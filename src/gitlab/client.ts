import { Gitlab } from '@gitbeaker/rest';
import type { AppConfig } from '../config.js';
import { neutralizeQuickActions } from './quickActions.js';

export type GitlabClient = InstanceType<typeof Gitlab>;

/** Клиент под конкретный бот-токен — им постятся комменты от имени этого бот-юзера. */
export function createGitlabWithToken(host: string, token: string): GitlabClient {
  return guardNoteBodies(new Gitlab({ host, token }));
}

type AnyMethod = (...args: unknown[]) => unknown;

/**
 * Обезвреживает quick actions на единственном выходе в GitLab, а не в каждом месте публикации:
 * новый путь постинга иначе пришлось бы не забыть защитить отдельно.
 * `bodyIndex` — позиция текста заметки в аргументах метода gitbeaker.
 */
function guardNoteBodies(client: GitlabClient): GitlabClient {
  const guard = (resource: object, method: string, bodyIndex: number): void => {
    const target = resource as Record<string, AnyMethod>;
    const original = target[method]!.bind(resource);
    target[method] = (...args: unknown[]) => {
      const body = args[bodyIndex];
      if (typeof body === 'string') args[bodyIndex] = neutralizeQuickActions(body);
      return original(...args);
    };
  };
  guard(client.MergeRequestNotes, 'create', 2);
  guard(client.MergeRequestDiscussions, 'create', 2);
  guard(client.MergeRequestDiscussions, 'addNote', 4);
  return client;
}

/** Клиент по дефолтному (codex) токену. */
export function createGitlab(config: AppConfig): GitlabClient {
  return createGitlabWithToken(config.gitlabHost, config.gitlabToken);
}
