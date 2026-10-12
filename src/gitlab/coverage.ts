/**
 * Покрытие диффа: сколько бот реально увидел.
 *
 * Зачем отдельный модуль. Раньше факт усечения (`MAX_DIFF_BYTES`) уходил ТОЛЬКО в промпт,
 * а заметка в MR его не несла — шапка писала «Замечаний: 0», даже когда агент видел меньше
 * половины изменений. Со стороны это неотличимо от «диф чистый», то есть бот выдавал
 * ложную уверенность ровно там, где был наименее компетентен.
 *
 * Поэтому предупреждение живёт здесь и подмешивается ВСЕМИ путями постинга (review, spec,
 * raw-fallback): добавится четвёртый путь — он либо позовёт это, либо явно решит не звать.
 *
 * Усечения по байтам больше нет (см. `git/diff.ts`): большой дифф агент читает пофайлово
 * сам. Поэтому покрытие теперь считается не в процентах байт, а по файлам — из самоотчёта
 * агента (`reviewedFiles`/`skippedFiles`), сверенного с фактическим списком изменённых.
 */

import type { DiffMode } from '../git/diff.js';

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface DiffCoverage {
  readonly mode: DiffMode;
  /** Что реально изменено в MR (из `git diff --numstat`). */
  readonly changedFiles: readonly string[];
  /** Что агент заявил как просмотренное. Заявке верим только на пересечении с changedFiles. */
  readonly reviewedFiles: readonly string[];
  readonly skippedFiles: readonly SkippedFile[];
}

/** Пути от git и от агента приходят в разной форме — сводим к одному виду. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^[ab]\//, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

interface Gaps {
  readonly total: number;
  readonly reviewed: number;
  readonly missed: readonly string[];
}

function computeGaps(coverage: DiffCoverage): Gaps {
  const changed = coverage.changedFiles.map(normalizePath).filter((p) => p.length > 0);
  const claimed = new Set(coverage.reviewedFiles.map(normalizePath));
  const missed = changed.filter((p) => !claimed.has(p));
  return { total: changed.length, reviewed: changed.length - missed.length, missed };
}

/**
 * Есть ли непросмотренные файлы. Отдельный предикат, потому что по нему смягчается
 * не только предупреждение, но и формулировка вердикта в шапке (`postReview`).
 */
export function hasGaps(coverage: DiffCoverage | undefined): boolean {
  if (!coverage || coverage.mode === 'inline') return false;
  return computeGaps(coverage).missed.length > 0;
}

/** Сколько путей показываем списком, прежде чем схлопнуть в «и ещё N». */
const MAX_LISTED = 15;

/**
 * Строки для заметки, либо пустой массив, когда предупреждать не о чем.
 * Возвращает именно массив, чтобы вызывающий вставил блок в нужное место своей разметки.
 */
export function coverageWarning(coverage: DiffCoverage | undefined): string[] {
  // inline — тело диффа уехало в промпт целиком, покрытие полное по построению.
  if (!coverage || coverage.mode === 'inline') return [];

  const { total, reviewed, missed } = computeGaps(coverage);
  if (total === 0) return [];

  if (missed.length === 0) {
    return [
      '',
      `> ℹ️ Дифф большой — агент читал его пофайлово из репозитория; просмотрено ${reviewed}/${total} файлов.`,
    ];
  }

  // Агент вообще не отчитался — худший случай, доверия к «замечаний нет» нет никакого.
  const silent = coverage.reviewedFiles.length === 0;
  const lines = [
    '',
    silent
      ? '> ⚠️ **Агент не отчитался о покрытии — полнота ревью не подтверждена.**'
      : `> ⚠️ **Ревью неполное: просмотрено ${reviewed}/${total} файлов.**`,
  ];

  if (!silent) {
    const shown = missed.slice(0, MAX_LISTED);
    lines.push('> Не просмотрены:');
    for (const path of shown) {
      const reason = coverage.skippedFiles.find((s) => normalizePath(s.path) === path)?.reason;
      lines.push(`> - \`${path}\`${reason ? ` — ${reason}` : ''}`);
    }
    if (missed.length > shown.length) {
      lines.push(`> - …и ещё ${missed.length - shown.length}`);
    }
  }

  lines.push(
    '> Отсутствие замечаний ниже относится только к просмотренной части и **не означает, что MR чист**.',
    '> Ревью большого MR стоит либо разбить на части, либо поднять `MAX_DIFF_BYTES`/`MAX_DIFF_LINES`.',
  );
  return lines;
}
