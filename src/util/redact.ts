/**
 * Вырезает учётные данные из текста ошибки. Нужен везде, где текст ошибки уходит в лог или в
 * заметку MR: сообщение execa содержит полную командную строку, а у git fetch/clone это URL
 * вида `https://oauth2:<токен>@host/…`.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@'"]+@/g, '$1***@')
    .replace(/\bglpat-[\w.-]+/g, 'glpat-***')
    .replace(/\blin_api_[\w-]+/g, 'lin_api_***');
}
