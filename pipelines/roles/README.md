# Role guides

The know-how of a pipeline role: what to do, what to write, and the rules to follow. A pipeline
step uses one with `"instructions": "guide:<name>"` (this folder, `<name>.md`). DevCrew puts the
guide's text in the role's instructions, so it works the same with any AI vendor; it is not a
Claude skill. Several pipelines can share a guide. The built-in Planner, QA and build steps can also take one
with `"guide": "guide:<name>"`; it is added on top of DevCrew's own instructions for that role.

| Guide | Used by |
|---|---|
| [codebase-analyst](codebase-analyst.md) | existing-code |
| [board-researcher](board-researcher.md) | firmware-board |
| [hil-rig-engineer](hil-rig-engineer.md) | firmware-board |
| [firmware-reviewer](firmware-reviewer.md) | firmware-board |
| [system-architect](system-architect.md) | system-integration |
| [hardware-scout](hardware-scout.md) | system-integration |
| [architecture-reviewer](architecture-reviewer.md) | system-integration |
| [risk-planner](risk-planner.md) | minimal-skills, with-security-skills (Planner) |
| [test-engineer](test-engineer.md) | minimal-skills, with-security-skills (QA) |
| [careful-developer](careful-developer.md) | minimal-skills, with-security-skills (Dev) |
| [security-auditor](security-auditor.md) | with-security-skills |
| [requirement-reviewer](requirement-reviewer.md) | with-security-skills |

**Changing a guide changes every pipeline that uses it**, so approved pipelines are tied to the
guide versions you approved. After you edit a guide, those pipelines show a problem and cannot be
used until you review them again (copy the pipeline to `pipelines/drafts/` and approve it). Runs
that already started keep the guide text they started with.

Write guides in plain English, as instructions to the role ("Read...", "Write..."). The platform
adds the requirement, what the role may write, the verdict format and, for roles that may write
`.devcrew/system.json`, the diagram format, so a guide does not repeat them.
