import type { AppConfig } from '../config.js';
import { fetchLinearIssue, type LinearDocument, type LinearIssue } from './client.js';

/** Первый идентификатор задачи в имени ветки: `dev/prj-137-…` → `PRJ-137`. */
const BRANCH_KEY_RE = /([a-z]{2,})-(\d+)/i;

export function parseIssueKeyFromBranch(branch: string): string | undefined {
  const m = BRANCH_KEY_RE.exec(branch);
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : undefined;
}

export interface Requirements {
  readonly issueKey: string;
  /** Отформатированная задача (критерии приёмки в description) или null, если не найдена. */
  readonly task: string | null;
  /** Отформатированный родительский эпик или null. */
  readonly epic: string | null;
  /** Ключ родительского эпика или null. */
  readonly epicKey: string | null;
  /** Фиче-спека — контент Linear-документов задачи и эпика (снапшот Google Doc) или null. */
  readonly spec: string | null;
}

/** Компактное текстовое представление issue для промпта. */
export function formatIssue(issue: LinearIssue): string {
  const head = `### ${issue.identifier}: ${issue.title}`;
  const labels = issue.labels.length > 0 ? `\nМетки: ${issue.labels.join(', ')}` : '';
  const desc = issue.description.trim();
  const body = desc.length > 0 ? `\n\n${desc}` : '\n\n(без описания)';
  return `${head}${labels}${body}`;
}

function formatDocuments(docs: readonly LinearDocument[]): string[] {
  return docs
    .filter((d) => d.content.trim().length > 0)
    .map((d) => `## ${d.title}\n\n${d.content.trim()}`);
}

/**
 * Собирает требования по задаче: саму задачу + её родительский эпик (сквозные факты
 * и BE-контракты) + фиче-спеку из привязанных Linear-документов (задачи и эпика).
 * Родителя тянем отдельным запросом; его недоступность не критична.
 */
export async function fetchRequirements(config: AppConfig, key: string): Promise<Requirements> {
  const issue = await fetchLinearIssue(config, key);
  if (!issue) return { issueKey: key, task: null, epic: null, epicKey: null, spec: null };

  const specParts: string[] = formatDocuments(issue.documents);
  let epic: string | null = null;
  let epicKey: string | null = null;
  if (issue.parentIdentifier) {
    epicKey = issue.parentIdentifier;
    const parent = await fetchLinearIssue(config, issue.parentIdentifier).catch(() => null);
    if (parent) {
      epic = formatIssue(parent);
      specParts.push(...formatDocuments(parent.documents));
    }
  }
  return {
    issueKey: issue.identifier || key,
    task: formatIssue(issue),
    epic,
    epicKey,
    spec: specParts.length > 0 ? specParts.join('\n\n---\n\n') : null,
  };
}
