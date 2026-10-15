import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate run data before any module reads DATA_ROOT
process.env.DEVCREW_NO_NOTIFY = '1';
process.env.DEVCREW_DATA = mkdtempSync(join(tmpdir(), 'devcrew-data-'));
process.env.FAKE_DELAY_MS = '0';
process.env.TEST_OPENCLAW_TOKEN = 'oc-token';
process.env.TEST_HERMES_SECRET = 'hermes-secret';

const { RunManager } = await import('../src/orchestrator/RunManager');
const { getBus, getConfig } = await import('../src/orchestrator/runtime');
const { STUDIO_ROOT } = await import('../src/core/config');

test('a waiting gate is sent to OpenClaw and Hermes, and the chat agent can answer it', { timeout: 60_000 }, async () => {
  const got: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) { body += c; }
    got.push({ path: req.url!, headers: req.headers, body });
    res.writeHead(req.url === '/broken' ? 500 : 200).end('ok');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  getConfig().notify = {
    dashboardUrl: 'http://127.0.0.1:4317',
    channels: [
      { type: 'openclaw', url: `${base}/hooks/agent`, tokenEnv: 'TEST_OPENCLAW_TOKEN', channel: 'telegram', to: '12345' },
      { type: 'hermes', url: `${base}/webhooks/devcrew-gate`, secretEnv: 'TEST_HERMES_SECRET' },
      { type: 'webhook', url: `${base}/broken` },
    ],
  };
  try {
    const runs = new RunManager();
    const runId = runs.start({ requirement: 'Shopping cart\nmore', source: join(STUDIO_ROOT, 'bench/tasks/S-01-cart/seed'), profile: 'fake', pipeline: JSON.parse(readFileSync(join(STUDIO_ROOT, 'test/fixtures/pipelines/standard.json'), 'utf8')) });
    await new Promise<void>(resolve => getBus().subscribe(e => { if (e.runId === runId && e.type === 'gate_waiting') resolve(); }));

    const oc = got.find(g => g.path === '/hooks/agent')!;
    assert.equal(oc.headers.authorization, 'Bearer oc-token');
    const ocBody = JSON.parse(oc.body);
    assert.equal(ocBody.deliver, true);
    assert.equal(ocBody.channel, 'telegram');
    assert.equal(ocBody.to, '12345');
    assert.match(ocBody.message, new RegExp(`/api/runs/${runId}/gate`));
    assert.match(ocBody.message, /approve\|revise\|abort/);

    const he = got.find(g => g.path === '/webhooks/devcrew-gate')!;
    const ts = he.headers['x-webhook-timestamp'] as string;
    assert.equal(he.headers['x-webhook-signature-v2'], createHmac('sha256', 'hermes-secret').update(`${ts}.${he.body}`).digest('hex'));
    assert.equal(JSON.parse(he.body).runId, runId);

    // A broken channel is logged, never stops the run
    assert.ok(getBus().read(runId).some(e => e.type === 'log' && e.level === 'warn' && e.message.includes('/broken')));
    assert.ok(getBus().read(runId).some(e => e.type === 'log' && e.level === 'info' && e.message === 'Gate question sent to hermes'));

    const text = runs.waitingGateText(runId);
    assert.ok(text?.includes('Answers: approve, revise, abort'), text ?? '');
    await assert.rejects(runs.resolveGate(runId, { decision: 'retry' }), /takes approve, revise, abort/);

    await runs.resolveGate(runId, { decision: 'abort' });
    assert.equal(await runs.waitFor(runId), 'aborted');
    assert.equal(runs.waitingGateText(runId), null);
  } finally {
    delete getConfig().notify;
    server.close();
  }
});

test('Discord buttons: only allowed users answer, revise asks for feedback, the buttons go away', async () => {
  const { gateMessage, handleInteraction } = await import('../src/core/discord');
  const { gateNotice } = await import('../src/core/notify');
  const n = gateNotice({ channels: [] }, 'r1', 'gate_spec', { kind: 'spec', title: 'Approve the plan' }, 'Cart');
  assert.deepEqual(gateMessage(n).body.components[0].components.map(b => b.custom_id), ['devcrew|r1|approve', 'devcrew|r1|revise', 'devcrew|r1|abort']);

  const calls: unknown[][] = [];
  const host = { resolve: async (...a: unknown[]) => { calls.push(a); }, waiting: () => ['r1'], decisionsOf: () => ['approve', 'revise', 'abort'] };
  const click = (user: string, id: string) => ({ type: 3, user: { id: user }, data: { custom_id: id }, message: { content: 'DevCrew run r1 is waiting' } });

  const stranger = await handleInteraction(click('999', 'devcrew|r1|approve'), ['42'], host) as any;
  assert.equal(stranger.data.flags, 64);
  assert.equal(calls.length, 0);

  const modal = await handleInteraction(click('42', 'devcrew|r1|revise'), ['42'], host) as any;
  assert.equal(modal.type, 9);
  assert.equal(calls.length, 0);

  const submit = { type: 5, member: { user: { id: '42' } }, message: { content: 'x' }, data: { custom_id: 'devcrew|r1|revise', components: [{ components: [{ custom_id: 'feedback', value: 'cents' }] }] } };
  const done = await handleInteraction(submit, ['42'], host) as any;
  assert.deepEqual(calls, [['r1', 'revise', 'cents']]);
  assert.equal(done.type, 7);
  assert.deepEqual(done.data.components, []);

  // Approve also opens a form, with an optional note
  const approveForm = await handleInteraction(click('42', 'devcrew|r1|approve'), ['42'], host) as any;
  assert.equal(approveForm.type, 9);
  assert.equal(approveForm.data.components[0].components[0].required, false);

  const failing = await handleInteraction({ ...submit, data: { ...submit.data, custom_id: 'devcrew|r1|approve' } }, ['42'], { ...host, resolve: async () => { throw new Error('Run is not waiting at a gate'); } }) as any;
  assert.match(failing.data.content, /not waiting/);
});

test('Discord: the plan gate shows criteria and uncovered sentences, a typed comment becomes a choice', async () => {
  const { gateMessage, handleMessage, handleInteraction } = await import('../src/core/discord');
  const { gateNotice } = await import('../src/core/notify');
  const prd = '# PRD\n\n## Goal\nA cart in cents.\n\n## Acceptance Criteria\n- AC-1 Adds items.\n- AC-2 Rejects negative prices.\n';
  const payload = { kind: 'plan', title: 'Review the plan', prd, clauses: [{ id: 'R-1', text: 'Add items' }, { id: 'R-2', text: 'Trim titles' }],
    plan: { modules: [{ id: 'core', title: 'Core' }], coverage: { 'R-1': ['AC-1'], 'R-2': [] } } };
  const { body, files } = gateMessage(gateNotice({ channels: [] }, 'r1', 'gate_spec', payload, 'Cart'), payload);
  const text = JSON.stringify(body.embeds);
  assert.match(text, /A cart in cents/);
  assert.match(text, /AC-2\*\* Rejects negative prices/);
  assert.match(text, /Not covered: R-2/);
  assert.match(text, /Added by the Planner[^"]*AC-2/);
  assert.deepEqual(files.map(f => f.name), ['PRD.md']);

  const calls: unknown[][] = [];
  const host = { resolve: async (...a: unknown[]) => { calls.push(a); }, waiting: () => ['20261014-abcdef'], decisionsOf: () => ['approve', 'revise', 'abort'] };
  assert.equal(handleMessage({ author: { id: '7' }, content: 'hi' }, ['42'], host), null);
  const ask = handleMessage({ id: 'm1', author: { id: '42' }, content: 'keep prices in cents' }, ['42'], host) as any;
  const ids = ask.components[0].components.map((b: any) => b.custom_id);
  assert.deepEqual(ids.map((x: string) => x.split('|')[2]), ['approve', 'revise', 'cancel']);
  const done = await handleInteraction({ type: 3, user: { id: '42' }, data: { custom_id: ids[1] }, message: { content: 'c' } }, ['42'], host) as any;
  assert.deepEqual(calls, [['20261014-abcdef', 'revise', 'keep prices in cents']]);
  assert.equal(done.type, 7);

  // Two runs waiting and no reply-to: ask which one
  const two = handleMessage({ author: { id: '42' }, content: 'x' }, ['42'], { ...host, waiting: () => ['a', 'b'] }) as any;
  assert.match(two.content, /Reply to the gate message/);
  // A reply to a gate message picks that run
  const replied = handleMessage({ author: { id: '42' }, content: 'ok', referenced_message: { content: 'DevCrew run `20261014-abcdef` is waiting' } }, ['42'], { ...host, waiting: () => ['20261014-abcdef', 'b'] }) as any;
  assert.match(replied.content, /20261014-abcdef/);
});
