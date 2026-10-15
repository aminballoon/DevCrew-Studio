// How much of the project each change round needs: source files it changed, and source files the
// agents that wrote code had to read (the context a change costs). Lines per file say little; a
// project split by responsibility lets a change touch and read only the part it is about.
// Usage: npx tsx bench/runner/locality.ts <suite> [<suite> ...]
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { STUDIO_ROOT } from '../../src/core/config';
import { getBus } from '../../src/orchestrator/runtime';

const SOURCE = /^src\/.*\.(ts|js|py)$/;

function sourceFiles(dir: string, root = dir): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) { return out; }
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(d.name)) { continue; }
    const p = join(dir, d.name);
    if (d.isDirectory()) { for (const [k, v] of sourceFiles(p, root)) { out.set(k, v); } } else {
      const rel = relative(root, p);
      if (SOURCE.test(rel)) { out.set(rel, readFileSync(p, 'utf8')); }
    }
  }
  return out;
}

const workspaceOf = (runId: string) => {
  const e = getBus().read(runId).find(x => x.type === 'run_started');
  return e?.type === 'run_started' ? e.workspace : '';
};

function jsonl(dir: string): string[] {
  if (!existsSync(dir)) { return []; }
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? jsonl(join(dir, d.name)) : d.name.endsWith('.jsonl') ? [join(dir, d.name)] : []));
}

/** Source files read by the sessions that edited code, from Claude Code's transcripts of the workspace. */
function readByWriters(workspace: string): Set<string> | null {
  const dir = join(homedir(), '.claude', 'projects', realpathSync(workspace).replace(/[^a-zA-Z0-9]/g, '-'));
  const files = jsonl(dir);
  if (!files.length) { return null; }
  const read = new Set<string>();
  for (const f of files) {
    const uses = readFileSync(f, 'utf8').split('\n').flatMap(l => {
      try { const e = JSON.parse(l); return e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content.filter((c: any) => c.type === 'tool_use') : []; } catch { return []; }
    });
    if (!uses.some((u: any) => ['Edit', 'Write', 'MultiEdit'].includes(u.name))) { continue; }
    for (const u of uses) {
      const path: string | undefined = u.name === 'Read' ? u.input?.file_path : undefined;
      if (path) { const rel = relative(workspace, path); if (SOURCE.test(rel)) { read.add(rel); } }
    }
  }
  return read;
}

for (const suite of process.argv.slice(2)) {
  const dir = join(STUDIO_ROOT, 'bench/results', suite);
  const results = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  console.log(`\n# ${suite}\n\nchanged = source files the change edited or added; read = source files the code-writing agents opened\n`);
  console.log('arm                 rep  round                 src files  changed      read');
  const key = (r: any) => `${r.arm}#${r.rep}`;
  for (const r of results.sort((a, b) => key(a).localeCompare(key(b)) || a.task.localeCompare(b.task))) {
    const ws = workspaceOf(r.runId);
    if (!ws || !existsSync(ws)) { continue; }
    const after = sourceFiles(ws);
    const prev = r.continues ? results.find(x => x.task === r.continues && x.arm === r.arm && x.rep === r.rep) : null;
    const before = prev ? sourceFiles(workspaceOf(prev.runId)) : new Map<string, string>();
    const changed = [...after].filter(([k, v]) => before.get(k) !== v).length;
    const read = readByWriters(ws);
    const pct = (n: number, of: number) => `${n}/${of} ${of ? Math.round((n / of) * 100) : 0}%`;
    console.log(`${r.arm.padEnd(20)}${String(r.rep).padEnd(5)}${r.task.padEnd(22)}${String(after.size).padEnd(11)}${(prev ? pct(changed, after.size) : 'new').padEnd(13)}${read ? (prev ? pct([...read].filter(f => before.has(f)).length, before.size) : `${read.size}`) : '-'}`);
  }
}
