import { describe, it, expect } from 'vitest';
import { buildSummary, MAX_INFO_COMMENTS, rankBugs } from '../src/gitlab/postReview.js';
import { buildReviewPrompt } from '../src/codex/prompts.js';
import { buildStandardsPrompt } from '../src/codex/standardsPrompt.js';
import type { Review, ReviewComment } from '../src/codex/parseReview.js';

const comment = (severity: ReviewComment['severity'], n: number): ReviewComment => ({
  path: `F${n}.kt`,
  line: n,
  severity,
  body: `${severity} ${n}`,
});

const review = (comments: ReviewComment[]): Review => ({
  summary: '',
  comments,
  disputed: [],
  reviewedFiles: [],
  skippedFiles: [],
});

describe('rankBugs', () => {
  it('should order findings blocker, warn, info', () => {
    const ranked = rankBugs(review([comment('info', 1), comment('blocker', 2), comment('warn', 3)]));
    expect(ranked.review.comments.map((c) => c.severity)).toEqual(['blocker', 'warn', 'info']);
    expect(ranked.hiddenInfo).toBe(0);
  });

  it('should keep every blocker and warn and cut info beyond the limit', () => {
    const infos = Array.from({ length: MAX_INFO_COMMENTS + 3 }, (_, i) => comment('info', i));
    const ranked = rankBugs(review([...infos, comment('warn', 99), comment('blocker', 98)]));

    expect(ranked.review.comments).toHaveLength(2 + MAX_INFO_COMMENTS);
    expect(ranked.hiddenInfo).toBe(3);
  });

  it('should report the hidden info count in the summary', () => {
    const ranked = rankBugs(review(Array.from({ length: MAX_INFO_COMMENTS + 2 }, (_, i) => comment('info', i))));
    const note = buildSummary(ranked.review, [], undefined, ranked.hiddenInfo);

    expect(note).toContain(`Замечаний: **${MAX_INFO_COMMENTS}**`);
    expect(note).toContain('Ещё мелких замечаний (info): 2');
  });
});

describe('out-of-scope block', () => {
  const base = { diffMode: 'inline' as const, diff: 'd', projectPath: 'g/p', sourceBranch: 'f', targetBranch: 'main' };

  it('should be present in the bugs and standards prompts', () => {
    expect(buildReviewPrompt(base)).toContain('ВНЕ ЗОНЫ НАХОДОК');
    expect(buildStandardsPrompt(base)).toContain('ВНЕ ЗОНЫ НАХОДОК');
  });

  it('should tell the standards axis that agent workflow instructions are not code requirements', () => {
    expect(buildStandardsPrompt(base)).toContain('Сверяй только требования к самому коду');
  });
});
