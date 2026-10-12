function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Возвращает функцию, которая переписывает абсолютные пути worktree в выводе codex
 * (`<worktree>/<path>` или `<worktree>/<path>:<line>`) на GitLab blob-ссылки
 * (`<host>/<project>/-/blob/<sha>/<path>#L<line>`). Пути без префикса worktree не трогает.
 */
export function makeBlobLinker(
  worktreePath: string,
  gitlabHost: string,
  projectPath: string,
  sha: string,
): (text: string) => string {
  const blobBase = `${gitlabHost.replace(/\/+$/, '')}/${projectPath}/-/blob/${sha}`;
  // путь — до пробела/скобки/двоеточия/бэктика/запятой; опциональный :line
  const re = new RegExp(`${escapeRegExp(worktreePath)}/([^\\s):\\]\`,]+)(?::(\\d+))?`, 'g');
  return (text: string): string =>
    text.replace(re, (_match, path: string, line?: string) =>
      line ? `${blobBase}/${path}#L${line}` : `${blobBase}/${path}`,
    );
}
