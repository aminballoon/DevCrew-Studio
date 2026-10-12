import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { STUDIO_ROOT } from '../core/config';
import type { GateAnswer } from '../orchestrator/graph';
import { RunManager } from '../orchestrator/RunManager';
import { ROLE_CONTRACTS } from '../orchestrator/roles';
import { listPipelines, loadPipeline, reviewDraft } from '../pipeline/schema';
import { getBus, getConfig } from '../orchestrator/runtime';

const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC = join(import.meta.dirname, 'public');
const RESULTS = join(STUDIO_ROOT, 'bench', 'results');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const runs = new RunManager();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; }
  return raw ? JSON.parse(raw) : {};
}

/** Replays a run's events, then streams every new event (all runs, so the run list stays live). */
function stream(req: IncomingMessage, res: ServerResponse, runId: string | null): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  if (runId) {
    for (const e of getBus().read(runId)) { res.write(`data: ${JSON.stringify(e)}\n\n`); }
  }
  res.write(`event: replayed\ndata: {}\n\n`);
  const unsubscribe = getBus().subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { unsubscribe(); clearInterval(ping); });
}

/** Every graded benchmark result file, flattened. */
function benchResults(): unknown[] {
  if (!existsSync(RESULTS)) { return []; }
  const out: unknown[] = [];
  for (const suite of readdirSync(RESULTS)) {
    const dir = join(RESULTS, suite);
    if (!statSync(dir).isDirectory()) { continue; }
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try { out.push({ suite, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }); } catch { /* partial write */ }
    }
  }
  return out;
}

/** Every *.json in a folder, parsed (arm definitions). */
function readJsonDir(dir: string): unknown[] {
  if (!existsSync(dir)) { return []; }
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** Task metadata (task.json) of every benchmark task. */
function benchTasks(): unknown[] {
  const dir = join(STUDIO_ROOT, 'bench', 'tasks');
  if (!existsSync(dir)) { return []; }
  return readdirSync(dir).filter(t => existsSync(join(dir, t, 'task.json')))
    .map(t => ({ ...JSON.parse(readFileSync(join(dir, t, 'task.json'), 'utf8')), id: t }));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const runMatch = path.match(/^\/api\/runs\/([\w-]+)(\/gate)?$/);

  if (path === '/api/config' && req.method === 'GET') {
    const cfg = getConfig();
    return json(res, 200, { profiles: Object.keys(cfg.profiles), defaultProfile: cfg.defaultProfile, maxFixAttempts: cfg.maxFixAttempts, roles: cfg.profiles, profileNotes: cfg.profileNotes ?? {}, studioRoot: STUDIO_ROOT, contracts: ROLE_CONTRACTS, standardPipeline: loadPipeline('standard') });
  }
  if (path === '/api/runs' && req.method === 'GET') { return json(res, 200, runs.list()); }
  if (path === '/api/runs' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.requirement !== 'string' || !body.requirement.trim()) { return json(res, 400, { error: 'requirement is required' }); }
    let runId: string;
    try {
      runId = runs.start({
      requirement: body.requirement,
      source: typeof body.source === 'string' && body.source.trim() ? body.source.trim() : undefined,
      profile: typeof body.profile === 'string' ? body.profile : undefined,
      autoApprove: body.autoApprove === true,
      label: typeof body.label === 'string' ? body.label : undefined,
      pipeline: typeof body.pipeline === 'string' && body.pipeline ? body.pipeline : undefined,
      });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
    return json(res, 201, { runId });
  }
  if (runMatch && runMatch[2] && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await runs.resolveGate(runMatch[1], { decision: body.decision as GateAnswer['decision'], feedback: (body.feedback as string) || undefined });
      return json(res, 202, { ok: true });
    } catch (e) {
      return json(res, 409, { error: (e as Error).message });
    }
  }
  if (runMatch && req.method === 'GET') { return json(res, 200, runs.events(runMatch[1])); }
  if (path === '/api/stream') { return stream(req, res, url.searchParams.get('run')); }
  if (path === '/api/pipelines' && req.method === 'GET') { return json(res, 200, listPipelines()); }
  const pipelineReview = path.match(/^\/api\/pipelines\/([\w-]+)\/review$/);
  if (pipelineReview && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, reviewDraft(pipelineReview[1], body.decision === 'approve' ? 'approve' : 'revise', (body.feedback as string) || undefined));
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }
  if (path === '/api/bench') { return json(res, 200, { results: benchResults(), arms: readJsonDir(join(STUDIO_ROOT, 'bench', 'arms')), tasks: benchTasks() }); }

  // Static files
  const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

createServer((req, res) => {
  handle(req, res).catch(e => json(res, 500, { error: (e as Error).message }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`DevCrew Studio dashboard: http://localhost:${PORT}`);
});
