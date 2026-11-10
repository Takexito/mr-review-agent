import type { GitlabClient } from './client.js';
import { createInlineDiscussion, type DiffRefs } from './inline.js';
import type { SpecReview, SpecItem, SpecStatus } from '../codex/parseSpec.js';
import type { Logger } from '../logger.js';
import { coverageWarning, type DiffCoverage } from './coverage.js';

const STATUS_EMOJI: Record<SpecStatus, string> = {
  met: '✅',
  violated: '❌',
  unclear: '❓',
  na: '➖',
};

export const SPEC_HEADING = '## 🤖 Codex · соответствие требованиям';
export const SPEC_NOT_RUN = 'Сверка с постановкой не запускалась.';

export function degradedLines(degraded: readonly string[] | undefined): string[] {
  return degraded && degraded.length > 0 ? ['', '> ⚠️ Неполные источники:', ...degraded.map((d) => `> - ${d}`)] : [];
}

export interface PostSpecOptions {
  /** Метки скачанных прямых целей (`#34`, `PRJ-137`). */
  readonly targets: readonly string[];
  /** Пометки о недоступных источниках — выводим под таблицей. */
  readonly degraded?: readonly string[];
  /** Путь worktree — чтобы срезать абсолютный префикс из evidence для inline-позиции. */
  readonly worktree: string;
  /** Переписывает пути worktree в blob-ссылки (для отображения evidence). */
  readonly linkify: (text: string) => string;
  /** Покрытие диффа — предупреждение об усечении в шапке (как в review). */
  readonly coverage?: DiffCoverage;
  /**
   * Индексы пунктов `items`, которым inline-тред не нужен: в общем `review` то же место
   * уже получило тред другой оси. Строка в таблице при этом остаётся.
   */
  readonly skipInline?: ReadonlySet<number>;
}

/** Экранирует содержимое ячейки Markdown-таблицы (переносы и `|`). */
function cell(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Достаёт `{ path, line }` из evidence для inline-позиции. Срезает префикс worktree. */
function evidencePosition(evidence: string, worktree: string): { path: string; line: number } | null {
  let e = evidence.trim();
  if (e.length === 0) return null;
  const prefix = worktree.endsWith('/') ? worktree : `${worktree}/`;
  if (e.startsWith(prefix)) e = e.slice(prefix.length);
  const m = /^([^\s:]+):(\d+)/.exec(e);
  if (!m) return null;
  return { path: m[1]!, line: Number(m[2]) };
}

/** Цели, на которые не ссылается ни один пункт чек-листа. */
export function uncoveredTargets(review: SpecReview, targets: readonly string[]): string[] {
  const covered = new Set(review.items.map((i) => i.target.trim().toUpperCase()));
  return targets.filter((t) => !covered.has(t.toUpperCase()));
}

export function buildSpecNote(review: SpecReview, opts: PostSpecOptions): string {
  return [SPEC_HEADING, ...specSections(review, opts)].join('\n');
}

/** Тело заметки оси без заголовка — его же вставляет сводка общего `review`. */
export function specSections(review: SpecReview, opts: PostSpecOptions): string[] {
  const counts: Record<SpecStatus, number> = { met: 0, violated: 0, unclear: 0, na: 0 };
  const lines: string[] = [];

  lines.push('', `Постановка: ${opts.targets.map((s) => `\`${s}\``).join(', ')}.`);
  const uncovered = uncoveredTargets(review, opts.targets);
  if (uncovered.length > 0) {
    lines.push(
      `> ⚠️ По целям ${uncovered.map((s) => `\`${s}\``).join(', ')} в чек-листе нет ни одного пункта — их соответствие не проверено.`,
    );
  }

  if (review.summary.trim().length > 0) {
    lines.push('', opts.linkify(review.summary.trim()));
  }

  // Предупреждение о покрытии — до таблицы: непросмотренные файлы = статусы могли не подтвердиться.
  lines.push(...coverageWarning(opts.coverage));

  if (review.items.length > 0) {
    lines.push('', '| # | Требование | Статус | Где |', '|---|---|:---:|---|');
    review.items.forEach((item, i) => {
      counts[item.status] += 1;
      const where = item.evidence.trim().length > 0 ? cell(opts.linkify(item.evidence.trim())) : '—';
      const note = item.note.trim().length > 0 ? ` — ${cell(item.note)}` : '';
      lines.push(`| ${i + 1} | ${cell(item.requirement)}${note} | ${STATUS_EMOJI[item.status]} | ${where} |`);
    });
    lines.push(
      '',
      `Итог: ${counts.met} ✅ · ${counts.violated} ❌ · ${counts.unclear} ❓ · ${counts.na} ➖`,
    );
  } else {
    lines.push('', '_Проверяемых требований не выделено._');
  }

  if (review.extras.length > 0) {
    lines.push('', '### Сверх постановки');
    for (const extra of review.extras) {
      const where = extra.evidence.trim().length > 0 ? ` — ${opts.linkify(extra.evidence.trim())}` : '';
      const note = extra.note.trim().length > 0 ? ` _${extra.note.trim()}_` : '';
      lines.push(`- ${extra.what.trim()}${where}.${note}`);
    }
  }

  lines.push(...degradedLines(opts.degraded));
  return lines;
}

/**
 * Постит чек-лист соответствия: одна заметка-таблица (статус + evidence как blob-ссылка) +
 * best-effort inline-дискуссии на каждый пункт "violated" с распознанной позицией.
 */
export async function postSpecReview(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  review: SpecReview,
  log: Logger,
  opts: PostSpecOptions,
): Promise<void> {
  await api.MergeRequestNotes.create(projectId, mrIid, buildSpecNote(review, opts));
  await placeSpecInline(api, projectId, mrIid, refs, review, log, opts);
}

/** Best-effort inline-треды на пункты "violated" с распознанной позицией; непривязанное остаётся в таблице. */
export async function placeSpecInline(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  review: SpecReview,
  log: Logger,
  opts: PostSpecOptions,
): Promise<void> {
  for (const [index, item] of review.items.entries()) {
    if (item.status !== 'violated' || opts.skipInline?.has(index)) continue;
    const pos = evidencePosition(item.evidence, opts.worktree);
    if (!pos) continue;
    const body = `❌ **Не соответствует требованию.** ${opts.linkify(item.note.trim() || '—')}\n\n> ${cell(item.requirement)}`;
    try {
      await createInlineDiscussion(api, projectId, mrIid, refs, pos, body);
    } catch (error) {
      log.warn({ path: pos.path, line: pos.line, err: String(error) }, 'spec inline discussion failed (kept in table)');
    }
  }
}
