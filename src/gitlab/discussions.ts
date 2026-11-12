import type { GitlabClient } from './client.js';

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return String(v);
}

/**
 * Служебные заметки самого бота: ack, «упёрлись в лимит», «дифф пуст», remedy по токену,
 * сообщение о сбое. Смысла в обсуждении они не несут, но занимают место в срезе тредов и
 * читаются агентом как реальная дискуссия. Отличаем по ведущему эмодзи: содержательные
 * заметки бота начинаются иначе (`## 🤖 Codex · поиск багов`, `🔴 **blocker** — …`), поэтому
 * ревью и инлайн-замечания под фильтр не попадают и остаются видны.
 */
const SERVICE_NOTE_PREFIXES = ['👀', '🤖', '⏳', '🔑', '⚠️'] as const;

function isServiceNote(body: string): boolean {
  return SERVICE_NOTE_PREFIXES.some((p) => body.startsWith(p));
}

export interface FormatOptions {
  /**
   * Дискуссия, в которой задан текущий вопрос (ASK). Помечается в выводе, чтобы агент
   * понимал, на что именно ему отвечают — иначе реплай на его же замечание читается
   * как вопрос из ниоткуда.
   */
  readonly currentDiscussionId?: string;
  /** Без флага internal-заметки отбрасываются: ответ бота публичный и пересказал бы их всем. */
  readonly includeInternal?: boolean;
}

/**
 * Разбирает дискуссии GitLab в текстовые блоки: локация (file:line для inline),
 * статус resolved и реплики (author: body). Отсекает системные заметки GitLab и
 * служебный шум бота.
 */
export function formatDiscussions(
  discussions: readonly unknown[],
  options: FormatOptions = {},
): string {
  const blocks: string[] = [];

  for (const raw of discussions) {
    const disc = rec(raw);
    const notes = Array.isArray(disc['notes']) ? (disc['notes'] as unknown[]) : [];
    const lines: string[] = [];
    let location = 'общий';
    let resolved = false;

    for (const rn of notes) {
      const n = rec(rn);
      if (n['system'] === true) continue;
      if (!options.includeInternal && (n['internal'] === true || n['confidential'] === true)) continue;
      const body = str(n['body']).trim();
      if (body.length === 0 || isServiceNote(body)) continue;

      if (n['resolved'] === true) resolved = true;
      const pos = rec(n['position']);
      const path = str(pos['new_path'] ?? pos['newPath'] ?? pos['old_path'] ?? pos['oldPath']);
      const line = str(pos['new_line'] ?? pos['newLine'] ?? pos['old_line'] ?? pos['oldLine']);
      if (path) location = line ? `${path}:${line}` : path;

      const author = str(rec(n['author'])['username']) || '?';
      lines.push(`  ${author}: ${body}`);
    }

    if (lines.length === 0) continue;
    const isCurrent =
      options.currentDiscussionId !== undefined && str(disc['id']) === options.currentDiscussionId;
    const marks = `${resolved ? ' [resolved]' : ''}${isCurrent ? ` ${CURRENT_THREAD_MARK}` : ''}`;
    blocks.push(`[${location}]${marks}\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n');
}

/** Метка треда, в котором задан текущий вопрос. По ней же он закрепляется при обрезании. */
export const CURRENT_THREAD_MARK = '[← ВОПРОС ЗАДАН В ЭТОМ ТРЕДЕ]';

/**
 * Срез тредов для промпта. Режем по границе блока, а не посередине реплики: обрыв
 * на полуслове агент читает как искажённый текст. Если срез неполон — говорим об этом
 * прямо и подсказываем, чем дочитать.
 *
 * `pin` идёт первым и не может быть отрезан: для ASK это тред, в котором задан вопрос —
 * ровно тот, без которого ответ теряет смысл, а по порядку он обычно последний.
 */
export function truncateThreads(text: string, maxChars: number, pin?: string): string {
  if (text.length <= maxChars) return text;

  const blocks = text.split('\n\n');
  const pinned = pin ? blocks.filter((b) => b.includes(pin)) : [];
  const others = pin ? blocks.filter((b) => !b.includes(pin)) : blocks;

  const kept: string[] = [];
  let used = 0;
  for (const block of [...pinned, ...others]) {
    if (used + block.length > maxChars) break;
    kept.push(block);
    used += block.length + 2;
  }
  // Ни один блок не влез целиком — отдаём хотя бы начало важнейшего, чтобы контекст не пропал.
  if (kept.length === 0) kept.push((pinned[0] ?? blocks[0]!).slice(0, maxChars));

  const dropped = blocks.length - kept.length;
  return `${kept.join('\n\n')}\n\n…(показано ${kept.length} из ${blocks.length} тредов, ещё ${dropped} не поместились)`;
}

/** Все треды MR целиком; `currentDiscussionId` — тред вопроса (ASK), он помечается. */
export async function fetchThreads(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  options: FormatOptions = {},
): Promise<string> {
  const discussions = (await api.MergeRequestDiscussions.all(projectId, mrIid, {
    perPage: 100,
  })) as unknown[];
  return formatDiscussions(discussions, options);
}
