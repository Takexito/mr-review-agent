import { buildReviewPrompt } from '../../codex/prompts.js';
import { parseAnswerOutput, parseReviewOutput } from '../../codex/parseReview.js';
import { BUGS_HEADING, postRawReview, postReview } from '../../gitlab/postReview.js';
import type { Review } from '../../codex/parseReview.js';
import { buildCoverage, logCoverage, type KindContext, type KindHandler } from './shared.js';
import { completeCoverage, concatUnique, mergeCoverage, type CompletionAxis } from './completion.js';

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

/** Сводка дочитывания дописывается, только когда оно что-то нашло: иначе «багов нет» дублируется. */
export function mergeSummary(base: string, extra: string, foundMore: boolean): string {
  return foundMore && extra.trim().length > 0 ? `${base}\n\n${extra}`.trim() : base;
}

export function bugsCompletion(ctx: KindContext): CompletionAxis<Review> {
  return {
    name: 'bugs',
    prompt: (files) => bugsPrompt({ ...ctx, diffInput: { ...ctx.diffInput, files } }),
    parse: (output) => {
      const parsed = parseReviewOutput(output);
      return parsed.ok ? parsed.review : null;
    },
    merge: (base, extra) => {
      const comments = concatUnique(base.comments, extra.comments, (c) => `${c.path}:${c.line}:${c.body}`);
      const disputed = concatUnique(base.disputed, extra.disputed, (d) => `${d.path}:${d.line}:${d.body}`);
      return {
        ...mergeCoverage(base, extra),
        summary: mergeSummary(
          base.summary,
          extra.summary,
          comments.length + disputed.length > base.comments.length + base.disputed.length,
        ),
        comments,
        disputed,
      };
    },
  };
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
    publish: async (output, rerun) => {
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
          ctx.noteHeader(),
        );
        return;
      }
      const completed = await completeCoverage(diff, parsed.review, bugsCompletion(ctx), rerun, ctx.config.coverageFollowup, jlog);
      const review = linkifyBugs(completed, linkify);
      const coverage = buildCoverage(diff, completed);
      logCoverage(jlog, coverage);
      await postReview(api, data.projectId, data.mrIid, mr, review, jlog, coverage, ctx.noteHeader());
    },
  };
};
