const queues = new Map<number, Promise<void>>();

export function enqueue(chatId: number, task: () => Promise<void>): void {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch(() => {})
    .finally(() => {
      if (queues.get(chatId) === next) queues.delete(chatId);
    });
  queues.set(chatId, next);
}
