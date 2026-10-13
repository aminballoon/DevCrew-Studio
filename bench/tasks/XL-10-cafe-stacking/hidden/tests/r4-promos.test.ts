import { test } from 'node:test';
import assert from 'node:assert/strict';

import { engine, throwsCode } from './helpers.ts';

const B2G1 = { id: 'B2G1', type: 'buyXgetY', sku: 'CRO', buy: 2, get: 1 };
const HH = { id: 'HH', type: 'happyHour', category: 'coffee', percent: 50, from: '14:00', to: '16:00' };

test('r4: buy X get Y free, per complete group', () => {
  const e = engine({ promotions: [B2G1] });
  assert.equal(e.price({ lines: [{ sku: 'CRO', qty: 7 }] }).lines[0].discount, 9000);
  assert.equal(e.price({ lines: [{ sku: 'CRO', qty: 2 }] }).lines[0].discount, 0);
  assert.equal(e.price({ lines: [{ sku: 'CRO', qty: 3, modifiers: [{ name: 'butter', price: 500 }] }] }).lines[0].discount, 5000);
  assert.deepEqual(e.price({ lines: [{ sku: 'LAT', qty: 3 }, { sku: 'CRO', qty: 3 }] }).discounts, [{ promotionId: 'B2G1', sku: 'CRO', line: 1, amount: 4500 }]);
});

test('r4: the best promotion wins across types', () => {
  const e = engine({ promotions: [B2G1, { id: 'B20', type: 'percentOff', category: 'bakery', percent: 20 }] });
  assert.equal(e.price({ lines: [{ sku: 'CRO', qty: 3 }] }).discounts[0].promotionId, 'B2G1');
  assert.equal(e.price({ lines: [{ sku: 'CRO', qty: 2 }] }).discounts[0].promotionId, 'B20');
});

test('r4: happy hour depends on the order time', () => {
  const e = engine({ promotions: [HH, { id: 'P10', type: 'percentOff', category: 'coffee', percent: 10 }] });
  const at = (t?: string) => e.price({ lines: [{ sku: 'LAT', qty: 1 }], ...(t ? { at: t } : {}) }).discounts[0].promotionId;
  assert.equal(at('2030-05-01T14:00'), 'HH');
  assert.equal(at('2030-05-01T15:59:59'), 'HH');
  assert.equal(at('2030-05-01T16:00'), 'P10');
  assert.equal(at('2030-05-01T13:59'), 'P10');
  assert.equal(at(), 'P10');
});

test('r4: a tie across types goes to the smaller id', () => {
  const e = engine({ promotions: [{ ...HH, id: 'A', percent: 10 }, { id: 'B', type: 'percentOff', category: 'coffee', percent: 10 }] });
  assert.equal(e.price({ lines: [{ sku: 'LAT', qty: 1 }], at: '2030-05-01T15:00' }).discounts[0].promotionId, 'A');
});

test('r4: bad new promotions', () => {
  for (const p of [{ ...B2G1, sku: 'NOPE' }, { ...B2G1, buy: 0 }, { ...B2G1, get: 1.5 }, { ...HH, from: '16:00', to: '14:00' }, { ...HH, to: '25:00' }, { ...HH, percent: 0 }]) {
    throwsCode(() => engine({ promotions: [p] }), 'INVALID_CONFIG');
  }
  throwsCode(() => engine({ promotions: [B2G1, { ...HH, id: 'B2G1' }] }), 'INVALID_CONFIG');
});
