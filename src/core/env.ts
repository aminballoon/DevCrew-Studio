import { delimiter, join } from 'node:path';
import { STUDIO_ROOT } from './config';

/**
 * Environment for processes we start (agents, test commands).
 * Drops variables that change how child tools report: FORCE_COLOR puts ANSI codes in test
 * output, and NODE_TEST_CONTEXT (set when we run under node --test) makes a nested
 * `node --test` report to its parent instead of printing results.
 * Adds agents/bin at the end of PATH for tools agents expect but this machine may lack.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // Last on PATH, so only commands the machine lacks (timeout on macOS) come from agents/bin
  env.PATH = [env.PATH, join(STUDIO_ROOT, 'agents', 'bin')].filter(Boolean).join(delimiter);
  delete env.FORCE_COLOR;
  delete env.NODE_TEST_CONTEXT;
  return env;
}
