# Gates on your phone (OpenClaw, Hermes)

When a run stops at a gate, DevCrew can send the question to a chat agent you already run. The agent forwards it to your chat (Telegram, WhatsApp, Signal, ...), and when you reply ("approve", "revise: keep prices in cents", "abort") it answers the gate for you.

```
gate waits → DevCrew POSTs to OpenClaw / Hermes → message on your phone
you reply   → the agent calls POST /api/runs/<id>/gate → the run goes on
```

The chat agent must reach the dashboard (`npm run dashboard`, http://127.0.0.1:4317), so run it on the same machine, or set `notify.dashboardUrl` to an address it can reach (keep that private: the dashboard has no login). A run started from the CLI still sends the question; answering needs the dashboard to be running.

## 1. Config
Add a `notify` block to `devcrew.config.json`. Secrets stay in environment variables; the config names them.

```json
"notify": {
  "dashboardUrl": "http://127.0.0.1:4317",
  "channels": [
    { "type": "openclaw", "url": "http://127.0.0.1:18789/hooks/agent", "tokenEnv": "OPENCLAW_HOOKS_TOKEN", "channel": "telegram", "to": "<your chat id>" },
    { "type": "hermes", "url": "http://127.0.0.1:8644/webhooks/devcrew-gate", "secretEnv": "HERMES_WEBHOOK_SECRET" }
  ]
}
```
Use any channel alone. `"type": "webhook"` POSTs the same JSON (runId, gate, title, decisions, text, answerUrl, detailsUrl, message) to any URL, with an optional `tokenEnv` bearer token. A channel that fails is written to the run's log; the run still waits at the gate as usual.

## 2. OpenClaw
- Gateway config: `hooks: { enabled: true, token: "<long random>", path: "/hooks" }`; export the same token as `OPENCLAW_HOOKS_TOKEN` where DevCrew runs.
- `channel` + `to` pick the chat (recent OpenClaw versions need both; `"last"` is refused).
- Copy `integrations/devcrew-gates/` into the agent's skills folder so it knows how to answer.

## 3. Hermes Agent
- Enable the webhook platform and add a route, e.g. in `~/.hermes/config.yaml`:
  ```yaml
  platforms:
    webhook:
      enabled: true
      extra:
        routes:
          devcrew-gate:
            secret: "<long random>"
            prompt: "{message}"
            deliver: "telegram"
            deliver_extra: { chat_id: "<your chat id>" }
  ```
  or `hermes webhook subscribe devcrew-gate --prompt "{message}" --deliver telegram --deliver-chat-id <id>`. Export the secret as `HERMES_WEBHOOK_SECRET`. DevCrew signs with the Generic V2 scheme (`X-Webhook-Signature-V2`, `X-Webhook-Timestamp`).
- Copy `integrations/devcrew-gates/` into `~/.hermes/skills/` so the agent can answer from your replies. With `--deliver-only` you get the message but must answer in the dashboard.

## What the agent can call
- `GET /api/runs/<id>/gate.txt`: the waiting gate as plain text (question, findings, accepted answers); 404 when not waiting.
- `POST /api/runs/<id>/gate` `{"decision": "...", "feedback": "..."}`: answers it. A decision the gate does not take (e.g. `retry` at a plan gate) is refused with 409.
