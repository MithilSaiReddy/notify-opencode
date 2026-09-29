# notify-opencode

Telegram notifications for [OpenCode](https://opencode.ai) — as an agent skill.

Your OpenCode agent can finish a long task while you are in another window. This
sends you a Telegram message the moment it does, and lets you reply, continue,
abort, switch modes, or approve a permission request without going back to the
terminal.

This repository is a single [OpenCode skill](https://opencode.ai/docs/skills/).
The skill is `SKILL.md`; the plugin it installs is `assets/telegram-notify.ts`.

## Quick install

Clone, then symlink the repo into your global skills directory:

```bash
git clone https://github.com/MithilSaiReddy/notify-opencode.git
ln -s ~/Documents/notify-opencode ~/.config/opencode/skills/telegram-notify
```

Then ask your agent to set it up, or follow [`SKILL.md`](SKILL.md) yourself — it
covers creating the bot via @BotFather, getting your `chat_id`, writing the
config, and restarting OpenCode.

Restart OpenCode after installing. It loads skills and plugins at startup only.

## What you get

| Event | Notification |
|---|---|
| `session.idle` | `🤖 Agent finished:` + the first ~20 words of the reply |
| `session.error` | `❌ Session error:` + the error message |
| `permission.updated` | `🔔 Permission needed:` with allow / always / reject buttons |

Every notification carries an inline keyboard:

- `🛠 Build` / `🧠 Plan` — switch the session between edit and read-only mode
- `🔁 Continue` — ask the agent to pick up where it left off
- `🛑 Abort` — stop the running session
- Any plain text — sent as a prompt to your session, so you can iterate from
  Telegram

Slash commands: `/new`, `/sessions`, `/reset`, `/agents`.

Each session's notification is edited in place across turns, so a session keeps a
single thread rather than flooding the chat.

## Configuration

Credentials are read from `~/.config/opencode/telegram-notify.json`:

```json
{
  "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
  "chatId": "123456789"
}
```

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` take precedence over the file, so
you can keep the token out of disk entirely.

**Treat the bot token like a password.** It is not a secret in name only — anyone
holding it can read and send through your bot. This repo gitignores
`telegram-notify.json`; see `assets/telegram-notify.example.json` for the
template. If a real token is ever committed, revoke it via **@BotFather →
`/revoke`** and issue a new one.

Inbound messages and button presses are checked against the configured
`chatId`, so other users of the bot cannot drive your agent.

## Troubleshooting

See the troubleshooting table in [`SKILL.md`](SKILL.md). The short version: the
OpenCode logs are the source of truth — missing config, an invalid token, and
network failures are all logged under the `telegram-notify` service.

## License

MIT — see [LICENSE](LICENSE).
