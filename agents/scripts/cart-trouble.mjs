// Scripted run where things go wrong, built on the cart script.
// Dev never gets "cart-core" right: every attempt forgets quantities, tries to weaken a
// test, and adds a helper file that is not in the approved architecture. After the
// configured number of attempts the run stops at the escalation gate for a human.
import base from './cart.mjs';

const firstTry = base.turns['dev:cart-core'][0];

const HELPERS = String.raw`// Not part of the approved design.
export function cents(value: number): string {
  return (value / 100).toFixed(2);
}
`;

export default {
  ...base,
  turns: {
    ...base.turns,
    'dev:cart-core': [{
      ...firstTry,
      thinking: 'Trying again with the same approach…\n\n',
      files: { ...firstTry.files, 'src/helpers.ts': HELPERS },
      message: 'Implemented Cart core (added a small helpers file).',
    }],
  },
};
