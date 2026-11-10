import { z } from 'zod';
import { CoverageFieldsSchema, extractBetween } from './parseReview.js';
import { SPEC_BEGIN, SPEC_END } from './prompts.js';

export const SpecStatusSchema = z.enum(['met', 'violated', 'unclear', 'na']);
export type SpecStatus = z.infer<typeof SpecStatusSchema>;

export const SpecItemSchema = z.object({
  /** Метка прямой цели, из которой взят пункт (`PRJ-137`) — по ней бот сверяет покрытие целей. */
  target: z.string().default(''),
  requirement: z.string().min(1),
  status: SpecStatusSchema.default('unclear'),
  evidence: z.string().default(''),
  note: z.string().default(''),
});

/** Изменение, которого постановка не просила (scope creep). */
export const SpecExtraSchema = z.object({
  what: z.string().min(1),
  evidence: z.string().default(''),
  note: z.string().default(''),
});

export const SpecReviewSchema = z.object({
  summary: z.string().default(''),
  items: z.array(SpecItemSchema).default([]),
  extras: z.array(SpecExtraSchema).default([]),
  // Тот же самоотчёт о покрытии, что и в REVIEW — SPEC тоже ходит по диффу сам.
  ...CoverageFieldsSchema,
});

export type SpecItem = z.infer<typeof SpecItemSchema>;
export type SpecExtra = z.infer<typeof SpecExtraSchema>;
export type SpecReview = z.infer<typeof SpecReviewSchema>;

export type ParseSpecResult =
  | { readonly ok: true; readonly spec: SpecReview }
  | { readonly ok: false; readonly reason: string };

function stripCodeFence(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return fence?.[1]?.trim() ?? text;
}

/** Достаёт JSON чек-листа соответствия из вывода Codex (терпим к обёртке ```json). */
export function parseSpecOutput(output: string): ParseSpecResult {
  const raw = extractBetween(output, SPEC_BEGIN, SPEC_END);
  if (raw === null) {
    return { ok: false, reason: 'spec markers not found in codex output' };
  }
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` };
  }
  const parsed = SpecReviewSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  return { ok: true, spec: parsed.data };
}
