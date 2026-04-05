import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { sendMessage, sendMessageWithKeyboard, answerCallbackQuery, startTyping, setMyCommands, downloadFile, showStopKeyboard, removeReplyKeyboard, PHOTO_DIR } from "./telegram.js";
import { runClaude, CLAUDE_CWD, type ModelUsage } from "./claude.js";
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
import { enqueue, isBusy, setKill, clearKill, stop } from "./queue.js";
import { loadConfigs, getConfig, setConfigField, getActiveProject, setProject, switchProject, listProjects, MODELS, BUDGETS } from "./config.js";

if (!process.env.ALLOWED_CHAT_IDS) {
  console.error("ALLOWED_CHAT_IDS is required. Set it in .env as a comma-separated list of Telegram chat IDs.");
  process.exit(1);
}
const ALLOWED_CHAT_IDS = new Set(process.env.ALLOWED_CHAT_IDS.split(",").map(Number));

const BOT_TOKEN = process.env.BOT_TOKEN!;
const POLL_URL = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;

interface SessionUsage {
  totalCost: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  modelUsage: Record<string, ModelUsage>;
}

const sessionUsage = new Map<number, SessionUsage>();

function chatCwd(chatId: number): string {
  const proj = getActiveProject(chatId);
  // If path is absolute, use it directly; otherwise it's relative to workspace/<chatId>/
  const dir = path.isAbsolute(proj.path)
    ? proj.path
    : path.join(CLAUDE_CWD, String(chatId), proj.path);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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
loadConfigs();
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

        // Handle inline keyboard callback queries
        const cb = update.callback_query;
        if (cb?.data && cb.message?.chat?.id) {
          const cbChatId: number = cb.message.chat.id;
          if (ALLOWED_CHAT_IDS.has(cbChatId)) {
            if (cb.data.startsWith("resume:")) {
              const sessionId = cb.data.slice("resume:".length);
              const match = findSession(cbChatId, sessionId);
              if (match) {
                setSession(cbChatId, match.sessionId, match.project);
                const preview = match.display.slice(0, 60);
                answerCallbackQuery(cb.id, `Resumed ${match.sessionId.slice(0, 8)}`);
                sendMessage(
                  cbChatId,
                  `Resumed session \`${match.sessionId.slice(0, 8)}\` — "${preview}"`,
                  "Markdown"
                );
              } else {
                answerCallbackQuery(cb.id, "Session not found");
              }
            } else if (cb.data.startsWith("cfg:")) {
              handleConfigCallback(cbChatId, cb.id, cb.data);
            }
          }
          continue;
        }

        const msg = update.message;
        if (!msg?.chat?.id) continue;

        const chatId: number = msg.chat.id;
        if (!ALLOWED_CHAT_IDS.has(chatId)) continue;

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
          "/project — Show current project",
          "/project <name> — Switch or create project",
          "/project <name> <path> — Create project at custom path",
          "/projects — List all projects",
          "/sessions — List recent sessions",
          "/resume <id> — Resume a session",
          "/current — Show active session",
          "/stop — Cancel the running task",
          "/danger <msg> — Run with full permissions (skip approval)",
          "/config — Model, budget & permission settings",
          "/upgrade — Upgrade tg bot itself to latest",
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

    case "/project": {
      if (!arg) {
        const proj = getActiveProject(chatId);
        sendMessage(chatId, `*Current project:* \`${proj.name}\`\n\`${chatCwd(chatId)}\``, "Markdown");
        break;
      }
      const parts = arg.split(/\s+/);
      const name = parts[0].replace(/[^a-zA-Z0-9_-]/g, "");
      if (!name) {
        sendMessage(chatId, "Project name can only contain letters, numbers, hyphens, and underscores.");
        break;
      }
      const customPath = parts.slice(1).join(" ").trim().replace(/^~/, process.env.HOME || "~");

      if (customPath) {
        // Create/update project with custom path
        if (!path.isAbsolute(customPath)) {
          sendMessage(chatId, "Path must be absolute (e.g. `/project myapp ~/my-projects/myapp`).", "Markdown");
          break;
        }
        if (!fs.existsSync(customPath)) {
          sendMessage(chatId, `Path does not exist: \`${customPath}\``, "Markdown");
          break;
        }
        setProject(chatId, name, customPath);
      } else if (!switchProject(chatId, name)) {
        // New project at default location
        setProject(chatId, name, name);
      }
      clearSession(chatId);
      sessionUsage.delete(chatId);
      sendMessage(chatId, `Switched to project \`${name}\`\n\`${chatCwd(chatId)}\`\nSession cleared.`, "Markdown");
      break;
    }

    case "/projects": {
      const projects = listProjects(chatId);
      if (!projects.length) {
        sendMessage(chatId, "No projects yet. Send a message to create the default project.");
        break;
      }
      const active = getActiveProject(chatId).name;
      const lines = projects.map((p) => {
        const arrow = p.name === active ? "▸ " : "  ";
        const resolvedPath = path.isAbsolute(p.path)
          ? p.path
          : path.join(CLAUDE_CWD, String(chatId), p.path);
        return `${arrow}\`${p.name}\` — \`${resolvedPath.replace(/^\/home\/[^/]+/, "~")}\``;
      });
      sendMessage(chatId, `*Projects:*\n${lines.join("\n")}`, "Markdown");
      break;
    }

    case "/current": {
      const sid = getSessionId(chatId);
      if (sid) {
        const info = findSession(chatId, sid);
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
      const sessions = listHistory(chatId);
      if (!sessions.length) {
        sendMessage(chatId, "No sessions found.");
        return;
      }
      const lines = sessions.map((s, i) => {
        const preview = s.display.slice(0, 50) + (s.display.length > 50 ? "..." : "");
        return `${i + 1}. \`${s.sessionId.slice(0, 8)}\` — ${preview} (${timeAgo(s.timestamp)})`;
      });
      const buttons = sessions.map((s) => {
        const preview = s.display.slice(0, 30) + (s.display.length > 30 ? "…" : "");
        return [{ text: `${s.sessionId.slice(0, 8)} — ${preview}`, callback_data: `resume:${s.sessionId}` }];
      });
      sendMessageWithKeyboard(
        chatId,
        `*Recent sessions:*\n\n${lines.join("\n")}`,
        buttons,
        "Markdown"
      );
      break;
    }

    case "/resume": {
      if (!arg) {
        sendMessage(chatId, "Usage: /resume <session-id-prefix>");
        return;
      }
      const match = findSession(chatId, arg);
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

    case "/stop": {
      if (stop(chatId)) {
        sendMessage(chatId, "Stopping current task...");
      } else {
        sendMessage(chatId, "Nothing running.");
      }
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

    case "/config":
      sendConfigMenu(chatId);
      break;

    case "/upgrade": {
      const botDir = path.resolve(import.meta.dirname!, "..");
      sendMessage(chatId, "Pulling latest changes...");
      // Capture current HEAD before pull so we can show what changed
      execFile("git", ["rev-parse", "HEAD"], { cwd: botDir }, (_, oldHead) => {
        const oldRef = (oldHead || "").trim();
        execFile("git", ["pull"], { cwd: botDir, timeout: 30000 }, async (err, stdout, stderr) => {
          const output = (stdout || stderr || err?.message || "").trim();
          if (err) {
            await sendMessage(chatId, `Upgrade failed:\n\`\`\`\n${output}\n\`\`\``, "Markdown");
            return;
          }
          if (output.includes("Already up to date")) {
            await sendMessage(chatId, "Already up to date.");
            return;
          }
          // Show commit log of what changed
          execFile("git", ["log", "--oneline", `${oldRef}..HEAD`], { cwd: botDir }, async (_, log) => {
            const changes = (log || "").trim();
            const msg = changes
              ? `*Changes:*\n\`\`\`\n${changes}\n\`\`\`\nRestarting...`
              : `\`\`\`\n${output}\n\`\`\`\nRestarting...`;
            await sendMessage(chatId, msg, "Markdown");
            execFile("sudo", ["systemctl", "restart", "tg-to-cc"], { timeout: 10000 }, () => {});
          });
        });
      });
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
  if (isBusy(chatId)) {
    sendMessage(chatId, "Please wait — still generating a response.");
    return;
  }
  enqueue(chatId, async () => {
    const stopTyping = startTyping(chatId);
    showStopKeyboard(chatId);
    let localPath: string | undefined;
    try {
      localPath = await downloadFile(fileId, ext);
      const prompt = caption
        ? `Use the Read tool to view the image at ${localPath}, then respond to this: ${caption}`
        : `Use the Read tool to view the image at ${localPath} and describe what you see.`;
      const session = getSession(chatId);
      const cwd = session?.project || chatCwd(chatId);
      const cfg = getConfig(chatId);
      const handle = runClaude(prompt, {
        sessionId: session?.sessionId,
        cwd,
        dangerMode: cfg.alwaysDanger || false,
        addDirs: [PHOTO_DIR],
        model: cfg.model,
        maxBudget: cfg.maxBudget,
      });
      setKill(chatId, handle.kill);
      const result = await handle.promise;
      clearKill(chatId);
      if (result.cancelled) {
        await removeReplyKeyboard(chatId, "Task cancelled.");
        return;
      }
      if (result.sessionId) {
        setSession(chatId, result.sessionId, cwd, caption || "image");
      }
      accumulateUsage(chatId, result.modelUsage, result.cost, result.durationMs, result.durationApiMs);
      const text = formatResponse(result, cwd);
      await removeReplyKeyboard(chatId, text, "Markdown");
    } catch (err) {
      await removeReplyKeyboard(chatId, `Error processing image: ${err}`);
    } finally {
      stopTyping();
      if (localPath) fs.unlink(localPath, () => {});
    }
  });
}

function handlePrompt(chatId: number, prompt: string, dangerMode = false): void {
  if (isBusy(chatId)) {
    sendMessage(chatId, "Please wait — still generating a response.");
    return;
  }
  enqueue(chatId, async () => {
    const stopTyping = startTyping(chatId);
    showStopKeyboard(chatId);
    try {
      const session = getSession(chatId);
      const cwd = session?.project || chatCwd(chatId);
      const cfg = getConfig(chatId);
      const handle = runClaude(prompt, {
        sessionId: session?.sessionId,
        cwd,
        dangerMode: dangerMode || cfg.alwaysDanger || false,
        model: cfg.model,
        maxBudget: cfg.maxBudget,
      });
      setKill(chatId, handle.kill);
      const result = await handle.promise;
      clearKill(chatId);
      if (result.cancelled) {
        await removeReplyKeyboard(chatId, "Task cancelled.");
        return;
      }
      if (result.sessionId) {
        setSession(chatId, result.sessionId, cwd, prompt);
      }
      accumulateUsage(chatId, result.modelUsage, result.cost, result.durationMs, result.durationApiMs);
      const text = formatResponse(result, cwd);
      await removeReplyKeyboard(chatId, text, "Markdown");
    } catch (err) {
      await removeReplyKeyboard(chatId, `Error: ${err}`);
    } finally {
      stopTyping();
    }
  });
}

function sendConfigMenu(chatId: number): void {
  const cfg = getConfig(chatId);
  const currentModel = cfg.model || "default";
  const currentBudget = cfg.maxBudget ?? "default (0.50)";
  const dangerLabel = cfg.alwaysDanger ? "ON" : "OFF";

  const modelButtons = MODELS.map((m) => ({
    text: (cfg.model === m.id ? "✓ " : "") + m.label,
    callback_data: `cfg:model:${m.id}`,
  }));
  modelButtons.unshift({
    text: (!cfg.model ? "✓ " : "") + "Default",
    callback_data: "cfg:model:default",
  });

  const budgetButtons = BUDGETS.map((b) => ({
    text: (cfg.maxBudget === b ? "✓ " : "") + `$${b.toFixed(2)}`,
    callback_data: `cfg:budget:${b}`,
  }));
  budgetButtons.unshift({
    text: (!cfg.maxBudget ? "✓ " : "") + "Default",
    callback_data: "cfg:budget:default",
  });

  const keyboard = [
    modelButtons,
    budgetButtons,
    [
      {
        text: `Skip permissions: ${dangerLabel}`,
        callback_data: "cfg:danger:toggle",
      },
    ],
  ];

  sendMessageWithKeyboard(
    chatId,
    [
      "*Configuration*",
      "",
      `*Model:* ${currentModel}`,
      `*Budget:* $${currentBudget}`,
      `*Skip permissions:* ${dangerLabel}`,
      "",
      "Tap to change:",
    ].join("\n"),
    keyboard,
    "Markdown"
  );
}

function handleConfigCallback(chatId: number, callbackId: string, data: string): void {
  const parts = data.split(":");
  const field = parts[1];
  const value = parts[2];

  switch (field) {
    case "model":
      if (value === "default") {
        setConfigField(chatId, "model", undefined);
        answerCallbackQuery(callbackId, "Model reset to default");
      } else {
        setConfigField(chatId, "model", value);
        const label = MODELS.find((m) => m.id === value)?.label || value;
        answerCallbackQuery(callbackId, `Model set to ${label}`);
      }
      break;
    case "budget":
      if (value === "default") {
        setConfigField(chatId, "maxBudget", undefined);
        answerCallbackQuery(callbackId, "Budget reset to default");
      } else {
        setConfigField(chatId, "maxBudget", Number(value));
        answerCallbackQuery(callbackId, `Budget set to $${value}`);
      }
      break;
    case "danger":
      const cfg = getConfig(chatId);
      const newVal = !cfg.alwaysDanger;
      setConfigField(chatId, "alwaysDanger", newVal || undefined);
      answerCallbackQuery(callbackId, `Skip permissions: ${newVal ? "ON" : "OFF"}`);
      break;
  }

  // Refresh the config menu
  sendConfigMenu(chatId);
}

console.log("tg-to-cc starting (long polling)...");
poll();
