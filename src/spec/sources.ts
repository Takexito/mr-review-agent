import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { fetchGitlabUrl, parseGitlabUrl, parseShortRef } from '../gitlab/fetchUrl.js';
import { fetchRequirements } from '../linear/requirements.js';
import { specRefLabel, type SpecRef } from './refs.js';

/** Один источник требований. Источники равноправны: роль каждого определяет агент. */
export interface SpecSource {
  /** Как источник назван в ссылке: `#34`, `OPS-176`, URL. */
  readonly label: string;
  readonly title: string;
  readonly body: string;
}

export interface GatheredSources {
  readonly sources: readonly SpecSource[];
  /** Что не удалось подтянуть — уходит и в промпт, и в заметку MR. */
  readonly degraded: readonly string[];
}

export interface GatherContext {
  readonly config: AppConfig;
  readonly projectId: number;
  readonly projectPath: string;
  readonly downloadDir: string;
  readonly log: Logger;
}

const MAX_SOURCES = 12;
/** Спека с комментариями легко даёт 40–50 КБ; потолок страхует от задачи-простыни. */
const MAX_SOURCE_CHARS = 80_000;

function clip(text: string): string {
  return text.length > MAX_SOURCE_CHARS
    ? `${text.slice(0, MAX_SOURCE_CHARS)}\n\n[источник обрезан: показано ${MAX_SOURCE_CHARS} из ${text.length} символов — остальное дочитай сам]`
    : text;
}

/**
 * Ссылки на источники приходят из описания MR, а его пишет автор MR. Без этой проверки
 * `чужая-группа/проект#1` заставил бы бота скачать своим токеном задачу проекта, которого
 * автор не видит, и процитировать её в заметке. `PROJECT_ALLOWLIST` сюда не входит намеренно:
 * он говорит, где бот отвечает, а не что автор одного проекта вправе читать в другом.
 */
function isAllowedProject(ctx: GatherContext, target: string): boolean {
  const link = parseShortRef(target, String(ctx.projectId)) ?? parseGitlabUrl(ctx.config.gitlabHost, target);
  if (!link) return false;
  const allowed = [String(ctx.projectId), ctx.projectPath, ctx.config.docsRepoProject];
  return allowed.some((project) => project.toLowerCase() === link.project.toLowerCase());
}

async function gitlabSource(ctx: GatherContext, target: string): Promise<SpecSource | string> {
  const { config } = ctx;
  if (!isAllowedProject(ctx, target)) {
    return `Источник ${target} не скачан: он вне проекта этого MR и проекта документации.`;
  }
  const text = await fetchGitlabUrl(
    {
      host: config.gitlabHost,
      token: config.gitlabReadToken ?? config.gitlabToken,
      downloadDir: ctx.downloadDir,
      defaultProject: String(ctx.projectId),
    },
    target,
  );
  const firstLine = text.split('\n', 1)[0] ?? '';
  return { label: target, title: firstLine.replace(/^#\s*/, '') || target, body: clip(text) };
}

async function linearSource(ctx: GatherContext, key: string): Promise<SpecSource | string> {
  if (!ctx.config.linearApiKey) return `LINEAR_API_KEY не задан — задача ${key} не подтянута.`;
  const req = await fetchRequirements(ctx.config, key);
  if (!req.task) return `Задача ${key} не найдена в Linear.`;
  const parts = [req.task];
  if (req.epic) parts.push('## Родительский эпик', req.epic);
  if (req.spec) parts.push('## Привязанные документы', req.spec);
  const title = (req.task.split('\n', 1)[0] ?? key).replace(/^#+\s*/, '');
  return { label: key, title, body: clip(parts.join('\n\n')) };
}

/**
 * Скачивает источники до запуска агента. Ничего не бросает: недоступный источник —
 * строка в `degraded`, а не падение джобы.
 */
export async function gatherSpecSources(ctx: GatherContext, refs: readonly SpecRef[]): Promise<GatheredSources> {
  const sources: SpecSource[] = [];
  const degraded: string[] = [];

  for (const ref of refs.slice(0, MAX_SOURCES)) {
    const label = specRefLabel(ref);
    try {
      const result = ref.kind === 'gitlab' ? await gitlabSource(ctx, ref.target) : await linearSource(ctx, ref.key);
      if (typeof result === 'string') degraded.push(result);
      else sources.push(result);
    } catch (error) {
      ctx.log.warn({ err: String(error), source: label }, 'spec source fetch failed');
      const reason = error instanceof Error ? error.message : String(error);
      degraded.push(`Источник ${label} не открылся: ${reason}`);
    }
  }
  if (refs.length > MAX_SOURCES) {
    const rest = refs.slice(MAX_SOURCES).map(specRefLabel).join(', ');
    degraded.push(`Источников больше ${MAX_SOURCES} — не скачаны: ${rest}.`);
  }
  return { sources, degraded };
}
