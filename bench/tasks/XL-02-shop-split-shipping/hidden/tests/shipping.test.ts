import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS } from '../src/index.ts';
import { deliveredOrder, expect, level, lineOf, payOrder, placeOrder, requestReturn, shop } from './helpers.ts';
import type { Shop } from './helpers.ts';

/** A paid order of 12 mugs and 1 tea: W1 holds 10 mugs + the tea, W2 holds 2 mugs. */
function splitOrder(s: Shop, who: 'alice' | 'bob' = 'alice') {
  const order = placeOrder(s, who, { MUG: 12, TEA: 1 });
  payOrder(s, who, order.id);
  return order;
}

const ship = (s: Shop, orderId: string, warehouseId: string | undefined, token?: string) =>
  s.call('POST', `/orders/${orderId}/shipments`, token ?? s.staff, { warehouseId, carrier: 'fedex', trackingNumber: `T-${warehouseId}` });

test('a shipment needs a warehouse that holds part of the order', () => {
  const s = shop();
  const order = splitOrder(s);
  expect(ship(s, order.id, undefined), 400);
  expect(ship(s, order.id, 'wh_999'), 404);
  const w3 = expect(s.call('POST', '/warehouses', s.admin, { code: 'w3', name: 'East', priority: 3 }), 201).id;
  expect(ship(s, order.id, w3), 409);
  expect(ship(s, order.id, s.w1, s.alice), 403);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'paid');
});

test('each warehouse ships its own part of the order', () => {
  const s = shop();
  const order = splitOrder(s);
  const first = expect(ship(s, order.id, s.w1), 201);
  assert.equal(first.warehouseId, s.w1);
  assert.deepEqual(first.allocations.map((a: { sku: string; qty: number; warehouseId: string }) => [a.sku, a.qty, a.warehouseId]), [['MUG', 10, s.w1], ['TEA', 1, s.w1]]);
  assert.deepEqual([level(s, 'MUG', s.w1).onHand, level(s, 'MUG', s.w1).reserved], [0, 0]);
  assert.deepEqual([level(s, 'MUG', s.w2).onHand, level(s, 'MUG', s.w2).reserved], [10, 2]);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'partially_shipped');
  expect(ship(s, order.id, s.w1), 409);
  const second = expect(ship(s, order.id, s.w2), 201);
  assert.deepEqual(second.allocations.map((a: { sku: string; qty: number }) => [a.sku, a.qty]), [['MUG', 2]]);
  assert.deepEqual([level(s, 'MUG', s.w2).onHand, level(s, 'MUG', s.w2).reserved], [8, 0]);
  const o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'shipped');
  assert.deepEqual(o.history.map((h: { status: string }) => h.status), ['draft', 'placed', 'paid', 'partially_shipped', 'shipped']);
  expect(ship(s, order.id, s.w2), 409);
});

test('an order from one warehouse goes straight to shipped', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 2 });
  payOrder(s, 'alice', order.id);
  expect(ship(s, order.id, s.w1), 201);
  const o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'shipped');
  assert.equal(o.history.some((h: { status: string }) => h.status === 'partially_shipped'), false);
});

test('only paid orders ship, and a partly shipped order cannot be cancelled', () => {
  const s = shop();
  const placed = placeOrder(s, 'alice', { MUG: 1 });
  expect(ship(s, placed.id, s.w1), 409);
  const order = splitOrder(s);
  expect(ship(s, order.id, s.w2), 201);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.staff, {}), 409);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, {}), 409);
  assert.equal(level(s, 'MUG', s.w1).reserved, 10);
});

test('the shipments of an order are listed oldest first, visible like the order', () => {
  const s = shop();
  const order = splitOrder(s);
  expect(ship(s, order.id, s.w2), 201);
  s.clock.advance(60_000);
  expect(ship(s, order.id, s.w1), 201);
  const list = expect(s.call('GET', `/orders/${order.id}/shipments`, s.alice), 200);
  assert.deepEqual(list.map((x: { warehouseId: string }) => x.warehouseId), [s.w2, s.w1]);
  assert.ok(list.every((x: { trackingNumber: string; status: string }) => x.trackingNumber && x.status === 'in_transit'));
  expect(s.call('GET', `/orders/${order.id}/shipments`, s.bob), 404);
  assert.equal(s.call('GET', `/orders/${order.id}/shipment`, s.alice).status, 404);
});

test('the order is delivered when its last parcel is', () => {
  const s = shop();
  const order = splitOrder(s);
  const a = expect(ship(s, order.id, s.w1), 201);
  expect(s.call('POST', `/shipments/${a.id}/deliver`, s.staff), 200);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'partially_shipped');
  const b = expect(ship(s, order.id, s.w2), 201);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'shipped');
  s.clock.advanceDays(3);
  expect(s.call('POST', `/shipments/${b.id}/deliver`, s.staff), 200);
  const o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'delivered');
  assert.equal(o.deliveredAt, s.clock.now().toISOString());
  expect(s.call('POST', `/shipments/${b.id}/deliver`, s.staff), 409);
});

test('the order stays shipped while a parcel is still on its way', () => {
  const s = shop();
  const order = splitOrder(s);
  const a = expect(ship(s, order.id, s.w1), 201);
  expect(ship(s, order.id, s.w2), 201);
  expect(s.call('POST', `/shipments/${a.id}/deliver`, s.staff), 200);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'shipped');
  expect(requestReturn(s, s.alice, order.id, [{ lineId: lineOf(order, 'TEA').id, qty: 1, reason: 'other' }]), 409);
});

test('one email per parcel; the last one says the whole order is on its way', () => {
  const s = shop();
  const order = splitOrder(s);
  expect(ship(s, order.id, s.w1), 201);
  expect(ship(s, order.id, s.w2), 201);
  const mails = expect(s.call('GET', '/notifications', s.admin, undefined, { orderId: order.id, template: 'order_shipped' }), 200);
  assert.deepEqual(mails.map((n: { subject: string }) => n.subject), [`Part of order ${order.number} is on its way`, `Order ${order.number} is on its way`]);
  assert.ok(mails.every((n: { to: string }) => n.to === 'alice@example.com'));
});

test('a single-parcel order gets one shipping email', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  const mails = expect(s.call('GET', '/notifications', s.admin, undefined, { orderId: order.id, template: 'order_shipped' }), 200);
  assert.deepEqual(mails.map((n: { subject: string }) => n.subject), [`Order ${order.number} is on its way`]);
});

test('status changes are published: partially shipped, then shipped', () => {
  const s = shop();
  const order = splitOrder(s);
  expect(ship(s, order.id, s.w1), 201);
  expect(ship(s, order.id, s.w2), 201);
  const actions = expect(s.call('GET', '/audit', s.admin, undefined, { entity: 'order', entityId: order.id }), 200).items.map((e: { action: string }) => e.action);
  assert.deepEqual(actions.slice(-2), ['order.partially_shipped', 'order.shipped']);
  const shipments = expect(s.call('GET', '/audit', s.admin, undefined, { action: 'shipment.created' }), 200).items;
  assert.equal(shipments.length, 2);
});

test('returned units go back to the warehouses that shipped them, across returns', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 12 });
  const line = order.lines[0].id;
  const back = (qty: number, condition: string) => {
    const r = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty, reason: 'other' }]), 201);
    expect(s.call('POST', `/returns/${r.id}/approve`, s.staff, { lines: [{ lineId: line, condition }] }), 200);
  };
  const w1 = level(s, 'MUG', s.w1).onHand;
  const w2 = level(s, 'MUG', s.w2).onHand;
  back(9, 'resellable');
  assert.deepEqual([level(s, 'MUG', s.w1).onHand - w1, level(s, 'MUG', s.w2).onHand - w2], [9, 0]);
  back(3, 'resellable');
  assert.deepEqual([level(s, 'MUG', s.w1).onHand - w1, level(s, 'MUG', s.w2).onHand - w2], [10, 2]);
});

test('damaged units use up their warehouse share without being restocked', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 12 });
  const line = order.lines[0].id;
  const w1 = level(s, 'MUG', s.w1).onHand;
  const w2 = level(s, 'MUG', s.w2).onHand;
  const a = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 10, reason: 'damaged' }]), 201);
  expect(s.call('POST', `/returns/${a.id}/approve`, s.staff, { lines: [{ lineId: line, condition: 'damaged' }] }), 200);
  const b = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 2, reason: 'not_needed' }]), 201);
  expect(s.call('POST', `/returns/${b.id}/approve`, s.staff, { lines: [{ lineId: line, condition: 'resellable' }] }), 200);
  assert.deepEqual([level(s, 'MUG', s.w1).onHand - w1, level(s, 'MUG', s.w2).onHand - w2], [0, 2]);
});

test('the return window counts from the last delivery', () => {
  const s = shop();
  const order = splitOrder(s);
  const a = expect(ship(s, order.id, s.w1), 201);
  expect(s.call('POST', `/shipments/${a.id}/deliver`, s.staff), 200);
  s.clock.advanceDays(10);
  const b = expect(ship(s, order.id, s.w2), 201);
  s.clock.advanceDays(2);
  expect(s.call('POST', `/shipments/${b.id}/deliver`, s.staff), 200);
  s.clock.advance(30 * DAY_MS);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: lineOf(order, 'TEA').id, qty: 1, reason: 'other' }]), 201);
});

test("a warehouse cannot ship its part twice, even when other orders' reservations would cover it", () => {
  const s = shop();
  const mine = placeOrder(s, 'alice', { TEA: 2, BOOK: 1 });
  payOrder(s, 'alice', mine.id);
  placeOrder(s, 'bob', { TEA: 3 });
  expect(ship(s, mine.id, s.w1), 201);
  expect(ship(s, mine.id, s.w1), 409);
  assert.deepEqual([level(s, 'TEA', s.w1).onHand, level(s, 'TEA', s.w1).reserved], [48, 3]);
  assert.equal(expect(s.call('GET', `/orders/${mine.id}`, s.alice), 200).status, 'partially_shipped');
});
