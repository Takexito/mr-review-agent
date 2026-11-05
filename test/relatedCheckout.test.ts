import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutRelated } from '../src/related/checkout.js';
import { refreshDefaultBranch } from '../src/git/checkout.js';
import type { Logger } from '../src/logger.js';

const log = { warn: () => undefined, info: () => undefined } as unknown as Logger;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
}

/** Bare-репозиторий с веткой по умолчанию `main` и веткой `feature/x`, у каждой свой README. */
async function makeBare(root: string): Promise<string> {
  const work = join(root, 'work');
  await execa('git', ['init', '--quiet', '-b', 'main', work]);
  await execa('sh', ['-c', 'echo main > README'], { cwd: work });
  await git(work, 'add', 'README');
  await git(work, 'commit', '--quiet', '-m', 'main');
  await git(work, 'checkout', '--quiet', '-b', 'feature/x');
  await execa('sh', ['-c', 'echo feature > README'], { cwd: work });
  await git(work, 'commit', '--quiet', '-am', 'feature');
  // HEAD bare-клона — текущая ветка источника; она и станет веткой по умолчанию.
  await git(work, 'checkout', '--quiet', 'main');
  const bare = join(root, 'docs.git');
  await execa('git', ['clone', '--bare', '--quiet', work, bare]);
  return bare;
}

describe('checkoutRelated', () => {
  let root: string;
  let bare: string;
  let jobDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'related-test-'));
    bare = await makeBare(root);
    jobDir = join(root, 'job');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deps = () => ({ ensureCache: async () => bare });

  it('should check out the MR branch for same-branch and the default branch otherwise', async () => {
    const result = await checkoutRelated(
      [
        { project: 'g/docs', ref: 'same-branch', hint: 'Доки' },
        { project: 'g/other', ref: 'same-branch' },
      ],
      { jobDir, sourceBranch: 'feature/x' },
      log,
      deps(),
    );

    expect(result.degraded).toEqual([]);
    expect(result.repos.map((r) => [r.project, r.ref, r.hint])).toEqual([
      ['g/docs', 'feature/x', 'Доки'],
      ['g/other', 'feature/x', undefined],
    ]);
    expect(await readFile(join(result.repos[0]!.dir, 'README'), 'utf8')).toBe('feature\n');
    await result.cleanup();
  });

  it('should fall back to the default branch when the MR branch is missing there', async () => {
    const result = await checkoutRelated([{ project: 'g/docs', ref: 'same-branch' }], { jobDir, sourceBranch: 'nope' }, log, deps());

    expect(result.repos[0]!.ref).toBe('main');
    expect(await readFile(join(result.repos[0]!.dir, 'README'), 'utf8')).toBe('main\n');
    await result.cleanup();
  });

  it('should report an unreachable repository or branch as degraded instead of failing the job', async () => {
    const result = await checkoutRelated(
      [
        { project: 'g/missing' },
        { project: 'g/docs', ref: 'no-such-branch' },
      ],
      { jobDir, sourceBranch: 'main' },
      log,
      {
        ensureCache: async (project) => {
          if (project === 'g/missing') throw new Error('clone failed');
          return bare;
        },
      },
    );

    expect(result.repos).toEqual([]);
    expect(result.degraded).toHaveLength(2);
    expect(result.degraded[0]).toContain('g/missing');
    expect(result.degraded[1]).toContain('no-such-branch');
  });

  it('should remove the checkouts on cleanup', async () => {
    const result = await checkoutRelated([{ project: 'g/docs' }], { jobDir, sourceBranch: 'main' }, log, deps());
    const dir = result.repos[0]!.dir;
    await result.cleanup();
    await expect(access(dir)).rejects.toThrow();
  });

  it('should place each project in its own directory even when names differ only by separators', async () => {
    const result = await checkoutRelated(
      [{ project: 'a/b__c' }, { project: 'a__b/c' }],
      { jobDir, sourceBranch: 'main' },
      log,
      deps(),
    );
    expect(result.degraded).toEqual([]);
    expect(new Set(result.repos.map((r) => r.dir)).size).toBe(2);
    await result.cleanup();
  });
});

describe('refreshDefaultBranch', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'related-head-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should follow a renamed default branch of the remote', async () => {
    const bare = await makeBare(root);
    const work = join(root, 'work');
    await git(work, 'branch', '-m', 'main', 'trunk');
    await git(bare, 'fetch', '--quiet', '--prune', work, '+refs/heads/*:refs/heads/*');

    await refreshDefaultBranch(bare, work);

    const { stdout } = await execa('git', ['-C', bare, 'symbolic-ref', '--short', 'HEAD']);
    expect(stdout).toBe('trunk');
  });
});

