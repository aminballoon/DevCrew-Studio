import { createHmac } from 'node:crypto';

import type { DevcrewConfig } from './config';
import type { GateId } from './events';

/**
 * Where to tell you a run is waiting at a gate, so the question reaches your phone through a
 * chat agent you already run (OpenClaw or Hermes deliver to Telegram, WhatsApp, Signal...).
 * Secrets are never stored in the config: each channel names the environment variable that holds it.
 */
export type NotifyChannel =
  | {
    type: 'openclaw';
    /** Gateway hook URL, e.g. http://127.0.0.1:18789/hooks/agent */
    url: string;
    /** Env var with the hooks token (hooks.token in the OpenClaw config). */
    tokenEnv: string;
    agentId?: string;
    /** Chat to deliver to, e.g. "telegram" and a chat id. Both or neither. */
    channel?: string;
    to?: string;
  }
  | {
    type: 'hermes';
    /** Webhook route URL, e.g. http://127.0.0.1:8644/webhooks/devcrew-gate */
    url: string;
    /** Env var with the route's secret (signed as Generic V2). */
    secretEnv: string;
  }
  | {
    type: 'webhook';
    url: string;
    /** Optional env var with a bearer token. */
    tokenEnv?: string;
  };

export interface NotifyConfig {
  channels: NotifyChannel[];
  /** How the chat agent reaches the dashboard to answer, default http://127.0.0.1:4317 */
  dashboardUrl?: string;
}

export interface GateNotice {
  runId: string;
  gate: GateId;
  title: string;
  /** Answers this gate accepts. */
  decisions: string[];
  /** Plain-text question for a person on a phone, with how to answer. */
  text: string;
  /** Where the agent POSTs { decision, feedback } to answer. */
  answerUrl: string;
  /** Where the agent GETs the gate's details as plain text. */
  detailsUrl: string;
  dashboardUrl: string;
}

export const gateDecisions = (payload: Record<string, unknown>): string[] =>
  payload.kind === 'escalation' ? ['retry', 'replan', 'abort'] : ['approve', 'revise', 'abort'];

export function gateNotice(cfg: NotifyConfig, runId: string, gate: GateId, payload: Record<string, unknown>, requirement: string): GateNotice {
  const base = (cfg.dashboardUrl ?? `http://127.0.0.1:${process.env.PORT ?? 4317}`).replace(/\/$/, '');
  const decisions = gateDecisions(payload);
  const title = String(payload.title ?? gate);
  const reasons = Array.isArray(payload.reasons) && payload.reasons.length ? `\nWhy: ${payload.reasons.slice(0, 3).join('; ')}` : '';
  const text = [
    `DevCrew run ${runId} is waiting for you: ${title}`,
    `Requirement: ${requirement.split('\n')[0].slice(0, 160)}`,
    reasons.trim(),
    `Reply with one of: ${decisions.join(' / ')} (add feedback after it, e.g. "revise: keep prices in cents").`,
    `Review in full: ${base}/#run=${runId}`,
  ].filter(Boolean).join('\n');
  return {
    runId, gate, title, decisions, text,
    answerUrl: `${base}/api/runs/${runId}/gate`,
    detailsUrl: `${base}/api/runs/${runId}/gate.txt`,
    dashboardUrl: `${base}/#run=${runId}`,
  };
}

/** Instructions the chat agent gets with each gate, so it can answer from your reply. */
function agentMessage(n: GateNotice): string {
  return [
    'Send the person the question below on their chat, word for word.',
    'When they reply, turn the reply into a decision and answer the gate with:',
    `curl -s -X POST ${n.answerUrl} -H 'content-type: application/json' -d '{"decision":"<${n.decisions.join('|')}>","feedback":"<their words, optional>"}'`,
    `Only use a decision they clearly chose; if unsure, ask them again. Details: curl -s ${n.detailsUrl}`,
    '',
    n.text,
  ].join('\n');
}

function secret(env: string): string {
  const v = process.env[env];
  if (!v) { throw new Error(`environment variable ${env} is not set`); }
  return v;
}

export async function send(ch: NotifyChannel, n: GateNotice): Promise<void> {
  let headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: string;
  if (ch.type === 'openclaw') {
    headers.authorization = `Bearer ${secret(ch.tokenEnv)}`;
    body = JSON.stringify({
      message: agentMessage(n),
      name: 'DevCrew gate',
      deliver: true,
      ...(ch.agentId ? { agentId: ch.agentId } : {}),
      ...(ch.channel && ch.to ? { channel: ch.channel, to: ch.to } : {}),
    });
  } else if (ch.type === 'hermes') {
    body = JSON.stringify({ ...n, message: agentMessage(n) });
    const ts = String(Math.floor(Date.now() / 1000));
    headers = { ...headers, 'x-webhook-timestamp': ts, 'x-webhook-signature-v2': createHmac('sha256', secret(ch.secretEnv)).update(`${ts}.${body}`).digest('hex') };
  } else {
    if (ch.tokenEnv) { headers.authorization = `Bearer ${secret(ch.tokenEnv)}`; }
    body = JSON.stringify({ ...n, message: agentMessage(n) });
  }
  const res = await fetch(ch.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) { throw new Error(`${ch.type} ${ch.url} answered ${res.status} ${(await res.text()).slice(0, 200)}`); }
}

/** Sends a gate to every channel; returns one line per failure (a broken channel never stops a run). */
export async function notifyGate(cfg: DevcrewConfig, runId: string, gate: GateId, payload: Record<string, unknown>, requirement: string): Promise<string[]> {
  const nc = cfg.notify;
  if (!nc?.channels?.length) { return []; }
  const notice = gateNotice(nc, runId, gate, payload, requirement);
  const results = await Promise.allSettled(nc.channels.map(ch => send(ch, notice)));
  return results.flatMap(r => (r.status === 'rejected' ? [`Gate notification failed: ${(r.reason as Error).message}`] : []));
}
