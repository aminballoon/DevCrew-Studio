import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { STUDIO_ROOT } from '../../src/core/config';
import { usageByRole, type DevcrewEvent } from '../../src/core/events';
import { countDeclaredTests, parseTestCounts, runCommand } from '../../src/guard/verify';
import { RunManager } from '../../src/orchestrator/RunManager';
import { closeSessions, getBus } from '../../src/orchestrator/runtime';
import { runSingle } from '../../src/orchestrator/single';
import { guidePath } from '../../src/pipeline/schema';

interface Task {
  id: string; size: string; title: string; timeLimitMinutes: number; gradeCommand: string; regressionCommand?: string;
  /** Run after grading when some hidden tests pass; must print one line `PERF {json}`. */
  perfCommand?: string;
  /** Scripted agent profile that fits this task, used when running with --profile fake. */
  fakeProfile?: string;
}
interface Arm {
  id: string; mode: 'single' | 'pipeline'; process?: boolean; profile: string;
  /** Approved pipeline id (default standard). */
  pipeline?: string;
  /** Single arms only: role guides (pipelines/roles/<name>.md) given to the one agent. */
  guides?: string[];
}

const BENCH = join(STUDIO_ROOT, 'bench');
const USAGE = `Usage: npm run bench -- --tasks <id,...|all> --arms <id,...> [--reps N] [--profile name] [--suite name]

  --profile  override every arm's agent profile (e.g. "fake" to test the harness for free)
  --suite    results folder under bench/results (default: date + profile)
  --regrade  grade saved results again from their workspaces (after a grading fix); agents do not run`;

const { values } = parseArgs({
  options: {
    tasks: { type: 'string', default: 'all' },
    arms: { type: 'string', default: 'single-vanilla,single-process,multi-same' },
    reps: { type: 'string', default: '1' },
    profile: { type: 'string' },
    suite: { type: 'string' },
    regrade: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) { console.log(USAGE); process.exit(0); }

const taskIds = values.tasks === 'all' ? readdirSync(join(BENCH, 'tasks')) : values.tasks!.split(',');
const tasks = taskIds.map(id => ({ ...(JSON.parse(readFileSync(join(BENCH, 'tasks', id, 'task.json'), 'utf8')) as Task), id }));
const arms = values.arms!.split(',').map(id => JSON.parse(readFileSync(join(BENCH, 'arms', `${id}.json`), 'utf8')) as Arm);
const reps = Number(values.reps);
const suite = values.suite ?? `${new Date().toISOString().slice(0, 10)}-${values.profile ?? 'real'}`;
const outDir = join(BENCH, 'results', suite);
mkdirSync(outDir, { recursive: true });

// Randomized order, so slow periods or a draining quota do not land on one arm
const matrix = tasks.flatMap(task => arms.flatMap(arm => Array.from({ length: reps }, (_, i) => ({ task, arm, rep: i + 1 }))))
  .map(x => ({ x, k: Math.random() })).sort((a, b) => a.k - b.k).map(({ x }) => x);

const runs = new RunManager();
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Copy the hidden tests in only now, run them, and judge. */
async function grade(task: Task, workspace: string) {
  const hiddenSrc = join(BENCH, 'tasks', task.id, 'hidden', 'tests');
  // Start clean: a regrade must not count files an earlier grading left behind
  rmSync(join(workspace, 'hidden-tests'), { recursive: true, force: true });
  cpSync(hiddenSrc, join(workspace, 'hidden-tests'), { recursive: true });
  const declared = countDeclaredTests(workspace, 'hidden-tests/');
  const run = await runCommand(task.gradeCommand, workspace, 5 * 60_000);
  const hidden = parseTestCounts(run.output);
  let regression: { pass: number; total: number } | undefined;
  if (task.regressionCommand) {
    const r = parseTestCounts((await runCommand(task.regressionCommand, workspace)).output);
    regression = { pass: r.pass, total: r.total };
  }
  const resolved = hidden.fail === 0 && hidden.total >= declared && hidden.pass === hidden.total && (!regression || regression.pass === regression.total);
  return { hidden: { ...hidden, declared }, regression, resolved, output: run.output.slice(-4000) };
}

/** Run the task's performance probe 3 times and keep the median of each number. */
async function perf(task: Task, workspace: string) {
  if (!task.perfCommand) { return undefined; }
  // The probe lives apart from the graded tests, so it never counts as a hidden test
  const perfSrc = join(BENCH, 'tasks', task.id, 'hidden', 'perf');
  if (existsSync(perfSrc)) { cpSync(perfSrc, join(workspace, 'hidden-perf'), { recursive: true }); }
  const runs: Record<string, Record<string, number>>[] = [];
  for (let i = 0; i < 3; i++) {
    const out = (await runCommand(task.perfCommand, workspace, 5 * 60_000)).output;
    // Test harnesses print "test perf ... " on the same line before the probe's own output
    const json = out.match(/PERF (\{.*\})/)?.[1];
    if (json) { try { runs.push(JSON.parse(json)); } catch { /* unreadable run is skipped */ } }
  }
  if (!runs.length) { return { runs: 0 }; }
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const out: Record<string, Record<string, number>> = {};
  for (const [group, values] of Object.entries(runs[0])) {
    out[group] = Object.fromEntries(Object.keys(values).map(k => [k, median(runs.map(r => r[group]?.[k]).filter(v => typeof v === 'number'))]));
  }
  return { runs: runs.length, ...out };
}

function metrics(events: DevcrewEvent[]) {
  const usage = usageByRole(events);
  const all = Object.values(usage);
  const started = events.find(e => e.type === 'run_started')?.ts ?? 0;
  const ended = events.findLast(e => e.type === 'run_finished')?.ts ?? Date.now();
  const contextPeak = Math.max(0, ...events.flatMap(e => (e.type === 'usage' ? [e.contextUsed ?? 0] : [])));
  return {
    tokens: {
      total: all.reduce((n, u) => n + u.totalTokens, 0),
      input: all.reduce((n, u) => n + u.inputTokens, 0),
      output: all.reduce((n, u) => n + u.outputTokens, 0),
      cachedRead: all.reduce((n, u) => n + u.cachedReadTokens, 0),
      byRole: Object.fromEntries(Object.entries(usage).map(([r, u]) => [r, u.totalTokens])),
    },
    costUsd: all.reduce((n, u) => n + u.costUsd, 0),
    wallMs: ended - started,
    turns: events.filter(e => e.type === 'usage').length,
    fixIterations: events.filter(e => e.type === 'verify_result' && !e.passed).length,
    guardViolations: events.reduce((n, e) => n + (e.type === 'guard_violation' ? e.files.length : 0), 0),
    contextPeak,
  };
}

console.log(`Suite ${suite}: ${matrix.length} runs (${tasks.length} tasks × ${arms.length} arms × ${reps} reps)\n`);
const config = readFileSync(join(STUDIO_ROOT, 'devcrew.config.json'), 'utf8');
const prompts = readFileSync(join(STUDIO_ROOT, 'src/orchestrator/prompts.ts'), 'utf8');

/** Why a run stopped, when the vendor ran out of quota or rate-limited it; such a run says nothing about the arm. */
const QUOTA = /quota|rate[ -]?limit|\b429\b|resource[ _]exhausted|usage limit|too many requests|exceeded your|out of credits/i;
function quotaHit(events: DevcrewEvent[]): string | null {
  for (const e of events) {
    const text = e.type === 'run_finished' && e.status === 'failed' ? e.error ?? '' : e.type === 'log' && e.level === 'error' ? e.message : '';
    const m = text.match(QUOTA);
    if (m) { return text.split('\n').find(l => QUOTA.test(l))?.trim().slice(0, 160) ?? m[0]; }
  }
  return null;
}
/** A saved result that only failed for quota is run again. */
function savedAndValid(file: string): boolean {
  if (!existsSync(file)) { return false; }
  const r = JSON.parse(readFileSync(file, 'utf8')) as { resolved?: boolean; runId?: string; quotaLimited?: string };
  if (r.quotaLimited) { return false; }
  return r.resolved || !r.runId || !quotaHit(getBus().read(r.runId));
}
if (values.regrade) {
  for (const { task, arm, rep } of matrix) {
    const file = join(outDir, `${task.id}__${arm.id}__r${rep}.json`);
    if (!existsSync(file)) { continue; }
    const r = JSON.parse(readFileSync(file, 'utf8'));
    const started = getBus().read(r.runId).find(e => e.type === 'run_started');
    const workspace = started?.type === 'run_started' ? started.workspace : '';
    if (!workspace || !existsSync(workspace)) { console.log(`${task.id} ${arm.id} #${rep}: workspace gone, kept as is`); continue; }
    const before = `${r.resolved ? 'RESOLVED' : 'unresolved'} ${r.hidden.pass}/${r.hidden.total} (declared ${r.hidden.declared})`;
    const g = await grade(task, workspace);
    const p = g.hidden.pass > 0 ? await perf(task, workspace) : undefined;
    Object.assign(r, { resolved: g.resolved, hidden: g.hidden, regression: 'regression' in g ? g.regression : undefined, perf: p, gradeOutput: g.output, regradedAt: new Date().toISOString() });
    writeFileSync(file, JSON.stringify(r, null, 2));
    console.log(`${task.id} ${arm.id} #${rep}: ${before} → ${g.resolved ? 'RESOLVED' : 'unresolved'} ${g.hidden.pass}/${g.hidden.total} (declared ${g.hidden.declared})${p ? ` · perf ${JSON.stringify(p)}` : ''}`);
  }
  process.exit(0);
}

const QUOTA_WAIT_MIN = Number(process.env.BENCH_QUOTA_WAIT_MIN ?? 20);
const QUOTA_MAX_WAIT_MIN = Number(process.env.BENCH_QUOTA_MAX_WAIT_MIN ?? 12 * 60);

for (const [i, { task, arm, rep }] of matrix.entries()) {
  const file = join(outDir, `${task.id}__${arm.id}__r${rep}.json`);
  if (savedAndValid(file)) { console.log(`[${i + 1}/${matrix.length}] ${task.id} ${arm.id} #${rep}: already done`); continue; }
  let waitedMin = 0;
  retry: for (;;) {
    // Each task has its own script for the fake agent
    const profile = values.profile === 'fake' && task.fakeProfile ? task.fakeProfile : values.profile ?? arm.profile;
    const requirement = readFileSync(join(BENCH, 'tasks', task.id, 'requirement.md'), 'utf8');
    const seed = join(BENCH, 'tasks', task.id, 'seed');
    const label = `bench ${task.id} · ${arm.id} #${rep}`;
    process.stdout.write(`[${i + 1}/${matrix.length}] ${task.id} ${arm.id} #${rep} … `);

    // Past the time limit the agents are stopped and the run counts as failed
    let runId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => {
        if (runId) {
          closeSessions(runId);
          getBus().emit(runId, { type: 'run_finished', status: 'failed', error: `Time limit of ${task.timeLimitMinutes} min reached` });
        }
        resolve('timeout');
      }, task.timeLimitMinutes * 60_000);
    });

    let status: string;
    if (arm.mode === 'pipeline') {
      runId = runs.start({ requirement, source: seed, profile, autoApprove: true, label, pipeline: arm.pipeline });
      status = await Promise.race([runs.waitFor(runId), deadline]);
    } else {
      runId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(16).slice(2, 8)}`;
      const guides = arm.guides?.map(g => `## ${g}\n\n${readFileSync(guidePath(g), 'utf8').trim()}`).join('\n\n');
      const single = runSingle({ requirement, source: seed, profile, process: !!arm.process, guides, label, runId, turnTimeoutMs: task.timeLimitMinutes * 60_000 });
      status = await Promise.race([single.then(r => r.status), deadline]);
    }
    clearTimeout(timer);
    // Out of quota: wait for it to come back and run the same cell again from scratch
    const quota = quotaHit(getBus().read(runId));
    if (quota && waitedMin < QUOTA_MAX_WAIT_MIN) {
      console.log(`stopped by the vendor (${quota}); waiting ${QUOTA_WAIT_MIN} min, then running it again`);
      await new Promise(r => setTimeout(r, QUOTA_WAIT_MIN * 60_000));
      waitedMin += QUOTA_WAIT_MIN;
      continue retry;
    }
    const started = getBus().read(runId).find(e => e.type === 'run_started');
    const workspace = started?.type === 'run_started' ? started.workspace : '';

    const g = workspace ? await grade(task, workspace) : { hidden: { total: 0, pass: 0, fail: 0, skipped: 0, declared: 0 }, resolved: false, output: '' };
    const p = workspace && g.hidden.pass > 0 ? await perf(task, workspace) : undefined;
    const m = metrics(getBus().read(runId));
    const result = {
      task: task.id, size: task.size, arm: arm.id, rep, profile, runId, status,
      resolved: g.resolved, hidden: g.hidden, regression: 'regression' in g ? g.regression : undefined,
      ...m,
      perf: p,
      quotaLimited: quota ?? undefined,
      meta: { finishedAt: new Date().toISOString(), configHash: sha(config), promptsHash: sha(prompts), node: process.version },
      gradeOutput: g.output,
    };
    writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`${g.resolved ? 'RESOLVED' : 'unresolved'} · hidden ${g.hidden.pass}/${g.hidden.total} · ${m.tokens.total.toLocaleString()} tokens · $${m.costUsd.toFixed(2)} · ${Math.round(m.wallMs / 1000)}s${p ? ` · perf ${JSON.stringify(p)}` : ''}`);
    break;
  }
}

console.log(`\nResults in bench/results/${suite}. Open the dashboard's Benchmark tab to compare arms.`);
process.exit(0);
