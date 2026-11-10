import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectorConfig } from '../config.js';
import type { ConnectorSession, OpenConnector, ToolImage } from '../connectors/mcpClient.js';
import type { Logger } from '../logger.js';
import { safeFileName } from '../util/fileName.js';
import { redactSecrets } from '../util/redact.js';
import type { DirectTarget } from './targets.js';

/** Скачанная прямая цель: ответ инструмента `prefetch` как есть. */
export interface FetchedTarget {
  readonly target: DirectTarget;
  readonly text: string;
}

export interface PrefetchResult {
  readonly fetched: readonly FetchedTarget[];
  /** Цели, которые не скачались, — для промпта и заметки. */
  readonly degraded: readonly string[];
}

export interface PrefetchDeps {
  readonly connectors: Readonly<Record<string, ConnectorConfig>>;
  readonly open: OpenConnector;
  /** Куда сохранять картинки из ответа инструмента. */
  readonly imagesDir: string;
  readonly log: Logger;
  /** На вызовы инструментов всех целей вместе с запуском серверов; картинки целей — вне его. */
  readonly timeoutMs: number;
}

function fillTemplate(template: Readonly<Record<string, string>>, target: DirectTarget): Record<string, string> {
  const values: Record<string, string> = { key: target.label, number: target.number, project: target.project };
  return Object.fromEntries(
    Object.entries(template).map(([name, value]) => [name, value.replace(/\{(key|number|project)\}/g, (_, v: string) => values[v]!)]),
  );
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

async function saveImages(images: readonly ToolImage[], target: DirectTarget, dir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const [i, image] of images.entries()) {
    const name = `${safeFileName(target.label)}-${i + 1}.${IMAGE_EXTENSIONS[image.mimeType] ?? 'bin'}`;
    const path = join(dir, name);
    await writeFile(path, Buffer.from(image.data, 'base64'));
    lines.push(`Картинка из ответа сохранена: ${path}`);
  }
  return lines;
}

/** Ключи приходят из текста MR: без потолка любой автор MR запустит сотню вызовов инструмента. */
const MAX_TARGETS = 10;
/** Ответ-ошибку пишет сервер коннектора — он уходит в заметку MR, а сервер мог процитировать в нём свой env. */
const MAX_REASON_CHARS = 500;

function reason(text: string): string {
  const clean = redactSecrets(text.trim());
  return clean.length > MAX_REASON_CHARS ? `${clean.slice(0, MAX_REASON_CHARS)}…` : clean;
}

const TIMED_OUT = Symbol('timed out');
/** Закрытие зависшего сервера тоже может зависнуть — дольше джобу не держим. */
const CLOSE_TIMEOUT_MS = 5_000;

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorReason(error: unknown): string {
  return reason(error instanceof Error ? error.message : String(error));
}

/** Скачивает прямые цели как MCP-клиент коннектора. Ничего не бросает: нескачавшаяся цель — строка в `degraded`. */
export async function prefetchTargets(targets: readonly DirectTarget[], deps: PrefetchDeps): Promise<PrefetchResult> {
  const fetched: FetchedTarget[] = [];
  const degraded: string[] = [];
  // Ошибка подключения запоминается, чтобы не запускать упавший сервер заново на каждую цель.
  const sessions = new Map<string, Promise<ConnectorSession>>();
  const session = (name: string): Promise<ConnectorSession> => {
    let opened = sessions.get(name);
    if (!opened) {
      opened = deps.open({ name, config: deps.connectors[name]! });
      opened.catch(() => undefined);
      sessions.set(name, opened);
    }
    return opened;
  };

  if (targets.length > MAX_TARGETS) {
    degraded.push(`Прямых целей больше ${MAX_TARGETS} — не скачаны: ${targets.slice(MAX_TARGETS).map((t) => t.label).join(', ')}.`);
  }
  const deadline = Date.now() + deps.timeoutMs;
  const queue = targets.slice(0, MAX_TARGETS);
  try {
    for (const [index, target] of queue.entries()) {
      const rule = deps.connectors[target.connector]?.prefetch;
      const fail = (why: string): void => {
        degraded.push(`Цель ${target.label} не скачалась (${target.connector}): ${why}`);
      };
      if (!rule) {
        fail('у коннектора нет правила prefetch');
        continue;
      }
      try {
        const call = session(target.connector).then((s) => s.call(rule.tool, fillTemplate(rule.arguments, target)));
        call.catch(() => undefined);
        const result = await within(call, Math.max(0, deadline - Date.now()));
        if (result === TIMED_OUT) {
          const rest = queue.slice(index).map((t) => t.label);
          deps.log.warn({ targets: rest, timeoutMs: deps.timeoutMs }, 'target prefetch time limit reached');
          degraded.push(`Не скачаны: ${rest.join(', ')} — истёк общий лимит предзагрузки (${Math.round(deps.timeoutMs / 1000)} с).`);
          break;
        }
        if (result.isError) {
          fail(reason(result.text) || `инструмент ${rule.tool} вернул ошибку`);
          continue;
        }
        if (result.text.trim().length === 0 && result.images.length === 0) {
          fail(`пустой ответ инструмента ${rule.tool}`);
          continue;
        }
        const images = await saveImages(result.images, target, deps.imagesDir);
        fetched.push({ target, text: [result.text, ...images].join('\n\n') });
      } catch (error) {
        deps.log.warn({ target: target.label, connector: target.connector, err: errorReason(error) }, 'target prefetch failed');
        fail(errorReason(error));
      }
    }
  } finally {
    // Цепочка `then(close)` живёт и после `within`: сервер, поднявшийся позже, всё равно закроется.
    await Promise.all(
      [...sessions.values()].map((opened) => within(opened.then((s) => s.close()), CLOSE_TIMEOUT_MS).catch(() => undefined)),
    );
  }
  return { fetched, degraded };
}
