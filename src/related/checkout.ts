import { join } from 'node:path';
import { execa } from 'execa';
import type { RelatedRepo } from '../config.js';
import { SAME_BRANCH } from '../config/schema.js';
import { addWorktreeAt, removeWorktree } from '../git/checkout.js';
import type { Logger } from '../logger.js';

export interface RelatedBranches {
  readonly defaultBranch: string;
  has(branch: string): boolean;
}

export function chooseRelatedRef(ref: string | undefined, sourceBranch: string, branches: RelatedBranches): string {
  if (ref === undefined) return branches.defaultBranch;
  if (ref !== SAME_BRANCH) return ref;
  return branches.has(sourceBranch) ? sourceBranch : branches.defaultBranch;
}

export interface RelatedCheckout {
  readonly project: string;
  /** Ветка, которая реально выложена. */
  readonly ref: string;
  readonly dir: string;
  readonly hint?: string;
}

export interface RelatedResult {
  readonly repos: readonly RelatedCheckout[];
  readonly degraded: readonly string[];
  cleanup(): Promise<void>;
}

export interface RelatedDeps {
  /** Свежий bare-кэш проекта со всеми ветками. */
  ensureCache(project: string): Promise<string>;
}

async function gitOut(cacheDir: string, ...args: string[]): Promise<string> {
  return (await execa('git', ['-C', cacheDir, ...args])).stdout.trim();
}

async function readBranches(cacheDir: string): Promise<RelatedBranches> {
  const defaultBranch = await gitOut(cacheDir, 'symbolic-ref', '--short', 'HEAD');
  const names = new Set(
    (await gitOut(cacheDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean),
  );
  return { defaultBranch, has: (b) => names.has(b) };
}

/** Недоступный репозиторий или ветка — строка в `degraded`, а не падение джобы. */
export async function checkoutRelated(
  related: readonly RelatedRepo[],
  target: { readonly jobDir: string; readonly sourceBranch: string },
  log: Logger,
  deps: RelatedDeps,
): Promise<RelatedResult> {
  const repos: RelatedCheckout[] = [];
  const degraded: string[] = [];
  const added: { cacheDir: string; dir: string }[] = [];

  for (const repo of related) {
    // `+` не встречается в пути проекта (см. PROJECT_PATH), поэтому имена каталогов не совпадут.
    const dir = join(target.jobDir, 'related', repo.project.replaceAll('/', '+'));
    let ref: string | undefined;
    try {
      const cacheDir = await deps.ensureCache(repo.project);
      ref = chooseRelatedRef(repo.ref, target.sourceBranch, await readBranches(cacheDir));
      // До `worktree add`: сбой посреди него оставляет регистрацию в общем bare-кэше.
      added.push({ cacheDir, dir });
      await addWorktreeAt(cacheDir, `refs/heads/${ref}`, dir);
      repos.push({ project: repo.project, ref, dir, ...(repo.hint !== undefined ? { hint: repo.hint } : {}) });
    } catch (error) {
      log.warn({ err: String(error), project: repo.project, ref }, 'related repository checkout failed');
      const what = ref === undefined ? repo.project : `${repo.project} (ветка ${ref})`;
      degraded.push(`Смежный репозиторий ${what} недоступен боту.`);
    }
  }

  return {
    repos,
    degraded,
    cleanup: async () => {
      for (const { cacheDir, dir } of added) await removeWorktree(cacheDir, dir);
    },
  };
}
