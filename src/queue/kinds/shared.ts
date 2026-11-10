import type { AppConfig, ProjectProfile } from '../../config.js';
import type { OpenConnector } from '../../connectors/mcpClient.js';
import type { Logger } from '../../logger.js';
import type { GitlabClient } from '../../gitlab/client.js';
import type { MrDetails } from '../../gitlab/mr.js';
import type { DiffCoverage } from '../../gitlab/coverage.js';
import type { DiffResult } from '../../git/diff.js';
import type { DiffPromptInput } from '../../codex/prompts.js';
import type { JobData } from '../job.js';
import type { AgentRerun } from './completion.js';

/** Всё, что общий пролог процессора подготовил к моменту выбора оси. */
export interface KindContext {
  readonly config: AppConfig;
  readonly data: JobData;
  readonly api: GitlabClient;
  readonly jlog: Logger;
  readonly mr: MrDetails;
  readonly diff: DiffResult;
  readonly diffInput: DiffPromptInput;
  readonly jobDir: string;
  readonly worktree: string;
  /** undefined — профиль убрали из `service.yaml`, пока джоба стояла в очереди. */
  readonly profile: ProjectProfile | undefined;
  /** Бот как MCP-клиент коннектора — для предзагрузки прямых целей. */
  readonly openConnector: OpenConnector;
  /** Куда бот складывает картинки из описания MR и прямых целей. */
  readonly imagesDir: string;
  /** Проект MR и смежные репозитории профиля: только их вложения бот скачивает своим токеном. */
  readonly allowedProjects: readonly string[];
  readonly existingThreads: string;
  /** Ось дописывает сюда свои подсказки и пометки — массивы общие с прологом. */
  readonly contextHints: string[];
  readonly degraded: string[];
  /** Переписывает абсолютные пути worktree в тексте агента на GitLab blob-ссылки. */
  readonly linkify: (text: string) => string;
}

/** Ось ревью: промпт для агента и публикация его вывода. */
export interface PreparedKind {
  readonly prompt: string;
  /** Каталоги вне worktree, которые ось выложила для агента. */
  readonly readDirs?: readonly string[];
  /** Агенту нужна запись в каталог джобы (оркестратор: суб-агенты пишут туда результаты). */
  readonly needsWrite?: boolean;
  /** `rerun` — повторный прогон тем же движком с теми же правами, для дочитывания пропущенного. */
  publish(output: string, rerun?: AgentRerun): Promise<void>;
}

/** Ось решила не запускать агента; заметка объясняет почему. */
export interface SkippedKind {
  readonly skipNote: string;
}

export type KindHandler = (ctx: KindContext) => Promise<PreparedKind | SkippedKind>;

/** Самоотчёт агента о покрытии; null — вывод не распарсился, значит отчёта нет. */
interface CoverageReport {
  readonly reviewedFiles: readonly string[];
  readonly skippedFiles: readonly { path: string; reason: string }[];
}

export function buildCoverage(diff: DiffResult, report: CoverageReport | null): DiffCoverage {
  return {
    mode: diff.mode,
    changedFiles: diff.files.filter((f) => !f.binary).map((f) => f.path),
    binaryFiles: diff.files.filter((f) => f.binary).map((f) => f.path),
    reviewedFiles: report?.reviewedFiles ?? [],
    skippedFiles: report?.skippedFiles ?? [],
  };
}

/** Неполный обход — то, ради чего всё затевалось: пусть будет видно в логах, а не только в MR. */
export function logCoverage(jlog: Logger, coverage: DiffCoverage): void {
  if (coverage.mode === 'inline') return;
  jlog.info(
    { changed: coverage.changedFiles.length, claimed: coverage.reviewedFiles.length },
    'agentic diff coverage',
  );
}
