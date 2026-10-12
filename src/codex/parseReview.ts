import { z } from 'zod';
import { ANSWER_BEGIN, ANSWER_END, REVIEW_BEGIN, REVIEW_END } from './prompts.js';

export const ReviewCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(['info', 'warn', 'blocker']).default('info'),
  body: z.string().min(1),
});

/**
 * Самоотчёт агента о том, что он реально прочитал. Нужен только в agentic-режиме,
 * поэтому поля опциональные с дефолтами: старый или ленивый вывод не должен ронять
 * парсинг и уводить ревью в raw-fallback.
 */
export const SkippedFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().default(''),
});

export const CoverageFieldsSchema = {
  reviewedFiles: z.array(z.string()).default([]),
  skippedFiles: z.array(SkippedFileSchema).default([]),
};

/**
 * Находка, которую автор оспорил в треде, а агент, разобрав довод, всё равно считает
 * проблемой. Публикуется отдельным разделом сводки, а НЕ новым inline-тредом: повторно
 * дёргать автора в том же месте — плохой тон, но и молча проглатывать blocker нельзя.
 */
export const DisputedFindingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  body: z.string().min(1),
  reason: z.string().default(''),
});

export const ReviewSchema = z.object({
  summary: z.string().default(''),
  comments: z.array(ReviewCommentSchema).default([]),
  disputed: z.array(DisputedFindingSchema).default([]),
  ...CoverageFieldsSchema,
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type DisputedFinding = z.infer<typeof DisputedFindingSchema>;
export type Review = z.infer<typeof ReviewSchema>;

/** Вырезает содержимое между маркерами (первое вхождение). null — если не нашли пару. */
export function extractBetween(text: string, begin: string, end: string): string | null {
  const start = text.indexOf(begin);
  if (start === -1) return null;
  const from = start + begin.length;
  const stop = text.indexOf(end, from);
  if (stop === -1) return null;
  return text.slice(from, stop).trim();
}

export type ParseReviewResult =
  | { readonly ok: true; readonly review: Review }
  | { readonly ok: false; readonly reason: string };

/**
 * Достаёт JSON-ревью из вывода Codex. Терпим к «мусору» вокруг маркеров и
 * к обёртке ```json ... ```.
 */
export function parseReviewOutput(output: string): ParseReviewResult {
  const raw = extractBetween(output, REVIEW_BEGIN, REVIEW_END);
  if (raw === null) {
    return { ok: false, reason: 'review markers not found in codex output' };
  }
  const cleaned = stripCodeFence(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` };
  }
  const parsed = ReviewSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  return { ok: true, review: parsed.data };
}

/** Достаёт markdown-ответ ASK. Если маркеров нет — возвращает весь вывод как есть. */
export function parseAnswerOutput(output: string): string {
  const raw = extractBetween(output, ANSWER_BEGIN, ANSWER_END);
  return (raw ?? output).trim();
}

function stripCodeFence(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return fence?.[1]?.trim() ?? text;
}
