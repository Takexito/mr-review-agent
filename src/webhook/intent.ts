import type { ParsedNoteEvent } from './parse.js';
import type { EngineBinding, EngineName } from '../config.js';

export type Intent =
  | { readonly kind: 'REVIEW' }
  | { readonly kind: 'BUGS' }
  | { readonly kind: 'STANDARDS' }
  | { readonly kind: 'SPEC'; readonly specRefs: readonly string[] }
  | { readonly kind: 'ASK'; readonly question: string }
  | { readonly kind: 'IGNORE'; readonly reason: string };

/** Результат маршрутизации: какой движок и какой intent для упомянутого бота. */
export interface Route {
  readonly engine: EngineName;
  readonly handle: string;
  readonly intent: Exclude<Intent, { kind: 'IGNORE' }>;
}

/** Ключевые слова общего ревью — оркестратор по всем осям (после mention). RU + EN. */
const REVIEW_KEYWORDS = ['review', 'ревью', 'отревьюй', 'ревьюни', 'проверь'];

/** Ключевые слова отдельной оси поиска багов. */
const BUGS_KEYWORDS = ['bugs', 'bug', 'баги', 'багов'];

/** Ключевые слова проверки по стандартам репозитория. */
const STANDARDS_KEYWORDS = ['standards', 'standard', 'стандарты', 'стандарт', 'стандартам'];

/** Ключевые слова команды сверки с требованиями/спекой. RU + EN, ед. и мн. число. */
const SPEC_KEYWORDS = ['spec', 'specs', 'спека', 'спеки', 'спеку', 'спек'];

/**
 * Прямые цели из аргумента команды `spec`: всё после ключевого слова, по пробелам.
 * Какой токен — прямая цель, решает `findDirectTargets` по `issueKeys` профиля при запуске джобы.
 */
export function extractSpecArgs(after: string): string[] {
  return after
    .split(/\s+/)
    .slice(1)
    .map((token) => token.replace(/[,;]+$/, ''))
    .filter((token) => /^(?:https?:\/\/\S+|(?:[\w.-]+\/)*[\w.-]*#\d+|[a-z][a-z0-9]+-\d+)$/i.test(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Находит первое упоминание @bot и возвращает текст после него.
 * null — если упоминания нет.
 */
export function extractAfterMention(body: string, botUsername: string): string | null {
  // `\b` здесь не годится: он пропускает `@codex-team`, `@codex.io` и `user@codex.io`.
  const mention = new RegExp(`(?<![\\w.@])@${escapeRegExp(botUsername)}(?![\\w-]|\\.\\w)`, 'i');
  const match = mention.exec(maskQuotedText(body));
  if (!match) return null;
  return body.slice(match.index + match[0].length).trim();
}

/**
 * Заменяет пробелами блоки кода, инлайн-код и строки цитат: упоминание бота в них — пример или
 * пересказ, а не вызов. Длина текста сохраняется, чтобы индекс совпадения подходил к исходному тексту.
 */
function maskQuotedText(body: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return body
    .replace(/^(```|~~~)[\s\S]*?(?:^\1|(?![\s\S]))/gm, blank)
    .replace(/^>>>[\s\S]*?(?:^>>>|(?![\s\S]))/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^[ \t]*>.*$/gm, blank);
}

/**
 * Классифицирует текст ПОСЛЕ mention в команду:
 *  - review/ревью → REVIEW (все оси);
 *  - bugs/баги → BUGS;
 *  - standards/стандарты → STANDARDS;
 *  - spec/спека (+опц. источники требований) → SPEC;
 *  - пусто → REVIEW (просто «@bot» без текста);
 *  - иначе → ASK с остатком текста как вопросом.
 */
function classify(after: string): Exclude<Intent, { kind: 'IGNORE' }> {
  const rawFirst = after.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  // срезаем пунктуацию по краям: «ревью,» / «review:» → «ревью» / «review»
  const firstWord = rawFirst.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (REVIEW_KEYWORDS.includes(firstWord)) {
    return { kind: 'REVIEW' };
  }
  if (BUGS_KEYWORDS.includes(firstWord)) {
    return { kind: 'BUGS' };
  }
  if (STANDARDS_KEYWORDS.includes(firstWord)) {
    return { kind: 'STANDARDS' };
  }
  if (SPEC_KEYWORDS.includes(firstWord)) {
    return { kind: 'SPEC', specRefs: extractSpecArgs(after) };
  }
  if (after.length === 0) {
    // Просто «@bot» без текста трактуем как запрос ревью.
    return { kind: 'REVIEW' };
  }
  return { kind: 'ASK', question: after };
}

/**
 * Маршрутизация вебхука по набору бот-биндингов (мульти-движок):
 *  - заметка от ЛЮБОГО бота → null (анти-цикл: не реагируем на свои/чужие бот-комменты);
 *  - первый биндинг из `engines`, чей @handle упомянут → { engine, handle, intent };
 *  - никого не упомянули → null.
 * Анти-цикл смотрит на ВСЕ биндинги, а не только на `engines`: иначе бот, не обслуживающий
 * проект, тегнув другого бота в своей заметке, запустит переписку ботов.
 */
export function route(
  event: ParsedNoteEvent,
  bindings: readonly EngineBinding[],
  engines: readonly EngineName[] = bindings.map((b) => b.engine),
): Route | null {
  const author = event.authorUsername.toLowerCase();
  if (bindings.some((b) => b.handle.toLowerCase() === author)) return null;
  for (const b of bindings.filter((x) => engines.includes(x.engine))) {
    const after = extractAfterMention(event.noteBody, b.handle);
    if (after !== null) {
      return { engine: b.engine, handle: b.handle, intent: classify(after) };
    }
  }
  return null;
}

/**
 * Одиночный вариант (обратная совместимость / тесты): решает intent для одного бота.
 *  - свой же коммент → IGNORE (анти-цикл);
 *  - нет @mention → IGNORE;
 *  - иначе → команда через classify.
 */
export function resolveIntent(event: ParsedNoteEvent, botUsername: string): Intent {
  if (event.authorUsername.toLowerCase() === botUsername.toLowerCase()) {
    return { kind: 'IGNORE', reason: 'note authored by the bot itself' };
  }
  const after = extractAfterMention(event.noteBody, botUsername);
  if (after === null) {
    return { kind: 'IGNORE', reason: 'no @mention of the bot' };
  }
  return classify(after);
}
