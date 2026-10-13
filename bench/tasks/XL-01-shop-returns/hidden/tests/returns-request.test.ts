import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS } from '../src/index.ts';
import { deliveredOrder, expect, lineOf, payOrder, placeOrder, requestReturn, shop } from './helpers.ts';

test('a customer requests a return of a delivered order', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3, TEA: 1 });
  const mug = lineOf(order, 'MUG');
  const ret = expect(requestReturn(s, s.alice, order.id, [{ lineId: mug.id, qty: 2, reason: 'not_needed' }]), 201);
  assert.match(ret.id, /^ret_/);
  assert.equal(ret.orderId, order.id);
  assert.equal(ret.status, 'requested');
  assert.deepEqual(ret.lines.map(({ lineId, sku, qty, reason }: Record<string, unknown>) => ({ lineId, sku, qty, reason })),
    [{ lineId: mug.id, sku: 'MUG', qty: 2, reason: 'not_needed' }]);
  assert.equal(ret.note, '');
  assert.equal(ret.refundCents, null);
  assert.equal(ret.decidedAt, null);
  assert.equal(ret.decidedBy, null);
  assert.equal(ret.requestedAt, s.clock.now().toISOString());
});

test('the note is kept, and limited to 500 characters', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 2 });
  const line = lineOf(order, 'MUG');
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line.id, qty: 1, reason: 'other' }], 'x'.repeat(501)), 400);
  const ret = expect(requestReturn(s, s.alice, order.id, [{ lineId: line.id, qty: 1, reason: 'other' }], 'box was opened'), 201);
  assert.equal(ret.note, 'box was opened');
});

test('staff may request a return for any order', () => {
  const s = shop();
  const order = deliveredOrder(s, 'bob', { TEA: 2 });
  const ret = expect(requestReturn(s, s.staff, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'wrong_item' }]), 201);
  assert.equal(ret.orderId, order.id);
  expect(s.call('GET', `/returns/${ret.id}`, s.bob), 200);
});

test("another customer's order is not found", () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  expect(requestReturn(s, s.bob, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 404);
  expect(requestReturn(s, s.alice, 'ord_999', [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 404);
  expect(s.call('POST', `/orders/${order.id}/returns`, null, { lines: [] }), 401);
});

test('only delivered (or partially returned) orders can get a return', () => {
  const s = shop();
  const placed = placeOrder(s, 'alice', { MUG: 1 });
  expect(requestReturn(s, s.alice, placed.id, [{ lineId: placed.lines[0].id, qty: 1, reason: 'other' }]), 409);
  payOrder(s, 'alice', placed.id);
  expect(requestReturn(s, s.alice, placed.id, [{ lineId: placed.lines[0].id, qty: 1, reason: 'other' }]), 409);
  const shipment = expect(s.call('POST', `/orders/${placed.id}/shipments`, s.staff, { carrier: 'dhl', trackingNumber: 'T1' }), 201);
  expect(requestReturn(s, s.alice, placed.id, [{ lineId: placed.lines[0].id, qty: 1, reason: 'other' }]), 409);
  expect(s.call('POST', `/shipments/${shipment.id}/deliver`, s.staff), 200);
  expect(requestReturn(s, s.alice, placed.id, [{ lineId: placed.lines[0].id, qty: 1, reason: 'other' }]), 201);

  const cancelled = placeOrder(s, 'alice', { TEA: 1 });
  expect(s.call('POST', `/orders/${cancelled.id}/cancel`, s.alice, {}), 200);
  expect(requestReturn(s, s.alice, cancelled.id, [{ lineId: cancelled.lines[0].id, qty: 1, reason: 'other' }]), 409);
});

test('requests are accepted until exactly 30 days after delivery', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 2 });
  const line = order.lines[0].id;
  s.clock.advance(30 * DAY_MS);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 1, reason: 'other' }]), 201);
  s.clock.advance(1);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 1, reason: 'other' }]), 409);
});

test('the window starts at delivery, not at the order', () => {
  const s = shop();
  const placed = placeOrder(s, 'alice', { MUG: 1 });
  payOrder(s, 'alice', placed.id);
  s.clock.advanceDays(20);
  const shipment = expect(s.call('POST', `/orders/${placed.id}/shipments`, s.staff, { carrier: 'ups', trackingNumber: 'Z' }), 201);
  s.clock.advanceDays(5);
  expect(s.call('POST', `/shipments/${shipment.id}/deliver`, s.staff), 200);
  s.clock.advanceDays(29);
  expect(requestReturn(s, s.alice, placed.id, [{ lineId: placed.lines[0].id, qty: 1, reason: 'other' }]), 201);
});

test('bad lines are rejected', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3, TEA: 1 });
  const mug = lineOf(order, 'MUG').id;
  expect(requestReturn(s, s.alice, order.id, []), 400);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: mug, qty: 0, reason: 'other' }]), 400);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: mug, qty: 1.5, reason: 'other' }]), 400);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: mug, qty: 1, reason: 'bored' }]), 400);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: mug, qty: 1, reason: 'other' }, { lineId: mug, qty: 1, reason: 'damaged' }]), 400);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: 'lin_999', qty: 1, reason: 'other' }]), 404);
  assert.deepEqual(expect(s.call('GET', `/orders/${order.id}/returns`, s.alice), 200), []);
});

test('a line of another order is not a line of this order', () => {
  const s = shop();
  const mine = deliveredOrder(s, 'alice', { MUG: 1 });
  const other = deliveredOrder(s, 'alice', { TEA: 1 });
  expect(requestReturn(s, s.alice, mine.id, [{ lineId: other.lines[0].id, qty: 1, reason: 'other' }]), 404);
  expect(requestReturn(s, s.alice, mine.id, [{ lineId: mine.lines[0].id, qty: 1, reason: 'other' }]), 201);
});

test('units cannot be returned twice while a return is requested or approved', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3 });
  const line = order.lines[0].id;
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 4, reason: 'other' }]), 409);
  const first = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 2, reason: 'other' }]), 201);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 2, reason: 'other' }]), 409);
  expect(s.call('POST', `/returns/${first.id}/approve`, s.staff, { lines: [{ lineId: line, condition: 'resellable' }] }), 200);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 2, reason: 'other' }]), 409);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 1, reason: 'other' }]), 201);
});

test('units of a rejected return can be requested again', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 2 });
  const line = order.lines[0].id;
  const first = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 2, reason: 'other' }]), 201);
  expect(s.call('POST', `/returns/${first.id}/reject`, s.staff, { reason: 'used' }), 200);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 2, reason: 'damaged' }]), 201);
});

test('reading returns: own only for customers, all for staff', () => {
  const s = shop();
  const a = deliveredOrder(s, 'alice', { MUG: 2 });
  const b = deliveredOrder(s, 'bob', { TEA: 2 });
  const ra = expect(requestReturn(s, s.alice, a.id, [{ lineId: a.lines[0].id, qty: 1, reason: 'other' }]), 201);
  s.clock.advance(1000);
  const rb = expect(requestReturn(s, s.bob, b.id, [{ lineId: b.lines[0].id, qty: 1, reason: 'other' }]), 201);
  assert.equal(expect(s.call('GET', `/returns/${ra.id}`, s.alice), 200).id, ra.id);
  expect(s.call('GET', `/returns/${ra.id}`, s.bob), 404);
  expect(s.call('GET', '/returns/ret_999', s.staff), 404);
  expect(s.call('GET', `/orders/${a.id}/returns`, s.bob), 404);
  assert.deepEqual(expect(s.call('GET', `/orders/${a.id}/returns`, s.alice), 200).map((r: { id: string }) => r.id), [ra.id]);
  expect(s.call('GET', '/returns', s.alice), 403);
  const all = expect(s.call('GET', '/returns', s.staff), 200);
  assert.deepEqual(all.items.map((r: { id: string }) => r.id), [ra.id, rb.id]);
  assert.equal(all.nextCursor, null);
});

test('the staff list filters by status and paginates', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { TEA: 5 });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 201).id);
    s.clock.advance(1000);
  }
  expect(s.call('POST', `/returns/${ids[1]}/reject`, s.staff, { reason: 'no' }), 200);
  const page = expect(s.call('GET', '/returns', s.admin, undefined, { status: 'requested', limit: '1' }), 200);
  assert.deepEqual(page.items.map((r: { id: string }) => r.id), [ids[0]]);
  const next = expect(s.call('GET', '/returns', s.admin, undefined, { status: 'requested', limit: '1', cursor: page.nextCursor }), 200);
  assert.deepEqual(next.items.map((r: { id: string }) => r.id), [ids[2]]);
  assert.equal(next.nextCursor, null);
});
