# สถานะโปรเจกต์

อัปเดตล่าสุด: 2026-10-12

## Latest changes (2026-10-12, UX pass 1)
- Platform rule: **English only, no emoji** in the product (UI, configs, CLI output).
- Run view: kept the original pipeline diagram; unused detour arrows are now hidden until they happen. Clicking a box filters the activity log to that role; hovering highlights the matching box and log steps.
- Activity log is grouped into steps (one per box visit) with plain-English lines and short tags (EDIT, RUN, SAYS, BLOCKED, PASS, FAIL, USAGE) instead of raw events.
- A one-line "what is happening now" sentence sits above the stats.
- Benchmark page: explains the 4 groups (A, A+, B, C) with plain names, steps and roles before any numbers; "How we judge" section; results answered as questions ("Does splitting into a team help?") with an explicit "too little data" warning below 10 runs per group; metric-by-metric bars; glossary.
- Arm descriptions now live in `bench/arms/*.json` (code, name, summary, steps, role, color) and are served by `/api/bench`.
- CLI output uses text tags instead of symbols.

## Latest changes (2026-10-12, UX pass 2: inputs and outputs)
- Every agent turn now records `agent_input` (who it came from, which files it reads, the exact prompt) and `agent_output` (files it produced, with their content at handoff time, and who receives them). Verify records the commands it ran.
- Role contracts (receives / produces / hands to / may write) are defined once in `src/orchestrator/roles.ts` and served by `/api/config`.
- Run view: new **Handoffs** card under the pipeline. One column per role (You, Planner, QA, Dev, Verify, Reviewer) with what it received and produced; file chips are colored by the role that wrote them; hovering a file highlights everywhere it was passed on; an Orchestrator band explains that roles only hand off through files.
- Activity log steps show an INPUT block (sources, files, "show the exact instructions") and an OUTPUT block (files written, handed to). Gate steps show what you were shown and where your decision sent the run.
- Clicking a box in the diagram shows that role's contract above its log.
- File viewer dialog shows any handed-off file as it was at that moment.
- Pipeline test now checks inputs/outputs are recorded and that reverted files are not handed on.
- Runs made before this change have no input/output events, so their Handoffs card stays mostly empty.

## Latest changes (2026-10-12, UX pass 3: plain words)
- New card **What happened, in plain words** above the technical Handoffs card, for people who don't write code. Same columns (You, Planner, QA, Developer, Checker, Reviewer), each with Got / Gave in everyday language: no file names, "checks" instead of tests, "parts" instead of modules.
- Its numbers come from the run's real files: acceptance criteria counted in PRD.md, part names from plan.json, checks counted in QA's test files, lines of code from Dev's files, the reviewer's verdict and number of notes from review.md, tries per part, and pass/fail counts.
- The technical card is now labelled "(technical view)".
- Not yet covered: wording for runs that fail or are cancelled midway is generic ("Nothing yet"), and the plain card has not been tested with a real agent's files (real PRDs may not use the AC-1 numbering it counts).

## Latest changes (2026-10-12, file-level architecture at Gate 1)
- `plan.json` now requires `architecture.files`: every file the run will create, with path, kind (contract / source / test / config / doc), modules, purpose, exports and dependsOn. A plan without it, or with a file that has no purpose, is sent back to the Planner before it reaches you (`src/orchestrator/plan.ts`, covered by `test/plan.test.ts`).
- QA's instructions list the planned test files; Dev's instructions list the planned files for its module with their purpose, exports and dependencies.
- Gate 1 opens on an **Architecture** tab: a UML-style diagram (one box per file with «kind», purpose, exports, part, who writes it), arrows for implements / uses / tests, and a table of every file. The approve button reads "Approve plan and architecture".
- New **Code architecture** card in the run view: the same diagram with each file's status (built by whom, or not built yet) and a warning listing files that were created but are not in the approved design.
- Not yet: nothing stops Dev from creating unplanned files; they are only flagged. The diagram layout is simple (columns by dependency depth) and may get crowded for plans with many files.

## Latest changes (2026-10-12, architecture as the Planner's deliverable + more cases)
- The architecture is shown as the Planner's output: its log step ends with "Proposed architecture, version N, sent to you for review at Gate 1" and the diagram.
- Every design the Planner hands over is a version. The Code architecture card has version tabs, the review result of each ("changes asked", "approved", with time), and what changed from the previous version (added / removed / changed files). Gate 1 shows the same change summary, and new or changed files get a "New" / "Changed" tag in the diagram.
- Tests sit together in the last column of the diagram; boxes shrink to fit the width before the diagram scrolls.
- New demo cases (agent profiles, no quota), each with a note in the New run dialog that also fills in the right project folder:
  - `fake-expenses`: medium expense-splitter project, 3 parts, 8 then 9 files. Ask for changes at Gate 1 and the Planner sends version 2 with a single entry point. Dev's first ledger attempt fails once.
  - `fake-trouble`: Dev never fixes cart-core, edits a test every time (reverted) and adds `src/helpers.ts`, which is outside the design; the run stops at the escalation gate.
- New benchmark task `M-01-expenses` (size M, 11 hidden tests). `task.json` can name a `fakeProfile`, used by `npm run bench -- --profile fake`. The `demo-fake` suite now has S and M results, so the size chart shows.
- Tests: 13 (added the medium revise flow and the unattended trouble run).
- Fixed: the "fake results" warning on the Benchmark page now covers every fake profile.

## Latest changes (2026-10-12, role popup)
- Clicking a box in the pipeline diagram now opens a popup with that role's contract and every step it took (input, activity, output, and the Planner's proposed architecture), instead of filtering the activity log and scrolling the page. The page stays where it is.
- The popup updates live while the run is going, and closes with the Close button, Esc, or a click outside it. File chips inside it still open the file viewer.
- The activity log at the bottom always shows every step.
- Fixed: wide architecture diagrams inside log steps no longer stretch the log or the popup sideways; they scroll inside their own box.

## Latest changes (2026-10-12, pipelines as files + new-pipeline skill)
- **Pipelines are JSON files** in `pipelines/` (`standard`, `minimal`, `with-security`). The graph, each role's scope and agent, the dashboard diagram, the handoff and plain-words cards and the code gate all come from the file. Each run stores the definition it started with, so later edits never change a running pipeline. Runs from before this change show as `standard`.
- **Step types:** `planner`, `qa`, `build` (Dev + Verify + Escalation), `gate` (review `plan` or `code`, `reviseTo` an earlier step) and `agent` (an extra role: purpose, instructions or `builtin:reviewer`, reads, mayWrite, produces, optional verdict that reports or sends work back to Dev with a round limit).
- **Validator** (`src/pipeline/schema.ts`, documented in `pipelines/SCHEMA.md`): planner first and followed by a plan gate; last step a code gate; qa before build; extra roles cannot write `tests/`, `contracts/` or everything; every loop back to Dev is capped. Covered by `test/pipeline-schema.test.ts`.
- **Drafts and review:** new pipelines are written to `pipelines/drafts/`. Only you can approve them: the dashboard's new **Pipelines** tab (diagram with every possible detour, step-by-step text, problems, Approve / Ask for changes) or `npm run pipeline -- approve <id>`. Feedback is saved next to the draft so the AI can read it.
- **Skill `new-pipeline`** (`.claude/skills/new-pipeline/SKILL.md`): turns a plain request into a draft, validates it, summarises it for you and waits for your review; it never approves on its own. A sample draft made with it, `with-docs` (adds a docs writer), is waiting in the Pipelines tab.
- New run dialog: choose the pipeline. CLI: `--pipeline <id>`. Benchmark arms can name a `pipeline`.
- The code gate shows every reviewer's report (one tab each); extra roles are orange in the diagram and cards.
- Tests: 20 (validator rules, a security step that sends work back once, the minimal pipeline).
- Not yet: the fake demo agent only has scripts for the built-in roles and `security`, so other new roles write nothing in demo runs. Diagrams of long pipelines get crowded. Gate ids changed from `spec`/`merge` to the step ids (`gate_spec`/`gate_merge`); old runs still display correctly.

## Latest changes (2026-10-12, role guides, agent capabilities, isolated Claude)
- **Role guides:** `pipelines/roles/<name>.md` holds a role's instructions; steps use `"instructions": "guide:<name>"`. Seven guides from the three presets. Approval records each guide's hash (`guideHashes`); a changed guide puts the pipeline back under review. Runs keep the guide text they started with.
- **Capabilities:** steps declare `needs` (`web`, `shell`); agents declare `provides` in `devcrew.config.json` (`claude`: web, shell; `codex`: shell). A run whose profile gives a role an agent without what it needs is refused before it starts; an agent that declares nothing gets a warning in the run log.
- **`claude-isolated`** agent and profile: Claude without your user-level settings, skills, plugins and CLAUDE.md (`settingSources: project, local` via the ACP session `_meta`). Checked with a real session: `claude` lists your synced skills, `claude-isolated` only Claude Code's built-in ones. It copies `ANTHROPIC_BASE_URL` and the model from `~/.claude/settings.json`; keep them in step. Agent specs can pass any `sessionMeta`.
- New drafts of `existing-code`, `firmware-board` and `system-integration` that use the guides and declare needs, waiting for review (the approved versions keep working).
- Tests: 29.

## Latest changes (2026-10-12, presets approved, profiles choose vendors)
- `existing-code`, `firmware-board` and `system-integration` are approved and live in `pipelines/`.
- **Presets:** `pipelines/presets/` has one page per preset (use it for, what to prepare, requirement template, steps with agents and outputs, what to review, cost and limits) and a README with how to run any preset. The `new-pipeline` skill now writes a page for every approved pipeline.
- **Profiles choose vendors:** a role's agent comes from the profile's entry for its role or step id first, then the `"agent"` the step names, then the profile's reviewer. A new profile can move any preset to another vendor without editing the pipeline.

## Latest changes (2026-10-12, research roles, design pipelines, HIL rig)
- **Roles before the Planner:** agent steps may now come before the planner, writing only under `.devcrew/` (research and analysis, not code). The Planner, QA and Dev are told to read their reports, and every gate shows the reports of the roles before it (one tab per role; the plan gate too).
- **Design pipelines** (`"kind": "design"`): agent steps and `design` gates only, no planner, QA or build. The last design gate commits the documents. A role allowed to write `.devcrew/system.json` is given the diagram format (`src/orchestrator/system.ts`); design gates draw it as a **system architecture diagram** (blocks by kind, links labelled with their interface; data, control, power and mechanical links styled apart). An invalid diagram gets one automatic fix turn.
- **Gate feedback to agent steps:** a gate can send work back to an agent step (plan gates: the planner or any agent step before build). Your notes go to every role re-run on the way back to that gate.
- Each agent step's prompt now includes the customer's requirement.
- Dashboard: design runs hide the code architecture, module progress and test stats; the plain-words cards follow pipeline order; markdown tables render in reports. The `CUSTOM ROLE` badge is now `ADVISORY`.
- Three drafts waiting for review: `existing-code` (codebase analyst before the Planner), `firmware-board` (board researcher and HIL rig engineer before the Planner, firmware reviewer that can send work back twice, 4 tries per part) and `system-integration` (design only: architect, hardware scout, architecture reviewer on codex).
- The HIL rig engineer writes the rig to `.devcrew/hil/` (probe, flash, serial monitor, run with a per-board lock; local USB, SSH test host or USB hub port control). `.devcrew/` is read-only for Dev, so Dev cannot change the rig to make tests pass.
- Fake demo agent: scripted turns for `codebase`, `board`, `hil`, `firmware`, `architect`, `scout` and `arch`.
- Tests: 25 (roles before the planner, design pipeline rules and a full design run with revise).
- Not yet: a gate can send work back to one step only. HIL tests need the real board and tools on the machine running DevCrew (or the SSH host); nothing in the platform manages boards beyond the rig's lock.

## ✅ ทำแล้ว

### เอกสาร
- [CONCEPT.md](CONCEPT.md): แนวคิด, สถาปัตยกรรม 2 ชั้น, guardrails, roadmap
- [BENCHMARK.md](BENCHMARK.md): การออกแบบ benchmark (4 arm, hidden tests, metrics, สถิติ)
- [README.md](../README.md): วิธีติดตั้งและใช้งาน

### โค้ด (TypeScript, Node 22+)
| ส่วน | ไฟล์ | สถานะ |
|---|---|---|
| Event log (JSONL + live subscribe) | `src/core/events.ts` | ✅ |
| Config + agent profiles (`claude`, `cross-vendor`, `fake`) | `src/core/config.ts`, `devcrew.config.json` | ✅ |
| Scope ต่อบทบาท (ใครเขียน path ไหนได้) | `src/core/scope.ts` | ✅ |
| ACP client แบบ headless (ดัดแปลงจาก `~/vscode-acp`) | `src/acp/AgentSession.ts` | ✅ ทดสอบกับ fake agent เท่านั้น |
| Guard: snapshot และ revert การแก้นอก scope | `src/guard/snapshot.ts` | ✅ |
| Verify: รันเทส, ล็อกไฟล์เทสด้วย hash, ตรวจจำนวนเทส | `src/guard/verify.ts` | ✅ |
| Workspace: git worktree หรือ copy + git init, diff, commit | `src/guard/workspace.ts` | ✅ ทดสอบแค่โหมด copy |
| LangGraph graph: setup → planner → gate_spec → qa → dev ⇄ verify → escalate → reviewer → gate_merge → finish | `src/orchestrator/graph.ts` | ✅ |
| RunManager: start, resolveGate, SQLite checkpoint, resume ข้าม process | `src/orchestrator/RunManager.ts` | ✅ |
| Single-agent baseline (arm A และ A+) | `src/orchestrator/single.ts` | ✅ |
| Prompt ของแต่ละบทบาท | `src/orchestrator/prompts.ts` | ✅ ร่างแรก ยังไม่ได้จูนกับโมเดลจริง |
| CLI (`start`, `gate`, `list`) | `src/cli.ts` | ✅ |
| Dashboard: server (REST + SSE) | `src/dashboard/server.ts` | ✅ |
| Dashboard: หน้าเว็บ | `src/dashboard/public/*` | ✅ |
| Fake agent แบบ scripted + script ตะกร้าสินค้า | `agents/` | ✅ |
| Benchmark runner (สุ่มลำดับ, time limit, ตรวจด้วย hidden tests, ข้ามรอบที่ทำแล้ว) | `bench/runner/run.ts` | ✅ |
| Arm configs 4 ตัว | `bench/arms/*.json` | ✅ |
| โจทย์ `S-01-cart` + hidden tests 13 ข้อ | `bench/tasks/S-01-cart/` | ✅ |
| LangGraph Studio config | `langgraph.json` | ⚠️ เขียนไว้แต่ยังไม่ได้เปิดใช้จริง |

### Dashboard (ตรวจในเบราว์เซอร์แล้ว ทั้งจอใหญ่และจอมือถือ 375px)
- รายการ run พร้อมจุดสีบอกสถานะ, token และเวลา
- การ์ดตัวเลข: เวลา, token, cost, เทสที่ผ่าน, จำนวนรอบแก้ และ guard blocks
- แผนภาพ pipeline สด: node ที่กำลังทำงาน, เส้นทางที่ผ่าน, fix loop, เส้นส่งกลับ และ badge จำนวนครั้ง มีแผนภาพแยกสำหรับ run แบบ agent เดียว
- Gate 1: PRD (render markdown), รายการโมดูล, contracts
- Gate 2: รายการไฟล์ +/−, diff แบบมีสี, review, tests, token
- Escalation: เหตุผลที่ไม่ผ่าน, output ของเทส
- ปุ่มของ Gate: Approve / Request changes (บังคับใส่ feedback) / Abort / Retry / Replan
- ฟีดกิจกรรมแบบสด (auto-scroll), แผงความคืบหน้าของโมดูล, token แยกบทบาท (input/cached/output)
- หน้า Benchmark: การ์ดแต่ละ arm, กราฟ resolve rate ตามขนาดงาน, scatter คุณภาพเทียบต้นทุน, ตารางผล, เลือก suite ได้ และมีป้ายเตือนเมื่อผลมาจาก fake agent
- Dark/Light mode ตามระบบ

### การทดสอบ
- `npm test`: 8/8 ผ่าน (guard 6 ข้อ, e2e pipeline 2 ข้อ) และ `npm run typecheck` ผ่าน
- Pipeline ครบวงจรกับ fake agent ทั้งแบบ auto และแบบกด Gate เอง รวมถึงการ resume ข้าม process
- Benchmark `demo-fake` 6 รอบ (A, A+, B × 2 รอบ)

### Bug ที่เจอและแก้แล้ว
1. Verify นับเทสได้ 0 เมื่อรันผ่าน dashboard เพราะ `FORCE_COLOR` ทำให้มีโค้ดสี ANSI ปน → แก้ด้วยการตัด ANSI ออกและล้าง env ของ process ลูก (`src/core/env.ts`) มีเทสครอบแล้ว
2. `node --test` ที่รันซ้อนใน test runner ไม่พิมพ์ผล เพราะได้รับ `NODE_TEST_CONTEXT` → แก้ที่ `childEnv()` มีเทสครอบแล้ว
3. กด Approve ทันทีที่ Gate ขึ้นแล้วโดนปฏิเสธว่า "Run is busy" → `resolveGate` รอ job ปัจจุบันจบก่อน มีเทสครอบแล้ว
4. timer ของ time limit ใน benchmark ไม่ถูกยกเลิก จึงส่ง event "failed" ปลอมเข้า run ที่จบไปแล้ว → แก้แล้ว **ยังไม่มีเทส**
5. ในโหมด auto การไปถึง Escalation ถูกนับเป็น `aborted` → เปลี่ยนเป็น `failed`

---

## ⏳ ยังไม่ได้ทำ

### สำคัญที่สุด
- [ ] **ทดสอบกับ agent จริง** (`claude-agent-acp`, `codex-acp`): ยังไม่รู้ว่า adapter ส่ง `usage` และ `cost` ครบไหม, permission flow ทำงานถูกไหม และ prompt ใช้ได้จริงไหม
- [ ] Pilot benchmark กับ Claude จริงบน `S-01-cart` (2–3 รอบ) เพื่อวัดว่าหนึ่งรอบใช้โควต้าเท่าไร

### Pipeline
- [ ] Quota-aware scheduling: เช็คโควต้าก่อนเริ่มแต่ละขั้น, พักรอเมื่อหมด แล้วทำต่อเอง (reuse `ClaudeUsageProbe` และ `CodexRateLimits` จาก vscode-acp)
- [ ] Resume run ที่ค้างสถานะ running เพราะ server ดับระหว่างที่ agent ทำงาน (ตอนนี้ resume ได้เฉพาะตอนรอที่ Gate)
- [ ] ทดสอบโหมด git worktree กับ repo จริง และการ merge branch `devcrew/<runId>`
- [ ] แสดงโควต้าสดของแต่ละ vendor บน dashboard
- [ ] เปิดและทดสอบ LangGraph Studio จริง
- [ ] Container หรือ network sandbox สำหรับ agent (ตอนนี้แยกแค่โฟลเดอร์และ scope ของไฟล์)
- [ ] รองรับภาษาอื่นนอกจาก Node/TS ใน Verify (ตัว parse ผลเทสรองรับแค่ `node:test`)

### Presets ใหม่ (existing-code, firmware-board, system-integration)
- [ ] รันทั้ง 3 preset กับ agent จริง (ตอนนี้ทดสอบแค่กับ demo agent)
- [ ] firmware-board: Verify อ่านผลเทสได้แค่รูปแบบ `node:test` เทส firmware (Unity, ctest, pytest, HIL) ต้องห่อด้วย node:test หรือต้องเพิ่มตัวอ่านผลเทสแบบอื่น
- [ ] firmware-board: ทดสอบ HIL rig กับบอร์ดจริง (flash, serial, lock, SSH) ยังไม่เคยรันกับ hardware
- [ ] เช็คว่า Codex ผ่าน `codex-acp` ค้นเว็บได้ไหม ถ้าได้ เพิ่ม `web` ใน `provides`
- [ ] ส่งต่อจาก design pipeline ไป build pipeline (ใช้ branch ของ design เป็น source) ตอนนี้ต้องทำเอง
- [ ] System diagram: ป้ายเส้นซ้อนกัน เส้นยาวลากผ่านกล่อง ยังไม่มีปุ่ม export เป็น SVG/PNG
- [ ] Gate ส่งงานกลับได้ทีละ step เดียว
- [ ] `claude-isolated` คัดลอก proxy และ model จาก `~/.claude/settings.json` ไว้ ควรอ่านค่าจากไฟล์เองอัตโนมัติ
- [ ] แท็บ Pipelines ยังไม่แสดงเนื้อหาคู่มือ role (เห็นแค่ชื่อไฟล์)

### Benchmark
- [ ] เพิ่มโจทย์ให้ครบประมาณ 14 ข้อ (S×3, M×3, L×3, XL×2, Brownfield×2, Change Request×1) พร้อม hidden tests ที่มีคนอื่นช่วยตรวจ
- [ ] รองรับโจทย์ Change Request (ส่ง requirement ที่สองเข้าไปกลางทาง)
- [ ] สถิติ: bootstrap confidence interval, paired comparison ต่อโจทย์, pass^k
- [ ] กราฟ ablation waterfall A → A+ → B → C
- [ ] ตัววัดคุณภาพเพิ่มเติม: lint/typecheck, semgrep, blind review
- [ ] จัดหมวดสาเหตุที่ fail (failure taxonomy)
- [ ] โหมด Assisted (มีคนอยู่ด้วย, วัดจำนวนครั้งที่ต้องแทรกแซง)
- [ ] เทสสำหรับ bug ข้อ 4 (timer ของ time limit)
- [ ] เอาผล demo ออกจาก `bench/results/demo-fake` ก่อนนำเสนอ หรือแยกให้ชัดเจน

### Repo
- [ ] `git init` + commit แรก (ตอนนี้โฟลเดอร์ยังไม่เป็น git repo)

---

## 🎨 จุด UX/UI ที่สังเกตเห็นระหว่างทดสอบ (ไว้พิจารณาตอนปรับ)
- แผนภาพ pipeline: ตัวอักษรเล็กมากเมื่อ pane แคบ (ตอนนี้จอแคบกว่า 900px ต้องเลื่อนแนวนอน) และเส้นส่งกลับด้านบนเยอะจนดูรก ถึงแม้จะไม่ได้ใช้
- ไม่มีทางดูไฟล์ใน workspace จาก dashboard นอกจาก diff ตอน Gate 2 และไม่มีปุ่มเปิดหรือคัดลอก path ของ workspace
- Gate 1 แสดงแค่ PRD เปิดดู contracts และ ADR ไม่ได้
- รายการ run: ชื่อยาวถูกตัด ไม่มีตัวกรองหรือค้นหา ลบ run ไม่ได้ และ run ของ benchmark ปนกับ run ปกติ
- ไม่มีตัวบอกว่า run แบบ single เป็น arm ไหน (A หรือ A+)
- ฟีดกิจกรรม: ยาวมากเมื่อ run ยาว และยังไม่มีตัวกรองตามบทบาทหรือประเภท event
- หน้า Benchmark: ยังเทียบข้าม suite ไม่ได้ และยังไม่มีกราฟ waterfall
- ตอนสร้าง run ใหม่ ช่อง Project folder ต้องพิมพ์ path เอง ยังไม่มีตัวเลือกโฟลเดอร์
- ไม่มีการแจ้งเตือนเมื่อ run มาถึง Gate (เช่น เสียงหรือ desktop notification)
- Markdown renderer ทำเองแบบง่าย รองรับตารางแล้ว แต่ยังไม่รองรับลิงก์และ list ซ้อนกัน
