# tg-to-claude-code

Telegram bot that bridges messages to Claude Code CLI running locally. Gives you an interactive, multi-turn Claude Code experience from Telegram — including tool use (Bash, Read, Edit, etc.) on your VM.

Uses long polling (no public URL needed) and your existing Claude Max subscription via the CLI's OAuth auth.

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env: set BOT_TOKEN and ALLOWED_CHAT_IDS
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ALLOWED_CHAT_IDS` | No | Comma-separated chat IDs to whitelist (empty = allow all) |
| `CLAUDE_CWD` | No | Working directory for Claude Code (default: `/home/exedev`) |
| `CLAUDE_PATH` | No | Path to claude binary (default: `/home/exedev/.local/bin/claude`) |

### Get your chat ID

1. Start the bot with `ALLOWED_CHAT_IDS` empty
2. Send a message to your bot
3. Check `data/sessions.json` — the key is your chat ID
4. Add it to `ALLOWED_CHAT_IDS` and restart

## Running

### systemd (recommended)

```bash
sudo cp tg-to-cc.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-to-cc
```

Check logs:
```bash
journalctl -u tg-to-cc -f
```

### Manual

```bash
pnpm start
```

## Bot commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new Claude Code session |
| `/sessions` | List recent sessions |
| `/resume <id>` | Resume a session by ID prefix |
| `/current` | Show active session |
| `/danger <msg>` | Run with `--dangerously-skip-permissions` (full tool access) |
| `/usage` | Session token usage & cost |
| `/context` | Context window status |
| `/help` | Show commands |

Any non-command message is sent to Claude Code as a prompt. Responses include a footer with session ID, cost, and duration.

## How it works

Each message spawns `claude -p "<prompt>" --output-format json --resume <session-id>`. The `--resume` flag maintains multi-turn conversation context. Session IDs are tracked per Telegram chat in `data/sessions.json`.

By default, Claude runs in `--permission-mode auto`. Use `/danger` to run a single message with `--dangerously-skip-permissions` when you need unrestricted file edits or other tool access.
