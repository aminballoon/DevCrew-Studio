import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, level, payOrder, placeOrder, shop } from './helpers.ts';

test('a customer builds and places an order; lines merge per product', () => {
  const s = shop();
  const order = expect(s.call('POST', '/orders', s.alice, {}), 201);
  assert.equal(order.status, 'draft');
  assert.equal(order.number, 'SO-1001');
  expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.MUG, qty: 1 }), 201);
  const merged = expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.MUG, qty: 2 }), 201);
  assert.equal(merged.lines.length, 1);
  assert.equal(merged.lines[0].qty, 3);
  expect(s.call('PUT', `/orders/${order.id}/shipping-address`, s.alice, { addressId: s.aliceAddress }), 200);
  const placed = expect(s.call('POST', `/orders/${order.id}/place`, s.alice), 200);
  assert.equal(placed.status, 'placed');
  assert.deepEqual(placed.amounts, { subtotalCents: 3600, discountCents: 0, taxCents: 360, shippingCents: 500, totalCents: 4460 });
});

test('line amounts: tax per line on the net amount, shipping free from $50 of goods', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 2, TEA: 3, BOOK: 1 });
  const byS = Object.fromEntries(order.lines.map((l: { sku: string; amounts: unknown }) => [l.sku, l.amounts]));
  assert.deepEqual(byS.MUG, { grossCents: 2400, discountCents: 0, netCents: 2400, taxCents: 240, totalCents: 2640 });
  assert.deepEqual(byS.TEA, { grossCents: 2550, discountCents: 0, netCents: 2550, taxCents: 128, totalCents: 2678 });
  assert.deepEqual(byS.BOOK, { grossCents: 2500, discountCents: 0, netCents: 2500, taxCents: 0, totalCents: 2500 });
  assert.deepEqual(order.amounts, { subtotalCents: 7450, discountCents: 0, taxCents: 368, shippingCents: 0, totalCents: 7818 });
});

test('a coupon discount is spread over lines by their gross amount', () => {
  const s = shop();
  expect(s.call('POST', '/coupons', s.staff, { code: 'save10', kind: 'percent', value: 1000 }), 201);
  const order = placeOrder(s, 'alice', { MUG: 2, TEA: 1 }, { coupon: 'SAVE10' });
  assert.equal(order.couponCode, 'SAVE10');
  assert.deepEqual(order.lines.map((l: { amounts: { discountCents: number } }) => l.amounts.discountCents), [240, 85]);
  assert.deepEqual(order.amounts, { subtotalCents: 3250, discountCents: 325, taxCents: 216 + 38, shippingCents: 500, totalCents: 2925 + 254 + 500 });
});

test('coupons: minimum, expiry and max uses', () => {
  const s = shop();
  expect(s.call('POST', '/coupons', s.staff, { code: 'BIG', kind: 'fixed', value: 500, minSubtotalCents: 5000 }), 201);
  expect(s.call('POST', '/coupons', s.staff, { code: 'ONCE', kind: 'fixed', value: 100, maxUses: 1 }), 201);
  expect(s.call('POST', '/coupons', s.staff, { code: 'OLD', kind: 'fixed', value: 100, expiresAt: '2030-02-01T00:00:00Z' }), 201);
  const order = expect(s.call('POST', '/orders', s.alice, {}), 201);
  expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.MUG, qty: 1 }), 201);
  expect(s.call('PUT', `/orders/${order.id}/coupon`, s.alice, { code: 'BIG' }), 400);
  expect(s.call('PUT', `/orders/${order.id}/coupon`, s.alice, { code: 'OLD' }), 400);
  expect(s.call('PUT', `/orders/${order.id}/coupon`, s.alice, { code: 'NOPE' }), 404);
  placeOrder(s, 'bob', { MUG: 1 }, { coupon: 'ONCE' });
  expect(s.call('PUT', `/orders/${order.id}/coupon`, s.alice, { code: 'ONCE' }), 409);
});

test('placing freezes catalog prices; later price changes do not touch the order', () => {
  const s = shop();
  const order = expect(s.call('POST', '/orders', s.alice, {}), 201);
  expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.MUG, qty: 1 }), 201);
  expect(s.call('PATCH', `/products/${s.products.MUG}`, s.staff, { priceCents: 1500 }), 200);
  expect(s.call('PUT', `/orders/${order.id}/shipping-address`, s.alice, { addressId: s.aliceAddress }), 200);
  const placed = expect(s.call('POST', `/orders/${order.id}/place`, s.alice), 200);
  assert.equal(placed.lines[0].unitPriceCents, 1500);
  expect(s.call('PATCH', `/products/${s.products.MUG}`, s.staff, { priceCents: 9999 }), 200);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).lines[0].unitPriceCents, 1500);
});

test('only drafts can be edited', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  const res = expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.TEA, qty: 1 }), 409);
  assert.equal(res.error.code, 'invalid_state');
});

test('the full lifecycle is recorded in the order history', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  assert.deepEqual(order.history.map((h: { status: string }) => h.status), ['draft', 'placed', 'paid', 'shipped', 'delivered']);
  assert.ok(order.deliveredAt);
  assert.equal(level(s, 'MUG', s.w1).onHand, 9);
  assert.equal(level(s, 'MUG', s.w1).reserved, 0);
});

test('cancelling a placed order releases stock and the coupon use', () => {
  const s = shop();
  const coupon = expect(s.call('POST', '/coupons', s.staff, { code: 'ONCE', kind: 'fixed', value: 100, maxUses: 1 }), 201);
  const order = placeOrder(s, 'alice', { MUG: 3 }, { coupon: 'ONCE' });
  assert.equal(expect(s.call('GET', `/coupons/${coupon.id}`, s.staff), 200).uses, 1);
  const cancelled = expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, { reason: 'changed my mind' }), 200);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, 'changed my mind');
  assert.equal(level(s, 'MUG', s.w1).reserved, 0);
  assert.equal(expect(s.call('GET', `/coupons/${coupon.id}`, s.staff), 200).uses, 0);
});

test('cancelling a paid order refunds it in full', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  payOrder(s, 'alice', order.id);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.staff, {}), 200);
  const [payment] = expect(s.call('GET', `/orders/${order.id}/payments`, s.alice), 200);
  assert.equal(payment.refundedCents, order.amounts.totalCents);
  assert.equal(s.app.services.gateway.refunds[0].amountCents, order.amounts.totalCents);
});

test('shipped and delivered orders cannot be cancelled', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.staff, {}), 409);
});

test('staff list orders newest first with pagination; customers only see their own', () => {
  const s = shop();
  for (let i = 0; i < 3; i++) { placeOrder(s, 'alice', { TEA: 1 }); s.clock.advance(60_000); }
  placeOrder(s, 'bob', { TEA: 1 });
  const page = expect(s.call('GET', '/orders', s.staff, undefined, { limit: '3' }), 200);
  assert.deepEqual(page.items.map((o: { number: string }) => o.number), ['SO-1004', 'SO-1003', 'SO-1002']);
  const next = expect(s.call('GET', '/orders', s.staff, undefined, { limit: '3', cursor: page.nextCursor }), 200);
  assert.deepEqual(next.items.map((o: { number: string }) => o.number), ['SO-1001']);
  assert.equal(next.nextCursor, null);
  assert.equal(expect(s.call('GET', '/orders', s.bob), 200).items.length, 1);
});
