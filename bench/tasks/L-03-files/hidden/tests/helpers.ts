import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/index.ts';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
export const PDF = new TextEncoder().encode('%PDF-1.7\n...');
export const TXT = (s: string) => new TextEncoder().encode(s);

/** A fresh sandbox dir with the store's root one level down, so stray writes next to root can be seen. */
export function setup(opts: { maxFileBytes?: number; quotaBytes?: number } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'fs-hidden-'));
  const root = join(sandbox, 'root');
  mkdirSync(root);
  let now = new Date('2030-01-01T00:00:00Z');
  const store = new FileStore({ root, maxFileBytes: opts.maxFileBytes ?? 1000, quotaBytes: opts.quotaBytes ?? 5000, now: () => now });
  return { store, root, sandbox, advance: (s: number) => { now = new Date(now.getTime() + s * 1000); } };
}

/** Every file path under dir, recursively. */
export function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}
