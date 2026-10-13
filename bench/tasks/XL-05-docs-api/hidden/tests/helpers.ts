import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/index.ts';

export const START = new Date('2030-05-01T09:00:00.000Z');

export interface Res { status: number; body: any }

/** A fresh app with its own data dir and a clock tests can move. */
export function setup() {
  const root = mkdtempSync(join(tmpdir(), 'shelf-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  let t = START.getTime();
  const app = createApp({ dataDir, now: () => new Date(t) });
  const call = async (method: string, path: string, token?: string | null, body?: unknown, query?: Record<string, string>): Promise<Res> => {
    const res = await app.handle({ method, path, headers: token ? { authorization: `Bearer ${token}` } : {}, body, query });
    return res as Res;
  };
  return { app, root, dataDir, call, advance: (ms: number) => { t += ms; } };
}

export type Call = ReturnType<typeof setup>['call'];

export function expect(res: Res, status: number): any {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)?.slice(0, 300)}`);
  return res.body;
}

export async function signup(call: Call, name: string): Promise<{ id: string; token: string; email: string }> {
  const email = `${name.toLowerCase()}@example.com`;
  const body = expect(await call('POST', '/signup', null, { email, password: `${name}-password-1`, name }), 201);
  return { id: body.user.id, token: body.token, email };
}

/** Ann owns workspace "Acme" with editor Ed and viewer Vi; Mallory has her own workspace "Evil". */
export async function team() {
  const s = setup();
  const ann = await signup(s.call, 'Ann');
  const ed = await signup(s.call, 'Ed');
  const vi = await signup(s.call, 'Vi');
  const mal = await signup(s.call, 'Mallory');
  const acme = expect(await s.call('POST', '/workspaces', ann.token, { name: 'Acme' }), 201).id;
  expect(await s.call('POST', `/workspaces/${acme}/members`, ann.token, { email: ed.email, role: 'editor' }), 201);
  expect(await s.call('POST', `/workspaces/${acme}/members`, ann.token, { email: vi.email, role: 'viewer' }), 201);
  const evil = expect(await s.call('POST', '/workspaces', mal.token, { name: 'Evil' }), 201).id;
  const doc = expect(await s.call('POST', `/workspaces/${acme}/docs`, ann.token, { title: 'Plan', body: 'Secret plan for Q3', tags: ['q3'] }), 201);
  return { ...s, ann, ed, vi, mal, acme, evil, doc };
}
