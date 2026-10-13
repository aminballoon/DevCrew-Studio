import assert from 'node:assert/strict';

import { createApp, ManualClock } from '../src/index.ts';
import type { App, Response } from '../src/index.ts';

export const START = '2030-03-01T10:00:00.000Z';

export type Call = (method: string, path: string, token?: string | null, body?: unknown, query?: Record<string, string>) => Response;

export function client(app: App): Call {
  return (method, path, token, body, query) =>
    app.handle({ method, path, headers: token ? { authorization: `Bearer ${token}` } : {}, body, query });
}

/** Asserts the status and returns the body. */
export function expect(res: Response, status: number): any {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export interface Shop {
  app: App;
  clock: ManualClock;
  call: Call;
  admin: string;
  staff: string;
  staffId: string;
  alice: string;
  aliceId: string;
  aliceCustomer: string;
  aliceAddress: string;
  bob: string;
  bobId: string;
  bobCustomer: string;
  bobAddress: string;
  /** W1 ships first (priority 1), then W2 (priority 2). */
  w1: string;
  w2: string;
  /** Products by sku: MUG 1200 standard, TEA 850 reduced, BOOK 2500 exempt, LAMP 4999 standard. */
  products: Record<string, string>;
}

/**
 * A shop with an admin, a staff member, two customers with an address each, two
 * warehouses and four products. Stock: MUG 10@W1 + 10@W2, TEA 50@W1, BOOK 5@W2, LAMP 3@W1.
 */
export function shop(): Shop {
  const clock = new ManualClock(START);
  const app = createApp({ clock });
  const call = client(app);
  const { token: admin } = app.bootstrap('admin@shop.test', 'Ada Admin');

  const staffUser = expect(call('POST', '/users', admin, { email: 'sam@shop.test', name: 'Sam Staff', role: 'staff' }), 201);
  const staff = app.tokenFor(staffUser.id);

  const a = expect(call('POST', '/signup', null, { email: 'alice@example.com', name: 'Alice' }), 201);
  const b = expect(call('POST', '/signup', null, { email: 'bob@example.com', name: 'Bob' }), 201);
  const aliceCustomer = expect(call('GET', '/customers/me', a.token), 200).id;
  const bobCustomer = expect(call('GET', '/customers/me', b.token), 200).id;
  const address = { line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'us' };
  const aliceAddress = expect(call('POST', `/customers/${aliceCustomer}/addresses`, a.token, address), 201).addresses[0].id;
  const bobAddress = expect(call('POST', `/customers/${bobCustomer}/addresses`, b.token, address), 201).addresses[0].id;

  const w1 = expect(call('POST', '/warehouses', admin, { code: 'w1', name: 'North', priority: 1 }), 201).id;
  const w2 = expect(call('POST', '/warehouses', admin, { code: 'w2', name: 'South', priority: 2 }), 201).id;

  const products: Record<string, string> = {};
  for (const [sku, name, priceCents, taxCategory] of [
    ['MUG', 'Mug', 1200, 'standard'],
    ['TEA', 'Green tea', 850, 'reduced'],
    ['BOOK', 'Cookbook', 2500, 'exempt'],
    ['LAMP', 'Desk lamp', 4999, 'standard'],
  ] as const) {
    products[sku] = expect(call('POST', '/products', staff, { sku, name, priceCents, taxCategory }), 201).id;
  }
  for (const [sku, warehouseId, qty] of [['MUG', w1, 10], ['MUG', w2, 10], ['TEA', w1, 50], ['BOOK', w2, 5], ['LAMP', w1, 3]] as const) {
    expect(call('POST', '/inventory/receive', staff, { sku, warehouseId, qty }), 200);
  }

  return {
    app, clock, call, admin, staff, staffId: staffUser.id,
    alice: a.token, aliceId: a.user.id, aliceCustomer, aliceAddress,
    bob: b.token, bobId: b.user.id, bobCustomer, bobAddress,
    w1, w2, products,
  };
}

/** A placed order for a customer: lines like `{ MUG: 2, TEA: 1 }`. */
export function placeOrder(s: Shop, who: 'alice' | 'bob', lines: Record<string, number>, opts: { coupon?: string } = {}): any {
  const token = s[who];
  const order = expect(s.call('POST', '/orders', token, {}), 201);
  for (const [sku, qty] of Object.entries(lines)) {
    expect(s.call('POST', `/orders/${order.id}/lines`, token, { productId: s.products[sku], qty }), 201);
  }
  expect(s.call('PUT', `/orders/${order.id}/shipping-address`, token, { addressId: who === 'alice' ? s.aliceAddress : s.bobAddress }), 200);
  if (opts.coupon) { expect(s.call('PUT', `/orders/${order.id}/coupon`, token, { code: opts.coupon }), 200); }
  return expect(s.call('POST', `/orders/${order.id}/place`, token), 200);
}

export function payOrder(s: Shop, who: 'alice' | 'bob', orderId: string): any {
  return expect(s.call('POST', `/orders/${orderId}/payments`, s[who], { cardToken: 'tok_visa' }), 201);
}

/** Placed, paid, shipped by staff and delivered. Returns the delivered order. */
export function deliveredOrder(s: Shop, who: 'alice' | 'bob', lines: Record<string, number>, opts: { coupon?: string } = {}): any {
  const placed = placeOrder(s, who, lines, opts);
  payOrder(s, who, placed.id);
  const shipment = expect(s.call('POST', `/orders/${placed.id}/shipments`, s.staff, { carrier: 'ups', trackingNumber: `1Z${placed.id}` }), 201);
  expect(s.call('POST', `/shipments/${shipment.id}/deliver`, s.staff), 200);
  return expect(s.call('GET', `/orders/${placed.id}`, s[who]), 200);
}

export function level(s: Shop, sku: string, warehouseId: string): { onHand: number; reserved: number; available: number } {
  const levels = expect(s.call('GET', `/inventory/${sku}`, s.staff), 200);
  return levels.find((l: { warehouseId: string }) => l.warehouseId === warehouseId);
}

/** Requests a return as `who` (a token) and returns the response. */
export function requestReturn(s: Shop, token: string, orderId: string, lines: { lineId: string; qty: number; reason: string }[], note?: string): Response {
  return s.call('POST', `/orders/${orderId}/returns`, token, note === undefined ? { lines } : { lines, note });
}

export function lineOf(order: { lines: { sku: string }[] }, sku: string): any {
  return order.lines.find(l => l.sku === sku);
}

export function payment(s: Shop, orderId: string): any {
  return expect(s.call('GET', `/orders/${orderId}/payments`, s.staff), 200).find((p: { status: string }) => p.status === 'captured');
}
