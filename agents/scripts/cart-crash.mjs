// Harness test: the Planner leaves a long-running command behind (marker from FAKE_MARKER),
// then Dev's agent process dies mid-turn, so the run fails before its finish step.
import base from './cart.mjs';

const marker = process.env.FAKE_MARKER ?? 'sleep 3333';

export default {
  ...base,
  turns: {
    ...base.turns,
    planner: base.turns.planner.map(t => ({ ...t, background: marker })),
    'dev:cart-core': [{ crash: true }],
  },
};
