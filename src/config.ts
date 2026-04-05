import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "../data/config.json");

export interface ChatConfig {
  model?: string;
  maxBudget?: number;
  alwaysDanger?: boolean;
}

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

const BUDGETS = [0.25, 0.50, 1.00, 2.00, 5.00];

export { MODELS, BUDGETS };

const configs = new Map<number, ChatConfig>();

export function loadConfigs(): void {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      configs.set(Number(k), v as ChatConfig);
    }
  } catch {
    // No file yet
  }
}

function saveConfigs(): void {
  const obj: Record<string, ChatConfig> = {};
  for (const [k, v] of configs) obj[String(k)] = v;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

export function getConfig(chatId: number): ChatConfig {
  return configs.get(chatId) || {};
}

export function setConfigField<K extends keyof ChatConfig>(
  chatId: number,
  key: K,
  value: ChatConfig[K]
): void {
  const cfg = configs.get(chatId) || {};
  if (value === undefined) {
    delete cfg[key];
  } else {
    cfg[key] = value;
  }
  configs.set(chatId, cfg);
  saveConfigs();
}
