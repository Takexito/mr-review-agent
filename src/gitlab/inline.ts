import type { GitlabClient } from './client.js';

export interface DiffRefs {
  readonly baseSha: string;
  readonly headSha: string;
  readonly startSha: string;
}

/**
 * Inline-дискуссия на строке НОВОЙ версии файла. Бросает, если GitLab не принял позицию
 * (строка вне диффа) — вызывающий решает, куда деградировать замечание.
 */
export async function createInlineDiscussion(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  refs: DiffRefs,
  position: { readonly path: string; readonly line: number },
  body: string,
): Promise<void> {
  await api.MergeRequestDiscussions.create(projectId, mrIid, body, {
    position: {
      baseSha: refs.baseSha,
      headSha: refs.headSha,
      startSha: refs.startSha,
      newPath: position.path,
      newLine: String(position.line),
      positionType: 'text',
    },
  });
}
