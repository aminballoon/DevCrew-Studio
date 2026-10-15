# DevCrew Studio

Multi-agent development pipeline (QA ∥ Builder → Verify → Reviewer, หรือ AI ตัวเดียว) ที่สั่ง coding agent ผ่าน [ACP](https://agentclientprotocol.com/) มี Human Gate ให้หัวหน้าทีมอนุมัติ และมี benchmark harness ไว้เทียบกับการใช้ agent ตัวเดียว

- แนวคิดและสถาปัตยกรรม: [docs/CONCEPT.md](docs/CONCEPT.md)
- การออกแบบ benchmark: [docs/BENCHMARK.md](docs/BENCHMARK.md)

## เริ่มใช้งาน

ต้องใช้ Node 22+ (รัน `.ts` ได้โดยตรง) และ git

```bash
npm install
```

```bash
npm run dashboard
```

เปิด http://localhost:4317 แล้วกด **+ New run** เลือก profile `fake` เพื่อดู pipeline ครบวงจรโดยไม่ใช้โควต้า

## Agent profiles

`devcrew.config.json` กำหนดว่าแต่ละบทบาทใช้ agent ตัวไหน agent ทุกตัวเป็น ACP adapter ที่ใช้ login ของ CLI ของ vendor นั้นๆ (subscription) ตัวระบบไม่เคยถือ token เอง

| Profile | QA | Builder | Reviewer |
|---|---|---|---|
| `claude` | Claude | Claude | Claude |
| `cross-vendor` | Codex | Claude | Codex |
| `fake` | scripted ([agents/scripts/cart.mjs](agents/scripts/cart.mjs)) | | |

## คำสั่ง

| คำสั่ง | ใช้ทำอะไร |
|---|---|
| `npm run dashboard` | Dashboard: pipeline สด, Gate, ฟีดกิจกรรม, token ต่อบทบาท, ผล benchmark |
| `npm run run -- start --requirement <file> [--source <dir>] [--profile fake] [--pipeline single\|fast\|fast-arch] [--addons security,docs] [--auto]` | เริ่ม run จาก CLI |
| `npm run run -- gate <runId> approve` | ตอบ Gate จาก CLI |
| `npm run bench -- --tasks S-01-cart --arms single-vanilla,multi-fast,ext-claude-cli --reps 2` | รัน benchmark |
| `npm run pipeline -- validate <file>` / `list` / `status <id>` / `approve <id>` | Check, list and approve pipeline files (see [pipelines/SCHEMA.md](pipelines/SCHEMA.md)) |
| Skill `/new-pipeline` | Ask Claude Code to design a pipeline from a plain request; it writes a draft you review in the dashboard's Pipelines tab |
| `npm run studio` | เปิด graph ใน LangGraph Studio (ใช้ `langgraph.json`) |
| `npm test` / `npm run typecheck` | เทสและ typecheck |

## โครงสร้าง

```
src/
  core/          event log (JSONL + live), config, scope ของแต่ละบทบาท
  acp/           AgentSession: ACP client แบบ headless (มาจาก ~/vscode-acp)
  guard/         snapshot + revert, Verify (ตัวตัดสินที่ไม่ใช่ AI), workspace/worktree
  orchestrator/  LangGraph graph, prompts, RunManager (SQLite checkpoint), single-agent baseline
  dashboard/     server (SSE) + หน้าเว็บ
agents/          fake agent + scripts
bench/           tasks (hidden tests), arms, runner, results/
```

ข้อมูลของแต่ละ run (event log, checkpoint, workspace) อยู่ใน `.devcrew-data/` ซึ่งไม่ถูก commit

## Guardrails ที่ทำงานอยู่

- แต่ละบทบาทเขียนได้เฉพาะ path ของตัวเอง (`src/core/scope.ts`) การขอ permission และการเขียนไฟล์ผ่าน ACP ที่อยู่นอกขอบเขตจะถูกปฏิเสธ
- หลังทุก turn ระบบเทียบ workspace กับ snapshot และ **revert** การแก้ไขนอกขอบเขต รวมถึงการแก้ผ่าน shell ของ agent เอง
- เทสของ QA (`acceptance/`) ถูกเก็บไว้นอก workspace ระหว่างที่ Builder ทำงาน Builder เห็นแค่ชื่อและข้อความของเทสที่ fail Verify จะตัดสินว่าไม่ผ่านถ้ามีเทส fail หรือ skip หรือจำนวนเทสที่รันได้น้อยกว่าที่ประกาศไว้
- โปรเจกต์ที่มี `.devcrew/architecture.json` (fast-arch) Verify จะตรวจ import ทุกไฟล์ตามกฎของสถาปัตยกรรม
- วนแก้ได้ไม่เกิน `maxFixAttempts` รอบ เกินแล้วไปที่ Escalation Gate (ถ้าเป็นโหมด benchmark นับเป็น failed)

## สิ่งที่ยังไม่ได้ทำหรือยังไม่ได้ทดสอบ

- **ยังไม่ได้ทดสอบกับ agent จริง** (`claude-agent-acp`, `codex-acp`) ทดสอบแค่กับ fake agent
- ยังไม่ได้เปิด LangGraph Studio จริง (`langgraph.json` เตรียมไว้แล้ว)
- ยังไม่มี quota-aware scheduling (รอโควต้ารีเซ็ตแล้วทำต่อเอง)
- ถ้า server ดับระหว่างที่ agent กำลังทำงาน run นั้นจะค้างสถานะ running ยังไม่มีปุ่ม resume (ส่วนการรอที่ Gate กลับมาทำต่อได้ตามปกติ)
- Dashboard ไม่มีระบบ login และ bind อยู่ที่ 127.0.0.1 เท่านั้น
