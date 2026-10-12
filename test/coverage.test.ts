import { describe, expect, it } from 'vitest';
import { coverageWarning, hasGaps, normalizePath, type DiffCoverage } from '../src/gitlab/coverage.js';
import { buildSummary } from '../src/gitlab/postReview.js';
import { buildReviewPrompt } from '../src/codex/prompts.js';

/**
 * Регрессия: неполнота ревью была видна только внутри промпта, а заметка в MR её не несла.
 * На MR !29 android-app (дифф 445 КБ при лимите 200 КБ) бот увидел ~45% изменений и
 * отрапортовал «Замечаний: 0» — со стороны неотличимо от «MR чист».
 *
 * Усечения по байтам больше нет: большой дифф агент читает пофайлово сам. Но инвариант
 * тот же — «замечаний нет» не должно читаться как «MR чист», пока часть файлов не смотрели.
 */

const CHANGED = ['app/A.kt', 'app/B.kt', 'app/C.kt'];

function coverage(over: Partial<DiffCoverage> = {}): DiffCoverage {
  return {
    mode: 'agentic',
    changedFiles: CHANGED,
    reviewedFiles: CHANGED,
    skippedFiles: [],
    ...over,
  };
}

describe('normalizePath', () => {
  it('should strip diff prefixes when git-style path is given', () => {
    expect(normalizePath('a/app/A.kt')).toBe('app/A.kt');
    expect(normalizePath('b/app/A.kt')).toBe('app/A.kt');
  });

  it('should strip leading dot-slash and quotes when agent quotes the path', () => {
    expect(normalizePath('"./app/A.kt"')).toBe('app/A.kt');
    expect(normalizePath('  /app/A.kt ')).toBe('app/A.kt');
  });
});

describe('покрытие диффа', () => {
  it('молчит, когда дифф ушёл в промпт целиком', () => {
    expect(coverageWarning({ ...coverage(), mode: 'inline' })).toEqual([]);
    expect(coverageWarning(undefined)).toEqual([]);
  });

  it('подтверждает полный обход, когда агент прочитал все файлы', () => {
    const text = coverageWarning(coverage()).join('\n');

    expect(text).toContain('просмотрено 3/3');
    // Это не предупреждение — вердикт ниже читать можно как есть.
    expect(text).not.toContain('не означает, что MR чист');
  });

  it('называет непросмотренные файлы, когда обход неполный', () => {
    const text = coverageWarning(
      coverage({
        reviewedFiles: ['app/A.kt'],
        skippedFiles: [{ path: 'app/C.kt', reason: 'кончился бюджет' }],
      }),
    ).join('\n');

    expect(text).toContain('просмотрено 1/3');
    expect(text).toContain('app/B.kt');
    expect(text).toContain('app/C.kt');
    expect(text).toContain('кончился бюджет');
    // Главное: вердикт нельзя читать как «чисто».
    expect(text).toContain('не означает, что MR чист');
  });

  it('сверяет заявку агента с фактическим диффом, а не верит на слово', () => {
    // Агент «прочитал» файл, которого в диффе нет — покрытие от этого не растёт.
    const text = coverageWarning(
      coverage({ reviewedFiles: ['app/A.kt', 'app/B.kt', 'app/C.kt', 'app/Ghost.kt'] }),
    ).join('\n');

    expect(text).toContain('просмотрено 3/3');
    expect(text).not.toContain('Ghost');
  });

  it('различает пути, отличающиеся только diff-префиксом', () => {
    const text = coverageWarning(coverage({ reviewedFiles: ['b/app/A.kt', './app/B.kt', 'app/C.kt'] })).join('\n');

    expect(text).toContain('просмотрено 3/3');
  });

  it('отдельно помечает случай, когда агент вообще не отчитался', () => {
    const text = coverageWarning(coverage({ reviewedFiles: [] })).join('\n');

    expect(text).toContain('не отчитался о покрытии');
    expect(text).toContain('не означает, что MR чист');
  });

  it('схлопывает длинный список непросмотренных', () => {
    const many = Array.from({ length: 40 }, (_, i) => `app/F${i}.kt`);
    const text = coverageWarning(coverage({ changedFiles: many, reviewedFiles: [] })).join('\n');

    expect(text).toContain('не отчитался');
    // Полотно из 40 путей в заметку не лезет.
    expect(text.split('\n').length).toBeLessThan(20);
  });

  it('не падает на пустом диффе', () => {
    expect(coverageWarning(coverage({ changedFiles: [], reviewedFiles: [] }))).toEqual([]);
  });
});

describe('hasGaps', () => {
  it('should be false when mode is inline', () => {
    expect(hasGaps({ ...coverage({ reviewedFiles: [] }), mode: 'inline' })).toBe(false);
  });

  it('should be false when every changed file was reviewed', () => {
    expect(hasGaps(coverage())).toBe(false);
  });

  it('should be true when some files were not reviewed', () => {
    expect(hasGaps(coverage({ reviewedFiles: ['app/A.kt'] }))).toBe(true);
  });

  it('should be false when coverage is missing', () => {
    expect(hasGaps(undefined)).toBe(false);
  });
});

describe('summary-заметка в MR', () => {
  const clean = {
    summary: 'Проблем не найдено.',
    comments: [],
    disputed: [],
    reviewedFiles: [],
    skippedFiles: [],
  };

  it('при неполном обходе не даёт прочитать «0 замечаний» как «MR чист»', () => {
    const note = buildSummary(clean, [], coverage({ reviewedFiles: ['app/A.kt'] }));

    // Это и есть исходный баг: раньше заметка молчала про неполноту.
    expect(note).toContain('Ревью неполное');
    expect(note).toContain('не означает, что MR чист');
    // Предупреждение должно стоять ДО вердикта, иначе читатель уже сделал вывод.
    expect(note.indexOf('неполное')).toBeLessThan(note.indexOf('Замечаний:'));
    // И сам вердикт формулируется осторожнее.
    expect(note).toContain('В просмотренной части замечаний нет');
  });

  it('на полном обходе говорит прямо и без оговорок', () => {
    const note = buildSummary(clean, [], coverage());

    expect(note).not.toContain('не означает, что MR чист');
    expect(note).toContain('_Замечаний нет._');
  });

  it('на inline-диффе не пишет про покрытие вовсе', () => {
    const note = buildSummary(clean, [], { ...coverage(), mode: 'inline' });

    expect(note).not.toContain('просмотрено');
    expect(note).toContain('_Замечаний нет._');
  });
});

describe('review-промпт в agentic-режиме', () => {
  const base = {
    projectPath: 'acme/android-app',
    sourceBranch: 'feature',
    targetBranch: 'develop',
  };

  it('отдаёт полный diffstat и чеклист файлов вместо тела диффа', () => {
    const prompt = buildReviewPrompt({
      ...base,
      diffMode: 'agentic',
      diff: '',
      diffStat: ' A.kt | 2 +-\n B.kt | 8 ++++----\n 2 files changed',
      files: [
        { path: 'A.kt', added: 1, deleted: 1, binary: false },
        { path: 'B.kt', added: 4, deleted: 4, binary: false },
      ],
      baseSha: 'aaa111',
      headSha: 'bbb222',
    });

    // Состав изменения виден целиком — агент не может не знать про B.kt.
    expect(prompt).toContain('B.kt');
    expect(prompt).toContain('2 files changed');
    expect(prompt).toContain('ЧЕКЛИСТ — 2 изменённых файлов');
    expect(prompt).not.toContain('```diff');
  });

  it('велит прочитать дифф самому и назвать точную команду', () => {
    const prompt = buildReviewPrompt({
      ...base,
      diffMode: 'agentic',
      diff: '',
      diffStat: ' A.kt | 2 +-',
      files: [{ path: 'A.kt', added: 1, deleted: 1, binary: false }],
      baseSha: 'aaa111',
      headSha: 'bbb222',
    });

    expect(prompt).toContain('git diff aaa111..bbb222 -- <файл>');
    // Старая формулировка прямо разрешала ревьюить только присланное — она и породила баг.
    expect(prompt).not.toContain('ревьюй только присланную часть');
  });

  it('требует самоотчёт о покрытии только когда агент ходит по диффу сам', () => {
    const agentic = buildReviewPrompt({
      ...base,
      diffMode: 'agentic',
      diff: '',
      files: [{ path: 'A.kt', added: 1, deleted: 1, binary: false }],
    });
    const inline = buildReviewPrompt({
      ...base,
      diffMode: 'inline',
      diff: 'diff --git a/A.kt b/A.kt\n+val a = 1\n',
    });

    expect(agentic).toContain('reviewedFiles');
    expect(agentic).toContain('skippedFiles');
    expect(inline).not.toContain('reviewedFiles');
  });

  it('на inline-диффе кладёт тело в промпт и не шумит про самостоятельное чтение', () => {
    const prompt = buildReviewPrompt({
      ...base,
      diffMode: 'inline',
      diff: 'diff --git a/A.kt b/A.kt\n+val a = 1\n',
    });

    expect(prompt).toContain('```diff');
    expect(prompt).toContain('+val a = 1');
    expect(prompt).not.toContain('ДИФФ НЕ ПРИЛОЖЕН');
  });

  it('помечает бинарные файлы в чеклисте, чтобы агент не искал в них строки', () => {
    const prompt = buildReviewPrompt({
      ...base,
      diffMode: 'agentic',
      diff: '',
      files: [{ path: 'logo.png', added: 0, deleted: 0, binary: true }],
    });

    expect(prompt).toContain('logo.png (binary)');
  });
});
