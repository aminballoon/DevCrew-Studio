# Pipeline files

A pipeline says which roles work on a run, in which order, and where you review.
Approved pipelines live in `pipelines/<id>.json`. New ones start as drafts in
`pipelines/drafts/<id>.json` and can only be used after you approve them (in the
dashboard's **Pipelines** tab, or with `npm run pipeline -- approve <id>`).

Check a file at any time:

```bash
npm run pipeline -- validate pipelines/drafts/<id>.json
```

## What ships

- **Single AI** (`--pipeline single`, not a file): one agent plans, codes and tests in one session. On every benchmark task so far it scored the same as the teams at a quarter of the tokens; use it by default.
- `fast.json`: blind QA and one Builder at the same time, Verify, Reviewer, code gate.
- `fast-arch.json`: the same inside a lasting architecture that an Architect writes once and Verify enforces.
- `system-integration.json`: a design pipeline with a system architecture diagram, no code.

Pipelines with a Planner (a spec gate, then QA and a developer per module) were removed: they cost
about three times the fast team for the same result. They are in git history before 2026-10-15.

## Shape

```json
{
  "id": "fast-with-docs",
  "name": "Fast team with a docs writer",
  "description": "One or two sentences: what this pipeline is for and when to use it.",
  "kind": "fast",
  "steps": [ ... ]
}
```

`id`: lowercase letters, digits, `-` or `_`, starting with a letter. It is also the file name.

`kind`: `"fast"` ends in committed code; `"design"` ends in approved documents and a system
diagram, with no code (see [Design pipelines](#design-pipelines)).

A fast pipeline has a blind `qa` step and right after it the `build` step, which run at the same
time. One Builder plans and writes the code and its own tests; QA writes hidden acceptance tests
from the requirement alone, in its own copy of the project. Verify judges with both, failures go
back to the Builder (it sees only the names and messages of failing hidden tests), and a hidden
test that fails twice in a row, or that the Builder disputes, goes back to QA to check.

Before `qa` a fast pipeline may have research roles (agent steps that only write under
`.devcrew/`; the Builder and QA get their reports), and then an Architect
(`"instructions": "builtin:architect"`, which may write `contracts/`) with a gate with
`"review": "architecture"`. The Architect runs only while the project has no
`.devcrew/architecture.json`. That file lists the modules, which module may use which (`mayUse`)
and each module's `interface`; Verify rejects any import that breaks it, on every later run, and a
Builder that needs another design answers `ARCH_CHANGE` and the Architect revises it (see
`pipelines/fast-arch.json`).

## Steps

Steps run top to bottom. Four types exist.

| type | id | How many | What it does |
|---|---|---|---|
| `qa` | `qa` | exactly 1, `"blind": true` | Writes hidden acceptance tests while the Builder works. |
| `build` | `build` | exactly 1, right after `qa` | The Builder plans, codes and tests; Verify (the system, not AI) judges each try. Optional `"maxAttempts"` (1–10), then a human decides. Optional `"mutation"`: see [Mutation check](#mutation-check). |
| `gate` | your choice | any | You review. See below. |
| `agent` | your choice | any | An extra AI role: research before `qa`, reviewers and writers after `build`. See below. |

Reserved ids: `setup`, `finish`, `dev`, `verify`, `escalate`, `single`, `dispute`, `mutation`, `strengthen`.

### Mutation check

```json
{ "type": "build", "id": "build", "mutation": { "maxMutants": 30, "rounds": 1, "budgetMinutes": 10 } }
```

Once Verify passes, the system changes the lines this run wrote in one small way at a time (`>=`
to `>`, `+` to `-`, `&&` to `||`, `floor` to `ceil`, a number plus one, a `!` dropped) and runs QA's
hidden tests on each change. A change they still pass is a mistake they would not catch. Those go
to QA (`rounds` times), which adds tests where the requirement decides the behaviour; the new
tests then run on the real code, so a bug the first suite missed goes back to the Builder like any
failing hidden test. One more check after the last round only measures. All fields are optional
(`{}` uses the defaults above). Turn it on for one run with the **Mutation check** box, `--mutation`
on the CLI, or `"mutation": true` in a bench arm.

### Gate

```json
{ "type": "gate", "id": "gate_merge", "title": "Approve the merge", "review": "code", "reviseTo": "build" }
```

- `review`: `"code"` shows the diff, test results and every report; `"architecture"` shows the Architect's modules, decisions and contracts; `"design"` (design pipelines only) shows the system diagram and the reports.
- `reviseTo`: the earlier step that gets your feedback when you ask for changes; `"build"` means the Builder. Every role re-run on the way back to the gate sees your feedback.
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
  "reads": ["git diff", "contracts/"],
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
  - `onChanges: "dev"` sends the code back to the Builder with the findings, at most `maxRounds` (1–5) times. Only allowed after `build`.
  - `onChanges: "continue"` just reports; you see the report at the code gate.

## Rules the validator enforces

These keep a person in charge and keep the guardrails intact:

1. The last step is a gate with `"review": "code"`. You approve the code before it is committed.
2. QA is blind, and `qa` and `build` come once each, `build` right after `qa`.
3. Before `qa` only research roles that write under `.devcrew/`, then optionally the Architect and its gate.
4. Extra roles cannot write tests, contracts, or everything.
5. Every loop back to the Builder has a limit (`maxAttempts`, `maxRounds`).
6. `reviseTo` points to an earlier step that is not a gate.

## Add-ons

`pipelines/addons/<id>.json` holds steps you attach to a fast pipeline when you start a run (New run form, `--addons a,b` on the CLI, `addons` in the API). An add-on lists steps under `start` (research roles before QA), `afterBuild` (reviewers that may send the code back) and `end` (writers before the final gate), plus the `guideHashes` of the role guides it uses.

- `codebase`: a codebase analyst maps what the change touches in an existing project.
- `security`: a Semgrep-backed security audit that can send the code back twice.
- `docs`: a usage guide for the next developer.
- `hardware`: a board researcher and a HIL rig engineer first, a firmware reviewer after the build.

## Design pipelines

```json
{ "id": "system-design", "name": "...", "description": "...", "kind": "design", "steps": [ ... ] }
```

- No `qa` or `build`: only `agent` steps and gates with `"review": "design"`.
- At least one agent step; the last step is a design gate. Approving it commits the documents.
- A role whose `mayWrite` includes `.devcrew/system.json` is given the diagram format and draws
  the **system architecture diagram** there: blocks (`compute`, `controller`, `sensor`, `actuator`,
  `power`, `network`, `storage`, `software`, `interface`, `external`, `user`), optional groups,
  the chosen part per block, and links with their interface and kind (`data`, `control`, `power`,
  `mechanical`). Design gates draw it. If it cannot be drawn, the role gets one turn to fix it.

## Role guides

`pipelines/roles/<name>.md` holds a role's know-how in plain English. A step uses it with
`"instructions": "guide:<name>"`; DevCrew puts the text in the role's prompt, so it works the same
with every vendor. The built-in `qa` and `build` steps keep DevCrew's own instructions and can add
a guide on top with `"guide": "guide:<name>"` (for example a test engineer's techniques for QA).
Approving a pipeline records the version of each guide it uses (`guideHashes`, written for you).
If a guide changes afterwards, the pipeline shows a problem and cannot run until you review it
again. A run keeps the guide text it started with.

## Presets

`pipelines/presets/` has one page per ready-made design pipeline: when to use it, what to prepare,
a requirement template, every role and what it hands on, and how to run it.
