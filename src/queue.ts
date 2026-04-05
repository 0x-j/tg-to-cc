const busy = new Set<number>();
const killers = new Map<number, () => void>();

export function isBusy(chatId: number): boolean {
  return busy.has(chatId);
}

export function setKill(chatId: number, kill: () => void): void {
  killers.set(chatId, kill);
}

export function clearKill(chatId: number): void {
  killers.delete(chatId);
}

/** Kill the running task for a chat. Returns true if there was something to kill. */
export function stop(chatId: number): boolean {
  const kill = killers.get(chatId);
  if (kill) {
    kill();
    killers.delete(chatId);
    return true;
  }
  return false;
}

export function enqueue(chatId: number, task: () => Promise<void>): void {
  busy.add(chatId);
  task()
    .catch(() => {})
    .finally(() => {
      busy.delete(chatId);
      killers.delete(chatId);
    });
}
