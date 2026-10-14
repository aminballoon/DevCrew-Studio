import { randomUUID } from 'node:crypto';

import { gateReview } from './discordReview';
import { secret } from './secrets';
import type { GateNotice } from './notify';

/**
 * A Discord bot of your own that brings gates to your phone: the review itself, buttons to
 * answer, and comments typed in the DM. Free: no AI in between.
 * Sending uses Discord's REST API (any process); clicks and DMs arrive over the Gateway
 * websocket, which the dashboard keeps open, so nothing needs to be reachable from the internet.
 */
export interface DiscordChannel {
  type: 'discord';
  /** Env var with the bot token (Developer Portal → Bot → Reset Token). */
  tokenEnv: string;
  /** Discord user ids allowed to answer gates. The first one gets the DM. */
  userIds: string[];
  /** Post in this server channel instead of a DM. */
  channelId?: string;
}

/** What the dashboard offers the bot: answer a gate, and which runs wait at one. */
export interface GateHost {
  resolve(runId: string, decision: string, feedback?: string): Promise<void>;
  waiting(): string[];
  /** Answers the run's gate takes. */
  decisionsOf(runId: string): string[];
}

const API = 'https://discord.com/api/v10';
/** custom_id: devcrew|<runId>|<decision> for a gate button, devcrewc|<commentId>|<decision> for a typed comment. */
const SEP = '|';
const INTENT_DIRECT_MESSAGES = 1 << 12;

const token = (ch: DiscordChannel) => secret(ch.tokenEnv);

async function rest(tok: string, method: string, path: string, body?: unknown, files: { name: string; text: string }[] = []): Promise<any> {
  let init: RequestInit;
  if (files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...(body as object), attachments: files.map((f, id) => ({ id, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.text], { type: 'text/plain' }), f.name));
    init = { method, headers: { authorization: `Bot ${tok}` }, body: form };
  } else {
    init = { method, headers: { authorization: `Bot ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
  }
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) { throw new Error(`discord ${method} ${path} answered ${res.status} ${(await res.text()).slice(0, 200)}`); }
  return res.status === 204 ? null : res.json();
}

const LABELS: Record<string, { label: string; style: number }> = {
  approve: { label: 'Approve', style: 3 },
  revise: { label: 'Revise', style: 1 },
  retry: { label: 'Retry', style: 1 },
  replan: { label: 'Replan', style: 2 },
  abort: { label: 'Abort', style: 4 },
};
const button = (tag: string, id: string, d: string, label?: string) =>
  ({ type: 2, custom_id: [tag, id, d].join(SEP), label: label ?? LABELS[d]?.label ?? d, style: LABELS[d]?.style ?? 2 });

/** The message for a gate: the review, buttons for each answer, the full documents attached. */
export function gateMessage(n: GateNotice, payload: Record<string, unknown> = {}) {
  const { embeds, files } = gateReview({ title: n.title, ...payload });
  return {
    body: {
      content: `DevCrew run \`${n.runId}\` is waiting for you. Tap a button, or reply to this message to comment.\n${n.dashboardUrl}`,
      embeds: embeds.slice(0, 10),
      components: [{ type: 1, components: n.decisions.map(d => button('devcrew', n.runId, d)) }],
    },
    // Discord takes at most 10 files of 8 MB (free); text past 1 MB is not worth reading on a phone
    files: files.slice(0, 10).map(f => ({ ...f, text: f.text.slice(0, 1_000_000) })),
  };
}

export async function sendDiscord(ch: DiscordChannel, n: GateNotice, payload: Record<string, unknown> = {}): Promise<void> {
  const tok = token(ch);
  let channelId = ch.channelId;
  if (!channelId) {
    if (!ch.userIds?.length) { throw new Error('discord: set userIds (who may answer, and who gets the DM)'); }
    channelId = (await rest(tok, 'POST', '/users/@me/channels', { recipient_id: ch.userIds[0] })).id as string;
  }
  const { body, files } = gateMessage(n, payload);
  await rest(tok, 'POST', `/channels/${channelId}/messages`, body, files);
}

/** Comments typed in the DM, waiting for you to say what they are (Revise, Approve with note...). */
const comments = new Map<string, { runId: string; text: string }>();

const RUN_IN_TEXT = /`(\d{8}-[0-9a-f]{6})`/;

/**
 * What to answer a typed message: a comment on a waiting gate becomes a question with buttons
 * ("send as Revise / Approve with this note / Cancel"). The run is the one the message replies to,
 * or the only run waiting. Pure apart from the comment store, so it can be tested without Discord.
 */
export function handleMessage(m: any, allowed: string[], host: GateHost): unknown {
  if (m.author?.bot || !allowed.includes(m.author?.id)) { return null; }
  const text = String(m.content ?? '').trim();
  if (!text) { return null; }
  const replied = String(m.referenced_message?.content ?? '').match(RUN_IN_TEXT)?.[1];
  const waiting = host.waiting();
  const runId = replied ?? (waiting.length === 1 ? waiting[0] : undefined);
  if (!runId) {
    return { content: waiting.length ? `${waiting.length} runs are waiting (${waiting.map(r => `\`${r}\``).join(', ')}). Reply to the gate message you mean.` : 'No run is waiting for you right now.' };
  }
  if (!waiting.includes(runId)) { return { content: `Run \`${runId}\` is not waiting at a gate any more.` }; }
  const id = randomUUID().slice(0, 8);
  comments.set(id, { runId, text });
  // Escalations take retry/replan, plan and code gates take approve/revise; a note goes with any of them
  const decisions = host.decisionsOf(runId);
  return {
    content: `Your comment on run \`${runId}\`:\n> ${text.slice(0, 1500).replace(/\n/g, '\n> ')}\nSend it as:`,
    components: [{ type: 1, components: [
      ...decisions.filter(d => d !== 'abort').map(d => button('devcrewc', id, d, d === 'approve' ? 'Approve with this note' : `${LABELS[d]?.label ?? d} with this comment`)),
      { type: 2, custom_id: ['devcrewc', id, 'cancel'].join(SEP), label: 'Cancel', style: 2 },
    ] }],
    message_reference: m.id ? { message_id: m.id } : undefined,
  };
}

/** What to send back for one button click or form (pure apart from the comment store). */
export async function handleInteraction(i: any, allowed: string[], host: GateHost): Promise<unknown> {
  const user = i.member?.user?.id ?? i.user?.id;
  const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64 } });
  const [tag, key, decision] = String(i.data?.custom_id ?? '').split(SEP);
  if (!['devcrew', 'devcrewc'].includes(tag) || !key || !decision) { return null; }
  if (!allowed.includes(user)) { return ephemeral('You are not allowed to answer DevCrew gates.'); }

  let runId = key, feedback: string | undefined;
  if (tag === 'devcrewc') {
    const c = comments.get(key);
    if (decision === 'cancel') { comments.delete(key); return { type: 7, data: { content: 'Comment not sent.', components: [] } }; }
    if (!c) { return ephemeral('This comment is no longer known (the dashboard restarted). Type it again.'); }
    ({ runId, text: feedback } = c);
  } else if (i.type === 3) {
    // Every answer opens a form with a text box: an agent's question needs a typed answer, and a note can go with any decision
    const needs = decision === 'revise';
    const label = { revise: 'What should change?', approve: 'Note for the next step (optional)', retry: 'Hint for Dev (optional)', replan: 'What the Planner should change (optional)', abort: 'Why stop? (optional)' }[decision] ?? 'Note (optional)';
    return {
      type: 9,
      data: {
        custom_id: i.data.custom_id, title: LABELS[decision]?.label ?? decision,
        components: [{ type: 1, components: [{ type: 4, custom_id: 'feedback', label, style: 2, required: needs, max_length: 2000 }] }],
      },
    };
  } else if (i.type === 5) {
    feedback = i.data.components?.flatMap((r: any) => r.components).find((c: any) => c.custom_id === 'feedback')?.value || undefined;
  }
  try {
    await host.resolve(runId, decision, feedback);
  } catch (e) {
    return ephemeral(`Not sent: ${(e as Error).message}`);
  }
  if (tag === 'devcrewc') { comments.delete(key); }
  const done = `Answered **${decision}**${feedback ? `: ${feedback}` : ''} (by <@${user}>)`;
  // Replace the buttons with the answer, so nobody presses one twice
  return i.message ? { type: 7, data: { content: `${i.message.content}\n${done}`, components: [] } } : ephemeral(done);
}

/**
 * Keeps a Gateway connection open, answers button clicks and turns DMs into comments.
 * Reconnects on its own; returns a stop function. Needs no privileged intents.
 */
export function listenDiscord(ch: DiscordChannel, host: GateHost, log: (m: string) => void = console.log): () => void {
  const tok = token(ch);
  let ws: WebSocket | undefined, beat: NodeJS.Timeout | undefined, seq: number | null = null, stopped = false, retry: NodeJS.Timeout | undefined;

  const connect = async () => {
    try {
      const { url } = await rest(tok, 'GET', '/gateway/bot');
      ws = new WebSocket(`${url}/?v=10&encoding=json`);
    } catch (e) {
      log(`Discord: cannot connect (${(e as Error).message}); retrying in 30 s`);
      retry = setTimeout(connect, 30_000);
      return;
    }
    const send = (op: number, d: unknown) => ws!.send(JSON.stringify({ op, d }));
    ws.onmessage = async ev => {
      const m = JSON.parse(String(ev.data));
      if (m.s != null) { seq = m.s; }
      try {
        if (m.op === 10) {
          beat = setInterval(() => send(1, seq), m.d.heartbeat_interval);
          send(2, { token: tok, intents: INTENT_DIRECT_MESSAGES, properties: { os: process.platform, browser: 'devcrew', device: 'devcrew' } });
        } else if (m.op === 1) {
          send(1, seq);
        } else if (m.op === 7 || m.op === 9) {
          ws!.close();
        } else if (m.t === 'READY') {
          log(`Discord bot ${m.d.user.username} is listening for gate answers`);
        } else if (m.t === 'INTERACTION_CREATE') {
          const reply = await handleInteraction(m.d, ch.userIds, host);
          if (reply) { await rest(tok, 'POST', `/interactions/${m.d.id}/${m.d.token}/callback`, reply); }
        } else if (m.t === 'MESSAGE_CREATE' && !m.d.guild_id) {
          const reply = handleMessage(m.d, ch.userIds, host);
          if (reply) { await rest(tok, 'POST', `/channels/${m.d.channel_id}/messages`, reply); }
        }
      } catch (e) {
        log(`Discord: ${(e as Error).message}`);
      }
    };
    ws.onclose = ev => {
      clearInterval(beat);
      if (stopped) { return; }
      // 4004: bad token; reconnecting would only repeat it
      if (ev.code === 4004) { log('Discord: the bot token was refused; check the env var'); return; }
      retry = setTimeout(connect, 5_000);
    };
  };
  void connect();
  return () => { stopped = true; clearTimeout(retry); clearInterval(beat); ws?.close(); };
}
