import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { ValidationError, NotFoundError } from '../src/index.ts';
import { setup, allFiles, PNG, TXT } from './helpers.ts';

test('rejects names that could escape the root or hide files', async () => {
  const { store, sandbox, root } = setup();
  const bad = ['../evil.txt', '..', '.', 'a/b.txt', 'a\\b.txt', '..\\evil.txt', '/etc/passwd', '.hidden', 'nul\0.txt', 'tab\t.txt', 'new\nline.txt', '', 'x'.repeat(256)];
  for (const name of bad) {
    await assert.rejects(store.put('ann', name, TXT('x'), 'text/plain'), ValidationError, JSON.stringify(name));
  }
  await store.put('ann', 'x'.repeat(255), TXT('x'), 'text/plain');
  assert.deepEqual(readdirSync(sandbox), ['root']);
  assert.ok(allFiles(root).length >= 1);
});

test('owner names cannot be used to escape the root either', async () => {
  const { store, sandbox } = setup();
  for (const owner of ['../x', '..', 'a/../../b', '/abs']) {
    try { await store.put(owner, 'f.txt', TXT('x'), 'text/plain'); } catch { /* rejecting is fine */ }
  }
  assert.deepEqual(readdirSync(sandbox), ['root']);
});

test('files of another owner look like missing files (no IDOR)', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'secret.txt', TXT('s'), 'text/plain');
  await assert.rejects(store.get('bob', m.id), NotFoundError);
  await assert.rejects(store.delete('bob', m.id), NotFoundError);
  await assert.rejects(store.share('bob', m.id, 60), NotFoundError);
  await assert.rejects(store.get('bob', 'no-such-id'), NotFoundError);
  await store.get('ann', m.id);
});

test('only the owner can revoke a link', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.txt', TXT('a'), 'text/plain');
  const t = await store.share('ann', m.id, 60);
  await assert.rejects(store.revoke('bob', t), NotFoundError);
  await store.openShared(t);
});

test('share tokens are long, random and url-safe', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.png', PNG, 'image/png');
  const tokens = await Promise.all(Array.from({ length: 50 }, () => store.share('ann', m.id, 60)));
  assert.equal(new Set(tokens).size, 50);
  for (const t of tokens) {
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    assert.ok(t.length >= 22, `token too short: ${t}`);
    assert.ok(!t.includes(m.id), 'token must not contain the file id');
  }
});

test('a token is not the file id and ids do not open links', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.txt', TXT('a'), 'text/plain');
  await store.share('ann', m.id, 60);
  await assert.rejects(store.openShared(m.id), NotFoundError);
});

test('returned data and metadata are copies', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.txt', TXT('abc'), 'text/plain');
  m.owner = 'bob'; m.size = 0;
  const got = await store.get('ann', m.id);
  assert.equal(got.meta.owner, 'ann');
  got.data[0] = 0x7a;
  got.meta.name = 'renamed';
  const again = await store.get('ann', m.id);
  assert.equal(new TextDecoder().decode(again.data), 'abc');
  assert.equal(again.meta.name, 'a.txt');
});

test('changing the input buffer after put does not change the stored file', async () => {
  const { store } = setup();
  const buf = TXT('hello');
  const m = await store.put('ann', 'h.txt', buf, 'text/plain');
  buf[0] = 0x4a;
  assert.equal(new TextDecoder().decode((await store.get('ann', m.id)).data), 'hello');
});
