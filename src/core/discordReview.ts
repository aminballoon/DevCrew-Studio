/**
 * What a gate shows on Discord: the review itself, short enough for a phone, with the full
 * documents attached as files (PRD.md, the patch) to open in Discord.
 */

export interface ReviewEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}
export interface ReviewFile { name: string; text: string }

const VIOLET = 0x534ab7, GREEN = 0x3b6d11, RED = 0xa32d2d, AMBER = 0x854f0b;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Discord field values hold at most 1024 characters. */
const field = (name: string, lines: string[], inline = false) =>
  ({ name: cut(name, 256), value: cut(lines.filter(Boolean).join('\n') || '-', 1024), inline });

/** "- AC-3 Re-adding a SKU..." lines of a PRD, by id. */
export function criteria(prd: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of prd.matchAll(/^\s*[-*]\s*\**(AC-\d+)\**[:.)]?\s*(.+)$/gm)) { out.set(m[1], m[2].trim()); }
  return out;
}

type Payload = Record<string, any>;

function planReview(p: Payload): { embeds: ReviewEmbed[]; files: ReviewFile[] } {
  const prd: string = p.prd ?? '';
  const acs = criteria(prd);
  const goal = prd.match(/##\s*Goal\s*\n+([\s\S]*?)(\n##|$)/)?.[1]?.trim() ?? '';
  const modules: { id: string; title: string }[] = p.plan?.modules ?? [];
  const coverage: Record<string, string[]> = p.plan?.coverage ?? {};
  const clauses: { id: string; text: string }[] = p.clauses ?? [];
  const uncovered = clauses.filter(c => !(coverage[c.id] ?? []).length);
  const covered = new Set(Object.values(coverage).flat());
  const extra = [...acs.keys()].filter(id => Object.keys(coverage).length && !covered.has(id));

  const fields = [
    field(`Modules (${modules.length})`, modules.map((m, i) => `${i + 1}. **${m.title}** \`${m.id}\``)),
    field(`Acceptance criteria (${acs.size})`, [...acs].map(([id, t]) => `**${id}** ${cut(t, 110)}`)),
  ];
  if (clauses.length) {
    fields.push(field('Requirement coverage', [
      uncovered.length ? `⚠️ Not covered: ${uncovered.map(c => `${c.id} "${cut(c.text, 60)}"`).join(', ')}` : `✅ All ${clauses.length} requirement sentences are covered`,
      extra.length ? `Added by the Planner (no sentence asks for it): ${extra.join(', ')}` : '',
    ]));
  }
  if (p.specIssue) { fields.push(field('⚠️ Why the plan came back', [String(p.specIssue)])); }
  const embeds: ReviewEmbed[] = [{ title: p.title, description: cut(goal, 1500), color: uncovered.length || p.specIssue ? AMBER : VIOLET, fields }];
  return { embeds, files: prd ? [{ name: 'PRD.md', text: prd }] : [] };
}

function codeReview(p: Payload): { embeds: ReviewEmbed[]; files: ReviewFile[] } {
  const t = p.tests;
  const files: { path: string; change: string; lines: number }[] = p.files ?? [];
  const reviews: { name: string; text: string }[] = p.reviews ?? [];
  const cost = Object.values((p.usage ?? {}) as Record<string, { costUsd?: number }>).reduce((a, u) => a + (u.costUsd ?? 0), 0);
  const sign = { added: '+', modified: '~', deleted: '-' } as Record<string, string>;
  const fields = [
    field('Tests', [t ? `${t.fail ? '❌' : '✅'} ${t.pass}/${t.total} pass${t.fail ? `, ${t.fail} fail` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}` : 'No test result'], true),
    field('Cost so far', [cost ? `$${cost.toFixed(2)}` : '-'], true),
    field(`Files changed (${files.length})`, files.slice(0, 25).map(f => `\`${sign[f.change] ?? ''} ${f.path}\` ${f.lines} lines`).concat(files.length > 25 ? [`and ${files.length - 25} more`] : [])),
  ];
  for (const r of reviews.slice(0, 3)) {
    const verdict = r.text.match(/VERDICT:\s*(\w+)/i)?.[1];
    fields.push(field(`${r.name}${verdict ? `: ${verdict}` : ''}`, [cut(r.text.replace(/VERDICT:\s*\w+/i, '').trim(), 900)]));
  }
  const failing = t?.fail || reviews.some(r => /VERDICT:\s*changes/i.test(r.text));
  const out: ReviewFile[] = p.patch ? [{ name: 'changes.diff', text: p.patch }] : [];
  for (const r of reviews) { out.push({ name: `${r.name.replace(/\W+/g, '-').toLowerCase()}.md`, text: r.text }); }
  return { embeds: [{ title: p.title, description: p.branch ? `Branch \`${p.branch}\`` : undefined, color: failing ? AMBER : GREEN, fields }], files: out };
}

function escalationReview(p: Payload): { embeds: ReviewEmbed[]; files: ReviewFile[] } {
  const reasons: string[] = p.reasons ?? [];
  const output: string = p.output ?? '';
  return {
    embeds: [{
      title: p.title,
      color: RED,
      description: cut(`${reasons.map(r => `• ${r}`).join('\n')}\n\n**Last test output**\n\`\`\`\n${output.slice(-1200)}\n\`\`\``, 4000),
      fields: [field('Your options', ['**Retry**: Dev tries again (your note goes to Dev)', '**Replan**: back to the Planner', '**Abort**: stop the run'])],
    }],
    files: output ? [{ name: 'test-output.txt', text: output }] : [],
  };
}

/** The review for one gate. Unknown kinds fall back to the title only. */
export function gateReview(payload: Payload): { embeds: ReviewEmbed[]; files: ReviewFile[] } {
  if (payload.kind === 'plan') { return planReview(payload); }
  if (payload.kind === 'code') { return codeReview(payload); }
  if (payload.kind === 'escalation') { return escalationReview(payload); }
  const reports: { name: string; files: { path: string; text: string }[] }[] = payload.reports ?? [];
  const fields = reports.slice(0, 8).map(r => field(r.name, r.files.map(f => `\`${f.path}\``)));
  if (payload.systemErrors?.length) { fields.push(field('⚠️ System diagram problems', payload.systemErrors)); }
  return {
    embeds: [{ title: payload.title, color: payload.systemErrors?.length ? AMBER : VIOLET, fields }],
    files: reports.flatMap(r => r.files.map(f => ({ name: f.path.split('/').pop()!, text: f.text }))).slice(0, 9),
  };
}
