import { agentPath, spawnCommand } from '../../bin/agent-paths.mjs';
import { type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { TaskPermissions, TaskPermissionOption } from '../shared.ts';
import { DATA, ROOT, VERSION } from './paths.ts';
import { codexBinary } from './codex-binary.ts';
import { codexCandidates, codexWorkingDirectory } from '../../bin/codex-lookup.mjs';
import { taskAccessInstructions } from './task-permissions.ts';

export class RpcResponseError extends Error {}

export class Codex extends EventEmitter {
  permissionOptions(): TaskPermissionOption[] {
    return [
      { value: 'workspace', label: 'Workspace access', detail: 'Write within the workspace and configured writable roots, with network access. Ask before exceeding sandbox restrictions.' },
      { value: 'full', label: 'Full access', detail: 'Disable the sandbox and run tools without approval, subject to managed settings.' },
    ];
  }
  async taskPermissionConfig(value: TaskPermissions, cwd: string) {
    const thread = { approvalPolicy: value === 'full' ? 'never' : 'on-request', sandbox: value === 'full' ? 'danger-full-access' : 'workspace-write' };
    // Resuming even a cold thread retains its original developer instructions.
    // Application context supplies a later developer message on every turn,
    // including after restart, without discarding the conversation's history.
    const additionalContext = { 'papilot-task-access': { kind: 'application', value: `These are Papilot's current task access instructions. They replace earlier Papilot instructions about access outside the task worktree, including blanket prohibitions on explicitly authorized manuscript writes, commits, and pushes. Manuscript review scope still applies; other task worktrees and Papilot's own source/state remain protected.\n${taskAccessInstructions}` } };
    if (value === 'full') return { thread, turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, additionalContext } };
    // A loaded thread/resume can keep the previous policy (including full access).
    // Resolve a fresh native policy to retain configured roots and tmp exclusions,
    // then apply it atomically to the next turn, even on an already-loaded thread.
    const resolved = await this.request('thread/start', { ...thread, cwd, ephemeral: true, config: { 'sandbox_workspace_write.network_access': true } });
    try {
      if (resolved.sandbox?.type !== 'workspaceWrite' || resolved.approvalPolicy !== 'on-request') {
        throw new RpcResponseError('Codex could not apply workspace permissions.');
      }
      return { thread, turn: { approvalPolicy: resolved.approvalPolicy, sandboxPolicy: resolved.sandbox, additionalContext } };
    } finally {
      if (resolved.thread?.id) await this.request('thread/unsubscribe', { threadId: resolved.thread.id }).catch(() => {});
    }
  }
  child: ChildProcess | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private starting: Promise<void> | null = null;
  private launchAbort: AbortController | null = null;
  ready = false;
  stderr = '';
  // Without a binary of its own, this host's Codex is used (see codex-binary.ts).
  constructor(private binary?: string, private args = ['app-server', '--listen', 'stdio://'], private env: NodeJS.ProcessEnv = process.env, private platform = process.platform) { super(); }
  // Codex sandboxes commands on Windows only with a Windows sandbox set up.
  // Without one configured, workspace access resolves to read-only and its
  // sandbox cannot start; Papilot's threads then use the sandbox that needs no
  // administrator setup. A sandbox the user configured is kept.
  private threadConfig: Record<string, unknown> = {};
  detect() { return Boolean(this.binary || codexCandidates(this.env, DATA, ROOT).length); }
  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.launch().finally(() => { if (this.starting === starting) this.starting = null; });
    this.starting = starting;
    return starting;
  }
  // close() invalidates both the lookup and initialization of that launch.
  private generation = 0;
  private async launch() {
    this.stderr = '';
    const controller = new AbortController();
    this.launchAbort = controller;
    const generation = this.generation;
    const binary = this.binary || await codexBinary(this.env, DATA, controller.signal);
    if (generation !== this.generation) throw new Error('Codex is not connected.');
    const child = spawnCommand(binary, this.args, { cwd: codexWorkingDirectory(this.env) ?? ROOT, env: { ...this.env, PATH: agentPath(this.env) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    // A closed launch's child may still print before it exits; only the current one speaks for Codex.
    lines.on('line', line => { if (this.child !== child) return; try { this.receive(JSON.parse(line)); } catch { /* non-protocol stdout is ignored */ } });
    child.stderr!.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-12000); });
    const failed = (error: Error) => {
      if (this.child !== child) return;
      this.ready = false; this.child = null;
      for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
      this.pending.clear(); this.emit('disconnected', error);
    };
    child.once('error', failed);
    child.once('exit', (code, signal) => failed(new Error(`Codex exited (${signal || code})`)));
    // The experimental API carries the tools Papilot gives its threads (see VIEW_PDF_TOOL).
    await this.request('initialize', { clientInfo: { name: 'papilot', title: 'Papilot', version: VERSION }, capabilities: { experimentalApi: true } });
    if (generation !== this.generation) throw new Error('Codex is not connected.');
    this.notify('initialized', {});
    this.threadConfig = {};
    if (this.platform === 'win32') {
      // An older Codex without config/read answers with an error: keep its
      // defaults. A Codex that exits meanwhile fails this launch.
      const effective = await this.request('config/read', {}).catch(error => { if (error instanceof RpcResponseError) return null; throw error; });
      if (generation !== this.generation || this.child !== child) throw new Error('Codex is not connected.');
      if (effective && !effective.config?.windows?.sandbox) this.threadConfig = { 'windows.sandbox': 'unelevated' };
    }
    this.ready = true;
  }
  private receive(message: any) {
    if (message.method) { this.emit(message.id === undefined ? 'notification' : 'request', message); return; }
    const wait = this.pending.get(message.id);
    if (!wait) return;
    clearTimeout(wait.timer); this.pending.delete(message.id);
    if (message.error) wait.reject(new RpcResponseError(message.error.message || JSON.stringify(message.error)));
    else wait.resolve(message.result);
  }
  request(method: string, params: unknown, timeout = 60000): Promise<any> {
    if (!this.child) return Promise.reject(new Error('Codex is not connected.'));
    if ((method === 'thread/start' || method === 'thread/resume') && Object.keys(this.threadConfig).length && params && typeof params === 'object')
      params = { ...params, config: { ...this.threadConfig, ...(params as { config?: Record<string, unknown> }).config } };
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}. Check the task status before retrying.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  notify(method: string, params: unknown) { this.child?.stdin?.write(JSON.stringify({ method, params }) + '\n'); }
  respond(id: string | number, result: unknown) { if (!this.child) throw new Error('Codex disconnected. Resume the task before retrying.'); this.child.stdin!.write(JSON.stringify({ id, result }) + '\n'); }
  reject(id: string | number, message: string) { this.child?.stdin?.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n'); }
  close() {
    this.generation++; this.launchAbort?.abort(); this.launchAbort = null; this.starting = null; this.ready = false;
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('Codex is not connected.')); }
    this.pending.clear();
    this.child?.stdin?.end(); this.child?.kill('SIGTERM'); this.child = null;
  }
}
