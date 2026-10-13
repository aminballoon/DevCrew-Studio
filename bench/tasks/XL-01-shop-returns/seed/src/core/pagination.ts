import { ValidationError } from './errors.ts';

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Cursor pagination over an already-sorted list. The cursor is the index of the next
 * item, base64url-encoded so clients treat it as opaque.
 */
export function paginate<T>(items: T[], query: { limit?: string; cursor?: string } = {}): Page<T> {
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be 1-${MAX_LIMIT}`, 'limit');
  }
  let start = 0;
  if (query.cursor !== undefined) {
    start = Number(Buffer.from(query.cursor, 'base64url').toString());
    if (!Number.isInteger(start) || start < 0) { throw new ValidationError('bad cursor', 'cursor'); }
  }
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { items: slice, nextCursor: next };
}
