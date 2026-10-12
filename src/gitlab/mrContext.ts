import { createGitlabWithToken, type GitlabClient } from './client.js';
import { formatDiscussions } from './discussions.js';

/**
 * Чтение контекста MR по read-only токену — общая реализация для обоих транспортов:
 * shell-CLI (codex) и MCP-инструментов (claude).
 *
 * Отдельно от `discussions.ts`, который собирает срез для промпта: здесь треды отдаются
 * целиком и по требованию, а не обрезаются по `EXISTING_THREADS_MAX`.
 */

export interface MrContextConfig {
  readonly host: string;
  /** PAT со scope `read_api`. Рекомендуется project access token — узкий blast radius. */
  readonly token: string;
  readonly projectId: number;
  readonly mrIid: number;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return String(v);
}

function client(config: MrContextConfig): GitlabClient {
  return createGitlabWithToken(config.host, config.token);
}

/**
 * Шапка MR: заголовок, автор, метки, описание. В промпт это не вклеивается —
 * описание MR часто объясняет намерение автора, но раньше агенту было недоступно вовсе.
 */
export async function mrInfo(config: MrContextConfig, api?: GitlabClient): Promise<string> {
  const gl = api ?? client(config);
  const mr = rec(await gl.MergeRequests.show(config.projectId, config.mrIid));

  const labels = Array.isArray(mr['labels']) ? (mr['labels'] as unknown[]).map(str) : [];
  const description = str(mr['description']).trim();

  return [
    `# ${str(mr['title'])} (!${config.mrIid})`,
    `Автор: ${str(rec(mr['author'])['username']) || '?'}`,
    `Ветки: ${str(mr['source_branch'] ?? mr['sourceBranch'])} → ${str(mr['target_branch'] ?? mr['targetBranch'])}`,
    `Статус: ${str(mr['state'])}${mr['draft'] === true ? ' (draft)' : ''}`,
    ...(labels.length > 0 ? [`Метки: ${labels.join(', ')}`] : []),
    '',
    description.length > 0 ? description : '(описание пустое)',
  ].join('\n');
}

/** Все треды MR целиком: локация, resolved, реплики. Без обрезания. */
export async function mrNotes(config: MrContextConfig, api?: GitlabClient): Promise<string> {
  const gl = api ?? client(config);
  const discussions = (await gl.MergeRequestDiscussions.all(config.projectId, config.mrIid, {
    perPage: 100,
  })) as unknown[];

  const text = formatDiscussions(discussions);
  return text.length > 0 ? text : 'В этом MR пока нет обсуждений.';
}
