import { z } from 'zod';

/**
 * Схема релевантного подмножества GitLab «Note Hook» (комментарий).
 * Всё лишнее пропускаем через passthrough, чтобы не падать на изменениях payload.
 */
const NoteHookSchema = z
  .object({
    object_kind: z.literal('note'),
    user: z
      .object({
        username: z.string(),
      })
      .passthrough(),
    project: z
      .object({
        id: z.number(),
        path_with_namespace: z.string(),
      })
      .passthrough(),
    object_attributes: z
      .object({
        id: z.number(),
        note: z.string(),
        noteable_type: z.string(),
        discussion_id: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough(),
    merge_request: z
      .object({
        iid: z.number(),
        source_branch: z.string().optional(),
        target_branch: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ParsedNoteEvent {
  readonly projectId: number;
  readonly projectPath: string;
  readonly mrIid: number;
  readonly noteId: number;
  readonly noteBody: string;
  readonly authorUsername: string;
  readonly discussionId?: string;
  readonly noteUrl?: string;
}

export type ParseResult =
  | { readonly ok: true; readonly event: ParsedNoteEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * Разбирает тело вебхука. Возвращает событие только для комментариев к MR;
 * прочее (issue, commit, snippet, не-note) отсекает с понятной причиной.
 */
export function parseNoteHook(body: unknown): ParseResult {
  const parsed = NoteHookSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: `not a note hook: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}` };
  }
  const data = parsed.data;

  if (data.object_attributes.noteable_type !== 'MergeRequest') {
    return { ok: false, reason: `noteable_type=${data.object_attributes.noteable_type}, not MergeRequest` };
  }
  if (!data.merge_request) {
    return { ok: false, reason: 'merge_request block missing in payload' };
  }

  return {
    ok: true,
    event: {
      projectId: data.project.id,
      projectPath: data.project.path_with_namespace,
      mrIid: data.merge_request.iid,
      noteId: data.object_attributes.id,
      noteBody: data.object_attributes.note,
      authorUsername: data.user.username,
      discussionId: data.object_attributes.discussion_id,
      noteUrl: data.object_attributes.url,
    },
  };
}
