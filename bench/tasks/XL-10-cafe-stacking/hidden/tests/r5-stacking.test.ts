import { test } from 'node:test';
import assert from 'node:assert/strict';

import { engine, throwsCode } from './helpers.ts';

const pct = (id: string, percent: number, extra: Record<string, unknown> = {}) => ({ id, type: 'percentOff', category: 'coffee', percent, ...extra });
const ds = (r: any) => r.discounts.map((d: any) => [d.promotionId, d.amount]);

test('r5: priority beats size', () => {
  const r = engine({ promotions: [pct('SMALL', 10, { priority: 1 }), pct('BIG', 50)] }).price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual(ds(r), [['SMALL', 650]]);
});

test('r5: stackable promotions apply in turn on what is left', () => {
  const r = engine({ promotions: [pct('S1', 10, { stackable: true }), pct('S2', 20, { stackable: true })] }).price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual(ds(r), [['S2', 1300], ['S1', 520]]);
  assert.deepEqual([r.lines[0].discount, r.lines[0].net], [1820, 4680]);
});

test('r5: a non-stackable first promotion stands alone', () => {
  const r = engine({ promotions: [pct('N', 50), pct('S', 10, { stackable: true })] }).price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual(ds(r), [['N', 3250]]);
});

test('r5: non-stackable ones are skipped behind a stackable first', () => {
  const r = engine({ promotions: [pct('S', 50, { stackable: true }), pct('N', 10), pct('S2', 5, { stackable: true })] }).price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual(ds(r), [['S', 3250], ['S2', 163]]);
  assert.equal(r.lines[0].net, 3087);
});

test('r5: stacking across types, and never below zero', () => {
  const e = engine({ promotions: [{ id: 'B2G1', type: 'buyXgetY', sku: 'CRO', buy: 2, get: 1, priority: 1, stackable: true }, { id: 'B20', type: 'percentOff', category: 'bakery', percent: 20, stackable: true }] });
  const r = e.price({ lines: [{ sku: 'CRO', qty: 3 }] });
  assert.deepEqual(ds(r), [['B2G1', 4500], ['B20', 1800]]);
  assert.equal(r.lines[0].net, 7200);
  const free = engine({ promotions: [pct('ALL', 100, { stackable: true }), pct('MORE', 60, { stackable: true })] }).price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual(ds(free), [['ALL', 6500]]);
  assert.deepEqual([free.lines[0].net, free.lines[0].tax, free.total], [0, 0, 0]);
});

test('r5: equal priority falls back to size, then id', () => {
  const r = engine({ promotions: [pct('B', 10, { priority: 2 }), pct('A', 10, { priority: 2 }), pct('C', 30, { priority: 1 })] }).price({ lines: [{ sku: 'LAT', qty: 1 }] });
  assert.deepEqual(ds(r), [['A', 650]]);
});

test('r5: bad priority or stackable', () => {
  throwsCode(() => engine({ promotions: [pct('P', 10, { priority: 1.5 })] }), 'INVALID_CONFIG');
  throwsCode(() => engine({ promotions: [pct('P', 10, { stackable: 'yes' })] }), 'INVALID_CONFIG');
});
