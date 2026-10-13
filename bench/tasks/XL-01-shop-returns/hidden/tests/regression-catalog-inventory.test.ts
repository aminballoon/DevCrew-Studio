import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allocate, percentOf } from '../src/index.ts';
import { expect, level, placeOrder, shop } from './helpers.ts';

test('money: allocate keeps the exact total and favours larger remainders', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(10, [2400, 850]), [7, 3]);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocate(7, [0, 0]), [7, 0]);
  assert.equal(percentOf(1250, 1000), 125);
  assert.equal(percentOf(425, 1000), 43);
});

test('staff create products; skus are unique and upper-cased', () => {
  const s = shop();
  const p = expect(s.call('POST', '/products', s.staff, { sku: 'cup-2', name: 'Cup', priceCents: 300 }), 201);
  assert.equal(p.sku, 'CUP-2');
  assert.equal(p.taxCategory, 'standard');
  expect(s.call('POST', '/products', s.staff, { sku: 'CUP-2', name: 'Again', priceCents: 1 }), 409);
  const bad = expect(s.call('POST', '/products', s.staff, { sku: 'X', name: 'Cup', priceCents: 1.5 }), 400);
  assert.equal(bad.error.code, 'validation_failed');
});

test('customers cannot write the catalog and do not see inactive products', () => {
  const s = shop();
  expect(s.call('POST', '/products', s.alice, { sku: 'NOPE', name: 'x', priceCents: 1 }), 403);
  expect(s.call('POST', `/products/${s.products.LAMP}/deactivate`, s.staff), 200);
  expect(s.call('GET', `/products/${s.products.LAMP}`, s.alice), 404);
  assert.deepEqual(expect(s.call('GET', '/products', s.alice), 200).map((p: { sku: string }) => p.sku), ['BOOK', 'MUG', 'TEA']);
  assert.equal(expect(s.call('GET', '/products', s.staff), 200).length, 4);
});

test('stock levels per warehouse, in shipping order', () => {
  const s = shop();
  const levels = expect(s.call('GET', '/inventory/MUG', s.staff), 200);
  assert.deepEqual(levels.map((l: { warehouseId: string; onHand: number }) => [l.warehouseId, l.onHand]), [[s.w1, 10], [s.w2, 10]]);
  expect(s.call('GET', '/inventory/MUG', s.alice), 403);
});

test('adjustments need a reason and cannot go below what is reserved', () => {
  const s = shop();
  placeOrder(s, 'alice', { LAMP: 2 });
  expect(s.call('POST', '/inventory/adjust', s.staff, { sku: 'LAMP', warehouseId: s.w1, qty: -1 }), 400);
  expect(s.call('POST', '/inventory/adjust', s.staff, { sku: 'LAMP', warehouseId: s.w1, qty: -2, reason: 'damage' }), 409);
  const l = expect(s.call('POST', '/inventory/adjust', s.staff, { sku: 'LAMP', warehouseId: s.w1, qty: -1, reason: 'damage' }), 200);
  assert.deepEqual([l.onHand, l.reserved, l.available], [2, 2, 0]);
});

test('placing an order reserves stock from warehouses in shipping order', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 12 });
  assert.deepEqual(order.lines[0].fulfilment, [{ warehouseId: s.w1, qty: 10 }, { warehouseId: s.w2, qty: 2 }]);
  assert.deepEqual(level(s, 'MUG', s.w1), { ...level(s, 'MUG', s.w1), onHand: 10, reserved: 10, available: 0 });
  assert.equal(level(s, 'MUG', s.w2).reserved, 2);
});

test('the movement history explains the stock level', () => {
  const s = shop();
  const order = placeOrder(s, 'alice', { MUG: 12 });
  const moves = expect(s.call('GET', '/inventory/MUG/movements', s.staff), 200);
  assert.deepEqual(moves.map((m: { kind: string }) => m.kind), ['receive', 'receive', 'reserve', 'reserve']);
  assert.ok(moves.slice(2).every((m: { ref: string }) => m.ref === order.id));
  const w1 = moves.filter((m: { warehouseId: string }) => m.warehouseId === s.w1);
  const sum = (k: string) => w1.reduce((n: number, m: Record<string, number>) => n + m[k], 0);
  assert.deepEqual([sum('onHandDelta'), sum('reservedDelta')], [10, 10]);
});

test('not enough stock: nothing is reserved', () => {
  const s = shop();
  const order = expect(s.call('POST', '/orders', s.alice, {}), 201);
  expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.TEA, qty: 2 }), 201);
  expect(s.call('POST', `/orders/${order.id}/lines`, s.alice, { productId: s.products.LAMP, qty: 4 }), 201);
  expect(s.call('PUT', `/orders/${order.id}/shipping-address`, s.alice, { addressId: s.aliceAddress }), 200);
  expect(s.call('POST', `/orders/${order.id}/place`, s.alice), 409);
  assert.equal(level(s, 'TEA', s.w1).reserved, 0);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'draft');
});

test('low-stock report lists active products under the threshold, fewest first', () => {
  const s = shop();
  placeOrder(s, 'alice', { LAMP: 2 });
  const rows = expect(s.call('GET', '/reports/low-stock', s.staff, undefined, { threshold: '6' }), 200);
  assert.deepEqual(rows, [{ sku: 'LAMP', name: 'Desk lamp', available: 1 }, { sku: 'BOOK', name: 'Cookbook', available: 5 }]);
});
