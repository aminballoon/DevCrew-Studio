import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.ts';

test('adds items and sums the subtotal in cents', () => {
  const c = new Cart();
  c.addItem('A', 250, 2);
  c.addItem('B', 99);
  assert.equal(c.subtotal(), 599);
  assert.deepEqual(c.items(), [{ sku: 'A', unitPriceCents: 250, qty: 2 }, { sku: 'B', unitPriceCents: 99, qty: 1 }]);
});

test('adding an existing SKU increases its quantity', () => {
  const c = new Cart();
  c.addItem('A', 100, 1);
  c.addItem('A', 100, 3);
  assert.deepEqual(c.items(), [{ sku: 'A', unitPriceCents: 100, qty: 4 }]);
});

test('adding an existing SKU at another price throws', () => {
  const c = new Cart();
  c.addItem('A', 100);
  assert.throws(() => c.addItem('A', 120), Error);
});

test('rejects invalid prices and quantities with RangeError', () => {
  const c = new Cart();
  for (const [price, qty] of [[-1, 1], [1.5, 1], [100, 0], [100, -2], [100, 1.5]]) {
    assert.throws(() => c.addItem('X', price, qty), RangeError, `price ${price} qty ${qty}`);
  }
  assert.equal(c.items().length, 0);
});

test('free items are allowed', () => {
  const c = new Cart();
  c.addItem('GIFT', 0, 1);
  assert.equal(c.subtotal(), 0);
});

test('removes part of a line, the whole line, or more than present', () => {
  const c = new Cart();
  c.addItem('A', 100, 5);
  c.removeItem('A', 2);
  assert.equal(c.subtotal(), 300);
  c.removeItem('A', 99);
  assert.deepEqual(c.items(), []);
  c.addItem('B', 10, 3);
  c.removeItem('B');
  assert.deepEqual(c.items(), []);
});

test('removing an unknown SKU throws', () => {
  assert.throws(() => new Cart().removeItem('nope'), Error);
});

test('SAVE10 rounds the discount down to whole cents', () => {
  const c = new Cart();
  c.addItem('A', 1999);
  c.applyDiscount('SAVE10');
  assert.equal(c.total(), 1800);
});

test('FLAT5 applies from exactly 2000 cents', () => {
  const below = new Cart();
  below.addItem('A', 1999);
  below.applyDiscount('FLAT5');
  assert.equal(below.total(), 1999);
  const at = new Cart();
  at.addItem('A', 2000);
  at.applyDiscount('FLAT5');
  assert.equal(at.total(), 1500);
});

test('the last discount code wins', () => {
  const c = new Cart();
  c.addItem('A', 3000);
  c.applyDiscount('FLAT5');
  c.applyDiscount('SAVE10');
  assert.equal(c.total(), 2700);
});

test('discount follows later cart changes', () => {
  const c = new Cart();
  c.addItem('A', 1000, 3);
  c.applyDiscount('FLAT5');
  c.removeItem('A', 2);
  assert.equal(c.total(), 1000);
});

test('unknown discount codes throw', () => {
  const c = new Cart();
  c.addItem('A', 100);
  assert.throws(() => c.applyDiscount('FREE100'), Error);
});

test('total of an empty cart is 0', () => {
  assert.equal(new Cart().total(), 0);
});
