import { describe, it, expect } from 'vitest';
import { parseSpecOutput } from '../src/codex/parseSpec.js';
import { buildSpecNote } from '../src/gitlab/postSpecReview.js';
import { SPEC_BEGIN, SPEC_END } from '../src/codex/prompts.js';

describe('spec output', () => {
  const body = JSON.stringify({
    summary: 'ok',
    items: [{ target: '#34', requirement: 'Строка ника', status: 'met', evidence: 'A.kt:1' }],
    extras: [{ what: 'Новый FloatingToolbar', evidence: 'core/Toolbar.kt:10', note: 'в задаче нет' }],
  });

  it('should parse extras and default them to empty', () => {
    const full = parseSpecOutput(`${SPEC_BEGIN}\n${body}\n${SPEC_END}`);
    expect(full.ok && full.spec.extras[0]?.what).toBe('Новый FloatingToolbar');
    const bare = parseSpecOutput(`${SPEC_BEGIN}\n{"summary":"x"}\n${SPEC_END}`);
    expect(bare.ok && bare.spec.extras).toEqual([]);
  });

  it('should render targets and the scope-creep section', () => {
    const parsed = parseSpecOutput(`${SPEC_BEGIN}\n${body}\n${SPEC_END}`);
    if (!parsed.ok) throw new Error(parsed.reason);
    const note = buildSpecNote(parsed.spec, { targets: ['#34'], worktree: '/wt', linkify: (t) => t });

    expect(note).toContain('Постановка: `#34`.');
    expect(note).not.toContain('нет ни одного пункта');
    expect(note).toContain('### Сверх постановки');
    expect(note).toContain('Новый FloatingToolbar — core/Toolbar.kt:10.');
  });
});
