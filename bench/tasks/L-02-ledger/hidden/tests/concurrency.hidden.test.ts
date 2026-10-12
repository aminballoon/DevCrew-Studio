import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, InsufficientFundsError } from '../src/index.ts';
import { SlowStore } from './helpers.ts';

test('all state lives in the store: a new Ledger on the same store sees it', async () => {
  const store = new SlowStore();
  const a = new Ledger(store);
  await a.openAccount('alice', { currency: 'THB' });
  await a.openAccount('bob', { currency: 'THB' });
  await a.deposit('alice', 100, 'k1');
  const t = await a.transfer({ from: 'alice', to: 'bob', amount: 40, idempotencyKey: 'k2' });
  await a.freeze('bob');
  const b = new Ledger(store);
  assert.equal(await b.balance('alice'), 60);
  assert.equal(await b.balance('bob'), 40);
  assert.deepEqual(await b.transfer({ from: 'alice', to: 'bob', amount: 40, idempotencyKey: 'k2' }), t);
  await assert.rejects(b.deposit('bob', 1, 'k3'));
  assert.equal((await b.history('alice')).length, 2);
  assert.ok(store.sets > 0);
});

test('concurrent withdrawals never overdraw', async () => {
  const l = new Ledger(new SlowStore());
  await l.openAccount('alice', { currency: 'THB' });
  await l.deposit('alice', 100, 'seed');
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => l.withdraw('alice', 30, `w${i}`)));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  assert.equal(ok, 3);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason instanceof InsufficientFundsError));
  assert.equal(await l.balance('alice'), 10);
});

test('concurrent transfers in both directions keep the total', async () => {
  const l = new Ledger(new SlowStore());
  for (const id of ['a', 'b', 'c']) {
    await l.openAccount(id, { currency: 'USD' });
    await l.deposit(id, 1000, `seed-${id}`);
  }
  const ids = ['a', 'b', 'c'];
  const calls = Array.from({ length: 60 }, (_, i) => {
    const from = ids[i % 3], to = ids[(i + 1 + (i % 2)) % 3];
    return l.transfer({ from, to, amount: 1 + (i * 37) % 400, idempotencyKey: `t${i}` });
  });
  await Promise.allSettled(calls);
  const balances = await Promise.all(ids.map(id => l.balance(id)));
  assert.equal(balances.reduce((x, y) => x + y, 0), 3000);
  assert.ok(balances.every(b => b >= 0));
  for (const id of ids) {
    const h = await l.history(id);
    assert.equal(h.at(-1)!.balanceAfter, await l.balance(id));
    assert.equal(h.reduce((n, e) => n + e.amount, 0), await l.balance(id));
  }
});

test('the same key sent many times at once applies once', async () => {
  const l = new Ledger(new SlowStore());
  await l.openAccount('alice', { currency: 'THB' });
  await l.openAccount('bob', { currency: 'THB' });
  await l.deposit('alice', 1000, 'seed');
  const results = await Promise.all(Array.from({ length: 8 }, () => l.transfer({ from: 'alice', to: 'bob', amount: 100, idempotencyKey: 'once' })));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(await l.balance('alice'), 900);
  assert.equal(await l.balance('bob'), 100);
});

test('concurrent deposits on the same account are all counted', async () => {
  const l = new Ledger(new SlowStore());
  await l.openAccount('alice', { currency: 'THB' });
  await Promise.all(Array.from({ length: 25 }, (_, i) => l.deposit('alice', 4, `d${i}`)));
  assert.equal(await l.balance('alice'), 100);
  assert.equal((await l.history('alice')).length, 25);
});
