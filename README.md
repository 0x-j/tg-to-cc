# tg-to-claude-code

Telegram bot that bridges messages to Claude Code CLI running locally. Gives you an interactive, multi-turn Claude Code experience from Telegram — including tool use (Bash, Read, Edit, etc.) on your VM.

Uses long polling (no public URL needed) and your existing Claude Max subscription via the CLI's OAuth auth.

## Setup

### Prerequisites (Node.js & pnpm)

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc

# Install Node.js LTS
nvm install --lts

# Install pnpm
corepack enable
corepack prepare pnpm@latest --activate
```

### Install & configure

```bash
pnpm install
cp .env.example .env
# Edit .env: set BOT_TOKEN and ALLOWED_CHAT_IDS
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ALLOWED_CHAT_IDS` | Yes | Comma-separated chat IDs to whitelist |
| `CLAUDE_CWD` | No | Base working directory (default: `/home/exedev/workspace`). Each chat gets projects under `CLAUDE_CWD/<chatId>/<project>/` |
| `CLAUDE_PATH` | No | Path to claude binary (default: `/home/exedev/.local/bin/claude`) |

### Get your chat ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your chat ID
2. Add it to `ALLOWED_CHAT_IDS` in `.env`

## Running

### systemd (recommended)

```bash
sudo cp tg-to-cc.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-to-cc
sudo systemctl restart tg-to-cc
```

Check logs:
```bash
journalctl -u tg-to-cc -f
```

Update and restart after changes:
```bash
git pull && sudo systemctl restart tg-to-cc
```

### Manual

```bash
pnpm start
```

## Bot commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new Claude Code session |
| `/project` | Show current project |
| `/project <name>` | Switch or create a project |
| `/project <name> <path>` | Create project at a custom absolute path |
| `/projects` | List all projects |
| `/sessions` | List recent sessions |
| `/resume <id>` | Resume a session by ID prefix |
| `/current` | Show active session |
| `/stop` | Cancel the running task |
| `/danger <msg>` | Run with `--dangerously-skip-permissions` (full tool access) |
| `/config` | Per-chat settings: model, budget limit, skip permissions |
| `/usage` | Session token usage & cost |
| `/context` | Context window status |
| `/help` | Show commands |

Any non-command message is sent to Claude Code as a prompt. Responses include a footer with session ID, cost, duration, and working directory.

## How it works

Each message spawns `claude -p "<prompt>" --output-format json --resume <session-id>`. The `--resume` flag maintains multi-turn conversation context. Session IDs are tracked per Telegram chat in `data/sessions.json`.

While Claude is generating, the bot shows a typing indicator and a `/stop` reply keyboard button. Tasks run with no hard timeout — the budget cap is the natural limit. Use `/stop` to cancel a long-running or stuck task at any time. Once complete, the reply keyboard is removed and the response is sent with a footer including session ID, cost, duration, and working directory.

By default, Claude runs in `--permission-mode auto`. Use `/danger` to run a single message with `--dangerously-skip-permissions` when you need unrestricted file edits or other tool access. Use `/config` to permanently toggle skip-permissions per chat.

## Per-chat configuration

Use `/config` to customize settings per Telegram chat via inline keyboard buttons:

- **Model** — Default, Sonnet 4.6, Opus 4.6, or Haiku 4.5
- **Budget** — Per-message spend cap ($0.25–$5.00, default $0.50)
- **Skip permissions** — Always run in danger mode (no tool approval)

Config persists in `data/config.json` and applies across all sessions in a chat.

## Projects

Each chat organizes work into named projects. The default project is `default`, stored at `workspace/<chatId>/default/`.

- `/project myapp` — create or switch to a project (stored at `workspace/<chatId>/myapp/`)
- `/project myapp ~/my-projects/myapp` — create a project pointing to an existing directory
- `/projects` — list all projects with their paths

Switching projects clears the active session. Each project has its own working directory, so files from different tasks don't collide.

## Multi-user isolation

Each Telegram chat gets its own project namespace under `workspace/<chatId>/`. Session listing and resuming are scoped per chat, so users cannot see or resume each other's sessions. Note: there is no hard filesystem isolation — Claude can still access paths outside the project via Bash.
