# Preset: System integration design (`system-integration`)

**Use it for:** designing a system made of hardware and software parts and choosing the parts,
with evidence, before anyone builds it. No code is written.
**Kind:** design (ends in approved documents and a system architecture diagram).
**Definition:** `pipelines/system-integration.json`. **Status:** approved 2026-10-12; a version using role guides is waiting for review in `pipelines/drafts/`.

## What to prepare

- **Requirement:** what the system must do and the constraints. The more numbers, the better the
  part choices (payload, range, speed, accuracy, runtime, environment, budget, quantity).
- **Source folder (optional):** existing documents, drawings or datasheets to take into account.

### Requirement template

```markdown
# <System name>

## Goal
<What the system does and for whom.>

## Requirements
- Performance: <e.g. carries 20 kg, 1 m/s, 8 h runtime>
- Environment: <indoor, temperature range, dust, water>
- Interfaces: <systems it must talk to>
- Safety: <emergency stop, certifications>
- Budget and quantity: <e.g. under 3,000 USD per unit, 10 units>

## Already decided
- <Parts, platforms or software that are fixed>

## Buying constraints
<Where it must be bought, e.g. available in Thailand>
```

## Steps

The Agent column is the default. A profile in `devcrew.config.json` can give any role another
agent by its step id (for example `"scout": "codex"`); see [README](README.md#which-ai-does-each-role).

| # | Step | Agent | Writes / hands on |
|---|---|---|---|
| 1 | **System architect** | claude | `.devcrew/system.json` (the diagram), `.devcrew/SYSTEM.md` |
| 2 | **You: Gate 1** "Review the system architecture" | | approve, or send back to the architect |
| 3 | **Hardware scout** | claude | `.devcrew/hardware/options.md`; writes the recommended part into each block of the diagram |
| 4 | **Architecture reviewer** | codex | `.devcrew/arch-review.md` (advice only) |
| 5 | **You: Gate 2** "Approve the design" | | approve and commit the documents, or send back to the architect (the scout and reviewer then run again) |

The reviewer uses a different vendor from the architect and the scout on purpose, for a second
opinion.

### The system architecture diagram: `.devcrew/system.json`

Blocks (compute, controller, sensor, actuator, power, network, storage, software, interface,
external, user), optional groups (subsystems), the chosen part per block, and links with their
interface (for example `UART 921600`, `24 V`) and kind (data, control, power, mechanical). The
dashboard draws it at both gates. The format is in `src/orchestrator/system.ts`.

### `.devcrew/SYSTEM.md`

Goal and constraints, each block with the requirements a part must meet, the data, control and
power paths, failure and safety behaviour, and open questions for you.

### `.devcrew/hardware/options.md`

Two to four parts per hardware block: part number, maker, key specs, interfaces, power, operating
temperature, price and seller, stock or lead time, lifecycle status, software support, datasheet
URL, with one recommendation and its trade-off. Every fact has a source URL and the date checked;
unknown facts say "unknown". Parts hard to buy in Thailand or Southeast Asia are noted. You decide.

### `.devcrew/arch-review.md`

Interfaces that do not match, the power budget per rail, bandwidth and latency, timing, single
points of failure, thermal limits, safety and emergency stop paths, software support and total cost,
rated by severity with a fix or alternative part.

## Role guides and agent needs

- Guides: [system-architect](../roles/system-architect.md), [hardware-scout](../roles/hardware-scout.md), [architecture-reviewer](../roles/architecture-reviewer.md). They hold each role's full instructions.
- **Hardware scout** needs `web`. A run is refused before it starts if the profile gives a role an agent that cannot do what it needs.

## What you review

- **Gate 1:** are the blocks and interfaces right? Change the structure here, before parts are searched.
- **Gate 2:** the diagram with parts, the options, and the review. Approving commits the documents
  to a branch. To build something from it, start a build pipeline with these documents as the source.

## Cost

The hardware scout searches the web for every block and is the most expensive turn. Sending the
design back at Gate 2 runs the scout again.
