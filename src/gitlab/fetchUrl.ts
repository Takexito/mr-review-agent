import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { formatDiscussions } from './discussions.js';

export interface FetchUrlConfig {
  readonly host: string;
  readonly token: string;
  /** Куда складывать бинарные файлы (картинки) — агент открывает их как локальные. */
  readonly downloadDir: string;
  /** Проект текущего MR (id или путь) — к нему относятся короткие ссылки `#34` / `!12`. */
  readonly defaultProject?: string;
}

export type GitlabLink =
  | { readonly kind: 'issue'; readonly project: string; readonly iid: number }
  | { readonly kind: 'mr'; readonly project: string; readonly iid: number }
  | { readonly kind: 'file'; readonly project: string; readonly refAndPath: string }
  | { readonly kind: 'upload'; readonly project: string; readonly secret: string; readonly filename: string };

export class GitlabFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitlabFetchError';
  }
}

const MAX_TEXT_BYTES = 200_000;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const NOTES_PAGE_SIZE = 100;
/** Сколько сегментов пути пробуем как имя ветки: `feature/x/y` неотличима от каталогов. */
const MAX_REF_SEGMENTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const BINARY_SNIFF_BYTES = 8_000;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return String(v);
}

/** Разбирает web-ссылку GitLab. null — чужой хост или неподдерживаемый вид ссылки. */
export function parseGitlabUrl(host: string, raw: string): GitlabLink | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw.trim());
    base = new URL(host);
  } catch {
    return null;
  }
  // Токен уходит только на свой хост: ссылку в тексте задачи может написать кто угодно.
  if (url.origin !== base.origin) return null;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  const issue = /^\/(.+?)\/-\/(?:issues|work_items)\/(\d+)/.exec(path);
  if (issue) return { kind: 'issue', project: issue[1]!, iid: Number(issue[2]) };

  const mr = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(path);
  if (mr) return { kind: 'mr', project: mr[1]!, iid: Number(mr[2]) };

  const file = /^\/(.+?)\/-\/(?:blob|raw)\/(.+)$/.exec(path);
  if (file) return { kind: 'file', project: file[1]!, refAndPath: file[2]! };

  const upload = /^\/(.+?)\/uploads\/([0-9a-f]{32})\/(.+)$/.exec(path);
  if (upload) return { kind: 'upload', project: upload[1]!, secret: upload[2]!, filename: upload[3]! };

  const uploadById = /^\/-\/project\/(\d+)\/uploads\/([0-9a-f]{32})\/(.+)$/.exec(path);
  if (uploadById) {
    return { kind: 'upload', project: uploadById[1]!, secret: uploadById[2]!, filename: uploadById[3]! };
  }
  return null;
}

/**
 * Короткая ссылка GitLab: `#34`, `!12`, `group/project#34`. Без префикса проекта относится
 * к `defaultProject`; null — не короткая ссылка либо проект взять неоткуда.
 */
export function parseShortRef(raw: string, defaultProject?: string): GitlabLink | null {
  const m = /^([\w.-]+(?:\/[\w.-]+)+)?([#!])(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const project = m[1] ?? defaultProject;
  if (!project) return null;
  return { kind: m[2] === '#' ? 'issue' : 'mr', project, iid: Number(m[3]) };
}

async function request(config: FetchUrlConfig, apiPath: string): Promise<Response> {
  const origin = new URL(config.host).origin;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // Редирект обрабатываем вручную: вложения отдаются через объектное хранилище на другом
  // хосте, а fetch при автоследовании донёс бы туда и заголовок PRIVATE-TOKEN.
  const first = await fetch(`${origin}/api/v4${apiPath}`, {
    headers: { 'PRIVATE-TOKEN': config.token },
    redirect: 'manual',
    signal,
  });
  const location = first.headers.get('location');
  if (first.status >= 300 && first.status < 400 && location) {
    return fetch(new URL(location, origin), { signal });
  }
  return first;
}

async function requestOk(config: FetchUrlConfig, apiPath: string): Promise<Response> {
  const response = await request(config, apiPath);
  if (!response.ok) throw new GitlabFetchError(`GitLab ответил ${response.status} на ${apiPath}`);
  return response;
}

async function getJson(config: FetchUrlConfig, apiPath: string): Promise<unknown> {
  return (await requestOk(config, apiPath)).json();
}

/** Вложения в markdown GitLab относительные (`/uploads/…`) — делаем их открываемыми ссылками. */
function absolutizeUploads(markdown: string, projectWebUrl: string): string {
  return projectWebUrl ? markdown.replace(/\]\(\/uploads\//g, `](${projectWebUrl}/uploads/`) : markdown;
}

function projectWebUrl(entity: Record<string, unknown>): string {
  return str(entity['web_url']).split('/-/')[0] ?? '';
}

function header(entity: Record<string, unknown>, title: string): string[] {
  const labels = Array.isArray(entity['labels']) ? (entity['labels'] as unknown[]).map(str) : [];
  return [
    `# ${title}`,
    `URL: ${str(entity['web_url'])}`,
    `Автор: ${str(rec(entity['author'])['username']) || '?'}`,
    `Статус: ${str(entity['state'])}`,
    ...(labels.length > 0 ? [`Метки: ${labels.join(', ')}`] : []),
  ];
}

function body(entity: Record<string, unknown>): string {
  const description = str(entity['description']).trim();
  return description.length > 0 ? absolutizeUploads(description, projectWebUrl(entity)) : '(описание пустое)';
}

async function renderIssue(config: FetchUrlConfig, link: { project: string; iid: number }): Promise<string> {
  const base = `/projects/${encodeURIComponent(link.project)}/issues/${link.iid}`;
  const issue = rec(await getJson(config, base));
  const notes = (await getJson(config, `${base}/notes?sort=asc&per_page=${NOTES_PAGE_SIZE}`)) as unknown[];
  const webUrl = projectWebUrl(issue);

  const comments = notes
    .map(rec)
    .filter((n) => n['system'] !== true && str(n['body']).trim().length > 0)
    .map((n) => `**${str(rec(n['author'])['username']) || '?'}:** ${absolutizeUploads(str(n['body']).trim(), webUrl)}`);

  return [
    ...header(issue, `${str(issue['title'])} (#${link.iid})`),
    '',
    body(issue),
    '',
    `## Комментарии (${comments.length}${notes.length === NOTES_PAGE_SIZE ? `, показаны первые ${NOTES_PAGE_SIZE} записей` : ''})`,
    comments.length > 0 ? comments.join('\n\n') : '(нет)',
  ].join('\n');
}

async function renderMr(config: FetchUrlConfig, link: { project: string; iid: number }): Promise<string> {
  const base = `/projects/${encodeURIComponent(link.project)}/merge_requests/${link.iid}`;
  const mr = rec(await getJson(config, base));
  const diffs = (await getJson(config, `${base}/diffs?per_page=${NOTES_PAGE_SIZE}`)) as unknown[];
  const discussions = (await getJson(config, `${base}/discussions?per_page=${NOTES_PAGE_SIZE}`)) as unknown[];
  const files = diffs.map((d) => `- ${str(rec(d)['new_path'])}`);
  const threads = formatDiscussions(discussions);

  return [
    ...header(mr, `${str(mr['title'])} (!${link.iid})`),
    `Ветки: ${str(mr['source_branch'])} → ${str(mr['target_branch'])}`,
    '',
    body(mr),
    '',
    `## Изменённые файлы (${files.length}${files.length === NOTES_PAGE_SIZE ? '+' : ''})`,
    files.length > 0 ? files.join('\n') : '(нет)',
    '',
    '## Обсуждения',
    threads.length > 0 ? threads : '(нет)',
  ].join('\n');
}

function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

async function renderContent(config: FetchUrlConfig, response: Response, name: string): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!looksBinary(bytes)) {
    const text = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES));
    return bytes.length > MAX_TEXT_BYTES
      ? `${text}\n\n[обрезано: показано ${MAX_TEXT_BYTES} из ${bytes.length} байт]`
      : text;
  }
  if (bytes.length > MAX_BINARY_BYTES) {
    throw new GitlabFetchError(`Файл ${name} слишком большой (${bytes.length} байт) — не скачан.`);
  }
  await mkdir(config.downloadDir, { recursive: true });
  // Имя пришло из ссылки: basename отсекает `../`, префикс разводит одноимённые вложения.
  const target = join(config.downloadDir, `${Date.now()}-${basename(name).replace(/[^\w.-]+/g, '_')}`);
  await writeFile(target, bytes);
  const type = response.headers.get('content-type') ?? 'тип неизвестен';
  return `Бинарный файл (${type}, ${bytes.length} байт) сохранён: ${target}\nОткрой его как локальный файл (изображение — инструментом просмотра картинок).`;
}

async function renderFile(config: FetchUrlConfig, link: { project: string; refAndPath: string }): Promise<string> {
  const segments = link.refAndPath.split('/');
  const project = encodeURIComponent(link.project);
  for (let i = 1; i < segments.length && i <= MAX_REF_SEGMENTS; i += 1) {
    const ref = segments.slice(0, i).join('/');
    const path = segments.slice(i).join('/');
    const response = await request(
      config,
      `/projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
    );
    if (response.status === 404) continue;
    if (!response.ok) throw new GitlabFetchError(`GitLab ответил ${response.status} на файл ${path}@${ref}`);
    return renderContent(config, response, path);
  }
  throw new GitlabFetchError(`Файл не найден: ${link.refAndPath} (нет такого пути/ветки или нет доступа).`);
}

async function renderUpload(
  config: FetchUrlConfig,
  link: { project: string; secret: string; filename: string },
): Promise<string> {
  const response = await requestOk(
    config,
    `/projects/${encodeURIComponent(link.project)}/uploads/${link.secret}/${encodeURIComponent(link.filename)}`,
  );
  return renderContent(config, response, link.filename);
}

export async function fetchGitlabUrl(config: FetchUrlConfig, target: string): Promise<string> {
  const link = parseShortRef(target, config.defaultProject) ?? parseGitlabUrl(config.host, target);
  if (!link) {
    throw new GitlabFetchError(
      `Ссылка не поддерживается: нужен ${new URL(config.host).origin} и задача, merge request, файл (blob/raw) ` +
        'или вложение (uploads), либо короткая ссылка вида #34, !12, group/project#34.',
    );
  }
  switch (link.kind) {
    case 'issue':
      return renderIssue(config, link);
    case 'mr':
      return renderMr(config, link);
    case 'file':
      return renderFile(config, link);
    case 'upload':
      return renderUpload(config, link);
  }
}
