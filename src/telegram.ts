const BOT_TOKEN = process.env.BOT_TOKEN!;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

export async function setMyCommands(): Promise<void> {
  await fetch(`${API}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "new", description: "Start a new session" },
        { command: "sessions", description: "List recent sessions" },
        { command: "resume", description: "Resume a session by ID" },
        { command: "current", description: "Show active session" },
        { command: "usage", description: "Session token usage & cost" },
        { command: "context", description: "Context window status" },
        { command: "help", description: "Show available commands" },
      ],
    }),
  });
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
