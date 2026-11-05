import type { ChangedFile, DiffResult } from '../../git/diff.js';
import { normalizePath } from '../../gitlab/coverage.js';
import type { Logger } from '../../logger.js';

/** Повторный прогон агента; null — прогона не было (лимит, сбой), дочитывание прекращаем. */
export type AgentRerun = (prompt: string) => Promise<string | null>;

export interface CoverageReport {
  readonly reviewedFiles: readonly string[];
  readonly skippedFiles: readonly { path: string; reason: string }[];
}

export interface CompletionLimits {
  /** Сколько дополнительных прогонов на ось. */
  readonly runs: number;
  /** Сколько файлов в чеклисте одного прогона. */
  readonly batch: number;
}

export interface CompletionAxis<T extends CoverageReport> {
  readonly name: string;
  /** Промпт оси, в котором чеклист — только переданные файлы. */
  readonly prompt: (files: readonly ChangedFile[]) => string;
  readonly parse: (output: string) => T | null;
  readonly merge: (base: T, extra: T) => T;
}

export const FOLLOWUP_PREFACE = [
  'ДОЧИТЫВАНИЕ. Остальные файлы этого MR уже разобраны предыдущим проходом — не повторяй их.',
  'В этом проходе разбери ТОЛЬКО файлы из чеклиста ниже, каждый. Находки — только по ним.',
  '',
].join('\n');

/** Текстовые файлы диффа, которых нет в самоотчёте. */
export function unreviewedFiles(diff: DiffResult, report: CoverageReport): ChangedFile[] {
  const claimed = new Set(report.reviewedFiles.map(normalizePath));
  return diff.files.filter((f) => !f.binary && !claimed.has(normalizePath(f.path)));
}

export async function completeCoverage<T extends CoverageReport>(
  diff: DiffResult,
  first: T,
  axis: CompletionAxis<T>,
  rerun: AgentRerun | undefined,
  limits: CompletionLimits,
  jlog: Logger,
): Promise<T> {
  if (!rerun || diff.mode === 'inline') return first;

  let acc = first;
  // Файл, который агент уже получил в дочитывании и всё равно пропустил, второй раз не шлём —
  // иначе каждый прогон уходит на один и тот же отказ.
  const attempted = new Set<string>();
  for (let run = 1; run <= limits.runs; run++) {
    const batch = unreviewedFiles(diff, acc)
      .filter((f) => !attempted.has(normalizePath(f.path)))
      .slice(0, limits.batch);
    if (batch.length === 0) break;
    for (const f of batch) attempted.add(normalizePath(f.path));

    const output = await rerun(`${FOLLOWUP_PREFACE}${axis.prompt(batch)}`);
    const extra = output === null ? null : axis.parse(output);
    if (extra === null) {
      jlog.warn({ axis: axis.name, run }, 'coverage follow-up produced no report, stopping');
      break;
    }
    const before = unreviewedFiles(diff, acc).length;
    acc = axis.merge(acc, extra);
    const after = unreviewedFiles(diff, acc).length;
    jlog.info({ axis: axis.name, run, batch: batch.length, read: before - after, left: after }, 'coverage follow-up');
  }
  return acc;
}

/** Объединение самоотчётов: прочитанное в любом прогоне больше не числится пропущенным. */
export function mergeCoverage(
  base: CoverageReport,
  extra: CoverageReport,
): { reviewedFiles: string[]; skippedFiles: { path: string; reason: string }[] } {
  const reviewedFiles = [...new Set([...base.reviewedFiles, ...extra.reviewedFiles])];
  const reviewed = new Set(reviewedFiles.map(normalizePath));
  const skipped = new Map<string, { path: string; reason: string }>();
  for (const s of [...base.skippedFiles, ...extra.skippedFiles]) {
    if (!reviewed.has(normalizePath(s.path))) skipped.set(normalizePath(s.path), s);
  }
  return { reviewedFiles, skippedFiles: [...skipped.values()] };
}

/** Склейка списков находок без дублей: оба прогона могли задеть один и тот же файл. */
export function concatUnique<T>(base: readonly T[], extra: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(base.map(key));
  return [...base, ...extra.filter((item) => !seen.has(key(item)))];
}
