# DevCrew Studio — Multi-Agent Development Pipeline

แนวคิดหลักคือการสร้าง "Virtual Software House" ที่จำลองกระบวนการพัฒนาซอฟต์แวร์จริง โดยแบ่ง AI ออกเป็นบทบาทเฉพาะทาง และให้คุณเป็น **Approver (หัวหน้าทีม)** ที่ตรวจและอนุมัติงานในแต่ละ Milestone ผ่าน Dashboard

หัวใจของระบบไม่ใช่การแบ่ง "แผนก" ให้ agent แต่คือ **Human Gate + การตรวจสอบอัตโนมัติที่ AI โกงไม่ได้** การแบ่งบทบาทเป็นเพียงวิธีจัดงานให้ตรวจสอบง่าย

---

## 1. Two-Tier System Model

### Control Plane — Orchestrator
- **LangGraph.js + LangGraph Studio** วาด flow และคุม state
  - ใช้ TypeScript เพื่อนำโค้ด ACP client จาก `~/vscode-acp` มาใช้ต่อได้โดยตรง
- **Human-in-the-Loop Gate** ใช้ `interrupt()` หยุด pipeline ไว้รอคำสั่งอนุมัติ
- **Checkpointer (SQLite)** บันทึก state ทุก node ทำให้ resume ได้หลังเครื่องดับ โควต้าหมด หรือรอคนอนุมัติข้ามวัน
- ทำหน้าที่ประสานงานอย่างเดียว ไม่เรียก LLM เอง จึงใช้ทรัพยากรน้อย
- **LangGraph เป็นแค่ชั้นบาง**: ACP worker (`src/acp`), guardrails และ Verify (`src/guard`) รวมถึง event log (`src/core`) ไม่ import LangGraph เลย มีแค่ `src/orchestrator/graph.ts` กับ `RunManager.ts` ที่ผูกกับมัน ถ้าวันหน้าย้ายไป Temporal จะเขียนใหม่แค่สองไฟล์นี้

### Visualization — 2 ชั้น
- **LangGraph Studio**: สำหรับนักพัฒนาใช้ debug graph และ state
- **DevCrew Dashboard** (`npm run dashboard`): สำหรับหัวหน้าทีม ทุกอย่างที่แสดงมาจาก event log ของ run
  - แผนภาพ pipeline สด: node ที่กำลังทำงาน, เส้นทางที่ผ่านมา, จำนวนรอบ fix และการส่งกลับ
  - Gate: อ่าน PRD, plan, diff และ review แล้วกด Approve / Request changes ได้ในหน้าเดียว
  - ฟีดกิจกรรมของ agent, การ block ของ guard, ผล Verify
  - token และ cost แยกตามบทบาท, ความคืบหน้าต่อโมดูล
  - หน้า Benchmark: resolve rate ตามขนาดงาน, คุณภาพเทียบต้นทุน, ตารางผลทุกรอบ

### Worker Plane — Agents ผ่าน ACP
- Orchestrator ทำหน้าที่เป็น **ACP Client** สั่ง agent ผ่าน [Agent Client Protocol](https://agentclientprotocol.com/) (JSON-RPC ทาง stdio) แบบเดียวกับ `vscode-acp`
- Agent แต่ละตัวคือ **CLI ทางการของ vendor ที่ล็อกอินด้วย subscription ไว้แล้ว** เช่น `claude-agent-acp` และ `codex-acp` โดยตัวระบบไม่เคยถือ token ของ vendor เอง
- **ใช้หลาย vendor แยกตามบทบาทได้** เช่น Dev ใช้ Claude Code ส่วน QA/Reviewer ใช้ Codex
  - ได้ทั้งการตรวจที่ไม่มีจุดบอดแบบเดียวกับคนเขียน (คนละโมเดล)
  - และกระจายภาระไปหลาย subscription

#### ส่วนที่ reuse จาก `~/vscode-acp`

| ส่วนประกอบ | ใช้ทำอะไรใน pipeline |
|---|---|
| `core/ConnectionManager`, `core/AcpClientImpl` | spawn agent และคุยด้วย ACP |
| `handlers/PermissionHandler` | ตอบ `session/request_permission` อัตโนมัติตาม **policy ของแต่ละบทบาท** แทนการให้คนกด |
| `handlers/FileSystemHandler` | ดักการเขียนไฟล์ผ่าน `fs/write_text_file` เพื่อบังคับ file lock (ดู §3) |
| `changes/WorkspaceSnapshot` | จับการแก้ไฟล์ที่ agent ทำเองผ่าน shell ซึ่งไม่ผ่าน client |
| `core/ClaudeUsageProbe`, `core/CodexRateLimits` | อ่านโควต้า 5 ชั่วโมงและรายสัปดาห์ เพื่อใช้จัดคิวงานตามโควต้า |
| `session/resume` / `session/load` | ต่อ session เดิมของ agent หลังพัก โดยไม่เสีย context |
| `test-fixtures/fake-agent.mjs` | ทดสอบ orchestrator โดยไม่เปลืองโควต้าจริง |

---

## 2. Core Workflow & Quality Gates

```
[Requirement ภาษาคน]
        │
        ▼
1. Planner Agent ─────────────► PRD + User Stories + Acceptance Criteria
   (PO + Architect)             + DB Schema / API Contract / Directory Structure
        │                         (เขียนลงไฟล์ใน repo ทั้งหมด)
        │
        🛑 [Gate 1: Spec & Architecture Approval]  ◄── ตรวจสเปก / ส่งฟีดแบ็ก
        │ (Approve)
        ▼
2. QA Agent ──────────────────► เขียนเทสจาก Acceptance Criteria + Contract ก่อน
        │                         (Dev ยังไม่เริ่ม → เทสไม่ลำเอียงตามโค้ด)
        │                         ➜ ล็อกไฟล์เทส
        ▼
3. Dev Agent ─────────────────► เขียนโค้ดทีละโมดูล ใน git worktree แยก
        │        ▲
        │        │ Auto-fix loop (สูงสุด N รอบ/โมดูล, ค่าเริ่มต้น 5)
        ▼        │
4. Verify (ไม่ใช่ AI) ─────────► unit + contract test, lint, typecheck,
        │                         security scan, ตรวจว่าเทสไม่ถูกทำให้อ่อนลง
        │
        ├── ผ่าน ────────────────────────────────┐
        ├── ไม่ผ่าน และยังไม่ครบ N รอบ ──► กลับ 3     │
        ├── ครบ N รอบ ──► 🛑 [Escalation] ให้คนตัดสิน│
        └── Dev แจ้งว่าสเปกใช้ไม่ได้ ──► กลับ 1      │
                                                  ▼
5. Reviewer Agent (คนละโมเดลกับ Dev) ──► code review: ดีไซน์, ความซ้ำซ้อน,
        │                                ความปลอดภัย, ตรงกับ ADR ไหม
        ▼
6. Final Summary ─────────────► Code Diff, Test Logs, Review Notes,
        │                         Live Preview, สถิติ (เวลา/รอบ/โควต้า)
        🛑 [Gate 2: Merge Approval]  ◄── กด Merge
        ▼
7. CI จริง (นอก sandbox ของ agent) ─► รันเทสซ้ำบนสภาพแวดล้อมสะอาด
        │
        🛑 [Gate 3: Deploy Approval]  ◄── กด Deploy
```

### สิ่งที่เปลี่ยนจากเวอร์ชันแรก
- **รวม PO + Architect เป็น Planner ตัวเดียว** ใน MVP แต่ยังส่งงานออกมาแยกเป็น 2 ชุด แยกเป็น 2 agent ทีหลังเมื่อมีข้อมูลยืนยันว่าคุ้ม
- **QA เขียนเทสก่อน Dev** (TDD) และใช้ context แยกกัน
- **Auto-fix มีเพดานจำนวนรอบ** ถ้าเกินจะส่งกลับมาหาคน ไม่วนเผาโควต้าไปเรื่อยๆ
- **ย้อนกลับขั้นก่อนได้**: Dev ส่งปัญหาสเปกกลับไป Planner แล้วผ่าน Gate 1 อีกรอบ
- **เพิ่ม Reviewer** เพราะเทสผ่านไม่ได้แปลว่าโค้ดดี
- **แยก Merge กับ Deploy** และให้ CI ตัวจริงเป็นผู้ตัดสินสุดท้าย ไม่ใช่ sandbox ของ agent

---

## 3. Guardrails — กันไม่ให้ AI "โกงเพื่อผ่านเทส"

| ความเสี่ยง | วิธีกัน |
|---|---|
| Dev แก้หรือลบเทสให้ผ่าน | Permission policy ของบทบาท Dev ปฏิเสธการเขียน `tests/**` และ contract files ผ่าน `FileSystemHandler` |
| Dev แก้ไฟล์ผ่าน shell อ้อม policy | หลังจบแต่ละ turn ใช้ `WorkspaceSnapshot` หรือ `git diff` ตรวจ ถ้ามีไฟล์ต้องห้ามถูกแก้ ให้ revert และนับเป็นรอบที่ fail |
| ใส่ `skip`/`only`/mock ทุกอย่าง | ขั้น Verify ตรวจจำนวนเทสและ assertion ต้องไม่ลดลงจากที่ QA ส่งมอบ และห้ามมี skip ใหม่ |
| Agent ทำงานเกินขอบเขต | ทำงานใน **git worktree** (หรือ container) แยกต่อ task, deny network ที่ไม่จำเป็น, ไม่มี secret ของ production |
| วนไม่จบ | เพดานรอบต่อโมดูล + timeout ต่อ turn → Escalation Gate |

---

## 4. Single Source of Truth — ทุกอย่างอยู่ใน repo

Agent ทุกตัวอ่านงานจากไฟล์ ไม่อ่านจากประวัติแชทของ agent ตัวอื่น

```
<project>/
├── .devcrew/
│   ├── PRD.md                 # Planner
│   ├── stories/*.md           # User stories + Acceptance Criteria
│   ├── adr/*.md               # Architecture Decision Records
│   └── runs/<run-id>.json     # สถิติของแต่ละ run
├── contracts/
│   ├── openapi.yaml           # API contract — validate ได้ด้วยเครื่อง
│   └── migrations/*.sql       # DB schema
├── tests/                     # QA (ล็อกสำหรับ Dev)
└── src/                       # Dev
```

- **Contract ต้องตรวจด้วยเครื่องได้** (OpenAPI, SQL) เพื่อให้ QA ทำ contract test ได้จริง
- ได้ **audit trail** จาก git history ว่าใครเปลี่ยนอะไรและผ่าน Gate ไหน
- **รองรับโปรเจกต์ที่มีโค้ดอยู่แล้ว**: ถ้าเป็น repo เดิม Planner ต้องอ่าน codebase และเขียน `adr/0000-existing-architecture.md` ก่อนออกแบบสิ่งใหม่

---

## 5. Dashboard & Observability

- **เห็นความคืบหน้าระหว่าง Gate**: สถานะรายโมดูล (เขียนเทส, กำลังเขียนโค้ด, รอบ fix ที่ 3/5, ผ่าน) และแจ้งเตือนเมื่อเกิด Escalation
- **โควต้าแบบสด**: แสดงลิมิต 5 ชั่วโมงและรายสัปดาห์ของแต่ละ vendor (reuse probe จาก vscode-acp)
- **สถิติต่อ run**: เวลา จำนวนรอบ fix และโควต้าที่ใช้ในแต่ละขั้น ไว้พิสูจน์ว่าระบบคุ้ม และหาว่าขั้นไหนเป็นคอขวด
- **MVP**: ใช้ LangGraph Studio ไปก่อน แล้วค่อยสร้าง Dashboard เองเมื่อรู้แล้วว่าต้องเห็นอะไร

---

## 6. Key Value

- **Fixed Monthly Cost**: จ่ายเป็นค่า subscription รายเดือนตามปกติ ไม่มีค่า API ต่อ token
  - *ข้อจำกัด*: **ค่าใช้จ่ายคงที่ แต่ปริมาณงานที่ทำได้ไม่คงที่** เพราะ subscription มีลิมิตทั้ง 5 ชั่วโมงและรายสัปดาห์
  - ระบบรับมือด้วย **quota-aware scheduling**: เช็คโควต้าก่อนเริ่มแต่ละขั้น ถ้าไม่พอจะพักไว้ด้วย checkpoint และ resume เองเมื่อลิมิตรีเซ็ต หรือย้ายไปใช้ vendor อื่น
  - ตรวจ Terms ของแต่ละ vendor ด้วย เมื่อใช้งานแบบอัตโนมัติ โดยเฉพาะถ้าวันหน้าจะให้คนอื่นใช้ร่วมหรือรันเป็น service
- **Verified Quality** (เดิมเขียนว่า "Deterministic"): LLM ไม่ deterministic สั่งซ้ำผลก็ต่างกัน แต่โค้ด **ต้องผ่านเกณฑ์เดียวกันทุกครั้ง** ได้แก่ เทสที่เขียนก่อนและ Dev แก้ไม่ได้, lint/typecheck/security scan, review จากโมเดลอื่น และ CI ตัวจริง
- **Full Transparency**: เห็นทุกขั้นสดๆ ทุกการตัดสินใจอยู่ใน git และควบคุมได้จริงทุกจุดสำคัญ รวมถึงจุดที่ AI ติด

---

## 7. MVP Roadmap

0. **Benchmark harness + baseline** (ดู [BENCHMARK.md](BENCHMARK.md)): ทำคู่ขนานกับข้อ 1–3 เพื่อให้มีตัวเลขเทียบตั้งแต่วันแรก
1. **Skeleton**: LangGraph.js graph `Planner → QA → Dev ⇄ Verify` + `interrupt()` ที่ Gate 1 และ Escalation + SQLite checkpointer
2. **ACP worker**: แยก ACP client จาก `vscode-acp` ออกมาเป็นแพ็กเกจที่ไม่พึ่ง VS Code พร้อม permission policy ต่อบทบาท และทดสอบด้วย `fake-agent.mjs`
3. **Guardrails**: git worktree ต่องาน, ล็อกไฟล์เทส, ตรวจ diff หลังทุก turn, เพดานรอบ fix
4. **ทดลองจริง** กับฟีเจอร์เล็กๆ 3–5 งาน แล้วเก็บสถิติใน `.devcrew/runs/`
5. **ขยาย** ตามข้อมูลที่ได้: แยก Architect, เพิ่ม Reviewer, quota-aware scheduling, Dashboard ของตัวเอง
