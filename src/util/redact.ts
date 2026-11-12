/**
 * Вырезает учётные данные из текста ошибки. Нужен везде, где текст ошибки уходит в лог или в
 * заметку MR: сообщение execa содержит полную командную строку, а у git fetch/clone это URL
 * вида `https://oauth2:<токен>@host/…`.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@'"]+@/g, '$1***@')
    .replace(/\b(gl(?:pat|ptt|dt|rt|soat|cbt|oas|imt|agent|ft|wt|ffct))-[\w.-]+/g, '$1-***')
    .replace(/\blin_api_[\w-]+/g, 'lin_api_***')
    .replace(/\bsk-ant-[\w-]+/g, 'sk-ant-***')
    // Ключи OpenAI длинные; порог длины не трогает обычные слова вида `sk-1`.
    .replace(/\bsk-[\w-]{20,}/g, 'sk-***')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, '***')
    // Порог длины и пробел без перевода строки: «Bearer token scheme» в тексте ревью — не заголовок.
    .replace(/\b(Bearer)[ \t]+[\w.~+/=-]{16,}/g, '$1 ***');
}

/** Значения короче этого не вычищаем: совпадение с обычным словом испортило бы текст. */
const MIN_KNOWN_SECRET_LENGTH = 8;

/** `redactSecrets` плюс точные значения известных секретов — для текста, уходящего наружу. */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= MIN_KNOWN_SECRET_LENGTH) out = out.split(secret).join('***');
  }
  return redactSecrets(out);
}
