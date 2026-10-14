import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT } from '../core/config';

export interface Workspace {
  path: string;
  kind: 'worktree' | 'copy';
  branch?: string;
  /** Commit the workspace started from, for diffs. */
  baseCommit: string;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 }).trim();

/**
 * Whether the folder is the top of a git repository. A folder inside someone else's repository
 * (for example a demo project inside DevCrew's own repo) is copied instead: a worktree would
 * check out the whole parent repository.
 */
function isGitRepo(dir: string): boolean {
  try { return realpathSync(git(dir, 'rev-parse', '--show-toplevel')) === realpathSync(dir); } catch { return false; }
}

/**
 * An isolated place for one run to work in.
 * The top folder of a git repository gets a new worktree on branch devcrew/<runId>; anything else is copied
 * and given a fresh repository, so every run can show a diff from where it started.
 */
export function prepareWorkspace(source: string | undefined, runId: string): Workspace {
  const path = join(DATA_ROOT, 'workspaces', runId);
  if (source && isGitRepo(source)) {
    const branch = `devcrew/${runId}`;
    git(source, 'worktree', 'add', '-b', branch, path, 'HEAD');
    return { path, kind: 'worktree', branch, baseCommit: git(path, 'rev-parse', 'HEAD') };
  }
  mkdirSync(path, { recursive: true });
  if (source && existsSync(source)) {
    cpSync(source, path, { recursive: true, filter: src => !/[/\\](node_modules|\.git)([/\\]|$)/.test(src) });
  }
  git(path, 'init', '-q');
  git(path, 'add', '-A');
  git(path, '-c', 'user.name=DevCrew', '-c', 'user.email=devcrew@localhost', 'commit', '-q', '--allow-empty', '-m', 'Workspace start');
  return { path, kind: 'copy', baseCommit: git(path, 'rev-parse', 'HEAD') };
}

export interface DiffSummary { files: { path: string; added: number; removed: number }[]; patch: string }

/** Changes since the workspace started, untracked files included. */
export function diffSince(ws: Workspace): DiffSummary {
  git(ws.path, 'add', '-A', '--intent-to-add');
  const numstat = git(ws.path, 'diff', '--numstat', ws.baseCommit);
  const files = numstat.split('\n').filter(Boolean).map(line => {
    const [a, r, path] = line.split('\t');
    return { path, added: Number(a) || 0, removed: Number(r) || 0 };
  });
  const patch = git(ws.path, 'diff', ws.baseCommit).slice(0, 200_000);
  return { files, patch };
}

export function commitAll(ws: Workspace, message: string): string {
  git(ws.path, 'add', '-A');
  git(ws.path, '-c', 'user.name=DevCrew', '-c', 'user.email=devcrew@localhost', 'commit', '-q', '--allow-empty', '-m', message);
  return git(ws.path, 'rev-parse', 'HEAD');
}
