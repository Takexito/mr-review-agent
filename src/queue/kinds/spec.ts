import { buildSpecPrompt } from '../../codex/specPrompt.js';
import { parseAnswerOutput } from '../../codex/parseReview.js';
import { parseSpecOutput } from '../../codex/parseSpec.js';
import { postRawReview } from '../../gitlab/postReview.js';
import { postSpecReview, SPEC_HEADING } from '../../gitlab/postSpecReview.js';
import { parseIssueKeyFromBranch } from '../../linear/requirements.js';
import { materializeLinear } from '../../linear/materialize.js';
import { extractSpecRefs, type SpecRef } from '../../spec/refs.js';
import { gatherSpecSources } from '../../spec/sources.js';
import { buildCoverage, logCoverage, type KindContext, type KindHandler } from './shared.js';

/**
 * Откуда брать постановку: названное в команде — как есть; иначе всё, на что ссылаются
 * описание MR и имя ветки. Автопоиск приносит и соседние задачи («это #35») — их отсеивает
 * агент на шаге «роли источников», а не регулярка.
 */
function resolveRefs(ctx: KindContext): { refs: SpecRef[]; origin: 'command' | 'mr' } {
  const { config, data, mr } = ctx;
  if (data.specRefs && data.specRefs.length > 0) {
    return {
      refs: extractSpecRefs(data.specRefs.join(' '), config.gitlabHost, { looseLinearCase: true }),
      origin: 'command',
    };
  }
  const refs = extractSpecRefs(`${mr.title}\n${mr.description}`, config.gitlabHost);
  const branchKey = parseIssueKeyFromBranch(mr.sourceBranch);
  if (branchKey && !refs.some((r) => r.kind === 'linear' && r.key === branchKey)) {
    refs.push({ kind: 'linear', key: branchKey });
  }
  return { refs, origin: 'mr' };
}

export interface SpecAxis {
  readonly prompt: string;
  readonly readDirs: readonly string[];
  /** Подписи реально скачанных источников; пусто — сверять не с чем. */
  readonly sources: readonly string[];
}

/** Скачивает источники и строит промпт оси — общее для команды `spec` и общего `review`. */
export async function prepareSpecAxis(ctx: KindContext): Promise<SpecAxis> {
  const { config, data, mr, jlog, degraded, contextHints } = ctx;
  const { refs, origin } = resolveRefs(ctx);
  if (refs.length === 0) {
    degraded.push(
      'Источник постановки не найден: ни в команде (`spec #34`, `spec PRJ-137`), ни в описании MR, ни в имени ветки.',
    );
  }

  const gathered = await gatherSpecSources(
    { config, projectId: data.projectId, downloadDir: ctx.downloadDir, log: jlog },
    refs,
  );
  degraded.push(...gathered.degraded);

  // Раскладка Linear на диск нужна ровно тогда, когда дочитать самому агент не может.
  let linearDir: string | null = null;
  const linearKey = refs.find((r): r is Extract<SpecRef, { kind: 'linear' }> => r.kind === 'linear')?.key;
  if (linearKey && !ctx.ondemand) {
    linearDir = (await materializeLinear(config, ctx.jobDir, linearKey, jlog)).dir;
    if (linearDir) {
      contextHints.push(
        `Требования, эпик, спеки и смежные задачи Linear выложены в \`${linearDir}\` — начни с \`INDEX.md\`.`,
      );
    }
  }

  const prompt = buildSpecPrompt({
    ...ctx.diffInput,
    projectPath: data.projectPath,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    sources: gathered.sources,
    sourcesOrigin: origin,
    mrTitle: mr.title,
    mrDescription: mr.description,
    existingThreads: ctx.existingThreads,
    degraded,
    contextHints,
  });

  return {
    prompt,
    readDirs: linearDir ? [linearDir] : [],
    sources: gathered.sources.map((s) => s.label),
  };
}

export const prepareSpec: KindHandler = async (ctx) => {
  const { data, mr, diff, api, jlog, linkify, degraded } = ctx;
  const axis = await prepareSpecAxis(ctx);

  return {
    prompt: axis.prompt,
    readDirs: axis.readDirs,
    publish: async (output) => {
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
      const coverage = buildCoverage(diff, parsed.spec);
      logCoverage(jlog, coverage);
      await postSpecReview(api, data.projectId, data.mrIid, mr, parsed.spec, jlog, {
        sources: axis.sources,
        degraded,
        worktree: ctx.worktree,
        linkify,
        coverage,
      });
    },
  };
};
