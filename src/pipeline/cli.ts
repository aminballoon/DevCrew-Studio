import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DRAFTS_DIR, guideName, listPipelines, PIPELINES_DIR, reviewDraft, validatePipeline, type PipelineDef, type Step } from './schema';

const USAGE = `Usage:
  npm run pipeline -- validate <file.json>      check a definition and print it in plain words
  npm run pipeline -- describe <id | file.json>  print a pipeline in plain words
  npm run pipeline -- list                       approved pipelines and drafts
  npm run pipeline -- status <draft-id>          your review of a draft (in review / changes requested / approved)
  npm run pipeline -- approve <draft-id>         approve a draft: moves it from pipelines/drafts/ to pipelines/
  npm run pipeline -- revise <draft-id> "<what should change>"

Drafts live in pipelines/drafts/. Only approved pipelines can be chosen for a run.`;

const GATE_SHOWS = {
  plan: 'spec, architecture and the reports written so far',
  code: 'code, test results and reviews',
  design: 'system diagram and the reports written so far',
  architecture: "project's lasting architecture: modules, which may use which, contracts and decisions",
};

/** One line per step, in words a non-programmer can review. */
export function describe(def: PipelineDef): string {
  const name = (s: Step | undefined) => !s ? 'the end of the run'
    : s.type === 'gate' ? `you (${s.title})` : s.type === 'agent' ? s.name : s.type === 'build' ? 'Dev' : s.type === 'qa' ? 'QA' : 'the Planner';
  const withGuide = (s: Step) => {
    const g = 'guide' in s ? guideName(s.guide) : null;
    return g ? ` Also follows the role guide pipelines/roles/${g}.md.` : '';
  };
  const lines = def.steps.map((s, i) => {
    const n = `${i + 1}.`.padEnd(4);
    switch (s.type) {
      case 'planner': return `${n}Planner: reads your request, writes the spec and designs every file. Writes .devcrew/ and contracts/.${withGuide(s)}`;
      case 'qa': return `${n}QA: writes tests from the spec before any code exists. Writes tests/ (locked afterwards).${withGuide(s)}`;
      case 'build': return `${n}Dev + Verify: Dev builds one part at a time; the system runs the tests after each try. Up to ${s.maxAttempts ?? 'the configured number of'} tries per part, then you decide.${withGuide(s)}`;
      case 'gate': return `${n}You review the ${GATE_SHOWS[s.review]} ("${s.title}"). Approve to continue${i === def.steps.length - 1 ? ' and commit' : ''}, or ask for changes to send it back to ${name(def.steps.find(x => x.id === s.reviseTo))}.`;
      case 'agent': {
        const back = s.verdict?.onChanges === 'dev' ? ` If it finds problems it sends the code back to Dev (at most ${s.verdict.maxRounds ?? 1} time${(s.verdict.maxRounds ?? 1) === 1 ? '' : 's'}).` : '';
        const guide = guideName(s.instructions);
        const extra = `${guide ? ` Follows the role guide pipelines/roles/${guide}.md.` : ''}${s.needs?.length ? ` Needs an agent that can use ${s.needs.join(' and ')}.` : ''}`;
        return `${n}${s.name}${s.agent ? ` (${s.agent})` : ''}: ${s.purpose} Reads ${s.reads.join(', ') || 'the workspace'}. May only write ${s.mayWrite.join(', ')}.${back}${extra}`;
      }
    }
  });
  const kind = def.kind === 'design' ? 'Design only: no code is written; the result is approved documents and a system diagram.\n' : '';
  return `${def.name} (${def.id})\n${def.description}\n${kind}\n${lines.join('\n')}`;
}

function readFile(arg: string): unknown {
  const path = existsSync(arg) ? resolve(arg)
    : existsSync(join(PIPELINES_DIR, `${arg}.json`)) ? join(PIPELINES_DIR, `${arg}.json`)
    : join(DRAFTS_DIR, `${arg}.json`);
  if (!existsSync(path)) { throw new Error(`Not found: ${arg}`); }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(): number {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'validate':
    case 'describe': {
      if (!arg) { break; }
      const raw = readFile(arg);
      const errors = validatePipeline(raw);
      if (errors.length) {
        console.log(`NOT VALID (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
        errors.forEach(e => console.log(`- ${e}`));
        return 1;
      }
      if (cmd === 'validate') { console.log('VALID\n'); }
      console.log(describe(raw as PipelineDef));
      return 0;
    }
    case 'list': {
      for (const p of listPipelines()) {
        const state = p.draft ? `draft, ${p.review?.status.replace('_', ' ') ?? 'in review'}` : 'approved';
        console.log(`${p.id.padEnd(24)} ${state.padEnd(30)} ${p.errors.length ? `${p.errors.length} problem(s)` : p.def?.name ?? ''}`);
      }
      return 0;
    }
    case 'status': {
      if (!arg) { break; }
      const p = listPipelines().find(x => x.id === arg && x.draft) ?? listPipelines().find(x => x.id === arg);
      if (!p) { console.log(`No pipeline or draft "${arg}"`); return 1; }
      if (!p.draft) { console.log('approved'); return 0; }
      console.log(p.review?.status ?? 'in_review');
      if (p.review?.feedback) { console.log(`Feedback: ${p.review.feedback}`); }
      if (p.errors.length) { console.log(`Problems:\n- ${p.errors.join('\n- ')}`); }
      return 0;
    }
    case 'approve':
    case 'revise': {
      if (!arg) { break; }
      const review = reviewDraft(arg, cmd === 'approve' ? 'approve' : 'revise', rest.join(' ') || undefined);
      console.log(cmd === 'approve' ? `Approved: pipelines/${arg}.json` : `Changes requested: ${review.feedback}`);
      return 0;
    }
  }
  console.log(USAGE);
  return 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
