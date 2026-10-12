import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Which paths a role may change, as workspace-relative prefixes.
 * "*" allows everything not denied; a prefix ending in "/" covers a directory.
 */
export interface Scope { write: string[]; deny: string[] }

export const ROLE_SCOPES: Record<string, Scope> = {
  planner: { write: ['.devcrew/', 'contracts/'], deny: [] },
  qa: { write: ['tests/'], deny: [] },
  dev: { write: ['*'], deny: ['tests/', 'contracts/', '.devcrew/'] },
  reviewer: { write: ['.devcrew/review.md'], deny: [] },
  single: { write: ['*'], deny: [] },
};

/** Workspace-relative POSIX path, or undefined when the path is outside the workspace. */
export function toRelative(workspace: string, path: string): string | undefined {
  const rel = relative(workspace, isAbsolute(path) ? path : resolve(workspace, path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) { return undefined; }
  return rel.split(sep).join('/');
}

const matches = (rel: string, prefix: string) =>
  prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix;

export function isAllowed(scope: Scope, workspace: string, path: string): boolean {
  const rel = toRelative(workspace, path);
  if (rel === undefined) { return false; }
  if (scope.deny.some(p => matches(rel, p))) { return false; }
  return scope.write.some(p => p === '*' || matches(rel, p));
}
