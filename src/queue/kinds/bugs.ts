import { buildReviewPrompt } from '../../codex/prompts.js';
import { parseAnswerOutput, parseReviewOutput } from '../../codex/parseReview.js';
import { BUGS_HEADING, postRawReview, postReview } from '../../gitlab/postReview.js';
import type { Review } from '../../codex/parseReview.js';
import { buildCoverage, logCoverage, type KindContext, type KindHandler } from './shared.js';

export function bugsPrompt(ctx: KindContext): string {
  return buildReviewPrompt({
    ...ctx.diffInput,
    projectPath: ctx.data.projectPath,
    sourceBranch: ctx.mr.sourceBranch,
    targetBranch: ctx.mr.targetBranch,
    existingThreads: ctx.existingThreads,
    contextHints: ctx.contextHints,
  });
}

export function linkifyBugs(review: Review, linkify: (text: string) => string): Review {
  return {
    ...review,
    summary: linkify(review.summary),
    comments: review.comments.map((c) => ({ ...c, body: linkify(c.body) })),
    disputed: review.disputed.map((d) => ({ ...d, body: linkify(d.body), reason: linkify(d.reason) })),
  };
}

export const prepareBugs: KindHandler = async (ctx) => {
  const { data, mr, diff, api, jlog, linkify } = ctx;
  const prompt = bugsPrompt(ctx);

  return {
    prompt,
    publish: async (output) => {
      const parsed = parseReviewOutput(output);
      if (!parsed.ok) {
        jlog.warn({ reason: parsed.reason }, 'review JSON parse failed, posting raw');
        await postRawReview(
          api,
          data.projectId,
          data.mrIid,
          BUGS_HEADING,
          linkify(parseAnswerOutput(output)),
          buildCoverage(diff, null),
        );
        return;
      }
      const review = linkifyBugs(parsed.review, linkify);
      const coverage = buildCoverage(diff, parsed.review);
      logCoverage(jlog, coverage);
      await postReview(api, data.projectId, data.mrIid, mr, review, jlog, coverage);
    },
  };
};
