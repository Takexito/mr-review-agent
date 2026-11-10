import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSpecPrompt, type SpecPromptInput, type SpecPromptTarget, type TargetsMode } from '../../codex/specPrompt.js';
import { parseAnswerOutput } from '../../codex/parseReview.js';
import { parseSpecOutput, type SpecReview } from '../../codex/parseSpec.js';
import { postRawReview } from '../../gitlab/postReview.js';
import { degradedLines, postSpecReview, SPEC_HEADING, SPEC_NOT_RUN, uncoveredTargets } from '../../gitlab/postSpecReview.js';
import { downloadImages, imageDegraded, imageHint } from '../../gitlab/uploads.js';
import { prefetchTargets } from '../../spec/prefetch.js';
import { findDirectTargets, GITLAB_ISSUE_PREFIX } from '../../spec/targets.js';
import { safeFileName } from '../../util/fileName.js';
import { mergeCoverage, type AgentRerun } from './completion.js';
import { buildCoverage, logCoverage, type KindContext, type KindHandler } from './shared.js';

export type SpecAxis =
  | { readonly state: 'skipped'; readonly reason: string }
  | {
      readonly state: 'ready';
      readonly prompt: string;
      readonly readDirs: readonly string[];
      readonly targets: readonly string[];
      /** Дочитывание целей, по которым агент не выписал ни одного пункта. */
      complete(review: SpecReview, rerun: AgentRerun | undefined): Promise<SpecReview>;
    };

function howToSetTarget(ctx: KindContext, prefixes: readonly string[]): string {
  const keyPrefix = prefixes.find((p) => p !== GITLAB_ISSUE_PREFIX);
  const example = keyPrefix ? `${keyPrefix}-123` : '#34';
  const handle = ctx.config.bindings.find((b) => b.engine === ctx.data.engine)?.handle ?? ctx.data.engine;
  const kinds = prefixes.map((p) => (p === GITLAB_ISSUE_PREFIX ? '`#…` (задача GitLab)' : `\`${p}-…\``)).join(', ');
  return (
    `Прямая цель не найдена. Укажите ключ задачи (${kinds}) в заголовке MR, в имени ветки, ` +
    `строкой \`Closes ${example}\` в описании или в команде: \`@${handle} spec ${example}\`.`
  );
}

/** Находит и скачивает прямые цели, строит промпт оси — общее для команды `spec` и общего `review`. */
export async function prepareSpecAxis(ctx: KindContext): Promise<SpecAxis> {
  const { config, data, mr, jlog, degraded, contextHints } = ctx;
  if (!ctx.profile) return { state: 'skipped', reason: 'Проект больше не входит ни в один профиль `service.yaml`.' };
  const { issueKeys } = ctx.profile;
  const prefixes = Object.keys(issueKeys);
  if (prefixes.length === 0) {
    return { state: 'skipped', reason: 'В профиле проекта не настроены `issueKeys` — прямые цели MR не определяются.' };
  }

  const found = findDirectTargets(
    { title: mr.title, branch: mr.sourceBranch, description: mr.description, args: data.specRefs },
    { issueKeys, gitlabHost: config.gitlabHost, projectPath: data.projectPath },
  );
  for (const token of found.unmatched) {
    degraded.push(`\`${token}\` из команды не подходит ни под один префикс задач профиля (${prefixes.join(', ')}).`);
  }
  if (found.targets.length === 0) return { state: 'skipped', reason: howToSetTarget(ctx, prefixes) };

  const prefetched = await prefetchTargets(found.targets, {
    connectors: config.connectors,
    open: ctx.openConnector,
    imagesDir: ctx.imagesDir,
    log: jlog,
  });
  degraded.push(...prefetched.degraded);
  jlog.info({ found: found.targets.map((t) => t.label), fetched: prefetched.fetched.map((f) => f.target.label) }, 'direct targets');
  if (prefetched.fetched.length === 0) {
    return { state: 'skipped', reason: 'Ни одна прямая цель не скачалась.' };
  }

  const dir = join(ctx.jobDir, 'targets');
  await mkdir(dir, { recursive: true });
  const targets: SpecPromptTarget[] = [];
  const hints = [...contextHints];
  for (const { target, text } of prefetched.fetched) {
    const file = join(dir, `${safeFileName(target.label)}.md`);
    await writeFile(file, text, 'utf8');
    targets.push({ label: target.label, text, file });
    // Относительные `/uploads/…` в задаче GitLab — вложения её проекта; у остальных целей `project` — проект MR.
    const images = await downloadImages(text, {
      host: config.gitlabHost,
      token: config.gitlabToken,
      dir: ctx.imagesDir,
      project: target.project,
      prefix: `target-${safeFileName(target.label)}`,
    });
    hints.push(...imageHint(`цели ${target.label}`, images));
    degraded.push(...imageDegraded(`цели ${target.label}`, images));
  }

  const size = targets.reduce((sum, t) => sum + t.text.length, 0);
  const targetsMode: TargetsMode = size > config.targetsInlineMaxChars ? 'files' : 'inline';
  const promptFor = (subset: readonly SpecPromptTarget[], followup: boolean): string => {
    const input: SpecPromptInput = {
      ...ctx.diffInput,
      projectPath: data.projectPath,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      targets: subset,
      targetsMode,
      followup,
      mrTitle: mr.title,
      mrDescription: mr.description,
      existingThreads: ctx.existingThreads,
      degraded,
      contextHints: hints,
    };
    return buildSpecPrompt(input);
  };
  const labels = targets.map((t) => t.label);

  return {
    state: 'ready',
    prompt: promptFor(targets, false),
    readDirs: [dir],
    targets: labels,
    // Как дочитывание файлов диффа: в промпте одно оглавление, и цель легко пропустить.
    complete: async (review, rerun) => {
      const missing = uncoveredTargets(review, labels);
      if (targetsMode === 'inline' || missing.length === 0 || !rerun || config.coverageFollowup.runs === 0) return review;
      const output = await rerun(promptFor(targets.filter((t) => missing.includes(t.label)), true));
      const extra = output === null ? null : parseSpecOutput(output);
      if (!extra?.ok) {
        jlog.warn({ missing }, 'targets follow-up produced no checklist');
        return review;
      }
      jlog.info({ missing, added: extra.spec.items.length }, 'targets follow-up');
      return { ...review, items: [...review.items, ...extra.spec.items], ...mergeCoverage(review, extra.spec) };
    },
  };
}

export const prepareSpec: KindHandler = async (ctx) => {
  const { data, mr, diff, api, jlog, linkify, degraded } = ctx;
  const axis = await prepareSpecAxis(ctx);
  if (axis.state === 'skipped') {
    return { skipNote: [SPEC_HEADING, '', `${SPEC_NOT_RUN} ${axis.reason}`, ...degradedLines(degraded)].join('\n') };
  }

  return {
    prompt: axis.prompt,
    readDirs: axis.readDirs,
    publish: async (output, rerun) => {
      const parsed = parseSpecOutput(output);
      if (!parsed.ok) {
        jlog.warn({ reason: parsed.reason }, 'spec JSON parse failed, posting raw');
        await postRawReview(
          api,
          data.projectId,
          data.mrIid,
          SPEC_HEADING,
          linkify(parseAnswerOutput(output)),
          buildCoverage(diff, null),
        );
        return;
      }
      const spec = await axis.complete(parsed.spec, rerun);
      const coverage = buildCoverage(diff, spec);
      logCoverage(jlog, coverage);
      await postSpecReview(api, data.projectId, data.mrIid, mr, spec, jlog, {
        targets: axis.targets,
        degraded,
        worktree: ctx.worktree,
        linkify,
        coverage,
      });
    },
  };
};
