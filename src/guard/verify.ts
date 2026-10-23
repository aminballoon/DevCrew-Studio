import { spawn } from 'node:child_process';
import { childEnv } from '../core/env';
import type { TestCounts } from '../core/events';
import { hashFiles, takeSnapshot } from './snapshot';
import { declaredIn, parseTestOutput, TEST_FORMATS } from './testFormats';

export interface CommandResult { code: number; output: string; timedOut: boolean }

export function runCommand(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<CommandResult> {
  return new Promise(resolve => {
    const proc = spawn(command, { cwd, shell: true, env: childEnv({ CI: '1', NO_COLOR: '1' }) });
    let output = '';
    const collect = (d: Buffer) => { output = (output + d).slice(-200_000); };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, output: output.replace(ANSI, ''), timedOut }); });
  });
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Summary counts from a test run's output, in any supported format (see testFormats.ts). */
export function parseTestCounts(raw: string, formats?: string[]): TestCounts {
  return parseTestOutput(raw.replace(ANSI, ''), formats).tests;
}

/** Test cases declared in the locked test files (any supported language), counted without running them. */
export function countDeclaredTests(workspace: string, prefix = 'tests/'): number {
  let n = 0;
  for (const [path, content] of takeSnapshot(workspace)) {
    if (path.startsWith(prefix)) { n += declaredIn(path, content.toString('utf8')); }
  }
  return n;
}

export interface TestBaseline {
  /** sha256 of every locked file when QA handed over. */
  hashes: Record<string, string>;
  /** Test cases QA declared; fewer running means some never loaded. */
  declared: number;
}

export const LOCKED_PREFIXES = ['tests/', 'contracts/'];

export function captureBaseline(workspace: string): TestBaseline {
  return { hashes: hashFiles(workspace, LOCKED_PREFIXES), declared: countDeclaredTests(workspace) };
}

export interface Check { name: string; command: string }

export interface VerifyResult {
  passed: boolean;
  tests: TestCounts;
  reasons: string[];
  output: string;
  /** Which test output format the counts were read from. */
  format?: string | null;
  /** For the Builder: the clause and QA's reason behind each failing hidden test. */
  context?: string;
}

/**
 * The non-AI judge. Passing means: locked files untouched, every declared test ran,
 * none failed or were skipped, and every extra check (typecheck, lint, ...) exited 0.
 */
export async function verify(opts: {
  workspace: string;
  testCommand: string;
  baseline: TestBaseline;
  /** Declared tests expected to run with this command (defaults to all). */
  expectedTests?: number;
  checks?: Check[];
  /** Test output formats to read (plan.json testFormats); found automatically when empty. */
  testFormats?: string[];
}): Promise<VerifyResult> {
  const reasons: string[] = [];

  // Every file QA handed over must be unchanged and present. New files under tests/ are build
  // output of the test command itself (a compiled test binary, a cache): agents cannot create
  // them, because the scope guard reverts any file an agent adds there after its turn.
  const now = hashFiles(opts.workspace, LOCKED_PREFIXES);
  const tampered = Object.keys(opts.baseline.hashes).filter(p => now[p] !== opts.baseline.hashes[p]);
  if (tampered.length) { reasons.push(`Locked files changed: ${tampered.join(', ')}`); }

  const run = await runCommand(opts.testCommand, opts.workspace);
  const { tests, format } = parseTestOutput(run.output, opts.testFormats);
  const expected = opts.expectedTests ?? opts.baseline.declared;
  if (run.timedOut) { reasons.push('Test command timed out'); }
  if (!format && expected > 0) {
    reasons.push(`No test results found in the output (${opts.testFormats?.length ? `expected ${opts.testFormats.join(', ')}` : `supported: ${TEST_FORMATS.join(', ')}`})`);
  }
  if (tests.fail > 0) { reasons.push(`${tests.fail} of ${tests.total} tests failed`); }
  if (tests.skipped > 0) { reasons.push(`${tests.skipped} tests skipped`); }
  if (tests.total < expected) { reasons.push(`Only ${tests.total} of ${expected} declared tests ran`); }
  if (run.code !== 0 && reasons.length === 0) { reasons.push(`Test command exited with ${run.code}`); }

  let output = run.output;
  for (const check of opts.checks ?? []) {
    const r = await runCommand(check.command, opts.workspace);
    if (r.code !== 0) {
      reasons.push(`Check "${check.name}" failed`);
      output += `\n\n--- ${check.name} ---\n${r.output}`;
    }
  }
  return { passed: reasons.length === 0, tests, reasons, output: output.slice(-12_000), format };
}
