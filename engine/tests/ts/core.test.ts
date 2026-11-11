import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { Fixture, METHOD, BODY, MAIN } from "./helpers.ts";
import { cleanPath, merge3Async, within } from "../../src/core/git.ts";
import { loadProject, detectMain } from "../../src/core/config.ts";
import {
  buildOutline,
  resolveSections,
  selectedRanges,
  deepestNode,
} from "../../src/core/outline.ts";
import {
  diffUnits,
  applyUnits,
  revertUnits,
  scopeViolationsAsync,
} from "../../src/core/changes.ts";
import {
  affectedTargets,
  compilerDiagnostics,
  errors,
  warnings,
} from "../../src/core/build.ts";
let f: Fixture;
beforeEach(() => {
  f = new Fixture();
});
afterEach(async () => f.close());
describe("Git snapshots", () => {
  it("preserves HEAD and index including staged and unstaged changes", () => {
    f.write("paper/main.tex", "staged\n");
    f.write("notes.txt", "staged outside source\n");
    f.repo.run(["add", "."]);
    f.write("paper/main.tex", "unstaged\n");
    f.write("paper/new.tex", "new\n");
    f.write("elsewhere.tex", "outside\n");
    const head = f.repo.rev("HEAD"),
      index = fs.readFileSync(path.join(f.root, ".git/index")),
      rev = f.repo.snapshot(["paper"]);
    expect(f.repo.blob(rev, "paper/main.tex")?.toString()).toBe("unstaged\n");
    expect(f.repo.blob(rev, "paper/new.tex")).not.toBeNull();
    expect(f.repo.blob(rev, "notes.txt")).not.toBeNull();
    expect(f.repo.blob(rev, "elsewhere.tex")).toBeNull();
    expect(f.repo.rev("HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
  });
  it("reads missing files, privately commits added/deleted files and exports", async () => {
    const head = f.repo.rev("HEAD");
    expect(f.repo.blobs(head, ["paper/main.tex", "missing", "paper"])).toEqual({
      "paper/main.tex": Buffer.from(MAIN),
      missing: null,
      paper: null,
    });
    const rev = f.repo.commitWith(
      head,
      {
        [METHOD]: null,
        "paper/main.tex": Buffer.from("changed\n"),
        "new.tex": Buffer.from("new"),
      },
      "test",
    );
    expect(f.repo.changedFiles(head, rev)).toEqual([
      "new.tex",
      "paper/main.tex",
      METHOD,
    ]);
    expect(f.repo.rev("HEAD")).toBe(head);
    const out = path.join(f.base, "export");
    await f.repo.export(head, "paper", out);
    expect(fs.readFileSync(path.join(out, "main.tex"), "utf8")).toBe(MAIN);
  });
  it("rejects escaping exported symlinks", async () => {
    fs.symlinkSync("../../outside", path.join(f.root, "paper/link"));
    const rev = f.repo.snapshot(["paper"]);
    await expect(
      f.repo.export(rev, "paper", path.join(f.base, "export")),
    ).rejects.toThrow("outside");
  });
  it.each(["../x", "/etc/passwd", ".git/config"])(
    "rejects unsafe path %s",
    (value) => expect(() => cleanPath(value)).toThrow(),
  );
  it("merges independent edits and reports overlaps", async () => {
    const b = (s: string) => Buffer.from(s);
    expect(
      await merge3Async(b("A\nb\nc\nd\ne\n"), b("a\nb\nc\nd\ne\n"), b("a\nb\nc\nd\nE\n")),
    ).toEqual([b("A\nb\nc\nd\nE\n"), false]);
    expect((await merge3Async(b("x\n"), b("a\n"), b("y\n")))[1]).toBe(true);
    expect(await merge3Async(null, b("a"), null)).toEqual([null, false]);
    expect(within("paper-old/a", ["paper"])).toBe(false);
    expect(cleanPath("./paper/")).toBe("paper");
  });
});
describe("configuration", () => {
  it("detects main and source directory", () => {
    expect(detectMain(f.root)).toBe("paper/main.tex");
    expect(loadProject(f.root)).toMatchObject({
      main: "paper/main.tex",
      source_dir: "paper",
      engine: "pdflatex",
      build_workers: 1,
    });
  });
  it("detects magic engine and latexmk defaults", () => {
    f.write("paper/main.tex", "% !TeX program = lualatex\n" + MAIN);
    expect(loadProject(f.root).engine).toBe("lualatex");
    f.write("paper/main.tex", MAIN);
    f.write("paper/latexmkrc", "@default_files=('main.tex');\n$pdf_mode = 5;");
    expect(loadProject(f.root).engine).toBe("xelatex");
  });
  it.each([
    { mian: "x" },
    { engine: "tex" },
    { main: "missing.tex" },
    { source_dir: "other" },
    { worktrees: "inside" },
    ...[0, 9, true, "2", 1.5].map((build_workers) => ({ build_workers })),
    { figures: "no" },
    { preload: null },
    { dependencies: [] },
    { partial_builds: "false" },
  ])("rejects invalid settings %j", (settings) => {
    f.write(".latex-review.json", JSON.stringify(settings));
    expect(() => loadProject(f.root)).toThrow();
  });
  it("does not silently ignore malformed JSON", () => {
    f.write(".latex-review.json", "{broken");
    expect(() => loadProject(f.root)).toThrow("not valid JSON");
  });
});
describe("outline and units", () => {
  it("maps KOMA addchap source without advancing chapter numbers", () => {
    const files: Record<string, string> = {
      "paper/main.tex": String.raw`\documentclass{scrbook}
\begin{document}
\frontmatter
\include{acknowledgments}
\mainmatter
\chapter{Introduction}
Introduction.
\addchap[Short]{Unnumbered chapter}
Unnumbered content.
\addchap*{Unlisted chapter}
Unlisted content.
\chapter{Background}
Background.
\end{document}
`,
      "paper/acknowledgments.tex":
        "% Notes before the heading.\n\n\\addchap{Acknowledgments}\nThanks to my supervisor.\nThanks to my family.\n",
    };
    const nodes = buildOutline((name) => files[name], "paper/main.tex").nodes;
    expect(nodes.map((n) => [n.kind, n.number, n.title])).toEqual([
      ["chapter", "", "Acknowledgments"],
      ["chapter", "1", "Introduction"],
      ["chapter", "", "Unnumbered chapter"],
      ["chapter", "", "Unlisted chapter"],
      ["chapter", "2", "Background"],
    ]);
    expect(deepestNode(nodes, "paper/acknowledgments.tex", 1, 5)?.title).toBe(
      "Acknowledgments",
    );
    expect(nodes[0].ranges["paper/main.tex"]).toBeUndefined();
  });
  it("selects labeled sections and nested ranges", () => {
    const files: Record<string, string> = {
        "paper/main.tex": MAIN,
        [METHOD]: BODY,
      },
      nodes = buildOutline(
        (name) => files[name] ?? null,
        "paper/main.tex",
      ).nodes;
    expect(nodes.map((n) => [n.number, n.title])).toEqual([
      ["1", "Introduction"],
      ["2", "Method"],
      ["2.1", "Details"],
      ["3", "Conclusion"],
    ]);
    expect(
      resolveSections(nodes, ["2", "sec:method", "label:sec:method"]),
    ).toEqual(["label:sec:method"]);
    const [ranges] = selectedRanges(nodes, ["label:sec:method"]);
    expect(ranges[METHOD]).toEqual([[1, 44]]);
    expect(deepestNode(nodes, METHOD, 30, 30)?.title).toBe("Details");
  });
  it("keeps nearby edits independent when unchanged text separates them", () => {
    const head = f.repo.rev("HEAD");
    f.write(
      METHOD,
      BODY.replace("Method sentence 1.", "One.")
        .replace("Method sentence 3.", "Three.")
        .replace("Detail sentence 12.", "Twelve."),
    );
    const after = f.repo.snapshot(["paper"]),
      units = diffUnits(f.repo, head, after);
    expect(units).toHaveLength(3);
    const old = f.repo.blob(head, METHOD),
      next = f.repo.blob(after, METHOD);
    expect(applyUnits(old, next, [units[2]])?.toString()).toBe(
      BODY.replace("Detail sentence 12.", "Twelve."),
    );
    expect(revertUnits(old, next, units)).toEqual(old);
    expect(applyUnits(old, next, units)).toEqual(next);
  });
  it("preserves missing final newline and binary files", () => {
    const head = f.repo.rev("HEAD");
    f.write(METHOD, BODY + "Appended");
    f.write("paper/a.bin", Buffer.from([0, 1]));
    const after = f.repo.snapshot(["paper"]),
      units = diffUnits(f.repo, head, after);
    expect(units.find((u) => u.kind === "binary")?.whole_file).toBe(true);
    expect(
      applyUnits(
        f.repo.blob(head, METHOD),
        f.repo.blob(after, METHOD),
        units.filter((u) => u.file === METHOD),
      )?.toString(),
    ).toBe(BODY + "Appended");
  });
  it("enforces line and file scope", async () => {
    const head = f.repo.rev("HEAD"),
      scope = {
        ranges: { [METHOD]: [[4, 10] as [number, number]] },
        paths: [METHOD],
        sections: [],
      };
    f.write(METHOD, BODY.replace("Method sentence 5.", "Inside."));
    expect(
      await scopeViolationsAsync(f.repo, head, f.repo.snapshot(["paper"]), scope),
    ).toEqual([]);
    f.write(METHOD, BODY.replace("Method sentence 15.", "Outside."));
    expect(
      await scopeViolationsAsync(f.repo, head, f.repo.snapshot(["paper"]), scope),
    ).toEqual([METHOD + ":18"]);
  });
});
describe("compiler diagnostics and source diff", () => {
  it("retains TeX diagnostics wrapped in the middle of a word", () => {
    const message =
      "./chapters/01-introduction/01-operational-semantics-and-static-typing.tex:12: Package minted Error: minted v3+ executable is not installed, is not added to PATH, or is not permitted with restricted shell escape.";
    const wrapped = message.match(/.{1,79}/g)!.join("\n");
    expect(
      errors(
        wrapped +
          "\n\nSee the minted package documentation for explanation.\nType H for immediate help.\n ...\n\nl.12 \\end{shortcode}\n",
      ),
    ).toEqual([message.slice(2) + "  [l.12 \\end{shortcode}]"]);
  });
  it("includes Python helper failures from compiler output with a useful remedy", () => {
    const transcript =
      "Traceback (most recent call last):\n  File \"/tex/latexminted.py\", line 372, in <module>\n    main()\nTypeError: ArgParser.__init__() got an unexpected keyword argument 'color'\n";
    const diagnostics = compilerDiagnostics(
      "! Package minted Error: executable unavailable.\nl.12 \\end{minted}",
      transcript,
    );
    expect(diagnostics[0]).toContain("Package minted Error");
    expect(diagnostics[1]).toBe(
      "latexminted: TypeError: ArgParser.__init__() got an unexpected keyword argument 'color'",
    );
    expect(diagnostics[2]).toContain("select a compatible Python on PATH");
    expect(
      compilerDiagnostics("! Undefined control sequence.\nl.4 \\broken", ""),
    ).toEqual(["Undefined control sequence.  [l.4 \\broken]"]);
  });
  it("resolves shared input owners and falls back for global files", () => {
    const files = {
      "a.tex": "\\input{shared}",
      "b.tex": "\\input{shared}",
      "shared.tex": "text",
      "main.tex": "root",
    };
    expect(affectedTargets(files, ["shared.tex"], ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
    expect(affectedTargets(files, ["main.tex"], ["a", "b"])).toEqual(["full"]);
  });
  it("extracts compiler warnings and errors", () => {
    expect(
      warnings(
        "LaTeX Warning: Reference `missing' on page 1 undefined\nLaTeX Warning: Label `dup' multiply defined",
      ),
    ).toEqual(["Label defined twice: dup", "Undefined reference: missing"]);
    expect(errors("! Undefined control sequence.\nl.4 \\broken")).toEqual([
      "Undefined control sequence.  [l.4 \\broken]",
    ]);
  });
});
