import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import type { JobData } from './job.js';
import type { AppConfig, EngineName } from '../config.js';
import type { Logger } from '../logger.js';
import type { GitlabClient } from '../gitlab/client.js';
import type { Agent, McpServerSpec, RunOptions } from '../agent/types.js';
import { AgentRateLimitError } from '../agent/types.js';
import { fetchMrDetails, postAck, reactToNote } from '../gitlab/mr.js';
import {
  addWorktreeAt,
  createJobDir,
  ensureBareCache,
  MissingRevisionError,
  removeJobDir,
  removeWorktree,
} from '../git/checkout.js';
import { computeDiff } from '../git/diff.js';
import { fetchExistingThreads } from '../gitlab/discussions.js';
import { makeBlobLinker } from '../gitlab/links.js';
import { gatherDocsRepo } from '../docs/docsRepo.js';
import { prepareAsk } from './kinds/ask.js';
import { prepareBugs } from './kinds/bugs.js';
import { prepareReview } from './kinds/review.js';
import { prepareSpec } from './kinds/spec.js';
import { prepareStandards } from './kinds/standards.js';
import type { KindHandler } from './kinds/shared.js';
import type { JobKind } from './job.js';

const KIND_HANDLERS: Record<JobKind, KindHandler> = {
  REVIEW: prepareReview,
  BUGS: prepareBugs,
  STANDARDS: prepareStandards,
  SPEC: prepareSpec,
  ASK: prepareAsk,
};

/** Лимит объёма существующих тредов, подкладываемых в промпт. */
const EXISTING_THREADS_MAX = 20_000;

/** Реакция-подтверждение «взял в работу» на заметку-триггер (gemoji-имя 👀). */
const ACK_REACTION = 'eyes';

/**
 * Команда shell-CLI для Linear, которую предлагаем codex. Путь считаем от собранного
 * модуля, а не хардкодим `/app/...`: так одинаково работает и в контейнере, и локально.
 */
const LINEAR_CLI = `${process.execPath} ${new URL('../cli/linear.js', import.meta.url).pathname}`;
const GITLAB_CLI = `${process.execPath} ${new URL('../cli/gitlab.js', import.meta.url).pathname}`;

const GITLAB_LINKS_HINT =
  'Ссылки на GitLab в требованиях, описаниях и тредах — полные URL и короткие `#34` / `!12` ' +
  '(задачи, merge request-ы, файлы, картинки-вложения) ' +
  'открывай сам: если на такой источник ссылается постановка — прочитай его обязательно, а если он не ' +
  'открылся — прямо скажи об этом в summary/ответе.';

/** Движки и GitLab-клиенты по имени движка (клиент = токен соответствующей бот-идентичности). */
export interface ProcessorDeps {
  readonly engines: Record<EngineName, Agent>;
  readonly clients: Partial<Record<EngineName, GitlabClient>>;
}

async function bestEffort(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

/**
 * Описание MCP-сервера ctxmcp. Поднимается движком как дочерний процесс, поэтому
 * в окружение кладём только `LINEAR_*` — GitLab-токен туда не попадает никогда.
 */
function mcpSpec(config: AppConfig, data: JobData, downloadDir: string): McpServerSpec | undefined {
  if (!config.linearApiKey && !config.gitlabReadToken) return undefined;
  return {
    name: 'ctxmcp',
    command: process.execPath,
    args: [new URL('../mcp/server.js', import.meta.url).pathname],
    env: {
      LINEAR_API_URL: config.linearApiUrl,
      ...(config.linearApiKey ? { LINEAR_API_KEY: config.linearApiKey } : {}),
      // Read-токен уезжает в MCP-процесс, а не в окружение самого движка.
      ...(config.gitlabReadToken
        ? {
            GITLAB_READ_TOKEN: config.gitlabReadToken,
            GITLAB_HOST: config.gitlabHost,
            GITLAB_PROJECT_ID: String(data.projectId),
            GITLAB_MR_IID: String(data.mrIid),
            GITLAB_DOWNLOAD_DIR: downloadDir,
          }
        : {}),
    },
  };
}

/**
 * Собирает обработчик BullMQ-джоб. Движок и GitLab-клиент выбираются по `data.engine`
 * (codex → @codex_bot, claude → @claude_bot), поэтому и запуск агента, и постинг идут
 * от нужной идентичности. Порядок: детали MR → ack → bare-кэш → дифф → worktree →
 * контекст (доки, подсказки CLI) → ось (`kinds/*`: промпт) → агент → ось (постинг) → cleanup.
 */
export function createProcessor(
  config: AppConfig,
  log: Logger,
  deps: ProcessorDeps,
): (job: Job<JobData>) => Promise<void> {
  return async (job: Job<JobData>): Promise<void> => {
    const data = job.data;
    const jlog = log.child({
      jobId: job.id,
      project: data.projectPath,
      mr: data.mrIid,
      kind: data.kind,
      engine: data.engine,
    });

    const api = deps.clients[data.engine];
    const agent = deps.engines[data.engine];
    if (!api || !agent) {
      jlog.error({ engine: data.engine }, 'no engine/client configured for job — skip');
      return;
    }
    jlog.info('job started');

    const mr = await fetchMrDetails(api, data.projectId, data.mrIid);
    // У смёрдженного MR GitLab удаляет merge-ref, и клон падает невнятной ошибкой git.
    if (mr.state !== 'opened') {
      const what = mr.state === 'merged' ? 'уже смёрджен' : 'закрыт';
      await bestEffort(postAck(api, data.projectId, data.mrIid, `🤖 MR ${what} — ревьюить нечего.`));
      jlog.info({ state: mr.state }, 'mr not open, nothing to do');
      return;
    }
    // «Взял в работу» — реакцией на коммент-триггер (идемпотентно на ретраях, без дубля заметок).
    await bestEffort(reactToNote(api, data.projectId, data.mrIid, data.noteId, ACK_REACTION));

    let cacheDir: string;
    try {
      // mrIid + requireShas: ветки целевого проекта не покрывают MR из форка и
      // force-push в target — без merge-ref агент упрётся в `bad object`.
      cacheDir = await ensureBareCache(config, data.projectPath, {
        mrIid: data.mrIid,
        requireShas: [mr.baseSha, mr.headSha],
      });
    } catch (error) {
      if (error instanceof MissingRevisionError) {
        jlog.warn({ sha: error.sha }, 'revision unreachable, cannot review');
        await bestEffort(
          postAck(
            api,
            data.projectId,
            data.mrIid,
            `🤖 Не удалось получить ревизию \`${error.sha}\` — возможно, ветку перезаписали. Перезапустите после обновления MR.`,
          ),
        );
        return;
      }
      throw error;
    }

    const diff = await computeDiff(cacheDir, mr.baseSha, mr.headSha, {
      maxBytes: config.maxDiffBytes,
      maxLines: config.maxDiffLines,
    });

    if (diff.files.length === 0) {
      await bestEffort(postAck(api, data.projectId, data.mrIid, '🤖 дифф пуст — нечего проверять.'));
      jlog.info('empty diff, nothing to do');
      return;
    }
    jlog.info({ mode: diff.mode, files: diff.files.length, lines: diff.linesChanged }, 'diff ready');

    const jobDir = await createJobDir();
    const worktree = await addWorktreeAt(cacheDir, mr.headSha, join(jobDir, 'repo'));
    let docsCacheDir: string | null = null;
    let docsDir: string | null = null;
    try {
      // Треды нужны всем режимам: осям ревью — для дедупа уже поднятого, ASK — чтобы
      // видеть тред, в который отвечает (реплай на собственное замечание бота).
      let existingThreads = '';
      try {
        existingThreads = await fetchExistingThreads(api, data.projectId, data.mrIid, EXISTING_THREADS_MAX, {
          // Помечаем и закрепляем от обрезания только тред самого вопроса.
          ...(data.kind === 'ASK' && data.discussionId ? { currentDiscussionId: data.discussionId } : {}),
        });
      } catch (error) {
        jlog.warn({ err: String(error) }, 'fetch discussions failed, continue without prior context');
      }

      // Доку выкладываем на диск для всех режимов, а не только SPEC: вопрос про контракт
      // может прийти и в ASK, и в обычном ревью.
      const docs = await gatherDocsRepo(config, jobDir, jlog);
      docsCacheDir = docs.cacheDir;
      docsDir = docs.dir;

      const degraded: string[] = [];
      if (!docs.ok) degraded.push('docs-repo недоступен боту — без сверки API-контрактов.');

      const contextHints: string[] = [];
      if (docs.dir) {
        contextHints.push(
          `Документация и API-контракты (источник истины) выложены в \`${docs.dir}\` — grep/read по всему репозиторию доки.`,
        );
      }

      // Создаём заранее: `--add-dir` у claude принимает только существующий каталог.
      const downloadDir = join(jobDir, 'gitlab-files');
      if (config.gitlabReadToken) await mkdir(downloadDir, { recursive: true });
      const mcp = mcpSpec(config, data, downloadDir);
      // MCP реально работает только у claude: codex авто-отклоняет tools/call под песочницей.
      const mcpUsable = mcp !== undefined && (agent.name === 'claude' || config.codexMcpEnabled);
      // codex вместо MCP ходит shell-CLI — ему для этого открыта сеть.
      const cliUsable = agent.name === 'codex' && config.codexOndemandLinear;

      if (mcpUsable) {
        if (config.linearApiKey) {
          contextHints.push(
            'Задачи Linear доступны инструментами `linear_get_issue` (по ключу вида PRJ-137) и `linear_search_issues`.',
          );
        }
        if (config.gitlabReadToken) {
          contextHints.push(
            'Полное описание MR — инструмент `gitlab_mr_info`, все обсуждения целиком — `gitlab_mr_notes`.',
            `${GITLAB_LINKS_HINT} Инструмент — \`gitlab_fetch_url\`.`,
          );
        }
      } else if (cliUsable) {
        if (config.linearApiKey) {
          contextHints.push(
            `Задачи Linear читаются командой \`${LINEAR_CLI} issue PRJ-137\` (описание, критерии приёмки, спеки) ` +
              `и \`${LINEAR_CLI} search "<запрос>"\`. Зови, когда встретил ссылку на смежную задачу.`,
          );
        }
        if (config.gitlabReadToken) {
          contextHints.push(
            `Полное описание MR — \`${GITLAB_CLI} mr-info\`, все обсуждения целиком — \`${GITLAB_CLI} mr-notes\` ` +
              '(в промпт попадает только срез тредов).',
            `${GITLAB_LINKS_HINT} Команда — \`${GITLAB_CLI} fetch '<url или #34>'\` (в одинарных кавычках).`,
          );
        }
      }
      // Раскладка Linear на диск нужна ровно тогда, когда дочитать самому агент не может.
      const ondemand = (mcpUsable || cliUsable) && !!config.linearApiKey;

      // Оркестратор держится на суб-агентах codex; у остальных движков общее ревью — это поиск багов.
      const kind = data.kind === 'REVIEW' && agent.name !== 'codex' ? 'BUGS' : data.kind;
      const prepared = await KIND_HANDLERS[kind]({
        config,
        data,
        api,
        jlog,
        mr,
        diff,
        diffInput: {
          diffMode: diff.mode,
          diff: diff.text,
          diffStat: diff.diffStat,
          files: diff.files,
          baseSha: mr.baseSha,
          headSha: mr.headSha,
        },
        jobDir,
        worktree,
        downloadDir,
        existingThreads,
        ondemand,
        contextHints,
        degraded,
        linkify: makeBlobLinker(worktree, config.gitlabHost, data.projectPath, mr.headSha),
      });

      const readDirs = [docsDir, config.gitlabReadToken ? downloadDir : null, ...(prepared.readDirs ?? [])].filter(
        (d): d is string => d !== null,
      );
      const runOptions: RunOptions = {
        cwd: worktree,
        jobDir,
        // Только реально существующие каталоги: `--add-dir` на несуществующий путь
        // claude проглатывает, но передавать его нечестно.
        readDirs,
        ...(prepared.needsWrite ? { needsWrite: true } : {}),
        ...(mcpUsable ? { mcp } : {}),
        ...(cliUsable && config.gitlabReadToken
          ? { mrContext: { projectId: data.projectId, mrIid: data.mrIid, downloadDir } }
          : {}),
      };

      const runCtx = { api, projectId: data.projectId, mrIid: data.mrIid, jlog };
      const output = await runAgentOrNotify(agent, prepared.prompt, runOptions, runCtx);
      if (output === null) return; // rate-limit: уведомили, не ретраим

      await prepared.publish(output, (prompt) => rerunAgent(agent, prompt, runOptions, jlog));
      await bestEffort(warnIfStale(api, data.projectId, data.mrIid, mr.headSha, jlog));
      jlog.info('job done');
    } finally {
      await removeWorktree(cacheDir, worktree);
      if (docsCacheDir && docsDir) await removeWorktree(docsCacheDir, docsDir);
      await removeJobDir(jobDir);
    }
  };
}

interface RunCtx {
  readonly api: GitlabClient;
  readonly projectId: number;
  readonly mrIid: number;
  readonly jlog: Logger;
}

/**
 * Ревью идёт десятки минут: автор успевает запушить. Замечания при этом остаются привязаны к
 * проверенной версии, но читатель должен знать, что под ними уже другой код.
 */
async function warnIfStale(api: GitlabClient, projectId: number, mrIid: number, reviewedSha: string, jlog: Logger): Promise<void> {
  const current = await fetchMrDetails(api, projectId, mrIid);
  if (current.headSha === reviewedSha) return;
  jlog.info({ reviewed: reviewedSha, current: current.headSha }, 'mr changed during review');
  await postAck(
    api,
    projectId,
    mrIid,
    `🤖 Ревью выполнено по коммиту \`${reviewedSha.slice(0, 8)}\`; пока оно шло, в MR появились новые коммиты — часть замечаний может быть неактуальна.`,
  );
}

/**
 * Дополнительный прогон уже после основного: его сбой не должен ронять джобу и терять
 * готовое ревью, поэтому любая ошибка — это null, и публикуется то, что есть.
 */
async function rerunAgent(agent: Agent, prompt: string, options: RunOptions, jlog: Logger): Promise<string | null> {
  try {
    return await agent.run(prompt, options);
  } catch (error) {
    jlog.warn({ err: String(error) }, 'agent rerun failed');
    return null;
  }
}

/** Запускает движок; на rate-limit постит заметку и возвращает null (без ретрая). */
async function runAgentOrNotify(
  agent: Agent,
  prompt: string,
  options: RunOptions,
  ctx: RunCtx,
): Promise<string | null> {
  try {
    return await agent.run(prompt, options);
  } catch (error) {
    if (error instanceof AgentRateLimitError) {
      ctx.jlog.warn('agent rate-limited, no retry');
      await bestEffort(
        postAck(ctx.api, ctx.projectId, ctx.mrIid, '⏳ Упёрлись в лимит подписки — попробуйте позже.'),
      );
      return null;
    }
    // Auth (401) — ретраибельно: часть инвалидаций транзиентна. Пробрасываем → BullMQ повторит;
    // дружелюбное «🔑» постим только после исчерпания ретраев в worker.on('failed').
    throw error;
  }
}
