import assert from 'node:assert/strict';

import { createEngine, PricingError } from '../src/index.ts';

export const CATALOG = [
  { sku: 'LAT', name: 'Latte', category: 'coffee', price: 6500 },
  { sku: 'AME', name: 'Americano', category: 'coffee', price: 5500 },
  { sku: 'CRO', name: 'Croissant', category: 'bakery', price: 4500 },
  { sku: 'CKY', name: 'Cookie', category: 'bakery', price: 150 },
  { sku: 'WAT', name: 'Water', category: 'drinks', price: 2000 },
];

export const engine = (extra: Record<string, unknown> = {}) => createEngine({ catalog: CATALOG, promotions: [], ...extra });

export function throwsCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof PricingError && (e as PricingError).code === code, `expected PricingError ${code}`);
}

export const pick = (r: any) => ({ subtotal: r.subtotal, discountTotal: r.discountTotal, tax: r.tax, total: r.total });
