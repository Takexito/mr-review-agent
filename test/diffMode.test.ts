import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Гибридный дифф. Ключевая инварианта, ради которой всё затевалось: тело диффа
 * либо уходит целиком, либо не уходит вовсе — усечённой середины больше нет.
 */

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

const { computeDiff, parseNumstat, parseNumstatLine } = await import('../src/git/diff.js');

/** Раскладывает ответы git по подкоманде, чтобы порядок вызовов в тесте не был важен. */
function mockGit(responses: {
  numstat: string;
  stat?: string;
  body?: string | (() => never);
}): void {
  execaMock.mockImplementation((_bin: string, args: string[]) => {
    const joined = args.join(' ');
    if (joined.includes('--numstat')) return Promise.resolve({ stdout: responses.numstat });
    if (joined.includes('--stat')) return Promise.resolve({ stdout: responses.stat ?? '' });
    if (typeof responses.body === 'function') return Promise.reject(responses.body());
    return Promise.resolve({ stdout: responses.body ?? '' });
  });
}

const LIMITS = { maxBytes: 1000, maxLines: 100 };

beforeEach(() => {
  execaMock.mockReset();
});

describe('parseNumstatLine', () => {
  it('should parse added and deleted counts when line is regular', () => {
    expect(parseNumstatLine('12\t3\tsrc/app/Main.kt')).toEqual({
      path: 'src/app/Main.kt',
      added: 12,
      deleted: 3,
      binary: false,
    });
  });

  it('should mark file binary when counts are dashes', () => {
    expect(parseNumstatLine('-\t-\tassets/logo.png')).toEqual({
      path: 'assets/logo.png',
      added: 0,
      deleted: 0,
      binary: true,
    });
  });

  it('should take new side when rename uses arrow form', () => {
    expect(parseNumstatLine('1\t1\told/Name.kt => new/Name.kt')?.path).toBe('new/Name.kt');
  });

  it('should take new side when rename uses braced form', () => {
    expect(parseNumstatLine('1\t1\tsrc/{old => new}/Name.kt')?.path).toBe('src/new/Name.kt');
  });

  it('should return null when line is not numstat', () => {
    expect(parseNumstatLine('not a numstat line')).toBeNull();
  });
});

describe('parseNumstat', () => {
  it('should skip unparsable lines when output is mixed', () => {
    const files = parseNumstat('5\t0\ta.kt\ngarbage\n0\t2\tb.kt\n');
    expect(files.map((f) => f.path)).toEqual(['a.kt', 'b.kt']);
  });
});

describe('computeDiff', () => {
  it('should return inline mode with full body when diff fits both limits', async () => {
    mockGit({ numstat: '10\t5\tsrc/a.kt\n', stat: ' src/a.kt | 15 +++', body: 'diff --git a/a b/a\n' });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.mode).toBe('inline');
    expect(result.text).toBe('diff --git a/a b/a\n');
    expect(result.linesChanged).toBe(15);
    expect(result.files).toHaveLength(1);
  });

  it('should switch to agentic without running git diff when line limit exceeded', async () => {
    mockGit({ numstat: '90\t90\tsrc/big.kt\n', stat: ' src/big.kt | 180 +++' });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.mode).toBe('agentic');
    expect(result.text).toBe('');
    expect(result.totalBytes).toBe(-1);
    // Полное тело диффа не запрашивалось вовсе — только numstat и stat.
    const calls = execaMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('--numstat'))).toBe(true);
    expect(calls.some((c) => !c.includes('--numstat') && !c.includes('--stat'))).toBe(false);
  });

  it('should switch to agentic and drop body when byte limit exceeded', async () => {
    mockGit({ numstat: '10\t5\tsrc/a.kt\n', body: 'x'.repeat(LIMITS.maxBytes + 1) });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.mode).toBe('agentic');
    expect(result.text).toBe('');
    expect(result.totalBytes).toBe(LIMITS.maxBytes + 1);
  });

  it('should keep body when size sits exactly on the byte limit', async () => {
    mockGit({ numstat: '10\t5\tsrc/a.kt\n', body: 'x'.repeat(LIMITS.maxBytes) });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.mode).toBe('inline');
    expect(result.text).toHaveLength(LIMITS.maxBytes);
  });

  it('should degrade to agentic when git diff overflows the buffer', async () => {
    mockGit({
      numstat: '10\t5\tsrc/a.kt\n',
      body: () => {
        throw Object.assign(new Error('maxBuffer length exceeded'), { code: 'ENOBUFS' });
      },
    });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.mode).toBe('agentic');
    expect(result.files).toHaveLength(1);
  });

  it('should rethrow when git diff fails for a non-buffer reason', async () => {
    mockGit({
      numstat: '10\t5\tsrc/a.kt\n',
      body: () => {
        throw new Error('fatal: bad object base');
      },
    });

    await expect(computeDiff('/cache', 'base', 'head', LIMITS)).rejects.toThrow('bad object');
  });

  it('should report empty inline diff when nothing changed', async () => {
    mockGit({ numstat: '' });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.files).toHaveLength(0);
    expect(result.mode).toBe('inline');
  });

  it('should keep full diffstat when body is dropped in agentic mode', async () => {
    mockGit({ numstat: '90\t90\tsrc/big.kt\n', stat: ' src/big.kt | 180 +++\n 1 file changed' });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.diffStat).toContain('1 file changed');
  });

  it('should survive when diffstat call fails', async () => {
    execaMock.mockImplementation((_bin: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--numstat')) return Promise.resolve({ stdout: '1\t1\ta.kt\n' });
      if (joined.includes('--stat')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ stdout: 'body' });
    });

    const result = await computeDiff('/cache', 'base', 'head', LIMITS);

    expect(result.diffStat).toBe('');
    expect(result.mode).toBe('inline');
  });
});
