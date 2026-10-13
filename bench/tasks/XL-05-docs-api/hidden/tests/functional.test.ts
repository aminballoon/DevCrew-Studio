import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expect, setup, signup, team } from './helpers.ts';

test('signup, login, me and logout', async () => {
  const { call } = setup();
  const s = expect(await call('POST', '/signup', null, { email: 'Ann@Example.com', password: 'correct horse', name: '  Ann  ' }), 201);
  assert.deepEqual([s.user.email, s.user.name, typeof s.user.id, typeof s.token], ['ann@example.com', 'Ann', 'string', 'string']);
  expect(await call('POST', '/signup', null, { email: 'ANN@example.com', password: 'another one', name: 'Ann 2' }), 409);
  const l = expect(await call('POST', '/login', null, { email: 'ann@EXAMPLE.com', password: 'correct horse' }), 200);
  assert.equal(l.user.id, s.user.id);
  assert.deepEqual(expect(await call('GET', '/me', l.token), 200), s.user);
  expect(await call('POST', '/logout', l.token), 204);
  expect(await call('GET', '/me', l.token), 401);
  expect(await call('GET', '/me', s.token), 200);
  expect(await call('POST', '/login', null, { email: 'ann@example.com', password: 'wrong horse' }), 401);
});

test('signup validation', async () => {
  const { call } = setup();
  for (const body of [
    { email: 'nope', password: 'longenough', name: 'A' },
    { email: 'a@b.c', password: 'short', name: 'A' },
    { email: 'a@b.c', password: 'x'.repeat(129), name: 'A' },
    { email: 'a@b.c', password: 'longenough', name: '   ' },
  ]) {
    expect(await call('POST', '/signup', null, body), 400);
  }
  expect(await call('GET', '/me', null), 401);
  expect(await call('GET', '/me', 'not-a-token'), 401);
});

test('workspaces and members', async () => {
  const { call, ann, ed, vi, acme } = await team();
  const b = expect(await call('POST', '/workspaces', ann.token, { name: 'Beta' }), 201);
  assert.deepEqual(expect(await call('GET', '/workspaces', ann.token), 200).map((w: { name: string; role: string }) => [w.name, w.role]), [['Acme', 'owner'], ['Beta', 'owner']]);
  assert.deepEqual(expect(await call('GET', '/workspaces', vi.token), 200).map((w: { id: string; role: string }) => [w.id, w.role]), [[acme, 'viewer']]);
  const members = expect(await call('GET', `/workspaces/${acme}/members`, vi.token), 200);
  assert.deepEqual(members.map((m: { name: string; role: string }) => [m.name, m.role]).sort(), [['Ann', 'owner'], ['Ed', 'editor'], ['Vi', 'viewer']]);
  expect(await call('POST', `/workspaces/${acme}/members`, ann.token, { email: ed.email, role: 'viewer' }), 409);
  expect(await call('POST', `/workspaces/${acme}/members`, ann.token, { email: 'ghost@example.com', role: 'viewer' }), 404);
  expect(await call('POST', `/workspaces/${b.id}/members`, ann.token, { email: ed.email, role: 'owner' }), 400);
  expect(await call('POST', `/workspaces/${acme}/members`, ed.token, { email: 'x@example.com', role: 'viewer' }), 403);
  expect(await call('DELETE', `/workspaces/${acme}/members/${ann.id}`, ann.token), 400);
  expect(await call('DELETE', `/workspaces/${acme}/members/${vi.id}`, ed.token), 403);
  expect(await call('DELETE', `/workspaces/${acme}/members/${vi.id}`, ann.token), 204);
  assert.equal(expect(await call('GET', `/workspaces/${acme}/members`, ann.token), 200).length, 2);
});

test('documents: create, read, list newest first, viewers read only', async () => {
  const { call, ann, ed, vi, acme, doc, advance } = await team();
  assert.deepEqual([doc.title, doc.body, doc.tags, doc.version, doc.createdBy, doc.workspaceId], ['Plan', 'Secret plan for Q3', ['q3'], 1, ann.id, acme]);
  advance(1000);
  const d2 = expect(await call('POST', `/workspaces/${acme}/docs`, ed.token, { title: '  Notes ', body: '' }), 201);
  assert.deepEqual([d2.title, d2.tags, d2.createdBy], ['Notes', [], ed.id]);
  expect(await call('POST', `/workspaces/${acme}/docs`, vi.token, { title: 'x', body: 'y' }), 403);
  expect(await call('POST', `/workspaces/${acme}/docs`, ed.token, { title: 'x'.repeat(201), body: 'y' }), 400);
  expect(await call('POST', `/workspaces/${acme}/docs`, ed.token, { title: 'x', body: 'y', tags: Array(11).fill('t') }), 400);
  assert.deepEqual(expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}`, vi.token), 200), doc);
  const list = expect(await call('GET', `/workspaces/${acme}/docs`, vi.token), 200);
  assert.deepEqual(list.items.map((d: { id: string }) => d.id), [d2.id, doc.id]);
  assert.equal(list.nextCursor, null);
});

test('documents: paging and search', async () => {
  const { call, ann, acme, advance } = await team();
  for (let i = 0; i < 24; i++) {
    advance(1000);
    expect(await call('POST', `/workspaces/${acme}/docs`, ann.token, { title: `Doc ${i}`, body: i % 2 ? 'Budget NUMBERS' : 'nothing' }), 201);
  }
  const p1 = expect(await call('GET', `/workspaces/${acme}/docs`, ann.token), 200);
  assert.equal(p1.items.length, 20);
  assert.equal(p1.items[0].title, 'Doc 23');
  const p2 = expect(await call('GET', `/workspaces/${acme}/docs`, ann.token, undefined, { cursor: p1.nextCursor }), 200);
  assert.equal(p2.items.length, 5);
  assert.equal(p2.nextCursor, null);
  const found = expect(await call('GET', `/workspaces/${acme}/docs`, ann.token, undefined, { q: 'budget numbers', limit: '50' }), 200);
  assert.equal(found.items.length, 12);
  assert.equal(expect(await call('GET', `/workspaces/${acme}/docs`, ann.token, undefined, { q: 'secret PLAN' }), 200).items.length, 1);
});

test('documents: versioned updates and deletion rights', async () => {
  const { call, ann, ed, vi, acme, doc, advance } = await team();
  advance(5000);
  const u = expect(await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, ed.token, { version: 1, body: 'New plan' }), 200);
  assert.deepEqual([u.title, u.body, u.version, u.updatedAt === doc.updatedAt], ['Plan', 'New plan', 2, false]);
  expect(await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, ann.token, { version: 1, title: 'Stale' }), 409);
  expect(await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, vi.token, { version: 2, title: 'Mine' }), 403);
  const mine = expect(await call('POST', `/workspaces/${acme}/docs`, ed.token, { title: 'Ed', body: '' }), 201);
  expect(await call('DELETE', `/workspaces/${acme}/docs/${doc.id}`, ed.token), 403);
  expect(await call('DELETE', `/workspaces/${acme}/docs/${mine.id}`, ed.token), 204);
  expect(await call('DELETE', `/workspaces/${acme}/docs/${doc.id}`, ann.token), 204);
  expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}`, ann.token), 404);
});

test('share links: public, live content, expiry and revocation', async () => {
  const { call, ann, ed, vi, acme, doc, advance } = await team();
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, vi.token, { expiresInMinutes: 5 }), 403);
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, ed.token, { expiresInMinutes: 0 }), 400);
  const link = expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, ed.token, { expiresInMinutes: 10 }), 201);
  assert.equal(link.expiresAt, new Date(Date.parse('2030-05-01T09:00:00.000Z') + 10 * 60_000).toISOString());
  expect(await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, ann.token, { version: 1, title: 'Plan v2' }), 200);
  assert.equal(expect(await call('GET', `/shared/${link.token}`, null), 200).title, 'Plan v2');
  advance(10 * 60_000 - 1);
  expect(await call('GET', `/shared/${link.token}`, null), 200);
  advance(1);
  expect(await call('GET', `/shared/${link.token}`, null), 404);
  const other = expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, ann.token, { expiresInMinutes: 60 }), 201);
  expect(await call('DELETE', `/workspaces/${acme}/docs/${doc.id}/share/${other.token}`, ed.token), 204);
  expect(await call('GET', `/shared/${other.token}`, null), 404);
  expect(await call('GET', '/shared/no-such-token', null), 404);
});

test('attachments: upload, replace, download, size limit', async () => {
  const { call, ann, ed, vi, acme, doc } = await team();
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, vi.token, { filename: 'a.txt', contentBase64: b64('x') }), 403);
  assert.deepEqual(expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ed.token, { filename: 'notes.txt', contentBase64: b64('hello') }), 201), { filename: 'notes.txt', size: 5 });
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ann.token, { filename: 'notes.txt', contentBase64: b64('hello again') }), 201);
  assert.equal(Buffer.from(expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}/attachments/notes.txt`, vi.token), 200).contentBase64, 'base64').toString(), 'hello again');
  expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}/attachments/none.txt`, vi.token), 404);
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ed.token, { filename: 'big.bin', contentBase64: Buffer.alloc(1024 * 1024 + 1).toString('base64') }), 413);
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ed.token, { filename: 'ok.bin', contentBase64: Buffer.alloc(1024 * 1024).toString('base64') }), 201);
});

test('a second account sees nothing of the first one by default', async () => {
  const { call } = setup();
  const a = await signup(call, 'Ann');
  const b = await signup(call, 'Bob');
  expect(await call('POST', '/workspaces', a.token, { name: 'Acme' }), 201);
  assert.deepEqual(expect(await call('GET', '/workspaces', b.token), 200), []);
});
