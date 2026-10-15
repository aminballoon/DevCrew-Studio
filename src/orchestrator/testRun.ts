import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_FORMATS, type TestFormat } from '../guard/testFormats';

/** A text file in the workspace, cut to `max` characters; null when it does not exist. */
export function readText(workspace: string, rel: string, max = 20_000): string | null {
  const path = join(workspace, rel);
  return existsSync(path) ? readFileSync(path, 'utf8').slice(0, max) : null;
}

/** How to run a set of tests, as the fast pipeline's Builder or QA wrote it. */
export interface TestRun { testCommand: string; testFormats?: string[] }

/** A test run file (.devcrew/test.json, .devcrew/acceptance.json), validated. Throws with a message the agent can act on. */
export function readTestRun(workspace: string, rel: string): TestRun {
  const text = readText(workspace, rel);
  if (text === null) { throw new Error(`${rel} was not written`); }
  let raw: { testCommand?: unknown; testFormats?: unknown };
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${rel} is not valid JSON: ${(e as Error).message}`); }
  if (typeof raw.testCommand !== 'string' || !raw.testCommand.trim()) { throw new Error(`${rel} has no "testCommand"`); }
  const formats = Array.isArray(raw.testFormats) ? raw.testFormats.filter((f): f is TestFormat => TEST_FORMATS.includes(f as TestFormat)) : [];
  return { testCommand: raw.testCommand.trim(), ...(formats.length ? { testFormats: formats } : {}) };
}
