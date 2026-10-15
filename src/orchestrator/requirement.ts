/**
 * The customer's requirement split into numbered clauses (R-1, R-2, ...), so every role can be
 * held to the original words.
 *
 * A clause is a sentence of a paragraph or bullet, one data row of a table, or a
 * whole fenced code block. Headings are context, not clauses.
 */
export interface Clause { id: string; text: string }

const MIN_CHARS = 12;

export function requirementClauses(requirement: string): Clause[] {
  const out: string[] = [];
  const lines = requirement.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const block = [line];
      while (++i < lines.length) {
        block.push(lines[i]);
        if (/^\s*```/.test(lines[i])) { break; }
      }
      out.push(block.join('\n'));
      continue;
    }
    const t = line.trim();
    if (!t || /^#{1,6}\s/.test(t)) { continue; }
    if (t.startsWith('|')) {
      // Header row (followed by a |---| line) and the separator itself are not clauses
      if (/^\|[\s:|-]+\|$/.test(t) || /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) { continue; }
      out.push(t);
      continue;
    }
    const body = t.replace(/^([-*+]|\d+[.)])\s+/, '');
    out.push(...splitSentences(body));
  }
  return out.filter(c => c.replace(/[`*_]/g, '').trim().length >= MIN_CHARS).map((text, n) => ({ id: `R-${n + 1}`, text }));
}

/** Split on ". " when the next part starts a new sentence, never inside `code`. */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0, inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') { inCode = !inCode; continue; }
    if (inCode || c !== '.' || text[i + 1] !== ' ') { continue; }
    const next = text.slice(i + 2);
    const prev = text.slice(Math.max(0, i - 4), i + 1);
    if (/\b(e\.g|i\.e|etc|vs)\.$/i.test(prev) || !/^[A-Z`*("'0-9]/.test(next)) { continue; }
    parts.push(text.slice(start, i + 1).trim());
    start = i + 2;
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** The clauses as a numbered list for prompts. */
export function clauseList(clauses: Clause[]): string {
  return clauses.map(c => `${c.id}: ${c.text.includes('\n') ? `\n${c.text}` : c.text}`).join('\n');
}
