import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatMoney } from '../src/index.ts';
import { CATALOG, engine, pick, throwsCode } from './helpers.ts';

test('r1: a plain line, with VAT included', () => {
  const r = engine().price({ lines: [{ sku: 'LAT', qty: 2 }] });
  assert.equal(r.currency, 'THB');
  assert.deepEqual(r.lines, [{ sku: 'LAT', name: 'Latte', qty: 2, unitPrice: 6500, amount: 13000, discount: 0, net: 13000, taxRate: 7, tax: 850 }]);
  assert.deepEqual(pick(r), { subtotal: 13000, discountTotal: 0, tax: 850, total: 13000 });
  assert.deepEqual(r.discounts, []);
});

test('r1: modifiers add to the unit price', () => {
  const r = engine().price({ lines: [{ sku: 'LAT', qty: 1, modifiers: [{ name: 'oat milk', price: 1500 }, { name: 'extra shot', price: 1000 }] }] });
  assert.deepEqual([r.lines[0].unitPrice, r.lines[0].amount, r.lines[0].tax], [9000, 9000, 589]);
});

test('r1: percentOff by category, one line each', () => {
  const e = engine({ promotions: [{ id: 'P10', type: 'percentOff', category: 'coffee', percent: 10 }, { id: 'B20', type: 'percentOff', category: 'bakery', percent: 20 }] });
  const r = e.price({ lines: [{ sku: 'LAT', qty: 1 }, { sku: 'CRO', qty: 3 }, { sku: 'WAT', qty: 1 }] });
  assert.deepEqual(r.lines.map((l: any) => [l.discount, l.net, l.tax]), [[650, 5850, 383], [2700, 10800, 707], [0, 2000, 131]]);
  assert.deepEqual(pick(r), { subtotal: 22000, discountTotal: 3350, tax: 1221, total: 18650 });
  assert.deepEqual(r.discounts, [{ promotionId: 'P10', sku: 'LAT', line: 0, amount: 650 }, { promotionId: 'B20', sku: 'CRO', line: 1, amount: 2700 }]);
});

test('r1: a line gets only its best promotion; ties go to the smaller id', () => {
  const best = engine({ promotions: [{ id: 'A', type: 'percentOff', category: 'coffee', percent: 10 }, { id: 'B', type: 'percentOff', category: 'coffee', percent: 15 }] });
  assert.deepEqual(best.price({ lines: [{ sku: 'AME', qty: 1 }] }).discounts, [{ promotionId: 'B', sku: 'AME', line: 0, amount: 825 }]);
  const tie = engine({ promotions: [{ id: 'Z', type: 'percentOff', category: 'coffee', percent: 10 }, { id: 'Y', type: 'percentOff', category: 'coffee', percent: 10 }] });
  assert.equal(tie.price({ lines: [{ sku: 'AME', qty: 1 }] }).discounts[0].promotionId, 'Y');
});

test('r1: rounding is half up', () => {
  const e = engine({ promotions: [{ id: 'C1', type: 'percentOff', category: 'bakery', percent: 1 }] });
  assert.equal(e.price({ lines: [{ sku: 'CKY', qty: 1 }] }).lines[0].discount, 2);
});

test('r1: invalid orders', () => {
  const e = engine();
  throwsCode(() => e.price({ lines: [{ sku: 'NOPE', qty: 1 }] }), 'UNKNOWN_SKU');
  for (const qty of [0, 1000, 1.5, '2']) throwsCode(() => e.price({ lines: [{ sku: 'LAT', qty }] }), 'INVALID_QTY');
  throwsCode(() => e.price({ lines: [{ sku: 'LAT', qty: 1, modifiers: [{ name: 'x', price: -1 }] }] }), 'INVALID_ORDER');
  throwsCode(() => e.price({ lines: 'LAT' }), 'INVALID_ORDER');
});

test('r1: invalid configs', () => {
  throwsCode(() => engine({ catalog: [...CATALOG, CATALOG[0]] }), 'INVALID_CONFIG');
  throwsCode(() => engine({ catalog: [{ sku: 'X', name: 'X', category: 'c', price: -1 }] }), 'INVALID_CONFIG');
  for (const percent of [0, 101, 2.5]) throwsCode(() => engine({ promotions: [{ id: 'P', type: 'percentOff', category: 'coffee', percent }] }), 'INVALID_CONFIG');
  throwsCode(() => engine({ promotions: [{ id: 'P', type: 'percentOff', category: 'coffee', percent: 5 }, { id: 'P', type: 'percentOff', category: 'bakery', percent: 5 }] }), 'INVALID_CONFIG');
  throwsCode(() => engine({ promotions: [{ id: 'P', type: 'mystery', category: 'coffee', percent: 5 }] }), 'INVALID_CONFIG');
});

test('r1: formatMoney in baht', () => {
  assert.equal(formatMoney(123450, 'THB'), '฿1,234.50');
  assert.equal(formatMoney(5, 'THB'), '฿0.05');
  assert.equal(formatMoney(0, 'THB'), '฿0.00');
  assert.equal(formatMoney(100000000, 'THB'), '฿1,000,000.00');
});
