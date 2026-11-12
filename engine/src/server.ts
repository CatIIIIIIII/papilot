import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import compress from "@fastify/compress";
import { WEB, codeVersion, environmentVersion } from "./runtime.ts";
import { Repo, stateDir } from "./core/git.ts";
import { serverHome } from "./client.ts";
import { loadProject, settingsFile, type Project } from "./core/config.ts";
import { Store } from "./core/store.ts";
import { Tasks } from "./core/tasks.ts";
import { Review } from "./core/review.ts";
import { useNoteOption, type OptionInput } from "./core/note-options.ts";
import { previewNoteOption } from "./core/option-preview.ts";
import { SourceEdits } from "./core/source-edit.ts";
import { Reconciliations } from "./core/reconcile.ts";
import { Deliveries } from "./core/delivery.ts";
import { more, PublishError, Publisher } from "./core/publish.ts";
import { Applied } from "./core/applied.ts";
import { view, type ViewRequest } from "./core/view.ts";
import { acquireLock, now, readJson, realPath, writeJson } from "./core/files.ts";
import { stopAll } from "./core/process.ts";
import { checkInputs, Confirmations, ReferenceChecker } from "./core/verify.ts";
import type { ActionKind, SourceEditRequest, SourceFileSave } from "./types.ts";
export class App {
  root: string;
  repo: Repo;
  state: string;
  store: Store;
  csrf = randomBytes(32).toString("base64url");
  viewers = new Map<string, number>();
  url = "";
  activity = now();
  tasks: Tasks;
  review: Review;
  sourceEdits: SourceEdits;
  delivery: Deliveries;
  reconciliation: Reconciliations;
  publisher: Publisher;
  applied: Applied;
  references: ReferenceChecker;
  confirmations: Confirmations;
  private cachedProject?: Project;
  private stamp?: number;
  constructor(root: string) {
    this.root = realPath(root);
    this.repo = new Repo(this.root);
    this.state = stateDir(this.repo.gitDir());
    this.store = new Store(path.join(this.state, "state.sqlite3"));
    this.tasks = new Tasks(this);
    this.review = new Review(this);
    this.sourceEdits = new SourceEdits(this);
    this.delivery = new Deliveries(this);
    this.reconciliation = new Reconciliations(this);
    this.publisher = new Publisher(this);
    this.applied = new Applied(this);
    this.references = new ReferenceChecker(
      path.join(this.state, "references.json"),
    );
    this.confirmations = new Confirmations(
      path.join(this.state, "references-confirmed.json"),
    );
    // Writes interrupted by a restart are finished first, before any other.
    this.ready = this.exclusive(async () => {
      await this.review.recover();
      await this.delivery.recover();
      await this.reconciliation.recover();
      await this.publisher.recover();
    });
    // Decisions made before a restart compile now; that never blocks a write.
    void this.ready.then(() => this.applied.recover(), () => undefined);
  }
  /** Settles once writes interrupted by a restart are finished. */
  ready: Promise<void>;
  private writing: Promise<unknown> = Promise.resolve();
  /** Runs `work` after every write that started before it. Decisions,
   *  deliveries and task changes run Git without blocking the server, so this
   *  keeps them from interleaving, as when they ran in one piece. */
  exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.writing.then(() => work());
    this.writing = result.then(() => undefined, () => undefined);
    return result;
  }
  get project() {
    const config = settingsFile(this.root),
      stamp = fs.existsSync(config) ? fs.statSync(config).mtimeMs : 0;
    if (!this.cachedProject || this.stamp !== stamp) {
      this.cachedProject = loadProject(this.root);
      this.stamp = stamp;
    }
    return this.cachedProject;
  }
  page(name: string) {
    return `${this.url}/?task=${encodeURIComponent(name)}`;
  }
  taskInfo(name: string) {
    const task = this.tasks.get(name),
      delivery = this.delivery.get(name),
      reconciliation = this.reconciliation.get(name),
      scope = reconciliation ? { ...task.scope, paths: reconciliation.files, ranges: null } : task.scope;
    return {
      ...this.review.summary(name),
      deferred: Boolean(task.deferred),
      delivery: delivery ? { ...this.delivery.result(delivery), pending: !delivery.done } : null,
      reconciliation: reconciliation ?? null,
      worktree: task.worktree,
      url: this.page(name),
      viewing: now() - (this.viewers.get(name) ?? 0) < 15,
      scope: {
        sections: scope.sections.map((s) => `${s.number} ${s.title}`.trim()),
        files: scope.ranges
          ? Object.entries(scope.ranges).flatMap(([file, spans]) =>
              spans.map(([a, b]) => `${file}:${a}-${b}`),
            )
          : scope.paths,
      },
    };
  }
  tasksOverview() {
    return this.tasks.list().map((task) => {
      const { next: _next, ...summary } = this.review.summary(task.name);
      return { ...summary, url: this.page(task.name) };
    });
  }
  async close() {
    this.publisher.stop();
    this.applied.stop();
    await Promise.all([this.publisher.join(), this.applied.join()]);
    this.store.close();
  }
}
export function createServer(app: App) {
  const server = Fastify({ logger: false, bodyLimit: Number.MAX_SAFE_INTEGER });
  server.register(compress, { threshold: 1024 });
  server.addHook("onRequest", async (request, reply) => {
    app.activity = now();
    const port = new URL(app.url || "http://127.0.0.1:80").port || "80",
      hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY");
    if (
      !hosts.has(request.headers.host ?? "") ||
      (request.headers.origin &&
        ![...hosts].some((h) => request.headers.origin === "http://" + h))
    )
      return reply
        .code(403)
        .send({ error: "Only same-origin localhost requests are accepted." });
    if (request.method === "POST") {
      const token = Buffer.from(
          String(request.headers["x-review-token"] ?? ""),
        ),
        expected = Buffer.from(app.csrf);
      if (token.length !== expected.length || !timingSafeEqual(token, expected))
        return reply
          .code(403)
          .send({ error: "This page is out of date. Reload it." });
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    reply.code(e.statusCode ?? 400).send({ error: e.message });
  });
  server.after(() => {
    server.get("/api/info", () => ({
      root: app.root,
      version: codeVersion(),
      environment: environmentVersion(),
      pid: process.pid,
      busy: app.publisher.busy(),
      build_workers: app.project.build_workers,
      csrf: app.csrf,
      runtime: "typescript",
    }));
    server.get("/api/tasks", () => ({
      tasks: app.tasksOverview(),
      csrf: app.csrf,
    }));
    server.get<{ Params: { id: string } }>("/api/jobs/:id", (request) => {
      const j = app.publisher.job(request.params.id),
        revision = app.publisher.revision(j.id);
      return {
        id: j.id,
        task: j.task,
        status: j.status,
        phase: j.phase,
        createdAt: j.created * 1000,
        ...(app.publisher.progress(j.id) ? { progress: app.publisher.progress(j.id) } : {}),
        ...(revision ? { revision } : {}),
        ...j.result,
      };
    });
    server.get<{ Params: { name: string } }>("/api/tasks/:name", (request) =>
      app.taskInfo(request.params.name),
    );
    server.get<{ Params: { name: string }; Querystring: { round?: string; hidden?: string } }>(
      "/api/tasks/:name/state",
      (request) => {
        // A page in a hidden tab or a locked phone still polls, but nobody reads it.
        const seen = request.query.hidden !== "1";
        const state = app.review.pageState(
          request.params.name,
          request.query.round && /^\d+$/.test(request.query.round)
            ? Number(request.query.round)
            : undefined,
          seen,
        );
        // The page is open: its round compiles in the foreground.
        if (seen) app.publisher.attend();
        return state;
      },
    );
    // What the review page shows now, so that what is on screen compiles first.
    server.post<{ Params: { name: string }; Body: { mode: "changes" | "pdf" } }>(
      "/api/tasks/:name/look",
      { schema: { body: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { enum: ["changes", "pdf"] } } } } },
      (request) => {
        app.tasks.get(request.params.name, false);
        app.publisher.look(request.params.name, request.body.mode);
        return { ok: true };
      },
    );
    // The paper as decided so far: every accepted change, no other.
    server.get<{ Params: { name: string } }>("/api/tasks/:name/applied", async (request) => {
      const name = app.tasks.get(request.params.name, false).name, state = await app.applied.state(name);
      return { ...state, shown: state.shown && { ...state.shown, pdf: `/applied/${name}/${state.shown.key}.pdf` } };
    });
    server.get<{ Params: { name: string; key: string } }>("/applied/:name/:key", async (request, reply) => {
      const { name, key } = request.params, match = /^([0-9a-f]{32})\.pdf$/.exec(key);
      app.tasks.get(name, false);
      const pdf = match ? await app.applied.pdf(name, match[1]) : null;
      if (!pdf) return reply.code(404).send({ error: "No such file" });
      reply.header("Cache-Control", "private, max-age=31536000, immutable").type("application/pdf");
      return fs.createReadStream(pdf);
    });
    server.get<{ Params: { name: string }; Querystring: { round: number; change: string } }>(
      "/api/tasks/:name/source",
      { schema: { querystring: { type: "object", required: ["round", "change"], properties: { round: { type: "integer", minimum: 1 }, change: { type: "string", pattern: "^c[0-9]+$" } } } } },
      request => app.sourceEdits.read(request.params.name, request.query.round, request.query.change),
    );
    server.post<{ Params: { name: string }; Body: SourceEditRequest }>(
      "/api/tasks/:name/source",
      { schema: { body: { type: "object", additionalProperties: false, required: ["id", "round", "change", "revision", "text"], properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9-]{1,80}$" }, round: { type: "integer", minimum: 1 }, change: { type: "string", pattern: "^c[0-9]+$" }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, text: { type: "string", maxLength: 200000 },
      } } } },
      request => app.sourceEdits.save(request.params.name, request.body),
    );
    // A whole file of the task, for an editor beside the review.
    server.get<{ Params: { name: string }; Querystring: { file: string } }>(
      "/api/tasks/:name/source/file",
      { schema: { querystring: { type: "object", required: ["file"], properties: { file: { type: "string", minLength: 1, maxLength: 1024 } } } } },
      request => app.sourceEdits.readFile(request.params.name, request.query.file),
    );
    server.post<{ Params: { name: string }; Body: SourceFileSave }>(
      "/api/tasks/:name/source/file",
      { bodyLimit: 8 * 1024 * 1024, schema: { body: { type: "object", additionalProperties: false, required: ["id", "round", "file", "revision", "text"], properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9-]{1,80}$" }, round: { type: "integer", minimum: 1 }, file: { type: "string", minLength: 1, maxLength: 1024 }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, text: { type: "string", maxLength: 2000000 },
      } } } },
      request => app.sourceEdits.saveFile(request.params.name, request.body),
    );
    server.get<{ Params: { name: string }; Querystring: { after?: string } }>(
      "/api/tasks/:name/feedback",
      (request) =>
        app.review.feedback(
          request.params.name,
          /^\d+$/.test(request.query.after ?? "")
            ? Number(request.query.after)
            : 0,
        ),
    );
    server.post<{ Params: { name: string }; Body: OptionInput }>("/api/tasks/:name/source/options/preview",
      request => previewNoteOption(app, app.tasks.get(request.params.name).name, request.body));
    server.get<{ Params: { name: string; number: string; key: string; file: string } }>(
      "/option-files/:name/:number/:key/:file", (request, reply) => {
        const { name, number, key, file } = request.params;
        const task = app.tasks.get(name, false);
        if (!/^\d+$/.test(number) || !/^[a-f0-9]{64}$/.test(key) || !/^[\w.-]+\.(svg|png|pdf)$/.test(file))
          return reply.code(404).send({ error: "No such file" });
        const root = path.resolve(app.state, "cache/option-previews");
        const target = path.resolve(root, task.name, String(Number(number)), key, file);
        if (!target.startsWith(root + path.sep)) return reply.code(404).send({ error: "No such file" });
        if (!fs.existsSync(target)) return reply.code(404).send({ error: "No such file" });
        reply.header("Cache-Control", "private, max-age=31536000, immutable").type(file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".pdf") ? "application/pdf" : "image/png");
        return fs.createReadStream(target);
      });
    server.post<{ Params: { name: string }; Body: OptionInput }>("/api/tasks/:name/source/options",
      request => useNoteOption(app, app.tasks.get(request.params.name).name, request.body));
    server.get<{ Params: { name: string; number: string } }>(
      "/api/tasks/:name/rounds/:number",
      (request) =>
        app.review.positioned(
          app.review.roundDetail(
            request.params.name,
            Number(request.params.number),
          ),
        ),
    );
    // The places an edit changes away from its lines, past those its round
    // rendered: rendering them takes a moment, so the page asks for them.
    server.get<{ Params: { name: string; number: string; unit: string } }>(
      "/api/tasks/:name/rounds/:number/effects/:unit",
      async (request, reply) => {
        const { name, number, unit } = request.params;
        if (!/^\d+$/.test(number) || !/^c\d+$/.test(unit))
          return reply.code(404).send({ error: "No such change" });
        try {
          app.review.round(name, Number(number));
        } catch {
          return reply.code(404).send({ error: "No such round" });
        }
        try {
          return {
            places: await more(
              path.join(
                app.state,
                "rounds",
                name,
                String(Number(number)).padStart(3, "0"),
              ),
              unit,
            ),
          };
        } catch (error) {
          if (!(error instanceof PublishError)) throw error;
          return reply
            .code(409)
            .send({ error: `${error.message} ${error.next}`.trim() });
        }
      },
    );
    // Checks of the bibliography entries a round adds or modifies. The page
    // asks with check=1 to look up entries online, and keeps asking until
    // none is pending; without it only results already known are returned.
    server.get<{
      Params: { name: string; number: string };
      Querystring: { check?: string; retry?: string };
    }>("/api/tasks/:name/rounds/:number/references", (request) => {
      const inputs = checkInputs(
        app.review.roundDetail(request.params.name, Number(request.params.number))
          .references,
      );
      return {
        ...app.references.lookup(
          inputs,
          request.query.check === "1",
          request.query.retry === "1",
        ),
        confirmed: app.confirmations.of(inputs),
      };
    });
    // The author confirms, or takes back, that they checked an entry by hand.
    server.post<{
      Params: { name: string; number: string };
      Body: { id: string; confirmed: boolean };
    }>(
      "/api/tasks/:name/rounds/:number/references/confirm",
      {
        schema: {
          body: {
            ...{ type: "object" as const },
            required: ["id", "confirmed"],
            properties: { id: { type: "string" }, confirmed: { type: "boolean" } },
          },
        },
      },
      (request, reply) => {
        const inputs = checkInputs(
            app.review.roundDetail(request.params.name, Number(request.params.number))
              .references,
          ),
          input = inputs.find((i) => i.id === request.body.id);
        if (!input) return reply.code(404).send({ error: "No such entry in this round." });
        app.confirmations.set(input, request.body.confirmed);
        return {
          ...app.references.lookup(inputs),
          confirmed: app.confirmations.of(inputs),
        };
      },
    );
    server.get<{ Params: { name: string; number: string; file: string } }>(
      "/files/:name/:number/:file",
      (request, reply) => {
        const { name, number, file } = request.params;
        app.tasks.get(name, false);
        if (!/^\d+$/.test(number) || !/^[\w.-]+\.(svg|png)$/.test(file))
          return reply.code(404).send({ error: "No such file" });
        const target = path.join(
          app.state,
          "rounds",
          name,
          String(Number(number)).padStart(3, "0"),
          file,
        );
        if (!fs.existsSync(target))
          return reply.code(404).send({ error: "No such file" });
        reply
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .type(file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        return fs.createReadStream(target);
      },
    );
    const objectSchema = { type: "object" as const };
    server.post<{
      Body: {
        name?: string;
        title?: string;
        sections?: string[];
        files?: string[];
        deferred?: boolean;
      };
    }>(
      "/api/tasks",
      {
        schema: {
          body: {
            ...objectSchema,
            properties: {
              name: { type: "string" },
              title: { type: "string" },
              sections: { type: "array", items: { type: "string" } },
              files: { type: "array", items: { type: "string" } },
              deferred: { type: "boolean" },
            },
          },
        },
      },
      async (request) => {
        const d = request.body;
        return app.taskInfo(
          (await app.tasks.createAsync(d.name, d.title, d.sections, d.files, d.deferred)).name,
        );
      },
    );
    server.post<{ Params: { name: string }; Body: { requestId?: string; indirect?: boolean } }>(
      "/api/tasks/:name/publish",
      { schema: { body: { ...objectSchema, properties: { requestId: { type: "string", pattern: "^[a-zA-Z0-9-]{1,80}$" }, indirect: { type: "boolean" } } } } },
      (request) => {
        app.delivery.assertReady(request.params.name);
        const job = app.publisher.submit(request.params.name, request.body?.requestId, request.body?.indirect);
        return { job: job.id, status: job.status };
      },
    );
    // The task's agent is writing files: what its round will compile first
    // is compiled ahead in the background. Answers at once.
    server.post<{ Params: { name: string } }>("/api/tasks/:name/prefetch", (request) => {
      app.publisher.prefetch(request.params.name);
      return { ok: true };
    });
    // The task's typeset pages as images, for its agent to look at.
    server.post<{ Params: { name: string }; Body: ViewRequest }>(
      "/api/tasks/:name/view",
      { schema: { body: { ...objectSchema, additionalProperties: false, properties: { locations: { type: "array", items: { type: "string", maxLength: 1000 } }, pages: { type: "array", items: { type: "string", maxLength: 40 } }, accepted: { type: "boolean" } } } } },
      (request) => view(app, request.params.name, request.body),
    );
    server.post<{ Params: { name: string }; Body: { keepCurrent?: boolean; mode?: "workspace" | "commit"; message?: string; confirmation?: string } }>(
      "/api/tasks/:name/apply",
      { schema: { body: { ...objectSchema, additionalProperties: false, properties: { confirmation: { type: "string", maxLength: 100 }, keepCurrent: { type: "boolean" }, mode: { enum: ["workspace", "commit"] }, message: { type: "string", maxLength: 5000 } } } } },
      request => app.delivery.apply(request.params.name, request.body.keepCurrent === true, request.body.mode, request.body.message, request.body.confirmation),
    );
    // A speculative build of the manuscript compiles what applying the task
    // would write, so its PDF is ready when the author applies it.
    server.get<{ Params: { name: string } }>("/api/tasks/:name/preview", async (request) => {
      const writes = await app.delivery.preview(request.params.name);
      return { files: writes && Object.fromEntries(Object.entries(writes).map(([file, data]) => [file, data?.toString("base64") ?? null])) };
    });
    server.post<{
      Params: { name: string };
      Body: {
        action: ActionKind;
        id?: string;
        changes: string[];
        round: number;
        body?: string;
        queue?: boolean;
      };
    }>(
      "/api/tasks/:name/decide",
      {
        schema: {
          body: {
            ...objectSchema,
            required: ["action", "changes", "round"],
            properties: {
              action: { enum: ["accept", "reject", "comment"] },
              id: { type: "string" },
              changes: { type: "array", items: { type: "string" } },
              round: { type: "integer", minimum: 1 },
              body: { type: "string" },
              queue: { type: "boolean" },
            },
          },
        },
      },
      (request) => app.review.decide(request.params.name, request.body),
    );
    server.post<{ Params: { name: string }; Body: { id: string } }>(
      "/api/tasks/:name/undo",
      {
        schema: {
          body: {
            ...objectSchema,
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
      (request) => app.review.undo(request.params.name, request.body.id),
    );
    server.post<{ Params: { name: string }; Body: { force?: boolean } }>(
      "/api/tasks/:name/finish",
      {
        schema: {
          body: { ...objectSchema, properties: { force: { type: "boolean" } } },
        },
      },
      async (request) => {
        const result = await app.tasks.finish(
          request.params.name,
          request.body.force,
        );
        return {
          task: request.params.name,
          finished: true,
          changed_files: result.changed,
          discarded: Object.fromEntries(
            Object.entries(result.discarded).filter(
              ([k, n]) => ["pending", "commented"].includes(k) && n,
            ),
          ),
        };
      },
    );
    server.post<{ Body: { force?: boolean } }>(
      "/api/shutdown",
      {
        schema: {
          body: { ...objectSchema, properties: { force: { type: "boolean" } } },
        },
      },
      (request, reply) => {
        if (app.publisher.busy() && !request.body.force)
          throw new Error(
            "A round is being built. Stop after it finishes, or force the stop.",
          );
        reply.send({ ok: true });
        setImmediate(() => {
          app.publisher.stop();
          stopAll();
          void server.close();
        });
      },
    );
    if (fs.existsSync(WEB)) {
      server.register(staticFiles, {
        root: WEB,
        prefix: "/",
        cacheControl: false,
        setHeaders: (response) => response.header("Cache-Control", "no-cache"),
      });
    } else
      server.get("/", (_req, reply) =>
        reply
          .type("text/plain")
          .send("Build the review UI with npm run build."),
      );
  });
  return server;
}
interface Owner {
  left: boolean;
  stop: () => void;
}
export async function serve(root: string, port = 0, idle = 12 * 3600) {
  // A server started with an IPC channel belongs to the app that started it
  // (see launch in client.ts) and stops when that app ends, even while it is
  // still starting. Closing the channel on the way out keeps it from holding
  // this process open.
  if (!process.send) return run(root, port, idle);
  if (!process.connected) return;
  const owner: Owner = { left: false, stop: () => {} };
  const left = () => {
    owner.left = true;
    owner.stop();
  };
  process.once("disconnect", left);
  try {
    await run(root, port, idle, owner);
  } finally {
    process.off("disconnect", left);
    if (process.connected) process.disconnect();
  }
}
async function run(root: string, port: number, idle: number, owner?: Owner) {
  root = new Repo(root).toplevel();
  process.chdir(root);
  // Losing the server lock means another engine now serves this paper. Stop,
  // closing open requests, rather than write its review state beside it;
  // Papilot's next request connects to that engine.
  let lost = false, stop = () => {};
  const home = serverHome(root),
    release = await acquireLock(path.join(home, "server.lock"), false, { onLost: () => { lost = true; stop(); } }),
    app = new App(root),
    server = createServer(app);
  let timer: NodeJS.Timeout | undefined;
  try {
    // Requests see the state that interrupted writes leave once finished.
    await app.ready.catch(() => undefined);
    try {
      await server.listen({ host: "127.0.0.1", port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await server.listen({ host: "127.0.0.1", port: 0 });
    }
    const address = server.server.address();
    if (!address || typeof address === "string")
      throw new Error("No server address");
    app.url = `http://127.0.0.1:${address.port}`;
    // Lost while starting: the paper's connection belongs to the new owner.
    if (lost) { await server.close(); return; }
    const info = {
      url: app.url,
      port: address.port,
      pid: process.pid,
      version: codeVersion(),
      root,
      runtime: "typescript",
    };
    writeJson(path.join(home, "connection.json"), info, 0o600);
    writeJson(path.join(home, "last.json"), { port: address.port });
    const shutdown = () => {
      app.publisher.stop();
      stopAll();
      void server.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    // Requests still open, such as a CLI waiting on feedback, end with it.
    stop = () => {
      shutdown();
      server.server.closeAllConnections();
    };
    if (owner) {
      owner.stop = stop;
      if (owner.left) stop();
    }
    timer = setInterval(
      () => {
        if (now() - app.activity > idle && !app.publisher.busy()) shutdown();
      },
      Math.min(30000, idle * 1000),
    );
    console.log(JSON.stringify(info));
    await new Promise<void>((resolve) => server.server.once("close", resolve));
  } finally {
    if (timer) clearInterval(timer);
    app.publisher.stop();
    stopAll();
    await app.close();
    if (
      readJson<{ pid?: number }>(path.join(home, "connection.json"), {}).pid ===
      process.pid
    )
      fs.rmSync(path.join(home, "connection.json"), { force: true });
    await release();
  }
}
