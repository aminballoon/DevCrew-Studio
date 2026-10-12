# Pipeline files

A pipeline says which roles work on a run, in which order, and where you review.
Approved pipelines live in `pipelines/<id>.json`. New ones start as drafts in
`pipelines/drafts/<id>.json` and can only be used after you approve them (in the
dashboard's **Pipelines** tab, or with `npm run pipeline -- approve <id>`).

Check a file at any time:

```bash
npm run pipeline -- validate pipelines/drafts/<id>.json
```

## Shape

```json
{
  "id": "with-docs",
  "name": "Team with a docs writer",
  "description": "One or two sentences: what this pipeline is for and when to use it.",
  "steps": [ ... ]
}
```

`id`: lowercase letters, digits, `-` or `_`, starting with a letter. It is also the file name.

`kind` (optional): `"build"` (default) ends in committed code. `"design"` ends in approved
documents and a system diagram, with no code: see [Design pipelines](#design-pipelines).

## Steps

Steps run top to bottom. Five types exist.

| type | id | How many | What it does |
|---|---|---|---|
| `planner` | `planner` | exactly 1, first | Writes the spec (`.devcrew/PRD.md`), the architecture and parts (`.devcrew/plan.json`) and `contracts/`. |
| `qa` | `qa` | exactly 1, before `build` | Writes tests from the spec before any code exists. Tests and contracts are locked afterwards. |
| `build` | `build` | exactly 1 | Dev builds one part at a time; Verify (the system, not AI) runs the tests after each try. Optional `"maxAttempts"` (1–10) per part, then a human decides. |
| `gate` | your choice | any | You review. See below. |
| `agent` | your choice | any | An extra AI role. See below. It may also come before `planner`, to research or analyse first. |

Reserved ids: `setup`, `finish`, `dev`, `verify`, `escalate`, `single`.

### Gate

```json
{ "type": "gate", "id": "gate_spec", "title": "Review the spec and plan", "review": "plan", "reviseTo": "planner" }
```

- `review`: `"plan"` shows the spec, the architecture and the reports of the roles before it; `"code"` shows the diff, test results and every report; `"design"` (design pipelines only) shows the system diagram and the reports.
- `reviseTo`: the earlier step that gets your feedback when you ask for changes. A plan gate sends it to `planner` or to an agent step before `build`; `"build"` means Dev. Every role re-run on the way back to the gate sees your feedback.
- Approving the **last** gate commits the work.

### Agent (an extra role)

```json
{
  "type": "agent",
  "id": "security",
  "name": "Security reviewer",
  "purpose": "Looks for ways the code could be misused or leak data.",
  "agent": "codex",
  "instructions": "What to do, in plain words, as specific as possible.",
  "reads": ["git diff", ".devcrew/PRD.md", "contracts/"],
  "mayWrite": [".devcrew/security.md"],
  "produces": [".devcrew/security.md: a verdict and findings by severity"],
  "verdict": { "file": ".devcrew/security.md", "onChanges": "dev", "maxRounds": 2 }
}
```

- `purpose`: one plain sentence; it is shown to people who do not write code.
- `agent` (optional): an agent name from `devcrew.config.json` (`claude`, `codex`, ...). A profile that lists this step's id overrides it (`"scout": "codex"`), so you can switch vendors without editing the pipeline. Without either, the profile's reviewer agent plays the role. Demo profiles (`fake*`) always use their scripted agent.
- `instructions`: the role's job. `"builtin:reviewer"` reuses DevCrew's standard code review. `"guide:<name>"` uses the role guide `pipelines/roles/<name>.md`, which several pipelines can share (see [Role guides](#role-guides)).
- `needs` (optional): what the role's agent must be able to do: `"web"` (search and read web pages) and/or `"shell"` (run commands). A run is refused before it starts when the profile gives the role an agent whose `provides` (in `devcrew.config.json`) lacks one.
- `reads`: files or folders (ending in `/`) to read first. `"git diff"` means every code change so far.
- `mayWrite`: the only paths it may change; anything else it touches is put back. Not allowed: `"*"`, `tests/`, `contracts/`, absolute paths, `..`.
- `produces`: plain descriptions of what it hands on.
- `verdict` (optional): the first line of `file` must be `VERDICT: approve` or `VERDICT: changes`.
  - `onChanges: "dev"` sends the code back to Dev with the findings, at most `maxRounds` (1–5) times. Only allowed after `build`.
  - `onChanges: "continue"` just reports; you see the report at the code gate.

## Rules the validator enforces

These keep a person in charge and keep the guardrails intact:

1. Only agent steps come before `planner`, and they may only write under `.devcrew/`. The step right after `planner` is a gate with `"review": "plan"`. You approve the spec and architecture before anything is built.
2. The last step is a gate with `"review": "code"`. You approve the code before it is committed.
3. `qa` comes before `build`: tests are written before code.
4. Extra roles cannot write tests, contracts, or everything.
5. Every loop back to Dev has a limit (`maxAttempts`, `maxRounds`).
6. A code gate comes after `build`; `reviseTo` points to an earlier step that is not a gate.

## Roles before the Planner

Agent steps placed before `planner` run first: a codebase analyst reading existing code, a
researcher looking up a board online, a rig engineer preparing hardware tests. They may only
write under `.devcrew/`, so they leave reports and notes, never code. The Planner, QA and Dev
are told to read what they wrote, and the plan gate shows their reports next to the spec.
`.devcrew/` is read-only for Dev, so anything written there (a test rig, for example) cannot be
changed to make tests pass.

## Design pipelines

```json
{ "id": "system-design", "name": "...", "description": "...", "kind": "design", "steps": [ ... ] }
```

- No `planner`, `qa` or `build`: only `agent` steps and gates with `"review": "design"`.
- At least one agent step; the last step is a design gate. Approving it commits the documents.
- A role whose `mayWrite` includes `.devcrew/system.json` is given the diagram format and draws
  the **system architecture diagram** there: blocks (`compute`, `controller`, `sensor`, `actuator`,
  `power`, `network`, `storage`, `software`, `interface`, `external`, `user`), optional groups,
  the chosen part per block, and links with their interface and kind (`data`, `control`, `power`,
  `mechanical`). Design gates draw it. If it cannot be drawn, the role gets one turn to fix it.

## Role guides

`pipelines/roles/<name>.md` holds a role's know-how in plain English. A step uses it with
`"instructions": "guide:<name>"`; DevCrew puts the text in the role's prompt, so it works the same
with every vendor. Approving a pipeline records the version of each guide it uses
(`guideHashes`, written for you). If a guide changes afterwards, the pipeline shows a problem and
cannot run until you review it again. A run keeps the guide text it started with.

## Presets

`pipelines/presets/` has one page per ready-made pipeline: when to use it, what to prepare, a
requirement template, every role and what it hands on, and how to run it. Read those first when
you only want to use a pipeline.

## Examples

- `standard.json`: Planner, plan gate, QA, build, Reviewer, code gate.
- `minimal.json`: the same without the Reviewer.
- `with-security.json`: adds a security reviewer that can send the code back to Dev twice.
- `existing-code.json`: a codebase analyst before the Planner.
- `firmware-board.json`: a board researcher and a hardware-in-the-loop rig engineer before the Planner.
- `system-integration.json`: a design pipeline with a system architecture diagram.
