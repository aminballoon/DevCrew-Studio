import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, payOrder, placeOrder, shop } from './helpers.ts';

test('paying charges the order total and marks it paid', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  const payment = payOrder(s, 'alice', order.id);
  assert.equal(payment.status, 'captured');
  assert.equal(payment.amountCents, order.amounts.totalCents);
  assert.equal('gatewayRef' in payment, false);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'paid');
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa' }), 409);
});

test('a declined card records a failed payment and leaves the order placed', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  const res = expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_declined' }), 402);
  assert.equal(res.error.code, 'payment_failed');
  const payments = expect(s.call('GET', `/orders/${order.id}/payments`, s.alice), 200);
  assert.deepEqual(payments.map((p: { status: string }) => p.status), ['failed']);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'placed');
  payOrder(s, 'alice', order.id);
});

test('staff can refund part of a payment, never more than is left', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { LAMP: 1 });
  const [payment] = expect(s.call('GET', `/orders/${order.id}/payments`, s.staff), 200);
  const after = expect(s.call('POST', `/payments/${payment.id}/refunds`, s.staff, { amountCents: 1000, reason: 'scratched' }), 201);
  assert.equal(after.refundedCents, 1000);
  assert.equal(after.refunds[0].reason, 'scratched');
  expect(s.call('POST', `/payments/${payment.id}/refunds`, s.staff, { amountCents: payment.amountCents, reason: 'all' }), 400);
  expect(s.call('POST', `/payments/${payment.id}/refunds`, s.alice, { amountCents: 1, reason: 'me' }), 403);
});

test('refunds are not possible on unpaid or cancelled orders', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  const payment = payOrder(s, 'alice', order.id);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, {}), 200);
  expect(s.call('POST', `/payments/${payment.id}/refunds`, s.staff, { amountCents: 1, reason: 'x' }), 409);
});

test('a gateway outage fails the refund and changes nothing', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  const [payment] = expect(s.call('GET', `/orders/${order.id}/payments`, s.staff), 200);
  s.app.services.gateway.down = true;
  expect(s.call('POST', `/payments/${payment.id}/refunds`, s.staff, { amountCents: 100, reason: 'x' }), 402);
  s.app.services.gateway.down = false;
  assert.equal(expect(s.call('GET', `/orders/${order.id}/payments`, s.staff), 200)[0].refundedCents, 0);
});

test('sales report: sales on the day paid, refunds on the day refunded', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 2, TEA: 1 });
  s.clock.advanceDays(1);
  const [payment] = expect(s.call('GET', `/orders/${order.id}/payments`, s.staff), 200);
  expect(s.call('POST', `/payments/${payment.id}/refunds`, s.staff, { amountCents: 300, reason: 'late' }), 201);
  const report = expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-03-01', to: '2030-03-03' }), 200);
  assert.deepEqual(report.days.map((d: { day: string }) => d.day), ['2030-03-01', '2030-03-02', '2030-03-03']);
  assert.deepEqual(report.days[0], {
    day: '2030-03-01', orders: 1, grossCents: 3250, discountCents: 0, taxCents: 283, shippingCents: 500, refundsCents: 0, netCents: 4033,
  });
  assert.equal(report.days[1].refundsCents, 300);
  assert.equal(report.days[1].netCents, -300);
  assert.equal(report.totals.netCents, 3733);
  assert.deepEqual(report.topProducts, [{ sku: 'MUG', units: 2 }, { sku: 'TEA', units: 1 }]);
});

test('cancelled orders leave top products but their money stays visible', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  payOrder(s, 'alice', order.id);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, {}), 200);
  const report = expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-03-01', to: '2030-03-01' }), 200);
  assert.equal(report.totals.orders, 1);
  assert.equal(report.totals.refundsCents, order.amounts.totalCents);
  assert.equal(report.totals.netCents, 0);
  assert.deepEqual(report.topProducts, []);
});

test('reports need reports:read and a valid range', () => {
  const s = shop();
  expect(s.call('GET', '/reports/sales', s.alice, undefined, { from: '2030-03-01', to: '2030-03-01' }), 403);
  expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-03-02', to: '2030-03-01' }), 400);
  expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-01-01', to: '2030-06-01' }), 400);
});

test('every domain event lands in the audit log with its actor', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  const entries = expect(s.call('GET', '/audit', s.admin, undefined, { entity: 'order', entityId: order.id }), 200).items;
  assert.deepEqual(entries.map((e: { action: string }) => e.action),
    ['order.created', 'order.line_added', 'order.placed', 'order.paid', 'order.shipped', 'order.delivered']);
  assert.equal(entries[0].actor, s.aliceId);
  assert.equal(entries[4].actor, s.staffId);
  expect(s.call('GET', '/audit', s.staff), 403);
});

test('customers get emails for their order', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  payOrder(s, 'alice', order.id);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, { reason: 'oops' }), 200);
  const mails = expect(s.call('GET', '/notifications', s.admin, undefined, { orderId: order.id }), 200);
  assert.deepEqual(mails.map((n: { template: string }) => n.template), ['order_confirmation', 'refund_issued', 'order_cancelled']);
  assert.ok(mails.every((n: { to: string }) => n.to === 'alice@example.com'));
  assert.equal(mails[1].subject, `Refund of $18.20 for order ${order.number}`);
});
