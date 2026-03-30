import { execFile } from "node:child_process";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/home/exedev/.local/bin/claude";
const CLAUDE_CWD = process.env.CLAUDE_CWD || "/home/exedev";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ClaudeResult {
  success: boolean;
  text: string;
  sessionId: string;
  cost: number;
  durationMs: number;
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
            error: stderr || error.message,
          });
          return;
        }

        try {
          const data = JSON.parse(stdout);
          if (data.is_error) {
            resolve({
              success: false,
              text: data.result || "Unknown error",
              sessionId: data.session_id || sessionId || "",
              cost: data.total_cost_usd || 0,
              durationMs: data.duration_ms || 0,
              error: data.result,
            });
          } else {
            let text = data.result || "(empty response)";
            const denials: string[] = data.permission_denials || [];
            if (denials.length) {
              text += "\n\n⚠️ Permissions blocked:\n" + denials.map((d: string) => `• ${d}`).join("\n");
            }
            resolve({
              success: true,
              text,
              sessionId: data.session_id || sessionId || "",
              cost: data.total_cost_usd || 0,
              durationMs: data.duration_ms || 0,
            });
          }
        } catch {
          resolve({
            success: false,
            text: "",
            sessionId: sessionId || "",
            cost: 0,
            durationMs: 0,
            error: `Failed to parse response: ${stdout.slice(0, 200)}`,
          });
        }
      }
    );
  });
}
