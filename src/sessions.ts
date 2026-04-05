import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSIONS_FILE = path.join(
  __dirname,
  "../data/sessions.json"
);

interface ChatSession {
  sessionId: string;
  project: string;
}

export interface SessionInfo {
  sessionId: string;
  display: string;
  timestamp: number;
  project: string;
}

interface ChatData {
  active?: ChatSession;
  history: SessionInfo[];
}

const chatData = new Map<number, ChatData>();

export function load(): void {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      const chatId = Number(k);
      if (typeof v === "string") {
        // Migrate old format (bare session ID string)
        chatData.set(chatId, {
          active: { sessionId: v, project: "" },
          history: [{ sessionId: v, display: "(migrated)", timestamp: Date.now(), project: "" }],
        });
      } else if ((v as any).sessionId) {
        // Migrate format: { sessionId, project }
        const entry = v as ChatSession;
        chatData.set(chatId, {
          active: entry,
          history: [{ sessionId: entry.sessionId, display: "(migrated)", timestamp: Date.now(), project: entry.project }],
        });
      } else {
        // New format: { active, history }
        chatData.set(chatId, v as ChatData);
      }
    }
  } catch {
    // No file yet — that's fine
  }
}

function save(): void {
  const obj: Record<string, ChatData> = {};
  for (const [k, v] of chatData) obj[String(k)] = v;
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  const tmp = SESSIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}

function ensureChat(chatId: number): ChatData {
  let data = chatData.get(chatId);
  if (!data) {
    data = { history: [] };
    chatData.set(chatId, data);
  }
  return data;
}

export function getSession(chatId: number): ChatSession | undefined {
  return chatData.get(chatId)?.active;
}

export function getSessionId(chatId: number): string | undefined {
  return chatData.get(chatId)?.active?.sessionId;
}

export function setSession(chatId: number, sessionId: string, project: string, display?: string): void {
  const data = ensureChat(chatId);
  data.active = { sessionId, project };

  // Update or add to history
  const existing = data.history.find((s) => s.sessionId === sessionId);
  if (existing) {
    existing.timestamp = Date.now();
    if (display) existing.display = display;
  } else {
    data.history.push({
      sessionId,
      display: display || "(new session)",
      timestamp: Date.now(),
      project,
    });
  }

  // Keep history bounded
  if (data.history.length > 50) {
    data.history.sort((a, b) => b.timestamp - a.timestamp);
    data.history = data.history.slice(0, 50);
  }

  save();
}

export function clearSession(chatId: number): void {
  const data = chatData.get(chatId);
  if (data) {
    data.active = undefined;
    save();
  }
}

export function listHistory(chatId: number, limit = 10): SessionInfo[] {
  const data = chatData.get(chatId);
  if (!data) return [];
  return [...data.history]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

export function findSession(chatId: number, idPrefix: string): SessionInfo | undefined {
  const data = chatData.get(chatId);
  if (!data) return undefined;
  return data.history.find((s) => s.sessionId.startsWith(idPrefix));
}
