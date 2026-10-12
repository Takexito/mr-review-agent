import { buildStandardsPrompt } from '../../codex/standardsPrompt.js';
import { parseAnswerOutput } from '../../codex/parseReview.js';
import { parseStandardsOutput, type StandardsReview } from '../../codex/parseStandards.js';
import { postRawReview } from '../../gitlab/postReview.js';
import { postStandards, STANDARDS_HEADING } from '../../gitlab/postStandards.js';
import { buildCoverage, logCoverage, type KindContext, type KindHandler } from './shared.js';

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
    publish: async (output) => {
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
      const review = linkifyStandards(parsed.review, linkify);
      const coverage = buildCoverage(diff, parsed.review);
      logCoverage(jlog, coverage);
      await postStandards(api, data.projectId, data.mrIid, mr, review, jlog, coverage);
    },
  };
};
