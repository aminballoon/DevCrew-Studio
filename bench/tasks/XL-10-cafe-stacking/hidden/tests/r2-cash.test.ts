import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMoney } from '../src/index.ts';
import { engine, throwsCode } from './helpers.ts';

test('r2: store currency', () => {
  assert.equal(engine({ currency: 'JPY' }).price({ lines: [{ sku: 'WAT', qty: 1 }] }).currency, 'JPY');
  assert.equal(engine().price({ lines: [{ sku: 'WAT', qty: 1 }] }).currency, 'THB');
  throwsCode(() => engine({ currency: 'EUR' }), 'INVALID_CONFIG');
});

test('r2: formatMoney in every currency', () => {
  assert.equal(formatMoney(123450, 'USD'), '$1,234.50');
  assert.equal(formatMoney(1235, 'JPY'), '¥1,235');
  assert.equal(formatMoney(1250, 'KWD'), 'KWD 1.250');
  assert.equal(formatMoney(5, 'KWD'), 'KWD 0.005');
  assert.equal(formatMoney(-25, 'THB'), '-฿0.25');
  throwsCode(() => formatMoney(1, 'EUR'), 'INVALID_CONFIG');
});

test('r2: card pays the total', () => {
  const r = engine().price({ lines: [{ sku: 'LAT', qty: 1, modifiers: [{ name: 'syrup', price: 1012 }] }] });
  assert.deepEqual([r.payment, r.total, r.payable, r.rounding], ['card', 7512, 7512, 0]);
});

test('r2: cash rounds to the smallest coin', () => {
  const e = engine();
  const down = e.price({ payment: 'cash', lines: [{ sku: 'LAT', qty: 1, modifiers: [{ name: 'syrup', price: 1012 }] }] });
  assert.deepEqual([down.payment, down.payable, down.rounding], ['cash', 7500, -12]);
  const up = e.price({ payment: 'cash', lines: [{ sku: 'LAT', qty: 1, modifiers: [{ name: 'syrup', price: 1013 }] }] });
  assert.deepEqual([up.payable, up.rounding], [7525, 12]);
  const kwd = engine({ currency: 'KWD' });
  assert.equal(kwd.price({ payment: 'cash', lines: [{ sku: 'WAT', qty: 1, modifiers: [{ name: 'x', price: -0 + 2 }] }] }).payable, 2000);
  assert.equal(kwd.price({ payment: 'cash', lines: [{ sku: 'WAT', qty: 1, modifiers: [{ name: 'x', price: 3 }] }] }).payable, 2005);
  for (const c of ['USD', 'JPY']) assert.equal(engine({ currency: c }).price({ payment: 'cash', lines: [{ sku: 'WAT', qty: 1, modifiers: [{ name: 'x', price: 3 }] }] }).payable, 2003);
});

test('r2: unknown payment method', () => {
  throwsCode(() => engine().price({ payment: 'crypto', lines: [{ sku: 'WAT', qty: 1 }] }), 'INVALID_ORDER');
});
