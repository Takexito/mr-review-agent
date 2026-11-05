import { buildStandardsPrompt } from '../../codex/standardsPrompt.js';
import { parseAnswerOutput } from '../../codex/parseReview.js';
import { parseStandardsOutput, type StandardsReview } from '../../codex/parseStandards.js';
import { postRawReview } from '../../gitlab/postReview.js';
import { postStandards, STANDARDS_HEADING } from '../../gitlab/postStandards.js';
import { buildCoverage, logCoverage, type KindContext, type KindHandler } from './shared.js';
import { completeCoverage, concatUnique, mergeCoverage, type CompletionAxis } from './completion.js';
import { mergeSummary } from './bugs.js';

export function standardsPrompt(ctx: KindContext): string {
  return buildStandardsPrompt({
    ...ctx.diffInput,
    projectPath: ctx.data.projectPath,
    sourceBranch: ctx.mr.sourceBranch,
    targetBranch: ctx.mr.targetBranch,
    existingThreads: ctx.existingThreads,
    contextHints: ctx.contextHints,
  });
}

export function standardsCompletion(ctx: KindContext): CompletionAxis<StandardsReview> {
  return {
    name: 'standards',
    prompt: (files) => standardsPrompt({ ...ctx, diffInput: { ...ctx.diffInput, files } }),
    parse: (output) => {
      const parsed = parseStandardsOutput(output);
      return parsed.ok ? parsed.review : null;
    },
    merge: (base, extra) => {
      const violations = concatUnique(base.violations, extra.violations, (v) => `${v.path}:${v.line}:${v.standard}`);
      const smells = concatUnique(base.smells, extra.smells, (s) => `${s.path}:${s.line}:${s.smell}`);
      return {
        ...mergeCoverage(base, extra),
        summary: mergeSummary(
          base.summary,
          extra.summary,
          violations.length + smells.length > base.violations.length + base.smells.length,
        ),
        standardsRead: [...new Set([...base.standardsRead, ...extra.standardsRead])],
        violations,
        smells,
        deadLetters: concatUnique(base.deadLetters, extra.deadLetters, (d) => d.standard),
        unproven: concatUnique(base.unproven, extra.unproven, (v) => `${v.path}:${v.line}:${v.standard}`),
      };
    },
  };
}

export function linkifyStandards(review: StandardsReview, linkify: (text: string) => string): StandardsReview {
  return {
    ...review,
    summary: linkify(review.summary),
    violations: review.violations.map((v) => ({ ...v, body: linkify(v.body), precedent: linkify(v.precedent) })),
    smells: review.smells.map((s) => ({ ...s, body: linkify(s.body) })),
  };
}

export const prepareStandards: KindHandler = async (ctx) => {
  const { data, mr, diff, api, jlog, linkify } = ctx;

  return {
    prompt: standardsPrompt(ctx),
    publish: async (output, rerun) => {
      const parsed = parseStandardsOutput(output);
      if (!parsed.ok) {
        jlog.warn({ reason: parsed.reason }, 'standards JSON parse failed, posting raw');
        await postRawReview(
          api,
          data.projectId,
          data.mrIid,
          STANDARDS_HEADING,
          linkify(parseAnswerOutput(output)),
          buildCoverage(diff, null),
        );
        return;
      }
      const completed = await completeCoverage(
        diff,
        parsed.review,
        standardsCompletion(ctx),
        rerun,
        ctx.config.coverageFollowup,
        jlog,
      );
      const review = linkifyStandards(completed, linkify);
      const coverage = buildCoverage(diff, completed);
      logCoverage(jlog, coverage);
      await postStandards(api, data.projectId, data.mrIid, mr, review, jlog, coverage);
    },
  };
};
