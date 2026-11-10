import type { ToolCall } from '../agent/journal.js';

const MAX_CALLS = 20;
const MAX_CALL_CHARS = 80;

export interface NoteHeaderInput {
  /** Журнал всех прогонов джобы. */
  readonly calls: readonly ToolCall[];
  readonly related: readonly { readonly project: string; readonly ref: string }[];
}

/**
 * Текст из журнала пишет агент (его могли подговорить текстом задачи), имя ветки — автор MR: без
 * обратных кавычек и переносов он не выйдет из код-спана, где GitLab не рендерит markdown и упоминания.
 */
function spanText(text: string): string {
  return text.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

function describeCall(call: ToolCall): string {
  const args =
    typeof call.arguments === 'object' && call.arguments !== null
      ? Object.values(call.arguments).filter((v) => ['string', 'number', 'boolean'].includes(typeof v))
      : [];
  const parts = [call.server, call.tool, ...(args.length > 0 ? [args.map(String).join(', ')] : [])];
  return spanText(parts.join(' · '));
}

const cut = (text: string): string => (text.length > MAX_CALL_CHARS ? `${text.slice(0, MAX_CALL_CHARS)}…` : text);

function callList(descriptions: readonly string[]): string {
  const shown = descriptions.slice(0, MAX_CALLS).map((d) => `\`${cut(d)}\``);
  const rest = descriptions.length - MAX_CALLS;
  return rest > 0 ? `${shown.join(', ')} и ещё ${rest}` : shown.join(', ');
}

/** Строки шапки заметки: какие источники агент открыл через коннекторы и какие ветки смежных репозиториев взяты. */
export function noteHeader(input: NoteHeaderInput): string[] {
  const opened = new Set<string>();
  const failed = new Set<string>();
  for (const call of input.calls) (call.ok ? opened : failed).add(describeCall(call));
  for (const description of opened) failed.delete(description);

  const lines: string[] = [];
  if (opened.size > 0) lines.push(`_Открыто агентом: ${callList([...opened])}._`);
  if (failed.size > 0) lines.push(`_Не открылось: ${callList([...failed])}._`);
  if (input.related.length > 0) {
    lines.push(`_Смежные репозитории: ${input.related.map((r) => `\`${spanText(r.project)}\` (\`${spanText(r.ref)}\`)`).join(', ')}._`);
  }
  return lines.length > 0 ? ['', ...lines] : [];
}

/** Вставляет шапку сразу под строкой заголовка заметки. */
export function withHeader(body: string, header: readonly string[]): string {
  if (header.length === 0) return body;
  const [heading, ...rest] = body.split('\n');
  return [heading, ...header, ...rest].join('\n');
}
