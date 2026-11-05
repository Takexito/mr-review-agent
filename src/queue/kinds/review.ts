import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildOrchestratorPrompt, type AxisName, type AxisTask } from '../../codex/orchestratorPrompt.js';
import { applyDuplicates, parseOrchestratorOutput, type AxisReviews } from '../../codex/parseOrchestrator.js';
import { parseAnswerOutput, parseReviewOutput } from '../../codex/parseReview.js';
import { parseSpecOutput } from '../../codex/parseSpec.js';
import { parseStandardsOutput } from '../../codex/parseStandards.js';
import { buildCombinedNote, type AxisSection } from '../../gitlab/postCombinedReview.js';
import { bugsSections, placeBugsInline, rankBugs } from '../../gitlab/postReview.js';
import { placeSpecInline, specSections, type PostSpecOptions } from '../../gitlab/postSpecReview.js';
import { placeViolationsInline, standardsSections } from '../../gitlab/postStandards.js';
import { bugsCompletion, bugsPrompt, linkifyBugs } from './bugs.js';
import { prepareSpecAxis } from './spec.js';
import { linkifyStandards, standardsCompletion, standardsPrompt } from './standards.js';
import { buildCoverage, logCoverage, type KindHandler } from './shared.js';
import { completeCoverage } from './completion.js';

type AxisFile = { readonly state: 'missing' } | { readonly state: 'text'; readonly text: string };

async function readAxisFile(path: string): Promise<AxisFile> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().length > 0 ? { state: 'text', text } : { state: 'missing' };
  } catch {
    return { state: 'missing' };
  }
}

/**
 * Промпты и результаты осей ходят через файлы, а не через ответ оркестратора: в его
 * пересказе менялись бы и задания суб-агентов, и сами находки.
 */
export const prepareReview: KindHandler = async (ctx) => {
  const { data, mr, diff, api, jlog, linkify, degraded } = ctx;
  const dir = join(ctx.jobDir, 'review');
  await mkdir(dir, { recursive: true });

  // Порядок важен: ось постановки дописывает свои подсказки в общий `contextHints`,
  // поэтому промпты остальных осей строятся до неё.
  const file = (name: string, kind: 'prompt' | 'out'): string => join(dir, `${name}.${kind}.md`);
  const prompts: { axis: AxisName; prompt: string }[] = [
    { axis: 'bugs', prompt: bugsPrompt(ctx) },
    { axis: 'standards', prompt: standardsPrompt(ctx) },
  ];
  const spec = await prepareSpecAxis(ctx);
  if (spec.sources.length > 0) prompts.push({ axis: 'spec', prompt: spec.prompt });

  const tasks: AxisTask[] = [];
  for (const { axis, prompt } of prompts) {
    const task: AxisTask = { axis, promptFile: file(axis, 'prompt'), outputFile: file(axis, 'out') };
    await writeFile(task.promptFile, prompt, 'utf8');
    tasks.push(task);
  }

  return {
    prompt: buildOrchestratorPrompt({
      projectPath: data.projectPath,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      tasks,
    }),
    readDirs: [dir, ...spec.readDirs],
    needsWrite: true,
    publish: async (orchestratorOutput, rerun) => {
      const files = new Map<string, AxisFile>();
      for (const task of tasks) files.set(task.axis, await readAxisFile(task.outputFile));
      const text = (name: string): string | null => {
        const found = files.get(name);
        return found?.state === 'text' ? found.text : null;
      };

      const bugsText = text('bugs');
      const standardsText = text('standards');
      const specText = text('spec');
      const bugs = bugsText === null ? null : parseReviewOutput(bugsText);
      const standards = standardsText === null ? null : parseStandardsOutput(standardsText);
      const specParsed = specText === null ? null : parseSpecOutput(specText);

      // Дочитанное дописывается в конец списков, поэтому индексы `ось:список:N` из ответа
      // оркестратора по-прежнему указывают на те же находки.
      const limits = ctx.config.coverageFollowup;
      const [bugsReview, standardsReview] = await Promise.all([
        bugs?.ok ? completeCoverage(diff, bugs.review, bugsCompletion(ctx), rerun, limits, jlog) : null,
        standards?.ok
          ? completeCoverage(diff, standards.review, standardsCompletion(ctx), rerun, limits, jlog)
          : null,
      ]);

      const reviews: AxisReviews = {
        ...(bugsReview ? { bugs: linkifyBugs(bugsReview, linkify) } : {}),
        ...(standardsReview ? { standards: linkifyStandards(standardsReview, linkify) } : {}),
        ...(specParsed?.ok ? { spec: specParsed.spec } : {}),
      };
      const consolidation = parseOrchestratorOutput(orchestratorOutput);
      if (!consolidation) jlog.warn('orchestrator consolidation missing, publishing axes as is');
      const deduped = applyDuplicates(reviews, consolidation);
      jlog.info(
        {
          axes: tasks.map((t) => `${t.axis}:${files.get(t.axis)?.state ?? 'missing'}`),
          duplicates: consolidation?.duplicates.length ?? 0,
        },
        'review axes collected',
      );

      const unparsed = (axis: AxisName, skipped?: string): AxisSection => {
        if (skipped !== undefined) return { state: 'skipped', reason: skipped };
        const raw = text(axis);
        return raw === null ? { state: 'missing' } : { state: 'raw', text: linkify(parseAnswerOutput(raw)) };
      };

      let bugsSection = unparsed('bugs');
      if (deduped.bugs && bugsReview) {
        const coverage = buildCoverage(diff, bugsReview);
        logCoverage(jlog, coverage);
        const ranked = rankBugs(deduped.bugs);
        const unplaced = await placeBugsInline(api, data.projectId, data.mrIid, mr, ranked.review, jlog);
        bugsSection = { state: 'ok', lines: bugsSections(ranked.review, unplaced, coverage, ranked.hiddenInfo) };
      }

      let standardsSection = unparsed('standards');
      if (deduped.standards && standardsReview) {
        const coverage = buildCoverage(diff, standardsReview);
        const unplaced = await placeViolationsInline(api, data.projectId, data.mrIid, mr, deduped.standards, jlog);
        standardsSection = { state: 'ok', lines: standardsSections(deduped.standards, unplaced, coverage) };
      }

      let specSection = unparsed(
        'spec',
        spec.sources.length === 0 ? `Сверка с постановкой не запускалась. ${degraded.join(' ')}`.trim() : undefined,
      );
      if (deduped.spec && specParsed?.ok) {
        const options: PostSpecOptions = {
          sources: spec.sources,
          degraded,
          worktree: ctx.worktree,
          linkify,
          coverage: buildCoverage(diff, specParsed.spec),
          skipInline: deduped.specSkipInline,
        };
        await placeSpecInline(api, data.projectId, data.mrIid, mr, deduped.spec, jlog, options);
        specSection = { state: 'ok', lines: specSections(deduped.spec, options) };
      }

      await api.MergeRequestNotes.create(
        data.projectId,
        data.mrIid,
        buildCombinedNote(
          linkify(consolidation?.summary ?? ''),
          { bugs: bugsSection, standards: standardsSection, spec: specSection },
          consolidation !== null,
        ),
      );
    },
  };
};
