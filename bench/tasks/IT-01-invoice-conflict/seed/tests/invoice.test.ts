import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTHB, invoiceTotal } from '../src/invoice.ts';

test('empty invoice', () => {
  assert.deepEqual(invoiceTotal([]), { net: 0, vat: 0, gross: 0 });
});

test('single line', () => {
  assert.deepEqual(invoiceTotal([{ sku: 'A', qty: 2, unitPrice: 5000 }]), { net: 10000, vat: 700, gross: 10700 });
});

test('VAT is rounded per line', () => {
  assert.deepEqual(invoiceTotal([{ sku: 'A', qty: 1, unitPrice: 35 }, { sku: 'B', qty: 1, unitPrice: 35 }]), { net: 70, vat: 4, gross: 74 });
});

test('small lines', () => {
  assert.deepEqual(invoiceTotal([{ sku: 'A', qty: 1, unitPrice: 5 }, { sku: 'B', qty: 1, unitPrice: 5 }]), { net: 10, vat: 1, gross: 11 });
});

test('invalid lines throw', () => {
  assert.throws(() => invoiceTotal([{ sku: 'A', qty: 0, unitPrice: 1 }]), RangeError);
  assert.throws(() => invoiceTotal([{ sku: 'A', qty: 1, unitPrice: -1 }]), RangeError);
});

test('formats baht', () => {
  assert.equal(formatTHB(123456), '฿1,234.56');
  assert.equal(formatTHB(5), '฿0.05');
});
