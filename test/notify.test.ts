import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate run data before any module reads DATA_ROOT
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
    const runId = runs.start({ requirement: 'Shopping cart\nmore', source: join(STUDIO_ROOT, 'bench/tasks/S-01-cart/seed'), profile: 'fake' });
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
    assert.ok(getBus().read(runId).some(e => e.type === 'log' && e.message.includes('/broken')));

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
