import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, MemoryStore, ValidationError, NotFoundError, ConflictError, InsufficientFundsError, FrozenError } from '../src/index.ts';
import { SlowStore } from './helpers.ts';

async function two() {
  const l = new Ledger(new MemoryStore());
  await l.openAccount('alice', { currency: 'THB' });
  await l.openAccount('bob', { currency: 'THB' });
  return l;
}

test('error classes extend Error', () => {
  for (const E of [ValidationError, NotFoundError, ConflictError, InsufficientFundsError, FrozenError]) {
    assert.ok(new E('x') instanceof Error);
  }
});

test('deposit, withdraw and transfer move money and return transactions', async () => {
  const l = await two();
  const d = await l.deposit('alice', 1000, 'k1');
  assert.deepEqual({ ...d, id: 'x' }, { id: 'x', type: 'deposit', from: null, to: 'alice', amount: 1000, currency: 'THB' });
  const t = await l.transfer({ from: 'alice', to: 'bob', amount: 300, idempotencyKey: 'k2' });
  assert.deepEqual({ ...t, id: 'x' }, { id: 'x', type: 'transfer', from: 'alice', to: 'bob', amount: 300, currency: 'THB' });
  const w = await l.withdraw('bob', 100, 'k3');
  assert.deepEqual({ ...w, id: 'x' }, { id: 'x', type: 'withdraw', from: 'bob', to: null, amount: 100, currency: 'THB' });
  assert.equal(await l.balance('alice'), 700);
  assert.equal(await l.balance('bob'), 200);
  assert.equal(new Set([d.id, t.id, w.id]).size, 3);
});

test('account and amount validation', async () => {
  const l = await two();
  await assert.rejects(l.openAccount('alice', { currency: 'THB' }), ConflictError);
  await assert.rejects(l.openAccount('eur', { currency: 'EUR' as any }), ValidationError);
  await assert.rejects(l.openAccount('', { currency: 'THB' }), ValidationError);
  await assert.rejects(l.openAccount('a/b', { currency: 'THB' }), ValidationError);
  await assert.rejects(l.openAccount('x'.repeat(65), { currency: 'THB' }), ValidationError);
  for (const amount of [0, -5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10' as any]) {
    await assert.rejects(l.deposit('alice', amount, `bad-${String(amount)}`), ValidationError, String(amount));
  }
  await assert.rejects(l.balance('nobody'), NotFoundError);
  await assert.rejects(l.deposit('nobody', 5, 'n1'), NotFoundError);
  await assert.rejects(l.transfer({ from: 'alice', to: 'nobody', amount: 1, idempotencyKey: 'n2' }), NotFoundError);
});

test('balances never go negative and never pass the safe-integer limit', async () => {
  const l = await two();
  await l.deposit('alice', 100, 'a');
  await assert.rejects(l.withdraw('alice', 101, 'b'), InsufficientFundsError);
  await assert.rejects(l.transfer({ from: 'alice', to: 'bob', amount: 101, idempotencyKey: 'c' }), InsufficientFundsError);
  assert.equal(await l.balance('alice'), 100);
  assert.equal(await l.balance('bob'), 0);
  await l.deposit('bob', Number.MAX_SAFE_INTEGER, 'd');
  await assert.rejects(l.deposit('bob', 1, 'e'), ValidationError);
  await assert.rejects(l.transfer({ from: 'alice', to: 'bob', amount: 1, idempotencyKey: 'f' }), ValidationError);
  assert.equal(await l.balance('alice'), 100);
});

test('transfers need the same currency and two different accounts', async () => {
  const l = await two();
  await l.openAccount('usd', { currency: 'USD' });
  await l.deposit('alice', 100, 'a');
  await assert.rejects(l.transfer({ from: 'alice', to: 'usd', amount: 10, idempotencyKey: 'b' }), ValidationError);
  await assert.rejects(l.transfer({ from: 'alice', to: 'alice', amount: 10, idempotencyKey: 'c' }), ValidationError);
  assert.equal(await l.balance('alice'), 100);
});

test('repeating a call with the same key returns the original and changes nothing', async () => {
  const l = await two();
  await l.deposit('alice', 500, 'dep');
  const t1 = await l.transfer({ from: 'alice', to: 'bob', amount: 200, idempotencyKey: 'pay-1' });
  const t2 = await l.transfer({ from: 'alice', to: 'bob', amount: 200, idempotencyKey: 'pay-1' });
  assert.deepEqual(t2, t1);
  const d2 = await l.deposit('alice', 500, 'dep');
  assert.equal(d2.amount, 500);
  assert.equal(await l.balance('alice'), 300);
  assert.equal(await l.balance('bob'), 200);
});

test('a used key with different arguments or a different method conflicts', async () => {
  const l = await two();
  await l.deposit('alice', 500, 'k');
  await assert.rejects(l.deposit('alice', 501, 'k'), ConflictError);
  await assert.rejects(l.deposit('bob', 500, 'k'), ConflictError);
  await assert.rejects(l.withdraw('alice', 500, 'k'), ConflictError);
  await assert.rejects(l.transfer({ from: 'alice', to: 'bob', amount: 500, idempotencyKey: 'k' }), ConflictError);
  assert.equal(await l.balance('alice'), 500);
});

test('a failed call does not use up its key', async () => {
  const l = await two();
  await assert.rejects(l.withdraw('alice', 50, 'retry'), InsufficientFundsError);
  await l.deposit('alice', 100, 'top-up');
  const w = await l.withdraw('alice', 50, 'retry');
  assert.equal(w.amount, 50);
  assert.equal(await l.balance('alice'), 50);
});

test('frozen accounts cannot send or receive but can be read', async () => {
  const l = await two();
  await l.deposit('alice', 100, 'a');
  await l.deposit('bob', 100, 'b');
  await l.freeze('bob');
  await assert.rejects(l.deposit('bob', 1, 'c'), FrozenError);
  await assert.rejects(l.withdraw('bob', 1, 'd'), FrozenError);
  await assert.rejects(l.transfer({ from: 'alice', to: 'bob', amount: 1, idempotencyKey: 'e' }), FrozenError);
  await assert.rejects(l.transfer({ from: 'bob', to: 'alice', amount: 1, idempotencyKey: 'f' }), FrozenError);
  assert.equal(await l.balance('bob'), 100);
  assert.equal(await l.balance('alice'), 100);
  await l.unfreeze('bob');
  await l.transfer({ from: 'bob', to: 'alice', amount: 1, idempotencyKey: 'f' });
  assert.equal(await l.balance('alice'), 101);
  await assert.rejects(l.freeze('nobody'), NotFoundError);
});

test('reversing a transfer moves the money back once', async () => {
  const l = await two();
  await l.deposit('alice', 100, 'a');
  const t = await l.transfer({ from: 'alice', to: 'bob', amount: 40, idempotencyKey: 'b' });
  const r = await l.reverse(t.id, 'undo');
  assert.deepEqual({ ...r, id: 'x' }, { id: 'x', type: 'reversal', from: 'bob', to: 'alice', amount: 40, currency: 'THB' });
  assert.equal(await l.balance('alice'), 100);
  assert.equal(await l.balance('bob'), 0);
  assert.deepEqual(await l.reverse(t.id, 'undo'), r); // same key: same answer
  await assert.rejects(l.reverse(t.id, 'undo-again'), ConflictError);
  await assert.rejects(l.reverse('no-such-tx', 'x'), NotFoundError);
  const d = await l.deposit('alice', 5, 'c');
  await assert.rejects(l.reverse(d.id, 'y'), ValidationError);
});

test('a reversal needs funds and unfrozen accounts', async () => {
  const l = await two();
  await l.deposit('alice', 100, 'a');
  const t = await l.transfer({ from: 'alice', to: 'bob', amount: 60, idempotencyKey: 'b' });
  await l.withdraw('bob', 30, 'c');
  await assert.rejects(l.reverse(t.id, 'r1'), InsufficientFundsError);
  await l.deposit('bob', 30, 'd');
  await l.freeze('alice');
  await assert.rejects(l.reverse(t.id, 'r2'), FrozenError);
  await l.unfreeze('alice');
  await l.reverse(t.id, 'r3');
  assert.equal(await l.balance('alice'), 100);
});

test('history lists signed entries with running balances, oldest first', async () => {
  const l = await two();
  const d = await l.deposit('alice', 100, 'a');
  const t = await l.transfer({ from: 'alice', to: 'bob', amount: 30, idempotencyKey: 'b' });
  const w = await l.withdraw('alice', 20, 'c');
  const r = await l.reverse(t.id, 'd');
  assert.deepEqual(await l.history('alice'), [
    { transactionId: d.id, type: 'deposit', amount: 100, balanceAfter: 100 },
    { transactionId: t.id, type: 'transfer', amount: -30, balanceAfter: 70 },
    { transactionId: w.id, type: 'withdraw', amount: -20, balanceAfter: 50 },
    { transactionId: r.id, type: 'reversal', amount: 30, balanceAfter: 80 },
  ]);
  assert.deepEqual(await l.history('bob'), [
    { transactionId: t.id, type: 'transfer', amount: 30, balanceAfter: 30 },
    { transactionId: r.id, type: 'reversal', amount: -30, balanceAfter: 0 },
  ]);
  await assert.rejects(l.history('nobody'), NotFoundError);
});
