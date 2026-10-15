/**
 * Evolution report: how each arm holds up over consecutive change requests, and where its
 * runs went wrong, so the pipeline can be improved. Writes bench/results/<suite>/REPORT.md.
 *
 *   npx tsx bench/runner/evolution-report.ts --suite <name>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { STUDIO_ROOT } from '../../src/core/config';
import type { DevcrewEvent } from '../../src/core/events';
import { countDeclaredTests } from '../../src/guard/verify';
import { takeSnapshot } from '../../src/guard/snapshot';
import { getBus } from '../../src/orchestrator/runtime';

interface Result {
  task: string; arm: string; rep: number; runId: string; status: string; resolved: boolean; continues?: string;
  hidden: { pass: number; total: number; declared: number };
  regression?: { pass: number; total: number };
  tests?: Record<string, boolean>;
  tokens: { total: number; byRole: Record<string, number> };
  costUsd: number; wallMs: number; fixIterations: number; guardViolations: number;
}

const { values } = parseArgs({ options: { suite: { type: 'string' } } });
if (!values.suite) { console.error('Usage: npx tsx bench/runner/evolution-report.ts --suite <name>'); process.exit(1); }
const dir = join(STUDIO_ROOT, 'bench', 'results', values.suite);
const results = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Result);

// Round order follows the "continues" chain
const tasks = [...new Set(results.map(r => r.task))];
const roundOf = (task: string): number => {
  const r = results.find(x => x.task === task);
  return r?.continues ? roundOf(r.continues) + 1 : 1;
};
tasks.sort((a, b) => roundOf(a) - roundOf(b));
const arms = [...new Set(results.map(r => r.arm))].sort();
const get = (task: string, arm: string) => results.find(r => r.task === task && r.arm === arm && r.rep === 1);

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`);
const min = (ms: number) => `${Math.round(ms / 60_000)} min`;

function workspace(events: DevcrewEvent[]): string {
  const s = events.find(e => e.type === 'run_started');
  return s?.type === 'run_started' ? s.workspace : '';
}

/**
 * Size and shape of the code an arm leaves behind: lines and files of source, the largest
 * file, the share of source lines inside blocks of 5+ lines that appear more than once
 * (copy-paste), and the number of tests it keeps in tests/.
 */
function codeStats(ws: string) {
  if (!ws || !existsSync(ws)) { return null; }
  const files: string[][] = [];
  for (const [path, buf] of takeSnapshot(ws)) {
    if (path.startsWith('src/') && path.endsWith('.ts')) { files.push(buf.toString('utf8').split('\n')); }
  }
  const srcLines = files.reduce((n, f) => n + f.length, 0);
  const largest = Math.max(0, ...files.map(f => f.length));
  // Meaningful lines only: blank lines, lone braces and imports say nothing about duplication
  const meaningful = files.map(f => f.map(l => l.trim()).filter(l => l.length > 3 && !/^[{}()[\];,]+$/.test(l) && !l.startsWith('import ')));
  const WINDOW = 5;
  const seen = new Map<string, number>();
  for (const f of meaningful) {
    for (let i = 0; i + WINDOW <= f.length; i++) { const key = f.slice(i, i + WINDOW).join('\n'); seen.set(key, (seen.get(key) ?? 0) + 1); }
  }
  let duplicated = 0, total = 0;
  for (const f of meaningful) {
    const dup = new Array(f.length).fill(false);
    for (let i = 0; i + WINDOW <= f.length; i++) {
      if ((seen.get(f.slice(i, i + WINDOW).join('\n')) ?? 0) > 1) { for (let j = i; j < i + WINDOW; j++) { dup[j] = true; } }
    }
    duplicated += dup.filter(Boolean).length;
    total += f.length;
  }
  return { srcLines, srcFiles: files.length, largest, duplicatedPct: total ? Math.round((duplicated / total) * 100) : 0, ownTests: countDeclaredTests(ws, 'tests/') };
}

/** Time and tokens per pipeline step, from the event log. */
function stages(events: DevcrewEvent[]) {
  const out: { node: string; ms: number; tokens: number }[] = [];
  let open: { node: string; ts: number; tokens: number } | null = null;
  for (const e of events) {
    if (e.type === 'node_started') {
      if (open) { out.push({ node: open.node, ms: e.ts - open.ts, tokens: open.tokens }); }
      open = { node: e.module ? `${e.node}:${e.module}` : e.node, ts: e.ts, tokens: 0 };
    } else if (e.type === 'usage' && open) {
      open.tokens += e.totalTokens;
    } else if ((e.type === 'node_finished' || e.type === 'run_finished') && open) {
      out.push({ node: open.node, ms: e.ts - open.ts, tokens: open.tokens });
      open = null;
    }
  }
  return out;
}

/** What went wrong in a run, in words a pipeline author can act on. */
function problems(r: Result, events: DevcrewEvent[]): string[] {
  const p: string[] = [];
  const end = events.findLast(e => e.type === 'run_finished');
  if (end?.type === 'run_finished' && end.status === 'failed') { p.push(`Run failed: ${end.error ?? 'unknown'}`); }
  const timeouts = events.filter(e => e.type === 'log' && e.level === 'error' && /timed out/i.test(e.message)).length;
  if (timeouts) { p.push(`${timeouts} agent turn(s) timed out`); }
  const failedVerifies = events.filter(e => e.type === 'verify_result' && !e.passed);
  for (const v of failedVerifies) {
    if (v.type === 'verify_result') { p.push(`Verify failed for ${v.module} (attempt ${v.attempt}): ${v.reasons.slice(0, 2).join('; ')}`); }
  }
  const guards = events.filter(e => e.type === 'guard_violation');
  for (const g of guards) {
    if (g.type === 'guard_violation') { p.push(`${g.role} wrote outside its scope (${g.action}): ${g.files.slice(0, 3).join(', ')}${g.files.length > 3 ? ` +${g.files.length - 3}` : ''}`); }
  }
  for (const e of events) {
    if (e.type === 'agent_output') {
      for (const f of e.files) {
        if (/\.devcrew\/(review|security)\.md$/.test(f.path) && f.content && /VERDICT:\s*changes/i.test(f.content)) {
          p.push(`${f.path.replace('.devcrew/', '')} asked for changes`);
        }
      }
    }
  }
  // Dev's SPEC_ISSUE sends the run back to the Planner, which redoes QA and every module
  let devText = '';
  for (const e of events) {
    if (e.type === 'agent_text' && e.role === 'dev') { devText += e.text; }
    if (e.type === 'node_finished' && e.node === 'dev') {
      const issue = devText.match(/^SPEC_ISSUE:\s*(.+)$/m)?.[1];
      if (issue) { p.push(`Dev disputed a test (SPEC_ISSUE): ${issue.slice(0, 200)}`); }
      devText = '';
    }
  }
  if (r.regression && r.regression.pass < r.regression.total) { p.push(`Its own tests in tests/ fail: ${r.regression.pass}/${r.regression.total} pass`); }
  return p;
}

let md = `# Evolution report: ${values.suite}\n\n`;
md += `Each arm builds every round on top of what it left in the round before. The hidden tests of round *n* include every earlier round's, so a test that passed in round *n−1* and fails in round *n* is a **regression**: the change broke something that worked.\n\n`;

md += `## Hidden tests per round\n\n| Arm | ${tasks.map((_, i) => `R${i + 1}`).join(' | ')} | Regressions |\n|---|${tasks.map(() => '---|').join('')}---|\n`;
const regressionsOf = (arm: string) => tasks.slice(1).map((t, i) => {
  const before = get(tasks[i], arm)?.tests ?? {};
  const now = get(t, arm)?.tests ?? {};
  return Object.keys(now).filter(name => before[name] === true && now[name] === false);
});
for (const arm of arms) {
  const cells = tasks.map(t => {
    const r = get(t, arm);
    return r ? `${r.resolved ? '✅' : '❌'} ${r.hidden.pass}/${r.hidden.declared || r.hidden.total}` : '—';
  });
  md += `| ${arm} | ${cells.join(' | ')} | ${regressionsOf(arm).map(x => x.length).join(' → ') || '—'} |\n`;
}

md += `\n## Cost and code health per round\n\nA handoff round (marked ⇢) is done by one and the same agent on every arm's code, so its cost and result show how easy each arm's code is to extend.\n\n| Arm | Round | Tokens | Cost | Time | Own tests (pass/total) | Source lines (files) | Largest file | Duplicated |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const arm of arms) {
  tasks.forEach((t, i) => {
    const r = get(t, arm);
    if (!r) { return; }
    const stats = codeStats(workspace(getBus().read(r.runId)));
    const handoff = (r as Result & { ranAs?: string }).ranAs;
    md += `| ${arm} | R${i + 1}${handoff ? ` ⇢ ${handoff}` : ''} | ${k(r.tokens.total)} | $${r.costUsd.toFixed(2)} | ${min(r.wallMs)} | ${r.regression ? `${r.regression.pass}/${r.regression.total}` : '—'} | ${stats ? `${stats.srcLines} (${stats.srcFiles})` : '—'} | ${stats ? `${stats.largest} lines` : '—'} | ${stats ? `${stats.duplicatedPct}%` : '—'} |\n`;
  });
}

md += `\n## Diagnostics per run\n`;
for (const arm of arms) {
  const regs = regressionsOf(arm);
  tasks.forEach((t, i) => {
    const r = get(t, arm);
    if (!r) { return; }
    const events = getBus().read(r.runId);
    md += `\n### ${arm} · R${i + 1} (${t}) · ${r.status}${r.resolved ? ' · resolved' : ''}\n\n`;
    const st = stages(events);
    if (st.length > 1) {
      const replans = st.filter(x => x.node === 'planner').length - 1;
      md += `Steps (${st.length}${replans > 0 ? `, ${replans} replan${replans > 1 ? 's' : ''}` : ''}): ${st.map(s => `${s.node} ${min(s.ms)} / ${k(s.tokens)}`).join(' → ')}\n\n`;
    }
    const failing = Object.entries(r.tests ?? {}).filter(([, ok]) => !ok).map(([name]) => name);
    if (failing.length) { md += `Failing hidden tests (${failing.length}):\n${failing.map(n => `- ${n}`).join('\n')}\n\n`; }
    if (i > 0 && regs[i - 1].length) { md += `Regressions from R${i}: ${regs[i - 1].map(n => `\`${n}\``).join(', ')}\n\n`; }
    const p = problems(r, events);
    md += p.length ? `What went wrong:\n${p.map(x => `- ${x}`).join('\n')}\n` : `No problems recorded.\n`;
  });
}

const out = join(dir, 'REPORT.md');
writeFileSync(out, md);
console.log(`Wrote ${relative(STUDIO_ROOT, out)}`);
