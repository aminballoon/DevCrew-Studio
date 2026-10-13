import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STUDIO_ROOT } from '../core/config';

/**
 * A pipeline is an ordered list of steps. A "build" pipeline (the default) produces code:
 * the built-in steps (planner, qa, build) carry the guardrails and must appear exactly once,
 * with gates and agent steps around them. A "design" pipeline produces documents and a system
 * diagram only: agent steps and design gates, no code. See pipelines/SCHEMA.md.
 */
export type Step = PlannerStep | QaStep | BuildStep | GateStep | AgentStep;

/**
 * Built-in roles keep DevCrew's own instructions; `guide` ("guide:<name>") adds a role guide on top,
 * such as the techniques and tools a specialist uses. A run carries its text in `guideText`.
 */
interface WithGuide { guide?: string; guideText?: string }
export interface PlannerStep extends WithGuide { type: 'planner'; id: 'planner' }
export interface QaStep extends WithGuide {
  type: 'qa'; id: 'qa';
  /**
   * Blind QA: most tests (acceptance/) are kept away from Dev and only run when Verify judges the
   * work, so Dev builds from the requirement, not from the tests. Dev sees which behaviours fail.
   */
  blind?: boolean;
}
export interface BuildStep extends WithGuide {
  type: 'build';
  id: 'build';
  /** Dev attempts per module before asking a human (defaults to the config value). */
  maxAttempts?: number;
}

export interface GateStep {
  type: 'gate';
  id: string;
  title: string;
  /**
   * What you are shown: the plan (spec, architecture and earlier reports), the code (diff,
   * tests, reviews) or, in a design pipeline, the design (system diagram and reports).
   */
  review: 'plan' | 'code' | 'design';
  /** Step that gets your feedback when you ask for changes ("build" means Dev). */
  reviseTo: string;
}

export interface AgentStep {
  type: 'agent';
  id: string;
  /** Short display name, e.g. "Security reviewer". */
  name: string;
  /** One plain sentence: what this role is for. */
  purpose: string;
  /** Agent name from devcrew.config.json; defaults to the profile's reviewer agent. */
  agent?: string;
  /**
   * What to do. "builtin:reviewer" uses DevCrew's standard code-review instructions;
   * "guide:<name>" uses the role guide in pipelines/roles/<name>.md.
   */
  instructions: string;
  /** What the agent must be able to do (checked against the agent's "provides" before a run starts). */
  needs?: Capability[];
  /** Files or folders (ending in /) it should read; "git diff" means all changes so far. */
  reads: string[];
  /** The only paths it may change. tests/, contracts/ and "*" are not allowed. */
  mayWrite: string[];
  /** Plain description of what it hands on, e.g. ".devcrew/security.md: findings by severity". */
  produces: string[];
  /** Optional verdict: the first line of `file` is "VERDICT: approve" or "VERDICT: changes". */
  verdict?: {
    file: string;
    /** "dev": changes send the work back to Dev (after build only). "continue": just report. */
    onChanges: 'dev' | 'continue';
    /** How many times it may send work back. */
    maxRounds?: number;
  };
}

/** Things a role can need from its agent: search and read the web, or run commands. */
export const CAPABILITIES = ['web', 'shell'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface PipelineDef {
  id: string;
  name: string;
  description: string;
  /** "build" (default) ends in committed code; "design" ends in approved documents and a diagram. */
  kind?: 'build' | 'design';
  steps: Step[];
  /** Written on approval: the version of each role guide you approved, by name. */
  guideHashes?: Record<string, string>;
}

/** Where a role that may write it draws the system architecture diagram (design pipelines). */
export const SYSTEM_DIAGRAM = '.devcrew/system.json';

export const isDesign = (def: Pick<PipelineDef, 'kind'>) => def.kind === 'design';

// --- Role guides ---

export const ROLES_DIR = join(STUDIO_ROOT, 'pipelines', 'roles');
const GUIDE = /^guide:([a-z][a-z0-9-]{1,59})$/;

/** The guide name an instructions value refers to, if any. */
export const guideName = (instructions: unknown) => (typeof instructions === 'string' ? instructions.match(GUIDE)?.[1] ?? null : null);
export const guidePath = (name: string) => join(ROLES_DIR, `${name}.md`);
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
export const guideHash = (name: string) => hash(readFileSync(guidePath(name), 'utf8'));

/** Every guide the pipeline's steps use. */
export const guidesOf = (def: PipelineDef) =>
  [...new Set(def.steps.flatMap(s => {
    const name = s.type === 'agent' ? guideName(s.instructions) : 'guide' in s ? guideName(s.guide) : null;
    return name ? [name] : [];
  }))];

/** The definition with every guide's text in place of its "guide:" reference, as a run uses it. */
export function withGuides(def: PipelineDef): PipelineDef {
  return {
    ...def,
    steps: def.steps.map(s => {
      if (s.type !== 'agent') {
        const name = 'guide' in s ? guideName(s.guide) : null;
        return name ? { ...s, guideText: readFileSync(guidePath(name), 'utf8').trim() } : s;
      }
      const name = guideName(s.instructions);
      return name ? { ...s, instructions: readFileSync(guidePath(name), 'utf8').trim() } : s;
    }),
  };
}

export const RESERVED_IDS = ['setup', 'finish', 'dev', 'verify', 'escalate', 'single'];
const ID = /^[a-z][a-z0-9_-]{1,39}$/;
const LOCKED = ['tests/', 'contracts/'];

/** Graph node a step starts at (the build step starts at Dev). */
export const entryNode = (step: Step) => (step.type === 'build' ? 'dev' : step.id);

/** Every problem with a definition, in words the author can act on. Empty = valid. */
export function validatePipeline(raw: unknown): string[] {
  const errors: string[] = [];
  const def = raw as Partial<PipelineDef>;
  if (!def || typeof def !== 'object') { return ['The pipeline must be a JSON object.']; }
  if (typeof def.id !== 'string' || !ID.test(def.id)) { errors.push('"id" must be lowercase letters, digits, - or _ (2 to 40 characters), starting with a letter.'); }
  if (typeof def.name !== 'string' || !def.name.trim()) { errors.push('"name" is required.'); }
  if (typeof def.description !== 'string' || !def.description.trim()) { errors.push('"description" is required: one or two sentences on when to use this pipeline.'); }
  if (!Array.isArray(def.steps) || !def.steps.length) { errors.push('"steps" must be a non-empty list.'); return errors; }

  const steps = def.steps as Step[];
  const ids = new Set<string>();
  steps.forEach((s, i) => {
    const where = `Step ${i + 1}${s && typeof s.id === 'string' ? ` ("${s.id}")` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${where} is not an object.`); return; }
    if (!['planner', 'qa', 'build', 'gate', 'agent'].includes(s.type)) { errors.push(`${where}: "type" must be planner, qa, build, gate or agent.`); return; }
    if (typeof s.id !== 'string' || !ID.test(s.id)) { errors.push(`${where}: "id" must be lowercase letters, digits, - or _.`); return; }
    if (RESERVED_IDS.includes(s.id)) { errors.push(`${where}: "${s.id}" is reserved, pick another id.`); }
    if (ids.has(s.id)) { errors.push(`${where}: id "${s.id}" is used twice.`); }
    ids.add(s.id);
    if (s.type !== 'gate' && s.type !== 'agent' && s.id !== s.type) { errors.push(`${where}: the ${s.type} step must have id "${s.type}".`); }
  });

  const index = (id: string) => steps.findIndex(s => s.id === id);
  const count = (type: Step['type']) => steps.filter(s => s?.type === type).length;
  if (def.kind !== undefined && def.kind !== 'build' && def.kind !== 'design') { errors.push('"kind" must be "build" or "design".'); }
  const design = def.kind === 'design';
  const lastStep = steps[steps.length - 1];
  // Without a build step, "after build" means never
  let iBuild = Infinity;

  if (design) {
    for (const type of ['planner', 'qa', 'build'] as const) {
      if (count(type)) { errors.push(`A design pipeline has no "${type}" step: it produces documents and a diagram, not code.`); }
    }
    if (!count('agent')) { errors.push('A design pipeline needs at least one agent step to do the work.'); }
    if (lastStep.type !== 'gate' || lastStep.review !== 'design') {
      errors.push('The last step must be a gate with "review": "design", so you approve the design before it is committed.');
    }
    if (errors.length) { return errors; }
  } else {
    for (const type of ['planner', 'qa', 'build'] as const) {
      if (count(type) !== 1) { errors.push(`There must be exactly one "${type}" step (found ${count(type)}).`); }
    }
    if (errors.length) { return errors; }
    const iPlanner = index('planner'), iQa = index('qa');
    iBuild = index('build');
    // Research roles may run before the Planner, so the plan is written with their findings
    steps.slice(0, iPlanner).forEach(s => {
      if (s.type !== 'agent') { errors.push(`Step "${s.id}": only agent steps may come before the planner (found a ${s.type}).`); }
      else if (Array.isArray(s.mayWrite) && s.mayWrite.some(p => typeof p === 'string' && !p.startsWith('.devcrew/'))) {
        errors.push(`Step "${s.id}": a step before the planner may only write under .devcrew/ (reports and notes, not code).`);
      }
    });
    if (!(iQa < iBuild)) { errors.push('"qa" must come before "build": tests are written before the code.'); }
    const afterPlanner = steps[iPlanner + 1];
    if (afterPlanner?.type !== 'gate' || afterPlanner.review !== 'plan') {
      errors.push('The step right after the planner must be a gate with "review": "plan", so you approve the spec and architecture before anything is built.');
    }
    if (lastStep.type !== 'gate' || lastStep.review !== 'code') {
      errors.push('The last step must be a gate with "review": "code", so you approve the code before it is committed.');
    }
  }

  steps.forEach((s, i) => {
    const where = `Step "${s.id}"`;
    if (s.type === 'build' && s.maxAttempts !== undefined && !(Number.isInteger(s.maxAttempts) && s.maxAttempts >= 1 && s.maxAttempts <= 10)) {
      errors.push(`${where}: "maxAttempts" must be a whole number from 1 to 10.`);
    }
    if (s.type === 'gate') {
      if (typeof s.title !== 'string' || !s.title.trim()) { errors.push(`${where}: "title" is required.`); }
      if (design ? s.review !== 'design' : s.review !== 'plan' && s.review !== 'code') {
        errors.push(`${where}: "review" must be ${design ? '"design" in a design pipeline' : '"plan" or "code"'}.`);
      }
      if (s.review === 'code' && i < iBuild) { errors.push(`${where}: a code review gate must come after "build".`); }
      if (s.review === 'plan' && i > iBuild) { errors.push(`${where}: a plan review gate must come before "build".`); }
      const target = steps.find(t => t.id === s.reviseTo);
      if (!target) { errors.push(`${where}: "reviseTo" must name an earlier step (got "${s.reviseTo}").`); }
      else if (index(target.id) >= i) { errors.push(`${where}: "reviseTo" must point back to an earlier step.`); }
      else if (target.type === 'gate') { errors.push(`${where}: "reviseTo" cannot be another gate.`); }
      else if (s.review === 'plan' && target.type !== 'planner' && !(target.type === 'agent' && index(target.id) < iBuild)) {
        errors.push(`${where}: a plan review sends feedback to "planner" or to an agent step before "build".`);
      }
    }
    if (s.type === 'qa' && s.blind !== undefined && typeof s.blind !== 'boolean') { errors.push(`${where}: "blind" must be true or false.`); }
    if ((s.type === 'planner' || s.type === 'qa' || s.type === 'build') && s.guide !== undefined) {
      const guide = guideName(s.guide);
      if (!guide) { errors.push(`${where}: "guide" must be "guide:<name>" (lowercase letters, digits and -).`); }
      else if (!existsSync(guidePath(guide))) { errors.push(`${where}: no role guide pipelines/roles/${guide}.md.`); }
    }
    if (s.type === 'agent') {
      if (typeof s.name !== 'string' || !s.name.trim()) { errors.push(`${where}: "name" is required.`); }
      if (typeof s.purpose !== 'string' || !s.purpose.trim()) { errors.push(`${where}: "purpose" is required: one plain sentence.`); }
      const guide = guideName(s.instructions);
      if (typeof s.instructions === 'string' && s.instructions.startsWith('guide:')) {
        if (!guide) { errors.push(`${where}: "${s.instructions}" is not a guide name (lowercase letters, digits and -).`); }
        else if (!existsSync(guidePath(guide))) { errors.push(`${where}: no role guide pipelines/roles/${guide}.md.`); }
      } else if (typeof s.instructions !== 'string' || (s.instructions !== 'builtin:reviewer' && s.instructions.trim().length < 20)) {
        errors.push(`${where}: "instructions" must say what to do (at least a sentence), be "builtin:reviewer" or name a guide ("guide:<name>").`);
      }
      if (s.needs !== undefined && (!Array.isArray(s.needs) || s.needs.some(n => !CAPABILITIES.includes(n)))) {
        errors.push(`${where}: "needs" must be a list of ${CAPABILITIES.join(', ')}.`);
      }
      for (const key of ['reads', 'mayWrite', 'produces'] as const) {
        if (!Array.isArray(s[key]) || s[key].some(x => typeof x !== 'string')) { errors.push(`${where}: "${key}" must be a list of strings.`); }
      }
      if (Array.isArray(s.mayWrite)) {
        if (!s.mayWrite.length) { errors.push(`${where}: "mayWrite" needs at least one path (a report file at minimum).`); }
        for (const p of s.mayWrite) {
          if (p === '*' || p === '' || p === '/') { errors.push(`${where}: "mayWrite" cannot be everything; list the files or folders it owns.`); }
          else if (p.startsWith('/') || p.includes('..')) { errors.push(`${where}: "${p}" must be a path inside the project.`); }
          else if (LOCKED.some(l => p.startsWith(l) || l.startsWith(p))) { errors.push(`${where}: it may not write "${p}": tests and contracts are locked.`); }
        }
      }
      if (s.verdict) {
        const v = s.verdict;
        if (typeof v.file !== 'string' || !s.mayWrite?.some(p => p === v.file || (p.endsWith('/') && v.file.startsWith(p)))) {
          errors.push(`${where}: "verdict.file" must be one of the paths in "mayWrite".`);
        }
        if (v.onChanges !== 'dev' && v.onChanges !== 'continue') { errors.push(`${where}: "verdict.onChanges" must be "dev" or "continue".`); }
        if (v.onChanges === 'dev' && i < iBuild) { errors.push(`${where}: only steps after "build" can send work back to Dev.`); }
        if (v.maxRounds !== undefined && !(Number.isInteger(v.maxRounds) && v.maxRounds >= 1 && v.maxRounds <= 5)) {
          errors.push(`${where}: "verdict.maxRounds" must be a whole number from 1 to 5.`);
        }
      }
    }
  });
  return errors;
}

// --- Files ---

export const PIPELINES_DIR = join(STUDIO_ROOT, 'pipelines');
export const DRAFTS_DIR = join(PIPELINES_DIR, 'drafts');

export interface PipelineReview { status: 'in_review' | 'changes_requested' | 'approved'; feedback?: string; at: string }

export interface PipelineListing {
  id: string;
  draft: boolean;
  def: PipelineDef | null;
  errors: string[];
  review?: PipelineReview;
  updatedAt: number;
}

function readDef(path: string, approved = false): { def: PipelineDef | null; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { def: null, errors: [`Not valid JSON: ${(e as Error).message}`] }; }
  // Invalid definitions are still returned, so a draft can be shown next to its errors
  const errors = validatePipeline(raw);
  if (approved && !errors.length) { errors.push(...changedGuides(raw as PipelineDef)); }
  return { def: raw as PipelineDef, errors };
}

/** An approved pipeline only runs with the guides you approved: a changed guide needs a new review. */
function changedGuides(def: PipelineDef): string[] {
  return guidesOf(def).flatMap(name => {
    const approved = def.guideHashes?.[name];
    if (!approved) { return [`Role guide "${name}" was not part of the approval. Review the pipeline again (copy it to pipelines/drafts/ and approve it).`]; }
    return guideHash(name) === approved ? [] : [`Role guide pipelines/roles/${name}.md changed since this pipeline was approved. Review the pipeline again (copy it to pipelines/drafts/ and approve it).`];
  });
}

export function loadPipeline(id: string): PipelineDef {
  const path = join(PIPELINES_DIR, `${id}.json`);
  if (!ID.test(id) || !existsSync(path)) { throw new Error(`No approved pipeline "${id}" in pipelines/`); }
  const { def, errors } = readDef(path, true);
  if (errors.length) { throw new Error(`Pipeline "${id}" is invalid:\n- ${errors.join('\n- ')}`); }
  return def!;
}

export function listPipelines(): PipelineListing[] {
  const out: PipelineListing[] = [];
  const scan = (dir: string, draft: boolean) => {
    if (!existsSync(dir)) { return; }
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.review.json'))) {
      const path = join(dir, f);
      const { def, errors } = readDef(path, !draft);
      const reviewPath = join(dir, f.replace(/\.json$/, '.review.json'));
      out.push({
        id: f.replace(/\.json$/, ''), draft, def, errors,
        review: draft && existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, 'utf8')) : undefined,
        updatedAt: Math.round(statSync(path).mtimeMs),
      });
    }
  };
  scan(PIPELINES_DIR, false);
  scan(DRAFTS_DIR, true);
  return out;
}

/** Record your decision on a draft. Approving validates it and moves it into pipelines/. */
export function reviewDraft(id: string, decision: 'approve' | 'revise', feedback?: string): PipelineReview {
  const path = join(DRAFTS_DIR, `${id}.json`);
  if (!ID.test(id) || !existsSync(path)) { throw new Error(`No draft "${id}" in pipelines/drafts/`); }
  const reviewPath = join(DRAFTS_DIR, `${id}.review.json`);
  if (decision === 'revise') {
    if (!feedback?.trim()) { throw new Error('Say what should change.'); }
    const review: PipelineReview = { status: 'changes_requested', feedback, at: new Date().toISOString() };
    writeFileSync(reviewPath, JSON.stringify(review, null, 2));
    return review;
  }
  const { errors } = readDef(path);
  if (errors.length) { throw new Error(`The draft is not valid yet:\n- ${errors.join('\n- ')}`); }
  const target = join(PIPELINES_DIR, `${id}.json`);
  mkdirSync(PIPELINES_DIR, { recursive: true });
  // Record the guides as approved, so a later edit to one needs a new review
  const def = JSON.parse(readFileSync(path, 'utf8')) as PipelineDef;
  delete def.guideHashes;
  const guides = guidesOf(def);
  if (guides.length) { def.guideHashes = Object.fromEntries(guides.map(name => [name, guideHash(name)])); }
  writeFileSync(target, JSON.stringify(def, null, 2) + '\n');
  unlinkSync(path);
  const review: PipelineReview = { status: 'approved', feedback, at: new Date().toISOString() };
  writeFileSync(reviewPath, JSON.stringify(review, null, 2));
  return review;
}
