import { execa } from 'execa';

/**
 * Как дифф попадает к агенту.
 *
 * `inline` — тело диффа влезло в бюджет и уехало прямо в промпт: один проход, дёшево.
 * `agentic` — не влезло; тело в промпт НЕ кладём вообще, вместо него отдаём полный
 * список файлов и `base..head`, а агент вычитывает дифф пофайлово сам из worktree.
 *
 * Усечения больше нет как класса: раньше половина диффа молча выбрасывалась, и бот
 * рапортовал «замечаний 0» по тому, чего не видел (см. `gitlab/coverage.ts`).
 */
export type DiffMode = 'inline' | 'agentic';

export interface ChangedFile {
  /** Путь в НОВОЙ версии (для rename — то, что после стрелки). */
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
  /** numstat отдаёт `-` вместо чисел — считать строки нечего. */
  readonly binary: boolean;
}

export interface DiffResult {
  readonly mode: DiffMode;
  /** Тело диффа. В режиме `agentic` — пустая строка. Никогда не усечено. */
  readonly text: string;
  /** Размер тела в байтах; -1 — не измеряли (отсеклись по строкам, дифф не запускали). */
  readonly totalBytes: number;
  readonly linesChanged: number;
  /** `git diff --stat` — полный список затронутых файлов, не усекается никогда. */
  readonly diffStat: string;
  readonly files: readonly ChangedFile[];
}

export interface DiffLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

/**
 * numstat: `<added>\t<deleted>\t<path>`, где для бинарников вместо чисел `-`.
 * Rename приходит либо как `old => new`, либо как `pre{old => new}post` — берём
 * новую сторону, потому что все замечания агента привязываются к новой версии.
 */
export function parseNumstatLine(line: string): ChangedFile | null {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  if (!m) return null;
  const [, addedRaw, deletedRaw, rawPath] = m;
  const binary = addedRaw === '-' || deletedRaw === '-';
  return {
    path: newSideOfPath(rawPath!),
    added: binary ? 0 : Number(addedRaw),
    deleted: binary ? 0 : Number(deletedRaw),
    binary,
  };
}

function newSideOfPath(raw: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    const [, prefix, , to, suffix] = braced;
    return `${prefix}${to}${suffix}`.replace(/\/{2,}/g, '/');
  }
  const arrow = raw.split(' => ');
  return (arrow.length === 2 ? arrow[1]! : raw).trim();
}

export function parseNumstat(stdout: string): ChangedFile[] {
  return stdout
    .split('\n')
    .map((l) => parseNumstatLine(l.trimEnd()))
    .filter((f): f is ChangedFile => f !== null);
}

/** execa не типизирует code, а ENOBUFS прилетает и как code, и в тексте сообщения. */
function isBufferOverflow(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === 'ENOBUFS' || /maxBuffer|ENOBUFS/i.test(e?.message ?? '');
}

/**
 * Дифф MR: `git diff base..head` в bare-кэше (обе ревизии уже выкачаны).
 *
 * Порядок намеренный: сперва дешёвые numstat/stat без тела, и только если по ним
 * видно, что дифф влезает, — запускаем полный `git diff`. Огромный дифф вообще
 * не материализуется в память (раньше он всегда читался целиком и на >8 МБ падал
 * с ENOBUFS вместо деградации).
 */
export async function computeDiff(
  cacheDir: string,
  baseSha: string,
  headSha: string,
  limits: DiffLimits,
): Promise<DiffResult> {
  const range = `${baseSha}..${headSha}`;
  const git = (args: string[], maxBuffer: number): Promise<string> =>
    execa('git', ['-C', cacheDir, ...args], { maxBuffer }).then((r) => r.stdout);

  const numstat = await git(['diff', '--numstat', '--no-color', range], 8 * 1024 * 1024);
  const files = parseNumstat(numstat);
  const linesChanged = files.reduce((sum, f) => sum + f.added + f.deleted, 0);

  // diffstat дёшев (строка на файл) и в промпт идёт целиком в обоих режимах.
  let diffStat = '';
  try {
    diffStat = await git(['diff', '--stat', '--no-color', range], 4 * 1024 * 1024);
  } catch {
    diffStat = '';
  }

  const agentic = (totalBytes: number): DiffResult => ({
    mode: 'agentic',
    text: '',
    totalBytes,
    linesChanged,
    diffStat,
    files,
  });

  if (files.length === 0) {
    return { mode: 'inline', text: '', totalBytes: 0, linesChanged: 0, diffStat, files };
  }
  if (linesChanged > limits.maxLines) {
    return agentic(-1);
  }

  let body: string;
  try {
    body = await git(['diff', '--no-color', range], limits.maxBytes * 2 + 1024 * 1024);
  } catch (error) {
    if (isBufferOverflow(error)) return agentic(-1);
    throw error;
  }

  const totalBytes = Buffer.byteLength(body, 'utf8');
  if (totalBytes > limits.maxBytes) return agentic(totalBytes);

  return { mode: 'inline', text: body, totalBytes, linesChanged, diffStat, files };
}
