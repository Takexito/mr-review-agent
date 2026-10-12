import type { EngineName } from '../config.js';

export type JobKind = 'REVIEW' | 'BUGS' | 'STANDARDS' | 'SPEC' | 'ASK';

export interface JobData {
  readonly kind: JobKind;
  /** Каким движком исполнять (по упомянутому бот-хендлу). */
  readonly engine: EngineName;
  readonly projectId: number;
  readonly projectPath: string;
  readonly mrIid: number;
  /** id заметки-триггера — для реплая в тред. */
  readonly noteId: number;
  readonly discussionId?: string;
  readonly authorUsername: string;
  /** Текст вопроса для kind === 'ASK'. */
  readonly question?: string;
  /**
   * Источники требований, названные в команде `spec` (`#34`, `OPS-176`, URL), как написал
   * пользователь. Пусто — источники ищутся по описанию MR и имени ветки.
   */
  readonly specRefs?: readonly string[];
}
