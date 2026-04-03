import "dotenv/config";
import fs from "node:fs";
import { sendMessage, startTyping, setMyCommands, downloadFile, PHOTO_DIR } from "./telegram.js";
import { runClaude, type ModelUsage } from "./claude.js";
import { formatResponse, timeAgo } from "./format.js";
import {
  load as loadSessions,
  getSession,
  getSessionId,
  setSession,
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

interface SessionUsage {
  totalCost: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  modelUsage: Record<string, ModelUsage>;
}

const sessionUsage = new Map<number, SessionUsage>();

function accumulateUsage(chatId: number, modelUsage: Record<string, ModelUsage>, cost: number, durationMs: number, apiDurationMs: number): void {
  const existing = sessionUsage.get(chatId);
  if (!existing) {
    sessionUsage.set(chatId, { totalCost: cost, totalDurationMs: durationMs, totalApiDurationMs: apiDurationMs, modelUsage: { ...modelUsage } });
    return;
  }
  existing.totalCost += cost;
  existing.totalDurationMs += durationMs;
  existing.totalApiDurationMs += apiDurationMs;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const prev = existing.modelUsage[model];
    if (prev) {
      prev.inputTokens += usage.inputTokens;
      prev.outputTokens += usage.outputTokens;
      prev.cacheReadInputTokens += usage.cacheReadInputTokens;
      prev.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      prev.webSearchRequests += usage.webSearchRequests;
      prev.costUSD += usage.costUSD;
      prev.contextWindow = usage.contextWindow;
    } else {
      existing.modelUsage[model] = { ...usage };
    }
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

loadSessions();
setMyCommands();

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
        if (!msg?.chat?.id) continue;

        const chatId: number = msg.chat.id;
        if (ALLOWED_CHAT_IDS && !ALLOWED_CHAT_IDS.has(chatId)) continue;

        // Handle photo messages
        if (msg.photo?.length) {
          const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
          const caption = (msg.caption || "").trim();
          handleImage(chatId, fileId, caption);
          continue;
        }

        // Handle document images
        if (msg.document?.mime_type?.startsWith("image/")) {
          const caption = (msg.caption || "").trim();
          handleImage(chatId, msg.document.file_id, caption, extFromMime(msg.document.mime_type));
          continue;
        }

        if (!msg.text) continue;
        const text: string = msg.text.trim();

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
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@\w+/, ""); // strip @botname suffix
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
          "/danger <msg> — Run with full permissions (skip approval)",
          "/usage — Session token usage & cost",
          "/context — Context window status",
          "/help — This message",
        ].join("\n"),
        "Markdown"
      );
      break;

    case "/new":
      clearSession(chatId);
      sessionUsage.delete(chatId);
      sendMessage(chatId, "Session cleared. Next message starts a new conversation.");
      break;

    case "/current": {
      const sid = getSessionId(chatId);
      if (sid) {
        const info = findSession(sid);
        const preview = info
          ? info.display.slice(0, 60) + (info.display.length > 60 ? "..." : "")
          : "";
        const ago = info ? ` (${timeAgo(info.timestamp)})` : "";
        sendMessage(
          chatId,
          `*Active session:* \`${sid.slice(0, 8)}\`${ago}\n${preview}`,
          "Markdown"
        );
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
      setSession(chatId, match.sessionId, match.project);
      const preview = match.display.slice(0, 60);
      sendMessage(
        chatId,
        `Resumed session \`${match.sessionId.slice(0, 8)}\` — "${preview}"`,
        "Markdown"
      );
      break;
    }

    case "/danger": {
      if (!arg) {
        sendMessage(chatId, "Usage: /danger <instruction>\n\nRuns with --dangerously-skip-permissions (no tool approval needed).");
        break;
      }
      handlePrompt(chatId, arg, true);
      break;
    }

    case "/usage": {
      const stats = sessionUsage.get(chatId);
      if (!stats || !Object.keys(stats.modelUsage).length) {
        sendMessage(chatId, "No usage data yet. Send a message first.");
        break;
      }
      // Aggregate totals across models
      let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
      for (const u of Object.values(stats.modelUsage)) {
        totalIn += u.inputTokens;
        totalOut += u.outputTokens;
        totalCacheRead += u.cacheReadInputTokens;
        totalCacheWrite += u.cacheCreationInputTokens;
      }

      const lines: string[] = [
        `*Usage:* ${formatTokens(totalIn)} input, ${formatTokens(totalOut)} output, ${formatTokens(totalCacheRead)} cache read, ${formatTokens(totalCacheWrite)} cache write`,
        "",
        "*Usage by model:*",
      ];
      for (const [model, u] of Object.entries(stats.modelUsage)) {
        const name = model.replace(/\[.*\]/, "");
        lines.push(
          `  ${name}  ${formatTokens(u.inputTokens)} in, ${formatTokens(u.outputTokens)} out, ${formatTokens(u.cacheReadInputTokens)} cache read, ${formatTokens(u.cacheCreationInputTokens)} cache write  $${u.costUSD.toFixed(4)}`
        );
      }
      lines.push(
        "",
        `*Total cost:* $${stats.totalCost.toFixed(4)}`,
        `*Total duration (API):* ${formatDuration(stats.totalApiDurationMs)}`,
        `*Total duration (wall):* ${formatDuration(stats.totalDurationMs)}`,
      );
      sendMessage(chatId, lines.join("\n"), "Markdown");
      break;
    }

    case "/context": {
      const stats = sessionUsage.get(chatId);
      if (!stats || !Object.keys(stats.modelUsage).length) {
        sendMessage(chatId, "No context data yet. Send a message first.");
        break;
      }
      // Use the first model's context window (primary model)
      const models = Object.values(stats.modelUsage);
      const contextWindow = models[0].contextWindow;
      if (!contextWindow) {
        sendMessage(chatId, "Context window info not available.");
        break;
      }
      let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
      for (const u of models) {
        totalIn += u.inputTokens;
        totalOut += u.outputTokens;
        totalCacheRead += u.cacheReadInputTokens;
        totalCacheWrite += u.cacheCreationInputTokens;
      }
      const totalTokens = totalIn + totalOut + totalCacheRead + totalCacheWrite;
      const pct = ((totalTokens / contextWindow) * 100).toFixed(1);
      const bar = progressBar(totalTokens, contextWindow);
      sendMessage(
        chatId,
        [
          "*Context window:*",
          "",
          `${bar} ${pct}%`,
          `${formatTokens(totalTokens)} / ${formatTokens(contextWindow)} tokens`,
        ].join("\n"),
        "Markdown"
      );
      break;
    }

    default:
      sendMessage(chatId, "Unknown command. Try /help");
  }
}

function progressBar(used: number, total: number, width = 15): string {
  const filled = Math.round((used / total) * width);
  return "▓".repeat(Math.min(filled, width)) + "░".repeat(Math.max(width - filled, 0));
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
    "image/webp": ".webp", "image/bmp": ".bmp", "image/tiff": ".tiff",
  };
  return map[mime] || ".jpg";
}

function handleImage(chatId: number, fileId: string, caption: string, ext = ".jpg"): void {
  enqueue(chatId, async () => {
    const stopTyping = startTyping(chatId);
    let localPath: string | undefined;
    try {
      localPath = await downloadFile(fileId, ext);
      const prompt = caption
        ? `Use the Read tool to view the image at ${localPath}, then respond to this: ${caption}`
        : `Use the Read tool to view the image at ${localPath} and describe what you see.`;
      const session = getSession(chatId);
      const result = await runClaude(prompt, session?.sessionId, session?.project, false, [PHOTO_DIR]);
      if (result.sessionId) {
        setSession(chatId, result.sessionId, session?.project || "");
      }
      accumulateUsage(chatId, result.modelUsage, result.cost, result.durationMs, result.durationApiMs);
      const text = formatResponse(result);
      await sendMessage(chatId, text, "Markdown");
    } catch (err) {
      await sendMessage(chatId, `Error processing image: ${err}`);
    } finally {
      stopTyping();
      if (localPath) fs.unlink(localPath, () => {});
    }
  });
}

function handlePrompt(chatId: number, prompt: string, dangerMode = false): void {
  enqueue(chatId, async () => {
    const stopTyping = startTyping(chatId);
    try {
      const session = getSession(chatId);
      const result = await runClaude(prompt, session?.sessionId, session?.project, dangerMode);
      if (result.sessionId) {
        setSession(chatId, result.sessionId, session?.project || "");
      }
      accumulateUsage(chatId, result.modelUsage, result.cost, result.durationMs, result.durationApiMs);
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
