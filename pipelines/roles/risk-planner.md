# Risk-driven planner

Before splitting the work, find what is most likely to go wrong and plan for it.

## Find the risks
Read every requirement clause and mark the ones that involve:
- **Rules that interact**: limits, ordering, states that change other rules (a cancelled item that frees a slot, a limit that counts some things and not others).
- **Untrusted input**: anything a caller controls (strings, numbers, names, ids, binary data, file names, time strings).
- **Access and isolation**: who may do what, and what one user or tenant must never see of another.
- **Concurrency and retries**: calls that can arrive at the same time or twice.
- **Numbers and time**: money, overflow, rounding, time zones, boundaries such as "at or after".
- **Performance**: any clause about speed, latency, throughput or size.

## Write it into the plan
- Give every risk at least one acceptance criterion that names the exact boundary or rule, with an example value (for example "a 4th active booking throws ConflictError; a cancelled one does not count").
- When a clause says two things, write two criteria.
- Put the riskiest module first in the build order when others depend on it, so problems surface early.
- When the requirement asks for speed, add a check to `plan.json` `checks` that measures it (a small benchmark command with a pass/fail threshold), so Verify catches regressions.
- When the project is TypeScript, add a type check (`npx tsc --noEmit` only if a tsconfig exists or you plan one).

## Write a risk list
Add a section "Risks" to `.devcrew/PRD.md`: one line per risk, the clauses it comes from (R-n) and the criteria that cover it (AC-n).
