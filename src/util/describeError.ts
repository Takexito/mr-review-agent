import { redactSecrets } from './redact.js';

type RequestCause = {
  readonly description?: unknown;
  readonly request?: { readonly method?: unknown; readonly url?: unknown };
  readonly response?: { readonly status?: unknown };
};

function pathOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Текст ошибки для человека. У ошибки GitLab-клиента сообщение — `statusText` ответа, а по HTTP/2
 * он пустой: `String(error)` даёт голое `GitbeakerRequestError`, поэтому статус, метод, путь и
 * описание берём из `cause`. Путь — без хоста и query.
 */
export function describeError(error: unknown): string {
  const cause = (error as { cause?: RequestCause } | null)?.cause;
  const status = cause?.response?.status;
  if (typeof status !== 'number') return redactSecrets(String(error));
  const method = typeof cause?.request?.method === 'string' ? cause.request.method : '';
  const description = typeof cause?.description === 'string' ? cause.description : JSON.stringify(cause?.description ?? '');
  const request = [method, pathOf(cause?.request?.url)].filter((part) => part.length > 0).join(' ');
  return redactSecrets(`GitLab ${status}${request ? ` ${request}` : ''}: ${description}`);
}
