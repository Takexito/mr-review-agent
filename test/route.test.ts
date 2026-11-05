import { describe, it, expect } from 'vitest';
import { route } from '../src/webhook/intent.js';
import type { ParsedNoteEvent } from '../src/webhook/parse.js';
import type { EngineBinding } from '../src/config.js';

const BINDINGS: readonly EngineBinding[] = [
  { engine: 'codex', handle: 'codex_bot', gitlabToken: 't-codex' },
  { engine: 'claude', handle: 'claude_bot', gitlabToken: 't-claude' },
];

function evt(overrides: Partial<ParsedNoteEvent>): ParsedNoteEvent {
  return {
    projectId: 1,
    projectPath: 'acme/android-app',
    mrIid: 7,
    noteId: 1,
    noteBody: '',
    authorUsername: 'alice',
    discussionId: 'd1',
    ...overrides,
  };
}

describe('route: мульти-движок по хендлу', () => {
  it('@codex_bot review → движок codex', () => {
    expect(route(evt({ noteBody: '@codex_bot review' }), BINDINGS)).toEqual({
      engine: 'codex',
      handle: 'codex_bot',
      intent: { kind: 'REVIEW' },
    });
  });

  it('@claude_bot review → движок claude', () => {
    expect(route(evt({ noteBody: 'глянь @claude_bot review плиз' }), BINDINGS)).toEqual({
      engine: 'claude',
      handle: 'claude_bot',
      intent: { kind: 'REVIEW' },
    });
  });

  it('@claude_bot spec PRJ-137 → claude + SPEC + источник', () => {
    expect(route(evt({ noteBody: '@claude_bot spec PRJ-137' }), BINDINGS)).toEqual({
      engine: 'claude',
      handle: 'claude_bot',
      intent: { kind: 'SPEC', specRefs: ['PRJ-137'] },
    });
  });

  it('@claude_bot <вопрос> → claude + ASK', () => {
    expect(route(evt({ noteBody: '@claude_bot почему тут N+1?' }), BINDINGS)).toEqual({
      engine: 'claude',
      handle: 'claude_bot',
      intent: { kind: 'ASK', question: 'почему тут N+1?' },
    });
  });

  it('заметка от любого из ботов → null (анти-цикл)', () => {
    expect(route(evt({ authorUsername: 'codex_bot', noteBody: '@claude_bot review' }), BINDINGS)).toBeNull();
    expect(route(evt({ authorUsername: 'claude_bot', noteBody: '@codex_bot review' }), BINDINGS)).toBeNull();
  });

  it('нет упоминания бота → null', () => {
    expect(route(evt({ noteBody: 'просто комментарий' }), BINDINGS)).toBeNull();
  });

  it('только codex в bindings → @claude_bot не матчится', () => {
    const onlyCodex: readonly EngineBinding[] = [BINDINGS[0]!];
    expect(route(evt({ noteBody: '@claude_bot review' }), onlyCodex)).toBeNull();
    expect(route(evt({ noteBody: '@codex_bot review' }), onlyCodex)?.engine).toBe('codex');
  });
});

describe('route: движки профиля', () => {
  it('should ignore a mention of a bot outside the profile engines', () => {
    expect(route(evt({ noteBody: '@claude_bot review' }), BINDINGS, ['codex'])).toBeNull();
  });

  it('should still ignore notes by a bot outside the profile engines', () => {
    const note = evt({ authorUsername: 'claude_bot', noteBody: '@codex_bot review' });
    expect(route(note, BINDINGS, ['codex'])).toBeNull();
  });
});
