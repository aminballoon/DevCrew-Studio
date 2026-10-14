// Scripted fast-arch run where the design does not fit: the Builder's first answer asks the
// Architect to let util use the cart (ARCH_CHANGE). The Architect changes the design, it is
// approved, and the Builder carries on inside the new version.
import fast from './cart-fast.mjs';

const [design] = fast.turns.architect;
const changed = JSON.parse(design.files['.devcrew/architecture.json']);
changed.modules.find(m => m.id === 'util').mayUse = ['cart'];
changed.modules.find(m => m.id === 'cart').mayUse = [];
changed.decisions.push({ id: 'ADR-2', title: 'Cart helpers in util', decision: 'util may build carts; the cart no longer uses util.', why: 'The Builder needed a cart factory next to the other helpers.' });

export default {
  ...fast,
  turns: {
    ...fast.turns,
    architect: [design, { ...design, files: { ...design.files, '.devcrew/architecture.json': JSON.stringify(changed) }, message: 'util may now use the cart (ADR-2).' }],
    'dev:main': [
      { ...fast.turns['dev:main'][0], message: 'The cart builds, but a cart factory belongs in util.\nARCH_CHANGE: let util use the cart, so helpers can build carts.' },
      // Keeps the cart factory, which the new design allows, and adds the discount codes
      { ...fast.turns['dev:main'][1], files: { 'src/cart.ts': fast.turns['dev:main'][1].files['src/cart.ts'] } },
    ],
  },
};
