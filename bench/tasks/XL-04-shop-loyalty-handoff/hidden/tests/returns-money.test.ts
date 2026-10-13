import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, lineOf, payment, requestReturn, shop } from './helpers.ts';
import type { Shop } from './helpers.ts';

/** Requests and approves (resellable) a return of `qty` units of `sku`; returns the approved return. */
function returnUnits(s: Shop, order: any, units: Record<string, number>, reason = 'not_needed') {
  const lines = Object.entries(units).map(([sku, qty]) => ({ lineId: lineOf(order, sku).id, qty, reason }));
  const ret = expect(requestReturn(s, s.alice, order.id, lines), 201);
  return expect(s.call('POST', `/returns/${ret.id}/approve`, s.staff, { lines: lines.map(l => ({ lineId: l.lineId, condition: 'resellable' })) }), 200);
}

test('the refund is the paid share of the line, tax included', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3, TEA: 1 });
  assert.equal(lineOf(order, 'MUG').amounts.totalCents, 3960);
  assert.equal(returnUnits(s, order, { MUG: 2 }).refundCents, 2640);
  assert.equal(returnUnits(s, order, { TEA: 1 }).refundCents, 893);
});

test('the refunds of a line add up exactly to its total, whatever the split', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { TEA: 3, MUG: 5 });
  const tea = lineOf(order, 'TEA');
  assert.equal(tea.amounts.totalCents, 2678);
  const parts = [1, 1, 1].map(n => returnUnits(s, order, { TEA: n }).refundCents);
  assert.deepEqual(parts, [893, 892, 893]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 2678);
});

test('half a cent rounds up', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { TEA: 2, MUG: 5 });
  assert.equal(lineOf(order, 'TEA').amounts.totalCents, 1785);
  assert.equal(returnUnits(s, order, { TEA: 1 }).refundCents, 893);
  assert.equal(returnUnits(s, order, { TEA: 1 }).refundCents, 892);
});

test('discounted lines refund what was actually paid for them', () => {
  const s = shop();
  expect(s.call('POST', '/coupons', s.staff, { code: 'SAVE10', kind: 'percent', value: 1000 }), 201);
  const order = deliveredOrder(s, 'alice', { MUG: 2, TEA: 1 }, { coupon: 'SAVE10' });
  assert.equal(lineOf(order, 'MUG').amounts.totalCents, 2376);
  assert.equal(returnUnits(s, order, { MUG: 1 }).refundCents, 1188);
});

test('shipping is refunded once, with the last return, when something was damaged or wrong', () => {
  const s = shop();
  expect(s.call('POST', '/coupons', s.staff, { code: 'SAVE10', kind: 'percent', value: 1000 }), 201);
  const order = deliveredOrder(s, 'alice', { MUG: 2, TEA: 1 }, { coupon: 'SAVE10' });
  assert.equal(order.amounts.shippingCents, 500);
  assert.equal(returnUnits(s, order, { TEA: 1 }, 'damaged').refundCents, 803);
  assert.equal(returnUnits(s, order, { MUG: 2 }, 'not_needed').refundCents, 2376 + 500);
  const p = payment(s, order.id);
  assert.equal(p.refundedCents, p.amountCents);
});

test('shipping is not refunded when nothing was damaged or wrong', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1, TEA: 1 });
  assert.equal(order.amounts.shippingCents, 500);
  assert.equal(returnUnits(s, order, { MUG: 1, TEA: 1 }, 'other').refundCents, 1320 + 893);
  assert.equal(payment(s, order.id).refundedCents, 1320 + 893);
});

test('shipping is not refunded while units are still kept', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 2, TEA: 1 });
  assert.equal(returnUnits(s, order, { MUG: 2 }, 'wrong_item').refundCents, 2640);
});

test('free-shipping orders have no shipping to refund', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { LAMP: 2 });
  assert.equal(order.amounts.shippingCents, 0);
  assert.equal(returnUnits(s, order, { LAMP: 2 }, 'damaged').refundCents, order.amounts.totalCents);
});

test('a return never refunds more than is left on the payment', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3, TEA: 1 });
  const p = payment(s, order.id);
  assert.equal(p.amountCents, 5353);
  expect(s.call('POST', `/payments/${p.id}/refunds`, s.staff, { amountCents: 5000, reason: 'goodwill' }), 201);
  assert.equal(returnUnits(s, order, { MUG: 1 }).refundCents, 353);
  const zero = returnUnits(s, order, { MUG: 1 });
  assert.equal(zero.refundCents, 0);
  const after = payment(s, order.id);
  assert.equal(after.refundedCents, 5353);
  assert.equal(after.refunds.length, 2);
  assert.equal(s.app.services.gateway.refunds.length, 2);
});

test('a fully returned order gives its coupon use back', () => {
  const s = shop();
  const coupon = expect(s.call('POST', '/coupons', s.staff, { code: 'ONCE', kind: 'fixed', value: 100, maxUses: 1 }), 201);
  const order = deliveredOrder(s, 'alice', { MUG: 2 }, { coupon: 'ONCE' });
  returnUnits(s, order, { MUG: 1 });
  assert.equal(expect(s.call('GET', `/coupons/${coupon.id}`, s.staff), 200).uses, 1);
  returnUnits(s, order, { MUG: 1 });
  assert.equal(expect(s.call('GET', `/coupons/${coupon.id}`, s.staff), 200).uses, 0);
});
