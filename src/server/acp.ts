import { agentPath, spawnCommand } from '../../bin/agent-paths.mjs';
import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, TaskPermissionOption, TaskPermissions } from '../shared.ts';
import { Adapter, findExecutable, type Item, type Thread, type Turn } from './agents.ts';
import { imageType } from './attachments.ts';
import { VERSION } from './paths.ts';

interface Choice { value: string; name: string }
interface ConfigOption { id: string; category?: string; currentValue: string; options: (Choice | { options: Choice[] })[] }
interface Session { sessionId: string; configOptions?: ConfigOption[]; modes?: { availableModes: { id: string }[] }; models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] } }
interface LiveTurn { turn: Turn; cwd: string; text: string; message: string; tools: Map<string, any>; received: boolean; stopped: boolean }
// Some agents report every tool as kind "other" (DeepSeek Harness), so shell
// commands and file edits are also recognized by the tool's name.
const SHELL_TOOLS = new Set(['bash', 'shell', 'run_shell_command', 'execute_command', 'terminal']);
const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'strreplacefile', 'writefile', 'write_file', 'edit_file', 'replace', 'apply_patch']);
function toolKind(tool: any): string {
  if (tool.kind && tool.kind !== 'other') return tool.kind;
  const names = [tool.name, tool.title].filter(Boolean).map((name: string) => String(name).toLowerCase());
  if (names.some(name => SHELL_TOOLS.has(name)) && tool.rawInput?.command) return 'execute';
  if (names.some(name => EDIT_TOOLS.has(name))) return 'edit';
  return tool.kind || 'other';
}
const choices = (option?: ConfigOption): Choice[] => (option?.options || []).flatMap(value => 'options' in value ? value.options : [value]);
const sessionModel = (session: Session) => session.configOptions?.find(option => option.category === 'model' || option.id === 'model')?.currentValue || session.models?.currentModelId || null;

// The default mode is pinned instead of inheriting the user's global choice.
// Additional permissions are offered only when advertised by the ACP session.
export interface AcpProfile {
  id: AgentId; name: string; bin: string; binEnv: string; args: string[]; modes: string[]; setup: string;
  env?: () => NodeJS.ProcessEnv;
  config?: Record<string, string>;
  authMethods?: string[];
  sessionMeta?: Record<string, unknown>;
  modelEfforts?: boolean;
  permissionModes?: Record<string, { value?: string; label: string; detail: string }>;
}
const permissionModes = {
  default: { label: 'Default', detail: 'Ask before tools' },
  'auto-edit': { label: 'Auto edit', detail: 'Approve edits' },
  plan: { label: 'Plan', detail: 'Read-only planning' },
  auto: { label: 'Auto', detail: 'Approve safe operations' },
  yolo: { label: 'YOLO', detail: 'Approve all tools' },
};
export const ACP_PROFILES = {
  // Grok owns authentication and tools. A dedicated process and explicit
  // session metadata keep new and restored sessions out of yolo/auto mode.
  grok: { id: 'grok', name: 'Grok', bin: 'grok', binEnv: 'PAPILOT_GROK_BIN', args: ['--no-auto-update', 'agent', '--no-leader', 'stdio'],
    modes: [], authMethods: ['xai.api_key', 'cached_token'], sessionMeta: { yoloMode: false, autoMode: false },
    setup: 'Install Grok Build CLI from https://x.ai/cli and run grok login on this host, or configure XAI_API_KEY, then select Reconnect. Set PAPILOT_GROK_BIN if grok is not on PATH.' },
  // Copilot's agent mode and permission mode are separate: leaving autopilot
  // does not disable allow-all. Pin both, including when resuming a session.
  copilot: { id: 'copilot', name: 'Copilot', bin: 'copilot', binEnv: 'PAPILOT_COPILOT_BIN', args: ['--acp', '--stdio', '--no-auto-update'],
    modes: ['https://agentclientprotocol.com/protocol/session-modes#agent'], config: { allow_all: 'off' },
    setup: 'Install GitHub Copilot CLI (npm install -g @github/copilot) and run copilot login on this host, then select Reconnect. Set PAPILOT_COPILOT_BIN if copilot is not on PATH.',
    env: () => ({ ...process.env, COPILOT_ALLOW_ALL: 'false', COPILOT_ASSISTED_APPROVAL: 'false' }) },
  kimi: { id: 'kimi', name: 'Kimi', bin: 'kimi', binEnv: 'PAPILOT_KIMI_BIN', args: ['acp'], modes: ['default'], permissionModes,
    setup: 'Install Kimi Code CLI and run kimi login on this host, then select Reconnect. Set PAPILOT_KIMI_BIN if kimi is not on PATH.' },
  qwen: { id: 'qwen', name: 'Qwen', bin: 'qwen', binEnv: 'PAPILOT_QWEN_BIN', args: ['--acp'], modes: ['auto-edit', 'default'], permissionModes,
    setup: 'Install Qwen Code and sign in by running qwen once on this host, then select Reconnect. Set PAPILOT_QWEN_BIN if qwen is not on PATH.' },
  // DeepSeek Harness has no session modes: its ACP profile sandboxes writes and
  // commands to the session folder and asks before leaving it. Papilot pins
  // that preset so a looser DSH_PERMISSION_MODE in the environment is not used.
  deepseek: { id: 'deepseek', name: 'DeepSeek', bin: 'dsh', binEnv: 'PAPILOT_DSH_BIN', args: ['acp'], modes: [],
    setup: 'Install DeepSeek Harness (npm install -g @deepseek-ai/dsh) and set up a model with dsh web or the dsh TUI, then select Reconnect. Set PAPILOT_DSH_BIN if dsh is not on PATH.',
    env: () => ({ ...process.env, DSH_PERMISSION_MODE: 'workspace-write' }) },
  // OpenCode runs tools without asking by default. Its highest-precedence
  // config layer makes it ask before shell commands and anything outside the
  // task worktree, while edits in the worktree go ahead for review.
  opencode: { id: 'opencode', name: 'OpenCode', bin: 'opencode', binEnv: 'PAPILOT_OPENCODE_BIN', args: ['acp'], modes: ['papilot-default'], modelEfforts: true,
    permissionModes: {
      'papilot-default': { label: 'Default', detail: 'Ask before commands' },
      'papilot-full': { value: 'full', label: 'Allow all', detail: 'Approve all tools' },
    },
    setup: 'Install OpenCode and connect a provider with opencode auth login, then select Reconnect. Set PAPILOT_OPENCODE_BIN if opencode is not on PATH.',
    env: () => ({ ...process.env, OPENCODE_CONFIG_CONTENT: opencodeConfig(process.env.OPENCODE_CONFIG_CONTENT) }) },
} satisfies Record<string, AcpProfile>;
export function opencodeConfig(own?: string) {
  let config: Record<string, unknown> = {};
  try { const parsed = own ? JSON.parse(own) : {}; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed; } catch { /* Replaced below. */ }
  const permission = config.permission && typeof config.permission === 'object' ? config.permission : {};
  const agent = config.agent && typeof config.agent === 'object' ? config.agent : {};
  // v2 accepts these legacy fields, but a same-named native agent takes priority.
  // Own just our two entries; preserve all other provider and agent settings.
  if (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)) {
    config.agents = Object.fromEntries(Object.entries(config.agents).filter(([id]) => !['papilot-default', 'papilot-full'].includes(id)));
  }
  const restricted = { bash: 'ask', shell: 'ask', edit: 'allow', external_directory: 'ask' };
  return JSON.stringify({ ...config, permission: { ...permission, ...restricted }, agent: { ...agent,
    'papilot-default': { mode: 'primary', disable: false, permission: restricted },
    'papilot-full': { mode: 'primary', disable: false, permission: 'allow' },
  } });
}

// ACP sessions are the thread IDs persisted by Papilot. The agent owns
// credentials and conversation storage; the adapter only translates JSON-RPC
// over stdio.
export class AcpAgent extends Adapter {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private approvals = new Map<string, { rpcId: string | number; turn: Turn; options: { optionId: string; kind: string; name?: string }[]; question: boolean }>();
  private live = new Map<string, LiveTurn>();
  private sessions = new Map<string, Session>();
  private capabilities: any = {};
  private catalog: any[] = [];
  private defaultModel: string | null = null;
  private availablePermissions: TaskPermissionOption[] = [];
  permissionOptions() { return this.availablePermissions; }
  private readonly name: string;
  private readonly binary: string;
  constructor(private profile: AcpProfile, binary?: string, private launch: typeof spawnCommand = spawnCommand) {
    super();
    this.name = profile.name;
    this.binary = binary || process.env[profile.binEnv] || profile.bin;
  }
  detect() { return Boolean(findExecutable(this.binary)); }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async connect() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `papilot-${this.profile.id}-`));
    try {
      // The probe folder is removed below, so the agent itself runs from the home folder.
      const env = this.profile.env?.() || process.env;
      const child = this.launch(findExecutable(this.binary) || this.binary, this.profile.args, { cwd: os.homedir(), env: { ...env, PATH: agentPath(env) }, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const failed = (error: Error) => { if (this.child === child) this.disconnect(error); };
      createInterface({ input: child.stdout! }).on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        if (this.child === child) this.receive(message);
      });
      child.stderr?.resume();
      child.stdin?.on('error', failed);
      child.once('error', failed);
      child.once('close', (code, signal) => failed(new Error(`${this.name} exited (${signal || code}). ${this.profile.setup}`)));
      // The first start of some agents installs their plugins, so allow it a minute.
      const init = await this.rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'papilot', version: VERSION }, clientCapabilities: {} }, 60000);
      if (init.protocolVersion !== 1) throw new Error(`${this.name} returned an unsupported ACP version. Update it.`);
      this.capabilities = init.agentCapabilities || {};
      if (this.profile.authMethods) {
        const methodId = this.profile.authMethods.find(id => init.authMethods?.some((method: { id: string }) => method.id === id));
        if (!methodId) throw new Error(`${this.name} has no saved login or configured API credentials.`);
        await this.rpc('authenticate', { methodId, _meta: { headless: true } }, 60000);
      }
      // No generation: a disposable session checks configuration and exposes models.
      const probe: Session = await this.rpc('session/new', { cwd, mcpServers: [], ...(this.profile.sessionMeta ? { _meta: this.profile.sessionMeta } : {}) }, 60000);
      this.catalog = [];
      if (this.profile.modes.length) this.mode(probe);
      this.config(probe);
      this.availablePermissions = this.permissions(probe).map(({ native: _, ...option }) => option);
      this.readModels(probe, true);
      if (this.profile.modelEfforts) await this.learnEfforts(probe);
      const sessionCapabilities = this.capabilities.sessionCapabilities || {};
      if (sessionCapabilities.delete) await this.rpc('session/delete', { sessionId: probe.sessionId });
      else if (sessionCapabilities.close) await this.rpc('session/close', { sessionId: probe.sessionId });
      this.ready = true;
    } catch (error) {
      this.close();
      throw new Error(`${this.name} is unavailable: ${error instanceof Error ? error.message.replace(/\.$/, '') : String(error)}. ${this.profile.setup}`);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
  protected account() { return { account: this.ready ? { type: `Local ${this.name} configuration` } : null, requiresOpenaiAuth: !this.ready }; }
  protected models() { return { data: this.catalog }; }

  async request(method: string, params: any = {}): Promise<any> {
    if (method === 'thread/start' || method === 'thread/resume') {
      const resumed = method === 'thread/resume';
      const readOnly = params.sandbox === 'read-only';
      const permissions = readOnly ? 'workspace' : params.taskPermissions || 'workspace';
      const session = await this.session(resumed ? String(params.threadId) : null, params.cwd, params.model, permissions);
      const known = this.threads.get(session.sessionId);
      const model = params.model || sessionModel(session) || known?.model || null;
      this.threads.set(session.sessionId, { cwd: params.cwd, instructions: params.developerInstructions || '', model, started: resumed, permissions, readOnly });
      return { thread: { id: session.sessionId }, model };
    }
    return super.request(method, params);
  }
  private async session(id: string | null, cwd: string, model?: string | null, permissions: TaskPermissions = 'workspace'): Promise<Session> {
    let session = id ? this.sessions.get(id) : undefined;
    if (!session) {
      if (id && !this.capabilities.loadSession && !this.capabilities.sessionCapabilities?.resume) throw new Error(`This ${this.name} version cannot resume sessions. Update it.`);
      const result = await this.rpc(id ? this.capabilities.sessionCapabilities?.resume ? 'session/resume' : 'session/load' : 'session/new', { ...(id ? { sessionId: id } : {}), cwd, mcpServers: [], ...(this.profile.sessionMeta ? { _meta: this.profile.sessionMeta } : {}) });
      session = { ...result, sessionId: id || result.sessionId };
      if (!session!.sessionId) throw new Error(`${this.name} did not return a session ID.`);
      this.sessions.set(session!.sessionId, session!);
    }
    if (model) {
      const option = session!.configOptions?.find(option => option.category === 'model' || option.id === 'model');
      if (option) {
        await this.chooseModel(session!, option, model);
      } else {
        await this.rpc('session/set_model', { sessionId: session!.sessionId, modelId: model });
        if (session!.models) session!.models.currentModelId = model;
      }
    }
    await this.applyPermissions(session!, permissions);
    this.readModels(session!);
    return session!;
  }
  // OpenCode reports efforts only for the current model. Visit the catalog in
  // the disposable probe before publishing it; no prompt or inference is sent.
  private async learnEfforts(probe: Session) {
    const option = probe.configOptions?.find(option => option.category === 'model' || option.id === 'model');
    const deadline = Date.now() + 10000;
    for (const choice of choices(option)) {
      if (Date.now() >= deadline) break;
      if (choice.value === sessionModel(probe)) continue;
      try {
        await this.chooseModel(probe, option!, choice.value, deadline);
        this.readModels(probe);
      } catch (error) {
        if (!this.child) throw error;
        // A broken model must not hide the rest of the catalog. Unconfirmed
        // choices keep their empty efforts; the total discovery time is bounded.
      }
    }
  }
  private async chooseModel(session: Session, option: ConfigOption, value: string, deadline?: number) {
    // OpenCode can acknowledge a change with the previous model's options.
    // Never apply an effort or prompt against such an unconfirmed selection.
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline === undefined ? 20000 : Math.min(2000, deadline - Date.now());
      if (remaining <= 0) break;
      const result = await this.rpc('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value }, remaining);
      if (this.profile.modelEfforts && result?.configOptions?.find((entry: ConfigOption) => entry.id === option.id)?.currentValue !== value) continue;
      if (result?.configOptions) session.configOptions = result.configOptions;
      return;
    }
    throw new Error(`${this.name} could not apply ${option.id}=${value}.`);
  }
  private permissions(session: Session): (TaskPermissionOption & { native: string })[] {
    if (this.profile.permissionModes) {
      const { mode, option } = this.mode(session);
      const offered = session.modes ? session.modes.availableModes.map(mode => mode.id) : choices(option).map(choice => choice.value);
      return offered.flatMap(id => {
        const entry = this.profile.permissionModes![id];
        return entry ? [{ ...entry, native: id, value: id === mode ? 'workspace' : entry.value || (id === 'yolo' ? 'full' : id) }] : [];
      });
    }
    if (this.profile.id === 'copilot') {
      const offered = choices(session.configOptions?.find(option => option.id === 'allow_all'));
      return [
        { value: 'workspace', native: 'off', label: 'Default', detail: 'Ask before tools' },
        { value: 'full', native: 'on', label: 'Allow all', detail: 'Approve all tools' },
      ].filter(option => offered.some(choice => choice.value === option.native));
    }
    return [{ value: 'workspace', native: '', label: this.profile.id === 'deepseek' ? 'Workspace access' : 'Default', detail: this.profile.id === 'deepseek' ? 'Fixed ACP preset' : 'Native approvals' }];
  }
  private async applyPermissions(session: Session, value: TaskPermissions) {
    const selected = this.permissions(session).find(option => option.value === value);
    if (!selected) throw new Error(`${this.name} does not support the selected permissions. Reconnect to refresh its modes.`);
    if (this.profile.modes.length) {
      const fallback = this.mode(session), mode = this.profile.permissionModes ? selected.native : fallback.mode;
      // Apply on every turn: a cached or restored session may retain a broader mode.
      if (session.modes) await this.rpc('session/set_mode', { sessionId: session.sessionId, modeId: mode });
      else await this.setConfig(session, fallback.option!.id, mode);
    }
    for (const [configId, defaultValue] of this.config(session)) {
      await this.setConfig(session, configId, this.profile.id === 'copilot' && configId === 'allow_all' ? selected.native : defaultValue);
    }
  }
  private async setConfig(session: Session, configId: string, value: string) {
    const result = await this.rpc('session/set_config_option', { sessionId: session.sessionId, configId, value });
    if (result?.configOptions) {
      session.configOptions = result.configOptions;
      if (session.configOptions?.find(option => option.id === configId)?.currentValue !== value) throw new Error(`${this.name} could not apply ${configId}=${value}.`);
    }
  }
  // The accepted mode a session offers, as a session mode or a mode option.
  private mode(session: Session) {
    const option = session.configOptions?.find(option => option.category === 'mode' || option.id === 'mode');
    const offered = session.modes ? session.modes.availableModes.map(mode => mode.id) : choices(option).map(choice => choice.value);
    const mode = this.profile.modes.find(id => offered.includes(id));
    if (!mode) throw new Error(`${this.name} does not offer manual approvals. Update it.`);
    return { mode, option };
  }
  private config(session: Session) {
    const settings = Object.entries(this.profile.config || {});
    for (const [id, value] of settings) {
      if (!choices(session.configOptions?.find(option => option.id === id)).some(choice => choice.value === value)) {
        throw new Error(`${this.name} does not offer the required ${id} setting. Update it.`);
      }
    }
    return settings;
  }
  private readModels(session: Session, initial = false) {
    const model = session.configOptions?.find(option => option.category === 'model' || option.id === 'model');
    const thinking = session.configOptions?.find(option => option.category === 'thought_level' || option.id === 'thinking');
    // A "default" level is the model default Papilot already offers.
    const levels = choices(thinking).filter(choice => choice.value !== 'default'), level = thinking?.currentValue === 'default' ? null : thinking?.currentValue || null;
    const current = sessionModel(session);
    if (initial) this.defaultModel = current;
    const available = model ? choices(model) : (session.models?.availableModels || []).map(model => ({ value: model.modelId, name: model.name }));
    for (const option of available) {
      const previous = this.catalog.find(entry => entry.model === option.value);
      const entry = { model: option.value, displayName: option.name, isDefault: option.value === this.defaultModel,
        supportedReasoningEfforts: option.value === current ? levels.map(choice => ({ reasoningEffort: choice.value })) : previous?.supportedReasoningEfforts || [],
        // A turn's explicit effort must not become the catalog's default.
        defaultReasoningEffort: previous?.supportedReasoningEfforts.length ? previous.defaultReasoningEffort : option.value === current ? level : null };
      if (previous) Object.assign(previous, entry); else this.catalog.push(entry);
    }
  }
  protected run(turn: Turn, thread: Thread, text: string, effort: string | null, images: string[]) { void this.execute(turn, thread, text, effort, images); }
  private async execute(turn: Turn, thread: Thread, text: string, effort: string | null, images: string[]) {
    let stopped = false, prompting = false;
    let cancelTimer: NodeJS.Timeout | undefined;
    const live: LiveTurn = { turn, cwd: thread.cwd, text: '', message: randomUUID(), tools: new Map(), received: false, stopped: false };
    turn.stop = () => {
      stopped = true; live.stopped = true;
      this.clearApprovals(turn);
      if (prompting) {
        this.send({ method: 'session/cancel', params: { sessionId: turn.threadId } });
        // A broken server must not leave paused tasks waiting forever.
        cancelTimer ??= setTimeout(() => this.disconnect(new Error(`${this.name} did not acknowledge cancellation. Reconnect to resume.`)), 5000);
        cancelTimer.unref();
      }
    };
    try {
      const session = await this.session(turn.threadId, thread.cwd, thread.model, thread.readOnly ? 'workspace' : thread.permissions);
      const option = session.configOptions?.find(option => option.category === 'thought_level' || option.id === 'thinking');
      const defaultEffort = choices(option).some(choice => choice.value === 'default') ? 'default' : this.catalog.find(model => model.model === thread.model)?.defaultReasoningEffort;
      const chosenEffort = effort || defaultEffort;
      if (chosenEffort) {
        if (!option || !choices(option).some(choice => choice.value === chosenEffort)) throw new Error(`${this.name} does not support reasoning effort ${chosenEffort} for this model.`);
        const result = await this.rpc('session/set_config_option', { sessionId: turn.threadId, configId: option.id, value: chosenEffort });
        if (this.profile.modelEfforts && result?.configOptions?.find((entry: ConfigOption) => entry.id === option.id)?.currentValue !== chosenEffort) throw new Error(`${this.name} could not apply ${option.id}=${chosenEffort}.`);
        if (result?.configOptions) session.configOptions = result.configOptions;
      }
      const prompt: any[] = [{ type: 'text', text: thread.started ? text : `${thread.instructions}\n\n---\n\n${text}` }];
      if (images.length && !this.capabilities.promptCapabilities?.image) throw new Error(`This ${this.name} version does not support image input. Update it, or send the images to another agent.`);
      for (const file of images) {
        const bytes = await fs.promises.readFile(file), mimeType = imageType(bytes);
        if (!mimeType) throw new Error('This image format is not supported.');
        prompt.push({ type: 'image', data: bytes.toString('base64'), mimeType });
      }
      if (stopped) return this.finish(turn, 'interrupted');
      this.live.set(turn.threadId, live);
      prompting = true;
      // The response arrives at the end of the turn; user approvals can take any amount of time.
      const result = await this.rpc('session/prompt', { sessionId: turn.threadId, prompt }, 0);
      this.threads.set(turn.threadId, { ...thread, started: true });
      this.flush(live);
      if (stopped || result.stopReason === 'cancelled') this.finish(turn, 'interrupted');
      else if (result.stopReason === 'end_turn' && live.received) this.finish(turn, 'completed');
      else if (result.stopReason === 'end_turn') this.finish(turn, 'failed', `${this.name} returned no response. Check its login and model configuration, then retry.`);
      else this.finish(turn, 'failed', `${this.name} stopped: ${result.stopReason || 'no stop reason returned'}.`);
    } catch (error) {
      this.flush(live);
      this.finish(turn, stopped ? 'interrupted' : 'failed', stopped ? undefined : error instanceof Error ? error.message : String(error));
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      this.clearApprovals(turn);
      this.live.delete(turn.threadId);
    }
  }
  private flush(live: LiveTurn) {
    if (live.text.trim()) this.item(live.turn, { id: live.message, type: 'agentMessage', text: live.text });
    live.text = ''; live.message = randomUUID();
  }
  private update(params: any) {
    const live = this.live.get(params.sessionId), update = params.update;
    if (!live || !update) return; // Includes history replay while loading a session.
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const text = String(update.content.text || ''), shown = live.text.trim();
      live.text += text;
      // Empty and whitespace-only chunks (Qwen sends them) would show as empty
      // messages, so text is streamed from its first visible character.
      if (!live.text.trim()) return;
      live.received = true;
      this.notify('item/agentMessage/delta', { threadId: live.turn.threadId, turnId: live.turn.id, itemId: live.message, delta: shown ? text : live.text });
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      live.received = true;
      this.flush(live);
      const tool = { ...live.tools.get(update.toolCallId), ...update };
      live.tools.set(update.toolCallId, tool);
      const kind = toolKind(tool), named = tool.rawInput?.file_path || tool.rawInput?.path;
      const paths = (tool.locations || []).map((location: any) => location.path).concat((tool.content || []).filter((part: any) => part.type === 'diff').map((part: any) => part.path))
        .concat(kind === 'edit' && typeof named === 'string' ? [path.resolve(live.cwd, named)] : []);
      const id = `${live.turn.id}:${tool.toolCallId}`;
      const status = tool.status === 'failed' ? 'failed' : tool.status === 'completed' ? 'completed' : 'inProgress';
      const output = (tool.content || []).map((part: any) => part.type === 'content' && part.content?.type === 'text' ? part.content.text : '').join('\n');
      const item: Item = kind === 'execute' ? { id, type: 'commandExecution', command: tool.rawInput?.command || tool.title || `${this.name} command`, aggregatedOutput: output.slice(-40000), status }
        : kind === 'edit' && paths.length ? { id, type: 'fileChange', changes: [...new Set(paths)].map(file => ({ path: file })), status }
        : { id, type: 'toolCall', text: tool.title || `${this.name} tool`, status };
      this.item(live.turn, item, status !== 'inProgress');
    }
  }
  private receive(message: any) {
    if (!message.method) {
      const wait = this.pending.get(message.id);
      if (!wait) return;
      if (wait.timer) clearTimeout(wait.timer);
      this.pending.delete(message.id);
      if (message.error) wait.reject(new Error(message.error.message || `${this.name} request failed.`));
      else wait.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') { this.update(message.params); return; }
    if (message.id === undefined) return;
    const live = this.live.get(message.params?.sessionId);
    if (message.method !== 'session/request_permission' || !live || live.turn.status !== 'inProgress') {
      this.send({ id: message.id, error: { code: -32601, message: 'This client does not support this request, or the turn has ended.' } }); return;
    }
    if (live.stopped) { this.send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    const id = randomUUID(), update = message.params.toolCall || {};
    const tool = { ...live.tools.get(update.toolCallId), ...update };
    const file = tool.locations?.[0]?.path || tool.rawInput?.file_path || tool.rawInput?.path;
    const edit = toolKind(tool) === 'edit';
    const options = message.params.options || [];
    const question = options.filter((option: any) => option.kind === 'allow_once').length > 1;
    this.approvals.set(id, { rpcId: message.id, turn: live.turn, options, question });
    if (question) {
      // A question arrives as a permission request with several one-time
      // choices (Kimi's AskUserQuestion): the question itself is the tool's
      // text, and a one-time rejection is its Skip choice. An ACP permission
      // answer can only select an option, never carry free text.
      const asked = (tool.content || []).map((part: any) => part.type === 'content' && part.content?.type === 'text' ? part.content.text : '').filter(Boolean).join('\n');
      this.emit('request', { id, method: 'item/tool/requestUserInput', params: { threadId: live.turn.threadId, turnId: live.turn.id,
        questions: [{ id: 'choice', question: asked || tool.title || `${this.name} needs your input.`, isOther: false, options: options.filter((option: any) => option.kind === 'allow_once' || option.kind === 'reject_once').map((option: any) => ({ label: option.name || option.optionId })) }] } });
      return;
    }
    this.emit('request', { id, method: edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
      params: { threadId: live.turn.threadId, turnId: live.turn.id, reason: tool.title || `${this.name} requests permission.`, command: tool.rawInput?.command || (edit && file ? `Edit ${file}` : tool.title || `${this.name} tool`) } });
  }
  respond(id: string | number, result: any) {
    const wait = this.approvals.get(String(id));
    if (!wait) throw new Error('This request has ended.');
    const kind = result?.decision === 'accept' ? 'allow_once' : result?.decision === 'decline' ? 'reject_once' : null;
    const answer = result?.answers?.choice?.answers?.[0];
    const option = wait.question
      ? wait.options.find(option => (option.kind === 'allow_once' || option.kind === 'reject_once') && (option.name || option.optionId) === answer)
      : wait.options.find(option => option.kind === kind);
    this.approvals.delete(String(id));
    this.send({ id: wait.rpcId, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
  }
  reject(id: string | number, _message: string) { if (this.approvals.has(String(id))) this.respond(id, { decision: 'decline' }); }
  private clearApprovals(turn: Turn) {
    for (const [id, wait] of this.approvals) if (wait.turn === turn) {
      this.respond(id, { decision: 'cancel' });
      this.notify('serverRequest/resolved', { threadId: turn.threadId, requestId: id });
    }
  }
  private send(message: Record<string, unknown>) {
    const child = this.child;
    child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', error => { if (error && this.child === child) this.disconnect(error); });
  }
  private rpc(method: string, params: unknown, timeout = 20000): Promise<any> {
    if (!this.child) return Promise.reject(new Error(`${this.name} is not connected.`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} request timed out: ${method}.`)); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private disconnect(error: Error, notify = true) {
    const child = this.child;
    this.child = null; this.ready = false; this.sessions.clear();
    for (const wait of this.pending.values()) { if (wait.timer) clearTimeout(wait.timer); wait.reject(error); }
    this.pending.clear(); this.approvals.clear();
    child?.stdin?.end(); child?.kill('SIGTERM');
    if (child && notify) this.emit('disconnected', error);
  }
  close() { this.disconnect(new Error(`${this.name} disconnected.`), false); }
}

export class KimiAgent extends AcpAgent {
  constructor(binary?: string, launch?: typeof spawnCommand) { super(ACP_PROFILES.kimi, binary, launch); }
}
