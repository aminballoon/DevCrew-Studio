# DevCrew Bench — Multi-Agent vs Single-Agent

เป้าหมาย: หาหลักฐานที่ **คนอื่นตรวจซ้ำได้** ว่า pipeline แบบ Multi-Agent ให้ผลดีกว่าการใช้ agent ตัวเดียวที่แบก context ทั้งหมดหรือไม่ ในงานแบบไหน และแลกกับต้นทุนเท่าไร

> หลักการ: benchmark ที่น่าเชื่อถือต้อง **พร้อมรายงานผลที่ Multi-Agent แพ้ด้วย** ถ้าออกแบบให้ฝั่งเราชนะแน่ๆ คนที่ฟังจะจับได้และไม่เชื่อ

---

## 1. คำถามและสมมติฐาน (เขียนก่อนรัน แล้วห้ามแก้ภายหลัง)

| # | สมมติฐาน | วัดด้วย |
|---|---|---|
| H1 | Multi-Agent แก้งานได้สำเร็จมากกว่า Single-Agent | Resolve rate จาก hidden tests |
| H2 | ยิ่งงานใหญ่ ช่องว่างระหว่างสองวิธียิ่งกว้าง เพราะ single agent เจอ context ล้นหรือถูก compact | Resolve rate แยกตามขนาดงาน (S/M/L/XL) |
| H3 | Multi-Agent ใช้ token รวม **มากกว่า** แต่ **ต้นทุนต่องานที่สำเร็จ** ไม่แย่กว่า | Tokens ต่องาน และ Cost per resolved task |
| H4 | Multi-Agent ให้ผลสม่ำเสมอกว่าเมื่อรันซ้ำ | ความแปรปรวนระหว่างรอบ และ pass^k |
| H5 | โค้ดของ Multi-Agent ดูแลต่อง่ายกว่าและปลอดภัยกว่า | lint/type errors, security findings, blind review |

H3 ตั้งไว้อย่างซื่อตรง: Multi-Agent น่าจะใช้ token มากกว่า จุดที่ต้องพิสูจน์คือ **ความคุ้ม** ไม่ใช่ความถูก

---

## 2. Arms — ผู้เข้าแข่งขัน

ปัญหาสำคัญ: ถ้าเทียบแค่ "pipeline" กับ "agent เดียวที่สั่งตรงๆ" เราจะแยกไม่ออกว่าผลดีมาจาก **การแบ่ง agent** หรือจาก **กระบวนการ** (วางแผนก่อน, TDD, verify) จึงต้องมี arm ควบคุมตรงกลาง

| Arm | รายละเอียด | ใช้ตอบคำถามอะไร |
|---|---|---|
| **A — Single (Vanilla)** | Claude Code session เดียว รับ requirement แล้วทำจนจบ รันเทสเองได้ | baseline ที่คนส่วนใหญ่ใช้กันอยู่ |
| **A+ — Single (Process)** | agent เดียวเหมือนเดิม แต่ prompt สั่งให้ทำตามขั้นเดียวกับ pipeline (PRD → contract → เทสก่อน → โค้ด → self-review) และมี Verify loop ภายนอกพร้อมเพดานรอบเท่ากัน | **arm ควบคุม** แยกผลของ "กระบวนการ" ออกจากผลของ "การแบ่ง agent" |
| **B — Multi (Same model)** | DevCrew pipeline ทุกบทบาทใช้ Claude รุ่นเดียวกัน | ผลของการแบ่ง agent และแยก context ล้วนๆ |
| **C — Multi (Cross-vendor)** | DevCrew pipeline โดย Dev ใช้ Claude ส่วน QA/Reviewer ใช้ Codex | ผลเพิ่มจากการใช้โมเดลต่างกันตรวจกัน |

การอ่านผล:
- **B − A+** = คุณค่าของ Multi-Agent จริงๆ (ตัวเลขนี้คือสิ่งที่ควรเอาไปบอกคนอื่น)
- **A+ − A** = คุณค่าของกระบวนการ (ซึ่งได้แม้ไม่ใช้ Multi-Agent)
- **C − B** = คุณค่าของการใช้หลาย vendor

### กติกาความยุติธรรม
- **ใช้ instrument เดียวกันทุก arm**: ทุก arm รันผ่าน ACP harness ตัวเดียวกัน, adapter เดียวกัน (`claude-agent-acp`) และวัด token ด้วยวิธีเดียวกัน
- **Pin เวอร์ชัน**: model ID, เวอร์ชัน CLI/adapter และ prompt ของแต่ละ arm (เก็บ hash ไว้ในผลลัพธ์)
- **เพดานเท่ากัน**: wall-clock สูงสุดต่องาน (เช่น 60 นาที) และเพดาน token ต่องาน ถ้าเกินนับเป็น fail
- **Human Gate ปิดใน benchmark** (auto-approve) เพื่อวัดความสามารถของระบบล้วนๆ ส่วนโหมดที่มีคนช่วยวัดแยกต่างหาก (ดู §6)
- **สภาพแวดล้อมสะอาดทุกรอบ**: git worktree ใหม่จาก seed เดิม, ไม่มี memory หรือ session ค้าง, สิทธิ์ network เหมือนกัน
- **สลับลำดับการรัน** ระหว่าง arm เพื่อไม่ให้ช่วงเวลาที่โควต้าใกล้หมดหรือ server ช้าไปตกที่ arm เดียว

---

## 3. Task Suite — โจทย์แข่งขัน

### หัวใจ: Hidden Tests
แต่ละโจทย์มี **ชุดเทสลับที่คนเขียน** ซึ่ง agent ไม่เคยเห็น โดยจะ copy เข้าไปตอนตรวจหลังรันจบเท่านั้น ข้อนี้กันไม่ให้ arm ไหน "ผ่านเทสของตัวเอง" แล้วนับว่าสำเร็จ

ต้องกำหนดสิ่งที่ interface ต้องมี (ชื่อ endpoint, CLI args, signature ของ function) ไว้ใน requirement ให้ชัด เพื่อให้ hidden tests ใช้ได้กับทุก arm โดยไม่บังคับ implementation

### ระดับโจทย์

| ระดับ | ลักษณะ | ตัวอย่าง | จำนวน |
|---|---|---|---|
| **S** | ฟีเจอร์เดียว 1–3 ไฟล์ | เพิ่ม endpoint + validation | 3 |
| **M** | ฟีเจอร์ข้ามหลายโมดูล | auth + RBAC บน API ที่มีอยู่ | 3 |
| **L** | แอปเล็กตั้งแต่ศูนย์ | Todo API + DB + tests ครบ | 3 |
| **XL / Long-horizon** | ฟีเจอร์ใหญ่ หรือ requirement หลายเฟส | ระบบจองห้องประชุม ที่มี 3 เฟสส่งต่อกัน | 2 |
| **Brownfield** | เพิ่มฟีเจอร์ใน repo จริงขนาดกลาง (5k–20k LOC) | เพิ่มฟีเจอร์ใน open-source repo ที่ fork มา | 2 |
| **Change Request** | ระหว่างทำมี requirement เปลี่ยน (ส่ง message ที่ 2 กลางทาง) | เปลี่ยน schema หลังเริ่มเขียนโค้ดแล้ว | 1 |

รวมประมาณ **14 โจทย์** ระดับ XL, Brownfield และ Change Request คือจุดที่สมมติฐาน H2 ทำนายว่า Multi-Agent จะได้เปรียบ ส่วนระดับ S คือจุดที่ Single น่าจะชนะเรื่องต้นทุน ต้องมีทั้งสองแบบผลจึงจะน่าเชื่อ

### กัน contamination
- เขียนโจทย์เอง ไม่ใช้โจทย์ยอดนิยมที่โมเดลอาจเคยเห็น
- (ไม่บังคับ) เพิ่ม SWE-bench Verified 3–5 ข้อเป็น **external anchor** ให้คนอื่นเทียบกับตัวเลขที่รู้จักได้ แต่ไม่ใช้เป็นตัวตัดสินหลัก เพราะโจทย์แนวนั้นเป็นการแก้ bug เดี่ยวๆ ซึ่งเข้าทาง single agent

### โครงสร้างโจทย์

```
bench/tasks/<task-id>/
├── task.yaml          # ระดับ, เพดานเวลา/token, ภาษา, คำสั่ง build/test
├── requirement.md     # ข้อความที่ทุก arm ได้รับ (เหมือนกันทุกตัวอักษร)
├── change_request.md  # (ถ้ามี) ส่งเข้าไปกลางทาง ณ จุดที่กำหนด
├── seed/              # repo เริ่มต้น
└── hidden/
    ├── tests/         # ชุดเทสลับ
    └── rubric.md      # เกณฑ์ blind review
```

---

## 4. Metrics

### Quality (ตัวตัดสินหลัก)
| Metric | นิยาม |
|---|---|
| **Resolve rate** ⭐ | % ของรอบที่ผ่าน hidden tests **ครบทุกข้อ** |
| Hidden test pass % | สัดส่วนเทสที่ผ่าน (ให้คะแนนบางส่วน) |
| Regression | เทสเดิมของ seed ที่พังหลังรันจบ (สำคัญมากในโจทย์ Brownfield) |
| Static quality | จำนวน lint error, type error, ค่า complexity และโค้ดซ้ำ |
| Security | จำนวน finding จาก semgrep และการตรวจ secret |
| Blind review | คะแนน 1–5 ตาม rubric โดยผู้ตรวจ **ไม่รู้ว่าโค้ดมาจาก arm ไหน** (ใช้คน หรือ LLM judge ที่ไม่ใช่โมเดลที่ใช้ใน arm) และใช้เป็นตัวชี้วัดรองเท่านั้น |

### Cost
| Metric | นิยาม |
|---|---|
| Tokens | input / output / cache read / cache write แยกตามบทบาทและ vendor |
| **API-equivalent $** | token × ราคา API ณ วันรัน คำนวณไว้ให้คนอื่นเทียบได้ แม้ว่าเราจ่ายแบบ subscription |
| **Cost per resolved task** ⭐ | $ รวมทุกรอบ ÷ จำนวนรอบที่สำเร็จ (ตัวเลขนี้แฟร์กว่าการดู $ ต่อรอบ) |
| Quota burn | % ของลิมิต 5 ชั่วโมงที่ใช้ไปต่องาน (มีความหมายสำหรับคนที่ใช้ subscription) |

### Time
| Metric | นิยาม |
|---|---|
| Wall-clock | ตั้งแต่เริ่มจนจบ |
| Fix iterations | จำนวนรอบ Dev ⇄ Verify |
| Human time | เวลาที่คนใช้ตรวจที่ Gate (วัดเฉพาะโหมด Assisted) |

### Context (ใช้พิสูจน์ H2 โดยตรง)
| Metric | นิยาม |
|---|---|
| Peak context | context สูงสุดต่อ session (ของ multi ให้ดูต่อ agent) |
| Compaction events | จำนวนครั้งที่ถูก auto-compact |
| Requirement drift | Acceptance Criteria ข้อที่ถูกลืมหรือทำผิด เทียบกับ requirement |

### Reliability
- รัน **อย่างน้อย 3 รอบต่อ (task × arm)** และ 5 รอบถ้าโควต้าพอ
- รายงาน **pass@1** (อัตราสำเร็จเฉลี่ย) และ **pass^k** (สำเร็จทั้ง k รอบ) ซึ่งตัวหลังวัดความสม่ำเสมอ

---

## 5. สถิติและการนำเสนอ

- **Paired comparison ต่อโจทย์**: เทียบ arm ในโจทย์เดียวกัน แล้วรวมผลด้วย bootstrap confidence interval 95%
- ข้อมูลน้อย (14 โจทย์ × 3 รอบ) **ห้ามสรุปเกินข้อมูล** ให้รายงานช่วงความเชื่อมั่นเสมอ ถ้าช่วงคร่อม 0 ให้เขียนว่า "ยังไม่ต่างอย่างมีนัยสำคัญ"
- **Failure taxonomy**: ทุกรอบที่ fail ให้จัดหมวด (ไม่เข้าใจสเปก, ลืม AC, regression, หมดเวลา, วนไม่จบ, โกงเทส, context ล้น) ซึ่งมีค่ามากกว่าตัวเลขรวม เพราะบอก **ว่าทำไม** ถึงต่าง

### กราฟหลักที่จะเอาไปนำเสนอ
1. **Resolve rate × ขนาดงาน** (เส้นละ arm) แสดงจุดที่ Multi-Agent เริ่มคุ้ม ⭐ ใช้เป็นกราฟหลัก
2. **Cost per resolved task** ของแต่ละ arm
3. **Quality vs Cost scatter** (1 จุด = 1 รอบ) เพื่อหา Pareto frontier
4. **Failure taxonomy** แบบ stacked bar ต่อ arm
5. **Ablation waterfall**: A → A+ → B → C แสดงว่าผลดีมาจากตรงไหน

---

## 6. โหมดเสริม: Assisted Run

benchmark หลักปิด Human Gate แต่ในงานจริงคนอนุมัติ จึงรันโจทย์ M/L บางข้อในโหมดที่มีคนอยู่ด้วย:
- ทั้ง Single และ Multi ให้คนแทรกแซงได้ตามปกติ
- วัด **จำนวนครั้งที่ต้องแทรกแซง**, **เวลาของคน** และ **ผลสุดท้าย**
- ใช้ตอบคำถามที่ผู้บริหารสนใจ: "คนต้องเฝ้าน้อยลงไหม"

---

## 7. Harness Architecture

```
bench/
├── tasks/                  # §3
├── arms/
│   ├── single-vanilla.yaml # prompt + config
│   ├── single-process.yaml
│   ├── multi-same.yaml
│   └── multi-cross.yaml
├── runner/
│   ├── run.ts              # matrix (task × arm × rep) → สุ่มลำดับ → รัน
│   ├── workspace.ts        # สร้าง worktree สะอาดจาก seed
│   ├── acp-recorder.ts     # ครอบ ACP client: บันทึกทุก message + usage
│   ├── quota-gate.ts       # รอเมื่อโควต้าไม่พอ (ใช้ probe จาก vscode-acp)
│   └── grade.ts            # copy hidden tests → รัน → lint/semgrep → score
├── results/
│   └── <run-id>/
│       ├── meta.json       # versions, hashes, เวลาเริ่ม/จบ
│       ├── transcript.jsonl# ACP traffic ทั้งหมด (ใช้วิเคราะห์ failure)
│       ├── usage.json
│       └── grade.json
└── report/                 # สร้างกราฟและ summary จาก results/
```

จุดสำคัญ:
- **`acp-recorder` คือเครื่องมือวัดตัวเดียวที่ทุก arm ใช้** ซึ่งรับประกันว่าวัด token แบบเดียวกัน
- **Single-agent arm ใช้ harness เดียวกัน** แค่เป็น graph ที่มี node เดียว จึงไม่ต้องสร้างระบบแยก
- **เก็บ transcript ทุกรอบ** ทำให้คนอื่นตรวจซ้ำได้ และใช้ทำ failure analysis ได้
- ทดสอบ harness ด้วย `fake-agent.mjs` ก่อน เพื่อไม่เปลืองโควต้ากับบั๊กของ harness

---

## 8. งบโควต้าและแผนการรัน

เต็มชุด: 14 โจทย์ × 4 arm × 3 รอบ = **168 รอบ** ซึ่งใช้โควต้า subscription หนัก จึงต้องทยอยรันหลายสัปดาห์ผ่าน `quota-gate`

| เฟส | ขอบเขต | เป้าหมาย |
|---|---|---|
| **0. Pilot** | 3 โจทย์ (S, M, L) × arm A, A+ × 2 รอบ | ทดสอบ harness และ grader, ประเมินว่ารอบหนึ่งใช้โควต้าเท่าไร ทำได้ **ก่อน pipeline เสร็จ** |
| **1. Baseline** | ทุกโจทย์ × A, A+ × 3 รอบ | ได้ตัวเลข baseline ไว้ใช้ตั้งเป้า |
| **2. Head-to-head** | ทุกโจทย์ × B (+C) × 3 รอบ | ผลหลัก |
| **3. Assisted** | 3–4 โจทย์ M/L | ตัวเลขฝั่งคน |

ข้อดีของลำดับนี้: เฟส 0–1 ทำคู่ขนานกับการสร้าง pipeline ได้ และ baseline ช่วยบอกว่า pipeline ต้องเก่งกว่าเท่าไรจึงจะคุ้ม

---

## 9. Checklist ความน่าเชื่อถือ (ก่อนเอาไปนำเสนอ)

- [ ] สมมติฐานและเกณฑ์ใน §1 ถูก commit **ก่อน** รันเฟส 2
- [ ] Hidden tests และ requirement ถูก review โดยคนที่ไม่ได้เขียน pipeline
- [ ] ทุก arm ใช้ model ID, เพดาน และ instrument เดียวกัน
- [ ] รายงานทุกรอบ รวมรอบที่ fail และรอบที่ harness พัง ห้ามคัดทิ้ง
- [ ] เปิดเผย prompt ของทุก arm, transcript และ script คำนวณกราฟ
- [ ] มี arm A+ เพื่อแยกผลของกระบวนการออกจากผลของ Multi-Agent
- [ ] ระบุข้อจำกัดชัดเจน: จำนวนโจทย์, ภาษาที่ใช้, เวอร์ชันโมเดล ณ วันที่รัน
