// Scripted fast run where the Builder's cart is right but its package.json declares lodash. The
// requirement says "No dependencies" (R-14): Verify, not a hidden test, sends it back, and the
// Builder removes the dependency.
import base from './cart.mjs';

const [first, complete] = base.turns['dev:main'];
const withDeps = JSON.stringify({ name: 'cart', type: 'module', dependencies: { lodash: '^4.17.21' } }, null, 2);
const without = JSON.stringify({ name: 'cart', type: 'module' }, null, 2);

export default {
  ...base,
  turns: {
    ...base.turns,
    'dev:main': [
      { ...first, files: { ...first.files, 'src/cart.ts': complete.files['src/cart.ts'], 'src/util/carts.ts': complete.files['src/util/carts.ts'], 'package.json': withDeps } },
      { thinking: 'The requirement says no dependencies…', files: { 'package.json': without }, message: 'Removed lodash from package.json; nothing used it.' },
    ],
  },
};
