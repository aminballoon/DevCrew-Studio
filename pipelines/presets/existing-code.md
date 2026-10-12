# Preset: Extend existing code (`existing-code`)

**Use it for:** adding a feature to a codebase that already exists, when you want to know which
files the feature touches before anything is built.
**Kind:** build (ends in committed code). **Definition:** `pipelines/existing-code.json`.
**Status:** approved 2026-10-12; a version using role guides is waiting for review in `pipelines/drafts/`.

## What to prepare

- **Source:** the existing project folder or git repository (`--source`). Required: the analyst
  needs code to read.
- **Requirement:** the feature in plain words, plus anything the code alone does not tell (users,
  limits, what must not change).

### Requirement template

```markdown
# <Feature name>

## What it should do
<Behaviour from the user's point of view. One paragraph or a short list.>

## Acceptance
- <A concrete, testable outcome>
- <Another one>

## Must not change
- <Existing behaviour, API, data format or file that must stay as it is>

## Notes
<Conventions to follow, areas to avoid, related issues.>
```

## Steps

The Agent column is the default. A profile in `devcrew.config.json` can give any role another
agent by its step id (for example `"scout": "codex"`); see [README](README.md#which-ai-does-each-role).

| # | Step | Agent | Reads | Writes / hands on |
|---|---|---|---|---|
| 1 | **Codebase analyst** | claude | the existing code, README and docs | `.devcrew/codebase-review.md` |
| 2 | Planner | profile | the requirement, the codebase review, the code | `.devcrew/PRD.md`, `.devcrew/plan.json`, `contracts/`, `.devcrew/adr/0000-existing-architecture.md` |
| 3 | **You: Gate 1** "Review the code analysis and the plan" | | spec, architecture diagram, the analyst's report | approve, or send back to the Planner |
| 4 | QA | profile | spec, contracts, the codebase review | `tests/` (locked afterwards) |
| 5 | Dev + Verify | profile | spec, contracts, tests, the codebase review | the code; Verify runs the tests after each try (default tries per part from the config) |
| 6 | Reviewer | profile (`reviewer`) | the diff, spec, contracts, the codebase review | `.devcrew/review.md` (advice only) |
| 7 | **You: Gate 2** "Approve the merge" | | diff, test results, all reports | approve and commit, or send back to Dev |

### The codebase analyst's report

`.devcrew/codebase-review.md` has four sections:

1. **Overview:** what the code does, main modules and entry points, data flow, languages and
   frameworks, and the existing build, run and test commands.
2. **Health:** real problems in the existing code, each with `file:line` and a severity.
3. **Change map:** for each feature in the requirement, a table of the existing files and functions
   to change, new files to add, why, and the risk. This answers "where do I change the code".
4. **Risks:** behaviour the feature could break, interfaces or data formats it changes, and
   untested areas.

The analyst never changes code; it may only write its report.

## Role guides and agent needs

- Guides: [codebase-analyst](../roles/codebase-analyst.md). They hold each role's full instructions.
- No role needs more than reading and writing files. A run is refused before it starts if the profile gives a role an agent that cannot do what it needs.

## What you review

- **Gate 1:** does the change map match your understanding of the code? Does the plan touch the
  files the map says, and nothing it should not? Ask for changes here: it is the cheap place.
- **Gate 2:** the diff, the test results and the Reviewer's notes.

## Cost

One extra agent turn (the analyst) compared with the standard pipeline. On a large codebase this
turn reads a lot; expect it to be the most expensive turn before Dev.
