import type { AppConfig } from '../config.js';

/** Сбой обращения к Linear API (нет ключа, HTTP-ошибка, GraphQL-ошибка). */
export class LinearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearError';
  }
}

export interface LinearDocument {
  readonly title: string;
  readonly content: string;
}

export interface LinearIssue {
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly labels: readonly string[];
  /** Нативные Linear-документы, привязанные к issue (напр. снапшот спеки на эпике). */
  readonly documents: readonly LinearDocument[];
  readonly parentIdentifier?: string;
  readonly parentTitle?: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Разбирает `PRJ-137` → { teamKey:'PRJ', number:137 }. null — если формат не тот. */
export function splitIssueKey(key: string): { teamKey: string; number: number } | null {
  const m = /^([A-Za-z]{2,})-(\d+)$/.exec(key.trim());
  if (!m) return null;
  return { teamKey: m[1]!.toUpperCase(), number: Number(m[2]) };
}

const ISSUE_QUERY = `query IssueByKey($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes {
      identifier
      title
      description
      url
      labels { nodes { name } }
      documents(first: 20) { nodes { title content } }
      parent { identifier title }
    }
  }
}`;

const SEARCH_QUERY = `query SearchIssues($term: String!, $first: Int!) {
  searchIssues(term: $term, first: $first) {
    nodes {
      identifier
      title
      description
      url
      labels { nodes { name } }
      documents(first: 20) { nodes { title content } }
      parent { identifier title }
    }
  }
}`;

/** Один POST в Linear GraphQL с общей обработкой сетевых и GraphQL-ошибок. */
async function graphql(
  config: AppConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!config.linearApiKey) throw new LinearError('LINEAR_API_KEY not set');

  let res: Response;
  try {
    res = await fetch(config.linearApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: config.linearApiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new LinearError(`Linear request failed: ${String(error)}`);
  }
  if (!res.ok) throw new LinearError(`Linear HTTP ${res.status}`);

  const json = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: { message?: string }[];
  };
  if (json.errors?.length) {
    throw new LinearError(`Linear GraphQL: ${json.errors[0]?.message ?? 'unknown error'}`);
  }
  return json.data ?? {};
}

/** Разбирает узел issue из GraphQL-ответа в наш тип. */
function toIssue(node: Record<string, unknown>): LinearIssue {
  const labelsNodes = (node['labels'] as { nodes?: unknown[] } | undefined)?.nodes ?? [];
  const docNodes = (node['documents'] as { nodes?: unknown[] } | undefined)?.nodes ?? [];
  const parent = node['parent'] as Record<string, unknown> | null | undefined;
  return {
    identifier: str(node['identifier']),
    title: str(node['title']),
    description: str(node['description']),
    url: str(node['url']),
    labels: labelsNodes
      .map((l) => str((l as Record<string, unknown>)?.['name']))
      .filter((n) => n.length > 0),
    documents: docNodes
      .map((d) => {
        const dd = d as Record<string, unknown>;
        return { title: str(dd['title']), content: str(dd['content']) };
      })
      .filter((d) => d.content.trim().length > 0),
    parentIdentifier: parent?.['identifier'] ? str(parent['identifier']) : undefined,
    parentTitle: parent?.['title'] ? str(parent['title']) : undefined,
  };
}

/**
 * Тянет issue по идентификатору (`PRJ-137`) через GraphQL Linear: фильтр по ключу
 * команды + номеру (issue(id:) требует UUID, поэтому идём через issues(filter:)).
 * Возвращает null, если формат ключа неверен или задача не найдена.
 * Кидает LinearError на отсутствие ключа / сетевую / GraphQL-ошибку.
 */
export async function fetchLinearIssue(config: AppConfig, key: string): Promise<LinearIssue | null> {
  const parts = splitIssueKey(key);
  if (!parts) return null;

  const data = await graphql(config, ISSUE_QUERY, parts);
  const node = (data['issues'] as { nodes?: unknown[] } | undefined)?.nodes?.[0] as
    | Record<string, unknown>
    | undefined;
  return node ? toIssue(node) : null;
}

/** Полнотекстовый поиск по задачам — чтобы агент мог найти смежную постановку сам. */
export async function searchLinearIssues(
  config: AppConfig,
  term: string,
  limit = 10,
): Promise<LinearIssue[]> {
  const first = Math.min(Math.max(Math.trunc(limit), 1), 25);
  const data = await graphql(config, SEARCH_QUERY, { term, first });
  const nodes = (data['searchIssues'] as { nodes?: unknown[] } | undefined)?.nodes ?? [];
  return nodes.map((n) => toIssue(n as Record<string, unknown>));
}
