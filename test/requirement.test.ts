import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clauseList, requirementClauses } from '../src/orchestrator/requirement';

test('splits a requirement into sentence clauses, skipping headings', () => {
  const c = requirementClauses(`# Booking

Build a library. Everything is exported from \`src/index.ts\`.

## Rules
- \`title\` is trimmed and must be 1 to 100 characters; \`attendees\` is an integer. Otherwise \`ValidationError\`.
- Times like e.g. 10:00 are UTC. Use \`a.b. C\` as is.
`);
  assert.deepEqual(c.map(x => x.text), [
    'Build a library.',
    'Everything is exported from `src/index.ts`.',
    '`title` is trimmed and must be 1 to 100 characters; `attendees` is an integer.',
    'Otherwise `ValidationError`.',
    'Times like e.g. 10:00 are UTC.',
    'Use `a.b. C` as is.',
  ]);
  assert.deepEqual(c.map(x => x.id), ['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6']);
});

test('table rows and code blocks are whole clauses; table headers and tiny fragments are not', () => {
  const c = requirementClauses(`| Bytes | Field |
|---|---|
| 0 | version, must be \`1\` |
| 1–8 | timestamp in microseconds |

\`\`\`rust
pub fn decode(b: &[u8]) -> Frame;
\`\`\`
Ok.
- JPY: \`¥1,235\`
- \`PING\` → \`PONG\`
`);
  assert.deepEqual(c.map(x => x.text), [
    '| 0 | version, must be `1` |',
    '| 1–8 | timestamp in microseconds |',
    '```rust\npub fn decode(b: &[u8]) -> Frame;\n```',
    // Short, but examples: they are clauses
    'JPY: `¥1,235`',
    '`PING` → `PONG`',
  ]);
  assert.match(clauseList(c), /^R-1: \| 0 \|.*\nR-2: .*\nR-3: \n```rust/);
});
