import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { safeFileName } from '../util/fileName.js';

export interface ImageDownloadConfig {
  readonly host: string;
  readonly token: string;
  readonly dir: string;
  /** Проект, к которому относятся относительные ссылки `/uploads/…` в тексте. */
  readonly project: string;
  /** См. `KindContext.allowedProjects`. */
  readonly allowedProjects: readonly string[];
  /** Префикс имён файлов: разводит картинки описания MR и разных целей. */
  readonly prefix: string;
  readonly attachments?: ConnectorAttachments | undefined;
}

export interface ConnectorAttachments {
  readonly hosts: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}

export interface SavedImage {
  readonly url: string;
  readonly path: string;
}

export interface ImageDownloads {
  readonly saved: readonly SavedImage[];
  readonly failed: readonly string[];
  /** Картинки чужих хостов и проектов вне профиля: не скачиваются. */
  readonly foreign: number;
}

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

interface UploadLink {
  readonly project: string;
  readonly secret: string;
  readonly filename: string;
}

function parseUpload(raw: string, host: string, project: string): UploadLink | 'foreign' | null {
  const relative = /^\/uploads\/([0-9a-f]{32})\/(.+)$/.exec(raw);
  if (relative) return { project, secret: relative[1]!, filename: relative[2]! };
  let url: URL;
  let base: URL;
  try {
    url = new URL(raw);
    base = new URL(host);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return /^https?:$/.test(url.protocol) ? 'foreign' : null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const byPath = /^\/(.+?)\/uploads\/([0-9a-f]{32})\/(.+)$/.exec(path);
  if (byPath) return { project: byPath[1]!, secret: byPath[2]!, filename: byPath[3]! };
  // `/-/project/<id>/uploads/…` проверить по пути проекта нельзя — считаем чужой.
  if (/^\/-\/project\/\d+\/uploads\//.test(path)) return 'foreign';
  return null;
}

/** Что и с какими заголовками скачать; `url` — как ссылка записана в тексте. */
interface Download {
  readonly url: string;
  readonly fetchUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly filename: string;
}

/**
 * Только https, точное совпадение хоста и порт по умолчанию: иначе заголовки коннектора ушли бы в
 * открытом виде или чужому сервису. Свой GitLab — никогда: его вложения проходят проверку проекта.
 */
function attachmentDownload(raw: string, config: ImageDownloadConfig): Download | null {
  const { attachments } = config;
  if (!attachments) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || !attachments.hosts.includes(url.hostname)) return null;
  if (url.hostname === new URL(config.host).hostname) return null;
  let filename: string;
  try {
    filename = basename(decodeURIComponent(url.pathname)) || 'attachment';
  } catch {
    return null;
  }
  return { url: raw, fetchUrl: url.href, headers: attachments.headers, filename };
}

function uploadDownload(url: string, link: UploadLink, config: ImageDownloadConfig): Download {
  const origin = new URL(config.host).origin;
  const apiPath = `/projects/${encodeURIComponent(link.project)}/uploads/${link.secret}/${encodeURIComponent(link.filename)}`;
  return { url, fetchUrl: `${origin}/api/v4${apiPath}`, headers: { 'PRIVATE-TOKEN': config.token }, filename: link.filename };
}

async function request(download: Download): Promise<Response> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // Вложения отдаются через объектное хранилище на другом хосте: при автоследовании
  // редиректа fetch донёс бы туда и заголовок с токеном.
  const first = await fetch(download.fetchUrl, { headers: { ...download.headers }, redirect: 'manual', signal });
  const location = first.headers.get('location');
  if (first.status >= 300 && first.status < 400 && location) {
    return fetch(new URL(location, download.fetchUrl), { signal });
  }
  return first;
}

function imageUrls(markdown: string): string[] {
  const urls = [...markdown.matchAll(MARKDOWN_IMAGE_RE), ...markdown.matchAll(HTML_IMAGE_RE)].map((m) => m[1]!);
  return [...new Set(urls)];
}

/** Скачивает картинки-вложения своего GitLab, на которые ссылается markdown. Ничего не бросает. */
export async function downloadImages(markdown: string, config: ImageDownloadConfig): Promise<ImageDownloads> {
  const saved: SavedImage[] = [];
  const failed: string[] = [];
  let foreign = 0;
  const uploads: Download[] = [];
  for (const url of imageUrls(markdown)) {
    const attachment = attachmentDownload(url, config);
    if (attachment) {
      uploads.push(attachment);
      continue;
    }
    const link = parseUpload(url, config.host, config.project);
    if (link === 'foreign' || (link && !config.allowedProjects.includes(link.project))) foreign += 1;
    else if (link) uploads.push(uploadDownload(url, link, config));
  }
  if (uploads.length > MAX_IMAGES) {
    failed.push(`картинок больше ${MAX_IMAGES} — скачаны первые ${MAX_IMAGES}`);
  }

  for (const [i, download] of uploads.slice(0, MAX_IMAGES).entries()) {
    const { url } = download;
    try {
      const response = await request(download);
      if (!response.ok) {
        failed.push(`${url}: сервер ответил ${response.status}`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) {
        failed.push(`${url}: больше ${MAX_IMAGE_BYTES} байт`);
        continue;
      }
      await mkdir(config.dir, { recursive: true });
      // Префикс и номер разводят одноимённые вложения.
      const path = join(config.dir, `${config.prefix}-${i + 1}-${safeFileName(basename(download.filename))}`);
      await writeFile(path, bytes);
      saved.push({ url, path });
    } catch (error) {
      failed.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { saved, failed, foreign };
}

/** Строки для промпта: где лежит каждая скачанная картинка. */
export function imageHint(what: string, downloads: ImageDownloads): string[] {
  return downloads.saved.map((s) => `Картинка из ${what} (${s.url}) сохранена: \`${s.path}\` — открой её как локальный файл.`);
}

/** Пометки для `degraded`: агент не увидит этих картинок. */
export function imageDegraded(what: string, downloads: ImageDownloads): string[] {
  const lines = downloads.failed.map((f) => `Картинка из ${what} не скачалась: ${f}`);
  if (downloads.foreign > 0) {
    lines.push(`Картинок из ${what} с чужих хостов или из проектов вне профиля: ${downloads.foreign} — бот их не скачивает, агенту они недоступны.`);
  }
  return lines;
}
