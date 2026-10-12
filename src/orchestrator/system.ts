import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_DIAGRAM } from '../pipeline/schema';

/**
 * A system architecture diagram: hardware and software blocks and the interfaces between
 * them. Roles in a design pipeline write it to .devcrew/system.json; the dashboard draws it.
 */
export const BLOCK_KINDS = ['compute', 'controller', 'sensor', 'actuator', 'power', 'network', 'storage', 'software', 'interface', 'external', 'user'] as const;
export const LINK_KINDS = ['data', 'control', 'power', 'mechanical'] as const;

export interface SystemBlock {
  id: string;
  name: string;
  kind: (typeof BLOCK_KINDS)[number];
  /** Id of a group (subsystem) the block belongs to. */
  group?: string;
  /** Chosen part or product, e.g. "STM32F446RE"; empty while undecided. */
  part?: string;
  description?: string;
}

export interface SystemLink {
  from: string;
  to: string;
  /** Protocol or connection, e.g. "UART 921600", "CAN 1 Mbit/s", "24 V". */
  interface: string;
  kind?: (typeof LINK_KINDS)[number];
  label?: string;
}

export interface SystemDiagram {
  title: string;
  groups?: { id: string; name: string }[];
  blocks: SystemBlock[];
  links: SystemLink[];
}

export const SYSTEM_FORMAT = `{
  "title": "Short name of the system",
  "groups": [ { "id": "base", "name": "Robot base" } ],
  "blocks": [
    { "id": "kebab-case-id", "name": "Display name", "kind": "${BLOCK_KINDS.join(' | ')}",
      "group": "group id (optional)", "part": "chosen part number, or empty while undecided", "description": "One plain sentence: what it does" }
  ],
  "links": [
    { "from": "block id", "to": "block id", "interface": "protocol and rate, e.g. UART 921600 or 24 V", "kind": "${LINK_KINDS.join(' | ')}", "label": "what flows, e.g. odometry (optional)" }
  ]
}`;

/** The diagram and its problems. Missing file = null diagram, no errors. */
export function readSystem(workspace: string): { system: SystemDiagram | null; errors: string[] } {
  const path = join(workspace, SYSTEM_DIAGRAM);
  if (!existsSync(path)) { return { system: null, errors: [] }; }
  let raw: Partial<SystemDiagram>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { system: null, errors: [`${SYSTEM_DIAGRAM} is not valid JSON: ${(e as Error).message}`] }; }
  const errors: string[] = [];
  if (!Array.isArray(raw.blocks) || !raw.blocks.length) { errors.push('"blocks" must be a non-empty list.'); }
  if (!Array.isArray(raw.links)) { errors.push('"links" must be a list (it may be empty).'); }
  if (errors.length) { return { system: null, errors }; }
  const ids = new Set<string>();
  const groups = new Set((raw.groups ?? []).map(g => g.id));
  for (const b of raw.blocks!) {
    if (typeof b.id !== 'string' || !b.id) { errors.push('Every block needs an "id".'); continue; }
    if (ids.has(b.id)) { errors.push(`Block id "${b.id}" is used twice.`); }
    ids.add(b.id);
    if (!BLOCK_KINDS.includes(b.kind)) { errors.push(`Block "${b.id}": "kind" must be one of ${BLOCK_KINDS.join(', ')}.`); }
    if (b.group && !groups.has(b.group)) { errors.push(`Block "${b.id}": group "${b.group}" is not in "groups".`); }
  }
  for (const l of raw.links!) {
    if (!ids.has(l.from) || !ids.has(l.to)) { errors.push(`Link ${l.from} → ${l.to}: both ends must be block ids.`); }
    if (l.kind && !LINK_KINDS.includes(l.kind)) { errors.push(`Link ${l.from} → ${l.to}: "kind" must be one of ${LINK_KINDS.join(', ')}.`); }
  }
  return { system: { title: raw.title ?? 'System', groups: raw.groups ?? [], blocks: raw.blocks!, links: raw.links! }, errors };
}
