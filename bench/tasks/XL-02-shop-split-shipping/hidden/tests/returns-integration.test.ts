import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, lineOf, requestReturn, shop } from './helpers.ts';

test('return events land in the audit log with the acting user and the order', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3 });
  const a = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 201);
  const b = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 201);
  expect(s.call('POST', `/returns/${a.id}/approve`, s.staff, { lines: [{ lineId: order.lines[0].id, condition: 'resellable' }] }), 200);
  expect(s.call('POST', `/returns/${b.id}/reject`, s.admin, { reason: 'no' }), 200);
  const entries = expect(s.call('GET', '/audit', s.admin, undefined, { entity: 'return' }), 200).items;
  assert.deepEqual(entries.map((e: { action: string; entityId: string }) => [e.action, e.entityId]),
    [['return.requested', a.id], ['return.requested', b.id], ['return.approved', a.id], ['return.rejected', b.id]]);
  assert.deepEqual(entries.map((e: { actor: string }) => e.actor), [s.aliceId, s.aliceId, s.staffId, entries[3].actor]);
  assert.notEqual(entries[3].actor, s.staffId);
  assert.ok(entries.every((e: { data: { orderId: string } }) => e.data.orderId === order.id));
});

test('order status changes are published as events', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 2 });
  for (let i = 0; i < 2; i++) {
    const r = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 201);
    expect(s.call('POST', `/returns/${r.id}/approve`, s.staff, { lines: [{ lineId: order.lines[0].id, condition: 'damaged' }] }), 200);
  }
  const actions = expect(s.call('GET', '/audit', s.admin, undefined, { entity: 'order', entityId: order.id }), 200).items.map((e: { action: string }) => e.action);
  assert.deepEqual(actions.slice(-2), ['order.partially_returned', 'order.returned']);
});

test('the customer is emailed when a return is received, approved and rejected', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3 });
  const line = order.lines[0].id;
  const a = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 1, reason: 'other' }]), 201);
  expect(s.call('POST', `/returns/${a.id}/approve`, s.staff, { lines: [{ lineId: line, condition: 'resellable' }] }), 200);
  const b = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 1, reason: 'other' }]), 201);
  expect(s.call('POST', `/returns/${b.id}/reject`, s.staff, { reason: 'no' }), 200);
  const mails = expect(s.call('GET', '/notifications', s.admin, undefined, { orderId: order.id }), 200);
  const by = (t: string) => mails.filter((n: { template: string }) => n.template === t);
  assert.deepEqual(by('return_received').map((n: { subject: string }) => n.subject), [
    `Return request for order ${order.number} received`, `Return request for order ${order.number} received`,
  ]);
  assert.deepEqual(by('return_approved').map((n: { subject: string }) => n.subject), [`Return for order ${order.number} approved: $13.20 refunded`]);
  assert.deepEqual(by('return_rejected').map((n: { subject: string }) => n.subject), [`Return for order ${order.number} rejected`]);
  assert.equal(by('refund_issued').length, 1);
  assert.ok(mails.every((n: { to: string }) => n.to === 'alice@example.com'));
});

test('sales report: return refunds on the day approved, returned units leave top products', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3, TEA: 1 });
  const r = expect(requestReturn(s, s.alice, order.id, [
    { lineId: lineOf(order, 'MUG').id, qty: 1, reason: 'other' }, { lineId: lineOf(order, 'TEA').id, qty: 1, reason: 'other' },
  ]), 201);
  s.clock.advanceDays(2);
  expect(s.call('POST', `/returns/${r.id}/approve`, s.staff, { lines: [
    { lineId: lineOf(order, 'MUG').id, condition: 'resellable' }, { lineId: lineOf(order, 'TEA').id, condition: 'damaged' },
  ] }), 200);
  const report = expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-03-01', to: '2030-03-03' }), 200);
  assert.deepEqual(report.days.map((d: { refundsCents: number }) => d.refundsCents), [0, 0, 1320 + 893]);
  assert.equal(report.totals.netCents, 5353 - 2213);
  assert.deepEqual(report.topProducts, [{ sku: 'MUG', units: 2 }]);
});

test('requested and rejected returns do not change top products', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3 });
  const r = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 2, reason: 'other' }]), 201);
  const report = () => expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-03-01', to: '2030-03-01' }), 200);
  assert.deepEqual(report().topProducts, [{ sku: 'MUG', units: 3 }]);
  expect(s.call('POST', `/returns/${r.id}/reject`, s.staff, { reason: 'no' }), 200);
  assert.deepEqual(report().topProducts, [{ sku: 'MUG', units: 3 }]);
});

test('restocked units are available to new orders and the low-stock report', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { LAMP: 3 });
  expect(s.call('GET', '/reports/low-stock', s.staff, undefined, { threshold: '1' }), 200).some((r: { sku: string }) => r.sku === 'LAMP') || assert.fail('LAMP should be out');
  const r = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 2, reason: 'not_needed' }]), 201);
  expect(s.call('POST', `/returns/${r.id}/approve`, s.staff, { lines: [{ lineId: order.lines[0].id, condition: 'resellable' }] }), 200);
  const rows = expect(s.call('GET', '/reports/low-stock', s.staff, undefined, { threshold: '3' }), 200);
  assert.deepEqual(rows.find((x: { sku: string }) => x.sku === 'LAMP'), { sku: 'LAMP', name: 'Desk lamp', available: 2 });
  deliveredOrder(s, 'bob', { LAMP: 2 });
});

test('responses for returns never expose the owner', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  const r = expect(requestReturn(s, s.alice, order.id, [{ lineId: order.lines[0].id, qty: 1, reason: 'other' }]), 201);
  const body = JSON.stringify(expect(s.call('GET', `/returns/${r.id}`, s.alice), 200));
  assert.equal(body.includes('ownerUserId'), false);
  assert.equal(body.includes(s.aliceId), false);
});
