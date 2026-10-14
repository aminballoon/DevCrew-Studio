// DevCrew Studio dashboard. Everything on screen is derived from the run's event log,
// replayed and then followed live over SSE.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0));
const fmtUsd = n => '$' + (n ?? 0).toFixed(n >= 10 ? 1 : 2);
const fmtTime = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDur = ms => {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return '–';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const S = { tab: 'pipeline', config: null, runs: [], selected: null, events: [], es: null, gateKey: null, raf: 0, focus: null, open: new Map() };

// ---------- Markdown (small, safe subset) ----------

function md(src) {
  const lines = esc(src ?? '').split('\n');
  let html = '', list = null, code = false, table = null;
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    html += `<div class="md-table"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    table = null;
  };
  const close = () => { closeTable(); if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    if (line.startsWith('```')) { close(); html += code ? '</pre>' : '<pre>'; code = !code; continue; }
    if (code) { html += line + '\n'; continue; }
    // Tables: rows of | cells |; the |---| line under the header is skipped
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!table) { close(); table = []; }
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(cells(line));
      continue;
    }
    closeTable();
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { close(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) { close(); }
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return html + (code ? '</pre>' : '');
}

// ---------- Stages ----------

const STAGES = {
  planner: { name: 'Planner', color: 'planner' },
  gate_spec: { name: 'Review the spec and plan', gate: 'plan' },
  qa: { name: 'QA', color: 'qa' },
  dev: { name: 'Dev', color: 'dev' },
  verify: { name: 'Verify', color: 'system' },
  escalate: { name: 'Escalation', gate: 'escalation' },
  reviewer: { name: 'Reviewer', color: 'reviewer' },
  gate_merge: { name: 'Approve the merge', gate: 'code' },
  finish: { name: 'Done' },
  single: { name: 'Single AI', color: 'single' },
};
const GATE_NODE = { spec: 'gate_spec', merge: 'gate_merge', escalation: 'escalate' };

/** The pipeline of the run on screen; runs from before pipelines used the standard one. */
let DEF = null;
const gateNode = g => GATE_NODE[g] ?? g;
/** "plan", "code" or "escalation". Runs from before pipelines used the gate ids spec and merge. */
const gateKind = g => ({ spec: 'plan', merge: 'code', escalation: 'escalation' })[g] ?? DEF?.steps.find(s => s.id === g)?.review ?? 'plan';
/** Name and colour for any box: built-in stages, and gates and roles from the pipeline file. */
function stageOf(id) {
  const step = DEF?.steps.find(s => s.id === id);
  if (step?.type === 'gate') return { name: step.title, gate: step.review };
  if (step?.type === 'agent') return { name: step.name, color: id === 'reviewer' ? 'reviewer' : 'custom', step };
  return STAGES[id] ?? { name: id, color: 'custom' };
}
const roleClass = r => (['planner', 'qa', 'dev', 'reviewer', 'single'].includes(r) ? r : 'custom');
const DECISION = { approve: 'Approved', revise: 'Changes requested', retry: 'Retry', replan: 'Back to planning', abort: 'Cancelled' };

// ---------- Steps: the run's log, grouped by which box did the work ----------

/** Split the event log into steps, one per stage visit, each owning the events that happened in it. */
function buildSteps(events) {
  const steps = [];
  const visits = {};
  let cur = null;
  const open = (node, e, extra = {}) => {
    visits[node] = (visits[node] ?? 0) + 1;
    cur = { id: `s${e.seq}`, node, visit: visits[node], start: e.ts, events: [], ...extra };
    steps.push(cur);
  };
  for (const e of events) {
    switch (e.type) {
      case 'run_started': open('start', e, { requirement: e.requirement, workspace: e.workspace }); break;
      case 'node_started': open(e.node, e, { module: e.module, attempt: e.attempt }); break;
      case 'gate_waiting': open(gateNode(e.gate), e, { gate: e.gate, waiting: true }); break;
      case 'gate_resolved':
        if (cur?.gate === e.gate && cur.waiting) { Object.assign(cur, { waiting: false, decision: e.decision, feedback: e.feedback, end: e.ts }); }
        else { open(gateNode(e.gate), e, { gate: e.gate, decision: e.decision, feedback: e.feedback, auto: true, end: e.ts }); }
        continue;
      case 'run_finished': open('finish', e, { status: e.status, error: e.error, end: e.ts }); break;
    }
    cur?.events.push(e);
  }
  steps.forEach((s, i) => {
    s.end ??= steps[i + 1]?.start;
    s.tokens = 0; s.cost = 0; s.guards = 0;
    for (const e of s.events) {
      if (e.type === 'usage') { s.tokens += e.totalTokens; s.cost += e.costUsd; }
      if (e.type === 'guard_violation') s.guards += e.files.length;
      if (e.type === 'verify_result') s.verify = e;
    }
  });
  return steps;
}

function buildModel(events) {
  const started = events.find(e => e.type === 'run_started');
  DEF = started?.pipeline ?? S.config?.standardPipeline ?? null;
  const steps = buildSteps(events);
  const m = { def: DEF, steps, status: 'running', stages: {}, edges: {}, lastEdge: null, gate: null, modules: new Map(), plan: null, fixes: 0, guards: 0, tokens: 0, cost: 0, byRole: {} };
  const st = id => (m.stages[id] ??= { state: 'idle', visits: 0 });
  for (const e of events) {
    if (e.type === 'run_started') Object.assign(m, { started: e.ts, requirement: e.requirement, label: e.label, profile: e.profile, workspace: e.workspace, mode: e.mode });
    if (e.type === 'gate_waiting') { m.gate = e; if (gateKind(e.gate) === 'plan' && e.payload.plan) m.plan = e.payload.plan; }
    if (e.type === 'gate_resolved' || e.type === 'run_finished') m.gate = null;
    if (e.type === 'verify_result') { m.lastVerify = e; if (!e.passed) m.fixes++; }
    if (e.type === 'guard_violation') m.guards += e.files.length;
    if (e.type === 'usage') {
      m.tokens += e.totalTokens; m.cost += e.costUsd;
      const r = (m.byRole[e.role] ??= { tokens: 0, cost: 0, input: 0, cached: 0, output: 0 });
      r.tokens += e.totalTokens; r.cost += e.costUsd; r.input += e.inputTokens - e.cachedReadTokens; r.cached += e.cachedReadTokens; r.output += e.outputTokens;
    }
    if (e.type === 'run_finished') Object.assign(m, { status: e.status, endedAt: e.ts, error: e.error });
    // A run resumed after it stopped or failed is running again
    if (e.type === 'node_started' && m.endedAt) Object.assign(m, { status: 'running', endedAt: undefined, error: undefined });
  }
  if (m.gate) m.status = 'waiting';
  // The server found nobody driving this run: it stopped mid-way and can be resumed
  if (m.status === 'running' && S.resume?.runId === S.selected && S.resume.resumable) m.status = 'stopped';
  const last = steps.at(-1);
  let prevNode = null, prevPassed = true;
  for (const s of steps) {
    if (s.node === 'start') continue;
    // Edges walked, for the diagram: verify → dev is either a fix or the next module
    if (prevNode && prevNode !== s.node) {
      const kind = (s.node === 'dev' || s.node === 'single') && prevNode === 'verify' ? (prevPassed ? ':next' : ':fix') : '';
      const key = `${prevNode}>${s.node}${kind}`;
      m.edges[key] = (m.edges[key] ?? 0) + 1;
      m.lastEdge = key;
    }
    prevNode = s.node;
    if (s.verify) prevPassed = s.verify.passed;

    const x = st(s.node);
    x.visits++;
    x.state = s === last && m.status === 'running' ? 'active' : s.waiting ? 'waiting' : 'done';
    if (s.verify) { x.lastVerify = s.verify; if (!s.verify.passed && s === last) x.state = 'failed'; }
    if (s.gate) x.decision = s.waiting ? 'waiting for you' : s.auto && s.decision === 'approve' ? 'auto-approved' : (DECISION[s.decision] ?? s.decision).toLowerCase();
    if (s.gate && s.decision === 'abort') x.state = 'failed';
    if (s.node === 'dev' && s.module) {
      const mod = m.modules.get(s.module) ?? { tries: [] };
      mod.tries.push('run');
      m.modules.set(s.module, mod);
      x.now = `${s.module} · #${s.attempt}`;
    }
    if (s.node === 'verify' && s.verify) {
      const mod = m.modules.get(s.verify.module);
      if (mod) mod.tries[mod.tries.length - 1] = s.verify.passed ? 'pass' : 'fail';
    }
    if (s.node === 'finish') x.state = ['approved', 'completed'].includes(m.status) ? 'done' : 'failed';
  }
  if (m.status === 'failed' && last && last.node !== 'finish') st(last.node).state = 'failed';
  const prev = steps.at(-2);
  if (m.status === 'failed' && last?.node === 'finish' && prev && prev.node !== 'start') st(prev.node).state = 'failed';
  m.active = m.status === 'running' ? last : null;
  return m;
}

/** One plain sentence: what is happening right now. */
function nowSentence(m) {
  if (m.status === 'waiting' && m.gate) {
    const title = stageOf(gateNode(m.gate.gate)).name;
    if (gateKind(m.gate.gate) === 'plan') return ['wait', `Waiting for you to review the spec and plan (“${title}”). Approve or ask for changes in the box below.`];
    if (gateKind(m.gate.gate) === 'design') return ['wait', `Waiting for you to review the design (“${title}”). The system diagram and reports are in the box below.`];
    if (gateKind(m.gate.gate) === 'code') return ['wait', `The AI team is done. Waiting for your decision (“${title}”). The changed files and reviews are in the box below.`];
    return ['bad', `Dev tried module ${m.gate.payload.module} ${m.gate.payload.attempts} times and it still fails. Your decision is needed.`];
  }
  const sum = `${m.lastVerify ? `${m.lastVerify.tests.pass}/${m.lastVerify.tests.total} tests passing · ` : ''}took ${fmtDur((m.endedAt ?? Date.now()) - m.started)} · ${fmtTok(m.tokens)} tokens (${fmtUsd(m.cost)})`;
  if (m.status === 'approved') return ['ok', `Done and committed. ${sum}`];
  if (m.status === 'completed') return ['ok', `Finished. ${sum}`];
  if (m.status === 'stopped') return ['bad', 'Stopped: the process running this run ended before it finished (closed terminal, crash or restart).'];
  if (m.status === 'failed') return ['bad', `Failed: ${m.error ?? 'see the activity log'}`];
  if (m.status === 'aborted') return ['muted', 'Cancelled'];
  const a = m.active;
  if (!a) return ['run', 'Starting…'];
  const text = {
    start: 'Preparing the workspace',
    planner: a.visit > 1 ? 'Planner is updating the plan based on your feedback' : 'Planner is reading the task and making a plan',
    qa: 'QA is writing tests from the spec (no code exists yet)',
    dev: `Dev is writing module ${a.module} (attempt ${a.attempt})`,
    verify: `The system is running the tests${a.module ? ` for module ${a.module}` : ''}`,
    reviewer: 'Reviewer is checking the code',
    single: a.attempt > 1 ? `The single AI is fixing its work (fix round ${a.attempt - 1})` : 'The single AI is doing the whole task',
  }[a.node] ?? `Working on ${a.node}`;
  return ['run', text];
}

// ---------- Pipeline diagram ----------

const SINGLE_NODES = [
  { id: 'single', x: 330, label: 'Single AI', role: 'WHOLE TASK', agentRole: 'single' },
  { id: 'verify', x: 640, label: 'Verify', role: 'NO AI · JUDGE' },
  { id: 'finish', x: 920, label: 'Done', role: 'END' },
];
const Y = 125, W = 116, H = 62, D = 30;
let layout;
const pos = id => { const n = layout.nodes.find(n => n.id === id); return { x: n.x, y: n.y ?? Y, gate: n.gate }; };
const top = p => ({ x: p.x, y: p.y - (p.gate ? D : H / 2) });
const bottom = p => ({ x: p.x, y: p.y + (p.gate ? D : H / 2) });
const left = p => ({ x: p.x - (p.gate ? D : W / 2), y: p.y });
const right = p => ({ x: p.x + (p.gate ? D : W / 2), y: p.y });
const straight = (a, b) => [right(a), right(a), left(b)];
/** A detour drawn above the row; the further it jumps, the higher it arcs. */
const arcAbove = (dx0 = 0, dx1 = 20) => (a, b) => [
  { x: a.x + dx0, y: top(a).y }, { x: (a.x + b.x) / 2, y: top(a).y - (40 + Math.min(120, Math.abs(a.x - b.x) / 6)) }, { x: b.x + dx1, y: top(b).y },
];

const SINGLE_EDGES = [
  ['single', 'verify', '', '', straight],
  ['verify', 'single', 'back fix', 'fix', (a, b) => [top(a), { x: (a.x + b.x) / 2, y: 22 }, top(b)]],
  ['verify', 'finish', '', '', straight],
  ['single', 'finish', 'back', 'no external check', (a, b) => [bottom(a), { x: (a.x + b.x) / 2, y: 250 }, bottom(b)]],
];

/** Boxes and arrows for a pipeline definition: one box per step, in order, plus Done. */
function pipelineLayout(def) {
  const nodes = [];
  let gateNo = 0;
  const fast = def.kind === 'fast';
  for (const s of def.steps) {
    if (s.type === 'planner') nodes.push({ id: 'planner', label: 'Planner', role: 'PO + ARCHITECT', agentRole: 'planner' });
    else if (s.type === 'qa') nodes.push({ id: 'qa', label: 'QA', role: fast ? 'HIDDEN TESTS' : 'TESTS FIRST', agentRole: 'qa' });
    else if (s.type === 'build') nodes.push({ id: 'dev', label: fast ? 'Builder' : 'Developer', role: fast ? 'SAME TIME AS QA' : 'PER MODULE', agentRole: 'dev' }, { id: 'verify', label: 'Verify', role: 'NO AI · JUDGE' });
    else if (s.type === 'gate') nodes.push({ id: s.id, label: `Gate ${++gateNo}`, gate: true, sub: { plan: 'Plan', code: 'Code', design: 'Design', architecture: 'Architecture' }[s.review] });
    else nodes.push({
      id: s.id, label: s.name.length > 15 ? `${s.name.slice(0, 14)}…` : s.name, agentRole: s.id,
      role: s.instructions === 'builtin:reviewer' ? 'CODE REVIEW' : s.verdict?.onChanges === 'dev' ? 'CAN SEND BACK' : 'ADVISORY',
    });
  }
  nodes.push({ id: 'finish', label: 'Done', role: 'COMMIT' });
  const width = Math.max(1200, 160 + 140 * (nodes.length - 1));
  nodes.forEach((n, i) => { n.x = 80 + i * (width - 160) / (nodes.length - 1); });
  const dev = nodes.find(n => n.id === 'dev'), verify = nodes.find(n => n.id === 'verify');
  const edges = nodes.slice(0, -1).map((n, i) => [n.id, nodes[i + 1].id, '', '', straight]);
  // Detours, drawn only once they happen
  for (const s of def.steps) {
    if (s.type === 'gate') edges.push([s.id, s.reviseTo === 'build' ? 'dev' : s.reviseTo, 'back', s.reviseTo === 'build' ? 'changes' : 'revise', arcAbove(0, s.reviseTo === 'build' ? -4 : 20)]);
    if (s.type === 'agent' && s.verdict?.onChanges === 'dev') edges.push([s.id, 'dev', 'back', 'changes', arcAbove(0, -12)]);
  }
  // A design pipeline builds nothing: no Dev, Verify or escalation
  if (!dev) return { nodes, edges, width };
  nodes.push({ id: 'escalate', x: (dev.x + verify.x) / 2, y: 240, label: 'Escalate', gate: true, sub: 'Human' });
  edges.push(
    ['verify', 'dev', 'back fix', 'fix', arcAbove(0, 22)],
    ['dev', 'planner', 'back', 'spec issue', arcAbove(-22, -20)],
    ['verify', 'dev', 'back next', 'next module', (a, b) => [{ x: a.x - 20, y: bottom(a).y }, { x: (a.x + b.x) / 2, y: 200 }, { x: b.x + 20, y: bottom(b).y }]],
    ['verify', 'escalate', 'back', '', (a, b) => [{ x: a.x + 10, y: bottom(a).y }, { x: a.x + 10, y: b.y }, right(b)]],
    ['escalate', 'dev', 'back', 'retry', (a, b) => [left(a), { x: b.x - 10, y: a.y }, { x: b.x - 10, y: bottom(b).y }]],
    ['escalate', 'planner', 'back', 'replan', (a, b) => [left(a), { x: b.x, y: a.y }, bottom(b)]],
  );
  return { nodes, edges, width };
}

function edgeKey([from, to, kind]) {
  if (kind.includes('fix')) return `${from}>${to}:fix`;
  if (kind.includes('next')) return `${from}>${to}:next`;
  return `${from}>${to}`;
}

/**
 * The diagram for a run, or (preview) for a pipeline being reviewed, where every
 * detour is drawn faintly so you can see where work can be sent back.
 */
function renderPipeline(m, preview = false) {
  layout = m.mode === 'single' ? { nodes: SINGLE_NODES, edges: SINGLE_EDGES, width: 1080 } : pipelineLayout(m.def ?? DEF);
  const roles = S.config?.roles?.[m.profile] ?? {};
  const markers = ['', 'used', 'fail'].map(c =>
    `<marker id="arr${c ? '-' + c : ''}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrow ${c}"/></marker>`).join('');
  let edges = '', labels = '';
  for (const e of layout.edges) {
    const [from, to, kind, label, path] = e;
    const key = edgeKey(e);
    const count = m.edges[key] ?? 0;
    // Unused detours stay hidden in a run: they only add noise until they happen
    if (kind.includes('back') && !count && !(preview && from !== 'escalate' && to !== 'escalate')) continue;
    const [p0, c, p1] = path(pos(from), pos(to));
    const fail = kind.includes('fix') && count > 0;
    const cls = ['edge', kind.includes('back') ? 'back' : '', count ? 'used' : '', fail ? 'fail' : '', m.lastEdge === key && m.status === 'running' ? 'last' : ''].join(' ');
    edges += `<path class="${cls}" d="M${p0.x} ${p0.y} Q${c.x} ${c.y} ${p1.x} ${p1.y}" marker-end="url(#${count ? (fail ? 'arr-fail' : 'arr-used') : 'arr'})"/>`;
    if (label) {
      const lx = (p0.x + 2 * c.x + p1.x) / 4, ly = (p0.y + 2 * c.y + p1.y) / 4 - 5;
      labels += `<text class="e-label ${count ? 'used' : ''} ${fail ? 'fail' : ''}" x="${lx}" y="${ly}" text-anchor="middle">${esc(count > 1 || fail ? `${label} ×${count}` : label)}</text>`;
    }
  }
  let nodes = '';
  for (const n of layout.nodes) {
    const st = m.stages[n.id] ?? { state: 'idle', visits: 0 };
    if (n.id === 'escalate' && !st.visits) continue;
    const { x, y } = pos(n.id);
    let sub = n.agentRole ? roles[n.agentRole] ?? (DEF?.steps.find(s => s.id === n.id)?.agent ?? roles.reviewer ?? '') : '';
    if (preview) sub = n.agentRole && !['planner', 'qa', 'dev'].includes(n.agentRole) ? DEF?.steps.find(s => s.id === n.id)?.agent ?? '' : '';
    if (n.id === 'dev' && st.now) sub = st.now;
    if (n.id === 'verify' && st.lastVerify) sub = `${st.lastVerify.tests.pass}/${st.lastVerify.tests.total} tests ${st.lastVerify.passed ? 'pass' : 'fail'}`;
    if (n.id === 'single' && st.visits > 1) sub = `${roles.single ?? ''} · ${plural(st.visits, 'turn')}`;
    if (n.id === 'finish') sub = m.status === 'approved' ? 'committed' : ['running', 'waiting', 'preview'].includes(m.status) ? '' : m.status;
    const clickable = preview || st.visits;
    const cls = `node ${st.state} ${clickable ? 'clickable' : ''} ${S.popup === n.id && $('#role-dialog')?.open ? 'focus' : ''}`;
    const tip = `<title>${preview ? 'Click to see this step in detail' : st.visits ? 'Click to see what this role received, did and handed on' : 'Not reached yet'}</title>`;
    if (n.gate) {
      sub = st.visits ? st.decision ?? n.sub : n.sub;
      const pts = `${x},${y - D} ${x + D},${y} ${x},${y + D} ${x - D},${y}`;
      nodes += `<g class="${cls}" data-node="${n.id}">${tip}
        <polygon class="n-halo" points="${pts}"/><polygon class="n-box" points="${pts}"/>
        <text class="n-title" x="${x}" y="${y + 4}" text-anchor="middle" style="font-size:11px">${n.label}</text>
        <text class="n-sub" x="${x}" y="${y + D + 15}" text-anchor="middle">${esc(sub)}</text>
        ${st.visits > 1 ? badge(x + D - 4, y - D + 6, st.visits) : ''}</g>`;
    } else {
      nodes += `<g class="${cls} ${n.agentRole && !STAGES[n.id] ? 'custom' : ''}" data-node="${n.id}">${tip}
        <rect class="n-halo" x="${x - W / 2}" y="${y - H / 2}" width="${W}" height="${H}" rx="12"/>
        <rect class="n-box" x="${x - W / 2}" y="${y - H / 2}" width="${W}" height="${H}" rx="12"/>
        <text class="n-role" x="${x}" y="${y - 12}" text-anchor="middle">${n.role}</text>
        <text class="n-title" x="${x}" y="${y + 5}" text-anchor="middle">${esc(n.label)}</text>
        <text class="n-sub" x="${x}" y="${y + 21}" text-anchor="middle">${esc(sub)}</text>
        ${st.visits > 1 ? badge(x + W / 2 - 6, y - H / 2 + 2, st.visits) : ''}</g>`;
    }
  }
  return `<svg viewBox="0 -50 ${layout.width} 345" role="img" aria-label="Pipeline diagram"><defs>${markers}</defs>${edges}${nodes}${labels}</svg>`;
}
const badge = (x, y, n) => `<circle class="badge-bg" cx="${x}" cy="${y}" r="9"/><text class="badge-tx" x="${x}" y="${y + 3.5}" text-anchor="middle">×${n}</text>`;

// ---------- Run view ----------

function renderRun() {
  const view = $('#run-view');
  if (!S.selected) {
    view.innerHTML = `<div class="empty"><h2>No run selected</h2><p>Click <b>+ New run</b> to start one, or pick a run on the left.</p>
      <p class="hint">First time? Choose the <code>fake</code> agent to watch every step without using any quota.</p></div>`;
    return;
  }
  view.innerHTML = `
    <div id="run-head"></div>
    <div id="now" class="now"></div>
    <div id="resume-slot"></div>
    <div class="stats" id="stats"></div>
    <section class="card pipeline"><div class="card-head"><h3>Pipeline</h3><span class="hint">Click a box to see what that role received, did and handed on</span></div>
      <div class="pipeline-wrap" id="flow"></div></section>
    <section class="card" id="arch-card"><div class="card-head"><h3>Code architecture <span class="hint">designed by the Planner, reviewed by you at Gate 1</span></h3><span class="hint" id="arch-status"></span></div>
      <div class="card-body" id="arch"></div></section>
    <section class="card" id="design-card" hidden><div class="card-head"><h3>System design and reports <span class="hint">what the roles wrote, kept after every gate</span></h3><span class="hint" id="design-status"></span></div>
      <div class="card-body" id="design"></div></section>
    <section class="card"><div class="card-head"><h3>What happened, in plain words</h3><span class="hint">For anyone, no coding knowledge needed</span></div>
      <div class="card-body" id="story"></div></section>
    <section class="card"><div class="card-head"><h3>Handoffs: who gives what to whom <span class="hint">(technical view)</span></h3><span class="hint">Hover a file to see where it goes · click it to read it</span></div>
      <div class="card-body" id="handoffs"></div></section>
    <div id="gate-slot"></div>
    <div class="run-grid">
      <section class="card"><div class="card-head"><h3>Activity log</h3><span class="hint">Oldest first · click a heading to open or close it</span></div><div class="steps" id="steps"></div></section>
      <div>
        <section class="card" id="modules-card"><div class="card-head"><h3>Progress per module</h3></div><div class="card-body" id="modules"></div></section>
        <section class="card"><div class="card-head"><h3>Tokens by role</h3></div><div class="card-body" id="usage"></div></section>
      </div>
    </div>`;
  S.gateKey = null;
  S.archKey = null;
  S.designKey = null;
  S.designTab = null;
  update(true);
}

function update(first = false) {
  if (!$('#run-head')) return;
  const m = buildModel(S.events);
  const title = m.label || (m.requirement ?? '').split('\n')[0].replace(/[`*#]/g, '').slice(0, 90);
  const statusText = { running: 'Running', stopped: 'Stopped', waiting: 'Waiting for you', approved: 'Done · committed', completed: 'Finished', failed: 'Failed', aborted: 'Cancelled' }[m.status];
  $('#run-head').innerHTML = `<div class="run-head"><div><h1>${esc(title)}</h1>
    <div class="meta"><span>${m.mode === 'single' ? 'Single AI mode' : 'AI team mode'}</span><span>agent: <b>${esc(m.profile)}</b></span><span>started ${m.started ? fmtTime(m.started) : ''}</span><span class="mono">${esc(S.selected)}</span></div></div>
    <span class="pill ${m.status}">${statusText}</span></div>`;
  const [tone, sentence] = nowSentence(m);
  $('#now').className = `now ${tone}`;
  $('#now').textContent = sentence;
  renderResume(m);
  // A design pipeline writes no code: no tests, modules or code architecture to show
  const design = DEF?.kind === 'design';
  // A fast run has no Planner, so no designed architecture to show
  $('#arch-card').hidden = design || DEF?.kind === 'fast';
  $('#modules-card').hidden = design;
  $('#stats').innerHTML = [
    ['Time', `<span data-elapsed="${m.started}" data-ended="${m.endedAt ?? ''}">${fmtDur((m.endedAt ?? Date.now()) - m.started)}</span>`, ''],
    ['Tokens', fmtTok(m.tokens), 'How much text the AIs read and wrote, in total'],
    ['Cost (API price)', fmtUsd(m.cost), 'What this would cost at API prices, even though we pay a monthly plan'],
    ['Tests passing', m.lastVerify ? `${m.lastVerify.tests.pass}<small> / ${m.lastVerify.tests.total}</small>` : '–', 'Latest check'],
    ['Fix rounds · Files blocked', `${m.fixes} <small>·</small> ${m.guards}`, 'Times the tests failed and work went back to Dev · files an AI tried to change without permission'],
  ].filter(([l]) => !design || !['Tests passing', 'Fix rounds · Files blocked'].includes(l)).map(([l, v, h]) => `<div class="stat" ${h ? `title="${h}"` : ''}><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
  $('#flow').innerHTML = renderPipeline(m);
  renderArchCard(m);
  renderDesignCard(m);
  renderStory(m);
  renderHandoffs(m);
  renderSteps(m, first);
  renderModules(m);
  renderUsage(m);
  renderGate(m);
}


// ---------- Code architecture: the planned files as a UML-style diagram ----------

const KIND_WRITER = { contract: 'planner', doc: 'planner', source: 'dev', config: 'dev', test: 'qa' };
const KIND_ORDER = { contract: 0, config: 1, source: 2, doc: 3, test: 4 };

/** The architecture from the latest plan.json the Planner handed over. */
/** Acceptance criteria in a PRD: "AC-3" → the rest of its line, without markdown emphasis. */
function prdCriteria(prd) {
  const out = new Map();
  for (const line of (prd ?? '').split('\n')) {
    const m = line.match(/\b(AC-\d+)\b\**\s*[:.)—–-]?\s*\**\s*(.*)$/);
    if (m && !out.has(m[1])) out.set(m[1], m[2].replace(/[*_`]/g, '').trim());
  }
  return out;
}

/** Each requirement clause with the criteria the Planner says cover it (runs from before clauses have none). */
function coverageRows(payload) {
  const clauses = payload.clauses ?? [];
  const coverage = payload.plan?.coverage ?? {};
  const criteria = prdCriteria(payload.prd);
  const rows = clauses.map(c => ({ ...c, acs: (coverage[c.id] ?? []).map(id => ({ id, text: criteria.get(id), known: criteria.has(id) })) }));
  const linked = new Set(rows.flatMap(r => r.acs.map(a => a.id)));
  const extra = [...criteria].filter(([id]) => !linked.has(id)).map(([id, text]) => ({ id, text }));
  return { rows, extra, covered: rows.filter(r => r.acs.some(a => a.known)).length };
}

function coverageButton(payload) {
  if (!payload.clauses?.length) return '';
  const { rows, covered } = coverageRows(payload);
  return `<button type="button" data-pane="coverage">Requirement coverage (${covered}/${rows.length})</button>`;
}

function coveragePane(payload) {
  if (!payload.clauses?.length) return '';
  const { rows, extra, covered } = coverageRows(payload);
  const chip = a => `<span class="chip ${a.known ? '' : 'bad'}" title="${esc(a.known ? a.text : 'Not found in the spec')}">${esc(a.id)}</span>`;
  return `<div data-pane="coverage" hidden>
    <p class="hint">Your requirement, split into its sentences, and the acceptance criteria in the spec that cover each one. QA tests these criteria, and every role also gets your sentences as the final word. Check that each criterion says everything its sentence says; hover a criterion to read it.</p>
    ${covered < rows.length ? `<div class="banner warn">${plural(rows.length - covered, 'sentence')} of your requirement ${rows.length - covered === 1 ? 'is' : 'are'} not covered by the spec.</div>` : ''}
    <div class="table-wrap"><table class="results coverage-table">
      <thead><tr><th>#</th><th>Your requirement</th><th>Covered by</th></tr></thead>
      <tbody>${rows.map(r => `<tr class="${r.acs.some(a => a.known) ? '' : 'uncovered'}"><td>${esc(r.id)}</td><td class="wrap">${r.text.includes('\n') ? `<pre>${esc(r.text)}</pre>` : esc(r.text)}</td><td class="acs">${r.acs.length ? r.acs.map(chip).join(' ') : '<span class="chip bad">None</span>'}</td></tr>`).join('')}</tbody>
    </table></div>
    ${extra.length ? `<h4 style="margin-top:14px">Added by the Planner (${extra.length})</h4><p class="hint">Criteria in the spec that no sentence of your requirement asks for. They can be sensible details or scope you did not ask for.</p>
      <ul class="coverage-extra">${extra.map(a => `<li><span class="chip">${esc(a.id)}</span> ${esc(a.text)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function plannedArchitecture() {
  const versions = archVersions();
  return (versions.find(x => x.version === S.archVersion) ?? versions.at(-1))?.files ?? null;
}

const relation = (from, to) => from.kind === 'test' ? 'tests' : to.kind === 'contract' ? 'implements' : 'uses';

/**
 * Files in columns by dependency depth: what others build on sits on the left,
 * what uses it to the right. Arrows are drawn afterwards by drawArch().
 * `built` (optional) maps path to the role that wrote it, to show progress.
 */
function renderArch(files, built, plan, changes = null) {
  if (!files?.length) return '<p class="hint">The Planner has not described the files yet.</p>';
  const byPath = new Map(files.map(f => [f.path, f]));
  const level = new Map();
  const depth = (f, seen = new Set()) => {
    if (level.has(f.path)) return level.get(f.path);
    if (seen.has(f.path)) return 0;
    seen.add(f.path);
    const deps = (f.dependsOn ?? []).map(d => byPath.get(d)).filter(Boolean);
    const d = deps.length ? 1 + Math.max(...deps.map(x => depth(x, seen))) : 0;
    level.set(f.path, d);
    return d;
  };
  files.forEach(f => depth(f));
  // Tests sit together in the last column, right of everything they check
  const lastCode = Math.max(0, ...files.filter(f => f.kind !== 'test').map(f => level.get(f.path)));
  for (const f of files) if (f.kind === 'test') level.set(f.path, lastCode + 1);
  const cols = [];
  for (const f of files) (cols[level.get(f.path)] ??= []).push(f);
  const partName = id => plan?.modules?.find(m => m.id === id)?.title ?? id;
  const box = f => {
    const name = f.path.split('/').pop(), dir = f.path.slice(0, -name.length);
    const writer = KIND_WRITER[f.kind] ?? 'dev';
    const state = !built ? '' : built.has(f.path)
      ? `<span class="arch-state ok">Built by ${COLUMN_NAME[built.get(f.path)] ?? built.get(f.path)}</span>`
      : '<span class="arch-state">Not built yet</span>';
    const tag = changes?.added.includes(f.path) ? '<span class="uml-new">New</span>' : changes?.changed.includes(f.path) ? '<span class="uml-new changed">Changed</span>' : '';
    return `<div class="uml ${f.kind} ${tag ? 'is-new' : ''}" data-arch="${esc(f.path)}">
      <div class="uml-head">${tag}<span class="uml-kind">«${esc(f.kind)}»</span><b>${esc(name)}</b><span class="uml-dir">${esc(dir)}</span></div>
      <div class="uml-sec">${esc(f.purpose)}</div>
      ${f.exports?.length ? `<div class="uml-sec uml-exports">${f.exports.map(x => `<div>+ ${esc(x)}</div>`).join('')}</div>` : ''}
      <div class="uml-foot"><span>${f.modules?.length ? `Part: ${f.modules.map(partName).map(esc).join(', ')}` : 'Shared by all parts'}</span><span>Written by ${COLUMN_NAME[writer]}</span>${state}</div>
    </div>`;
  };
  const extra = built ? [...built.keys()].filter(p => !byPath.has(p) && !p.startsWith('.devcrew/')) : [];
  return `<div class="arch">
      <div class="arch-cols">${cols.filter(Boolean).map(c => `<div class="arch-col">${c.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.path.localeCompare(b.path)).map(box).join('')}</div>`).join('')}</div>
      <svg class="arch-edges"></svg>
    </div>
    <div class="legend arch-legend"><span><i class="ln implements"></i>implements (follows the contract)</span><span><i class="ln uses"></i>uses</span><span><i class="ln tests"></i>tests</span>
      <span><i class="sw k-contract"></i>contract</span><span><i class="sw k-source"></i>source</span><span><i class="sw k-test"></i>test</span><span><i class="sw k-config"></i>config / doc</span></div>
    ${extra.length ? `<div class="banner warn">Not in the approved architecture: ${extra.map(p => `<code>${esc(p)}</code>`).join(', ')}</div>` : ''}
    <details class="arch-table"><summary>Every file in a table</summary><div class="table-wrap"><table class="results">
      <tr><th>File</th><th>Type</th><th>Part</th><th>Written by</th><th>What it does</th><th>Uses</th>${built ? '<th>Status</th>' : ''}</tr>
      ${files.map(f => `<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.kind)}</td><td>${f.modules?.length ? f.modules.map(partName).map(esc).join(', ') : 'all'}</td>
        <td>${COLUMN_NAME[KIND_WRITER[f.kind]] ?? ''}</td><td class="wrap">${esc(f.purpose)}</td><td>${(f.dependsOn ?? []).map(d => `<code>${esc(d)}</code>`).join(' ') || '–'}</td>
        ${built ? `<td>${built.has(f.path) ? '<span class="yes">Built</span>' : '<span class="hint">Not yet</span>'}</td>` : ''}</tr>`).join('')}
    </table></div></details>`;
}

/** Draw the dependency arrows between the boxes once they are laid out. */
function drawArch(root, files) {
  const wrap = root?.querySelector('.arch');
  if (!wrap || !files) return;
  const svg = wrap.querySelector('.arch-edges');
  const base = wrap.getBoundingClientRect();
  svg.setAttribute('width', wrap.scrollWidth);
  svg.setAttribute('height', wrap.scrollHeight);
  const rect = path => {
    const el = wrap.querySelector(`.uml[data-arch="${CSS.escape(path)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left - base.left + wrap.scrollLeft, r: r.right - base.left + wrap.scrollLeft, t: r.top - base.top, b: r.bottom - base.top };
  };
  const byPath = new Map(files.map(f => [f.path, f]));
  let paths = '';
  for (const f of files) {
    for (const d of f.dependsOn ?? []) {
      const to = byPath.get(d), a = rect(f.path), b = rect(d);
      if (!to || !a || !b) continue;
      const rel = relation(f, to);
      // From the user (right) to what it relies on (left)
      const x1 = a.l, y1 = (a.t + a.b) / 2, x2 = b.r, y2 = (b.t + b.b) / 2, mx = (x1 + x2) / 2;
      paths += `<path class="arch-edge ${rel}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 + 2} ${y2}" marker-end="url(#arch-${rel})"/>`;
    }
  }
  svg.innerHTML = `<defs>
    <marker id="arch-implements" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto"><path d="M1 1L11 6L1 11z" class="arch-head hollow"/></marker>
    <marker id="arch-uses" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10" class="arch-head open"/></marker>
    <marker id="arch-tests" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10" class="arch-head open"/></marker>
  </defs>${paths}`;
}

/**
 * Every architecture the Planner handed over, oldest first, with what happened at review:
 * { version, seq, ts, plan, files, review: { decision, feedback, auto, ts } | null }.
 */
function archVersions() {
  const versions = [];
  for (const e of S.events) {
    if (e.type === 'agent_output' && e.role === 'planner') {
      const f = e.files.find(x => x.path === '.devcrew/plan.json');
      if (!f?.content) continue;
      let plan = null;
      try { plan = JSON.parse(f.content); } catch { continue; }
      if (!plan?.architecture?.files?.length) continue;
      // A fix of an invalid plan within the same review round replaces the previous version
      const last = versions.at(-1);
      if (last && !last.review) versions.pop();
      versions.push({ version: versions.length + 1, seq: e.seq, ts: e.ts, plan, files: plan.architecture.files, review: null });
    }
    if (e.type === 'gate_resolved' && gateKind(e.gate) === 'plan' && versions.at(-1) && !versions.at(-1).review) {
      versions.at(-1).review = { decision: e.decision, feedback: e.feedback, ts: e.ts, auto: !S.events.some(x => x.type === 'gate_waiting' && x.gate === e.gate && x.seq < e.seq && x.seq > versions.at(-1).seq) };
    }
  }
  return versions;
}

/** What changed between two versions of the design. */
function archDiff(prev, next) {
  if (!prev) return null;
  const a = new Map(prev.files.map(f => [f.path, f])), b = new Map(next.files.map(f => [f.path, f]));
  const added = [...b.keys()].filter(p => !a.has(p));
  const removed = [...a.keys()].filter(p => !b.has(p));
  const changed = [...b.keys()].filter(p => a.has(p) && JSON.stringify(a.get(p)) !== JSON.stringify(b.get(p)));
  return { added, removed, changed };
}

function diffBanner(v, prev) {
  const d = archDiff(prev, v);
  if (!d) return '';
  const fb = prev.review?.feedback ? ` after you asked: ${quote(prev.review.feedback)}` : '';
  if (!d.added.length && !d.removed.length && !d.changed.length) return `<div class="banner info">Version ${v.version}${fb}. No file changes from version ${prev.version}.</div>`;
  return `<div class="banner info">Version ${v.version}${fb}. Compared with version ${prev.version}:
    ${d.added.length ? `<div><b>Added</b> ${d.added.map(p => `<code>${esc(p)}</code>`).join(', ')}</div>` : ''}
    ${d.removed.length ? `<div><b>Removed</b> ${d.removed.map(p => `<code>${esc(p)}</code>`).join(', ')}</div>` : ''}
    ${d.changed.length ? `<div><b>Changed</b> ${d.changed.map(p => `<code>${esc(p)}</code>`).join(', ')}</div>` : ''}</div>`;
}

function reviewText(v, m) {
  if (!v.review) return m.gate && gateKind(m.gate.gate) === 'plan' ? 'Waiting for your review at Gate 1' : 'Not reviewed yet';
  if (v.review.auto && v.review.decision === 'approve') return `Approved automatically (benchmark mode) at ${fmtTime(v.review.ts)}`;
  if (v.review.decision === 'approve') return `Approved by you at ${fmtTime(v.review.ts)}`;
  if (v.review.decision === 'revise') return `You asked for changes at ${fmtTime(v.review.ts)}`;
  return `Rejected at ${fmtTime(v.review.ts)}`;
}

function renderArchCard(m) {
  const el = $('#arch');
  const versions = archVersions();
  const built = new Map([...latestFiles()].map(([p, f]) => [p, f.role]));
  if (S.archVersion && !versions.some(v => v.version === S.archVersion)) S.archVersion = null;
  const v = versions.find(x => x.version === S.archVersion) ?? versions.at(-1);
  const key = JSON.stringify([versions.map(x => [x.seq, x.review]), v?.version, [...built.keys()].sort(), m.status]);
  if (key === S.archKey) return;
  S.archKey = key;
  $('#arch-status').textContent = v ? `Version ${v.version} · ${reviewText(v, m)}` : '';
  if (!v) { el.innerHTML = '<p class="hint">The Planner proposes the architecture together with the spec, and sends both to you at Gate 1.</p>'; return; }
  const isLatest = v === versions.at(-1);
  el.innerHTML = `${versions.length > 1 ? `<div class="subtabs">${versions.map(x => `<button type="button" class="${x === v ? 'on' : ''}" data-arch-version="${x.version}">Version ${x.version} · ${x.review ? (x.review.decision === 'approve' ? 'approved' : x.review.decision === 'revise' ? 'changes asked' : 'rejected') : 'in review'}</button>`).join('')}</div>` : ''}
    ${diffBanner(v, versions[v.version - 2])}
    ${renderArch(v.files, isLatest ? built : null, v.plan, archDiff(versions[v.version - 2], v))}`;
  requestAnimationFrame(() => drawArch(el, v.files));
}

// ---------- System design and reports: everything the roles wrote under .devcrew/ ----------

/** Every version of the system diagram, in the order roles handed it on. */
function systemVersions() {
  const versions = [];
  for (const e of S.events) {
    if (e.type !== 'agent_output') continue;
    const f = e.files.find(x => x.path === '.devcrew/system.json' && x.change !== 'deleted');
    if (!f?.content) continue;
    let sys = null;
    try { sys = JSON.parse(f.content); } catch { continue; }
    if (!Array.isArray(sys?.blocks) || !Array.isArray(sys?.links)) continue;
    versions.push({ version: versions.length + 1, seq: e.seq, role: e.role, sys });
  }
  return versions;
}

/** Latest reports per agent step: text files it wrote under .devcrew/ (not the plan, diagram or contracts). */
function stepReports() {
  const steps = (DEF?.steps ?? []).filter(x => x.type === 'agent');
  const files = latestFiles();
  return steps.flatMap(step => {
    const own = [...files.values()].filter(f => f.role === step.id && f.path.startsWith('.devcrew/') && f.path !== '.devcrew/system.json' && f.content && !/\.(?:bin|log)$/.test(f.path));
    return own.length ? [{ step: step.id, name: step.name, files: own.sort((a, b) => (/\.md$/.test(b.path) - /\.md$/.test(a.path)) || a.path.localeCompare(b.path)) }] : [];
  });
}

function renderDesignCard(m) {
  const card = $('#design-card'), el = $('#design');
  const versions = systemVersions(), reports = stepReports();
  card.hidden = !versions.length && !reports.length;
  if (card.hidden) return;
  const tabs = [
    ...versions.map(v => ({ id: `v${v.version}`, label: versions.length > 1 ? `Diagram v${v.version} · ${stageOf(v.role).name}` : 'System diagram' })),
    ...reports.map(r => ({ id: `r:${r.step}`, label: r.name })),
  ];
  if (!tabs.some(t => t.id === S.designTab)) S.designTab = versions.length ? `v${versions.at(-1).version}` : tabs[0].id;
  const key = JSON.stringify([S.designTab, versions.map(v => v.seq), reports.map(r => r.files.map(f => f.seq ?? f.path + f.lines))]);
  if (key === S.designKey) return;
  S.designKey = key;
  const last = versions.at(-1);
  $('#design-status').textContent = last ? `${plural(last.sys.blocks.length, 'block')} · ${plural(last.sys.links.length, 'link')}${last.sys.blocks.some(b => b.part) ? ` · ${last.sys.blocks.filter(b => b.part).length} with a part chosen` : ''}` : '';
  const v = versions.find(x => `v${x.version}` === S.designTab);
  const r = reports.find(x => `r:${x.step}` === S.designTab);
  el.innerHTML = `<div class="subtabs">${tabs.map(t => `<button type="button" class="${t.id === S.designTab ? 'on' : ''}" data-design-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('')}</div>
    ${v ? renderSystem(v.sys) : ''}
    ${r ? r.files.map(f => /\.md$/i.test(f.path)
      ? `${r.files.length > 1 ? `<div class="hint"><code>${esc(f.path)}</code>${f.truncated ? ' (cut short in the log)' : ''}</div>` : ''}<div class="doc">${md(f.content)}</div>`
      : `<details class="report-file"><summary><code>${esc(f.path)}</code></summary><pre class="doc">${esc(f.content)}</pre></details>`).join('') : ''}`;
  el.querySelectorAll('[data-design-tab]').forEach(b => b.addEventListener('click', () => { S.designTab = b.dataset.designTab; S.designKey = null; renderDesignCard(m); }));
}

// ---------- The same handoffs, in plain words for people who don't write code ----------

/** Latest content of every file the roles produced. */
function latestFiles() {
  const files = new Map();
  for (const e of S.events) {
    if (e.type !== 'agent_output') continue;
    for (const f of e.files) {
      if (f.change === 'deleted') files.delete(f.path);
      else files.set(f.path, { ...f, role: e.role });
    }
  }
  return files;
}

const countTests = text => (text.match(/^\s*(?:test|it)(?:\.only)?\s*\(/gm) ?? []).length;
const quote = s => `“${esc(s)}”`;

function renderStory(m) {
  const el = $('#story');
  const files = latestFiles();
  const byRole = role => [...files.values()].filter(f => f.role === role);
  const stage = id => m.stages[id] ?? { state: 'idle', visits: 0 };
  const status = id => {
    const st = stage(id);
    return st.state === 'active' ? '<div class="status-line working">Working on it now</div>'
      : st.state === 'waiting' ? '<div class="status-line waiting">Waiting for you</div>'
      : !st.visits ? '<div class="status-line">Not started yet</div>' : '';
  };

  // Facts pulled from the files the roles wrote
  const prd = files.get('.devcrew/PRD.md')?.content ?? '';
  const criteria = new Set(prd.match(/\bAC-\d+/g) ?? []).size;
  let parts = [];
  try { parts = JSON.parse(files.get('.devcrew/plan.json')?.content ?? '{}').modules ?? []; } catch { /* plan not written yet */ }
  const testFiles = byRole('qa');
  const checks = testFiles.reduce((n, f) => n + countTests(f.content ?? ''), 0);
  const codeLines = byRole(m.mode === 'single' ? 'single' : 'dev').filter(f => !f.path.startsWith('tests/') && !f.path.startsWith('.devcrew/')).reduce((n, f) => n + f.lines, 0);
  const runs = S.events.filter(e => e.type === 'verify_result');
  const failedRuns = runs.filter(e => !e.passed).length;
  const partTitle = id => parts.find(p => p.id === id)?.title ?? id;
  const gateSteps = m.steps.filter(s => s.gate);
  const decided = g => gateSteps.filter(s => s.gate === g && !s.waiting);
  const task = (m.requirement ?? '').split('\n').find(l => l.trim())?.replace(/[`*#]/g, '').trim() ?? '';

  const col = (cls, title, sub, got, gave, extra = '') =>
    `<div class="scol ${['you', 'verify'].includes(cls) ? cls : roleClass(cls)}" data-node="${cls === 'you' ? '' : cls}"><div class="scol-head"><b>${title}</b><span class="hint">${sub}</span></div>
      <div class="ssec"><div class="ssec-label">Got</div>${got}</div>
      <div class="ssec"><div class="ssec-label">Gave</div>${gave}</div>${extra}</div>`;
  const p = t => `<p>${t}</p>`;

  const you = col('you', 'You', 'the person in charge', p('Nothing. You start the work.'), [
    p(`A request: ${quote(task.length > 120 ? task.slice(0, 117) + '…' : task)}`),
    ...decided('spec').map(s => p(s.auto ? 'The plan was approved automatically (test mode).' : s.decision === 'approve' ? 'You approved the plan.' : s.decision === 'revise' ? `You asked for changes to the plan: ${quote(s.feedback ?? '')}` : 'You cancelled the work.')),
    ...decided('escalation').map(s => p(s.decision === 'retry' ? 'You let the builder try again.' : s.decision === 'replan' ? 'You sent the work back for a new plan.' : 'You stopped the work.')),
    ...decided('merge').map(s => p(s.auto ? 'The final work was accepted automatically (test mode).' : s.decision === 'approve' ? 'You accepted the final work.' : s.decision === 'revise' ? `You asked for changes: ${quote(s.feedback ?? '')}` : 'You rejected the final work.')),
  ].join(''));

  let cols;
  if (m.mode === 'single') {
    cols = [you,
      col('single', 'One AI', 'does everything alone', status('single') + p('Your request.') + (failedRuns ? p('The results of the checks, when they failed.') : ''),
        codeLines ? p(`The finished work: about ${codeLines} lines, including its own checks.`) : p('Nothing yet.')),
      col('verify', 'Checker', 'the Verify box: the system, not an AI', status('verify') + p('The finished work.'),
        runs.length ? p(`Ran the checks ${plural(runs.length, 'time')}: ${runs.length - failedRuns} passed, ${failedRuns} failed and went back to be fixed.`) : p('Nothing yet.')),
    ];
  } else {
    const devParts = [...m.modules].map(([id, mod]) => {
      const tries = mod.tries.length, ok = mod.tries.at(-1) === 'pass';
      return `<li>${esc(partTitle(id))}: ${ok ? (tries > 1 ? `done on try ${tries}` : 'done on the first try') : mod.tries.at(-1) === 'fail' ? `not working yet after ${plural(tries, 'try')}` : 'in progress'}</li>`;
    }).join('');
    const builtIn = {};
    builtIn.planner = [
      col('planner', 'Planner', 'turns the request into a plan', status('planner') + p('Your request.') + (stage('planner').visits > 1 ? p('Your comments on the first plan.') : ''),
        prd || parts.length ? [
          criteria ? p(`A written plan listing <b>${criteria} things</b> the finished work must do.`) : p('A written plan.'),
          parts.length ? p(`The work split into <b>${parts.length} ${parts.length === 1 ? 'part' : 'parts'}</b>, built in this order:`) + `<ol class="plain-list">${parts.map(x => `<li>${esc(x.title)}</li>`).join('')}</ol>` : '',
          p('A precise description of how the pieces fit together, so everyone builds to the same shape.'),
        ].join('') : p('Nothing yet.'))];
    const fast = DEF?.kind === 'fast';
    builtIn.qa = [
      col('qa', 'QA', fast ? 'writes hidden checks while the Builder builds' : 'writes the checks first', status('qa') + p(fast ? 'Your request, and nothing else.' : 'The plan from the Planner.'),
        checks ? p(`<b>${checks} automatic checks</b>, written before anything was built.`) + p('Nobody can change them afterwards, so they are a fair judge.') : p('Nothing yet.'))];
    builtIn.build = [
      col('dev', fast ? 'Builder' : 'Developer', fast ? 'plans and builds it, with its own checks' : 'builds it, one part at a time', status('dev') + (fast ? p('Your request.') : p('The plan from the Planner.') + p('The checks from QA, to aim for.')) + (failedRuns ? p(fast ? 'The names of the hidden checks that failed, each time something failed.' : 'A report from the Checker each time something failed.') : ''),
        m.modules.size ? `${codeLines ? p(`The working software: about <b>${codeLines} lines</b>.`) : ''}<ul class="plain-list">${devParts}</ul>` : p('Nothing yet.'),
        m.guards ? `<div class="plain-warn">Tried to change the checks ${m.guards === 1 ? 'once' : `${m.guards} times`} to make them easier to pass. The system undid it.</div>` : ''),
      col('verify', 'Checker', 'the Verify box: the system, not an AI', status('verify') + p(`The software from the ${fast ? 'Builder' : 'Developer'}.`) + p(fast ? "The Builder's own checks and QA's hidden ones." : 'The checks from QA.'),
        runs.length ? p(`Ran the checks <b>${runs.length === 1 ? 'once' : `${runs.length} times`}</b>: ${runs.length - failedRuns} passed${failedRuns ? `, ${failedRuns} failed and went back to the ${fast ? 'Builder' : 'Developer'} to fix` : ''}.`) : p('Nothing yet.'))];
    // Every role in pipeline order; runs from before pipelines use the standard one
    const order = DEF?.steps ?? [{ type: 'planner' }, { type: 'qa' }, { type: 'build' }];
    cols = [you, ...order.flatMap(step => {
      if (step.type !== 'agent') return builtIn[step.type] ?? [];
        const report = step.verdict ? files.get(step.verdict.file)?.content ?? '' : '';
        const v = report.match(/VERDICT:\s*(\w+)/)?.[1];
        const n = (report.match(/^\s*(?:\d+\.|[-*])\s+/gm) ?? []).length;
        const sentBack = m.steps.filter(x => x.node === step.id).length - 1;
        const got = step.reads.map(r => r === 'git diff' ? 'The finished software.' : r.includes('PRD') ? 'The plan, to compare against.' : '').filter(Boolean);
        const wrote = byRole(step.id);
        const gave = step.verdict
          ? (v ? p(`A report that <b>${v === 'approve' ? 'recommends accepting' : 'asks for changes to'}</b> the work${n ? `, with ${plural(n, 'note')}` : ''}.`) : '')
            + (step.verdict.onChanges === 'dev' && sentBack > 0 ? p(`Sent the software back to the Developer <b>${sentBack === 1 ? 'once' : `${sentBack} times`}</b> to fix what it found.`) : '')
          : wrote.length ? p(`${plural(wrote.length, 'document')} for the team.`) : '';
        return [col(step.id, esc(step.name), esc(step.purpose), status(step.id) + ([...new Set(got)].map(p).join('') || p('The work so far.')), gave || p('Nothing yet.'))];
    })];
  }
  el.innerHTML = `<div class="story-grid" style="grid-template-columns: repeat(${cols.length}, minmax(150px, 1fr))">${cols.join('')}</div>
    <p class="story-foot">The team members never talk to each other directly. DevCrew passes each one's work to the next and checks it on the way.</p>`;
}

// ---------- Handoffs: roles never talk to each other; they hand files over through the orchestrator ----------

const PRODUCERS = ['you', 'planner', 'qa', 'dev', 'verify', 'reviewer', 'single'];
const COLUMN_NAMES = { you: 'You', planner: 'Planner', qa: 'QA', dev: 'Dev', verify: 'Verify', reviewer: 'Reviewer', single: 'Single AI' };
const COLUMN_NAME = new Proxy(COLUMN_NAMES, { get: (o, k) => o[k] ?? stageOf(k).name });
const GATE_SHOWN = {
  plan: 'You were shown <b>PRD.md</b>, <b>plan.json</b> (with the architecture) and <b>contracts/</b> from the Planner, and the reports of the roles before it.',
  design: 'You were shown the system diagram and the reports of the roles before this gate.',
  code: 'You were shown the full diff, the test results from Verify and the reviewers’ reports.',
  escalation: 'You were shown the failing module, the reasons and the test output from Verify.',
};
/** Where a gate decision sends the run, from the pipeline definition. */
function gateNext(gate, decision) {
  if (decision === 'abort') return 'run cancelled';
  if (gate === 'escalation') return decision === 'retry' ? 'Dev tries again' : 'back to the Planner';
  const id = gateNode(gate);
  const steps = DEF?.steps ?? [];
  const i = steps.findIndex(s => s.id === id);
  const step = steps[i];
  if (decision === 'revise') {
    const target = step?.reviseTo ?? (gateKind(gate) === 'plan' ? 'planner' : 'build');
    return `back to ${target === 'build' ? 'Dev' : stageOf(target).name}`;
  }
  const next = steps[i + 1];
  if (!next) return 'work is committed';
  return next.type === 'qa' ? 'QA starts writing tests' : `${next.type === 'build' ? 'Dev' : stageOf(next.id).name} starts`;
}
const shortName = p => p.replace(/^\.devcrew\//, '');

/** Which role produced each file, as of a point in the log (seq). */
function producersBefore(seq) {
  const files = new Map();
  for (const e of S.events) {
    if (e.seq >= seq) break;
    if (e.type === 'agent_output') for (const f of e.files) files.set(f.path, { role: e.role, seq: e.seq, change: f.change });
  }
  return files;
}

/** Files under the paths an input names (a "dir/" prefix covers the directory). */
function resolveReads(reads, files) {
  const out = [];
  for (const r of reads) {
    for (const [path, f] of files) {
      if (f.change !== 'deleted' && (path === r || (r.endsWith('/') && path.startsWith(r)))) out.push({ path, ...f });
    }
  }
  return out;
}

const fileChip = (path, role, seq) =>
  `<button type="button" class="file-chip ${roleClass(role)}" data-file="${esc(path)}" data-seq="${seq}" title="Written by ${COLUMN_NAME[role] ?? role} · click to read">${esc(shortName(path))}</button>`;

function inputBlock(e) {
  const files = resolveReads(e.reads, producersBefore(e.seq));
  const notes = e.reads.filter(r => !r.includes('/') && !r.includes('.'));
  return `<div class="io in"><div class="io-label">Input</div><div>
    <div>The orchestrator wrote ${ROLE_NAME[e.role] ?? e.role}’s instructions from:</div>
    <ul class="io-list">${e.from.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
    ${files.length ? `<div class="chips">${files.map(f => fileChip(f.path, f.role, f.seq)).join('')}</div>` : ''}
    ${notes.length ? `<div class="hint">Also: ${notes.map(esc).join(', ')}</div>` : ''}
    <details><summary>Show the exact instructions sent to ${esc(e.agent)}</summary><pre>${esc(e.prompt)}</pre></details></div></div>`;
}

function outputBlock(e) {
  const kept = e.files.filter(f => f.change !== 'deleted');
  const version = e.role === 'planner' ? archVersions().find(v => v.seq === e.seq) : null;
  return `<div class="io out"><div class="io-label">Output</div><div>
    ${kept.length ? `<div>Wrote ${plural(kept.length, 'file')}:</div><div class="chips">${kept.map(f => fileChip(f.path, e.role, e.seq) + `<span class="hint">${f.change === 'added' ? 'new' : 'changed'} · ${f.lines} lines</span>`).join('')}</div>` : '<div class="hint">No files changed.</div>'}
    ${e.to.length ? `<div class="handto">Handed to: ${e.to.map(t => `<b>${esc(t)}</b>`).join(', ')}</div>` : ''}
    ${version ? `<div class="proposal"><div class="proposal-title">Proposed architecture, version ${version.version}: ${plural(version.files.length, 'file')}, sent to you for review at Gate 1</div>
      <div class="arch-host" data-arch-seq="${e.seq}"></div></div>` : ''}</div></div>`;
}

/** Receives / produces / hands-to for a step defined in the pipeline file. */
function stepContract(node) {
  const steps = DEF?.steps ?? [];
  const i = steps.findIndex(x => x.id === node);
  const step = steps[i];
  if (!step) return null;
  const nextName = x => !x ? 'the end of the run' : x.type === 'gate' ? `${x.title} (you)` : x.type === 'build' ? 'Dev' : stageOf(x.id).name;
  if (step.type === 'gate') {
    const base = S.config?.contracts?.[step.review === 'plan' ? 'gate_spec' : 'gate_merge'];
    const back = step.reviseTo === 'build' ? 'Dev' : stageOf(step.reviseTo).name;
    return base && { ...base, handsTo: [`${nextName(steps[i + 1])} (approved)`, `${back} (changes requested)`] };
  }
  if (step.type !== 'agent') return null;
  return {
    input: step.reads.map(r => (r === 'git diff' ? 'Every code change so far' : r)),
    output: step.produces,
    handsTo: [...(step.verdict?.onChanges === 'dev' ? [`Dev, if something must be fixed (at most ${step.verdict.maxRounds ?? 1} time${(step.verdict.maxRounds ?? 1) === 1 ? '' : 's'})`] : []), nextName(steps[i + 1])],
    mayWrite: step.mayWrite.join(', '),
  };
}

function contractBox(node) {
  const c = stepContract(node) ?? S.config?.contracts?.[node];
  if (!c) return '';
  const list = xs => `<ul class="io-list">${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `<div class="contract"><div class="contract-title">${esc(stageOf(node)?.name ?? node)}: its contract</div>
    <div class="contract-grid"><div><b>Receives</b>${list(c.input)}</div><div><b>Produces</b>${list(c.output)}</div><div><b>Hands to</b>${list(c.handsTo)}</div></div>
    ${c.mayWrite ? `<div class="hint">May only write: <code>${esc(c.mayWrite)}</code>. Anything else it changes is put back.</div>` : ''}</div>`;
}

function renderHandoffs(m) {
  const el = $('#handoffs');
  const order = m.mode === 'single' ? ['you', 'single', 'verify']
    : ['you', ...(DEF?.steps ?? []).flatMap(x => (x.type === 'build' ? ['dev', 'verify'] : x.type === 'gate' ? [] : [x.id]))];
  const readsCode = new Set((DEF?.steps ?? []).filter(x => x.type === 'agent' && x.reads.includes('git diff')).map(x => x.id));
  const col = Object.fromEntries(order.map(r => [r, { received: new Map(), notes: new Set(), produced: new Map(), extra: [] }]));
  col.you.extra.push('The task');
  for (const e of S.events) {
    if (e.type === 'gate_resolved' && !['approve'].includes(e.decision) && e.feedback) col.you.extra.push(`Feedback at ${stageOf(gateNode(e.gate))?.name}`);
    if (e.type === 'agent_input' && col[e.role]) {
      const c = col[e.role];
      for (const f of e.from) if (/^(You|Verify|System|Dev): /.test(f) && !/^Dev: all/.test(f)) c.notes.add(f);
      for (const f of resolveReads(e.reads, producersBefore(e.seq))) c.received.set(f.path, f);
    }
    if (e.type === 'agent_output' && col[e.role]) {
      for (const f of e.files) {
        if (f.change === 'deleted') col[e.role].produced.delete(f.path);
        else col[e.role].produced.set(f.path, { role: e.role, seq: e.seq });
      }
      // Reviewer and Verify read the code Dev produced
      if (e.role === 'dev' || e.role === 'single') for (const f of e.files) if (f.change !== 'deleted') {
        if (col.verify) col.verify.received.set(f.path, { role: e.role, seq: e.seq });
        for (const r of readsCode) if (col[r]) col[r].received.set(f.path, { role: e.role, seq: e.seq });
      }
      if (e.role === 'qa' && col.verify) for (const f of e.files) if (f.change !== 'deleted') col.verify.received.set(f.path, { role: 'qa', seq: e.seq });
    }
    if (e.type === 'verify_result' && col.verify) col.verify.extra.push(`${e.passed ? 'Pass' : 'Fail'} report for ${e.module === 'all' ? 'all tests' : e.module} (${e.tests.pass}/${e.tests.total})`);
  }
  if (col.you.extra.length === 1 && m.steps.some(s => s.gate && !s.auto && !s.waiting)) col.you.extra.push('Gate decisions');
  const any = order.some(r => r !== 'you' && (col[r].produced.size || col[r].received.size || col[r].extra.length));
  if (!any) { el.innerHTML = '<span class="hint">Appears once the first role has handed something over.</span>'; return; }

  const chips = map => [...map].map(([path, f]) => fileChip(path, f.role, f.seq)).join('');
  el.innerHTML = `<div class="handoff-explain">Roles never talk to each other. Each one writes files into the run’s workspace; the <b>orchestrator</b> reads those files and writes the next role’s instructions from them.</div>
    <div class="handoff-grid" style="grid-template-columns: repeat(${order.length}, minmax(140px, 1fr))">
    ${order.map((r, i) => {
      const c = col[r];
      const verifyNote = r === 'verify' && c.extra.length ? `<div class="hint">${plural(c.extra.length, 'report')}, ${c.extra.filter(x => x.startsWith('Fail')).length} failed</div>` : '';
      return `<div class="hcol ${r === 'you' || r === 'verify' ? r : roleClass(r)}" data-node="${r === 'you' ? '' : r}">
        <div class="hcol-head"><span>${COLUMN_NAME[r]}</span>${i < order.length - 1 ? '<span class="harrow">→</span>' : ''}</div>
        <div class="hsec"><div class="hsec-label">Received</div>
          ${r === 'you' ? '<div class="hint">Nothing: you start the run</div>' : `${chips(c.received)}${[...c.notes].map(n => `<div class="note">${esc(n)}</div>`).join('')}${!c.received.size && !c.notes.size ? '<div class="hint">The task only</div>' : ''}`}</div>
        <div class="hsec"><div class="hsec-label">Produced</div>
          ${r === 'you' ? c.extra.map(x => `<div class="note">${esc(x)}</div>`).join('') : r === 'verify' ? (verifyNote || '<div class="hint">Nothing yet</div>') : (chips(c.produced) || '<div class="hint">Nothing yet</div>')}</div>
      </div>`;
    }).join('')}</div>
    <div class="orch-band"><span>Orchestrator</span> reads each role’s files → checks them (scope guard, locked tests) → writes the next role’s instructions</div>`;
}

function openFile(seq, path) {
  const ev = S.events.find(e => e.seq === Number(seq) && e.type === 'agent_output');
  const f = ev?.files.find(x => x.path === path);
  const d = $('#file-dialog');
  $('#file-title').textContent = path;
  $('#file-meta').textContent = ev ? `Written by ${COLUMN_NAME[ev.role] ?? ev.role} at ${fmtTime(ev.ts)}${f?.truncated ? ' · showing the first 20,000 characters' : ''}` : '';
  $('#file-body').innerHTML = f?.content != null
    ? (path.endsWith('.md') ? `<div class="doc">${md(f.content)}</div>` : `<pre class="code">${esc(f.content)}</pre>`)
    : '<p class="hint">No content recorded for this file.</p>';
  d.showModal();
}

// ---------- Activity log: steps owned by a box, written for people ----------

const KIND = { edit: 'edit', read: 'read', execute: 'run', search: 'search', fetch: 'web', delete: 'delete', move: 'move', think: 'think' };
const ROLE_NAMES = { planner: 'Planner', qa: 'QA', dev: 'Dev', reviewer: 'Reviewer', single: 'AI' };
const ROLE_NAME = new Proxy(ROLE_NAMES, { get: (o, k) => o[k] ?? stageOf(k).name });

function reasonText(r) {
  let m;
  if ((m = r.match(/^Only (\d+) of (\d+) declared tests ran/))) return `Only ${m[1]} of ${m[2]} tests could run (some test files failed to load)`;
  if ((m = r.match(/^Locked files changed: (.*)/))) return `Locked test files were changed: ${m[1]}`;
  if ((m = r.match(/^(\d+) tests skipped/))) return `${m[1]} tests were skipped`;
  if (r === 'Test command timed out') return 'The tests took too long';
  return r;
}

function stepTitle(s) {
  switch (s.node) {
    case 'start': return 'Run started';
    case 'planner': return s.visit > 1 ? 'Planner updates the plan from feedback' : 'Planner reads the task and plans';
    case 'qa': return s.visit > 1 ? 'QA rewrites tests for the new plan' : 'QA writes tests from the spec, before any code';
    case 'dev': return `Dev writes module ${s.module} · attempt ${s.attempt}`;
    case 'verify': return s.module ? `System checks module ${s.module}` : 'System runs the tests';
    case 'reviewer': return 'Reviewer checks the code';
    case 'single': return s.attempt > 1 ? `Single AI fixes its work · round ${s.attempt - 1}` : 'Single AI does the whole task';
    case 'escalate': return 'Asked a human to decide';
    case 'finish': return 'Run ended';
    default: {
      const st = stageOf(s.node);
      if (st.gate) return `Gate · ${st.name}`;
      return st.step ? `${st.name}${s.visit > 1 ? ` · round ${s.visit}` : ''}` : s.node;
    }
  }
}

function stepOutcome(s) {
  if (s.verify) return `<span class="chip ${s.verify.passed ? 'ok' : 'bad'}">${s.verify.passed ? 'Passed' : 'Failed'} ${s.verify.tests.pass}/${s.verify.tests.total}</span>`;
  if (s.gate) return s.waiting ? '<span class="chip warn">Waiting for you</span>' : `<span class="chip ${s.decision === 'approve' ? 'ok' : s.decision === 'abort' ? 'bad' : 'warn'}">${s.auto && s.decision === 'approve' ? 'Auto-approved' : DECISION[s.decision] ?? s.decision}</span>`;
  if (s.node === 'finish') return `<span class="chip ${['approved', 'completed'].includes(s.status) ? 'ok' : 'bad'}">${{ approved: 'Done', completed: 'Finished', failed: 'Failed', aborted: 'Cancelled' }[s.status] ?? s.status}</span>`;
  if (s.guards) return `<span class="chip warn">${plural(s.guards, 'file')} blocked</span>`;
  return '';
}

function stepLines(s) {
  const out = [];
  // Each line starts with a short tag saying what kind of thing happened
  const line = (tag, html, cls = '') => out.push(`<div class="line ${cls}"><span class="li">${tag}</span><div>${html}</div></div>`);
  if (s.node === 'start') {
    line('task', `<div class="quote">${esc(s.requirement)}</div>`);
    line('folder', `<code>${esc(s.workspace)}</code> <button type="button" class="mini" data-copy="${esc(s.workspace)}">Copy path</button>`);
    return out.join('');
  }
  if (s.gate) out.push(`<div class="io in"><div class="io-label">Input</div><div>${GATE_SHOWN[gateKind(s.gate)]}</div></div>`);
  if (s.gate && !s.waiting) out.push(`<div class="io out"><div class="io-label">Output</div><div>${DECISION[s.decision] ?? s.decision}${s.feedback ? ` with feedback` : ''} → ${gateNext(s.gate, s.decision)}</div></div>`);
  if (s.gate && s.auto && !s.waiting && s.decision === 'approve') line('note', 'Benchmark mode: nobody reviews, so the system approved it.', 'muted');
  if (s.waiting) line('note', 'Paused until you decide (see the box above).');
  if (s.feedback) line('feedback', `<span class="quote inline">${esc(s.feedback)}</span>`);
  for (const e of s.events) {
    switch (e.type) {
      case 'agent_input':
        out.push(inputBlock(e));
        break;
      case 'agent_output':
        out.push(outputBlock(e));
        break;
      case 'agent_text':
        line('says', `<div class="bubble">${esc(e.text.trim())}</div>`, 'say');
        break;
      case 'tool_call':
        if (e.status === 'completed') break;
        if (e.status === 'failed') { line('failed', `<code>${esc(e.title)}</code>`, 'warnline'); break; }
        line(KIND[e.kind] ?? 'tool', `<code>${esc(e.title.replace(/^(Write|Edit|Read|Create|Delete)\s+/i, ''))}</code>`, 'tool');
        break;
      case 'guard_violation':
        line('blocked', `${ROLE_NAME[e.role] ?? e.role} tried to change ${e.files.map(f => `<code>${esc(f)}</code>`).join(', ')}, which it is not allowed to touch. ${e.action === 'reverted' ? 'The system put the file back.' : 'The system refused the change.'}`, 'warnline');
        break;
      case 'verify_result':
        if (e.commands?.length) out.push(`<div class="io in"><div class="io-label">Input</div><div>Ran ${e.commands.map(c => `<code>${esc(c)}</code>`).join(', ')} against the code from Dev, using the locked tests from QA.</div></div>`);
        line(e.passed ? 'pass' : 'fail', `${e.passed ? `All ${e.tests.total} tests passed` : `${e.reasons.map(reasonText).map(esc).join(' · ')}<br><span class="muted">The result goes back to be fixed.</span>`}
          <details><summary>Full test output</summary><pre>${esc(e.output.slice(-4000))}</pre></details>`, e.passed ? 'okline' : 'badline');
        break;
      case 'log':
        if (e.level === 'error') line('error', `Something went wrong<details><summary>Details</summary><pre>${esc(e.message)}</pre></details>`, 'badline');
        break;
      case 'run_finished':
        if (e.error) line('error', esc(e.error), 'badline');
        break;
    }
  }
  if (s.tokens) line('usage', `${fmtTok(s.tokens)} tokens (${fmtUsd(s.cost)})`, 'muted');
  return out.join('') || '<div class="line muted"><span class="li"></span><div>Nothing yet</div></div>';
}

/** Steps as collapsible blocks. `all` opens every step (used in the role popup). */
function stepsHtml(steps, m, all = false) {
  const lastId = m.steps.at(-1)?.id;
  return steps.map(s => {
    const def = stageOf(s.node) ?? {};
    const isOpen = S.open.get(s.id) ?? (all || s.id === lastId || s.waiting || s.node === 'start' || (s.verify && !s.verify.passed) || s.guards > 0);
    const dur = s.end ? fmtDur(s.end - s.start) : (m.status === 'running' ? 'working…' : '');
    const meta = [fmtTime(s.start), s.node === 'finish' || s.node === 'start' ? '' : dur].filter(Boolean).join(' · ');
    return `<details class="step ${def.color ?? ''} ${def.gate ? 'gate-step' : ''} ${s.id === lastId && m.status === 'running' ? 'live' : ''}" data-node="${s.node}" data-id="${s.id}" ${isOpen ? 'open' : ''}>
      <summary><span class="step-title">${esc(stepTitle(s))}</span>${stepOutcome(s)}<span class="step-meta">${meta}</span></summary>
      <div class="step-body">${stepLines(s)}</div></details>`;
  }).join('');
}

/** Fill in the Planner's proposed designs inside its steps. */
function fillArchHosts(root) {
  const versions = archVersions();
  root.querySelectorAll('.arch-host').forEach(host => {
    const v = versions.find(x => x.seq === Number(host.dataset.archSeq));
    if (!v) return;
    host.innerHTML = diffBanner(v, versions[v.version - 2]) + renderArch(v.files, null, v.plan, archDiff(versions[v.version - 2], v));
    requestAnimationFrame(() => drawArch(host, v.files));
  });
}

function renderSteps(m, first) {
  const box = $('#steps');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevTop = box.scrollTop;
  box.innerHTML = stepsHtml(m.steps, m) || '<div class="empty small">Nothing logged yet</div>';
  fillArchHosts(box);
  if (first || atBottom) box.scrollTop = box.scrollHeight; else box.scrollTop = prevTop;
  renderRolePopup(m);
}

/** The popup opened by clicking a box: that role's contract and every step it took. */
function renderRolePopup(m) {
  const d = $('#role-dialog');
  if (!S.popup || !d.open) return;
  const body = $('#role-body');
  const prevTop = body.scrollTop;
  const steps = m.steps.filter(s => s.node === S.popup);
  const stage = m.stages[S.popup] ?? { visits: 0 };
  $('#role-title').textContent = `${stageOf(S.popup)?.name ?? S.popup}`;
  $('#role-meta').textContent = `${plural(steps.length, 'step')} in this run${stage.state === 'active' ? ' · working now' : stage.state === 'waiting' ? ' · waiting for you' : ''}`;
  body.innerHTML = contractBox(S.popup) + (stepsHtml(steps, m, true) || '<p class="hint">This box has not done anything yet.</p>');
  fillArchHosts(body);
  body.scrollTop = prevTop;
}

function renderModules(m) {
  const planned = m.plan?.modules?.map(x => x.id) ?? [];
  const ids = [...new Set([...planned, ...m.modules.keys()])];
  const max = S.config?.maxFixAttempts ?? 5;
  if (!ids.length) {
    $('#modules').innerHTML = `<span class="hint">${m.mode === 'single' ? 'Single AI mode does not split work into modules.' : 'Shows up once the Planner has split the work.'}</span>`;
    return;
  }
  $('#modules').innerHTML = ids.map(id => {
    const tries = m.modules.get(id)?.tries ?? [];
    const last = tries.at(-1);
    const state = last === 'pass' ? `<span class="yes">Passed${tries.length > 1 ? ` (attempt ${tries.length})` : ''}</span>` : last === 'fail' ? '<span class="no">Failing</span>' : tries.length ? '<span class="hint">Writing…</span>' : '<span class="hint">Queued</span>';
    const cells = Array.from({ length: Math.max(max, tries.length) }, (_, i) => `<span class="try ${tries[i] ?? ''}"></span>`).join('');
    return `<div class="mod"><span class="name">${esc(id)}</span>${state}<div class="tries" title="Each box is one Dev attempt (max ${max})">${cells}</div></div>`;
  }).join('') + '<div class="legend"><span><i class="sw pass"></i>Passed</span><span><i class="sw fail"></i>Failed, sent back</span><span><i class="sw"></i>Attempts left</span></div>';
}

function renderUsage(m) {
  const rows = Object.keys(m.byRole);
  const max = Math.max(1, ...rows.map(r => m.byRole[r].tokens));
  $('#usage').innerHTML = rows.length ? `<div class="bars">${rows.map(r => {
    const u = m.byRole[r];
    const seg = (v, op) => `<span class="bar-fill" style="width:${(v / max) * 100}%;background:var(--${roleClass(r)});opacity:${op}"></span>`;
    return `<div class="bar-row" data-node="${r}"><span class="role ${roleClass(r)}">${esc(ROLE_NAME[r])}</span>
      <span class="bar-track" title="new input ${fmtTok(u.input)} · re-read from cache ${fmtTok(u.cached)} · written ${fmtTok(u.output)}">${seg(u.input, 1)}${seg(u.cached, .4)}${seg(u.output, .7)}</span>
      <span class="bar-val">${fmtTok(u.tokens)} · ${fmtUsd(u.cost)}</span></div>`;
  }).join('')}</div>
  <p class="hint" style="margin:10px 0 0">Solid: new text the AI read. Faded: re-read from cache (cheaper). Medium: text the AI wrote.</p>` : '<span class="hint">No AI usage yet</span>';
}

// ---------- Gates ----------

function renderGate(m) {
  const slot = $('#gate-slot');
  const key = m.gate ? `${m.gate.seq}` : null;
  if (key === S.gateKey) return;
  S.gateKey = key;
  if (!m.gate) { slot.innerHTML = ''; S.gate = null; return; }
  const { gate, payload } = m.gate;
  const kind = payload.kind ?? gateKind(gate);
  S.gate = m.gate;
  let body = '', actions = '', title = '';
  if (kind === 'plan') {
    title = `Gate · ${payload.title && payload.title !== 'Spec & Architecture Approval' ? payload.title : 'Review the spec and plan'}`;
    const plan = payload.plan;
    body = `${payload.specIssue ? `<div class="banner warn">Dev reported a problem with the spec: ${esc(payload.specIssue)}</div>` : ''}
      <p class="gate-ask">The Planner has written the spec and designed every file to build. Nothing has been built yet. If you approve, QA writes tests and Dev builds exactly these files; anything outside this design will be flagged.</p>
      <div class="subtabs" id="spec-tabs"><button type="button" class="on" data-pane="arch">Architecture (${plural(plan?.architecture?.length ?? 0, 'file')})</button>${coverageButton(payload)}<button type="button" data-pane="prd">Spec (PRD)</button><button type="button" data-pane="parts">Parts and build order</button>${reportButtons(payload.reports)}</div>
      <div data-pane="arch">${(() => { const vs = archVersions(); const v = vs.at(-1); const prev = v && vs[v.version - 2]; return (v ? diffBanner(v, prev) : '') + renderArch(plan?.architecture, null, plan, v ? archDiff(prev, v) : null); })()}</div>
      ${coveragePane(payload)}
      <div data-pane="prd" hidden><div class="doc">${payload.prd ? md(payload.prd) : '<p class="hint">No PRD written</p>'}</div></div>
      <div data-pane="parts" hidden><h4>Work split into ${plural(plan?.modules?.length ?? 0, 'part')} (Dev builds them in this order)</h4>
        <ul class="module-list">${(plan?.modules ?? []).map((x, i) => `<li><span class="id">${i + 1}. ${esc(x.id)}</span> — ${esc(x.title)}<div class="desc">${esc(x.description)}</div></li>`).join('')}</ul>
        <dl class="kv" style="margin-top:12px"><dt>Test command</dt><dd><code>${esc(plan?.testCommand)}</code></dd></dl></div>
      ${reportPanes(payload.reports)}`;
    actions = gateButtons([['approve', 'Approve plan and architecture', 'ok'], ['revise', 'Ask for changes', ''], ['abort', 'Cancel run', 'danger']]);
  } else if (kind === 'architecture') {
    title = `Gate · ${payload.title ?? 'Approve the architecture'}`;
    const a = payload.architecture;
    const contracts = payload.contracts ?? [];
    body = `${payload.architectureError ? `<div class="banner warn">${esc(payload.architectureError)}</div>` : ''}
      <p class="gate-ask">The Architect has designed the architecture this project will keep. Nothing has been built yet. If you approve, every run builds inside it, and Verify rejects any import that breaks its rules.</p>
      <div class="subtabs" id="arch-gate-tabs"><button type="button" class="on" data-pane="modules">Modules (${a?.modules?.length ?? 0})</button><button type="button" data-pane="doc">Design and reasons</button><button type="button" data-pane="contracts">Contracts (${contracts.length})</button></div>
      <div data-pane="modules"><table class="files"><tr><th>Module</th><th>Owns</th><th>What it does</th><th>May use</th><th>Others enter through</th></tr>
        ${(a?.modules ?? []).map(m => `<tr><td><b>${esc(m.id)}</b></td><td class="path">${esc(m.path)}</td><td>${esc(m.purpose)}</td><td>${esc(m.mayUse.join(', ') || 'nothing else')}</td><td class="path">${esc(m.interface ?? 'any file')}</td></tr>`).join('')}</table>
        ${(a?.decisions ?? []).length ? `<h4>Decisions</h4><ul>${a.decisions.map(d => `<li><b>${esc(d.id)} ${esc(d.title)}:</b> ${esc(d.decision)} <span class="hint">${esc(d.why)}</span></li>`).join('')}</ul>` : ''}</div>
      <div data-pane="doc" hidden><div class="doc">${payload.doc ? md(payload.doc) : '<p class="hint">No ARCHITECTURE.md written</p>'}</div></div>
      <div data-pane="contracts" hidden>${contracts.map(c => `<h4 class="path">${esc(c.path)}</h4><pre class="doc">${esc(c.text)}</pre>`).join('') || '<p class="hint">No contracts written</p>'}</div>`;
    actions = gateButtons([['approve', 'Approve the architecture', 'ok'], ['revise', 'Ask for changes', ''], ['abort', 'Cancel run', 'danger']]);
  } else if (kind === 'design') {
    title = `Gate · ${payload.title ?? 'Review the design'}`;
    const isLast = DEF?.steps.at(-1)?.id === gate;
    const sys = payload.system;
    const files = payload.files ?? [];
    const usage = Object.values(payload.usage ?? {});
    body = `${(payload.systemErrors ?? []).length ? `<div class="banner warn">The system diagram has problems: ${payload.systemErrors.map(esc).join(' ')}</div>` : ''}
      <p class="gate-ask">${isLast ? 'The design is ready. If you approve, the documents and diagram are committed to a branch. No code is built.' : 'Review the design so far. If you approve, the next roles continue from it; if you ask for changes, your notes go back to the role that wrote it.'}</p>
      <div class="subtabs" id="design-tabs"><button type="button" class="on" data-pane="system">System diagram${sys ? ` (${plural(sys.blocks.length, 'block')})` : ''}</button>${reportButtons(payload.reports)}<button type="button" data-pane="files">Changed files (${files.length})</button></div>
      <div data-pane="system">${sys ? renderSystem(sys) : '<p class="hint">No system diagram written yet (.devcrew/system.json).</p>'}</div>
      ${reportPanes(payload.reports)}
      <div data-pane="files" hidden><table class="files">${files.map(f => `<tr><td class="path">${esc(f.path)}</td><td class="add">+${f.added}</td><td class="del">−${f.removed}</td></tr>`).join('')}</table>
        <dl class="kv" style="margin-top:12px"><dt>Used</dt><dd>${fmtTok(usage.reduce((n, u) => n + u.totalTokens, 0))} tokens · ${fmtUsd(usage.reduce((n, u) => n + u.costUsd, 0))}</dd>
        <dt>Branch</dt><dd>${payload.branch ? `<code>${esc(payload.branch)}</code>` : 'Separate work folder (not your git repo)'}</dd></dl></div>`;
    actions = gateButtons([['approve', isLast ? 'Approve and commit the design' : 'Approve and continue', 'ok'], ['revise', 'Ask for changes', ''], ['abort', 'Cancel run', 'danger']]);
  } else if (kind === 'escalation') {
    title = 'Your decision is needed';
    body = `<p class="gate-ask">Dev tried module <b>${esc(payload.module)}</b> ${plural(payload.attempts, 'time')} and it still fails, because:</p>
      <ul>${(payload.reasons ?? []).map(r => `<li>${esc(reasonText(r))}</li>`).join('')}</ul>
      <details><summary>Full test output</summary><pre class="doc">${esc(payload.output)}</pre></details>`;
    actions = gateButtons([['retry', 'Let Dev try again (add a hint)', 'primary'], ['replan', 'Send back to the Planner', ''], ['abort', 'Cancel run', 'danger']]);
  } else if (kind === 'code') {
    title = `Gate · ${payload.title && payload.title !== 'Merge Approval' ? payload.title : 'Approve the merge'}`;
    const files = payload.files ?? [];
    const add = files.reduce((n, f) => n + f.added, 0), del = files.reduce((n, f) => n + f.removed, 0);
    // Every report written by a role with a verdict; older runs only had the reviewer's
    const reviews = payload.reviews ?? (payload.review ? [{ step: 'reviewer', name: 'Reviewer', text: payload.review }] : []);
    const verdictOf = t => (t ?? '').match(/VERDICT:\s*(\w+)/)?.[1];
    const usage = Object.values(payload.usage ?? {});
    body = `<p class="gate-ask">Every module passes its tests${reviews.length ? ` and ${reviews.map(r => esc(r.name)).join(' and ')} ${reviews.length === 1 ? 'has' : 'have'} checked the code` : ''}. If you approve, the work is committed to a branch. Nothing is deployed.</p>
      <div class="gate-grid"><div>
        <div class="subtabs" id="merge-tabs"><button type="button" class="on" data-pane="files">Changed files (${files.length})</button><button type="button" data-pane="diff">Code changes</button>${reviews.map((r, i) => `<button type="button" data-pane="review-${i}">${esc(r.name)} notes</button>`).join('')}${reportButtons(payload.reports)}</div>
        <div data-pane="files"><table class="files">${files.map(f => `<tr><td class="path">${esc(f.path)}</td><td class="add">+${f.added}</td><td class="del">−${f.removed}</td></tr>`).join('')}</table></div>
        <div data-pane="diff" hidden><pre class="diff">${diffHtml(payload.patch)}</pre></div>
        ${reviews.map((r, i) => `<div data-pane="review-${i}" hidden><div class="doc">${md(r.text)}</div></div>`).join('')}
        ${reportPanes(payload.reports)}
      </div><div>
        <dl class="kv">
          <dt>Tests</dt><dd>${payload.tests ? `<span class="yes">${payload.tests.pass}/${payload.tests.total} passing</span>` : '–'}</dd>
          ${reviews.map(r => { const v = verdictOf(r.text); return `<dt>${esc(r.name)}</dt><dd>${v ? `<span class="${v === 'approve' ? 'yes' : 'no'}">${v === 'approve' ? 'Recommends approval' : 'Asks for changes'}</span>` : '–'}</dd>`; }).join('')}
          <dt>Size of change</dt><dd><span class="yes">+${add}</span> <span class="no">−${del}</span> lines in ${plural(files.length, 'file')}</dd>
          <dt>Used</dt><dd>${fmtTok(usage.reduce((n, u) => n + u.totalTokens, 0))} tokens · ${fmtUsd(usage.reduce((n, u) => n + u.costUsd, 0))}</dd>
          <dt>Branch</dt><dd>${payload.branch ? `<code>${esc(payload.branch)}</code>` : 'Separate work folder (not your git repo)'}</dd>
        </dl></div></div>`;
    actions = gateButtons([['approve', 'Approve and commit', 'ok'], ['revise', 'Ask for changes', ''], ['abort', 'Reject this work', 'danger']]);
  }
  slot.innerHTML = `<section class="card gate"><div class="card-head"><h3>${title}</h3><span class="hint">The run is paused until you decide</span></div>
    <div class="card-body">${body}</div>${actions}</section>`;
  slot.querySelectorAll('.subtabs button').forEach(b => b.addEventListener('click', () => {
    b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    slot.querySelectorAll('[data-pane]:not(button)').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.pane; });
    if (b.dataset.pane === 'arch') drawArch(slot, payload.plan?.architecture);
  }));
  if (kind === 'plan') requestAnimationFrame(() => drawArch(slot, payload.plan?.architecture));
  wireGate(slot);
}

/** One tab per earlier role that wrote reports or notes. */
const reportButtons = reports => (reports ?? []).map((r, i) => `<button type="button" data-pane="report-${i}">${esc(r.name)}</button>`).join('');
function reportPanes(reports) {
  return (reports ?? []).map((r, i) => `<div data-pane="report-${i}" hidden>${r.files.map(f => /\.md$/i.test(f.path)
    ? `${r.files.length > 1 ? `<div class="hint"><code>${esc(f.path)}</code></div>` : ''}<div class="doc">${md(f.text)}</div>`
    : `<details class="report-file"><summary><code>${esc(f.path)}</code></summary><pre class="doc">${esc(f.text)}</pre></details>`).join('')}</div>`).join('');
}

// ---------- System architecture diagram ----------

const SYS_KIND = { compute: 'Compute', controller: 'Controller', sensor: 'Sensor', actuator: 'Actuator', power: 'Power', network: 'Network', storage: 'Storage', software: 'Software', interface: 'Interface', external: 'External', user: 'User' };

/**
 * Blocks in columns by how far down the data and control chain they are, with a curve per
 * link labelled with its interface. Power and mechanical links do not set the columns (a
 * power rail touches everything and would stretch the diagram), and loops are broken in list
 * order. Clicking a legend entry hides that kind of link.
 */
function renderSystem(sys) {
  const blocks = sys.blocks, byId = new Map(blocks.map(b => [b.id, b]));
  const links = sys.links.filter(l => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);
  const out = new Map(blocks.map(b => [b.id, []]));
  const signal = links.filter(l => !['power', 'mechanical'].includes(l.kind ?? 'data'));
  for (const l of signal) out.get(l.from).push(l.to);
  // Depth-first order; a link back into the current path is a loop and does not rank
  const state = new Map(), order = [], forward = new Set();
  const visit = id => {
    state.set(id, 'open');
    for (const to of out.get(id)) {
      if (state.get(to) === 'open') continue;
      forward.add(`${id}>${to}`);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 'done');
    order.push(id);
  };
  blocks.forEach(b => { if (!state.has(b.id)) visit(b.id); });
  const rank = new Map(blocks.map(b => [b.id, 0]));
  for (const id of order.reverse()) for (const to of out.get(id)) if (forward.has(`${id}>${to}`)) rank.set(to, Math.max(rank.get(to), rank.get(id) + 1));
  const cols = [];
  const groupIndex = new Map((sys.groups ?? []).map((g, i) => [g.id, i]));
  blocks.forEach((b, i) => { (cols[rank.get(b.id)] ??= []).push({ b, i }); });
  const BW = 176, BH = 70, CG = 170, RG = 34, PAD = 20;
  const tallest = Math.max(...cols.map(c => c?.length ?? 0));
  const height = PAD * 2 + tallest * BH + (tallest - 1) * RG;
  const at = new Map();
  cols.forEach((col, c) => {
    if (!col) return;
    col.sort((x, y) => (groupIndex.get(x.b.group) ?? 99) - (groupIndex.get(y.b.group) ?? 99) || x.i - y.i);
    const top = (height - (col.length * BH + (col.length - 1) * RG)) / 2;
    col.forEach(({ b }, r) => at.set(b.id, { x: PAD + c * (BW + CG), y: top + r * (BH + RG) }));
  });
  const width = PAD * 2 + cols.length * BW + (cols.length - 1) * CG;
  const groupName = new Map((sys.groups ?? []).map(g => [g.id, g.name]));
  let edges = '', labels = '';
  links.forEach((l, i) => {
    const a = at.get(l.from), b = at.get(l.to);
    const kind = l.kind ?? 'data';
    let d, lx, ly;
    if (b.x > a.x) {
      const x0 = a.x + BW, y0 = a.y + BH / 2, x1 = b.x, y1 = b.y + BH / 2, mx = (x0 + x1) / 2;
      d = `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
      lx = mx; ly = (y0 + y1) / 2;
    } else {
      // Same column or backwards: loop under the boxes
      const x0 = a.x + BW / 2 + 12, y0 = a.y + BH, x1 = b.x + BW / 2 - 12, y1 = b.y + BH, dip = Math.max(y0, y1) + 30 + (i % 3) * 8;
      d = `M${x0} ${y0} C${x0} ${dip} ${x1} ${dip} ${x1} ${y1}`;
      lx = (x0 + x1) / 2; ly = dip - 6;
    }
    const text = [l.interface, l.label].filter(Boolean).join(' · ');
    edges += `<path class="sys-link ${kind}" d="${d}" marker-end="url(#sys-arr-${kind})"><title>${esc(`${byId.get(l.from).name} → ${byId.get(l.to).name}: ${text}`)}</title></path>`;
    const short = l.interface && l.interface.length <= 22 ? l.interface : (l.interface ?? text).slice(0, 21) + '…';
    if (text) labels += `<text class="sys-label ${kind}" x="${lx}" y="${ly - 4}" text-anchor="middle">${esc(short)}<title>${esc(text)}</title></text>`;
  });
  const boxes = blocks.map(b => {
    const { x, y } = at.get(b.id);
    const name = b.name.length > 24 ? b.name.slice(0, 23) + '…' : b.name;
    const part = b.part ? (b.part.length > 26 ? b.part.slice(0, 25) + '…' : b.part) : 'part not chosen';
    return `<g class="sys-block k-${esc(b.kind)}"><title>${esc([b.name, b.part, b.description, b.group && `Group: ${groupName.get(b.group) ?? b.group}`].filter(Boolean).join('\n'))}</title>
      <rect class="sys-box" x="${x}" y="${y}" width="${BW}" height="${BH}" rx="10"/><rect class="sys-stripe" x="${x}" y="${y}" width="6" height="${BH}" rx="3"/>
      <text class="sys-kind" x="${x + 16}" y="${y + 17}">${esc(SYS_KIND[b.kind] ?? b.kind)}${b.group ? ` · ${esc(groupName.get(b.group) ?? b.group)}` : ''}</text>
      <text class="sys-name" x="${x + 16}" y="${y + 38}">${esc(name)}</text>
      <text class="sys-part ${b.part ? '' : 'none'}" x="${x + 16}" y="${y + 56}">${esc(part)}</text></g>`;
  }).join('');
  const markers = ['data', 'control', 'power', 'mechanical'].map(k => `<marker id="sys-arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="sys-arrow ${k}"/></marker>`).join('');
  const present = new Set(links.map(l => l.kind ?? 'data'));
  const legend = `<div class="sys-legend">${['data', 'control', 'power', 'mechanical'].filter(k => present.has(k)).map(k => `<button type="button" class="${k}" data-kind="${k}" title="Show or hide these links">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}<span class="hint">Click a link type to hide it. Hover a block or line for details.</span></div>`;
  return `<div class="sys-diagram" onclick="const b = event.target.closest('[data-kind]'); if (b) { this.classList.toggle('hide-' + b.dataset.kind); b.classList.toggle('off'); }"><h4>${esc(sys.title)}</h4><div class="sys-scroll"><svg width="${width}" height="${height + 60}" viewBox="0 0 ${width} ${height + 60}" role="img" aria-label="System architecture diagram"><defs>${markers}</defs>${edges}${boxes}${labels}</svg></div>${legend}</div>`;
}

function gateButtons(defs) {
  return `<div class="gate-actions"><textarea id="gate-feedback" placeholder="Feedback for the AI (required for “Ask for changes”, optional otherwise)"></textarea>
    ${defs.map(([d, label, cls]) => `<button type="button" class="btn ${cls}" data-decision="${d}">${label}</button>`).join('')}
    <span class="hint" id="gate-msg"></span></div>`;
}

function wireGate(slot) {
  slot.querySelectorAll('[data-decision]').forEach(btn => btn.addEventListener('click', async () => {
    const feedback = $('#gate-feedback').value.trim();
    if (btn.dataset.decision === 'revise' && !feedback) { $('#gate-msg').textContent = 'Write what should change first.'; $('#gate-feedback').focus(); return; }
    slot.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const r = await fetch(`/api/runs/${S.selected}/gate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: btn.dataset.decision, feedback }) });
    if (!r.ok) {
      $('#gate-msg').textContent = (await r.json()).error;
      slot.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }));
}

function diffHtml(patch) {
  return esc(patch ?? '').split('\n').map(l => {
    const c = l.startsWith('+++') || l.startsWith('---') ? '' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('diff ') ? 'h' : '';
    return `<span class="${c}">${l || ' '}</span>`;
  }).join('');
}

// ---------- Live events ----------

function onEvent(e) {
  refreshRunList();
  if (e.runId !== S.selected || S.events.some(x => x.seq === e.seq)) return;
  S.events.push(e);
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(() => update());
}

function openRole(node) {
  S.popup = node;
  $('#role-dialog').showModal();
  $('#role-body').scrollTop = 0;
  update();
}

// ---------- Runs list & selection ----------

let listTimer = 0;
function refreshRunList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => {
    S.runs = await (await fetch('/api/runs')).json();
    const statusText = { running: 'Running', stopped: 'Stopped', waiting: 'Your turn', approved: 'Done', completed: 'Finished', failed: 'Failed', aborted: 'Cancelled' };
    $('#run-list').innerHTML = S.runs.map(r => `<li data-id="${r.runId}" class="${r.runId === S.selected ? 'selected' : ''}">
      <span class="dot ${r.status}"></span><span class="title">${esc(r.label || r.requirement.split('\n')[0].replace(/[`*#]/g, ''))}</span>
      <span class="sub"><span>${statusText[r.status] ?? r.status}</span><span>${new Date(r.startedAt).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><span>${esc(r.profile)}</span></span></li>`).join('')
      || '<li class="hint" style="cursor:default">No runs yet</li>';
  }, 150);
}

// ---------- Resume a run that stopped mid-way ----------

/** Ask the server whether the selected run can continue; it knows whether any process still drives it. */
async function checkResume() {
  const runId = S.selected;
  if (!runId || !['running', 'stopped', 'failed'].includes(S.lastStatus)) { if (S.resume) { S.resume = null; update(); } return; }
  try {
    const info = await (await fetch(`/api/runs/${runId}/resume`)).json();
    if (runId !== S.selected) return;
    const changed = JSON.stringify(info) !== JSON.stringify(S.resume && { ...S.resume, runId: undefined });
    S.resume = { ...info, runId };
    if (changed) update();
  } catch { /* server restarting */ }
}

function renderResume(m) {
  S.lastStatus = m.status;
  const slot = $('#resume-slot');
  const r = S.resume;
  if (!r?.resumable || r.runId !== S.selected || !['stopped', 'failed'].includes(m.status)) { slot.innerHTML = ''; return; }
  const at = r.next.join(', ');
  if (slot.dataset.key === `${S.selected}:${at}`) return;
  slot.dataset.key = `${S.selected}:${at}`;
  slot.innerHTML = `<section class="card resume"><div class="card-body">
    <p><b>The work so far is saved.</b> Resume continues from <b>${esc(at)}</b>, the step that was interrupted, which starts again from its beginning. Earlier steps are not repeated.</p>
    ${m.status === 'failed' && m.error ? `<p class="hint">It stopped because: ${esc(m.error)}. If that was a usage limit, resume after it resets.</p>` : ''}
    <button type="button" class="btn primary" id="resume-btn">Resume from ${esc(at)}</button> <span class="hint" id="resume-msg"></span></div></section>`;
  $('#resume-btn').addEventListener('click', async e => {
    e.target.disabled = true;
    $('#resume-msg').textContent = 'Starting…';
    const res = await fetch(`/api/runs/${S.selected}/resume`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { $('#resume-msg').textContent = body.error ?? 'Could not resume'; e.target.disabled = false; return; }
    S.resume = null;
    slot.innerHTML = '';
    slot.dataset.key = '';
  });
}

async function select(runId) {
  S.resume = null;
  S.lastStatus = null;
  S.selected = runId;
  S.popup = null;
  S.archVersion = null;
  S.gate = null;
  S.open = new Map();
  history.replaceState(null, '', runId ? `#run=${runId}` : '#');
  S.events = runId ? await (await fetch(`/api/runs/${runId}`)).json() : [];
  renderRun();
  refreshRunList();
  checkResume();
}

function connect() {
  S.es?.close();
  const es = new EventSource('/api/stream');
  es.onopen = () => $('#conn').classList.add('live');
  es.onerror = () => $('#conn').classList.remove('live');
  es.onmessage = msg => onEvent(JSON.parse(msg.data));
  S.es = es;
}

// ---------- Pipelines: review drafts the AI proposes, and pick one for a run ----------

async function loadPipelines() {
  S.pipelines = await (await fetch('/api/pipelines')).json();
  const drafts = S.pipelines.filter(p => p.draft && p.review?.status !== 'approved').length;
  $('#draft-count').hidden = !drafts;
  $('#draft-count').textContent = drafts;
  return S.pipelines;
}

async function openNewRun(pipelineId) {
  const approved = (await loadPipelines()).filter(p => !p.draft && !p.errors.length);
  $('#pipeline-select').innerHTML = approved.map(p => `<option value="${esc(p.id)}" ${p.id === (pipelineId ?? 'fast') ? 'selected' : ''}>${esc(p.def.name)}</option>`).join('');
  $('#pipeline-select').dispatchEvent(new Event('change'));
  $('#start-error').textContent = '';
  $('#new-run').showModal();
}

/** A pipeline in plain words, one line per step (the same wording the CLI prints). */
function describeSteps(def) {
  const nameOf = s => !s ? 'the end of the run' : s.type === 'gate' ? `you (${s.title})` : s.type === 'agent' ? s.name : s.type === 'build' ? 'Dev' : s.type === 'qa' ? 'QA' : 'the Planner';
  return def.steps.map((s, i) => {
    let who, what;
    switch (s.type) {
      case 'planner': who = 'Planner'; what = 'Reads your request, writes the spec and designs every file.'; break;
      case 'qa': who = 'QA'; what = 'Writes tests from the spec before any code exists. The tests are locked afterwards.'; break;
      case 'build': who = 'Dev + Verify'; what = `Dev builds one part at a time; the system runs the tests after each try. Up to ${s.maxAttempts ?? S.config?.maxFixAttempts ?? 5} tries per part, then you decide.`; break;
      case 'gate': who = 'You'; what = `Review the ${{ plan: 'spec, architecture and the reports so far', code: 'code, test results and reviews', design: 'system diagram and the reports so far', architecture: "project's lasting architecture" }[s.review]} (“${esc(s.title)}”). Approve to continue${i === def.steps.length - 1 ? ' and commit' : ''}, or ask for changes to send it back to ${esc(nameOf(def.steps.find(x => x.id === s.reviseTo)))}.`; break;
      default: who = esc(s.name) + (s.agent ? ` <span class="hint">(${esc(s.agent)})</span>` : ''); what = `${esc(s.purpose)} May only write <code>${s.mayWrite.map(esc).join(', ')}</code>.${s.verdict?.onChanges === 'dev' ? ` Can send the code back to Dev, at most ${plural(s.verdict.maxRounds ?? 1, 'time')}.` : ''}${/^guide:/.test(s.instructions) ? ` Follows the role guide <code>pipelines/roles/${esc(s.instructions.slice(6))}.md</code>.` : ''}${s.needs?.length ? ` Needs an agent that can use ${esc(s.needs.join(' and '))}.` : ''}`;
    }
    if (s.type !== 'agent' && /^guide:/.test(s.guide ?? '')) what += ` Also follows the role guide <code>pipelines/roles/${esc(s.guide.slice(6))}.md</code>.`;
    return `<li data-node="${s.type === 'build' ? 'dev' : s.id}"><b>${who}</b> ${what}</li>`;
  }).join('');
}

async function renderPipelinesTab() {
  const list = await loadPipelines();
  const el = $('#pipelines-tab');
  if (!S.pipeId || !list.some(p => p.id === S.pipeId && p.draft === S.pipeDraft)) {
    const first = list.find(p => p.draft && p.review?.status !== 'approved') ?? list.find(p => p.id === 'standard') ?? list[0];
    S.pipeId = first?.id; S.pipeDraft = first?.draft;
  }
  const p = list.find(x => x.id === S.pipeId && x.draft === S.pipeDraft);
  const status = x => !x.draft ? '<span class="chip ok">Approved</span>'
    : x.review?.status === 'changes_requested' ? '<span class="chip warn">Changes asked</span>'
    : x.review?.status === 'approved' ? '<span class="chip ok">Approved</span>' : '<span class="chip warn">Waiting for your review</span>';
  const item = x => `<li data-pipe="${esc(x.id)}" data-draft="${x.draft ? 1 : 0}" class="${x === p ? 'selected' : ''}">
      <span class="title">${esc(x.def?.name ?? x.id)}</span><span class="sub">${status(x)}${x.errors.length ? `<span class="chip bad">${plural(x.errors.length, 'problem')}</span>` : ''}</span></li>`;
  const drafts = list.filter(x => x.draft && x.review?.status !== 'approved');
  el.innerHTML = `<aside class="runs"><div class="runs-head">Drafts to review</div><ul class="pipe-list">${drafts.map(item).join('') || '<li class="hint" style="cursor:default">None. Ask the AI to create one with the new-pipeline skill.</li>'}</ul>
      <div class="runs-head">Approved</div><ul class="pipe-list">${list.filter(x => !x.draft).map(item).join('')}</ul></aside>
    <section class="run-view">${p ? pipelineDetail(p) : '<div class="empty"><h2>No pipelines</h2></div>'}</section>`;
  if (p?.def?.steps && !p.errors.some(e => /exactly one|first step|not valid JSON|non-empty/.test(e))) {
    DEF = p.def;
    $('#pipe-diagram').innerHTML = renderPipeline({ def: p.def, mode: 'pipeline', stages: {}, edges: {}, status: 'preview' }, true);
  }
}

function pipelineDetail(p) {
  const d = p.def ?? {};
  const isDraft = p.draft && p.review?.status !== 'approved';
  return `<div class="run-head"><div><h1>${esc(d.name ?? p.id)}</h1>
      <div class="meta"><span class="mono">${p.draft ? 'pipelines/drafts/' : 'pipelines/'}${esc(p.id)}.json</span><span>updated ${new Date(p.updatedAt).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div></div>
      ${!p.draft ? `<button type="button" class="btn primary" data-run-with="${esc(p.id)}">Start a run with this pipeline</button>` : ''}</div>
    <p class="lede">${esc(d.description ?? '')}</p>
    ${p.errors.length ? `<div class="banner bad"><b>Not valid yet.</b> It cannot be approved until these are fixed:<ul>${p.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${p.review?.status === 'changes_requested' ? `<div class="banner warn">You asked for changes: “${esc(p.review.feedback ?? '')}”. The AI will update the draft.</div>` : ''}
    <section class="card pipeline"><div class="card-head"><h3>Flow</h3><span class="hint">Dashed arrows show where work can be sent back</span></div><div class="pipeline-wrap" id="pipe-diagram"></div></section>
    <section class="card"><div class="card-head"><h3>Step by step</h3></div><div class="card-body"><ol class="pipe-steps">${d.steps ? describeSteps(d) : ''}</ol></div></section>
    ${isDraft ? `<section class="card gate"><div class="card-head"><h3>Review this pipeline</h3><span class="hint">Only approved pipelines can be used for a run</span></div>
      <div class="gate-actions"><textarea id="pipe-feedback" placeholder="What should change? (required for “Ask for changes”)"></textarea>
        <button type="button" class="btn ok" data-pipe-decision="approve" ${p.errors.length ? 'disabled title="Fix the problems first"' : ''}>Approve pipeline</button>
        <button type="button" class="btn" data-pipe-decision="revise">Ask for changes</button><span class="hint" id="pipe-msg"></span></div></section>` : ''}
    <details class="glossary"><summary>Raw definition (JSON)</summary><pre class="code">${esc(JSON.stringify(d, null, 2))}</pre></details>`;
}


// ---------- Benchmark ----------

const SIZES = ['S', 'M', 'L', 'XL', 'Brownfield', 'CR'];
const SIZE_NAME = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large', Brownfield: 'Change existing code', CR: 'Change request on existing code' };
const ROLE_TAG = { baseline: 'Baseline', control: 'Control group', candidate: 'What we test' };
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
/** Fewer runs than this per group: say plainly that nothing can be concluded yet. */
const MIN_N = 10;

async function renderBench() {
  const { results: all, arms: armList, tasks } = await (await fetch('/api/bench')).json();
  const ARM = Object.fromEntries(armList.map(a => [a.id, a]));
  const order = ['single-vanilla', 'single-process', 'multi-same', 'multi-cross'].filter(id => ARM[id]);
  const TASK = Object.fromEntries(tasks.map(t => [t.id, t]));
  const el = $('#bench-tab');
  const chip = id => `<span class="arm-chip" style="--arm:${ARM[id]?.color}">${esc(ARM[id]?.code ?? id)}</span>`;

  const intro = `<h1>AI team vs one AI</h1>
    <p class="lede">Does splitting the work across several AIs (each one sees only its own part) beat <b>one AI that keeps everything in a single memory</b>? And how much more does it cost?</p>`;

  const armCards = `<section class="section"><h2>The 4 contestants</h2>
    <p class="hint">Every group gets the exact same task, the same AI model (except C), the same time limit, and is graded by the same hidden tests.</p>
    <div class="arm-cards">${order.map(id => { const a = ARM[id]; return `<div class="arm-card" style="--arm:${a.color}">
      <div class="arm-top"><span class="arm-code">${esc(a.code)}</span><span class="tag ${a.role}">${ROLE_TAG[a.role] ?? ''}</span></div>
      <h4>${esc(a.name)}</h4>
      <div class="agents">${a.agents > 1 ? `${a.agents} AIs, separate memories` : '1 AI, one memory'}</div>
      <p class="desc">${esc(a.summary)}</p>
      <ol class="mini-flow">${a.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>`; }).join('')}</div>
    <div class="banner info"><b>Why is there a group A+?</b> If we only compared A and B and B won, people could say B won because it <i>follows better steps</i>, not because it <i>splits the work into a team</i>. A+ is one AI following exactly the same steps as the team. So <b>B vs A+</b> is the fair answer to “does a team of AIs help?”</div></section>`;

  const how = `<section class="section"><h2>How we judge</h2><div class="how">
    <div><span class="num">1</span><b>Same task</b><p>Every group starts from the same starter project in its own folder. Runs happen in random order so no group gets a luckier time slot.</p></div>
    <div><span class="num">2</span><b>Same measuring tools</b><p>Tokens, time and cost are counted the same way for every group. Going over the time limit counts as a failure.</p></div>
    <div><span class="num">3</span><b>Hidden tests</b><p>A person writes tests in advance that no AI ever sees. They are added only after the work is done. <b>Passing every one of them is what counts as “solved”.</b></p></div>
  </div></section>`;

  if (!all.length) {
    el.innerHTML = `${intro}${armCards}${how}<section class="card"><div class="empty"><h2>No results yet</h2><p>Start a pilot with:</p>
      <div class="code-block">npm run bench -- --tasks S-01-cart --arms single-vanilla,single-process,multi-same --reps 2</div>
      <p class="hint">Add <code>--profile fake</code> to test the setup without using any quota.</p></div></section>`;
    return;
  }

  const suites = [...new Set(all.map(r => r.suite))].sort().reverse();
  const suite = S.benchSuite && suites.includes(S.benchSuite) ? S.benchSuite : suites[0];
  const rs = all.filter(r => r.suite === suite);
  const present = order.filter(a => rs.some(r => r.arm === a));
  const stat = a => {
    const x = rs.filter(r => r.arm === a), ok = x.filter(r => r.resolved);
    return {
      n: x.length, ok: ok.length, rate: x.length ? ok.length / x.length : 0,
      cpr: ok.length ? x.reduce((n, r) => n + r.costUsd, 0) / ok.length : null,
      tokens: median(x.map(r => r.tokens.total)), time: median(x.map(r => r.wallMs)),
      fixes: x.reduce((n, r) => n + (r.fixIterations ?? 0), 0) / (x.length || 1),
    };
  };
  const ST = Object.fromEntries(present.map(a => [a, stat(a)]));
  const fake = rs.some(r => r.profile?.startsWith('fake'));
  const taskCount = new Set(rs.map(r => r.task)).size;

  // The three questions, answered in sentences
  const questions = [
    ['multi-same', 'single-process', 'Does splitting into a team help?', 'Main question', 'Both groups follow the same steps. The only difference is one AI or several.'],
    ['single-process', 'single-vanilla', 'Does following a process help?', '', 'Both are one AI. The only difference is the forced steps and the system re-running tests.'],
    ['multi-cross', 'multi-same', 'Do checkers from another vendor help?', '', 'Same team. The only difference is that QA and Reviewer use another vendor’s model.'],
  ].filter(([x, y]) => ST[x] && ST[y]);
  const answer = ([x, y, q, tag, why]) => {
    const a = ST[x], b = ST[y];
    const diff = Math.round((a.rate - b.rate) * 100);
    const small = Math.min(a.n, b.n) < MIN_N;
    let costLine = 'Cost per solved task can’t be compared yet (a group has no solved runs).';
    if (a.cpr != null && b.cpr != null && b.cpr > 0) {
      const ratio = a.cpr / b.cpr;
      costLine = Math.abs(ratio - 1) < 0.05 ? 'Cost per solved task is about the same.'
        : `Cost per solved task is ${(ratio > 1 ? ratio : 1 / ratio).toFixed(1)}× ${ratio > 1 ? 'higher' : 'lower'} (${fmtUsd(a.cpr)} vs ${fmtUsd(b.cpr)}).`;
    }
    const verdict = small ? `<span class="chip warn">Too little data (${Math.min(a.n, b.n)} runs per group, need at least ${MIN_N}) · no conclusion yet</span>`
      : Math.abs(diff) < 10 ? '<span class="chip">About the same</span>'
      : `<span class="chip ${diff > 0 ? 'ok' : 'bad'}">Trend: ${ARM[x].code} is ${diff > 0 ? 'better' : 'worse'}</span>`;
    return `<div class="answer ${tag ? 'main' : ''}">
      <div class="q">${tag ? `<span class="tag candidate">${tag}</span>` : ''}<h3>${q}</h3><p class="hint">${why}</p></div>
      <div class="vs">
        <div><div class="big" style="color:${ARM[x].color}">${Math.round(a.rate * 100)}%</div><div class="who">${chip(x)} ${esc(ARM[x].name)}</div><div class="hint">solved ${a.ok} of ${a.n} runs</div></div>
        <div class="vs-mid">vs</div>
        <div><div class="big" style="color:${ARM[y].color}">${Math.round(b.rate * 100)}%</div><div class="who">${chip(y)} ${esc(ARM[y].name)}</div><div class="hint">solved ${b.ok} of ${b.n} runs</div></div>
      </div>
      <p class="sentence">${diff === 0 ? 'Same success rate.' : `${ARM[x].code} solved ${Math.abs(diff)} points ${diff > 0 ? 'more' : 'less'} often.`} ${costLine}</p>
      ${verdict}</div>`;
  };

  // Metric rows: one bar per arm, with which direction is better
  const metricRow = (label, better, get, fmt) => {
    const vals = present.map(a => get(ST[a])).filter(v => v != null);
    const max = Math.max(...vals, 1e-9);
    const best = better === 'higher' ? Math.max(...vals) : Math.min(...vals);
    const allSame = vals.every(v => v === vals[0]);
    return `<div class="metric"><div class="metric-head"><b>${label}</b><span class="hint">${better} is better</span></div>
      ${present.map(a => { const v = get(ST[a]); return `<div class="bar-row wide">${chip(a)}<span class="bar-track"><span class="bar-fill" style="width:${v == null ? 0 : Math.max(2, (v / max) * 100)}%;background:${ARM[a].color}"></span></span>
        <span class="bar-val">${v == null ? '–' : fmt(v)}${v != null && v === best && !allSame ? ' · best' : ''}</span></div>`; }).join('')}</div>`;
  };
  const sizes = SIZES.filter(s => rs.some(r => r.size === s));

  el.innerHTML = `${intro}
    <div class="suite-bar"><span>Result set <b>${esc(suite)}</b> · ${plural(rs.length, 'run')} · ${plural(taskCount, 'task')}</span>
      ${suites.length > 1 ? `<select id="suite-select" class="btn">${suites.map(s => `<option ${s === suite ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}</div>
    ${fake ? '<div class="banner warn"><b>These results come from the fake (scripted) AI.</b> It writes pre-written code, so this only proves the measuring setup works. <b>It is not evidence that one approach is better.</b></div>' : ''}
    ${armCards}
    ${how}
    <section class="section"><h2>Results</h2>
      ${questions.length ? `${answer(questions[0])}<div class="answers">${questions.slice(1).map(answer).join('')}</div>` : '<p class="hint">At least 2 groups are needed to compare.</p>'}</section>
    <section class="section"><h2>Metric by metric</h2><div class="card"><div class="card-body metrics">
      ${metricRow('Success rate', 'higher', s => s.rate, v => `${Math.round(v * 100)}%`)}
      ${metricRow('Cost per solved task', 'lower', s => s.cpr, fmtUsd)}
      ${metricRow('Time per run (median)', 'lower', s => s.time, fmtDur)}
      ${metricRow('Tokens per run (median)', 'lower', s => s.tokens, fmtTok)}
      ${metricRow('Fix rounds needed (average per run)', 'lower', s => s.fixes, v => v.toFixed(1))}
      <p class="hint">“Cost per solved task” = total cost of all runs (failed ones included) ÷ number of solved runs. A cheap group that often fails ends up looking as expensive as it really is.</p>
    </div></div></section>
    <section class="section"><h2>Success rate by task size</h2><div class="card"><div class="card-body">
      ${sizes.length > 1 ? chartBySize(rs, present, ARM) : `<p class="hint">There is only one task size so far (${sizes.map(s => SIZE_NAME[s] ?? s).join(', ')}). This chart appears once tasks of several sizes exist. The expectation: the bigger the task, the bigger the AI team’s advantage.</p>`}
    </div></div></section>
    <section class="section"><h2>Every run</h2><div class="card"><div class="table-wrap"><table class="results">
      <tr><th>Task</th><th>Size</th><th>Group</th><th>Run #</th><th>Solved?</th><th>Hidden tests passed</th><th>Tokens</th><th>Cost</th><th>Time</th><th>Fix rounds</th><th>Files blocked</th></tr>
      ${[...rs].sort((a, b) => a.task.localeCompare(b.task) || order.indexOf(a.arm) - order.indexOf(b.arm) || a.rep - b.rep).map(r => `<tr>
        <td>${esc(TASK[r.task]?.title ?? r.task)}</td><td>${esc(SIZE_NAME[r.size] ?? r.size)}</td><td>${chip(r.arm)} ${esc(ARM[r.arm]?.name ?? r.arm)}</td><td>${r.rep}</td>
        <td class="${r.resolved ? 'yes' : 'no'}">${r.resolved ? 'Solved' : 'Not solved'}</td><td>${r.hidden.pass}/${r.hidden.total}</td>
        <td>${fmtTok(r.tokens.total)}</td><td>${fmtUsd(r.costUsd)}</td><td>${fmtDur(r.wallMs)}</td><td>${r.fixIterations ?? 0}</td><td>${r.guardViolations ?? 0}</td></tr>`).join('')}
    </table></div></div></section>
    <details class="glossary"><summary>Glossary</summary><dl>
      <dt>Solved</dt><dd>Passed every hidden test. Passing 12 of 13 still counts as not solved.</dd>
      <dt>Hidden tests</dt><dd>Tests a person wrote in advance. No AI sees them before grading, so they can’t be gamed.</dd>
      <dt>Tokens</dt><dd>The unit for how much text an AI reads and writes. More tokens means more of your quota used.</dd>
      <dt>Cost</dt><dd>What the run would cost at the vendor’s API prices, so groups can be compared even though we pay a monthly plan.</dd>
      <dt>Fix rounds</dt><dd>How many times the system ran the tests, saw failures, and sent the work back to be fixed.</dd>
      <dt>Files blocked</dt><dd>Files an AI tried to change without permission (for example, Dev editing a test). The system put them back.</dd>
      <dt>Memory (context)</dt><dd>Everything an AI has to keep in mind while it works. When it gets too large, AIs tend to forget or get confused, which is why we try splitting the work into a team.</dd>
    </dl></details>`;
  $('#suite-select')?.addEventListener('change', e => { S.benchSuite = e.target.value; renderBench(); });
}

function chartBySize(rs, arms, ARM) {
  const sizes = SIZES.filter(s => rs.some(r => r.size === s));
  const w = 640, h = 260, pl = 40, pb = 30, pt = 10, gw = (w - pl - 10) / sizes.length, bw = Math.min(34, (gw - 16) / arms.length);
  const y = v => pt + (h - pt - pb) * (1 - v);
  let g = [0, .25, .5, .75, 1].map(v => `<line class="axis" x1="${pl}" x2="${w - 10}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join('');
  sizes.forEach((s, i) => {
    const x0 = pl + i * gw + (gw - bw * arms.length) / 2;
    arms.forEach((a, j) => {
      const x = rs.filter(r => r.size === s && r.arm === a);
      if (!x.length) return;
      const rate = x.filter(r => r.resolved).length / x.length;
      g += `<rect x="${x0 + j * bw + 2}" y="${y(rate)}" width="${bw - 4}" height="${y(0) - y(rate)}" rx="3" fill="${ARM[a].color}"><title>${ARM[a].code} · ${SIZE_NAME[s] ?? s}: ${Math.round(rate * 100)}% (${plural(x.length, 'run')})</title></rect>`;
    });
    g += `<text class="tick" x="${pl + i * gw + gw / 2}" y="${h - 10}" text-anchor="middle">${SIZE_NAME[s] ?? s}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" class="chart">${g}</svg><div class="legend">${arms.map(a => `<span><i style="background:${ARM[a].color}"></i>${ARM[a].code} · ${esc(ARM[a].name)}</span>`).join('')}</div>`;
}

// ---------- Boot ----------

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#pipeline-tab').hidden = tab !== 'pipeline';
  $('#pipelines-tab').hidden = tab !== 'pipelines';
  $('#bench-tab').hidden = tab !== 'bench';
  if (tab === 'bench') renderBench();
  if (tab === 'pipelines') renderPipelinesTab();
  if (tab === 'pipeline' && S.selected) update(true);
  history.replaceState(null, '', tab === 'pipelines' ? `#pipelines${S.pipeId ? `=${S.pipeId}` : ''}` : S.selected ? `#run=${S.selected}` : '#');
}

async function boot() {
  S.config = await (await fetch('/api/config')).json();
  $('#profile-select').innerHTML = S.config.profiles.map(p => `<option ${p === S.config.defaultProfile ? 'selected' : ''}>${esc(p)}</option>`).join('');
  // Explain the chosen profile, and fill in the demo project folder it needs
  const showNote = () => {
    const note = S.config.profileNotes?.[$('#profile-select').value] ?? '';
    $('#profile-note').textContent = note;
    const folder = note.match(/project folder (\S+?)\.?$/)?.[1];
    const source = $('#new-run-form [name=source]');
    if (folder && (!source.value || source.dataset.auto)) { source.value = `${S.config.studioRoot}/${folder}`; source.dataset.auto = '1'; }
    if (!folder && source.dataset.auto) { source.value = ''; delete source.dataset.auto; }
  };
  $('#profile-select').addEventListener('change', showNote);
  $('#new-run-form [name=source]').addEventListener('input', e => { delete e.target.dataset.auto; });
  showNote();
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#run-list').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select(li.dataset.id); });
  // Hovering a box or a step line highlights the other
  $('#pipelines-tab').addEventListener('mouseover', e => {
    const node = e.target.closest('[data-node]')?.dataset.node;
    $('#pipelines-tab').querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
    if (node) $('#pipelines-tab').querySelectorAll(`[data-node="${node}"]`).forEach(x => x.classList.add('hl'));
  });
  $('#pipelines-tab').addEventListener('click', async e => {
    const li = e.target.closest('li[data-pipe]');
    if (li) { S.pipeId = li.dataset.pipe; S.pipeDraft = li.dataset.draft === '1'; return setTab('pipelines'); }
    const runWith = e.target.closest('[data-run-with]');
    if (runWith) return openNewRun(runWith.dataset.runWith);
    const btn = e.target.closest('[data-pipe-decision]');
    if (!btn) return;
    const feedback = $('#pipe-feedback').value.trim();
    if (btn.dataset.pipeDecision === 'revise' && !feedback) { $('#pipe-msg').textContent = 'Write what should change first.'; return; }
    const r = await fetch(`/api/pipelines/${S.pipeId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: btn.dataset.pipeDecision, feedback }) });
    if (!r.ok) { $('#pipe-msg').textContent = (await r.json()).error; return; }
    if (btn.dataset.pipeDecision === 'approve') S.pipeDraft = false;
    renderPipelinesTab();
  });

  // Diagram boxes filter the log; hovering either side highlights the other
  const view = $('#run-view');
  document.addEventListener('click', e => {
    const chip = e.target.closest('.file-chip');
    if (chip) { e.preventDefault(); openFile(chip.dataset.seq, chip.dataset.file); }
  });
  $('#file-close').addEventListener('click', () => $('#file-dialog').close());
  const roleDialog = $('#role-dialog');
  $('#role-close').addEventListener('click', () => roleDialog.close());
  roleDialog.addEventListener('click', e => { if (e.target === roleDialog) roleDialog.close(); });
  roleDialog.addEventListener('close', () => { S.popup = null; update(); });
  roleDialog.addEventListener('toggle', e => { if (e.target.matches?.('details.step')) S.open.set(e.target.dataset.id, e.target.open); }, true);
  view.addEventListener('mouseover', e => {
    const file = e.target.closest('.file-chip')?.dataset.file;
    if (file === S.hoverFile) return;
    S.hoverFile = file;
    view.querySelectorAll('.file-chip.lit').forEach(x => x.classList.remove('lit'));
    if (file) view.querySelectorAll(`.file-chip[data-file="${CSS.escape(file)}"]`).forEach(x => x.classList.add('lit'));
  });
  view.addEventListener('click', e => {
    if (e.target.closest('.file-chip')) return;
    const ver = e.target.closest('[data-arch-version]');
    if (ver) { S.archVersion = Number(ver.dataset.archVersion); S.archKey = null; return update(); }
    const node = e.target.closest('.node.clickable[data-node]');
    if (node) return openRole(node.dataset.node);
    const copy = e.target.closest('[data-copy]');
    if (copy) { e.preventDefault(); navigator.clipboard?.writeText(copy.dataset.copy); copy.textContent = 'Copied'; }
  });
  view.addEventListener('toggle', e => { if (e.target.matches?.('details.step')) S.open.set(e.target.dataset.id, e.target.open); }, true);
  view.addEventListener('mouseover', e => {
    const node = e.target.closest('[data-node]')?.dataset.node;
    if (node === S.hover) return;
    S.hover = node;
    view.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
    if (node) view.querySelectorAll(`[data-node="${node}"]`).forEach(x => x.classList.add('hl'));
  });

  $('#new-run-btn').addEventListener('click', () => openNewRun());
  $('#pipeline-select').addEventListener('change', () => {
    const p = S.pipelines?.find(x => x.id === $('#pipeline-select').value);
    $('#pipeline-note').textContent = p?.def?.description ?? '';
  });
  $('#new-run-form').addEventListener('submit', async e => {
    if (e.submitter?.value !== 'start') return;
    const f = new FormData(e.target);
    const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      requirement: f.get('requirement'), label: f.get('label'), source: f.get('source'), profile: f.get('profile'), pipeline: f.get('pipeline'), autoApprove: f.get('autoApprove') === 'on',
    }) });
    const out = await r.json();
    if (!r.ok) { e.preventDefault(); $('#start-error').textContent = out.error; return; }
    const { runId } = out;
    $('#start-error').textContent = '';
    e.target.reset();
    setTab('pipeline');
    await select(runId);
  });
  setInterval(() => document.querySelectorAll('[data-elapsed]').forEach(el => {
    if (!el.dataset.ended && el.dataset.elapsed !== 'undefined') el.textContent = fmtDur(Date.now() - Number(el.dataset.elapsed));
  }), 1000);
  new ResizeObserver(() => {
    drawArch($('#arch'), plannedArchitecture());
    if (S.gate && gateKind(S.gate.gate) === 'plan') drawArch($('#gate-slot'), S.gate.payload.plan?.architecture);
  }).observe(document.body);
  connect();
  refreshRunList();
  loadPipelines();
  setInterval(() => { if (S.tab === 'pipelines') renderPipelinesTab(); else loadPipelines(); }, 5000);
  // A run's process can end without a word (closed terminal, crash): look again now and then
  setInterval(() => { if (S.tab === 'runs' || S.selected) checkResume(); }, 15000);
  const pipeHash = location.hash.match(/^#pipelines(?:=([\w-]+))?/);
  if (pipeHash) { S.pipeId = pipeHash[1]; S.pipeDraft = true; }
  const fromHash = location.hash.match(/run=([\w-]+)/)?.[1];
  await select(fromHash ?? null);
  if (!fromHash) {
    S.runs = await (await fetch('/api/runs')).json();
    if (S.runs[0]) await select(S.runs[0].runId);
  }
  if (pipeHash) setTab('pipelines');
}

boot();
