import { execFile } from "node:child_process";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/home/exedev/.local/bin/claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || "/home/exedev";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
}

export function runClaude(
  prompt: string,
  sessionId?: string,
  cwd?: string
): Promise<ClaudeResult> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "auto",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  return new Promise((resolve) => {
    execFile(
      CLAUDE_PATH,
      args,
      {
        cwd: cwd || CLAUDE_CWD,
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0" },
      },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({
            success: false,
            text: "",
            sessionId: sessionId || "",
            cost: 0,
            durationMs: 0,
            durationApiMs: 0,
            numTurns: 0,
            modelUsage: {},
            error: stderr || error.message,
          });
          return;
        }

        try {
          const data = JSON.parse(stdout);
          const modelUsage: Record<string, ModelUsage> = {};
          for (const [model, usage] of Object.entries(data.modelUsage || {})) {
            const u = usage as any;
            modelUsage[model] = {
              inputTokens: u.inputTokens || 0,
              outputTokens: u.outputTokens || 0,
              cacheReadInputTokens: u.cacheReadInputTokens || 0,
              cacheCreationInputTokens: u.cacheCreationInputTokens || 0,
              webSearchRequests: u.webSearchRequests || 0,
              costUSD: u.costUSD || 0,
              contextWindow: u.contextWindow || 0,
            };
          }

          const base = {
            sessionId: data.session_id || sessionId || "",
            cost: data.total_cost_usd || 0,
            durationMs: data.duration_ms || 0,
            durationApiMs: data.duration_api_ms || 0,
            numTurns: data.num_turns || 0,
            modelUsage,
          };

          if (data.is_error) {
            resolve({ ...base, success: false, text: data.result || "Unknown error", error: data.result });
          } else {
            let text = data.result || "(empty response)";
            const denials: string[] = data.permission_denials || [];
            if (denials.length) {
              text += "\n\n⚠️ Permissions blocked:\n" + denials.map((d: string) => `• ${d}`).join("\n");
            }
            resolve({ ...base, success: true, text });
          }
        } catch {
          resolve({
            success: false,
            text: "",
            sessionId: sessionId || "",
            cost: 0,
            durationMs: 0,
            durationApiMs: 0,
            numTurns: 0,
            modelUsage: {},
            error: `Failed to parse response: ${stdout.slice(0, 200)}`,
          });
        }
      }
    );
  });
}
