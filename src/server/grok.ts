import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { TaskPermissionOption, TaskPermissions } from '../shared.ts';
import type { AgentRuntime } from './agents.ts';
import { RpcResponseError } from './codex.ts';
import { ACP_PROFILES, AcpAgent } from './acp.ts';

interface Session { agent: AcpAgent; permissions: TaskPermissions; params: any; running: boolean }

// Grok reads permissions from session metadata. Its live mode extensions affect
// multiple sessions, and resuming a resident session does not reliably revoke
// YOLO. Each task therefore gets a fresh process before restoring its session.
export class GrokAgent extends EventEmitter implements AgentRuntime {
  private probe: AcpAgent;
  private sessions = new Map<string, Session>();
  private workers = new Set<AcpAgent>();
  private approvals = new Map<string, AcpAgent>();
  private generation = 0;
  constructor(private binary?: string, private launch: typeof spawn = spawn) {
    super();
    this.probe = new AcpAgent(ACP_PROFILES.grok, binary, launch);
    this.probe.on('disconnected', error => { this.close(); this.emit('disconnected', error); });
  }
  get ready() { return this.probe.ready; }
  detect() { return this.probe.detect(); }
  start() { return this.probe.start(); }
  permissionOptions(): TaskPermissionOption[] {
    return [
      { value: 'workspace', label: 'Default', detail: 'Ask before tools' },
      { value: 'full', label: 'YOLO', detail: 'Approve all tools' },
    ];
  }
  async taskPermissionConfig(value: TaskPermissions) {
    if (!this.permissionOptions().some(option => option.value === value)) throw new Error('Grok does not support the selected permissions.');
    return { thread: { taskPermissions: value }, turn: { taskPermissions: value } };
  }
  private worker(permissions: TaskPermissions) {
    const agent = new AcpAgent({ ...ACP_PROFILES.grok, sessionMeta: { yoloMode: permissions === 'full', autoMode: false } }, this.binary, this.launch);
    this.workers.add(agent);
    agent.on('notification', message => {
      this.emit('notification', message);
      if (message.method === 'turn/completed') {
        const session = this.sessions.get(message.params.threadId);
        if (session?.agent === agent) session.running = false;
        this.release(agent);
      }
    });
    agent.on('request', message => { this.approvals.set(String(message.id), agent); this.emit('request', message); });
    return agent;
  }
  private release(agent: AcpAgent) {
    agent.close();
    this.workers.delete(agent);
    for (const [id, owner] of this.approvals) if (owner === agent) this.approvals.delete(id);
  }
  async request(method: string, params: any = {}, timeout?: number): Promise<any> {
    const generation = this.generation;
    const connected = () => {
      if (!this.ready || generation !== this.generation) throw new Error('Grok disconnected. Reconnect to resume.');
    };
    if (method === 'thread/start' || method === 'thread/resume') {
      const permissions = params.sandbox === 'read-only' ? 'workspace' : params.taskPermissions || 'workspace';
      await this.taskPermissionConfig(permissions);
      connected();
      const previous = params.threadId && this.sessions.get(String(params.threadId));
      if (previous?.running) throw new Error('Pause the task before restoring its session.');
      if (previous) this.release(previous.agent);
      const agent = this.worker(permissions);
      try {
        await agent.start();
        connected();
        const result = await agent.request(method, { ...params, taskPermissions: 'workspace' });
        connected();
        this.sessions.set(result.thread.id, { agent, permissions, params: { ...params, threadId: result.thread.id }, running: false });
        return result;
      } catch (error) { this.release(agent); throw error; }
    }
    const session = params.threadId && this.sessions.get(String(params.threadId));
    if (method === 'turn/start') {
      try {
        if (!session) throw new Error('Start or resume the thread before starting a turn.');
        if (session.running) throw new Error('This task already has a running turn.');
        const permissions = session.params.sandbox === 'read-only' ? 'workspace' : params.taskPermissions || session.permissions;
        await this.taskPermissionConfig(permissions);
        connected();
        if (!session.agent.ready || session.permissions !== permissions) {
          this.release(session.agent);
          const agent = this.worker(permissions);
          try {
            await agent.start();
            connected();
            await agent.request('thread/resume', { ...session.params, ...(params.model !== undefined ? { model: params.model } : {}), taskPermissions: 'workspace' });
            connected();
          } catch (error) { this.release(agent); throw error; }
          session.agent = agent; session.permissions = permissions;
        }
        session.params = { ...session.params, ...(params.model !== undefined ? { model: params.model } : {}) };
        session.running = true;
        try { return await session.agent.request(method, { ...params, taskPermissions: 'workspace' }); }
        catch (error) { session.running = false; this.release(session.agent); throw error; }
      } catch (error) {
        // The worker's Adapter returns its turn ID before scheduling any prompt.
        // Failures here therefore have a definite outcome and can be retried.
        throw new RpcResponseError(error instanceof Error ? error.message : String(error));
      }
    }
    if (session) return session.agent.request(method, params);
    return this.probe.request(method, params);
  }
  respond(id: string | number, result: unknown) {
    const agent = this.approvals.get(String(id));
    if (!agent) throw new Error('This request has ended.');
    agent.respond(id, result); this.approvals.delete(String(id));
  }
  reject(id: string | number, message: string) {
    const agent = this.approvals.get(String(id));
    if (!agent) throw new Error('This request has ended.');
    agent.reject(id, message); this.approvals.delete(String(id));
  }
  close() {
    this.generation++;
    this.probe.close();
    for (const worker of this.workers) this.release(worker);
    // Workspace can retain loaded idle threads across a reconnect. Keep the
    // metadata needed to restore them, but never a running worker.
    for (const session of this.sessions.values()) session.running = false;
    this.approvals.clear();
  }
}
