import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, level, lineOf, payment, requestReturn, shop } from './helpers.ts';
import type { Shop } from './helpers.ts';

function requested(s: Shop, lines: Record<string, number>, ret: Record<string, number>, reason = 'not_needed') {
  const order = deliveredOrder(s, 'alice', lines);
  const r = expect(requestReturn(s, s.alice, order.id, Object.entries(ret).map(([sku, qty]) => ({ lineId: lineOf(order, sku).id, qty, reason }))), 201);
  return { order, ret: r };
}

const approve = (s: Shop, ret: { id: string; lines: { lineId: string }[] }, condition = 'resellable', token?: string) =>
  s.call('POST', `/returns/${ret.id}/approve`, token ?? s.staff, { lines: ret.lines.map(l => ({ lineId: l.lineId, condition })) });

test('approving refunds, records the decision and the condition of each line', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 3, TEA: 1 }, { MUG: 1 });
  s.clock.advance(3_600_000);
  const done = expect(approve(s, ret), 200);
  assert.equal(done.status, 'approved');
  assert.equal(done.refundCents, 1320);
  assert.equal(done.decidedBy, s.staffId);
  assert.equal(done.decidedAt, s.clock.now().toISOString());
  assert.equal(done.lines[0].condition, 'resellable');
  const p = payment(s, order.id);
  assert.equal(p.refundedCents, 1320);
  assert.equal(p.refunds.at(-1).reason, `return ${ret.id}`);
  assert.deepEqual(s.app.services.gateway.refunds.map(r => r.amountCents), [1320]);
  assert.equal(expect(s.call('GET', `/returns/${ret.id}`, s.alice), 200).status, 'approved');
});

test('rejecting needs a reason and records the decision', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 2 }, { MUG: 2 });
  expect(s.call('POST', `/returns/${ret.id}/reject`, s.staff, {}), 400);
  expect(s.call('POST', `/returns/${ret.id}/reject`, s.staff, { reason: 'x'.repeat(501) }), 400);
  const done = expect(s.call('POST', `/returns/${ret.id}/reject`, s.admin, { reason: 'used item' }), 200);
  assert.equal(done.status, 'rejected');
  assert.equal(done.rejectionReason, 'used item');
  assert.equal(typeof done.decidedBy, 'string');
  assert.equal(done.refundCents, null);
  assert.equal(payment(s, order.id).refundedCents, 0);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'delivered');
});

test('customers cannot decide, not even on their own return', () => {
  const s = shop();
  const { ret } = requested(s, { MUG: 2 }, { MUG: 1 });
  expect(approve(s, ret, 'resellable', s.alice), 403);
  expect(s.call('POST', `/returns/${ret.id}/reject`, s.alice, { reason: 'no' }), 403);
  assert.equal(expect(s.call('GET', `/returns/${ret.id}`, s.alice), 200).status, 'requested');
});

test('only requested returns can be decided', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 3 }, { MUG: 1 });
  expect(approve(s, ret), 200);
  expect(approve(s, ret), 409);
  expect(s.call('POST', `/returns/${ret.id}/reject`, s.staff, { reason: 'late' }), 409);
  const second = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 201);
  expect(s.call('POST', `/returns/${second.id}/reject`, s.staff, { reason: 'no' }), 200);
  expect(approve(s, second), 409);
  assert.equal(payment(s, order.id).refundedCents, 1320);
});

test('every line of the return needs exactly one valid condition', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 2, TEA: 2 }, { MUG: 1, TEA: 1 });
  const [a, b] = ret.lines.map((l: { lineId: string }) => l.lineId);
  const post = (lines: unknown) => s.call('POST', `/returns/${ret.id}/approve`, s.staff, { lines });
  expect(post([{ lineId: a, condition: 'resellable' }]), 400);
  expect(post([{ lineId: a, condition: 'resellable' }, { lineId: a, condition: 'damaged' }]), 400);
  expect(post([{ lineId: a, condition: 'resellable' }, { lineId: b, condition: 'mint' }]), 400);
  expect(post([{ lineId: a, condition: 'resellable' }, { lineId: b, condition: 'damaged' }, { lineId: 'lin_999', condition: 'damaged' }]), 400);
  assert.equal(payment(s, order.id).refundedCents, 0);
  const done = expect(post([{ lineId: b, condition: 'damaged' }, { lineId: a, condition: 'resellable' }]), 200);
  assert.deepEqual(Object.fromEntries(done.lines.map((l: { sku: string; condition: string }) => [l.sku, l.condition])), { MUG: 'resellable', TEA: 'damaged' });
});

test('resellable units go back to the warehouses that shipped them; damaged ones do not', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 12, TEA: 4 });
  assert.deepEqual(lineOf(order, 'MUG').fulfilment.map((f: { warehouseId: string }) => f.warehouseId), [s.w1, s.w2]);
  const before = { w1: level(s, 'MUG', s.w1).onHand, w2: level(s, 'MUG', s.w2).onHand, tea: level(s, 'TEA', s.w1).onHand };
  const ret = expect(requestReturn(s, s.alice, order.id, [
    { lineId: lineOf(order, 'MUG').id, qty: 11, reason: 'not_needed' },
    { lineId: lineOf(order, 'TEA').id, qty: 2, reason: 'damaged' },
  ]), 201);
  expect(s.call('POST', `/returns/${ret.id}/approve`, s.staff, { lines: [
    { lineId: lineOf(order, 'MUG').id, condition: 'resellable' },
    { lineId: lineOf(order, 'TEA').id, condition: 'damaged' },
  ] }), 200);
  assert.equal(level(s, 'MUG', s.w1).onHand, before.w1 + 10);
  assert.equal(level(s, 'MUG', s.w2).onHand, before.w2 + 1);
  assert.equal(level(s, 'TEA', s.w1).onHand, before.tea);
  const moves = expect(s.call('GET', '/inventory/MUG/movements', s.staff), 200);
  const back = moves.filter((m: { kind: string }) => m.kind === 'return');
  assert.deepEqual(back.map((m: Record<string, unknown>) => [m.warehouseId, m.onHandDelta, m.reservedDelta, m.ref]), [[s.w1, 10, 0, ret.id], [s.w2, 1, 0, ret.id]]);
  assert.equal(expect(s.call('GET', '/inventory/TEA/movements', s.staff), 200).filter((m: { kind: string }) => m.kind === 'return').length, 0);
});

test('a gateway failure changes nothing', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 3 }, { MUG: 3 });
  const stock = level(s, 'MUG', s.w1).onHand;
  s.app.services.gateway.down = true;
  expect(approve(s, ret), 402);
  s.app.services.gateway.down = false;
  assert.equal(expect(s.call('GET', `/returns/${ret.id}`, s.staff), 200).status, 'requested');
  assert.equal(level(s, 'MUG', s.w1).onHand, stock);
  assert.equal(payment(s, order.id).refundedCents, 0);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'delivered');
  assert.equal(expect(s.call('GET', '/audit', s.admin, undefined, { action: 'return.approved' }), 200).items.length, 0);
  expect(approve(s, ret), 200);
});

test('order status follows approvals: partially returned, then returned', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 3, TEA: 1 }, { MUG: 1 });
  expect(approve(s, ret), 200);
  let o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'partially_returned');
  assert.deepEqual(o.history.at(-1), { status: 'partially_returned', at: s.clock.now().toISOString(), actor: s.staffId });
  const again = expect(requestReturn(s, s.alice, order.id, [{ lineId: lineOf(order, 'MUG').id, qty: 1, reason: 'other' }]), 201);
  expect(approve(s, again, 'damaged', s.admin), 200);
  o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'partially_returned');
  assert.equal(o.history.filter((h: { status: string }) => h.status === 'partially_returned').length, 1);
  const last = expect(requestReturn(s, s.alice, order.id, [
    { lineId: lineOf(order, 'MUG').id, qty: 1, reason: 'other' }, { lineId: lineOf(order, 'TEA').id, qty: 1, reason: 'other' },
  ]), 201);
  expect(approve(s, last), 200);
  o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'returned');
  assert.deepEqual(o.history.map((h: { status: string }) => h.status), ['draft', 'placed', 'paid', 'shipped', 'delivered', 'partially_returned', 'returned']);
});

test('an order returned in one go goes straight to returned', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 1, TEA: 2 }, { MUG: 1, TEA: 2 });
  expect(approve(s, ret), 200);
  const o = expect(s.call('GET', `/orders/${order.id}`, s.alice), 200);
  assert.equal(o.status, 'returned');
  assert.deepEqual(o.history.slice(-2).map((h: { status: string }) => h.status), ['delivered', 'returned']);
  expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 409);
});

test('returned orders cannot be cancelled, but staff can still refund them', () => {
  const s = shop();
  const { order, ret } = requested(s, { MUG: 3 }, { MUG: 1 });
  expect(approve(s, ret), 200);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.staff, {}), 409);
  const p = payment(s, order.id);
  expect(s.call('POST', `/payments/${p.id}/refunds`, s.staff, { amountCents: 100, reason: 'sorry' }), 201);
  assert.equal(payment(s, order.id).refundedCents, 1420);
});
