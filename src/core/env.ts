/**
 * Environment for processes we start (agents, test commands).
 * Drops variables that change how child tools report: FORCE_COLOR puts ANSI codes in test
 * output, and NODE_TEST_CONTEXT (set when we run under node --test) makes a nested
 * `node --test` report to its parent instead of printing results.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.FORCE_COLOR;
  delete env.NODE_TEST_CONTEXT;
  return env;
}
