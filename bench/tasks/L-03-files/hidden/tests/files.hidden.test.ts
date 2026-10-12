import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ValidationError, NotFoundError, ConflictError } from '../src/index.ts';
import { setup, PNG, JPG, PDF, TXT } from './helpers.ts';

test('error classes extend Error', () => {
  for (const E of [ValidationError, NotFoundError, ConflictError]) { assert.ok(new E('x') instanceof Error); }
});

test('put returns metadata and get returns the same bytes', async () => {
  const { store } = setup();
  const meta = await store.put('ann', 'logo.png', PNG, 'image/png');
  assert.equal(typeof meta.id, 'string');
  assert.deepEqual({ ...meta, id: 'x' }, {
    id: 'x', owner: 'ann', name: 'logo.png', size: PNG.length, contentType: 'image/png',
    sha256: createHash('sha256').update(PNG).digest('hex'), createdAt: '2030-01-01T00:00:00.000Z',
  });
  const got = await store.get('ann', meta.id);
  assert.deepEqual(got.meta, meta);
  assert.deepEqual(Buffer.from(got.data), Buffer.from(PNG));
});

test('accepts each allowed type when the content matches', async () => {
  const { store } = setup();
  await store.put('ann', 'a.png', PNG, 'image/png');
  await store.put('ann', 'b.jpg', JPG, 'image/jpeg');
  await store.put('ann', 'c.pdf', PDF, 'application/pdf');
  await store.put('ann', 'd.txt', TXT('สวัสดี hello'), 'text/plain');
  assert.equal((await store.list('ann')).length, 4);
});

test('rejects unknown types and content that does not match its type', async () => {
  const { store } = setup();
  await assert.rejects(store.put('ann', 'x.svg', TXT('<svg/>'), 'image/svg+xml'), ValidationError);
  await assert.rejects(store.put('ann', 'x.png', JPG, 'image/png'), ValidationError);
  await assert.rejects(store.put('ann', 'x.jpg', PNG, 'image/jpeg'), ValidationError);
  await assert.rejects(store.put('ann', 'x.pdf', TXT('PDF-1.7'), 'application/pdf'), ValidationError);
  await assert.rejects(store.put('ann', 'x.txt', new Uint8Array([104, 105, 0, 33]), 'text/plain'), ValidationError);
  await assert.rejects(store.put('ann', 'y.txt', new Uint8Array([0xc3, 0x28]), 'text/plain'), ValidationError);
  await assert.rejects(store.put('ann', 'z.png', PNG.slice(0, 4), 'image/png'), ValidationError);
});

test('size limits: empty, per file and per owner quota', async () => {
  const { store } = setup({ maxFileBytes: 100, quotaBytes: 150 });
  await assert.rejects(store.put('ann', 'e.txt', new Uint8Array(), 'text/plain'), ValidationError);
  await assert.rejects(store.put('ann', 'big.txt', TXT('a'.repeat(101)), 'text/plain'), ValidationError);
  const a = await store.put('ann', 'a.txt', TXT('a'.repeat(100)), 'text/plain');
  await assert.rejects(store.put('ann', 'b.txt', TXT('b'.repeat(51)), 'text/plain'), ConflictError);
  await store.put('ann', 'b.txt', TXT('b'.repeat(50)), 'text/plain');
  await store.put('bob', 'b.txt', TXT('b'.repeat(100)), 'text/plain'); // quota is per owner
  await store.delete('ann', a.id);
  await store.put('ann', 'c.txt', TXT('c'.repeat(100)), 'text/plain'); // freed by delete
});

test('names must be unique per owner', async () => {
  const { store } = setup();
  await store.put('ann', 'same.txt', TXT('1'), 'text/plain');
  await assert.rejects(store.put('ann', 'same.txt', TXT('2'), 'text/plain'), ConflictError);
  await store.put('bob', 'same.txt', TXT('3'), 'text/plain');
});

test('list is per owner and sorted by name', async () => {
  const { store } = setup();
  await store.put('ann', 'b.txt', TXT('b'), 'text/plain');
  await store.put('ann', 'a.txt', TXT('a'), 'text/plain');
  await store.put('bob', 'c.txt', TXT('c'), 'text/plain');
  assert.deepEqual((await store.list('ann')).map(m => m.name), ['a.txt', 'b.txt']);
  assert.deepEqual(await store.list('nobody'), []);
});

test('delete removes the file', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.txt', TXT('a'), 'text/plain');
  await store.delete('ann', m.id);
  await assert.rejects(store.get('ann', m.id), NotFoundError);
  await assert.rejects(store.delete('ann', m.id), NotFoundError);
  assert.deepEqual(await store.list('ann'), []);
});

test('share links work until they expire', async () => {
  const { store, advance } = setup();
  const m = await store.put('ann', 'a.pdf', PDF, 'application/pdf');
  const token = await store.share('ann', m.id, 60);
  const opened = await store.openShared(token);
  assert.deepEqual(opened.meta, m);
  assert.deepEqual(Buffer.from(opened.data), Buffer.from(PDF));
  advance(59);
  await store.openShared(token);
  advance(1);
  await assert.rejects(store.openShared(token), NotFoundError);
});

test('ttl must be 1 to 86400 whole seconds', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.txt', TXT('a'), 'text/plain');
  for (const ttl of [0, 86401, 1.5, -1]) { await assert.rejects(store.share('ann', m.id, ttl), ValidationError, String(ttl)); }
  await store.share('ann', m.id, 86400);
});

test('revoke and delete end share links', async () => {
  const { store } = setup();
  const m = await store.put('ann', 'a.txt', TXT('a'), 'text/plain');
  const t1 = await store.share('ann', m.id, 600);
  const t2 = await store.share('ann', m.id, 600);
  await store.revoke('ann', t1);
  await assert.rejects(store.openShared(t1), NotFoundError);
  await store.openShared(t2);
  await store.delete('ann', m.id);
  await assert.rejects(store.openShared(t2), NotFoundError);
  await assert.rejects(store.revoke('ann', 'no-such-token'), NotFoundError);
});
