import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  Client,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import type { AgentSpec } from '../core/config';
import { childEnv } from '../core/env';
import { STUDIO_ROOT } from '../core/config';
import type { EventBus, Role, UsageNumbers } from '../core/events';
import { isAllowed, toRelative, type Scope } from '../core/scope';

export interface AgentSessionOptions {
  runId: string;
  role: Role;
  agentName: string;
  spec: AgentSpec;
  /** The agent works in, and may only write inside, this directory. */
  workspace: string;
  scope: Scope;
  bus: EventBus;
  turnTimeoutMs: number;
}

export interface TurnResult {
  text: string;
  stopReason: string;
  usage: UsageNumbers;
}

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

/**
 * One agent process + one ACP session, driven headless.
 *
 * Mirrors vscode-acp's ConnectionManager/AcpClientImpl, minus VS Code: permission
 * requests and client-side file writes are answered by the role's Scope instead of
 * a person. Writes the agent makes through its own tools never reach the client, so
 * the caller must still diff the workspace after each turn (see guard/snapshot).
 */
export class AgentSession {
  private text = '';
  private pending = '';
  private lastCost = 0;
  private context: { used?: number; size?: number } = {};
  /** Sum of usage_update.used this turn, for agents that report no usage on the prompt response. */
  private turnStepTokens = 0;
  private exited?: Error;

  private constructor(
    private readonly opts: AgentSessionOptions,
    private readonly proc: ChildProcess,
    private readonly connection: ClientSideConnection,
    readonly sessionId: string,
  ) {}

  static async start(opts: AgentSessionOptions): Promise<AgentSession> {
    const proc = spawn(opts.spec.command, (opts.spec.args ?? []).map(resolveStudioPath), {
      cwd: opts.workspace,
      env: childEnv(resolveEnv(opts.spec.env)),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr!.on('data', d => { stderr = (stderr + d).slice(-4000); });

    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );
    let session: AgentSession | undefined;
    const client: Client = {
      requestPermission: p => session!.requestPermission(p),
      sessionUpdate: async p => session?.onUpdate(p),
      writeTextFile: p => session!.writeTextFile(p),
      readTextFile: p => session!.readTextFile(p),
      // Vendor extensions DevCrew does not use (e.g. Claude's _auth/status_update): ignore quietly
      extNotification: async () => {},
    };
    const connection = new ClientSideConnection(() => client, stream);

    const failed = new Promise<never>((_, reject) => {
      proc.once('error', reject);
      proc.once('exit', code => reject(new Error(`Agent "${opts.agentName}" exited (${code}) during startup: ${stderr.trim()}`)));
    });
    const init = (async () => {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'devcrew-studio', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      // Vendor-specific session options from the config (for Claude: which settings and skills load)
      return connection.newSession({ cwd: opts.workspace, mcpServers: [], ...(opts.spec.sessionMeta && { _meta: opts.spec.sessionMeta }) });
    })();
    const { sessionId } = await Promise.race([init, failed]);

    session = new AgentSession(opts, proc, connection, sessionId);
    proc.on('exit', code => { session!.exited = new Error(`Agent "${opts.agentName}" exited (${code}): ${stderr.trim()}`); });
    return session;
  }

  async prompt(text: string): Promise<TurnResult> {
    if (this.exited) { throw this.exited; }
    this.text = '';
    const costBefore = this.lastCost;
    this.turnStepTokens = 0;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void this.connection.cancel({ sessionId: this.sessionId }).catch(() => {});
        // What the turn used so far still counts; agents that only report usage at the end lose it otherwise
        if (this.turnStepTokens) {
          this.emit({
            type: 'usage', role: this.opts.role, agent: this.opts.agentName, contextUsed: this.context.used, contextSize: this.context.size,
            inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: this.turnStepTokens, costUsd: Math.max(0, this.lastCost - costBefore),
          });
        }
        reject(new Error(`Turn timed out after ${Math.round(this.opts.turnTimeoutMs / 60000)} min`));
      }, this.opts.turnTimeoutMs);
    });
    const exited = new Promise<never>((_, reject) => this.proc.once('exit', () => setImmediate(() => reject(this.exited))));
    try {
      const response = await Promise.race([
        this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text }] }),
        timeout,
        exited,
      ]);
      this.flushText();
      const u = response.usage;
      const usage: UsageNumbers = {
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        cachedReadTokens: u?.cachedReadTokens ?? 0,
        cachedWriteTokens: u?.cachedWriteTokens ?? 0,
        // google-antigravity-acp sends no response usage, only per-model-call totals
        totalTokens: u?.totalTokens ?? this.turnStepTokens,
        costUsd: Math.max(0, this.lastCost - costBefore),
      };
      this.emit({
        type: 'usage', role: this.opts.role, agent: this.opts.agentName,
        contextUsed: this.context.used, contextSize: this.context.size, ...usage,
      });
      return { text: this.text, stopReason: response.stopReason, usage };
    } finally {
      clearTimeout(timer);
      this.flushText();
    }
  }

  close(): void {
    if (!this.proc.killed && this.proc.exitCode === null) { this.proc.kill(); }
  }

  // --- ACP client side ---

  private async requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const paths = [
      ...(p.toolCall.locations ?? []).map(l => l.path),
      ...(p.toolCall.content ?? []).flatMap(c => (c.type === 'diff' ? [c.path] : [])),
    ];
    const denied = EDIT_KINDS.has(p.toolCall.kind ?? '')
      ? paths.filter(path => !isAllowed(this.opts.scope, this.opts.workspace, path))
      : [];
    const pick = (kind: 'allow' | 'reject') =>
      p.options.find(o => o.kind === `${kind}_once`) ?? p.options.find(o => o.kind.startsWith(kind));
    if (denied.length) {
      this.emit({ type: 'guard_violation', role: this.opts.role, files: denied.map(d => this.rel(d)), action: 'rejected' });
      const reject = pick('reject');
      return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
    }
    const allow = pick('allow');
    return { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } };
  }

  private async writeTextFile(p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    if (!isAllowed(this.opts.scope, this.opts.workspace, p.path)) {
      this.emit({ type: 'guard_violation', role: this.opts.role, files: [this.rel(p.path)], action: 'rejected' });
      throw new Error(`${this.opts.role} may not write ${this.rel(p.path)}`);
    }
    const path = resolve(this.opts.workspace, p.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, p.content);
    return {};
  }

  private async readTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    if (toRelative(this.opts.workspace, p.path) === undefined) {
      throw new Error(`Reading outside the workspace is not allowed: ${p.path}`);
    }
    let content = await readFile(resolve(this.opts.workspace, p.path), 'utf8');
    if (p.line != null || p.limit != null) {
      const lines = content.split('\n');
      const start = (p.line ?? 1) - 1;
      content = lines.slice(start, p.limit != null ? start + p.limit : undefined).join('\n');
    }
    return { content };
  }

  private onUpdate(n: SessionNotification): void {
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') {
          this.text += u.content.text;
          this.pending += u.content.text;
          if (this.pending.length > 600 || this.pending.endsWith('\n\n')) { this.flushText(); }
        }
        break;
      case 'tool_call':
        this.flushText();
        this.emit({ type: 'tool_call', role: this.opts.role, toolCallId: u.toolCallId, title: u.title, kind: u.kind ?? undefined, status: u.status ?? undefined });
        break;
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') {
          this.emit({ type: 'tool_call', role: this.opts.role, toolCallId: u.toolCallId, title: u.title ?? '', status: u.status });
        }
        break;
      case 'usage_update':
        // Cost is the session total, not a delta
        this.context = { used: u.used, size: u.size };
        this.turnStepTokens += u.used ?? 0;
        if (u.cost) { this.lastCost = u.cost.amount; }
        break;
    }
  }

  private flushText(): void {
    if (!this.pending.trim()) { this.pending = ''; return; }
    this.emit({ type: 'agent_text', role: this.opts.role, text: this.pending });
    this.pending = '';
  }

  private emit(body: Parameters<EventBus['emit']>[1]): void {
    this.opts.bus.emit(this.opts.runId, body);
  }

  private rel(path: string): string {
    return toRelative(this.opts.workspace, path) ?? path;
  }
}

/** Agents run in the workspace, so args and env may name files in this repo (agents/, bench/) relative to it. */
const resolveStudioPath = (v: string) => (v.startsWith('agents/') || v.startsWith('bench/') ? resolve(STUDIO_ROOT, v) : v);

function resolveEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, resolveStudioPath(v)]));
}
