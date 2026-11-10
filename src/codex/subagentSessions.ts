import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { asString, isObject, jsonEvents, type ToolCall } from '../agent/journal.js';

/** Запас на расхождение часов ФС и процесса: иначе сессия, начатая в ту же секунду, отсеялась бы по mtime. */
const MTIME_SLACK_MS = 60_000;
/** В `session_meta` лежат базовые инструкции агента — десятки КБ; дальше строку не ищем. */
const MAX_META_BYTES = 1024 * 1024;

/** Каталог сессий одного дня; день — по местному времени процесса, как у codex. */
export function sessionDayDir(codexHome: string, day: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return join(codexHome, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
}

/** День до и после захватывают полночь и сдвиг часового пояса между ботом и codex. */
function dayDirs(codexHome: string, from: Date, to: Date): string[] {
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  const dirs: string[] = [];
  for (; day <= last; day.setDate(day.getDate() + 1)) dirs.push(sessionDayDir(codexHome, day));
  return dirs;
}

interface SessionMeta {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly path: string;
}

/** Первая строка файла: сессии других джоб и родителя — мегабайты, а нужен только `session_meta`. */
async function firstLine(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_META_BYTES) {
      const { bytesRead, buffer } = await file.read({ buffer: Buffer.alloc(64 * 1024), position: total });
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      total += bytesRead;
      if (newline !== -1) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await file.close();
  }
}

function parseMeta(line: string, path: string): SessionMeta | null {
  const [event] = jsonEvents(line);
  const payload = event?.['payload'];
  if (event?.['type'] !== 'session_meta' || !isObject(payload)) return null;
  const id = asString(payload['id']);
  return id ? { id, parentThreadId: asString(payload['parent_thread_id']) || null, path } : null;
}

/**
 * Вызовы коннекторов в сессии `rollout-*.jsonl` (codex 0.166): элементы `McpToolCall` событий
 * `item_completed`. Формат внутренний, codex его не обещает — при обновлении codex сверить с живой
 * сессией суб-агента. Недописанная последняя строка пропускается.
 */
export function parseSessionCalls(jsonl: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of jsonEvents(jsonl)) {
    const payload = event['payload'];
    if (event['type'] !== 'event_msg' || !isObject(payload) || payload['type'] !== 'item_completed') continue;
    const item = payload['item'];
    if (!isObject(item) || item['type'] !== 'McpToolCall') continue;
    const result = item['result'];
    calls.push({
      server: asString(item['server']),
      tool: asString(item['tool']),
      arguments: item['arguments'] ?? null,
      ok: item['status'] === 'completed' && !(isObject(result) && result['isError'] === true),
    });
  }
  return calls;
}

async function recentSessions(codexHome: string, since: Date): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];
  for (const dir of dayDirs(codexHome, since, new Date())) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl')).sort()) {
      const path = join(dir, name);
      try {
        if ((await stat(path)).mtimeMs < since.getTime() - MTIME_SLACK_MS) continue;
        const meta = parseMeta(await firstLine(path), path);
        if (meta) sessions.push(meta);
      } catch {
        // Файл мог удалиться между readdir и чтением — без него журнал только неполнее.
      }
    }
  }
  return sessions;
}

/**
 * Вызовы коннекторов суб-агентов прогона `rootThreadId` любой глубины: в поток `--json` родителя
 * codex их не пишет. Id сессии суб-агента — его `thread_id`, на него ссылаются его суб-агенты.
 * Ничего не бросает.
 */
export async function subagentCalls(codexHome: string, rootThreadId: string, since: Date): Promise<ToolCall[]> {
  const sessions = await recentSessions(codexHome, since).catch(() => []);
  const calls: ToolCall[] = [];
  const seen = new Set([rootThreadId]);
  let level = [rootThreadId];
  while (level.length > 0) {
    const children = sessions.filter((s) => s.parentThreadId !== null && level.includes(s.parentThreadId) && !seen.has(s.id));
    for (const child of children) {
      seen.add(child.id);
      calls.push(...parseSessionCalls(await readFile(child.path, 'utf8').catch(() => '')));
    }
    level = children.map((c) => c.id);
  }
  return calls;
}
