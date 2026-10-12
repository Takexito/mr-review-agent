import { describe, it, expect } from 'vitest';
import { buildStandardsPrompt, STANDARDS_BEGIN, STANDARDS_END } from '../src/codex/standardsPrompt.js';
import { parseStandardsOutput } from '../src/codex/parseStandards.js';
import { buildStandardsNote } from '../src/gitlab/postStandards.js';

function parse(json: unknown) {
  const parsed = parseStandardsOutput(`шум\n${STANDARDS_BEGIN}\n${JSON.stringify(json)}\n${STANDARDS_END}`);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.review;
}

const VIOLATION = {
  path: 'A.kt',
  line: 4,
  standard: 'AGENTS.md › Critical Rules › 1',
  quote: 'CustomTheme, NOT MaterialTheme',
  precedent: 'features/B.kt:10',
  body: 'MaterialTheme вместо CustomTheme',
};
const SMELL = { smell: 'Feature Envy', path: 'B.kt', line: 9, body: 'возможно, метод завидует профилю' };

describe('standards prompt', () => {
  const prompt = buildStandardsPrompt({
    diffMode: 'inline',
    diff: 'd',
    projectPath: 'g/p',
    sourceBranch: 'f',
    targetBranch: 'main',
    baseSha: 'abc123',
  });

  it('should define a violation by its three proofs and point at the base version', () => {
    expect(prompt).toContain('НАРУШЕНИЕ — регрессия против живого требования');
    expect(prompt).toContain('- Требование.');
    expect(prompt).toContain('- Живое.');
    expect(prompt).toContain('`git show abc123:<файл>`');
    expect(prompt).toContain('"quote"');
    expect(prompt).toContain('"precedent"');
    expect(prompt).toContain('"deadLetters"');
  });

  it('should carry the whole smell baseline and omit threads when there are none', () => {
    expect(prompt.match(/^- [A-Z][A-Za-z ]+: /gm)).toHaveLength(12);
    expect(prompt).not.toContain('УЖЕ ОБСУЖДЕНО');
  });
});

describe('parseStandardsOutput', () => {
  it('should keep a violation that carries both a quote and a precedent', () => {
    const review = parse({ violations: [VIOLATION], smells: [SMELL] });
    expect(review.violations).toHaveLength(1);
    expect(review.unproven).toEqual([]);
  });

  it('should set aside a violation that lacks the quote or the precedent', () => {
    const review = parse({ violations: [VIOLATION, { ...VIOLATION, quote: ' ' }, { ...VIOLATION, precedent: '' }] });
    expect(review.violations).toHaveLength(1);
    expect(review.unproven).toHaveLength(2);
  });

  it('should default every list to empty and fail without markers', () => {
    expect(parse({ summary: 'чисто' })).toMatchObject({ violations: [], smells: [], deadLetters: [], standardsRead: [] });
    expect(parseStandardsOutput('нет маркеров').ok).toBe(false);
  });
});

describe('buildStandardsNote', () => {
  it('should count inline violations and keep smells in the summary only', () => {
    const note = buildStandardsNote(parse({ standardsRead: ['AGENTS.md'], violations: [VIOLATION], smells: [SMELL] }), []);

    expect(note).toContain('Сверено с: `AGENTS.md`.');
    expect(note).toContain('Нарушений стандартов: **1** (inline: 1).');
    expect(note).toContain('- **Feature Envy** `B.kt:9`');
    expect(note).not.toContain('MaterialTheme');
  });

  it('should fall back to a summary list when a violation could not be placed inline', () => {
    const review = parse({ standardsRead: ['AGENTS.md'], violations: [VIOLATION] });
    const note = buildStandardsNote(review, review.violations);

    expect(note).toContain('(inline: 0, ниже: 1)');
    expect(note).toContain('`A.kt:4` — **AGENTS.md › Critical Rules › 1** — MaterialTheme');
  });

  it('should list dead letters as a note about the standards, not about the MR', () => {
    const note = buildStandardsNote(
      parse({ deadLetters: [{ standard: 'string-resources › 7', note: 'требует английский, весь values/ русский' }] }),
      [],
    );

    expect(note).toContain('### Стандарты, которым проект не следует');
    expect(note).toContain('- **string-resources › 7** — требует английский, весь values/ русский');
    expect(note).toContain('Нарушений стандартов: **0**');
  });

  it('should report how many unproven records were dropped', () => {
    const note = buildStandardsNote(parse({ violations: [{ ...VIOLATION, precedent: '' }] }), []);
    expect(note).toContain('Отброшено записей без цитаты требования или примера в проекте: 1.');
    expect(note).toContain('Нарушений стандартов: **0**');
  });

  it('should say so when no standards documents were found', () => {
    const note = buildStandardsNote(parse({}), []);
    expect(note).toContain('Документов со стандартами агент не нашёл');
    expect(note).toContain('_Находок нет._');
  });
});
