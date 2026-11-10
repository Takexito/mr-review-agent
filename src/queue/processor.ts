import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import type { JobData } from './job.js';
import { resolveProfile, type AppConfig, type EngineName, type ProjectProfile } from '../config.js';
import type { Logger } from '../logger.js';
import type { GitlabClient } from '../gitlab/client.js';
import type { Agent, RunOptions } from '../agent/types.js';
import type { ToolCall } from '../agent/journal.js';
import { noteHeader } from '../gitlab/noteHeader.js';
import { NO_ACCESS, type AgentAccess } from '../connectors/engineConfig.js';
import { openConnector, type OpenConnector } from '../connectors/mcpClient.js';
import { AgentRateLimitError } from '../agent/types.js';
import { fetchMrDetails, postAck, reactToNote } from '../gitlab/mr.js';
import {
  addWorktreeAt,
  createJobDir,
  defaultBranch,
  ensureBareCache,
  MissingRevisionError,
  readBranchFile,
  RepoFileTooLargeError,
  removeJobDir,
  removeWorktree,
} from '../git/checkout.js';
import { computeDiff } from '../git/diff.js';
import { applyRepoConfig, REPO_CONFIG_FILE, type RepoConfigResult } from '../config/repoConfig.js';
import { CURRENT_THREAD_MARK, fetchThreads, truncateThreads } from '../gitlab/discussions.js';
import { makeBlobLinker } from '../gitlab/links.js';
import { downloadImages, imageDegraded, imageHint } from '../gitlab/uploads.js';
import { checkoutRelated, type RelatedCheckout, type RelatedResult } from '../related/checkout.js';
import { prepareAsk } from './kinds/ask.js';
import { prepareBugs } from './kinds/bugs.js';
import { prepareReview } from './kinds/review.js';
import { prepareSpec, specSkipNote } from './kinds/spec.js';
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


/** Движки и GitLab-клиенты по имени движка (клиент = токен соответствующей бот-идентичности). */
export interface ProcessorDeps {
  readonly engines: Record<EngineName, Agent>;
  readonly clients: Partial<Record<EngineName, GitlabClient>>;
  readonly openConnector?: OpenConnector;
}

async function bestEffort(promise: Promise<unknown>): Promise<void> {
  await promise.catch(() => undefined);
}

/** Джоба могла встать в очередь до правки `service.yaml`, убравшей профиль, — тогда агенту ничего не открываем. */
function agentAccess(config: AppConfig, profile: ProjectProfile | undefined): AgentAccess {
  if (!profile) return NO_ACCESS;
  return {
    connectors: profile.connectors.map((name) => ({ name, config: config.connectors[name]! })),
    agentNetwork: profile.agentNetwork,
    cliTools: profile.cliTools,
  };
}

function relatedHint(repo: RelatedCheckout, engine: EngineName): string {
  let text = `Смежный репозиторий \`${repo.project}\` (ветка \`${repo.ref}\`) выложен в \`${repo.dir}\` — grep/read по всему репозиторию.`;
  // У claude `Bash(git show *)` не совпадает с `git -C …`, и dontAsk отклонит команду.
  if (engine === 'codex') text += ` Другие ветки — \`git -C ${repo.dir} show <ветка>:<файл>\`.`;
  return repo.hint ? `${text} ${repo.hint}` : text;
}

function accessHints(access: AgentAccess): string[] {
  const hints = access.connectors.flatMap(({ name, config }) =>
    config.hint ? [`MCP-сервер \`${name}\`: ${config.hint}`] : [],
  );
  if (access.cliTools.length > 0) {
    hints.push(`Доступные CLI-инструменты: ${access.cliTools.map((t) => `\`${t.name}\``).join(', ')}.`);
  }
  return hints;
}

/** Описание и все треды MR — файлами: в промпт треды попадают срезом, а описание не попадает вовсе. */
async function writeMrFiles(
  api: GitlabClient,
  data: JobData,
  mr: { title: string; description: string },
  jobDir: string,
  jlog: Logger,
): Promise<{ dir: string; excerpt: string }> {
  const dir = join(jobDir, 'mr');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'description.md'), `# ${mr.title}\n\n${mr.description}\n`, 'utf8');
  // Помечаем и закрепляем от обрезания только тред самого вопроса.
  const current = data.kind === 'ASK' ? data.discussionId : undefined;
  let threads = '';
  let threadsFile = '(обсуждений нет)\n';
  try {
    threads = await fetchThreads(api, data.projectId, data.mrIid, current);
    if (threads) threadsFile = threads;
  } catch (error) {
    jlog.warn({ err: String(error) }, 'fetch discussions failed, continue without prior context');
    // Иначе агент прочтёт «обсуждений нет» и решит, что уже поднятого в MR ничего нет.
    threadsFile = '(обсуждения MR не загрузились — их содержимое неизвестно)\n';
  }
  await writeFile(join(dir, 'threads.md'), threadsFile, 'utf8');
  const excerpt = threads ? truncateThreads(threads, EXISTING_THREADS_MAX, current ? CURRENT_THREAD_MARK : undefined) : '';
  return { dir, excerpt };
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

    const baseProfile = resolveProfile(config, data.projectPath);
    const repoBranch = await repoConfigBranch(api, data.projectId, mr.targetBranch, cacheDir, jlog);
    const repo = baseProfile ? await loadRepoConfig(cacheDir, repoBranch, baseProfile) : null;
    // На каждый вопрос в треде одна и та же заметка была бы шумом: хватает её у ревью.
    if (repo && repo.errors.length > 0 && data.kind !== 'ASK') {
      jlog.warn({ errors: repo.errors }, 'repository config ignored');
      await bestEffort(
        postAck(
          api,
          data.projectId,
          data.mrIid,
          [`⚠️ \`${REPO_CONFIG_FILE}\` в ветке \`${repoBranch}\` проигнорирован — ревью идёт по настройкам профиля:`, ...repo.errors.map((e) => `- ${e}`)].join('\n'),
        ),
      );
    }
    const profile = repo?.profile;
    const exclude = repo?.exclude ?? [];

    const diff = await computeDiff(cacheDir, mr.baseSha, mr.headSha, {
      exclude,
      maxBytes: config.maxDiffBytes,
      maxLines: config.maxDiffLines,
    });

    if (diff.files.length === 0) {
      const why = exclude.length > 0 ? ` (без путей из \`exclude\` в \`${REPO_CONFIG_FILE}\`)` : '';
      await bestEffort(postAck(api, data.projectId, data.mrIid, `🤖 дифф пуст${why} — нечего проверять.`));
      jlog.info('empty diff, nothing to do');
      return;
    }
    jlog.info({ mode: diff.mode, files: diff.files.length, lines: diff.linesChanged }, 'diff ready');

    const allowedProjects = [data.projectPath, ...(profile?.related ?? []).map((r) => r.project)];
    const specSkip = data.kind === 'SPEC' ? specSkipNote({ config, data, mr, profile, allowedProjects }) : null;
    if (specSkip !== null) {
      await api.MergeRequestNotes.create(data.projectId, data.mrIid, specSkip);
      jlog.info('no direct target, agent not started');
      return;
    }

    const jobDir = await createJobDir();
    const worktree = await addWorktreeAt(cacheDir, mr.headSha, join(jobDir, 'repo'));
    let relatedCheckouts: RelatedResult | null = null;
    try {
      // Треды нужны всем режимам: осям ревью — для дедупа уже поднятого, ASK — чтобы
      // видеть тред, в который отвечает (реплай на собственное замечание бота).
      const mrFiles = await writeMrFiles(api, data, mr, jobDir, jlog);

      const related = await checkoutRelated(profile?.related ?? [], { jobDir, sourceBranch: mr.sourceBranch }, jlog, {
        ensureCache: (project) => ensureBareCache(config, project),
      });
      relatedCheckouts = related;
      jlog.info({ related: related.repos.map((r) => `${r.project}@${r.ref}`) }, 'related repositories ready');

      // Создаём заранее: `--add-dir` у claude принимает только существующий каталог.
      const imagesDir = join(jobDir, 'images');
      await mkdir(imagesDir, { recursive: true });
      const mrImages = await downloadImages(mr.description, {
        host: config.gitlabHost,
        token: config.gitlabToken,
        dir: imagesDir,
        project: data.projectPath,
        allowedProjects,
        prefix: 'mr',
      });

      const degraded: string[] = [...related.degraded, ...imageDegraded('описания MR', mrImages)];
      const contextHints: string[] = [
        `Описание MR и все его обсуждения целиком лежат в \`${mrFiles.dir}\` (\`description.md\`, \`threads.md\`).`,
        ...imageHint('описания MR', mrImages),
        ...(exclude.length > 0
          ? [`Пути, исключённые из ревью в \`${REPO_CONFIG_FILE}\`: ${exclude.map((e) => `\`${e}\``).join(', ')} — в дифф они не вошли, замечаний по ним не пиши.`]
          : []),
        ...related.repos.map((r) => relatedHint(r, agent.name)),
      ];

      const access = agentAccess(config, profile);
      contextHints.push(...accessHints(access));
      // Один на джобу: дочитывания идут с теми же `runOptions` и дописывают сюда же.
      const journal: ToolCall[] = [];

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
          exclude,
          files: diff.files,
          baseSha: mr.baseSha,
          headSha: mr.headSha,
        },
        jobDir,
        worktree,
        profile,
        repo: { exclude, standards: repo?.standards ?? [], branch: repoBranch },
        openConnector: deps.openConnector ?? openConnector,
        imagesDir,
        allowedProjects,
        existingThreads: mrFiles.excerpt,
        contextHints,
        degraded,
        noteHeader: () => noteHeader({ calls: journal, related: related.repos }),
        linkify: makeBlobLinker(worktree, config.gitlabHost, data.projectPath, mr.headSha),
      });

      if ('skipNote' in prepared) {
        await api.MergeRequestNotes.create(data.projectId, data.mrIid, prepared.skipNote);
        jlog.info('axis skipped, agent not started');
        return;
      }

      const readDirs = [...related.repos.map((r) => r.dir), mrFiles.dir, imagesDir, ...(prepared.readDirs ?? [])];
      const runOptions: RunOptions = {
        cwd: worktree,
        jobDir,
        readDirs,
        ...(prepared.needsWrite ? { needsWrite: true } : {}),
        access,
        journal,
      };

      const runCtx = { api, projectId: data.projectId, mrIid: data.mrIid, jlog };
      const output = await runAgentOrNotify(agent, prepared.prompt, runOptions, runCtx);
      if (output === null) return; // rate-limit: уведомили, не ретраим

      await prepared.publish(output, (prompt) => rerunAgent(agent, prompt, runOptions, jlog));
      jlog.info({ calls: journal.map((c) => `${c.server}.${c.tool}:${c.ok ? 'ok' : 'failed'}`) }, 'agent tool calls');
      await bestEffort(warnIfStale(api, data.projectId, data.mrIid, mr.headSha, jlog));
      jlog.info('job done');
    } finally {
      await removeWorktree(cacheDir, worktree);
      await relatedCheckouts?.cleanup();
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
 * Target-ветку MR может создать сам автор MR и положить туда свой `.review.yml` (`exclude: ["**"]`).
 * Поэтому она годится, только если менять её может не каждый разработчик: защищённая или по умолчанию.
 */
async function repoConfigBranch(
  api: GitlabClient,
  projectId: number,
  targetBranch: string,
  cacheDir: string,
  jlog: Logger,
): Promise<string> {
  try {
    const branch = (await api.Branches.show(projectId, targetBranch)) as { protected?: boolean; default?: boolean };
    if (branch.protected || branch.default) return targetBranch;
  } catch (error) {
    jlog.warn({ err: String(error), branch: targetBranch }, 'target branch protection unknown, using default branch config');
  }
  return defaultBranch(cacheDir);
}

async function loadRepoConfig(cacheDir: string, branch: string, profile: ProjectProfile): Promise<RepoConfigResult> {
  try {
    return applyRepoConfig(await readBranchFile(cacheDir, branch, REPO_CONFIG_FILE), profile);
  } catch (error) {
    if (!(error instanceof RepoFileTooLargeError)) throw error;
    return { ...applyRepoConfig(null, profile), errors: [error.message] };
  }
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
