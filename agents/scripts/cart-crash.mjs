// Harness test: QA leaves a long-running command behind (marker from FAKE_MARKER) while the
// Builder's agent process dies mid-turn, so the run fails before its finish step.
import base from './cart.mjs';

const marker = process.env.FAKE_MARKER ?? 'sleep 3333';

export default {
  ...base,
  turns: {
    ...base.turns,
    qa: base.turns.qa.map(t => ({ ...t, background: marker })),
    'dev:main': [{ crash: true }],
  },
};
