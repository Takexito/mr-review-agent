/**
 * GitLab исполняет строку заметки, начинающуюся с `/команда` (`/merge`, `/approve`, `/close`),
 * от имени автора заметки — то есть бота. Текст заметок приходит от агента, а на него влияет
 * содержимое MR и задач, поэтому такая строка в ответе превращает prompt injection в действие
 * с правами бота. Внутри блоков кода GitLab команды не исполняет — их не трогаем.
 */
export function neutralizeQuickActions(body: string): string {
  let fence: string | null = null;
  return body
    .split('\n')
    .map((line) => {
      const marker = /^\s*(```|~~~)/.exec(line)?.[1];
      if (marker) {
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(\s*)\/(?=[a-z_]+\b)/i, '$1\\/');
    })
    .join('\n');
}
