import "dotenv/config";
import { sendMessage, startTyping } from "./telegram.js";
import { runClaude } from "./claude.js";
import { formatResponse, timeAgo } from "./format.js";
import {
  load as loadSessions,
  getSessionId,
  setSessionId,
  clearSession,
  listHistory,
  findSession,
} from "./sessions.js";
import { enqueue } from "./queue.js";

const ALLOWED_CHAT_IDS = process.env.ALLOWED_CHAT_IDS
  ? new Set(process.env.ALLOWED_CHAT_IDS.split(",").map(Number))
  : null;

const BOT_TOKEN = process.env.BOT_TOKEN!;
const POLL_URL = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;

loadSessions();

let offset = 0;

async function poll(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(POLL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: 30 }),
      });
      const data = await res.json() as { ok: boolean; result: any[] };

      if (!data.ok || !data.result?.length) continue;

      for (const update of data.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text || !msg.chat?.id) continue;

        const chatId: number = msg.chat.id;
        const text: string = msg.text.trim();

        if (ALLOWED_CHAT_IDS && !ALLOWED_CHAT_IDS.has(chatId)) continue;

        if (text.startsWith("/")) {
          handleCommand(chatId, text);
        } else {
          handlePrompt(chatId, text);
        }
      }
    } catch (err) {
      console.error("Poll error:", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function handleCommand(chatId: number, text: string): void {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      sendMessage(
        chatId,
        [
          "*Claude Code Bridge*",
          "",
          "Send any message to chat with Claude Code.",
          "",
          "/new — Start a new session",
          "/sessions — List recent sessions",
          "/resume <id> — Resume a session",
          "/current — Show active session",
          "/help — This message",
        ].join("\n"),
        "Markdown"
      );
      break;

    case "/new":
      clearSession(chatId);
      sendMessage(chatId, "Session cleared. Next message starts a new conversation.");
      break;

    case "/current": {
      const sid = getSessionId(chatId);
      if (sid) {
        sendMessage(chatId, `Active session: \`${sid.slice(0, 8)}\``, "Markdown");
      } else {
        sendMessage(chatId, "No active session. Send a message to start one.");
      }
      break;
    }

    case "/sessions": {
      const sessions = listHistory(10);
      if (!sessions.length) {
        sendMessage(chatId, "No sessions found.");
        return;
      }
      const lines = sessions.map((s, i) => {
        const preview = s.display.slice(0, 50) + (s.display.length > 50 ? "..." : "");
        return `${i + 1}. \`${s.sessionId.slice(0, 8)}\` — ${preview} (${timeAgo(s.timestamp)})`;
      });
      sendMessage(
        chatId,
        `*Recent sessions:*\n\n${lines.join("\n")}\n\nUse /resume <id> to switch.`,
        "Markdown"
      );
      break;
    }

    case "/resume": {
      if (!arg) {
        sendMessage(chatId, "Usage: /resume <session-id-prefix>");
        return;
      }
      const match = findSession(arg);
      if (!match) {
        sendMessage(chatId, `No session found matching \`${arg}\``, "Markdown");
        return;
      }
      setSessionId(chatId, match.sessionId);
      const preview = match.display.slice(0, 60);
      sendMessage(
        chatId,
        `Resumed session \`${match.sessionId.slice(0, 8)}\` — "${preview}"`,
        "Markdown"
      );
      break;
    }

    default:
      sendMessage(chatId, "Unknown command. Try /help");
  }
}

function handlePrompt(chatId: number, prompt: string): void {
  enqueue(chatId, async () => {
    const stopTyping = startTyping(chatId);
    try {
      const sessionId = getSessionId(chatId);
      const result = await runClaude(prompt, sessionId);
      if (result.sessionId) {
        setSessionId(chatId, result.sessionId);
      }
      const text = formatResponse(result);
      await sendMessage(chatId, text, "Markdown");
    } catch (err) {
      await sendMessage(chatId, `Error: ${err}`);
    } finally {
      stopTyping();
    }
  });
}

console.log("tg-to-cc starting (long polling)...");
poll();
