/** Имя приходит из текста MR или задачи: без этого `../` или `/` вывели бы файл из каталога джобы. */
export function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_');
}
