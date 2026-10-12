/**
 * Последовательный доступ к ресурсу по ключу.
 *
 * Нужен с тех пор, как воркер работает с concurrency > 1: две джобы по одному репозиторию
 * лезут в один bare-кэш, и параллельные `git fetch` / `worktree add` ловят `cannot lock ref`
 * или `index.lock`. Мьютекс — в процессе, чего достаточно: воркер один, кэш локальный.
 */
export class KeyedMutex {
  /** Хвост очереди по ключу. Ключ удаляется, когда его очередь опустела. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Выполняет `fn`, гарантируя, что для этого `key` одновременно бежит не более одной задачи. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Ошибка предыдущей задачи не должна ронять следующую — ждём только завершения.
    const result = previous.then(fn, fn);
    // В хвост кладём проглоченную версию, иначе неперехваченный reject всплывёт как unhandled.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Чистим только если за нами никто не встал, иначе затрём чужой хвост.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
