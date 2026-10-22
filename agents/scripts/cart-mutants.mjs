// Scripted fast run with the mutation check. The Builder's cart rejects a price of 0, which the
// requirement allows (">= 0"); QA's first suite only tries -1, so every test passes. The mutation
// check turns "<= 0" into "< 0" and the hidden tests still pass: QA is shown that change, adds a
// test for a price of 0, the test fails on the Builder's code, and the Builder fixes it.
import base from './cart.mjs';

const [first, complete] = base.turns['dev:main'];
const full = complete.files['src/cart.ts'];
const zeroRejected = full.replace('unitPriceCents < 0) throw', 'unitPriceCents <= 0) throw');
if (zeroRejected === full) { throw new Error('cart-mutants: the price check in cart.mjs changed'); }

const BOUNDARIES = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../../src/cart.ts';

test('R-1 a price of 0 cents is allowed', () => {
  const c = new Cart();
  c.addItem('FREE', 0);
  assert.equal(c.subtotal(), 0);
});

test('R-2 removing exactly the quantity removes the line', () => {
  const c = new Cart();
  c.addItem('A', 100, 2);
  c.removeItem('A', 2);
  assert.deepEqual(c.items(), []);
});
`;

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [
      base.turns.qa[0],
      {
        thinking: 'Checking each change the tests missed against the requirement…\n\n',
        files: { 'acceptance/cart-core/boundaries.test.ts': BOUNDARIES },
        message: 'QA_ANSWER: Added 2 tests, a price of 0 cents (R-1) and removing exactly the quantity (R-2); skipped none.',
      },
    ],
    'dev:main': [
      first,
      { ...complete, files: { ...complete.files, 'src/cart.ts': zeroRejected } },
      {
        thinking: 'A hidden test says a price of 0 must be allowed…',
        files: { 'src/cart.ts': full },
        message: 'Prices of 0 cents are allowed now, as the requirement says (>= 0).',
      },
    ],
  },
};
