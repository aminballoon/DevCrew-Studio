import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DevcrewEvent } from './core/events';
import type { GateAnswer } from './orchestrator/graph';
import { RunManager } from './orchestrator/RunManager';
import { getBus } from './orchestrator/runtime';

const USAGE = `Usage:
  npm run run -- start --requirement <file> [--source <dir>] [--profile <name>] [--pipeline <id>] [--auto]
  npm run run -- gate <runId> <approve|revise|retry|replan|abort> [--feedback <text>]
  npm run run -- resume <runId>     continue a run whose process stopped mid-way
  npm run run -- list

Gates wait for an answer; the dashboard (npm run dashboard) is the easier way to give one.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    requirement: { type: 'string' },
    source: { type: 'string' },
    profile: { type: 'string' },
    pipeline: { type: 'string' },
    auto: { type: 'boolean', default: false },
    feedback: { type: 'string' },
  },
});

function print(e: DevcrewEvent): void {
  const t = new Date(e.ts).toLocaleTimeString();
  switch (e.type) {
    case 'node_started': console.log(`${t}  start   ${e.node}${e.module ? ` [${e.module}${e.attempt ? ` #${e.attempt}` : ''}]` : ''}`); break;
    case 'tool_call': if (e.status !== 'completed') { console.log(`${t}          ${e.role}: ${e.title}`); } break;
    case 'guard_violation': console.log(`${t}  BLOCKED ${e.role} ${e.action}: ${e.files.join(', ')}`); break;
    case 'verify_result': console.log(`${t}  ${e.passed ? 'PASS   ' : 'FAIL   '} ${e.module}: ${e.tests.pass}/${e.tests.total} passed ${e.reasons.join('; ')}`); break;
    case 'usage': console.log(`${t}  usage   ${e.role}: ${e.totalTokens.toLocaleString()} tokens, $${e.costUsd.toFixed(3)}`); break;
    case 'gate_waiting': console.log(`${t}  WAITING at gate "${e.gate}" → npm run run -- gate ${e.runId} approve`); break;
    case 'gate_resolved': console.log(`${t}  gate    "${e.gate}": ${e.decision}`); break;
    case 'run_finished': console.log(`${t}  END     ${e.status}${e.error ? `: ${e.error}` : ''}`); break;
    case 'log': if (e.level === 'error') { console.error(e.message); } break;
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = positionals;
  const runs = new RunManager();
  if (cmd === 'list') {
    for (const r of runs.list()) {
      console.log(`${r.runId}  ${r.status.padEnd(9)} ${r.profile.padEnd(8)} ${r.requirement.split('\n')[0].slice(0, 60)}`);
    }
    return;
  }
  let runId: string;
  if (cmd === 'start' && values.requirement) {
    getBus().subscribe(print);
    runId = runs.start({
      requirement: readFileSync(values.requirement, 'utf8'),
      source: values.source,
      profile: values.profile,
      pipeline: values.pipeline,
      autoApprove: values.auto,
    });
    console.log(`Run ${runId}`);
  } else if (cmd === 'resume' && rest.length === 1) {
    getBus().subscribe(print);
    runId = rest[0];
    await runs.resume(runId);
  } else if (cmd === 'gate' && rest.length === 2) {
    getBus().subscribe(print);
    runId = rest[0];
    await runs.resolveGate(runId, { decision: rest[1] as GateAnswer['decision'], feedback: values.feedback });
  } else {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  // Exit when the run finishes or stops at a gate
  await new Promise<void>(resolve => getBus().subscribe(e => {
    if (e.runId === runId && (e.type === 'gate_waiting' || e.type === 'run_finished')) { resolve(); }
  }));
}

main().then(() => process.exit(), e => { console.error(e); process.exit(1); });
