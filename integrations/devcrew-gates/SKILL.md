---
name: devcrew-gates
description: Answer DevCrew Studio gates (approve, revise, retry, replan, abort a run) from the person's chat replies. Use when a message says a DevCrew run is waiting, or the person asks about or answers a DevCrew run.
---

# DevCrew gates

DevCrew Studio runs AI roles (Planner, QA, Dev, reviewers) on a project and stops at gates for a person's decision. Its dashboard listens on http://127.0.0.1:4317 (or the URL in the gate message).

## When a gate message arrives
Send the person the question part, as is. Do not decide for them.

## When the person replies
1. Map the reply to exactly one answer the gate takes (the message lists them):
   - `approve`: go on. `revise`: send it back with their feedback. `abort`: stop the run.
   - Escalations take `retry` (Dev tries again), `replan` (back to the Planner) or `abort`.
2. Anything after the word is feedback ("revise: keep prices in cents" → feedback "keep prices in cents"). `revise` needs feedback; ask for it if missing.
3. If the reply is unclear, or could mean two answers, ask again. Never guess, never answer a gate the person did not answer.
4. Answer:
   ```bash
   curl -s -X POST http://127.0.0.1:4317/api/runs/<runId>/gate -H 'content-type: application/json' -d '{"decision":"revise","feedback":"keep prices in cents"}'
   ```
   `{"ok":true}` means done: tell the person "Sent: revise". An error (wrong answer for this gate, run not waiting) goes back to the person word for word.

## When the person asks what is waiting
- `curl -s http://127.0.0.1:4317/api/runs/<runId>/gate.txt`: the gate's question and findings as text. Summarise it in a few lines.
- `curl -s http://127.0.0.1:4317/api/runs`: every run; `status: "waiting"` ones wait for an answer.
