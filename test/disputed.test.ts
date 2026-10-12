import { describe, expect, it } from 'vitest';
import { buildSummary } from '../src/gitlab/postReview.js';
import { buildReviewPrompt } from '../src/codex/prompts.js';
import { buildSpecPrompt } from '../src/codex/specPrompt.js';
import { parseReviewOutput } from '../src/codex/parseReview.js';
import { REVIEW_BEGIN, REVIEW_END } from '../src/codex/prompts.js';

/**
 * Раньше промпт велел безусловно уступать: «Если автор ответил, что это намеренно —
 * уважай и не поднимай». Значит, одной фразы «так задумано» хватало, чтобы blocker
 * исчез навсегда — каждое ревью стартует с нуля и памяти о правомерности отказа нет.
 * Теперь довод автора проверяется, а непроверенное возражение не проглатывается молча.
 */

const REVIEW_BASE = {
  projectPath: 'acme/android-app',
  sourceBranch: 'feature',
  targetBranch: 'develop',
  diffMode: 'inline' as const,
  diff: 'diff',
};

const THREADS = '[A.kt:42]\n  codex_bot: 🔴 тут NPE\n  bob: так задумано, список непустой';

const EMPTY_REVIEW = {
  summary: '',
  comments: [],
  disputed: [],
  reviewedFiles: [],
  skippedFiles: [],
};

describe('review-промпт: проверка доводов автора', () => {
  const prompt = buildReviewPrompt({ ...REVIEW_BASE, existingThreads: THREADS });

  it('требует проверить «уже починил» по коду, а не верить на слово', () => {
    expect(prompt).toContain('ПРОВЕРЬ по текущему коду');
    expect(prompt).toContain('Правки нет → подними снова');
  });

  it('запрещает принимать «так задумано» на веру', () => {
    expect(prompt).toContain('не принимай');
    expect(prompt).toContain('проверь сам аргумент');
    // Старая безусловная формулировка не должна вернуться.
    expect(prompt).not.toContain('уважай и не поднимай');
  });

  it('направляет непроверенное возражение в disputed, а не в новый тред', () => {
    expect(prompt).toContain('"disputed"');
    expect(prompt).toContain('отдельный раздел сводки, а не новый тред');
  });

  it('оставляет молчание допустимым исходом, чтобы не провоцировать спор', () => {
    expect(prompt).toContain('Не спорь ради спора');
  });

  it('не показывает поле disputed, когда обсуждений ещё нет', () => {
    const fresh = buildReviewPrompt(REVIEW_BASE);

    expect(fresh).not.toContain('disputed');
  });
});

describe('spec-промпт: ответ автора — довод, а не приговор', () => {
  it('велит оставлять violated, если довод не снимает несоответствие', () => {
    const prompt = buildSpecPrompt({
      ...REVIEW_BASE,
      diffMode: 'inline',
      diff: 'd',
      existingThreads: THREADS,
      sources: [],
      sourcesOrigin: 'mr',
    });

    expect(prompt).toContain('довод, а не приговор');
    expect(prompt).toContain('оставляй');
    expect(prompt).toContain('"violated"');
  });
});

describe('парсинг disputed', () => {
  function parse(body: string) {
    return parseReviewOutput(`${REVIEW_BEGIN}\n${body}\n${REVIEW_END}`);
  }

  it('читает disputed, когда агент его вернул', () => {
    const result = parse(
      JSON.stringify({
        summary: 's',
        comments: [],
        disputed: [{ path: 'A.kt', line: 42, body: 'NPE остаётся', reason: 'список пуст при старте' }],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.disputed).toHaveLength(1);
    expect(result.review.disputed[0]!.reason).toContain('список пуст');
  });

  it('не ломается, когда disputed отсутствует', () => {
    const result = parse(JSON.stringify({ summary: 's', comments: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.disputed).toEqual([]);
  });

  it('допускает disputed без номера строки', () => {
    const result = parse(
      JSON.stringify({ summary: 's', comments: [], disputed: [{ path: 'A.kt', body: 'проблема' }] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.disputed[0]!.line).toBeUndefined();
  });
});

describe('summary-заметка с оспоренным', () => {
  const withDisputed = {
    ...EMPTY_REVIEW,
    summary: 'Новых проблем нет.',
    disputed: [
      { path: 'A.kt', line: 42, body: 'NPE при пустом списке', reason: 'список пуст на холодном старте' },
    ],
  };

  it('печатает отдельный раздел, а не новый inline-тред', () => {
    const note = buildSummary(withDisputed, []);

    expect(note).toContain('Оспорено автором');
    expect(note).toContain('`A.kt:42`');
    expect(note).toContain('Почему довод не снимает проблему');
    expect(note).toContain('Это не новые треды');
  });

  it('не даёт прочитать «замечаний нет» как «всё чисто», пока висит оспоренное', () => {
    const note = buildSummary(withDisputed, []);

    expect(note).not.toContain('_Замечаний нет._');
    expect(note).toContain('см. раздел об оспоренном выше');
  });

  it('молчит, когда оспоренного нет', () => {
    const note = buildSummary({ ...EMPTY_REVIEW, summary: 'Чисто.' }, []);

    expect(note).not.toContain('Оспорено автором');
    expect(note).toContain('_Замечаний нет._');
  });

  it('обходится без строки причины, если агент её не дал', () => {
    const note = buildSummary(
      { ...EMPTY_REVIEW, disputed: [{ path: 'A.kt', body: 'проблема', reason: '' }] },
      [],
    );

    expect(note).toContain('`A.kt` — проблема');
    expect(note).not.toContain('Почему довод');
  });
});
