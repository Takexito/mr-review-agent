import type { LinearConfig } from '../config.js';
import { LinearError, searchLinearIssues, fetchLinearIssue, type LinearIssue } from '../linear/client.js';
import { formatIssue } from '../linear/requirements.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mrInfo, mrNotes, type MrContextConfig } from '../gitlab/mrContext.js';
import { fetchGitlabUrl } from '../gitlab/fetchUrl.js';

/**
 * Реализация инструментов ctxmcp без MCP-обвязки — так их можно тестировать
 * обычными юнит-тестами, не поднимая транспорт.
 *
 * Инструменты про Linear и про сам MR. Документация сюда НЕ заведена: чекаут docs-repo
 * лежит на диске рядом с worktree и читается обоими движками напрямую, а MCP работает
 * только у claude (см. README, раздел про ограничение codex).
 *
 * Те же функции обслуживают и shell-CLI для codex — транспорта два, поведение одно.
 */

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

function ok(text: string): ToolResult {
  return { text, isError: false };
}

function fail(text: string): ToolResult {
  return { text, isError: true };
}

/**
 * Ошибки отдаём агенту текстом: он должен уметь продолжить без этого источника.
 * Gitbeaker кладёт полезное в `cause.description` (`401 Unauthorized`), а сам
 * `String(error)` даёт бесполезное `GitbeakerRequestError` — по нему агент не отличит
 * протухший токен от отсутствующего MR.
 */
export function describeError(error: unknown): string {
  if (error instanceof LinearError) return error.message;

  const cause = (error as { cause?: { description?: unknown; response?: { status?: unknown } } })?.cause;
  if (cause) {
    const description = typeof cause.description === 'string' ? cause.description : '';
    const status = cause.response?.status;
    if (description) return description;
    if (status !== undefined) return `HTTP ${String(status)}`;
  }

  const message = (error as { message?: unknown })?.message;
  if (typeof message === 'string' && message.trim().length > 0) return message;
  const name = (error as { name?: unknown })?.name;
  if (typeof name === 'string' && name.length > 0) return name;
  return String(error);
}

function renderIssue(issue: LinearIssue): string {
  const parts = [formatIssue(issue), '', `URL: ${issue.url}`];
  if (issue.parentIdentifier) {
    parts.push(`Родительская задача: ${issue.parentIdentifier} — ${issue.parentTitle ?? ''}`.trim());
  }
  for (const doc of issue.documents) {
    parts.push('', `## Документ: ${doc.title}`, doc.content.trim());
  }
  return parts.join('\n');
}

export async function linearGetIssue(config: LinearConfig, key: unknown): Promise<ToolResult> {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return fail('Параметр "key" обязателен, например "PRJ-137".');
  }
  try {
    const issue = await fetchLinearIssue(config, key.trim());
    if (!issue) return fail(`Задача ${key} не найдена в Linear (или ключ неверного формата).`);
    return ok(renderIssue(issue));
  } catch (error) {
    return fail(`Linear недоступен: ${describeError(error)}`);
  }
}

/**
 * Контекст MR для инструментов чтения. Приходит из окружения процесса: и MCP-сервер,
 * и CLI поднимаются на конкретную джобу, поэтому «какой MR» — не параметр агента.
 * (Это удобство, а не граница безопасности: токен всё равно в окружении процесса.)
 */
export function mrContextFromEnv(env: NodeJS.ProcessEnv): MrContextConfig | null {
  const token = env['GITLAB_READ_TOKEN'];
  const projectId = Number(env['GITLAB_PROJECT_ID']);
  const mrIid = Number(env['GITLAB_MR_IID']);
  if (!token || !Number.isFinite(projectId) || !Number.isFinite(mrIid)) return null;
  return {
    host: env['GITLAB_HOST'] || 'https://gitlab.com',
    token,
    projectId,
    mrIid,
  };
}

const NO_MR_CONTEXT = 'Чтение MR недоступно: не задан GITLAB_READ_TOKEN или контекст джобы.';

export async function gitlabMrInfo(env: NodeJS.ProcessEnv): Promise<ToolResult> {
  const ctx = mrContextFromEnv(env);
  if (!ctx) return fail(NO_MR_CONTEXT);
  try {
    return ok(await mrInfo(ctx));
  } catch (error) {
    return fail(`GitLab недоступен: ${describeError(error)}`);
  }
}

export async function gitlabMrNotes(env: NodeJS.ProcessEnv): Promise<ToolResult> {
  const ctx = mrContextFromEnv(env);
  if (!ctx) return fail(NO_MR_CONTEXT);
  try {
    return ok(await mrNotes(ctx));
  } catch (error) {
    return fail(`GitLab недоступен: ${describeError(error)}`);
  }
}

/**
 * Любая ссылка GitLab (задача, MR, файл, вложение). Контекст джобы не нужен — только токен,
 * поэтому работает и там, где `mrContextFromEnv` вернул бы null.
 */
export async function gitlabFetchUrl(env: NodeJS.ProcessEnv, url: unknown): Promise<ToolResult> {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return fail('Параметр "url" обязателен — ссылка GitLab или короткая ссылка (#34, !12).');
  }
  const token = env['GITLAB_READ_TOKEN'];
  if (!token) return fail('Чтение ссылок GitLab недоступно: не задан GITLAB_READ_TOKEN.');
  try {
    return ok(
      await fetchGitlabUrl(
        {
          host: env['GITLAB_HOST'] || 'https://gitlab.com',
          token,
          downloadDir: env['GITLAB_DOWNLOAD_DIR'] || join(tmpdir(), 'gitlab-files'),
          ...(env['GITLAB_PROJECT_ID'] ? { defaultProject: env['GITLAB_PROJECT_ID'] } : {}),
        },
        url,
      ),
    );
  } catch (error) {
    return fail(`Не удалось открыть ${url}: ${describeError(error)}`);
  }
}

export async function linearSearchIssues(
  config: LinearConfig,
  query: unknown,
  limit: unknown,
): Promise<ToolResult> {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return fail('Параметр "query" обязателен.');
  }
  const first = typeof limit === 'number' && Number.isFinite(limit) ? limit : 10;
  try {
    const issues = await searchLinearIssues(config, query.trim(), first);
    if (issues.length === 0) return ok(`По запросу "${query}" ничего не найдено.`);
    // В выдаче поиска — только шапки: полный текст берётся точечно через linear_get_issue.
    const lines = issues.map((i) => `- ${i.identifier}: ${i.title} (${i.url})`);
    return ok([`Найдено: ${issues.length}`, ...lines].join('\n'));
  } catch (error) {
    return fail(`Linear недоступен: ${describeError(error)}`);
  }
}
