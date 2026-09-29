---
name: telegram-notify
description: Use when the user wants Telegram notifications for OpenCode, or wants to install, configure, update, or debug the telegram-notify plugin. Pushes agent-finished, error, and permission-request alerts to a Telegram chat and lets them drive sessions back from Telegram via inline buttons and slash commands.
license: MIT
compatibility: opencode
metadata:
  plugin: telegram-notify
  type: opencode-plugin
  version: "1.0.0"
---

# Telegram Notify for OpenCode

An OpenCode plugin that pushes session events to a Telegram chat and accepts
instructions back over the same chat. This skill explains what the plugin does
and how to install, configure, and repair it.

The plugin source lives at `assets/telegram-notify.ts` in this skill folder.

## What the plugin does

**Outbound** — the plugin subscribes to the OpenCode event bus and posts:

| Event                | Notification                                        |
|----------------------|-----------------------------------------------------|
| `session.idle`       | `🤖 Agent finished: [session]` + first ~20 words     |
| `session.error`      | `❌ Session error: [session]` + the error message    |
| `permission.updated` | `🔔 Permission needed:` + title, type, and pattern   |

Consecutive `session.idle` events with an identical summary are deduplicated.
Each session's notification is **edited in place** across turns, so a session
keeps one thread instead of spamming the chat.

**Inbound** — the plugin long-polls `getUpdates` and accepts:

| Message / button         | Action                                              |
|--------------------------|-----------------------------------------------------|
| `🛠 Build`               | Switch the session to Build mode (may edit files)   |
| `🧠 Plan`                | Switch the session to Plan mode (read-only)         |
| `🔁 Continue`            | Ask the agent to continue its last task             |
| `🛑 Abort`               | Abort the running session                           |
| Any text                 | Sent as a prompt to the target session              |
| `/new`                   | Start a new child session                           |
| `/sessions`              | List sessions as buttons — tap one to talk to it    |
| `/reset`                 | Stop targeting a specific session                   |
| `/agents`                | List available agents                               |
| `✅ Allow once / Always` | Approve a pending permission request                |
| `🚫 Reject`              | Reject a pending permission request                 |

Updates from any chat other than the configured `chatId` are dropped. Do not
remove that check — without it, anyone who finds the bot can drive the agent.

## Install

### 1. Create the bot

1. Message **@BotFather** in Telegram, send `/newbot`.
2. Choose a name and a username ending in `bot`.
3. Copy the **bot token** it returns. Treat it as a password.

### 2. Get your chat_id

1. Open your new bot in Telegram and send it any message (bots cannot start a
   conversation themselves).
2. Run:

   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```

3. Find `"chat":{"id":123456789}` — that number is your `chatId`.

### 3. Install the plugin file

```bash
mkdir -p ~/.config/opencode/plugin
cp <this-skill-folder>/assets/telegram-notify.ts ~/.config/opencode/plugin/telegram-notify.ts
```

Files in `~/.config/opencode/plugin/` are auto-discovered; no `opencode.json`
entry is required.

### 4. Configure credentials

Either write `~/.config/opencode/telegram-notify.json`:

```json
{
  "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
  "chatId": "123456789"
}
```

…or export environment variables, which **take precedence** over the file:

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export TELEGRAM_CHAT_ID="123456789"
```

Prefer the env vars when the token should not live in a file at all. A
placeholder config is at `assets/telegram-notify.example.json`.

> **Never** commit a real token. This repo gitignores `telegram-notify.json`; if
> a token is ever pushed, revoke it via **@BotFather → `/revoke`** immediately
> and issue a new one.

### 5. Restart OpenCode

Plugins load at startup only. Quit and relaunch OpenCode, then confirm the log
line `Connected to Telegram as @<yourbot>` appears in the OpenCode logs.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No notifications at all | Check the OpenCode logs for the `telegram-notify` service. A missing config or bad token is logged there as an error. Confirm `getMe` succeeded. |
| `getMe failed` in logs | The token is wrong or revoked. Re-check it against @BotFather. |
| Nothing sent when you text the bot | Your message came from a different chat than `chatId`, so it is ignored. Send `/start` to the bot first, re-run `getUpdates`, and use that `id`. |
| Duplicate notifications | Already deduplicated by the plugin. If you still see them, two OpenCode instances are running. |
| Bot not responding | You have never messaged the bot, or another process is consuming `getUpdates`. Telegram delivers each update to exactly one consumer. |
| Mode buttons don't "stick" | Plan/Build is applied per-prompt via the `agent` field. Persistent session switching needs the undocumented `client.session.switchAgent`; when the running OpenCode lacks it, the button only applies to the next prompt. |
| Replies go to the wrong session | Tap a different session in `/sessions`, or send `/reset` to fall back to the most recent. |

## Updating

Replace `~/.config/opencode/plugin/telegram-notify.ts` with the newer
`assets/telegram-notify.ts` and restart OpenCode. Your credentials file is
untouched — it lives outside the plugin folder.

## Uninstall

```bash
rm ~/.config/opencode/plugin/telegram-notify.ts
```

Then revoke the token via **@BotFather → `/revoke`** if you no longer intend to
use the bot.
