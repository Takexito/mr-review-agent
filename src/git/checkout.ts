import { execa } from 'execa';
import { redactSecrets } from '../util/redact.js';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { KeyedMutex } from '../util/keyedMutex.js';

/**
 * Один bare-кэш на репозиторий, и джоб может быть несколько одновременно
 * (`server.queueConcurrency`). Все операции над кэшем сериализуем по его пути.
 */
const cacheLock = new KeyedMutex();

/** Имя каталога bare-кэша по пути проекта. Экспортируется: по нему кэш находят и другие модули. */
export function slugify(projectPath: string): string {
  return `${projectPath.replace(/[^a-zA-Z0-9_.-]/g, '__')}.git`;
}

/** Путь bare-кэша проекта — без гарантии, что он уже выкачан. */
export function cachePath(config: AppConfig, projectPath: string): string {
  return join(config.reposCacheDir, slugify(projectPath));
}

function hostname(gitlabHost: string): string {
  return new URL(gitlabHost).host;
}

/**
 * URL с токеном — используется только как аргумент команды, в remote НЕ сохраняется.
 * Берём `gitlabCloneToken`: ему хватает `read_repository`, тогда как постинг требует `api`.
 */
function tokenizedUrl(config: AppConfig, projectPath: string): string {
  const host = hostname(config.gitlabHost);
  return `https://oauth2:${config.gitlabCloneToken}@${host}/${projectPath}.git`;
}

function tokenlessUrl(config: AppConfig, projectPath: string): string {
  const host = hostname(config.gitlabHost);
  return `https://${host}/${projectPath}.git`;
}

/** git-команда с токеном в аргументах: её ошибка не должна нести токен дальше. */
async function gitWithToken(args: readonly string[]): Promise<void> {
  try {
    await execa('git', args);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : '';
    const command = args.includes('clone') ? 'clone' : 'fetch';
    throw new Error(redactSecrets(`git ${command} failed${detail}`));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const MAX_REPO_FILE_BYTES = 64 * 1024;

export class RepoFileTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`файл ${bytes} байт — больше ${MAX_REPO_FILE_BYTES}`);
    this.name = 'RepoFileTooLargeError';
  }
}

/**
 * Файл из ветки bare-кэша; null — нет ветки или файла. Кэш тянет ветки как `refs/heads/*`,
 * поэтому target-ветка MR в нём есть после `ensureBareCache`.
 */
export async function readBranchFile(cacheDir: string, branch: string, path: string): Promise<string | null> {
  const rev = `refs/heads/${branch}:${path}`;
  let size: number;
  try {
    size = Number((await execa('git', ['-C', cacheDir, 'cat-file', '-s', rev])).stdout);
  } catch {
    return null;
  }
  if (size > MAX_REPO_FILE_BYTES) throw new RepoFileTooLargeError(size);
  return (await execa('git', ['-C', cacheDir, 'cat-file', 'blob', rev], { stripFinalNewline: false })).stdout;
}

/** Есть ли коммит в кэше. Без этого агент в agentic-режиме упрётся в `bad object`. */
export async function hasCommit(cacheDir: string, sha: string): Promise<boolean> {
  try {
    await execa('git', ['-C', cacheDir, 'cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `clone --bare` пишет HEAD один раз, а `fetch` его не трогает: после переименования ветки
 * по умолчанию на сервере HEAD кэша указывает на удалённую `--prune` ветку.
 */
export async function refreshDefaultBranch(cacheDir: string, remoteUrl: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execa('git', ['-C', cacheDir, 'ls-remote', '--symref', remoteUrl, 'HEAD']));
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(redactSecrets(`git ls-remote failed${typeof stderr === 'string' ? `: ${stderr.trim()}` : ''}`));
  }
  const head = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(stdout)?.[1];
  if (head) await execa('git', ['-C', cacheDir, 'symbolic-ref', 'HEAD', head]);
}

export interface EnsureCacheOptions {
  /**
   * IID мерж-реквеста. Если задан, дополнительно тянем `refs/merge-requests/<iid>/head`:
   * ветки целевого проекта не покрывают MR из форка (там нет headSha) и force-push
   * в target (там пропадает baseSha).
   */
  readonly mrIid?: number;
  /** Ревизии, без которых джоба бессмысленна — добираем точечно, если их нет после fetch. */
  readonly requireShas?: readonly string[];
}

/** Ревизия не доехала в кэш — джобу продолжать нельзя, но и падать молча не стоит. */
export class MissingRevisionError extends Error {
  constructor(readonly sha: string) {
    super(`revision ${sha} is not reachable in the repository cache`);
    this.name = 'MissingRevisionError';
  }
}

/**
 * Гарантирует свежий bare-кэш репозитория и возвращает путь к нему.
 * Токен передаётся только как аргумент git (fetch/clone), в конфиг remote
 * пишется URL без токена — чтобы креды не оседали на диске.
 */
export async function ensureBareCache(
  config: AppConfig,
  projectPath: string,
  options: EnsureCacheOptions = {},
): Promise<string> {
  const dir = cachePath(config, projectPath);
  const withToken = tokenizedUrl(config, projectPath);
  const withoutToken = tokenlessUrl(config, projectPath);

  return cacheLock.run(dir, async () => {
    await mkdir(config.reposCacheDir, { recursive: true });

    const refspecs = ['+refs/heads/*:refs/heads/*'];
    if (options.mrIid !== undefined) {
      refspecs.push(`+refs/merge-requests/${options.mrIid}/head:refs/mr/${options.mrIid}/head`);
    }

    if (await exists(join(dir, 'HEAD'))) {
      await gitWithToken(['-C', dir, 'fetch', '--prune', '--quiet', withToken, ...refspecs]);
      await refreshDefaultBranch(dir, withToken);
    } else {
      await rm(dir, { recursive: true, force: true });
      await gitWithToken(['clone', '--bare', '--quiet', withToken, dir]);
      await execa('git', ['-C', dir, 'remote', 'set-url', 'origin', withoutToken]);
      if (refspecs.length > 1) {
        await gitWithToken(['-C', dir, 'fetch', '--quiet', withToken, ...refspecs.slice(1)]);
      }
    }

    for (const sha of options.requireShas ?? []) {
      if (await hasCommit(dir, sha)) continue;
      // Последняя попытка: точечный fetch по SHA (GitLab разрешает при allowReachableSHA1InWant).
      await gitWithToken(['-C', dir, 'fetch', '--quiet', withToken, sha]).catch(() => undefined);
      if (!(await hasCommit(dir, sha))) throw new MissingRevisionError(sha);
    }

    return dir;
  });
}

/**
 * Каталог джобы. Внутри лежит `repo/` (cwd агента) и рядом — `related/`, `mr/`, `images/`, `targets/`.
 * Соседние каталоги, а не подкаталоги репозитория: иначе они засоряют worktree и
 * вылезают в `git status`/`git diff` как untracked.
 */
export async function createJobDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-wt-'));
}

/** Создаёт detached-worktree на нужном SHA по заданному пути. */
export async function addWorktreeAt(cacheDir: string, sha: string, target: string): Promise<string> {
  await cacheLock.run(cacheDir, () =>
    execa('git', ['-C', cacheDir, 'worktree', 'add', '--detach', '--quiet', target, sha]),
  );
  return target;
}

/** Убирает worktree. Ошибки глушим — это cleanup. */
export async function removeWorktree(cacheDir: string, worktreePath: string): Promise<void> {
  await cacheLock
    .run(cacheDir, () => execa('git', ['-C', cacheDir, 'worktree', 'remove', '--force', worktreePath]))
    .catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
}

/** Сносит каталог джобы целиком (worktree'ы должны быть сняты до этого). */
export async function removeJobDir(jobDir: string): Promise<void> {
  await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
}
