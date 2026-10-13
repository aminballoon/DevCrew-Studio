import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, lineOf, payOrder, placeOrder, requestReturn, shop } from './helpers.ts';
import type { Shop } from './helpers.ts';

const points = (s: Shop, who: 'alice' | 'bob') => expect(s.call('GET', '/customers/me/points', s[who]), 200);

function returnUnits(s: Shop, order: any, units: Record<string, number>) {
  const lines = Object.entries(units).map(([sku, qty]) => ({ lineId: lineOf(order, sku).id, qty, reason: 'other' }));
  const r = expect(requestReturn(s, s.alice, order.id, lines), 201);
  expect(s.call('POST', `/returns/${r.id}/approve`, s.staff, { lines: lines.map(l => ({ lineId: l.lineId, condition: 'resellable' })) }), 200);
}

test('customers earn a point per whole dollar of goods when an order is paid', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 3, TEA: 1 });
  assert.equal(points(s, 'alice').balance, 0);
  payOrder(s, 'alice', order.id);
  const p = points(s, 'alice');
  assert.equal(p.balance, 44);
  assert.deepEqual(p.entries.map((e: { points: number; kind: string; ref: string }) => [e.points, e.kind, e.ref]), [[44, 'earned', order.id]]);
  assert.equal(typeof p.entries[0].at, 'string');
});

test('points count goods after discount, without tax or shipping', () => {
  const s = shop();
  expect(s.call('POST', '/coupons', s.staff, { code: 'SAVE10', kind: 'percent', value: 1000 }), 201);
  const a = placeOrder(s, 'alice', { MUG: 2, TEA: 1 }, { coupon: 'SAVE10' });
  payOrder(s, 'alice', a.id);
  assert.equal(points(s, 'alice').balance, 29);
  const b = placeOrder(s, 'bob', { LAMP: 2 });
  payOrder(s, 'bob', b.id);
  assert.equal(points(s, 'bob').balance, 99);
});

test('cancelling a paid order takes its points back; unpaid orders never earned any', () => {
  const s = shop();
  const paid = placeOrder(s, 'alice', { MUG: 3, TEA: 1 });
  payOrder(s, 'alice', paid.id);
  expect(s.call('POST', `/orders/${paid.id}/cancel`, s.alice, {}), 200);
  const p = points(s, 'alice');
  assert.equal(p.balance, 0);
  assert.deepEqual(p.entries.map((e: { points: number; kind: string }) => [e.points, e.kind]), [[44, 'earned'], [-44, 'reversed']]);
  const unpaid = placeOrder(s, 'bob', { MUG: 1 });
  expect(s.call('POST', `/orders/${unpaid.id}/cancel`, s.bob, {}), 200);
  assert.deepEqual(points(s, 'bob').entries, []);
});

test('returns take back the points of what was returned', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3, TEA: 1 });
  returnUnits(s, order, { MUG: 1 });
  assert.equal(points(s, 'alice').balance, 32);
  returnUnits(s, order, { TEA: 1 });
  assert.equal(points(s, 'alice').balance, 24);
  returnUnits(s, order, { MUG: 2 });
  const p = points(s, 'alice');
  assert.equal(p.balance, 0);
  assert.deepEqual(p.entries.map((e: { points: number; kind: string }) => [e.points, e.kind]), [[44, 'earned'], [-12, 'reversed'], [-8, 'reversed'], [-24, 'reversed']]);
});

test('returned discounted goods take back points on what was paid for them', () => {
  const s = shop();
  expect(s.call('POST', '/coupons', s.staff, { code: 'SAVE10', kind: 'percent', value: 1000 }), 201);
  const order = deliveredOrder(s, 'alice', { MUG: 2, TEA: 1 }, { coupon: 'SAVE10' });
  returnUnits(s, order, { MUG: 1 });
  assert.equal(points(s, 'alice').balance, 18);
});

test('rejected returns leave points alone', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3 });
  const r = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 2, reason: 'other' }]), 201);
  expect(s.call('POST', `/returns/${r.id}/reject`, s.staff, { reason: 'no' }), 200);
  assert.equal(points(s, 'alice').balance, 36);
});

test('100 points can be turned into $1 of store credit', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { LAMP: 3 });
  payOrder(s, 'alice', order.id);
  assert.equal(points(s, 'alice').balance, 149);
  for (const bad of [0, 50, 150, 1.5, '100']) {
    expect(s.call('POST', '/customers/me/points/redeem', s.alice, { points: bad }), 400);
  }
  expect(s.call('POST', '/customers/me/points/redeem', s.alice, { points: 200 }), 409);
  const after = expect(s.call('POST', '/customers/me/points/redeem', s.alice, { points: 100 }), 200);
  assert.equal(after.balance, 49);
  assert.deepEqual(after.entries.at(-1), { ...after.entries.at(-1), points: -100, kind: 'redeemed' });
  const credit = expect(s.call('GET', '/customers/me/credit', s.alice), 200);
  assert.equal(credit.balanceCents, 100);
  assert.deepEqual(credit.entries.at(-1), { ...credit.entries.at(-1), amountCents: 100, kind: 'points' });
});

test('taking points back never makes the balance negative', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { LAMP: 3 });
  expect(s.call('POST', '/customers/me/points/redeem', s.alice, { points: 100 }), 200);
  returnUnits(s, order, { LAMP: 3 });
  const p = points(s, 'alice');
  assert.equal(p.balance, 0);
  assert.deepEqual(p.entries.at(-1), { ...p.entries.at(-1), points: -49, kind: 'reversed' });
});

test('points are private: other customers get 404, staff can look', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 3 });
  payOrder(s, 'alice', order.id);
  expect(s.call('GET', `/customers/${s.aliceCustomer}/points`, s.bob), 404);
  assert.equal(expect(s.call('GET', `/customers/${s.aliceCustomer}/points`, s.staff), 200).balance, 36);
  assert.equal(expect(s.call('GET', `/customers/${s.aliceCustomer}/points`, s.alice), 200).balance, 36);
  expect(s.call('POST', '/customers/me/points/redeem', s.staff, { points: 100 }), 404);
});

test('paying with store credit earns points the same way', () => {
  const s = shop();
  const card = expect(s.call('POST', '/gift-cards', s.staff, { amountCents: 5000 }), 201);
  expect(s.call('POST', '/customers/me/credit/redeem', s.alice, { code: card.code }), 200);
  const order = placeOrder(s, 'alice', { MUG: 1 });
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { useCreditCents: 1820 }), 201);
  assert.equal(points(s, 'alice').balance, 12);
});

test('point changes are in the audit log', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 3 });
  payOrder(s, 'alice', order.id);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, {}), 200);
  const actions = expect(s.call('GET', '/audit', s.admin, undefined, { limit: '100' }), 200).items.map((e: { action: string }) => e.action);
  assert.ok(actions.includes('points.earned'));
  assert.ok(actions.includes('points.reversed'));
});
