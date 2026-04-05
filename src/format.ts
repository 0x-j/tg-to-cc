import type { ClaudeResult } from "./claude.js";

export function formatResponse(result: ClaudeResult): string {
  if (!result.success) {
    if (result.budgetExceeded) {
      return `⚠️ Budget limit reached for this message. The response may be incomplete.\n\n${result.error}`;
    }
    return `Error: ${result.error || "Unknown error"}`;
  }

  const sid = result.sessionId.slice(0, 8);
  const cost = result.cost.toFixed(4);
  const dur = (result.durationMs / 1000).toFixed(1);
  const footer = `\n\n_session: \`${sid}\` | $${cost} | ${dur}s_`;

  return result.text + footer;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
