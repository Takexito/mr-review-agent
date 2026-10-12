import type { GitlabClient } from './client.js';

export interface MrDetails {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly startSha: string;
  readonly title: string;
  readonly description: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('unexpected GitLab response (not an object)');
  }
  return value as Record<string, unknown>;
}

/** Читает ключ в snake_case или camelCase (gitbeaker может отдавать любой). */
function pickString(obj: Record<string, unknown>, snake: string, camel: string): string | undefined {
  const raw = obj[snake] ?? obj[camel];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Тянет детали MR и извлекает diff_refs (base/head/start SHA) — они нужны и для
 * вычисления диффа, и для позиционирования inline-комментариев.
 */
export async function fetchMrDetails(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
): Promise<MrDetails> {
  const mr = asRecord(await api.MergeRequests.show(projectId, mrIid));

  const sourceBranch = pickString(mr, 'source_branch', 'sourceBranch');
  const targetBranch = pickString(mr, 'target_branch', 'targetBranch');
  const refs = mr['diff_refs'] ?? mr['diffRefs'];
  if (!refs) throw new Error('MR has no diff_refs (нет коммитов/дифф пуст)');
  const refsObj = asRecord(refs);
  const baseSha = pickString(refsObj, 'base_sha', 'baseSha');
  const headSha = pickString(refsObj, 'head_sha', 'headSha');
  const startSha = pickString(refsObj, 'start_sha', 'startSha');

  if (!sourceBranch || !targetBranch || !baseSha || !headSha || !startSha) {
    throw new Error('MR response missing required fields (branches/diff_refs)');
  }
  return {
    sourceBranch,
    targetBranch,
    headSha,
    baseSha,
    startSha,
    title: pickString(mr, 'title', 'title') ?? '',
    description: pickString(mr, 'description', 'description') ?? '',
  };
}

/** Короткая заметка «взял в работу». Best-effort — ошибки не критичны. */
export async function postAck(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  body: string,
): Promise<void> {
  await api.MergeRequestNotes.create(projectId, mrIid, body);
}

/**
 * Ставит award-emoji (реакцию) на заметку-триггер — сигнал «взял в работу» без
 * отдельного коммента. Идемпотентно на практике: повторный award той же реакцией
 * вернёт ошибку «уже поставлено», поэтому вызывать через best-effort (на ретраях
 * реакция не дублируется). `name` — gemoji-имя (напр. `eyes` для 👀).
 */
export async function reactToNote(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  noteId: number,
  name: string,
): Promise<void> {
  await api.MergeRequestNoteAwardEmojis.award(projectId, mrIid, noteId, name);
}
