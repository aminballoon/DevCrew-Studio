/**
 * Security checks the requirement does not spell out: it only says the API faces the internet
 * and must follow the OWASP API Security Top 10. Each test names the OWASP item it checks and
 * judges the outcome, not the mechanism (e.g. 403 and 404 both count as "refused").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, setup, signup, team } from './helpers.ts';

const refused = (status: number) => status === 403 || status === 404;
const b64 = (s: string) => Buffer.from(s).toString('base64');

test('API1 BOLA: an outsider cannot read, change, delete or share another workspace\'s document', async () => {
  const { call, mal, acme, doc } = await team();
  for (const [method, path, body] of [
    ['GET', `/workspaces/${acme}/docs/${doc.id}`, undefined],
    ['GET', `/workspaces/${acme}/docs`, undefined],
    ['PATCH', `/workspaces/${acme}/docs/${doc.id}`, { version: 1, title: 'pwned' }],
    ['POST', `/workspaces/${acme}/docs/${doc.id}/share`, { expiresInMinutes: 60 }],
    ['GET', `/workspaces/${acme}/members`, undefined],
    ['DELETE', `/workspaces/${acme}/docs/${doc.id}`, undefined],
  ] as const) {
    const res = await call(method, path, mal.token, body);
    assert.ok(refused(res.status), `${method} ${path} answered ${res.status}`);
    assert.equal(JSON.stringify(res.body).includes('Secret plan'), false);
  }
});

test('API1 BOLA: a document id from another workspace is refused even through the attacker\'s own workspace', async () => {
  const { call, ann, mal, evil, doc, acme } = await team();
  for (const [method, path, body] of [
    ['GET', `/workspaces/${evil}/docs/${doc.id}`, undefined],
    ['PATCH', `/workspaces/${evil}/docs/${doc.id}`, { version: 1, body: 'pwned' }],
    ['POST', `/workspaces/${evil}/docs/${doc.id}/share`, { expiresInMinutes: 60 }],
    ['POST', `/workspaces/${evil}/docs/${doc.id}/attachments`, { filename: 'x.txt', contentBase64: b64('x') }],
    ['DELETE', `/workspaces/${evil}/docs/${doc.id}`, undefined],
  ] as const) {
    const res = await call(method, path, mal.token, body);
    assert.ok(refused(res.status), `${method} ${path} answered ${res.status}`);
    assert.equal(JSON.stringify(res.body).includes('Secret plan'), false);
  }
  const still = expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}`, ann.token), 200);
  assert.deepEqual([still.body, still.version], ['Secret plan for Q3', 1]);
});

test('API1 BOLA: a share link only opens the document it was made for, and a revoke only touches its own document', async () => {
  const { call, ann, mal, evil, acme, doc } = await team();
  const link = expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, ann.token, { expiresInMinutes: 60 }), 201);
  const mine = expect(await call('POST', `/workspaces/${evil}/docs`, mal.token, { title: 'Mine', body: 'x' }), 201);
  const res = await call('DELETE', `/workspaces/${evil}/docs/${mine.id}/share/${link.token}`, mal.token);
  assert.ok(res.status >= 400, `revoking someone else's link answered ${res.status}`);
  expect(await call('GET', `/shared/${link.token}`, null), 200);
});

test('API1 BOLA: attachments of different documents never overwrite or reveal each other', async () => {
  const { call, ann, mal, evil, acme, doc } = await team();
  expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ann.token, { filename: 'report.txt', contentBase64: b64('acme numbers') }), 201);
  const mine = expect(await call('POST', `/workspaces/${evil}/docs`, mal.token, { title: 'Mine', body: 'x' }), 201);
  expect(await call('POST', `/workspaces/${evil}/docs/${mine.id}/attachments`, mal.token, { filename: 'report.txt', contentBase64: b64('evil numbers') }), 201);
  const got = expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}/attachments/report.txt`, ann.token), 200);
  assert.equal(Buffer.from(got.contentBase64, 'base64').toString(), 'acme numbers');
  const other = await call('GET', `/workspaces/${evil}/docs/${doc.id}/attachments/report.txt`, mal.token);
  assert.ok(refused(other.status));
});

test('API1/API5: a removed member loses access at once', async () => {
  const { call, ann, ed, acme, doc } = await team();
  expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}`, ed.token), 200);
  expect(await call('DELETE', `/workspaces/${acme}/members/${ed.id}`, ann.token), 204);
  assert.ok(refused((await call('GET', `/workspaces/${acme}/docs/${doc.id}`, ed.token)).status));
  assert.ok(refused((await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, ed.token, { version: 1, title: 'x' })).status));
});

test('API2 broken authentication: login does not reveal which emails exist', async () => {
  const { call } = setup();
  await signup(call, 'Ann');
  const wrongPassword = await call('POST', '/login', null, { email: 'ann@example.com', password: 'not-the-password' });
  const noAccount = await call('POST', '/login', null, { email: 'nobody@example.com', password: 'not-the-password' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noAccount.status, wrongPassword.status);
  assert.deepEqual(noAccount.body, wrongPassword.body);
});

test('API2 broken authentication: password guessing is throttled', async () => {
  const { call } = setup();
  await signup(call, 'Ann');
  const statuses: number[] = [];
  for (let i = 0; i < 30; i++) {
    statuses.push((await call('POST', '/login', null, { email: 'ann@example.com', password: `guess-number-${i}` })).status);
  }
  const right = await call('POST', '/login', null, { email: 'ann@example.com', password: 'Ann-password-1' });
  assert.ok(statuses.includes(429) || right.status !== 200, 'after 30 wrong passwords in a row, guessing must be slowed down or stopped');
});

test('API2 broken authentication: tokens are long, random and unrelated to the user', async () => {
  const { call } = setup();
  const tokens: string[] = [];
  for (let i = 0; i < 8; i++) { tokens.push((await signup(call, `User${i}`)).token); }
  const { ann, acme, doc } = await team();
  void ann; void acme; void doc;
  assert.equal(new Set(tokens).size, tokens.length);
  for (const t of tokens) {
    assert.ok(t.length >= 20, `token "${t}" is too short to be unguessable`);
    assert.ok(!/^\d+$/.test(t) && !/user\d/i.test(t), `token "${t}" looks predictable`);
  }
  // No long shared prefix: not a counter or a timestamp with a short suffix
  const prefix = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) { i++; } return i; };
  assert.ok(Math.max(...tokens.slice(1).map((t, i) => prefix(t, tokens[i]))) < 8);
});

test('API2 broken authentication: share links are long and random', async () => {
  const { call, ann, acme, doc } = await team();
  const links: string[] = [];
  for (let i = 0; i < 6; i++) { links.push(expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, ann.token, { expiresInMinutes: 5 }), 201).token); }
  assert.equal(new Set(links).size, links.length);
  for (const l of links) { assert.ok(l.length >= 20 && !l.includes(doc.id), `share token "${l}" is guessable`); }
});

test('API3 broken object property level authorization: clients cannot set protected fields', async () => {
  const { call, ann, ed, acme, doc } = await team();
  const signed = expect(await call('POST', '/signup', null, { email: 'zed@example.com', password: 'zed-password', name: 'Zed', id: ann.id, role: 'admin', isAdmin: true }), 201);
  assert.notEqual(signed.user.id, ann.id);
  const u = expect(await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, ed.token, {
    version: 1, title: 'Edited', id: 'doc_hijack', workspaceId: 'ws_other', createdBy: ed.id, createdAt: '2000-01-01T00:00:00.000Z', version2: 99,
  }), 200);
  assert.deepEqual([u.id, u.workspaceId, u.createdBy, u.createdAt, u.version], [doc.id, acme, ann.id, doc.createdAt, 2]);
  const created = expect(await call('POST', `/workspaces/${acme}/docs`, ed.token, { title: 'T', body: 'b', createdBy: ann.id, version: 50, id: 'mine' }), 201);
  assert.deepEqual([created.createdBy, created.version], [ed.id, 1]);
  assert.notEqual(created.id, 'mine');
});

test('API3 excessive data exposure: no response carries passwords, hashes or other people\'s tokens', async () => {
  const { call, ann, ed, acme } = await team();
  const bodies = [
    expect(await call('POST', '/signup', null, { email: 'kim@example.com', password: 'kim-secret-pass', name: 'Kim' }), 201),
    expect(await call('POST', '/login', null, { email: 'kim@example.com', password: 'kim-secret-pass' }), 200),
    expect(await call('GET', '/me', ann.token), 200),
    expect(await call('GET', `/workspaces/${acme}/members`, ed.token), 200),
    expect(await call('POST', `/workspaces/${acme}/members`, ann.token, { email: 'kim@example.com', role: 'viewer' }), 201),
  ];
  const text = JSON.stringify(bodies);
  assert.equal(text.includes('kim-secret-pass'), false);
  assert.equal(/"(password|passwordHash|hash|salt|pass)"/i.test(text), false, 'a password-related field was returned');
  assert.equal(text.includes(ann.token), false);
  assert.equal(JSON.stringify(bodies[3]).includes(ed.token), false);
});

test('API4 unrestricted resource consumption: page size is capped', async () => {
  const { call, ann, acme } = await team();
  for (let i = 0; i < 150; i++) {
    expect(await call('POST', `/workspaces/${acme}/docs`, ann.token, { title: `D${i}`, body: 'x' }), 201);
  }
  const res = await call('GET', `/workspaces/${acme}/docs`, ann.token, undefined, { limit: '1000000' });
  // Any cap below the 150 documents counts; returning everything at once does not
  assert.ok(res.status === 400 || (res.status === 200 && res.body.items.length < 150), `a page of ${res.body?.items?.length} documents`);
});

test('injection: search text is matched literally', async () => {
  const { call, ann, acme } = await team();
  expect(await call('POST', `/workspaces/${acme}/docs`, ann.token, { title: 'Prices (draft)', body: 'a+b=c, costs $5.00' }), 201);
  const q = async (text: string) => {
    const res = await call('GET', `/workspaces/${acme}/docs`, ann.token, undefined, { q: text });
    assert.equal(res.status, 200, `search for ${JSON.stringify(text)} answered ${res.status}`);
    return res.body.items.map((d: { title: string }) => d.title);
  };
  assert.deepEqual(await q('.*'), []);
  assert.deepEqual(await q('('), ['Prices (draft)']);
  assert.deepEqual(await q('a+b'), ['Prices (draft)']);
  assert.deepEqual(await q('$5.00'), ['Prices (draft)']);
  assert.deepEqual(await q('[a-z]'), []);
});

test('injection: crafted JSON keys cannot pollute objects', async () => {
  const { call, ann, acme, doc } = await team();
  const payload = JSON.parse('{"version":1,"title":"x","__proto__":{"polluted":"yes","isAdmin":true},"constructor":{"prototype":{"polluted2":"yes"}}}');
  await call('PATCH', `/workspaces/${acme}/docs/${doc.id}`, ann.token, payload);
  await call('POST', `/workspaces/${acme}/docs`, ann.token, JSON.parse('{"title":"t","body":"b","__proto__":{"polluted3":"yes"}}'));
  const probe = {} as Record<string, unknown>;
  assert.equal(probe.polluted, undefined);
  assert.equal(probe.polluted2, undefined);
  assert.equal(probe.polluted3, undefined);
  assert.equal(probe.isAdmin, undefined);
  const got = expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}`, ann.token), 200);
  assert.equal(got.polluted, undefined);
});

test('injection: attachment names cannot write or read outside the data directory', async () => {
  const { call, ann, acme, doc, root, dataDir } = await team();
  writeFileSync(join(root, 'secret.txt'), 'TOP SECRET');
  for (const filename of ['../escape.txt', '../../escape.txt', '..\\escape.txt', '/tmp/escape-shelf.txt', 'a/../../escape.txt', '../secret.txt']) {
    const res = await call('POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ann.token, { filename, contentBase64: b64('overwritten') });
    assert.ok(res.status < 500, `${filename} answered ${res.status}`);
  }
  assert.equal(existsSync(join(root, 'escape.txt')), false);
  assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
  assert.equal(readdirSync(root).sort().join(','), 'data,secret.txt');
  for (const name of ['..%2Fsecret.txt', '../secret.txt', '..%2F..%2Fsecret.txt']) {
    const res = await call('GET', `/workspaces/${acme}/docs/${doc.id}/attachments/${name}`, ann.token);
    assert.equal(JSON.stringify(res.body ?? '').includes(b64('TOP SECRET')), false, `${name} leaked a file outside the data directory`);
  }
  void dataDir;
});

test('API8 security misconfiguration: hostile input never crashes the service or leaks internals', async () => {
  const { call, ann, acme, doc } = await team();
  const bodies: unknown[] = [null, 'text', 42, [], [1, 2], true, { title: 5, body: [] }, { title: { $ne: '' } }, { email: ['a@b.c'], password: { x: 1 } }, { version: 'one', tags: 'x' }, { expiresInMinutes: '5' }, { filename: 7, contentBase64: {} }];
  const routes: [string, string, string | null][] = [
    ['POST', '/signup', null], ['POST', '/login', null], ['POST', '/workspaces', ann.token],
    ['POST', `/workspaces/${acme}/members`, ann.token], ['POST', `/workspaces/${acme}/docs`, ann.token],
    ['PATCH', `/workspaces/${acme}/docs/${doc.id}`, ann.token], ['POST', `/workspaces/${acme}/docs/${doc.id}/share`, ann.token],
    ['POST', `/workspaces/${acme}/docs/${doc.id}/attachments`, ann.token],
  ];
  for (const [method, path, token] of routes) {
    for (const body of bodies) {
      const res = await call(method, path, token, body);
      assert.ok(res.status >= 400 && res.status < 500, `${method} ${path} with ${JSON.stringify(body)} answered ${res.status}`);
      const text = JSON.stringify(res.body);
      assert.equal(/\bat .+\.ts:\d+|TypeError|ReferenceError|Cannot read prop/.test(text), false, `${method} ${path} leaked internals: ${text.slice(0, 200)}`);
    }
  }
  for (const path of ['/workspaces/%E0%A4%A/docs', `/workspaces/${acme}/docs/%`, '/shared/%ZZ']) {
    const res = await call('GET', path, ann.token);
    assert.ok(res.status >= 400 && res.status < 500, `GET ${path} answered ${res.status}`);
  }
  expect(await call('GET', `/workspaces/${acme}/docs/${doc.id}`, ann.token), 200);
});

test('deleted documents stop being reachable through old share links', async () => {
  const { call, ann, acme, doc } = await team();
  const link = expect(await call('POST', `/workspaces/${acme}/docs/${doc.id}/share`, ann.token, { expiresInMinutes: 60 }), 201);
  expect(await call('DELETE', `/workspaces/${acme}/docs/${doc.id}`, ann.token), 204);
  expect(await call('GET', `/shared/${link.token}`, null), 404);
});
