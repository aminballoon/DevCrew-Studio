// One screen per suite for the tuning loop: how each arm did, where its time and tokens went,
// and what went wrong, so the next change targets the biggest waste.
// Usage: npx tsx bench/runner/loop-report.ts <suite> [<suite> ...]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, STUDIO_ROOT } from '../../src/core/config';
import type { DevcrewEvent } from '../../src/core/events';

interface Result {
  task: string; arm: string; rep: number; runId: string; status: string; resolved: boolean;
  hidden: { pass: number; total: number }; tokens: { total: number; byRole?: Record<string, number> };
  costUsd: number; wallMs: number; fixIterations?: number; guardViolations?: number;
}

const events = (runId: string): DevcrewEvent[] => {
  const file = join(runDir(runId), 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};

/** Minutes each role spent in agent turns, and Verify in running tests. */
function minutesByRole(ev: DevcrewEvent[]): Record<string, number> {
  // Per role, since the fast pipeline runs QA and the Builder at the same time
  const out: Record<string, number> = {};
  const open: Record<string, number> = {};
  const close = (role: string, ts: number) => {
    if (open[role] !== undefined) { out[role] = (out[role] ?? 0) + (ts - open[role]) / 60_000; delete open[role]; }
  };
  for (const e of ev) {
    if (e.type === 'agent_input') { open[e.role] = e.ts; }
    if (e.type === 'usage') { close(e.role, e.ts); }
    if (e.type === 'node_started' && e.node === 'verify') { open.verify = e.ts; }
    if (e.type === 'verify_result') { close('verify', e.ts); }
    if (e.type === 'node_started' && e.node === 'mutation') { open.mutation = e.ts; }
    if (e.type === 'mutation_result') { close('mutation', e.ts); }
  }
  return out;
}

/** Model calls and hidden thinking per role, from agents that report them. */
function callsByRole(ev: DevcrewEvent[]): Record<string, { calls: number; thought: number }> {
  const out: Record<string, { calls: number; thought: number }> = {};
  for (const e of ev) {
    if (e.type !== 'usage' || e.modelCalls === undefined) { continue; }
    const r = (out[e.role] ??= { calls: 0, thought: 0 });
    r.calls += e.modelCalls; r.thought += e.thoughtChars ?? 0;
  }
  return out;
}

/** What went wrong in a run, counted. */
function problems(ev: DevcrewEvent[]): string[] {
  const n = (f: (e: DevcrewEvent) => boolean) => ev.filter(f).length;
  const out: string[] = [];
  const failedVerifies = n(e => e.type === 'verify_result' && !e.passed);
  if (failedVerifies) { out.push(`${failedVerifies} failed verify`); }
  const disputes = n(e => e.type === 'node_started' && e.node === 'qa' && !!e.module && e.module !== 'mutants');
  if (disputes) { out.push(`${disputes} disputes`); }
  for (const e of ev) {
    if (e.type === 'mutation_result') { out.push(`mutation check ${e.check}: ${e.skipped ?? `${e.killed}/${e.tested} caught (${e.score}%), ${e.survived.length} missed, ${Math.round(e.ms / 1000)}s`}`); }
  }
  const strengthened = ev.findIndex(e => e.type === 'node_started' && e.node === 'qa' && e.module === 'mutants');
  if (strengthened >= 0) {
    const caught = ev.slice(strengthened).filter(e => e.type === 'verify_result' && !e.passed).length;
    out.push(caught ? `QA's added tests failed on the code ${caught} time(s): a bug the first tests missed` : "QA's added tests passed on the code");
  }
  const replans = n(e => e.type === 'node_started' && e.node === 'planner') - 1;
  if (replans > 0) { out.push(`${replans} replans`); }
  const fresh = n(e => e.type === 'log' && /starting a fresh session/.test(e.message));
  if (fresh) { out.push(`${fresh} fresh sessions`); }
  for (const e of ev) {
    if (e.type === 'log' && e.level === 'warn') { out.push(`warn: ${e.message.slice(0, 120)}`); }
    if (e.type === 'run_finished' && e.status === 'failed') { out.push(`FAILED: ${(e.error ?? '').slice(0, 160)}`); }
  }
  return out;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const m = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${Math.round(x / 1e3)}k`);

for (const suite of process.argv.slice(2)) {
  const dir = join(STUDIO_ROOT, 'bench/results', suite);
  const results: Result[] = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  console.log(`\n# ${suite}: ${results.length} runs\n`);
  console.log('arm                     resolved  hidden      tokens/run  $/run  min/run');
  for (const arm of [...new Set(results.map(r => r.arm))].sort()) {
    const rs = results.filter(r => r.arm === arm);
    const pass = rs.reduce((a, r) => a + r.hidden.pass, 0), total = rs.reduce((a, r) => a + r.hidden.total, 0);
    const avg = (f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(`${arm.padEnd(24)}${`${rs.filter(r => r.resolved).length}/${rs.length}`.padEnd(10)}${`${pass}/${total} ${pct(pass, total)}`.padEnd(12)}${m(avg(r => r.tokens.total)).padEnd(12)}${avg(r => r.costUsd).toFixed(2).padEnd(7)}${avg(r => r.wallMs / 60_000).toFixed(1)}`);
  }
  console.log('\nper run: tokens and minutes by role, then problems');
  for (const r of results.sort((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm))) {
    const ev = events(r.runId);
    const mins = minutesByRole(ev);
    const calls = callsByRole(ev);
    const roles = Object.entries(r.tokens.byRole ?? {}).map(([k, v]) => `${k} ${m(v)}/${(mins[k] ?? 0).toFixed(1)}m${calls[k] ? ` ${calls[k].calls} calls, ${m(calls[k].thought)} thought chars` : ''}`).join(', ');
    console.log(`- ${r.task} ${r.arm} #${r.rep} [${r.runId}] ${r.resolved ? 'RESOLVED' : r.status} ${r.hidden.pass}/${r.hidden.total} · ${m(r.tokens.total)} · ${(r.wallMs / 60_000).toFixed(1)}m${mins.verify ? ` · verify ${mins.verify.toFixed(1)}m` : ''}${mins.mutation ? ` · mutation ${mins.mutation.toFixed(1)}m` : ''}`);
    if (roles) { console.log(`    ${roles}`); }
    for (const p of problems(ev)) { console.log(`    ${p}`); }
  }
}
