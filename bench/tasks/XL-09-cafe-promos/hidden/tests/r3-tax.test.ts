import { test } from 'node:test';
import assert from 'node:assert/strict';

import { engine, pick, throwsCode } from './helpers.ts';

test('r3: the default store is inclusive at 7% and lists its tax', () => {
  const r = engine().price({ lines: [{ sku: 'LAT', qty: 2 }] });
  assert.deepEqual(r.taxes, [{ rate: 7, taxable: 13000, tax: 850 }]);
});

test('r3: inclusive with rates per category', () => {
  const e = engine({ tax: { mode: 'inclusive', rates: { default: 7, byCategory: { drinks: 0, bakery: 10 } } } });
  const r = e.price({ lines: [{ sku: 'LAT', qty: 1 }, { sku: 'CRO', qty: 2 }, { sku: 'WAT', qty: 1 }] });
  assert.deepEqual(r.lines.map((l: any) => [l.taxRate, l.tax]), [[7, 425], [10, 818], [0, 0]]);
  assert.deepEqual(r.taxes, [{ rate: 0, taxable: 2000, tax: 0 }, { rate: 7, taxable: 6500, tax: 425 }, { rate: 10, taxable: 9000, tax: 818 }]);
  assert.deepEqual(pick(r), { subtotal: 17500, discountTotal: 0, tax: 1243, total: 17500 });
});

test('r3: exclusive adds tax on top, and cash rounds that total', () => {
  const e = engine({ tax: { mode: 'exclusive', rates: { default: 7 } } });
  const r = e.price({ payment: 'cash', lines: [{ sku: 'LAT', qty: 2 }] });
  assert.deepEqual([r.lines[0].tax, r.total, r.payable, r.rounding], [910, 13910, 13900, -10]);
});

test('r3: exclusive tax is on the discounted amount, half up', () => {
  const e = engine({ tax: { mode: 'exclusive', rates: { default: 7 } }, promotions: [{ id: 'P10', type: 'percentOff', category: 'coffee', percent: 10 }] });
  const r = e.price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual([r.lines[0].net, r.lines[0].tax, r.total], [5850, 410, 6260]);
});

test('r3: bad tax config', () => {
  for (const tax of [{ mode: 'vat', rates: { default: 7 } }, { mode: 'inclusive', rates: { default: 31 } }, { mode: 'inclusive', rates: { default: -1 } }, { mode: 'exclusive', rates: { default: 7, byCategory: { coffee: 7.5 } } }, { mode: 'inclusive' }]) {
    throwsCode(() => engine({ tax }), 'INVALID_CONFIG');
  }
});
