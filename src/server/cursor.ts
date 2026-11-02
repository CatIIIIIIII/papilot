import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Adapter, loadPackage, packageFile, toolItem, type Item, type Thread, type Turn } from './agents.ts';
import { imageType } from './attachments.ts';
import { DATA } from './paths.ts';

// The parts of @cursor/sdk Papilot uses. The SDK is fetched on first use, so
// its types are restated here instead of being a build dependency.
export const CURSOR_SDK_VERSION = '1.2.0';
interface ModelSelection { id: string; params?: { id: string; value: string }[] }
interface CursorModel { id: string; displayName: string; parameters?: { id: string; values: { value: string; displayName?: string }[] }[]; variants?: { params: { id: string; value: string }[]; isDefault?: boolean }[] }
interface CursorMessage { type: string; call_id?: string; name?: string; status?: string; args?: any; result?: any; message?: { content: { type: string; text?: string }[] } }
interface CursorRun { stream(): AsyncGenerator<CursorMessage, void>; wait(): Promise<{ status: 'finished' | 'error' | 'cancelled'; error?: { message: string } }>; cancel(): Promise<void> }
interface CursorAgentHandle { agentId: string; send(message: string | { text: string; images?: { data: string; mimeType: string }[] }, options?: { model?: ModelSelection; onDelta?: (args: { update: { type: string; text?: string } }) => void }): Promise<CursorRun>; close(): void }
interface AgentOptions { model?: ModelSelection; name?: string; local: { cwd: string; settingSources: string[]; sandboxOptions: { enabled: boolean } } }
export interface CursorSdk {
  Agent: { create(options: AgentOptions): Promise<CursorAgentHandle>; resume(agentId: string, options: Partial<AgentOptions>): Promise<CursorAgentHandle> };
  Cursor: { me(): Promise<{ apiKeyName: string; userEmail?: string }>; models: { list(): Promise<CursorModel[]> } };
}

const CURSOR_KEY = 'Cursor needs a Cursor API key: start Papilot with CURSOR_API_KEY set (create one in the Cursor dashboard). The SDK does not use the Cursor app or CLI login.';
// The SDK reads CURSOR_API_KEY, then the login it stores itself.
export function cursorConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.CURSOR_API_KEY) || fs.existsSync(path.join(os.homedir(), '.cursor/sdk/auth.json'));
}
let cursor: Promise<CursorSdk> | null = null;
export function loadCursor() {
  cursor ??= loadPackage('@cursor/sdk', CURSOR_SDK_VERSION, 'the Cursor SDK for Cursor tasks', () => { if (!cursorConfigured()) throw new Error(CURSOR_KEY); })
    .then(sdk => { const file = packageFile('@cursor/sdk'); return file ? helpersBesideSdk(sdk, file) : sdk; })
    .catch(error => { cursor = null; throw error; });
  return cursor;
}

// The SDK looks for its platform helpers (the cursorsandbox binary, rg and the
// shell parser) in node_modules folders above the running script, not beside
// itself, and loads them as a run starts. The copy Papilot fetches on first
// use sits in the data folder, outside that search, so every sandboxed run
// failed as "not supported in this environment". While a run starts, the
// search begins at the SDK's own file.
let starting = 0, script: string | undefined;
export function helpersBesideSdk(sdk: CursorSdk, file: string): CursorSdk {
  const fromSdk = async <T>(start: () => Promise<T>) => {
    if (starting++ === 0) { script = process.argv[1]; process.argv[1] = file; }
    try { return await start(); } finally { if (--starting === 0) process.argv[1] = script as string; }
  };
  const wrap = (agent: CursorAgentHandle): CursorAgentHandle => ({
    agentId: agent.agentId, close: () => agent.close(), send: (message, options) => fromSdk(() => agent.send(message, options)),
  });
  return { Cursor: sdk.Cursor, Agent: { create: async options => wrap(await sdk.Agent.create(options)), resume: async (id, options) => wrap(await sdk.Agent.resume(id, options)) } };
}

// Effort is a model parameter in Cursor's catalog.
const effortParameter = (model?: CursorModel) => model?.parameters?.find(parameter => /effort|reasoning/i.test(parameter.id));

// Cursor runs as a local SDK agent in the task worktree, with Cursor's own
// sandbox: writes stay in the worktree and temporary folders, and commands
// run without network access. The SDK has no interactive approvals, so
// anything outside the sandbox fails and is reported in the conversation.
// Each Papilot thread maps to a Cursor agent ID, resumed after a restart.
export class CursorAgent extends Adapter {
  private user: { apiKeyName: string; userEmail?: string } | null = null;
  private catalog: CursorModel[] = [];
  private agents = new Map<string, CursorAgentHandle>();
  private ids: Record<string, string> = {};
  constructor(private load: () => Promise<CursorSdk> = loadCursor, private file = path.join(DATA, 'cursor-agents.json'), private configured = () => cursorConfigured()) {
    super();
    try { this.ids = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* None yet. */ }
  }
  detect() { return this.configured(); }
  async preload() { if (packageFile('@cursor/sdk')) await this.load(); }
  async start() {
    if (this.ready) return;
    const sdk = await this.load();
    const [user, models] = await Promise.all([sdk.Cursor.me(), sdk.Cursor.models.list()]);
    this.user = user; this.catalog = models; this.ready = true;
  }
  private defaultModel() { return this.catalog.find(model => model.id === 'auto') || this.catalog[0]; }
  protected account() {
    return this.user ? { account: { email: this.user.userEmail, type: 'Cursor API key' }, requiresOpenaiAuth: false } : { account: null, requiresOpenaiAuth: true, reason: CURSOR_KEY };
  }
  protected models() {
    const preferred = this.defaultModel();
    return { data: this.catalog.map(model => {
      const parameter = effortParameter(model), fallback = model.variants?.find(variant => variant.isDefault)?.params.find(param => param.id === parameter?.id)?.value;
      return { model: model.id, displayName: model.displayName, isDefault: model === preferred,
        supportedReasoningEfforts: (parameter?.values || []).map(value => ({ reasoningEffort: value.value })), defaultReasoningEffort: fallback || null };
    }) };
  }
  private selection(model: string | null, effort: string | null): ModelSelection | undefined {
    const entry = this.catalog.find(item => item.id === model) || (model ? undefined : this.defaultModel());
    const id = entry?.id || model;
    if (!id) return undefined;
    const parameter = effortParameter(entry);
    if (effort && !parameter?.values.some(value => value.value === effort)) throw new Error(`Cursor does not support reasoning effort ${effort} for this model.`);
    return { id, ...(effort && parameter ? { params: [{ id: parameter.id, value: effort }] } : {}) };
  }
  private async agent(threadId: string, cwd: string, model: ModelSelection | undefined) {
    const known = this.agents.get(threadId);
    if (known) return known;
    const sdk = await this.load();
    const options: AgentOptions = { local: { cwd, settingSources: ['project'], sandboxOptions: { enabled: true } } };
    const id = this.ids[threadId];
    const agent = id ? await sdk.Agent.resume(id, options) : await sdk.Agent.create({ ...options, name: 'Papilot task', ...(model ? { model } : {}) });
    if (!id) { this.ids[threadId] = agent.agentId; this.save(); }
    this.agents.set(threadId, agent);
    return agent;
  }
  protected run(turn: Turn, thread: Thread, text: string, effort: string | null, images: string[]) { void this.execute(turn, thread, text, effort, images); }
  private async execute(turn: Turn, thread: Thread, text: string, effort: string | null, images: string[]) {
    let stopped = false, run: CursorRun | null = null;
    turn.stop = () => { stopped = true; void run?.cancel().catch(() => {}); if (!run) this.finish(turn, 'interrupted'); };
    let live = '', segment = 0, streamed = false;
    const flush = () => {
      if (live.trim()) this.item(turn, { id: `${turn.id}:text:${segment}`, type: 'agentMessage', text: live });
      if (live) segment++;
      live = '';
    };
    try {
      const model = this.selection(thread.model, effort);
      const agent = await this.agent(turn.threadId, thread.cwd, model);
      // Cursor's harness prompt stays in place: the first turn carries Papilot's instructions.
      const prompt = thread.started ? text : `${thread.instructions}\n\n---\n\n${text}`;
      const attached = await Promise.all(images.map(async file => {
        const bytes = await fs.promises.readFile(file), mimeType = imageType(bytes);
        if (!mimeType) throw new Error('This image format is not supported.');
        return { data: bytes.toString('base64'), mimeType };
      }));
      if (stopped) return;
      run = await agent.send(attached.length ? { text: prompt, images: attached } : prompt, { ...(model ? { model } : {}), onDelta: ({ update }) => {
        if (update.type !== 'text-delta' || !update.text) return;
        streamed = true; live += update.text;
        this.notify('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.id, itemId: `${turn.id}:text:${segment}`, delta: update.text });
      } });
      this.threads.set(turn.threadId, { ...thread, started: true });
      if (stopped) await run.cancel().catch(() => {});
      for await (const message of run.stream()) {
        if (message.type === 'tool_call' && message.call_id) { flush(); this.tool(turn, message); }
        // Without text deltas, the completed assistant text is the reply.
        else if (message.type === 'assistant' && !streamed) for (const block of message.message?.content || []) if (block.type === 'text' && block.text) live += block.text;
      }
      const result = await run.wait();
      flush();
      if (stopped || result.status === 'cancelled') this.finish(turn, 'interrupted');
      else if (result.status === 'finished') this.finish(turn, 'completed');
      else this.finish(turn, 'failed', result.error?.message || 'Cursor stopped with an error.');
    } catch (error) {
      flush();
      this.agents.delete(turn.threadId);
      this.finish(turn, stopped ? 'interrupted' : 'failed', stopped ? undefined : error instanceof Error ? error.message : String(error));
    }
  }
  private tool(turn: Turn, message: CursorMessage) {
    const id = `${turn.id}:${message.call_id}`, args = message.args && typeof message.args === 'object' ? message.args : {};
    const status = message.status === 'error' || message.result?.status === 'error' ? 'failed' : message.status === 'completed' ? 'completed' : 'inProgress';
    let item: Item;
    if (message.name === 'shell') {
      const value = message.result?.value || {}, output = [value.stdout, value.stderr].filter(Boolean).join('\n') || (message.result?.error ? String(message.result.error.message || message.result.error) : '');
      item = { id, type: 'commandExecution', command: String(args.command || 'shell'), aggregatedOutput: output.slice(-40000), status };
    } else if (['edit', 'write', 'delete'].includes(message.name || '') && typeof args.path === 'string') {
      item = { id, type: 'fileChange', changes: [{ path: args.path }], status };
    } else item = { ...toolItem(id, message.name || 'tool', { ...args, file_path: args.path, pattern: args.pattern || args.globPattern }), status };
    this.item(turn, item, status !== 'inProgress');
  }
  private save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.ids)); } catch { /* A later turn starts a new agent. */ }
  }
  close() {
    super.close();
    for (const agent of this.agents.values()) { try { agent.close(); } catch { /* Already closed. */ } }
    this.agents.clear(); this.ready = false;
  }
}
