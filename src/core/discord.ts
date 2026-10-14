import type { GateNotice } from './notify';

/**
 * A Discord bot of your own that brings gates to your phone with buttons. Free: no AI in between.
 * Sending uses Discord's REST API (any process); clicks arrive over the Gateway websocket, which
 * the dashboard keeps open, so nothing needs to be reachable from the internet.
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

const API = 'https://discord.com/api/v10';
/** custom_id of a button or modal: devcrew|<runId>|<decision> */
const SEP = '|';

/** What the dashboard does with a click: answer the gate, or say why not. */
export type GateResolver = (runId: string, decision: string, feedback?: string) => Promise<void>;

function token(ch: DiscordChannel): string {
  const t = process.env[ch.tokenEnv];
  if (!t) { throw new Error(`environment variable ${ch.tokenEnv} is not set`); }
  return t;
}

async function rest(tok: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bot ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
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

/** The message for a gate: what is asked, buttons for each answer, a link to the dashboard. */
export function gateMessage(n: GateNotice) {
  return {
    content: `DevCrew run \`${n.runId}\` is waiting for you.`,
    embeds: [{ title: n.title, description: n.text.slice(0, 4000), color: 0x534ab7 }],
    components: [{
      type: 1,
      components: n.decisions.map(d => ({ type: 2, custom_id: ['devcrew', n.runId, d].join(SEP), label: LABELS[d]?.label ?? d, style: LABELS[d]?.style ?? 2 })),
    }],
  };
}

export async function sendDiscord(ch: DiscordChannel, n: GateNotice): Promise<void> {
  const tok = token(ch);
  let channelId = ch.channelId;
  if (!channelId) {
    if (!ch.userIds?.length) { throw new Error('discord: set userIds (who may answer, and who gets the DM)'); }
    channelId = (await rest(tok, 'POST', '/users/@me/channels', { recipient_id: ch.userIds[0] })).id as string;
  }
  await rest(tok, 'POST', `/channels/${channelId}/messages`, gateMessage(n));
}

/** What to send back for one interaction (pure, so it can be tested without Discord). */
export async function handleInteraction(i: any, allowed: string[], resolve: GateResolver): Promise<unknown> {
  const user = i.member?.user?.id ?? i.user?.id;
  const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64 } });
  const [tag, runId, decision] = String(i.data?.custom_id ?? '').split(SEP);
  if (tag !== 'devcrew' || !runId || !decision) { return null; }
  if (!allowed.includes(user)) { return ephemeral('You are not allowed to answer DevCrew gates.'); }

  // Revise needs feedback: ask for it in a form first
  if (i.type === 3 && decision === 'revise') {
    return {
      type: 9,
      data: {
        custom_id: i.data.custom_id, title: 'Revise',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'feedback', label: 'What should change?', style: 2, required: true, max_length: 2000 }] }],
      },
    };
  }
  const feedback = i.type === 5
    ? i.data.components?.flatMap((r: any) => r.components).find((c: any) => c.custom_id === 'feedback')?.value
    : undefined;
  try {
    await resolve(runId, decision, feedback || undefined);
  } catch (e) {
    return ephemeral(`Not sent: ${(e as Error).message}`);
  }
  const done = `Answered **${decision}**${feedback ? `: ${feedback}` : ''} (by <@${user}>)`;
  // Replace the buttons with the answer, so nobody presses one twice
  return i.message ? { type: 7, data: { content: `${i.message.content}\n${done}`, components: [] } } : ephemeral(done);
}

/**
 * Keeps a Gateway connection open and answers button clicks. Reconnects on its own; returns a stop function.
 * Needs no privileged intents: interactions reach every bot.
 */
export function listenDiscord(ch: DiscordChannel, resolve: GateResolver, log: (m: string) => void = console.log): () => void {
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
      if (m.op === 10) {
        beat = setInterval(() => send(1, seq), m.d.heartbeat_interval);
        send(2, { token: tok, intents: 0, properties: { os: process.platform, browser: 'devcrew', device: 'devcrew' } });
      } else if (m.op === 1) {
        send(1, seq);
      } else if (m.op === 7 || m.op === 9) {
        ws!.close();
      } else if (m.t === 'READY') {
        log(`Discord bot ${m.d.user.username} is listening for gate answers`);
      } else if (m.t === 'INTERACTION_CREATE') {
        const reply = await handleInteraction(m.d, ch.userIds, resolve);
        if (reply) {
          await rest(tok, 'POST', `/interactions/${m.d.id}/${m.d.token}/callback`, reply).catch(e => log(`Discord: ${(e as Error).message}`));
        }
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
