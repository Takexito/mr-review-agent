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

function reason(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
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

  try {
    for (const target of targets) {
      const rule = deps.connectors[target.connector]?.prefetch;
      const fail = (why: string): void => {
        degraded.push(`Цель ${target.label} не скачалась (${target.connector}): ${why}`);
      };
      if (!rule) {
        fail('у коннектора нет правила prefetch');
        continue;
      }
      try {
        const result = await (await session(target.connector)).call(rule.tool, fillTemplate(rule.arguments, target));
        if (result.isError) {
          fail(result.text.trim() || `инструмент ${rule.tool} вернул ошибку`);
          continue;
        }
        if (result.text.trim().length === 0 && result.images.length === 0) {
          fail(`пустой ответ инструмента ${rule.tool}`);
          continue;
        }
        const images = await saveImages(result.images, target, deps.imagesDir);
        fetched.push({ target, text: [result.text, ...images].join('\n\n') });
      } catch (error) {
        deps.log.warn({ target: target.label, connector: target.connector, err: reason(error) }, 'target prefetch failed');
        fail(reason(error));
      }
    }
  } finally {
    for (const opened of sessions.values()) {
      await opened.then((s) => s.close()).catch(() => undefined);
    }
  }
  return { fetched, degraded };
}
