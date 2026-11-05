import { describe, expect, it, vi } from 'vitest';
import type { DiffResult } from '../src/git/diff.js';
import type { Logger } from '../src/logger.js';
import type { Review } from '../src/codex/parseReview.js';
import {
  completeCoverage,
  FOLLOWUP_PREFACE,
  mergeCoverage,
  unreviewedFiles,
  type CompletionAxis,
} from '../src/queue/kinds/completion.js';

/**
 * Регрессия: на MR !206 android-app (244 файла) ось багов прочитала 53 — при прямом
 * «ни один не пропускай» в промпте. Полноту теперь добивает бот повторными прогонами.
 */

const jlog = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;

function diff(paths: string[], mode: DiffResult['mode'] = 'agentic'): DiffResult {
  return {
    mode,
    text: '',
    totalBytes: -1,
    linesChanged: 0,
    diffStat: '',
    files: paths.map((path) => ({ path, added: 1, deleted: 0, binary: path.endsWith('.png') })),
  };
}

function review(reviewed: string[], comments: Review['comments'] = []): Review {
  return { summary: 's', comments, disputed: [], reviewedFiles: reviewed, skippedFiles: [] };
}

/** Ось, в которой агент «читает» ровно файлы своего чеклиста. */
function axis(seen: string[][]): CompletionAxis<Review> {
  let files: string[] = [];
  return {
    name: 'bugs',
    prompt: (batch) => {
      files = batch.map((f) => f.path);
      seen.push(files);
      return 'prompt';
    },
    parse: () => review(files),
    merge: (base, extra) => ({ ...base, ...mergeCoverage(base, extra), comments: [...base.comments, ...extra.comments] }),
  };
}

const PATHS = ['a.kt', 'b.kt', 'c.kt', 'd.kt', 'e.kt'];

describe('unreviewedFiles', () => {
  it('should skip binaries and normalize agent paths when diffing against the report', () => {
    const missed = unreviewedFiles(diff(['a.kt', 'b.kt', 'logo.png']), review(['./a.kt']));

    expect(missed.map((f) => f.path)).toEqual(['b.kt']);
  });
});

describe('completeCoverage', () => {
  it('should send missed files in batches until coverage is full', async () => {
    const seen: string[][] = [];
    const rerun = vi.fn(async (prompt: string) => {
      expect(prompt.startsWith(FOLLOWUP_PREFACE)).toBe(true);
      return 'out';
    });

    const result = await completeCoverage(diff(PATHS), review(['a.kt']), axis(seen), rerun, { runs: 5, batch: 2 }, jlog);

    expect(seen).toEqual([
      ['b.kt', 'c.kt'],
      ['d.kt', 'e.kt'],
    ]);
    expect(unreviewedFiles(diff(PATHS), result)).toEqual([]);
  });

  it('should stop at the run limit and leave the rest as gaps', async () => {
    const seen: string[][] = [];
    const result = await completeCoverage(
      diff(PATHS),
      review([]),
      axis(seen),
      async () => 'out',
      { runs: 1, batch: 2 },
      jlog,
    );

    expect(seen).toHaveLength(1);
    expect(unreviewedFiles(diff(PATHS), result).map((f) => f.path)).toEqual(['c.kt', 'd.kt', 'e.kt']);
  });

  it('should not resend a file the agent already refused in a follow-up', async () => {
    const seen: string[][] = [];
    const stubborn: CompletionAxis<Review> = { ...axis(seen), parse: () => review([]) };

    await completeCoverage(diff(['a.kt', 'b.kt']), review([]), stubborn, async () => 'out', { runs: 5, batch: 1 }, jlog);

    expect(seen).toEqual([['a.kt'], ['b.kt']]);
  });

  it('should keep the first report when a rerun fails', async () => {
    const first = review(['a.kt']);
    const result = await completeCoverage(diff(PATHS), first, axis([]), async () => null, { runs: 5, batch: 2 }, jlog);

    expect(result).toBe(first);
  });

  it('should not rerun on an inline diff or without a rerun hook', async () => {
    const rerun = vi.fn(async () => 'out');
    const first = review([]);

    expect(await completeCoverage(diff(PATHS, 'inline'), first, axis([]), rerun, { runs: 5, batch: 2 }, jlog)).toBe(first);
    expect(await completeCoverage(diff(PATHS), first, axis([]), undefined, { runs: 5, batch: 2 }, jlog)).toBe(first);
    expect(rerun).not.toHaveBeenCalled();
  });
});

describe('mergeCoverage', () => {
  it('should drop a skip once a later run has read the file', () => {
    const merged = mergeCoverage(
      { reviewedFiles: ['a.kt'], skippedFiles: [{ path: 'b.kt', reason: 'бюджет' }] },
      { reviewedFiles: ['./b.kt'], skippedFiles: [] },
    );

    expect(merged.reviewedFiles).toEqual(['a.kt', './b.kt']);
    expect(merged.skippedFiles).toEqual([]);
  });
});
