import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isAllowed, type Scope } from '../core/scope';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Contents of every file in a workspace, keyed by POSIX relative path. */
export type Snapshot = Map<string, Buffer>;

export function takeSnapshot(workspace: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) { continue; }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || statSync(full).size > MAX_FILE_BYTES) { continue; }
      out.set(relative(workspace, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(workspace);
  return out;
}

export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  for (const [path, content] of after) {
    const old = before.get(path);
    if (!old || !old.equals(content)) { changed.add(path); }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) { changed.add(path); }
  }
  return [...changed].sort();
}

/**
 * Undo every change outside the role's scope since `before`.
 * This is the real guard: agents can bypass the ACP client by editing through their own shell.
 */
export function revertOutOfScope(workspace: string, before: Snapshot, scope: Scope): string[] {
  const after = takeSnapshot(workspace);
  const violations = changedFiles(before, after).filter(p => !isAllowed(scope, workspace, join(workspace, p)));
  for (const path of violations) {
    const full = join(workspace, path);
    const original = before.get(path);
    if (original) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, original);
    } else {
      rmSync(full, { force: true });
    }
  }
  return violations;
}

/** Hashes of files under the given prefixes, used to lock what QA delivered. */
export function hashFiles(workspace: string, prefixes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of takeSnapshot(workspace)) {
    if (prefixes.some(p => path.startsWith(p))) {
      out[path] = createHash('sha256').update(content).digest('hex');
    }
  }
  return out;
}
