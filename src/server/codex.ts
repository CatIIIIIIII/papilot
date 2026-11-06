import { agentPath } from '../../bin/agent-paths.mjs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { TaskPermissions, TaskPermissionOption } from '../shared.ts';
import { CODEX, ROOT, VERSION } from './paths.ts';

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
    if (value === 'full') return { thread, turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } };
    // A loaded thread/resume can keep the previous policy (including full access).
    // Resolve a fresh native policy to retain configured roots and tmp exclusions,
    // then apply it atomically to the next turn, even on an already-loaded thread.
    const resolved = await this.request('thread/start', { ...thread, cwd, ephemeral: true, config: { 'sandbox_workspace_write.network_access': true } });
    try {
      if (resolved.sandbox?.type !== 'workspaceWrite' || resolved.approvalPolicy !== 'on-request') {
        throw new RpcResponseError('Codex could not apply workspace permissions.');
      }
      return { thread, turn: { approvalPolicy: resolved.approvalPolicy, sandboxPolicy: resolved.sandbox } };
    } finally {
      if (resolved.thread?.id) await this.request('thread/unsubscribe', { threadId: resolved.thread.id }).catch(() => {});
    }
  }
  child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private starting: Promise<void> | null = null;
  ready = false;
  stderr = '';
  constructor(private binary = CODEX, private args = ['app-server', '--listen', 'stdio://'], private env: NodeJS.ProcessEnv = process.env) { super(); }
  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async launch() {
    this.stderr = '';
    const child = spawn(this.binary, this.args, { cwd: ROOT, env: { ...this.env, PATH: agentPath(this.env) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { /* non-protocol stdout is ignored */ } });
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-12000); });
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
    this.notify('initialized', {}); this.ready = true;
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
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}. Check the task status before retrying.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  notify(method: string, params: unknown) { this.child?.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  respond(id: string | number, result: unknown) { if (!this.child) throw new Error('Codex disconnected. Resume the task before retrying.'); this.child.stdin.write(JSON.stringify({ id, result }) + '\n'); }
  reject(id: string | number, message: string) { this.child?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n'); }
  close() { this.child?.stdin.end(); this.child?.kill('SIGTERM'); }
}
