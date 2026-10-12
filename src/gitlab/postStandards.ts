import type { GitlabClient } from './client.js';
import type { StandardsReview, Violation } from '../codex/parseStandards.js';
import type { Logger } from '../logger.js';
import { coverageWarning, hasGaps, type DiffCoverage } from './coverage.js';
import { createInlineDiscussion, type DiffRefs } from './inline.js';

export const STANDARDS_HEADING = '## 🤖 Codex · стандарты';

function violationBody(v: Violation): string {
  return [
    `📏 **Стандарт:** ${v.standard}`,
    '',
    `> ${v.quote.trim().replace(/\r?\n+/g, ' ')}`,
    '',
    v.body,
    '',
    `_В проекте соблюдено, например: ${v.precedent.trim()}_`,
  ].join('\n');
}

export function buildStandardsNote(
  review: StandardsReview,
  unplaced: readonly Violation[],
  coverage?: DiffCoverage,
): string {
  return [STANDARDS_HEADING, ...standardsSections(review, unplaced, coverage)].join('\n');
}

/** Тело заметки оси без заголовка — его же вставляет сводка общего `review`. */
export function standardsSections(
  review: StandardsReview,
  unplaced: readonly Violation[],
  coverage?: DiffCoverage,
): string[] {
  const total = review.violations.length;
  const lines: string[] = [];

  if (review.summary.trim().length > 0) lines.push('', review.summary.trim());
  lines.push(...coverageWarning(coverage));

  lines.push(
    '',
    review.standardsRead.length > 0
      ? `Сверено с: ${review.standardsRead.map((s) => `\`${s}\``).join(', ')}.`
      : '_Документов со стандартами агент не нашёл — проверен только базовый набор запахов._',
  );

  const placed = total - unplaced.length;
  lines.push('', `Нарушений стандартов: **${total}** (inline: ${placed}${unplaced.length ? `, ниже: ${unplaced.length}` : ''}).`);
  if (unplaced.length > 0) {
    lines.push('', '### Не удалось привязать к строкам');
    for (const v of unplaced) lines.push(`- \`${v.path}:${v.line}\` — **${v.standard}** — ${v.body}`);
  }

  if (review.smells.length > 0) {
    lines.push('', '### Возможные запахи');
    for (const s of review.smells) {
      const where = s.line !== undefined ? `${s.path}:${s.line}` : s.path;
      lines.push(`- **${s.smell}** \`${where}\` — ${s.body}`);
    }
    lines.push('', '_Запахи — оценочные суждения, не нарушения: решение за автором._');
  }

  lines.push(...deadLettersSection(review));
  if (review.unproven.length > 0) {
    lines.push('', `_Отброшено записей без цитаты требования или примера в проекте: ${review.unproven.length}._`);
  }

  if (total === 0 && review.smells.length === 0) {
    lines.push('', hasGaps(coverage) ? '_В просмотренной части находок нет._' : '_Находок нет._');
  }
  return lines;
}

/** Устаревшие документы — в сводку: это вопрос к стандартам проекта, а не к автору MR. */
function deadLettersSection(review: StandardsReview): string[] {
  if (review.deadLetters.length === 0) return [];
  return [
    '',
    '### Стандарты, которым проект не следует',
    ...review.deadLetters.map((d) => `- **${d.standard}**${d.note.trim() ? ` — ${d.note.trim()}` : ''}`),
    '',
    '_К этому MR претензий нет: документ расходится с тем, как проект устроен на самом деле._',
  ];
}

/**
 * Нарушения задокументированных правил — inline-тредами (не принятая GitLab позиция
 * деградирует в список сводки); запахи — только в сводке, тредами они были бы шумом.
 */
export async function postStandards(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  review: StandardsReview,
  log: Logger,
  coverage?: DiffCoverage,
): Promise<void> {
  const unplaced = await placeViolationsInline(api, projectId, mrIid, refs, review, log);
  await api.MergeRequestNotes.create(projectId, mrIid, buildStandardsNote(review, unplaced, coverage));
}

/** Создаёт inline-треды нарушений; возвращает те, чью позицию GitLab не принял. */
export async function placeViolationsInline(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  review: StandardsReview,
  log: Logger,
): Promise<Violation[]> {
  const unplaced: Violation[] = [];
  for (const v of review.violations) {
    try {
      await createInlineDiscussion(api, projectId, mrIid, refs, v, violationBody(v));
    } catch (error) {
      log.warn({ path: v.path, line: v.line, err: String(error) }, 'inline discussion failed, will fall back');
      unplaced.push(v);
    }
  }
  return unplaced;
}
