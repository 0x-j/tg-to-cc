import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BOT_TOKEN = process.env.BOT_TOKEN!;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
export const PHOTO_DIR = path.join(os.tmpdir(), "tg-to-cc-photos");

fs.mkdirSync(PHOTO_DIR, { recursive: true });

export async function sendMessage(
  chatId: number,
  text: string,
  parseMode?: string
): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const body: Record<string, unknown> = { chat_id: chatId, text: chunk };
    if (parseMode) body.parse_mode = parseMode;

    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok && parseMode) {
      // Markdown parse failed — retry as plain text
      await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
    }
  }
}

export async function sendMessageWithId(
  chatId: number,
  text: string,
  parseMode?: string
): Promise<number | null> {
  const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 4096) };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
  return data.ok ? data.result!.message_id : null;
}

export async function editMessage(
  chatId: number,
  messageId: number,
  text: string,
  parseMode?: string
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4096),
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`${API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok && parseMode) {
    // Markdown parse failed — retry as plain text
    const res2 = await fetch(`${API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text.slice(0, 4096) }),
    });
    return res2.ok;
  }
  return res.ok;
}

export async function deleteMessage(
  chatId: number,
  messageId: number
): Promise<void> {
  await fetch(`${API}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
}

export async function setMyCommands(): Promise<void> {
  await fetch(`${API}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "new", description: "Start a new session" },
        { command: "project", description: "Show or switch project" },
        { command: "projects", description: "List all projects" },
        { command: "sessions", description: "List recent sessions" },
        { command: "resume", description: "Resume a session by ID" },
        { command: "current", description: "Show active session" },
        { command: "stop", description: "Cancel the running task" },
        { command: "danger", description: "Run with full permissions (skip approval)" },
        { command: "config", description: "Model, budget & permission settings" },
        { command: "usage", description: "Session token usage & cost" },
        { command: "context", description: "Context window status" },
        { command: "help", description: "Show available commands" },
      ],
    }),
  });
}

export async function sendMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: { text: string; callback_data: string }[][],
  parseMode?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok && parseMode) {
    body.parse_mode = undefined;
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, parse_mode: undefined }),
    });
  }
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function showStopKeyboard(chatId: number): Promise<void> {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Working on it...",
      reply_markup: {
        keyboard: [[{ text: "/stop" }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }),
  });
}

export async function removeReplyKeyboard(chatId: number, text: string, parseMode?: string): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: { remove_keyboard: true },
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok && parseMode) {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, parse_mode: undefined }),
    });
  }
}

export async function sendChatAction(
  chatId: number,
  action = "typing"
): Promise<void> {
  await fetch(`${API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

export function startTyping(chatId: number): () => void {
  sendChatAction(chatId);
  const interval = setInterval(() => sendChatAction(chatId), 4000);
  return () => clearInterval(interval);
}

export async function downloadFile(fileId: string, ext = ".jpg"): Promise<string> {
  const res = await fetch(`${API}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = (await res.json()) as { ok: boolean; result: { file_path: string } };
  if (!data.ok) throw new Error("Failed to get file path from Telegram");

  const fileRes = await fetch(`${FILE_API}/${data.result.file_path}`);
  if (!fileRes.ok) throw new Error("Failed to download file from Telegram");

  const localPath = path.join(PHOTO_DIR, `${fileId}${ext}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(localPath, buf);
  return localPath;
}

function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
