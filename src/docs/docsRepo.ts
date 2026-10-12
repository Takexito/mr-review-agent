import { join } from 'node:path';
import { addWorktreeAt, ensureBareCache } from '../git/checkout.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface DocsRepo {
  /** false — репо недоступно боту (нет доступа/клон упал); сверка контрактов деградирует. */
  readonly ok: boolean;
  /** Путь к чекауту доки рядом с worktree. null — если не удалось разложить. */
  readonly dir: string | null;
  /** bare-кэш доки — нужен вызывающему, чтобы снять worktree в cleanup. */
  readonly cacheDir: string | null;
}

/**
 * Кладёт документацию на диск рядом с worktree, вместо того чтобы вклеивать её в промпт.
 *
 * Раньше отсюда уезжали два ЗАХАРДКОЖЕННЫХ файла (`metody-api.md`, `baza-dannykh.md`),
 * склеенные и обрезанные по `DOCS_REPO_MAX_BYTES` — то есть агент физически не мог
 * заглянуть в остальную доку, даже когда ответ был именно там. Теперь он грепает весь
 * репозиторий доки: codex читает соседний каталог из read-only песочницы штатно,
 * claude — через `--add-dir`.
 *
 * Недоступность доки не роняет джобу: возвращаем ok:false, вызывающий пишет degraded.
 */
export async function gatherDocsRepo(
  config: AppConfig,
  jobDir: string,
  log: Logger,
): Promise<DocsRepo> {
  let cacheDir: string;
  try {
    cacheDir = await ensureBareCache(config, config.docsRepoProject);
  } catch (error) {
    log.warn({ err: String(error), project: config.docsRepoProject }, 'docs-repo clone/fetch failed');
    return { ok: false, dir: null, cacheDir: null };
  }

  const dir = join(jobDir, 'docs-repo');
  try {
    await addWorktreeAt(cacheDir, config.docsRepoRef, dir);
  } catch (error) {
    log.warn({ err: String(error), ref: config.docsRepoRef }, 'docs-repo checkout failed');
    return { ok: false, dir: null, cacheDir };
  }

  return { ok: true, dir, cacheDir };
}
