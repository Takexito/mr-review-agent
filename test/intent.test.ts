import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveIntent, extractAfterMention } from '../src/webhook/intent.js';
import { parseNoteHook } from '../src/webhook/parse.js';
import type { ParsedNoteEvent } from '../src/webhook/parse.js';

const BOT = 'codex';

function evt(overrides: Partial<ParsedNoteEvent>): ParsedNoteEvent {
  return {
    projectId: 1,
    projectPath: 'acme/android-app',
    mrIid: 7,
    noteId: 1,
    noteBody: '',
    authorUsername: 'alice',
    authorId: 42,
    internal: false,
    discussionId: 'd1',
    ...overrides,
  };
}

describe('extractAfterMention', () => {
  it('should return text after mention when @bot is present', () => {
    expect(extractAfterMention('hey @codex review this', BOT)).toBe('review this');
  });

  it('should be case-insensitive for the handle', () => {
    expect(extractAfterMention('@CODEX ревью', BOT)).toBe('ревью');
  });

  it('should return null when there is no mention', () => {
    expect(extractAfterMention('just a normal comment', BOT)).toBeNull();
  });

  it('should not match a longer handle or an email with the bot name', () => {
    expect(extractAfterMention('@codex-team глянь', BOT)).toBeNull();
    expect(extractAfterMention('@codex_bot глянь', BOT)).toBeNull();
    expect(extractAfterMention('пиши на user@codex.io', BOT)).toBeNull();
  });

  it('should accept punctuation right after the handle', () => {
    expect(extractAfterMention('@codex, ревью', BOT)).toBe(', ревью');
  });

  it('should ignore a mention inside a code block, inline code or a quote', () => {
    expect(extractAfterMention('```\n@codex review\n```', BOT)).toBeNull();
    expect(extractAfterMention('тегай `@codex review`', BOT)).toBeNull();
    expect(extractAfterMention('> @codex review\n\nсогласен', BOT)).toBeNull();
    expect(extractAfterMention('>>>\n@codex review\n>>>\nок', BOT)).toBeNull();
    expect(extractAfterMention('~~~\n@codex review\n~~~', BOT)).toBeNull();
  });

  it('should find a real mention after a quoted one', () => {
    expect(extractAfterMention('> @codex review\n\n@codex bugs', BOT)).toBe('bugs');
  });
});

describe('resolveIntent', () => {
  it('should IGNORE notes authored by the bot itself', () => {
    const intent = resolveIntent(evt({ authorUsername: 'codex', noteBody: '@codex review' }), BOT);
    expect(intent.kind).toBe('IGNORE');
  });

  it('should IGNORE when the bot is not mentioned', () => {
    const intent = resolveIntent(evt({ noteBody: 'looks good to me' }), BOT);
    expect(intent.kind).toBe('IGNORE');
  });

  it('should REVIEW on English review keyword', () => {
    expect(resolveIntent(evt({ noteBody: '@codex review' }), BOT).kind).toBe('REVIEW');
  });

  it('should REVIEW on Russian ревью keyword', () => {
    expect(resolveIntent(evt({ noteBody: '@codex ревью, глянь' }), BOT).kind).toBe('REVIEW');
  });

  it('should REVIEW on a bare mention with no text', () => {
    expect(resolveIntent(evt({ noteBody: 'ping @codex' }), BOT).kind).toBe('REVIEW');
  });

  it('should ASK with the question text when not a review command', () => {
    const intent = resolveIntent(evt({ noteBody: '@codex почему тут N+1?' }), BOT);
    expect(intent).toEqual({ kind: 'ASK', question: 'почему тут N+1?' });
  });

  it('should SPEC on the spec keyword with no key', () => {
    expect(resolveIntent(evt({ noteBody: '@codex spec' }), BOT)).toEqual({ kind: 'SPEC', specRefs: [] });
  });

  it('should SPEC on Russian спека', () => {
    expect(resolveIntent(evt({ noteBody: '@codex спека, глянь' }), BOT).kind).toBe('SPEC');
  });

  it('should SPEC on the plural specs / спеки', () => {
    expect(resolveIntent(evt({ noteBody: '@codex specs' }), BOT).kind).toBe('SPEC');
    expect(resolveIntent(evt({ noteBody: '@codex спеки PRJ-137' }), BOT)).toEqual({
      kind: 'SPEC',
      specRefs: ['PRJ-137'],
    });
  });

  it('should SPEC with an explicit issue key', () => {
    expect(resolveIntent(evt({ noteBody: '@codex spec PRJ-137' }), BOT)).toEqual({
      kind: 'SPEC',
      specRefs: ['PRJ-137'],
    });
  });

  it('should keep only source tokens from the spec arguments', () => {
    expect(resolveIntent(evt({ noteBody: '@codex spec prj-42 плиз' }), BOT)).toEqual({
      kind: 'SPEC',
      specRefs: ['prj-42'],
    });
  });

  it('should SPEC with GitLab short refs and urls as sources', () => {
    const body = '@codex spec #34, acme/docs#7 https://gitlab.com/g/p/-/issues/9';
    expect(resolveIntent(evt({ noteBody: body }), BOT)).toEqual({
      kind: 'SPEC',
      specRefs: ['#34', 'acme/docs#7', 'https://gitlab.com/g/p/-/issues/9'],
    });
  });

  it('should BUGS on the bugs keyword in both languages', () => {
    expect(resolveIntent(evt({ noteBody: '@codex bugs' }), BOT).kind).toBe('BUGS');
    expect(resolveIntent(evt({ noteBody: '@codex баги' }), BOT).kind).toBe('BUGS');
  });

  it('should STANDARDS on the standards keyword in both languages', () => {
    expect(resolveIntent(evt({ noteBody: '@codex standards' }), BOT).kind).toBe('STANDARDS');
    expect(resolveIntent(evt({ noteBody: '@codex стандарты, глянь' }), BOT).kind).toBe('STANDARDS');
  });
});

describe('parseNoteHook + resolveIntent (fixture)', () => {
  it('should parse the sample MR note and resolve to REVIEW', () => {
    const path = fileURLToPath(new URL('./fixtures/note.json', import.meta.url));
    const body = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const parsed = parseNoteHook(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.mrIid).toBe(7);
    expect(parsed.event.projectPath).toBe('acme/android-app');
    expect(parsed.event.authorId).toBe(42);
    expect(parsed.event.internal).toBe(false);
    expect(resolveIntent(parsed.event, BOT).kind).toBe('REVIEW');
  });

  it('should flag an internal note whichever field the GitLab version sends', () => {
    const path = fileURLToPath(new URL('./fixtures/note.json', import.meta.url));
    const body = JSON.parse(readFileSync(path, 'utf8')) as { object_attributes: Record<string, unknown> };
    for (const field of ['internal', 'confidential']) {
      const parsed = parseNoteHook({ ...body, object_attributes: { ...body.object_attributes, [field]: true } });
      expect(parsed.ok && parsed.event.internal).toBe(true);
    }
  });

  it('should ignore a non-MergeRequest note', () => {
    const parsed = parseNoteHook({
      object_kind: 'note',
      user: { username: 'bob' },
      project: { id: 1, path_with_namespace: 'x/y' },
      object_attributes: { id: 1, note: '@codex review', noteable_type: 'Issue' },
    });
    expect(parsed.ok).toBe(false);
  });
});
