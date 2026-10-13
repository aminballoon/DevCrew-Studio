import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliveredOrder, expect, payment, placeOrder, requestReturn, shop } from './helpers.ts';
import type { Shop } from './helpers.ts';

/** Issues a gift card and has `who` redeem it; returns the code. */
function giveCredit(s: Shop, who: 'alice' | 'bob', amountCents: number): string {
  const card = expect(s.call('POST', '/gift-cards', s.staff, { amountCents }), 201);
  expect(s.call('POST', '/customers/me/credit/redeem', s[who], { code: card.code }), 200);
  return card.code;
}

const credit = (s: Shop, who: 'alice' | 'bob') => expect(s.call('GET', '/customers/me/credit', s[who]), 200);

/** MUG 1 = 1200 + 120 tax + 500 shipping = 1820. */
function placedMug(s: Shop) {
  return placeOrder(s, 'alice', { MUG: 1 });
}

test('staff issue gift cards with a random 16-character code', () => {
  const s = shop();
  const a = expect(s.call('POST', '/gift-cards', s.staff, { amountCents: 2500 }), 201);
  const b = expect(s.call('POST', '/gift-cards', s.admin, { amountCents: 2500 }), 201);
  assert.match(a.code, /^[A-Z0-9]{16}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(a.amountCents, 2500);
  for (const amountCents of [0, 100_001, 12.5, '10']) {
    expect(s.call('POST', '/gift-cards', s.staff, { amountCents }), 400);
  }
  expect(s.call('POST', '/gift-cards', s.alice, { amountCents: 100 }), 403);
});

test('a customer redeems a gift card once into their store credit', () => {
  const s = shop();
  const card = expect(s.call('POST', '/gift-cards', s.staff, { amountCents: 2500 }), 201);
  const after = expect(s.call('POST', '/customers/me/credit/redeem', s.alice, { code: card.code.toLowerCase() }), 200);
  assert.equal(after.balanceCents, 2500);
  assert.deepEqual(after.entries.map((e: { kind: string; amountCents: number }) => [e.kind, e.amountCents]), [['gift_card', 2500]]);
  expect(s.call('POST', '/customers/me/credit/redeem', s.bob, { code: card.code }), 409);
  expect(s.call('POST', '/customers/me/credit/redeem', s.alice, { code: card.code }), 409);
  expect(s.call('POST', '/customers/me/credit/redeem', s.bob, { code: 'AAAAAAAAAAAAAAAA' }), 404);
  assert.equal(credit(s, 'bob').balanceCents, 0);
  assert.equal(credit(s, 'alice').balanceCents, 2500);
});

test("store credit is private: other customers get 404, staff can look", () => {
  const s = shop();
  giveCredit(s, 'alice', 700);
  expect(s.call('GET', `/customers/${s.aliceCustomer}/credit`, s.bob), 404);
  assert.equal(expect(s.call('GET', `/customers/${s.aliceCustomer}/credit`, s.staff), 200).balanceCents, 700);
  assert.equal(expect(s.call('GET', `/customers/${s.aliceCustomer}/credit`, s.alice), 200).balanceCents, 700);
});

test('paying with part store credit, part card', () => {
  const s = shop();
  giveCredit(s, 'alice', 1000);
  const order = placedMug(s);
  const p = expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa', useCreditCents: 1000 }), 201);
  assert.deepEqual([p.amountCents, p.creditCents, p.cardCents], [1820, 1000, 820]);
  assert.deepEqual(s.app.services.gateway.charges.map(c => c.amountCents), [820]);
  const c = credit(s, 'alice');
  assert.equal(c.balanceCents, 0);
  assert.deepEqual(c.entries.at(-1), { ...c.entries.at(-1), kind: 'payment', amountCents: -1000, ref: p.id });
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'paid');
});

test('paying entirely with store credit needs no card', () => {
  const s = shop();
  giveCredit(s, 'alice', 5000);
  const order = placedMug(s);
  const p = expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { useCreditCents: 1820 }), 201);
  assert.deepEqual([p.creditCents, p.cardCents], [1820, 0]);
  assert.equal(s.app.services.gateway.charges.length, 0);
  assert.equal(credit(s, 'alice').balanceCents, 3180);
});

test('a card-only payment shows zero credit', () => {
  const s = shop();
  const order = placedMug(s);
  const p = expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa' }), 201);
  assert.deepEqual([p.creditCents, p.cardCents], [0, 1820]);
});

test('store credit limits', () => {
  const s = shop();
  giveCredit(s, 'alice', 5000);
  const order = placedMug(s);
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa', useCreditCents: 1821 }), 400);
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa', useCreditCents: -1 }), 400);
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { useCreditCents: 1000 }), 400);
  const other = placeOrder(s, 'bob', { MUG: 1 });
  expect(s.call('POST', `/orders/${other.id}/payments`, s.bob, { cardToken: 'tok_visa', useCreditCents: 1 }), 409);
  assert.equal(credit(s, 'alice').balanceCents, 5000);
  assert.equal(s.app.services.gateway.charges.length, 0, 'no card is charged when the request is refused');
});

test('a declined card takes nothing from store credit', () => {
  const s = shop();
  giveCredit(s, 'alice', 1000);
  const order = placedMug(s);
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_declined', useCreditCents: 1000 }), 402);
  assert.equal(credit(s, 'alice').balanceCents, 1000);
  assert.equal(expect(s.call('GET', `/orders/${order.id}`, s.alice), 200).status, 'placed');
});

test('refunds go to the card first, the rest back to store credit', () => {
  const s = shop();
  giveCredit(s, 'alice', 1000);
  const order = placedMug(s);
  const p = expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa', useCreditCents: 1000 }), 201);
  const after = expect(s.call('POST', `/payments/${p.id}/refunds`, s.staff, { amountCents: 900, reason: 'late' }), 201);
  assert.deepEqual([after.refunds[0].toCardCents, after.refunds[0].toCreditCents], [820, 80]);
  assert.deepEqual(s.app.services.gateway.refunds.map(r => r.amountCents), [820]);
  assert.equal(credit(s, 'alice').balanceCents, 80);
  const again = expect(s.call('POST', `/payments/${p.id}/refunds`, s.staff, { amountCents: 100, reason: 'later' }), 201);
  assert.deepEqual([again.refunds[1].toCardCents, again.refunds[1].toCreditCents], [0, 100]);
  assert.equal(s.app.services.gateway.refunds.length, 1);
  assert.equal(again.refundedCents, 1000);
  const c = credit(s, 'alice');
  assert.equal(c.balanceCents, 180);
  assert.deepEqual(c.entries.slice(-2).map((e: { kind: string; amountCents: number; ref: string }) => [e.kind, e.amountCents, e.ref]), [['refund', 80, p.id], ['refund', 100, p.id]]);
});

test('cancelling an order paid partly with credit gives both parts back', () => {
  const s = shop();
  giveCredit(s, 'alice', 1000);
  const order = placedMug(s);
  expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa', useCreditCents: 1000 }), 201);
  expect(s.call('POST', `/orders/${order.id}/cancel`, s.alice, {}), 200);
  assert.deepEqual(s.app.services.gateway.refunds.map(r => r.amountCents), [820]);
  assert.equal(credit(s, 'alice').balanceCents, 1000);
  const report = expect(s.call('GET', '/reports/sales', s.staff, undefined, { from: '2030-03-01', to: '2030-03-01' }), 200);
  assert.equal(report.totals.refundsCents, 1820);
});

test('returns can be refunded as store credit instead', () => {
  const s = shop();
  const order = deliveredOrder(s, 'alice', { MUG: 3 });
  const line = order.lines[0].id;
  expect(s.call('POST', `/orders/${order.id}/returns`, s.alice, { lines: [{ lineId: line, qty: 1, reason: 'other' }], refundTo: 'cash' }), 400);
  const plain = expect(requestReturn(s, s.alice, order.id, [{ lineId: line, qty: 1, reason: 'other' }]), 201);
  assert.equal(plain.refundTo, 'original');
  const r = expect(s.call('POST', `/orders/${order.id}/returns`, s.alice, { lines: [{ lineId: line, qty: 1, reason: 'other' }], refundTo: 'store_credit' }), 201);
  assert.equal(r.refundTo, 'store_credit');
  const done = expect(s.call('POST', `/returns/${r.id}/approve`, s.staff, { lines: [{ lineId: line, condition: 'resellable' }] }), 200);
  assert.equal(done.refundCents, 1320);
  assert.equal(s.app.services.gateway.refunds.length, 0);
  assert.equal(credit(s, 'alice').balanceCents, 1320);
  const p = payment(s, order.id);
  assert.deepEqual([p.refundedCents, p.refunds[0].toCardCents, p.refunds[0].toCreditCents], [1320, 0, 1320]);
  expect(s.call('POST', `/returns/${plain.id}/approve`, s.staff, { lines: [{ lineId: line, condition: 'resellable' }] }), 200);
  assert.deepEqual(s.app.services.gateway.refunds.map(x => x.amountCents), [1320]);
});

test('the customer is told when money goes back to store credit', () => {
  const s = shop();
  giveCredit(s, 'alice', 1000);
  const order = placedMug(s);
  const p = expect(s.call('POST', `/orders/${order.id}/payments`, s.alice, { cardToken: 'tok_visa', useCreditCents: 1000 }), 201);
  expect(s.call('POST', `/payments/${p.id}/refunds`, s.staff, { amountCents: 820, reason: 'card only' }), 201);
  expect(s.call('POST', `/payments/${p.id}/refunds`, s.staff, { amountCents: 80, reason: 'credit' }), 201);
  const mails = expect(s.call('GET', '/notifications', s.admin, undefined, { orderId: order.id }), 200);
  assert.deepEqual(mails.filter((n: { template: string }) => n.template === 'credit_added').map((n: { subject: string }) => n.subject), ['$0.80 added to your store credit']);
  assert.equal(mails.filter((n: { template: string }) => n.template === 'refund_issued').length, 2);
});

test('gift card codes never leak into the audit log, emails or other responses', () => {
  const s = shop();
  const code = giveCredit(s, 'alice', 1000);
  const audit = expect(s.call('GET', '/audit', s.admin, undefined, { limit: '100' }), 200).items;
  assert.ok(audit.some((e: { action: string }) => e.action === 'gift_card.issued'));
  assert.ok(audit.some((e: { action: string }) => e.action === 'gift_card.redeemed'));
  assert.equal(JSON.stringify(audit).includes(code), false);
  assert.equal(JSON.stringify(expect(s.call('GET', '/notifications', s.admin), 200)).includes(code), false);
  assert.equal(JSON.stringify(credit(s, 'alice')).includes(code), false);
  assert.equal(JSON.stringify(expect(s.call('GET', `/customers/${s.aliceCustomer}/credit`, s.staff), 200)).includes(code), false);
});
