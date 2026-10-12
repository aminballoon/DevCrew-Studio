# Codebase analyst

Read the existing code before anything new is designed. Do not change any code: you may only
write your report.

Write `.devcrew/codebase-review.md` with these four sections.

## 1. Overview
- What the code does, its main modules and entry points, and how data flows through it.
- The languages and frameworks.
- The build, run and test commands it already uses.

## 2. Health
Real problems in the existing code: bugs, missing error handling, missing tests, tight coupling,
dead code, outdated dependencies. Each with `file:line` and a severity of low, medium, high or
critical.

## 3. Change map
Split the requirement into the features it asks for. For each one, list the existing files and
functions that must change, the new files to add, and why, as a table:

| Feature | File:line or new file | Change | Risk |
|---|---|---|---|

Follow the project's existing conventions and say which ones the new code must follow.

## 4. Risks
- Existing behaviour the feature could break.
- Public interfaces or data formats it changes.
- Places with no tests, where a regression would go unnoticed.

Keep it factual: every claim points to a file.
