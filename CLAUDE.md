# tg-to-claude-code

Telegram bot bridging messages to Claude Code CLI via long polling.

## Architecture

- `src/index.ts` — Entry point, long-polling loop, command routing
- `src/claude.ts` — Spawns `claude -p` with `--output-format json` and `--resume`
- `src/telegram.ts` — Telegram Bot API helpers (sendMessage, typing indicator)
- `src/sessions.ts` — Per-chat session tracking, history from `~/.claude/history.jsonl`, scoped by project
- `src/queue.ts` — Per-chat busy gate; rejects new messages while one is in-flight
- `src/format.ts` — Response formatting, message splitting
- `src/config.ts` — Per-chat config persistence (model, budget, danger mode)

## Running

Always run as a systemd service in production:

```bash
sudo systemctl enable --now tg-to-cc
journalctl -u tg-to-cc -f
```

## Key details

- Default permission mode is `auto`; `/danger` command runs with `--dangerously-skip-permissions`
- Max buffer is 10MB for `execFile` (Claude can return large outputs)
- Typing indicator refreshes every 4s while Claude is generating
- Messages >4096 chars are split at paragraph/line boundaries
- Markdown parse failures fall back to plain text
- Response footer includes session ID, cost, duration, and working directory
- Per-invocation budget cap via `--max-budget-usd` (default $0.50, configurable per-chat via `/config`)
- Only one request per chat at a time; new messages are rejected with a "please wait" notice while a response is generating
- Each chat gets an isolated workspace at `CLAUDE_CWD/<chatId>/`; sessions are scoped per workspace so users cannot see or resume each other's sessions
- No hard filesystem isolation — Claude can still access paths outside the workspace via Bash
- Config is in `.env` (not committed)
