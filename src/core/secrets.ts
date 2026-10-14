import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { STUDIO_ROOT } from './config';

/** KEY=value lines, git-ignored. Read here only, never put in process.env, so agents never inherit it. */
export const SECRETS_FILE = process.env.DEVCREW_SECRETS ?? join(STUDIO_ROOT, 'secrets.env');

/** A secret from the environment, or from secrets.env. */
export function secret(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) { return fromEnv; }
  const fromFile = existsSync(SECRETS_FILE) ? parseEnv(readFileSync(SECRETS_FILE, 'utf8'))[name] : undefined;
  if (!fromFile) { throw new Error(`${name} is not set: add it to secrets.env or the environment`); }
  return fromFile;
}
