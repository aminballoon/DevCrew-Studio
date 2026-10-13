import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSession } from '../src/acp/AgentSession';
import { STUDIO_ROOT } from '../src/core/config';
import { EventBus } from '../src/core/events';
import { ROLE_SCOPES } from '../src/core/scope';

const alive = (marker: string) => {
  try { return execSync(`pgrep -f "${marker}"`).toString().trim().length > 0; } catch { return false; }
};

test('closing a session also stops commands the agent left running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-close-'));
  const marker = `sleep 31${Math.floor(Math.random() * 900 + 100)}`;
  // The agent CLI starts a long-running tool in the background, as agents do with test binaries
  const session = await AgentSession.start({
    runId: 'close-test', role: 'single', agentName: 'fake', workspace: dir, scope: ROLE_SCOPES.single,
    bus: new EventBus(id => join(dir, `${id}.jsonl`)), turnTimeoutMs: 60_000,
    spec: { command: 'sh', args: ['-c', `${marker} & exec node ${join(STUDIO_ROOT, 'agents/fake-agent.mjs')}`], env: { FAKE_SCRIPT: 'agents/scripts/cart.mjs' } },
  });
  assert.ok(alive(marker), 'background tool is running');
  session.close();
  for (let i = 0; i < 40 && alive(marker); i++) { await new Promise(r => setTimeout(r, 100)); }
  assert.equal(alive(marker), false, 'background tool was stopped with the session');
});

test('closing a session also stops a CLI the adapter started in a process group of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devcrew-close-'));
  const marker = `sleep 32${Math.floor(Math.random() * 900 + 100)}`;
  const [cmd, arg] = marker.split(' ');
  // Like the agy adapter: a helper of the agent starts the real CLI detached (new process group)
  const helper = `node -e "require('child_process').spawn('${cmd}', ['${arg}'], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000)"`;
  const session = await AgentSession.start({
    runId: 'close-test-2', role: 'single', agentName: 'fake', workspace: dir, scope: ROLE_SCOPES.single,
    bus: new EventBus(id => join(dir, `${id}.jsonl`)), turnTimeoutMs: 60_000,
    spec: { command: 'sh', args: ['-c', `${helper} & exec node ${join(STUDIO_ROOT, 'agents/fake-agent.mjs')}`], env: { FAKE_SCRIPT: 'agents/scripts/cart.mjs' } },
  });
  for (let i = 0; i < 40 && !alive(marker); i++) { await new Promise(r => setTimeout(r, 100)); }
  assert.ok(alive(marker), 'detached CLI is running');
  session.close();
  for (let i = 0; i < 40 && alive(marker); i++) { await new Promise(r => setTimeout(r, 100)); }
  assert.equal(alive(marker), false, 'detached CLI was stopped with the session');
});
