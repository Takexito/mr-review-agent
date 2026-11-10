import { CONNECTOR_NAME_PATTERN } from '../config/schema.js';

/** Вызов инструмента коннектора в прогоне движка. */
export interface ToolCall {
  /** Имя коннектора — ключ `connectors` в `service.yaml`. */
  readonly server: string;
  readonly tool: string;
  /** Аргументы как их сформировал агент: недоверенный текст. */
  readonly arguments: unknown;
  /** Инструмент вернул результат, а не ошибку. */
  readonly ok: boolean;
}

export interface CodexEvents {
  /** Последнее сообщение агента — то, что без `--json` codex печатал в stdout. */
  readonly text: string;
  readonly calls: readonly ToolCall[];
  /** Сообщения событий `error` и `turn.failed` по порядку. */
  readonly errors: readonly string[];
  /** Из `thread.started`: на него ссылаются сессии суб-агентов, см. `subagentCalls`. */
  readonly threadId: string | null;
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null;
}

/** Событие — объект с `type`: строка `{}` в тексте ответа событием не считается. */
export function jsonEvents(stdout: string): Json[] {
  return stdout.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line) as unknown;
      return isObject(event) && typeof event['type'] === 'string' ? [event] : [];
    } catch {
      return [];
    }
  });
}

export const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Разбирает JSONL `codex exec --json`. Элемент `type: "error"` — предупреждение (устаревший ключ
 * конфигурации и т.п.), прогон после него продолжается; сбой — только события `error` и `turn.failed`.
 */
export function parseCodexEvents(stdout: string): CodexEvents {
  let text = '';
  let threadId: string | null = null;
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  for (const event of jsonEvents(stdout)) {
    if (event['type'] === 'thread.started') threadId = asString(event['thread_id']) || null;
    if (event['type'] === 'error') errors.push(asString(event['message']));
    if (event['type'] === 'turn.failed' && isObject(event['error'])) errors.push(asString(event['error']['message']));
    const item = event['item'];
    if (event['type'] !== 'item.completed' || !isObject(item)) continue;
    if (item['type'] === 'agent_message') text = asString(item['text']);
    if (item['type'] === 'mcp_tool_call') {
      calls.push({
        server: asString(item['server']),
        tool: asString(item['tool']),
        arguments: item['arguments'] ?? null,
        ok: item['status'] === 'completed',
      });
    }
  }
  return { text, calls, errors: errors.filter((e) => e.length > 0), threadId };
}

/** Встроенные инструменты claude именуются без префикса; у MCP — `mcp__<сервер>__<инструмент>`. */
const CLAUDE_MCP_TOOL = new RegExp(`^mcp__(${CONNECTOR_NAME_PATTERN})__(.+)$`);

export interface ClaudeStream {
  /** Последнее событие `result` — то же, что `--output-format json` отдавал целиком. */
  readonly result: Json | null;
  readonly calls: readonly ToolCall[];
  /** В stdout нашлось хоть одно JSON-событие. */
  readonly isStream: boolean;
}

function contentBlocks(event: Json): Json[] {
  const message = event['message'];
  if (!isObject(message) || !Array.isArray(message['content'])) return [];
  return message['content'].filter(isObject);
}

/**
 * Разбирает `claude -p --output-format stream-json`. Исход вызова приходит отдельным событием
 * `tool_result`; вызов без него (прогон оборвался) считается неудачным.
 */
export function parseClaudeStream(stdout: string): ClaudeStream {
  let result: Json | null = null;
  const pending = new Map<string, { server: string; tool: string; arguments: unknown }>();
  const order: string[] = [];
  const outcome = new Map<string, boolean>();
  const events = jsonEvents(stdout);
  for (const event of events) {
    if (event['type'] === 'result') result = event;
    for (const block of contentBlocks(event)) {
      if (block['type'] === 'tool_use') {
        const match = CLAUDE_MCP_TOOL.exec(asString(block['name']));
        const id = asString(block['id']);
        if (!match || !id) continue;
        pending.set(id, { server: match[1]!, tool: match[2]!, arguments: block['input'] ?? null });
        order.push(id);
      }
      if (block['type'] === 'tool_result') outcome.set(asString(block['tool_use_id']), block['is_error'] !== true);
    }
  }
  const calls = order.map((id) => ({ ...pending.get(id)!, ok: outcome.get(id) ?? false }));
  return { result, calls, isStream: events.length > 0 };
}
