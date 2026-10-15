---
name: new-pipeline
description: Create or change a DevCrew Studio pipeline (which AI roles work on a run, in what order, and where a person reviews) from a plain-language request, then get the user's review before it can be used. Use when the user asks for a new pipeline, a new review step or role (security, docs, performance, accessibility...), fewer or more steps, or changes to an existing pipeline.
---

# Create a DevCrew pipeline from a request

You turn the user's request into a pipeline file, check it, and hand it to the user for review.
**A pipeline is never usable until the user approves it.** You write drafts only.

Talk to the user in their own language. Everything you write into the pipeline file
(names, purposes, instructions) is in plain English: the platform is English only.

## 1. Understand the request

Read these first, every time:

- `pipelines/SCHEMA.md`: the file format and the rules the validator enforces.
- The existing pipelines in `pipelines/*.json`, to reuse their wording and to avoid duplicates.
- `devcrew.config.json` → `agents`, if the user names a specific AI (only names listed there can be used).

Work out from the request:

- Which extra roles are needed, what each one is for, what it reads and what it hands on.
- Whether a role should be able to **send the code back to the Builder** (a blocking check, like security) or only **report** (advice the user reads at the code gate).
- Which pipeline it starts from (usually `fast`, or `fast-arch` for a project that will grow). Check `pipelines/addons/` first: a request that an add-on already covers needs no new pipeline.
- Whether a role must work **before QA and the Builder** (read existing code, research hardware,
  prepare a test rig) so they start from its findings. Such roles may only write under `.devcrew/`.
- Whether the result is **code** (a fast pipeline) or **only a design** (`"kind": "design"`: agent
  steps and design gates, ending in documents and a system architecture diagram).

If something that changes the design is unclear (for example: should the new role block the
merge or only advise?), ask at most three short questions. Otherwise pick the sensible default,
and say which default you picked in the review summary.

## 2. Write the draft

Write `pipelines/drafts/<id>.json`. Pick a short, descriptive `id` that is not already used in
`pipelines/` or `pipelines/drafts/`.

Guidelines for good roles:

- `purpose`: one sentence a non-programmer understands.
- `instructions`: concrete. Say what to look for, how to rate severity, and when to use
  `VERDICT: changes`. Vague instructions ("review the code") produce noisy reviews.
- `mayWrite`: only the role's own report or folder (for example `.devcrew/security.md` or `docs/`).
  Never `tests/`, `contracts/` or `*`; the validator refuses them.
- Give blocking roles a `verdict` with `"onChanges": "dev"` and a small `maxRounds` (1 or 2).
  Advisory roles use `"onChanges": "continue"`.
- Keep the code gate last; the user must review the code before it is committed.
  In a design pipeline, end with a `design` gate; add an earlier one where the user should steer.
- A role that draws the system diagram needs `.devcrew/system.json` in `mayWrite`; the platform
  gives it the format. Say in its instructions what the diagram must contain.
- Roles that search the internet: add `"needs": ["web"]`, and tell them to cite source URLs and
  say "unknown" rather than guess. Roles that run commands: `"needs": ["shell"]`.
- Instructions longer than a few sentences, or shared by several pipelines, go in a role guide:
  `pipelines/roles/<name>.md`, used with `"instructions": "guide:<name>"`. Reuse an existing guide
  when one fits; a new or changed guide is part of what the user reviews, so say so in the summary.
  Editing a guide that approved pipelines use puts them back under review: list which ones.
- Roles that touch real hardware: write tools and scripts under `.devcrew/` (read-only for Dev),
  limit what they may run during their own turn, and never store passwords or keys.
- Do not add roles the user did not ask for.

## 3. Validate

```bash
npm run pipeline -- validate pipelines/drafts/<id>.json
```

Fix every problem it lists and run it again until it prints `VALID`. Do not hand an invalid draft
to the user. The command also prints the pipeline in plain words; use that text in your summary.

## 4. Hand it to the user for review

Tell the user, in their language:

1. What the pipeline does, step by step (paste the plain-words output of `validate`).
2. What changed compared with the pipeline it is based on: added, removed or changed steps.
3. Any defaults you chose, and trade-offs (extra steps cost more tokens and time).
4. Where to review it: the dashboard's **Pipelines** tab shows the flow diagram,
   http://localhost:4317/#pipelines=<id> (start the dashboard with `npm run dashboard` if it is not running).
5. How to decide: click **Approve pipeline** or **Ask for changes** there, or reply in the chat.

Then stop and wait for the user.

## 5. Act on the review

Check the decision with:

```bash
npm run pipeline -- status <id>
```

- **Changes requested** (in the dashboard, shown as `changes_requested` with feedback, or in the chat):
  update the draft, validate again, and go back to step 4. Say what you changed.
- **Approved in the chat**: run `npm run pipeline -- approve <id>`. It validates again and moves the
  file to `pipelines/<id>.json`.
- **Approved in the dashboard**: it is already moved; just confirm.

Never run `approve` unless the user clearly approved this draft in this conversation. "Looks good"
about an earlier version is not approval of a later one.

## 6. Write the preset page

Once the pipeline is approved, add `pipelines/presets/<id>.md` with the same sections as the other
pages there (use it for, what to prepare, requirement template, steps with agents and outputs, what
you review, cost and limits) and a row in `pipelines/presets/README.md`. Update the page whenever
the pipeline changes.

## 7. Offer a dry run

After approval, offer a run with the scripted demo agent, which costs no quota:

```bash
npm run run -- start --requirement bench/tasks/S-01-cart/requirement.md --source bench/tasks/S-01-cart/seed --profile fake --pipeline <id> --auto
```

Explain that the fake agent only has scripts for the built-in roles and the `security` example,
so new roles will not write anything in the dry run; it checks the flow, not the role's work.
For a real check, start a run with a real profile from the dashboard.

## Changing an existing approved pipeline

Do not edit `pipelines/<id>.json` directly. Copy it to `pipelines/drafts/<id>.json`, make the change
there, and follow the same review. Approving replaces the old version. Runs that already started
keep the version they started with.
