import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEvenly, Ledger, settle } from '../src/index.ts';

test('splits evenly and gives leftover cents to the first shares', () => {
  assert.deepEqual(splitEvenly(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitEvenly(5, 7), [1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual(splitEvenly(0, 2), [0, 0]);
});

test('shares always add up to the amount', () => {
  for (const [amount, people] of [[1, 3], [999, 4], [123457, 11]]) {
    assert.equal(splitEvenly(amount, people).reduce((a, b) => a + b, 0), amount);
  }
});

test('rejects bad split input with RangeError', () => {
  assert.throws(() => splitEvenly(-1, 2), RangeError);
  assert.throws(() => splitEvenly(10.5, 2), RangeError);
  assert.throws(() => splitEvenly(10, 0), RangeError);
});

test('the payer is owed what the others consumed', () => {
  const l = new Ledger();
  l.addExpense({ paidBy: 'ann', amountCents: 900, splitAmong: ['ann', 'bob', 'cat'] });
  assert.deepEqual(l.balances(), { ann: 600, bob: -300, cat: -300 });
});

test('balances accumulate and always sum to zero', () => {
  const l = new Ledger();
  l.addExpense({ paidBy: 'ann', amountCents: 1000, splitAmong: ['ann', 'bob', 'cat'] });
  l.addExpense({ paidBy: 'bob', amountCents: 600, splitAmong: ['bob', 'cat'] });
  const b = l.balances();
  assert.equal(Object.values(b).reduce((x, y) => x + y, 0), 0);
  assert.deepEqual(b, { ann: 666, bob: -33, cat: -633 });
});

test('someone can pay for others without sharing', () => {
  const l = new Ledger();
  l.addExpense({ paidBy: 'ann', amountCents: 500, splitAmong: ['bob'] });
  assert.deepEqual(l.balances(), { ann: 500, bob: -500 });
});

test('an expense with nobody to split among throws', () => {
  assert.throws(() => new Ledger().addExpense({ paidBy: 'ann', amountCents: 100, splitAmong: [] }), Error);
});

test('settles the biggest debt first', () => {
  assert.deepEqual(settle({ ann: 600, bob: -400, cat: -200 }), [
    { from: 'bob', to: 'ann', amountCents: 400 },
    { from: 'cat', to: 'ann', amountCents: 200 },
  ]);
});

test('settling breaks ties by name and clears every balance', () => {
  const balances = { dan: -300, cat: -300, ann: 300, bob: 300 };
  const transfers = settle(balances);
  assert.deepEqual(transfers, [
    { from: 'cat', to: 'ann', amountCents: 300 },
    { from: 'dan', to: 'bob', amountCents: 300 },
  ]);
  const after = { ...balances };
  for (const t of transfers) { after[t.from] += t.amountCents; after[t.to] -= t.amountCents; }
  assert.ok(Object.values(after).every(v => v === 0));
});

test('nothing to settle when everyone is even', () => {
  assert.deepEqual(settle({ ann: 0, bob: 0 }), []);
  assert.deepEqual(settle({}), []);
});

test('balances that do not sum to zero cannot be settled', () => {
  assert.throws(() => settle({ ann: 100, bob: -50 }), Error);
});
