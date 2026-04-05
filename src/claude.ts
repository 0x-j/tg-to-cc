import { spawn } from "node:child_process";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/home/exedev/.local/bin/claude";
export const CLAUDE_CWD = process.env.CLAUDE_CWD || "/home/exedev/workspace";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUDGET_USD = process.env.MAX_BUDGET_USD || "0.50";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
}

export interface ClaudeResult {
  success: boolean;
  text: string;
  sessionId: string;
  cost: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  modelUsage: Record<string, ModelUsage>;
  error?: string;
  budgetExceeded?: boolean;
}

function parseModelUsage(raw: Record<string, any>): Record<string, ModelUsage> {
  const modelUsage: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(raw)) {
    const u = usage as any;
    modelUsage[model] = {
      inputTokens: u.inputTokens || u.input_tokens || 0,
      outputTokens: u.outputTokens || u.output_tokens || 0,
      cacheReadInputTokens: u.cacheReadInputTokens || u.cache_read_input_tokens || 0,
      cacheCreationInputTokens: u.cacheCreationInputTokens || u.cache_creation_input_tokens || 0,
      webSearchRequests: u.webSearchRequests || u.web_search_requests || 0,
      costUSD: u.costUSD || u.cost_usd || 0,
      contextWindow: u.contextWindow || u.context_window || 0,
    };
  }
  return modelUsage;
}

export function runClaude(
  prompt: string,
  sessionId?: string,
  cwd?: string,
  dangerMode?: boolean,
  addDirs?: string[],
  onProgress?: (text: string) => void
): Promise<ClaudeResult> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    MAX_BUDGET_USD,
    ...(dangerMode
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "auto", "--allowedTools", "WebSearch", "WebFetch"]),
    ...(addDirs?.flatMap((d) => ["--add-dir", d]) ?? []),
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_PATH, args, {
      cwd: cwd || CLAUDE_CWD,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let currentText = "";
    let resultEvent: any = null;

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    proc.stdin.end();

    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            const texts = event.message.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text);
            if (texts.length) {
              currentText = texts.join("\n");
              onProgress?.(currentText);
            }
          } else if (event.type === "result") {
            resultEvent = event;
          }
        } catch {
          // skip unparseable lines
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") resultEvent = event;
        } catch {}
      }

      if (resultEvent) {
        const data = resultEvent;
        const modelUsage = parseModelUsage(data.model_usage || data.modelUsage || {});

        const base = {
          sessionId: data.session_id || sessionId || "",
          cost: data.total_cost_usd || 0,
          durationMs: data.duration_ms || 0,
          durationApiMs: data.duration_api_ms || 0,
          numTurns: data.num_turns || 0,
          modelUsage,
        };

        if (data.is_error || data.subtype === "error" || data.subtype?.startsWith("error_")) {
          const errors: string[] = data.errors || [];
          const budgetExceeded = data.subtype === "error_max_budget_usd";
          const errorMsg = errors.join("; ") || data.result || "Unknown error";
          resolve({ ...base, success: false, text: errorMsg, error: errorMsg, budgetExceeded });
        } else {
          let text = data.result || currentText || "(empty response)";
          const denials: string[] = data.permission_denials || [];
          if (denials.length) {
            text += "\n\n⚠️ Permissions blocked:\n" + denials.map((d: string) => `• ${d}`).join("\n");
          }
          resolve({ ...base, success: true, text });
        }
      } else if (currentText) {
        resolve({
          success: true,
          text: currentText,
          sessionId: sessionId || "",
          cost: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 0,
          modelUsage: {},
        });
      } else {
        resolve({
          success: false,
          text: "",
          sessionId: sessionId || "",
          cost: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 0,
          modelUsage: {},
          error: stderr || `Process exited with code ${code}`,
        });
      }
    });
  });
}
