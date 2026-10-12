import type { GitlabClient } from './client.js';

/**
 * Публикует ответ на вопрос. Если известен тред (discussionId) и исходная
 * заметка (noteId) — отвечает реплаем в тот же тред; иначе создаёт обычную заметку.
 */
export async function postAnswer(
  api: GitlabClient,
  projectId: number,
  mrIid: number,
  answer: string,
  thread: { readonly discussionId?: string; readonly noteId: number },
): Promise<void> {
  const body = ['## 🤖 Codex', '', answer.trim()].join('\n');

  if (thread.discussionId) {
    try {
      await api.MergeRequestDiscussions.addNote(projectId, mrIid, thread.discussionId, thread.noteId, body);
      return;
    } catch {
      // Тред мог быть индивидуальной заметкой — падаем на обычный коммент.
    }
  }
  await api.MergeRequestNotes.create(projectId, mrIid, body);
}
