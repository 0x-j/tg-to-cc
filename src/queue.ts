const busy = new Set<number>();

export function isBusy(chatId: number): boolean {
  return busy.has(chatId);
}

export function enqueue(chatId: number, task: () => Promise<void>): void {
  busy.add(chatId);
  task()
    .catch(() => {})
    .finally(() => busy.delete(chatId));
}
