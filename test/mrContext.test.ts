import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CURRENT_THREAD_MARK, formatDiscussions, truncateThreads } from '../src/gitlab/discussions.js';
import { buildAskPrompt } from '../src/codex/prompts.js';
import { describeError, mrContextFromEnv } from '../src/mcp/tools.js';

/**
 * Треды MR раньше уходили в промпт срезом на 20 000 символов, обрезанным ПОСЕРЕДИНЕ
 * реплики, и добрать остальное агент не мог никак. Теперь срез режется по границе
 * тредов и честно говорит, сколько не поместилось, а остальное читается on-demand.
 */

const DISCUSSIONS = [
  {
    notes: [
      { body: 'Тут возможен NPE', author: { username: 'alice' }, position: { new_path: 'A.kt', new_line: 42 } },
      { body: 'Пофиксил', author: { username: 'bob' }, resolved: true },
    ],
  },
  {
    notes: [{ body: 'Общий вопрос по архитектуре', author: { username: 'carol' } }],
  },
];

describe('formatDiscussions', () => {
  it('should render location, resolved flag and replies when discussion is inline', () => {
    const text = formatDiscussions(DISCUSSIONS);

    expect(text).toContain('[A.kt:42] [resolved]');
    expect(text).toContain('alice: Тут возможен NPE');
    expect(text).toContain('bob: Пофиксил');
  });

  it('should mark non-inline discussions as general', () => {
    expect(formatDiscussions(DISCUSSIONS)).toContain('[общий]');
  });

  it('should drop system notes and bot service noise', () => {
    // Все служебные заметки бота: ack, лимит, пустой дифф, ротация токена, сбой.
    const text = formatDiscussions([
      { notes: [{ body: 'assigned to @x', system: true, author: { username: 'gitlab' } }] },
      { notes: [{ body: '👀 взял в работу', author: { username: 'codex_bot' } }] },
      { notes: [{ body: '⏳ Упёрлись в лимит подписки — попробуйте позже.', author: { username: 'codex_bot' } }] },
      { notes: [{ body: '🤖 дифф пуст — нечего проверять.', author: { username: 'codex_bot' } }] },
      { notes: [{ body: '🔑 Codex: токен подписки недействителен', author: { username: 'codex_bot' } }] },
      { notes: [{ body: '⚠️ Codex не смог обработать запрос:', author: { username: 'codex_bot' } }] },
    ]);

    expect(text).toBe('');
  });

  it('should keep the bot own review and inline findings', () => {
    // Содержательные заметки бота начинаются иначе — фильтр их не должен съедать,
    // иначе на повторном ревью агент не увидит, что уже сам сказал.
    const text = formatDiscussions([
      { notes: [{ body: '## 🤖 Codex · поиск багов\n\nЗамечаний: 2', author: { username: 'codex_bot' } }] },
      { notes: [{ body: '🔴 **blocker** — тут NPE', author: { username: 'codex_bot' } }] },
    ]);

    expect(text).toContain('поиск багов');
    expect(text).toContain('blocker');
  });

  it('should mark the thread the current question was asked in', () => {
    const text = formatDiscussions(
      [
        { id: 'abc', notes: [{ body: '🔴 тут NPE', author: { username: 'codex_bot' } }] },
        { id: 'def', notes: [{ body: 'другой тред', author: { username: 'alice' } }] },
      ],
      { currentDiscussionId: 'abc' },
    );

    expect(text).toMatch(/\[общий\].*ВОПРОС ЗАДАН В ЭТОМ ТРЕДЕ[\s\S]*тут NPE/);
    expect(text.split('другой тред')[1]).not.toContain('ВОПРОС ЗАДАН');
  });

  it('should not mark anything when no current discussion is given', () => {
    const text = formatDiscussions([{ id: 'abc', notes: [{ body: 'x', author: { username: 'a' } }] }]);

    expect(text).not.toContain('ВОПРОС ЗАДАН');
  });

  it('should tolerate malformed payloads', () => {
    expect(formatDiscussions([null, undefined, {}, { notes: 'nonsense' }])).toBe('');
  });
});

describe('truncateThreads', () => {
  const text = formatDiscussions(DISCUSSIONS);

  it('should return text unchanged when it fits', () => {
    expect(truncateThreads(text, 10_000)).toBe(text);
  });

  it('should cut on a thread boundary, not mid-sentence', () => {
    const cut = truncateThreads(text, 80);

    // Второй тред не влез целиком — он не должен появиться обрывком.
    expect(cut).not.toContain('Общий вопрос по архитект');
    expect(cut).toContain('[A.kt:42]');
  });

  it('should say how many threads were dropped', () => {
    const cut = truncateThreads(text, 80);

    expect(cut).toMatch(/показано 1 из 2 тредов/);
    expect(cut).toContain('ещё 1 не поместились');
  });

  it('should keep at least the beginning when even one thread overflows', () => {
    const cut = truncateThreads(text, 10);

    expect(cut.length).toBeGreaterThan(0);
    expect(cut).toContain('показано');
  });

  /**
   * Тред вопроса обычно последний по времени — при обрезании «с начала» именно он и
   * терялся бы, то есть ASK опять отвечал бы вслепую.
   */
  it('should keep the pinned thread even when it sits last', () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i) => `[общий]\n  alice: старый тред номер ${i} с текстом`),
      `[A.kt:42] ${CURRENT_THREAD_MARK}\n  bob: а почему blocker?`,
    ].join('\n\n');

    const cut = truncateThreads(many, 300, CURRENT_THREAD_MARK);

    expect(cut).toContain('а почему blocker?');
    expect(cut).toContain(CURRENT_THREAD_MARK);
  });

  it('should still drop the pinned thread from the count honestly', () => {
    const many = [
      `[A.kt:42] ${CURRENT_THREAD_MARK}\n  bob: вопрос`,
      ...Array.from({ length: 30 }, (_, i) => `[общий]\n  alice: старый тред номер ${i} с текстом`),
    ].join('\n\n');

    const cut = truncateThreads(many, 300, CURRENT_THREAD_MARK);

    expect(cut).toMatch(/показано \d+ из 31 тредов/);
  });

  it('should behave as before when no pin is given', () => {
    const cut = truncateThreads(text, 80);

    expect(cut).toContain('[A.kt:42]');
  });
});

/**
 * ASK раньше получал ТОЛЬКО текст вопроса: реплай на замечание бота приходил как вопрос
 * из ниоткуда, хотя ответ уходил обратно в тот же тред.
 */
describe('ASK-промпт и контекст треда', () => {
  const base = { projectPath: 'acme/android-app', diffMode: 'inline' as const, diff: 'diff' };

  it('кладёт обсуждения MR в промпт', () => {
    const prompt = buildAskPrompt({
      ...base,
      question: 'а почему blocker?',
      existingThreads: `[A.kt:42] ${CURRENT_THREAD_MARK}\n  codex_bot: 🔴 тут NPE\n  bob: а почему blocker?`,
    });

    expect(prompt).toContain('ОБСУЖДЕНИЯ В ЭТОМ MR');
    expect(prompt).toContain('тут NPE');
    expect(prompt).toContain(CURRENT_THREAD_MARK);
  });

  it('велит отвечать именно про тред вопроса и признавать ошибку', () => {
    const prompt = buildAskPrompt({
      ...base,
      question: 'q',
      existingThreads: '[общий]\n  bob: q',
    });

    expect(prompt).toContain('отвечай именно про него');
    expect(prompt).toContain('признай ошибку');
  });

  it('не добавляет пустой блок, когда обсуждений нет', () => {
    const prompt = buildAskPrompt({ ...base, question: 'q', existingThreads: '   ' });

    expect(prompt).not.toContain('ОБСУЖДЕНИЯ В ЭТОМ MR');
  });

  it('работает без поля вовсе (обратная совместимость)', () => {
    const prompt = buildAskPrompt({ ...base, question: 'q' });

    expect(prompt).toContain('Вопрос: q');
    expect(prompt).not.toContain('ОБСУЖДЕНИЯ В ЭТОМ MR');
  });
});

describe('mrContextFromEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('should build context when token and ids are present', () => {
    const ctx = mrContextFromEnv({
      GITLAB_READ_TOKEN: 'glpat-read',
      GITLAB_HOST: 'https://gitlab.example.com',
      GITLAB_PROJECT_ID: '42',
      GITLAB_MR_IID: '7',
    });

    expect(ctx).toEqual({
      host: 'https://gitlab.example.com',
      token: 'glpat-read',
      projectId: 42,
      mrIid: 7,
    });
  });

  it('should return null when the read token is absent', () => {
    expect(mrContextFromEnv({ GITLAB_PROJECT_ID: '1', GITLAB_MR_IID: '2' })).toBeNull();
  });

  it('should return null when ids are missing or unparsable', () => {
    expect(mrContextFromEnv({ GITLAB_READ_TOKEN: 't', GITLAB_MR_IID: '2' })).toBeNull();
    expect(
      mrContextFromEnv({ GITLAB_READ_TOKEN: 't', GITLAB_PROJECT_ID: 'abc', GITLAB_MR_IID: '2' }),
    ).toBeNull();
  });

  it('should default the host when it is not provided', () => {
    const ctx = mrContextFromEnv({ GITLAB_READ_TOKEN: 't', GITLAB_PROJECT_ID: '1', GITLAB_MR_IID: '2' });

    expect(ctx?.host).toBe('https://gitlab.com');
  });
});

/**
 * Агент должен по тексту ошибки понимать, что делать дальше. `GitbeakerRequestError`
 * (его `message` пуст, полезное лежит в `cause.description`) этого не даёт.
 */
describe('describeError', () => {
  it('should surface the gitbeaker description instead of the empty message', () => {
    const err = Object.assign(new Error(''), {
      name: 'GitbeakerRequestError',
      cause: { description: '401 Unauthorized', response: { status: 401 } },
    });

    expect(describeError(err)).toBe('401 Unauthorized');
  });

  it('should fall back to the status when there is no description', () => {
    const err = Object.assign(new Error(''), { cause: { response: { status: 404 } } });

    expect(describeError(err)).toBe('HTTP 404');
  });

  it('should use the plain message for ordinary errors', () => {
    expect(describeError(new Error('getaddrinfo ENOTFOUND'))).toBe('getaddrinfo ENOTFOUND');
  });

  it('should never return an empty string', () => {
    expect(describeError(Object.assign(new Error(''), { name: 'WeirdError' }))).toBe('WeirdError');
    expect(describeError(undefined).length).toBeGreaterThan(0);
  });
});
