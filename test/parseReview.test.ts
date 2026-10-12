import { describe, it, expect } from 'vitest';
import { parseReviewOutput, parseAnswerOutput, extractBetween } from '../src/codex/parseReview.js';
import {
  REVIEW_BEGIN,
  REVIEW_END,
  ANSWER_BEGIN,
  ANSWER_END,
} from '../src/codex/prompts.js';

function wrapReview(json: string): string {
  return `какой-то лог codex\n${REVIEW_BEGIN}\n${json}\n${REVIEW_END}\nхвост`;
}

describe('extractBetween', () => {
  it('should return content between markers', () => {
    expect(extractBetween('a[X]b', '[', ']')).toBe('X');
  });
  it('should return null when the closing marker is missing', () => {
    expect(extractBetween('a[X', '[', ']')).toBeNull();
  });
});

describe('parseReviewOutput', () => {
  it('should parse a valid review JSON surrounded by log noise', () => {
    const out = wrapReview(
      JSON.stringify({
        summary: 'ок в целом',
        comments: [{ path: 'app/Mapper.kt', line: 12, severity: 'warn', body: 'nullable' }],
      }),
    );
    const res = parseReviewOutput(out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.review.comments).toHaveLength(1);
    expect(res.review.comments[0]?.severity).toBe('warn');
  });

  it('should tolerate a ```json code fence inside the markers', () => {
    const out = wrapReview('```json\n{"summary":"s","comments":[]}\n```');
    const res = parseReviewOutput(out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.review.comments).toHaveLength(0);
  });

  it('should default severity to info when omitted', () => {
    const out = wrapReview('{"summary":"s","comments":[{"path":"a.kt","line":1,"body":"x"}]}');
    const res = parseReviewOutput(out);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.review.comments[0]?.severity).toBe('info');
  });

  it('should fail when markers are absent', () => {
    const res = parseReviewOutput('no markers here');
    expect(res.ok).toBe(false);
  });

  it('should fail on invalid JSON between markers', () => {
    const res = parseReviewOutput(wrapReview('{not json'));
    expect(res.ok).toBe(false);
  });
});

describe('parseAnswerOutput', () => {
  it('should extract text between answer markers', () => {
    const out = `log\n${ANSWER_BEGIN}\nэто ответ\n${ANSWER_END}\n`;
    expect(parseAnswerOutput(out)).toBe('это ответ');
  });

  it('should fall back to the whole output when markers are missing', () => {
    expect(parseAnswerOutput('просто текст')).toBe('просто текст');
  });
});
