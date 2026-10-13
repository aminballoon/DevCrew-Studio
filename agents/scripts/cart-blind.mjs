// Scripted blind-QA run: QA hands Dev only a small contract test and keeps the real tests in
// acceptance/. Dev's first try passes the contract test but fails a hidden one; it fixes the
// behaviour from the failure message alone.
import base from './cart.mjs';

const qa = base.turns.qa[0];
const contract = String.raw`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../../src/cart.ts';

test('contract: a cart takes items and lists them', () => {
  const c = new Cart();
  c.addItem('A', 100);
  assert.equal(c.items().length, 1);
});
`;

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: [{
      ...qa,
      files: {
        'tests/cart-core/contract.test.ts': contract,
        'acceptance/cart-core/cart.test.ts': qa.files['tests/cart-core/cart.test.ts'],
        'acceptance/discounts/discounts.test.ts': qa.files['tests/discounts/discounts.test.ts'],
      },
      message: 'Contract test in tests/cart-core; acceptance tests for AC-1..8 in acceptance/.',
    }],
    'dev:cart-core': [
      // Without the real tests, the first try only follows the contract and misses quantities
      { ...base.turns['dev:cart-core'][0], files: { 'src/cart.ts': base.turns['dev:cart-core'][0].files['src/cart.ts'] } },
      base.turns['dev:cart-core'][1],
    ],
  },
};
