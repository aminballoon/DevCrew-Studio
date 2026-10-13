import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, placeOrder, shop } from './helpers.ts';

test('every non-public route needs a valid token', () => {
  const s = shop();
  expect(s.call('GET', '/orders', null), 401);
  expect(s.call('GET', '/orders', 'not-a-token'), 401);
  assert.equal(s.call('GET', '/nowhere', s.alice).status, 404);
  assert.equal(s.call('DELETE', '/orders', s.alice).status, 405);
});

test("another customer's order is not found, for reading and for every action", () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  expect(s.call('GET', `/orders/${order.id}`, s.bob), 404);
  expect(s.call('GET', `/orders/${order.id}/payments`, s.bob), 404);
  expect(s.call('POST', `/orders/${order.id}/payments`, s.bob, { cardToken: 'tok_visa' }), 404);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.bob, {}), 404);
  expect(s.call('GET', `/orders/${order.id}/shipment`, s.bob), 404);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'placed');
});

test("customers cannot read other customers' profiles or add addresses to them", () => {
  const s = shop();
  expect(s.call('GET', `/customers/${s.aliceCustomer}`, s.bob), 404);
  expect(s.call('POST', `/customers/${s.aliceCustomer}/addresses`, s.bob, { line1: 'x', city: 'y', postalCode: '1', country: 'US' }), 404);
  expect(s.call('GET', `/customers/${s.aliceCustomer}`, s.staff), 200);
});

test("a customer cannot ship to someone else's address", () => {
  const s = shop();
  const order = expect(s.call('POST', '/orders', s.alice, {}), 201);
  expect(s.call('PUT', `/orders/${order.id}/shipping-address`, s.alice, { addressId: s.bobAddress }), 404);
});

test('staff create orders for a named customer; customers cannot pick one', () => {
  const s = shop();
  const order = expect(s.call('POST', '/orders', s.staff, { customerId: s.bobCustomer }), 201);
  assert.equal(order.customerId, s.bobCustomer);
  expect(s.call('GET', `/orders/${order.id}`, s.bob), 200);
  const own = expect(s.call('POST', '/orders', s.alice, { customerId: s.bobCustomer }), 201);
  assert.equal(own.customerId, s.aliceCustomer);
});

test('only staff ship and deliver', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 1 });
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa' }), 201);
  expect(s.call('POST', `/orders/${order.id}/shipments`, s.alice, { carrier: 'ups', trackingNumber: '1' }), 403);
});

test('deactivated users lose access at once', () => {
  const s = shop();
  expect(s.call('POST', `/users/${s.bobId}/deactivate`, s.admin), 200);
  expect(s.call('GET', '/orders', s.bob), 401);
  expect(s.call('POST', `/users/${s.bobId}/deactivate`, s.staff), 403);
});

test('API responses never expose internal fields', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 1 });
  assert.equal('ownerUserId' in order, false);
  assert.equal('createdBy' in order, false);
  const [payment] = expect(s.call('GET', `/orders/${order.id}/payments`, s.alice), 200);
  assert.equal('gatewayRef' in payment, false);
  assert.ok(payment.refunds.every((r: object) => !('gatewayRef' in r) && !('actor' in r)));
});

test('validation errors name the field', () => {
  const s = shop();
  const order = expect(s.call('POST', '/orders', s.alice, {}), 201);
  const res = expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.MUG, qty: 100 }), 400);
  assert.equal(res.error.field, 'qty');
});
