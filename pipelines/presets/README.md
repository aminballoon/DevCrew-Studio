# Pipeline presets

Ready-made pipelines for common kinds of work. Changing an existing codebase and firmware on a real board are now add-ons to the fast pipeline (`pipelines/addons/codebase.json`, `hardware.json`; see `pipelines/SCHEMA.md`). Each file here explains one preset: when to use
it, what to prepare, what every role does and hands on, what you review, and how to start it.
An agent (or a person) can read one file and run the preset without reading anything else.

| Preset | Use it for | Kind | Definition |
|---|---|---|---|
| [system-integration](system-integration.md) | Designing a hardware and software system and choosing parts, no code | design | `pipelines/system-integration.json` |

The definition (the `.json` file) is what DevCrew runs. These pages describe it; if the two ever
disagree, the `.json` file is right. New presets start as drafts in `pipelines/drafts/` and can be
used only after you approve them (dashboard **Pipelines** tab, or `npm run pipeline -- approve <id>`).

## How to run a preset

1. Write the requirement in a Markdown file. Each preset page has a template.
2. Put the project files in a folder (the "source"). A git repository gets its own branch; any other
   folder is copied. Leave it out to start from an empty project.
3. Start the run:

   ```bash
   npm run run -- start --requirement <requirement.md> --source <folder> --profile <profile> --pipeline <preset-id>
   ```

   Or in the dashboard: **+ New run**, then pick the pipeline, the agent profile and the project folder.
4. The run stops at every gate until you approve or ask for changes, in the dashboard or with
   `npm run run -- gate <runId> <approve|revise|abort> [--feedback "<notes>"]`.
   Nothing is committed until you approve the last gate.

A dry run with the scripted demo agent costs no quota and checks the flow, not the quality of the work:

```bash
npm run run -- start --requirement bench/tasks/S-01-cart/requirement.md --source bench/tasks/S-01-cart/seed --profile fake --pipeline <preset-id> --auto
```

## Which AI does each role

Everything is in `devcrew.config.json`:

- `agents`: how to launch each vendor's agent (`claude`, `codex`, ...). Adding a vendor means
  adding an entry here.
- `profiles`: which agent plays each role. You pick the profile when you start a run. A role gets
  its agent from, in order:
  1. the profile's entry for that role: a built-in role (`qa`, `dev`, `reviewer`) or a
     pipeline step's id (`scout`, `hil`, `arch`...),
  2. the `"agent"` the pipeline step names (each preset page lists them),
  3. the profile's `reviewer`.

So to move a preset to another vendor, add a profile; the pipeline does not change. For example, a
profile where Codex does everything in `system-integration`:

```json
"codex-design": { "qa": "codex", "dev": "codex", "reviewer": "codex",
                  "architect": "codex", "scout": "codex", "arch": "codex" }
```

- `agents.<name>.provides`: what the agent can do (`web`, `shell`). Roles declare what they
  `need`; if the agent a profile gives a role cannot do it, the run is refused before it starts.
  Each preset page lists what its roles need.

Demo profiles (`fake*`) always use the scripted agent, whatever a role names.

### Your own Claude skills

The `claude` agent loads your personal Claude settings, skills and plugins (`~/.claude`), as the
CLI does. The `claude-isolated` agent and profile load only the run's project settings and
DevCrew's instructions (Claude Code's built-in skills stay). Use `claude-isolated` when comparing
vendors, so Claude has no knowledge the others lack.

## Role guides

What each role knows lives in `pipelines/roles/` (one guide per role, shared between pipelines),
not in a profile. See [roles/README.md](../roles/README.md).

## Adding a preset

Create the pipeline with the `new-pipeline` skill (it writes a draft and asks for your review), then
add a page here with the same sections as the others and a row in the table above.
