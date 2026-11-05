import type { GitlabClient } from './client.js';
import type { Review, ReviewComment } from '../codex/parseReview.js';
import type { Logger } from '../logger.js';
import { coverageWarning, hasGaps, type DiffCoverage } from './coverage.js';
import { createInlineDiscussion, type DiffRefs } from './inline.js';

export type { DiffRefs } from './inline.js';

export const BUGS_HEADING = '## 🤖 Codex · поиск багов';

/** Больше мелких замечаний тредами не публикуем: они тонут сами и топят важное. */
export const MAX_INFO_COMMENTS = 5;

const SEVERITY_ORDER: Record<ReviewComment['severity'], number> = { blocker: 0, warn: 1, info: 2 };

export interface RankedBugs {
  readonly review: Review;
  /** Сколько info-замечаний сверх лимита не опубликовано. */
  readonly hiddenInfo: number;
}

/**
 * Сортирует по важности и срезает info сверх лимита. В общем `review` вызывать после
 * `applyDuplicates`: идентификаторы повторов указывают на исходный порядок находок.
 */
export function rankBugs(review: Review): RankedBugs {
  const sorted = [...review.comments].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const firstInfo = sorted.findIndex((c) => c.severity === 'info');
  const kept = firstInfo === -1 ? sorted : sorted.slice(0, firstInfo + MAX_INFO_COMMENTS);
  return { review: { ...review, comments: kept }, hiddenInfo: sorted.length - kept.length };
}

const SEVERITY_EMOJI: Record<ReviewComment['severity'], string> = {
  blocker: '🔴',
  warn: '🟡',
  info: '🔵',
};

function commentBody(c: ReviewComment): string {
  return `${SEVERITY_EMOJI[c.severity]} **${c.severity}** — ${c.body}`;
}

/**
 * Постит ревью: inline-дискуссии по строкам + одна summary-заметка.
 * Комментарии, чью позицию GitLab не принял, деградируют в список внутри summary.
 */
export async function postReview(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  review: Review,
  log: Logger,
  coverage?: DiffCoverage,
): Promise<void> {
  const ranked = rankBugs(review);
  const unplaced = await placeBugsInline(api, projectId, mrIid, refs, ranked.review, log);
  await api.MergeRequestNotes.create(
    projectId,
    mrIid,
    buildSummary(ranked.review, unplaced, coverage, ranked.hiddenInfo),
  );
}

/** Создаёт inline-треды замечаний; возвращает те, чью позицию GitLab не принял. */
export async function placeBugsInline(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  review: Review,
  log: Logger,
): Promise<ReviewComment[]> {
  const unplaced: ReviewComment[] = [];

  for (const c of review.comments) {
    try {
      await createInlineDiscussion(api, projectId, mrIid, refs, c, commentBody(c));
    } catch (error) {
      log.warn({ path: c.path, line: c.line, err: String(error) }, 'inline discussion failed, will fall back');
      unplaced.push(c);
    }
  }
  return unplaced;
}

/**
 * Раздел про оспоренное. Отдельным блоком в сводке и НИКОГДА inline: автор уже ответил
 * в том треде, повторный комментарий там читался бы как пререкание. Но и умолчать нельзя —
 * иначе достаточно один раз написать «так задумано», чтобы blocker исчез навсегда.
 */
function disputedSection(review: Review): string[] {
  if (review.disputed.length === 0) return [];
  const lines = ['', '### 🔁 Оспорено автором — считаю, что проблема остаётся'];
  for (const d of review.disputed) {
    const where = d.line !== undefined ? `${d.path}:${d.line}` : d.path;
    lines.push(`- \`${where}\` — ${d.body}`);
    if (d.reason.trim().length > 0) {
      lines.push(`  - _Почему довод не снимает проблему:_ ${d.reason.trim()}`);
    }
  }
  lines.push('', '_Это не новые треды: решение за автором, бот лишь не проглатывает возражение молча._');
  return lines;
}

export function buildSummary(
  review: Review,
  unplaced: ReviewComment[],
  coverage?: DiffCoverage,
  hiddenInfo = 0,
): string {
  return [BUGS_HEADING, ...bugsSections(review, unplaced, coverage, hiddenInfo)].join('\n');
}

/** Тело заметки оси без заголовка — его же вставляет сводка общего `review`. */
export function bugsSections(
  review: Review,
  unplaced: readonly ReviewComment[],
  coverage?: DiffCoverage,
  hiddenInfo = 0,
): string[] {
  const total = review.comments.length;
  const placed = total - unplaced.length;
  const lines: string[] = [];

  if (review.summary.trim().length > 0) {
    lines.push('', review.summary.trim());
  }
  // Предупреждение о покрытии — ДО вердикта: иначе «Замечаний: 0» читается как «MR чист».
  lines.push(...coverageWarning(coverage));

  lines.push('', `Замечаний: **${total}** (inline: ${placed}${unplaced.length ? `, ниже: ${unplaced.length}` : ''}).`);
  if (hiddenInfo > 0) {
    lines.push(`_Ещё мелких замечаний (info): ${hiddenInfo} — не опубликованы, чтобы не топить важное._`);
  }

  if (unplaced.length > 0) {
    lines.push('', '### Не удалось привязать к строкам');
    for (const c of unplaced) {
      lines.push(`- ${SEVERITY_EMOJI[c.severity]} \`${c.path}:${c.line}\` — ${c.body}`);
    }
  }

  lines.push(...disputedSection(review));

  if (total === 0) {
    // Когда часть файлов не просмотрена, «нет замечаний» относится ТОЛЬКО к просмотренному.
    // И «нет замечаний» не должно звучать как «чисто», пока висит оспоренное.
    const verdict = hasGaps(coverage)
      ? '_В просмотренной части замечаний нет._'
      : review.disputed.length > 0
        ? '_Новых замечаний нет — но см. раздел об оспоренном выше._'
        : '_Замечаний нет._';
    lines.push('', verdict);
  }
  return lines;
}

/** Fallback, когда JSON не распарсился: постим сырой текст одной заметкой под заголовком оси. */
export async function postRawReview(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  heading: string,
  rawText: string,
  coverage?: DiffCoverage,
): Promise<void> {
  const body = [heading, ...coverageWarning(coverage), '', rawText.trim()].join('\n');
  await api.MergeRequestNotes.create(projectId, mrIid, body);
}
