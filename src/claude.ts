import { spawn } from "node:child_process";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "/home/exedev/.local/bin/claude";
export const CLAUDE_CWD = process.env.CLAUDE_CWD || "/home/exedev/workspace";
const DEFAULT_BUDGET_USD = "0.50";

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
  cancelled?: boolean;
}

export interface ClaudeOptions {
  sessionId?: string;
  cwd?: string;
  dangerMode?: boolean;
  addDirs?: string[];
  model?: string;
  maxBudget?: number;
}

export interface ClaudeHandle {
  promise: Promise<ClaudeResult>;
  kill: () => void;
}

export function runClaude(
  prompt: string,
  opts: ClaudeOptions = {}
): ClaudeHandle {
  const { sessionId, cwd, dangerMode, addDirs, model, maxBudget } = opts;
  const budget = maxBudget ? String(maxBudget) : DEFAULT_BUDGET_USD;
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-budget-usd",
    budget,
    ...(model ? ["--model", model] : []),
    ...(dangerMode
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "auto", "--allowedTools", "WebSearch", "WebFetch"]),
    ...(addDirs?.flatMap((d) => ["--add-dir", d]) ?? []),
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  let killed = false;
  const child = spawn(CLAUDE_PATH, args, {
    cwd: cwd || CLAUDE_CWD,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const kill = () => {
    killed = true;
    // Kill the entire process group to catch subprocesses
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
    // Force kill after 3s if still alive
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      try { child.kill("SIGKILL"); } catch {}
    }, 3000);
  };

  const promise = new Promise<ClaudeResult>((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let totalLen = 0;
    const MAX_BUF = 10 * 1024 * 1024;

    child.stdout.on("data", (chunk: Buffer) => {
      if (totalLen < MAX_BUF) {
        chunks.push(chunk);
        totalLen += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      if (killed && !stdout) {
        resolve({
          success: false,
          text: "",
          sessionId: sessionId || "",
          cost: 0,
          durationMs: 0,
          durationApiMs: 0,
          numTurns: 0,
          modelUsage: {},
          error: "Task cancelled.",
          cancelled: true,
        });
        return;
      }

      if (code !== 0 && !stdout) {
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
          const errors: string[] = data.errors || [];
          const budgetExceeded = data.subtype === "error_max_budget_usd";
          const errorMsg = errors.join("; ") || data.result || "Unknown error";
          resolve({ ...base, success: false, text: errorMsg, error: errorMsg, budgetExceeded });
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
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        text: "",
        sessionId: sessionId || "",
        cost: 0,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 0,
        modelUsage: {},
        error: err.message,
      });
    });
  });

  return { promise, kill };
}
