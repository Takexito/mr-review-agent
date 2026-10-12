import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/util/keyedMutex.js';

/**
 * Мьютекс появился вместе с `QUEUE_CONCURRENCY=2`: параллельные `git fetch` в один
 * bare-кэш ловят `cannot lock ref`. Проверяем именно сериализацию по ключу.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('KeyedMutex', () => {
  it('should serialize tasks when they share a key', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const first = deferred();

    const a = mutex.run('repo', async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = mutex.run('repo', async () => {
      events.push('b:start');
    });

    // Пока первая держит ключ, вторая не должна была даже начаться.
    await Promise.resolve();
    expect(events).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('should run tasks concurrently when keys differ', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const blocker = deferred();

    const a = mutex.run('repo-a', async () => {
      events.push('a:start');
      await blocker.promise;
    });
    const b = mutex.run('repo-b', async () => {
      events.push('b:start');
    });

    await b;
    expect(events).toContain('b:start');

    blocker.resolve();
    await a;
  });

  it('should keep the queue alive when a task throws', async () => {
    const mutex = new KeyedMutex();

    const failing = mutex.run('repo', async () => {
      throw new Error('fetch failed');
    });
    const next = mutex.run('repo', async () => 'ok');

    await expect(failing).rejects.toThrow('fetch failed');
    await expect(next).resolves.toBe('ok');
  });

  it('should release the key when the queue drains', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('repo', async () => undefined);
    // Следующая задача не должна ждать ничего — если ключ не почищен, тут будет утечка.
    await expect(mutex.run('repo', async () => 'again')).resolves.toBe('again');
  });

  it('should return the task result to its own caller', async () => {
    const mutex = new KeyedMutex();
    const [a, b] = await Promise.all([
      mutex.run('repo', async () => 1),
      mutex.run('repo', async () => 2),
    ]);
    expect([a, b]).toEqual([1, 2]);
  });
});
