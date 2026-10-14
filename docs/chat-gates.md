# Gates on your phone (OpenClaw, Hermes)

When a run stops at a gate, DevCrew can send the question to a chat agent you already run. The agent forwards it to your chat (Telegram, WhatsApp, Signal, ...), and when you reply ("approve", "revise: keep prices in cents", "abort") it answers the gate for you.

```
gate waits → DevCrew POSTs to OpenClaw / Hermes → message on your phone
you reply   → the agent calls POST /api/runs/<id>/gate → the run goes on
```

The chat agent must reach the dashboard (`npm run dashboard`, http://127.0.0.1:4317), so run it on the same machine, or set `notify.dashboardUrl` to an address it can reach (keep that private: the dashboard has no login). A run started from the CLI still sends the question; answering needs the dashboard to be running.

## Discord bot with buttons (free, no AI)
DevCrew sends the gate to your own Discord bot as a message with **Approve / Revise / Abort** buttons (Retry / Replan / Abort for an escalation). Revise opens a form for your feedback. After a click the buttons are replaced by the answer. Only the user ids in `userIds` can answer; anyone else gets "not allowed". Discord bots cost nothing.

The message carries the review itself: for the plan gate the goal, modules, acceptance criteria and requirement sentences nobody covers, with PRD.md attached; for the code gate the test result, changed files, cost and each reviewer's verdict, with `changes.diff` and the reviews attached; for an escalation the reasons and the last test output.

To comment, type in the DM (or reply to a gate message when several runs wait). The bot asks what the comment is: Approve with this note, Revise with this comment, or Cancel.

1. Make a private server for yourself (Discord app → + → Create my own → For me and my friends). A bot can only DM people it shares a server with.
2. https://discord.com/developers/applications → New Application → **Bot** → Reset Token, copy it. No privileged intents are needed.
3. **Installation** (or OAuth2 → URL Generator): scope `bot`, permission Send Messages; open the link and add the bot to your server.
4. Your user id: Discord Settings → Advanced → Developer Mode on; right-click your name → Copy User ID.
5. `export DISCORD_BOT_TOKEN=...` in the shell that starts the dashboard, and in `devcrew.config.json`:
   ```json
   "notify": { "channels": [ { "type": "discord", "tokenEnv": "DISCORD_BOT_TOKEN", "userIds": ["<your user id>"] } ] }
   ```
   The bot DMs the first user id. Add `"channelId": "..."` to post in a server channel instead.
6. `npm run dashboard`. It prints `Discord bot <name> is listening for gate answers`. Clicks are received over Discord's Gateway by the dashboard, so nothing on your machine is opened to the internet, but the dashboard must be running for clicks to work.

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
