import fs from "node:fs";
import path from "node:path";

const SESSIONS_FILE = path.join(
  import.meta.dirname,
  "../data/sessions.json"
);
const HISTORY_FILE = path.join(
  process.env.HOME || "/home/exedev",
  ".claude/history.jsonl"
);

const chatSessions = new Map<number, string>();

export function load(): void {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      chatSessions.set(Number(k), v as string);
    }
  } catch {
    // No file yet — that's fine
  }
}

function save(): void {
  const obj: Record<string, string> = {};
  for (const [k, v] of chatSessions) obj[String(k)] = v;
  const tmp = SESSIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
}

export function getSessionId(chatId: number): string | undefined {
  return chatSessions.get(chatId);
}

export function setSessionId(chatId: number, sessionId: string): void {
  chatSessions.set(chatId, sessionId);
  save();
}

export function clearSession(chatId: number): void {
  chatSessions.delete(chatId);
  save();
}

export interface SessionInfo {
  sessionId: string;
  display: string;
  timestamp: number;
  project: string;
}

export function listHistory(limit = 10): SessionInfo[] {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, "utf-8").trim().split("\n");
    const seen = new Map<string, SessionInfo>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.sessionId) continue;
        if (!seen.has(entry.sessionId)) {
          seen.set(entry.sessionId, {
            sessionId: entry.sessionId,
            display: entry.display || "(no prompt)",
            timestamp: entry.timestamp,
            project: entry.project || "",
          });
        }
      } catch {
        continue;
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function findSession(idPrefix: string): SessionInfo | undefined {
  const history = listHistory(50);
  return history.find((s) => s.sessionId.startsWith(idPrefix));
}
