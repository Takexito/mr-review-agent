import { z } from 'zod';
import { CoverageFieldsSchema, extractBetween } from './parseReview.js';
import { STANDARDS_BEGIN, STANDARDS_END } from './standardsPrompt.js';

/** Нарушение задокументированного правила репозитория — публикуется inline. */
export const ViolationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  standard: z.string().min(1),
  /** Дословная цитата требования из документа. */
  quote: z.string().default(''),
  /** Место в коде, существовавшем до MR, где правило соблюдено. */
  precedent: z.string().default(''),
  body: z.string().min(1),
});

/** Запах из базового набора — оценочное суждение, публикуется только в сводке. */
export const SmellSchema = z.object({
  smell: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  body: z.string().min(1),
});

/** Правило из документа, которому проект нигде не следует: сигнал об устаревшем документе, не о дефекте MR. */
export const DeadLetterSchema = z.object({
  standard: z.string().min(1),
  note: z.string().default(''),
});

export const StandardsReviewSchema = z.object({
  summary: z.string().default(''),
  standardsRead: z.array(z.string()).default([]),
  violations: z.array(ViolationSchema).default([]),
  deadLetters: z.array(DeadLetterSchema).default([]),
  smells: z.array(SmellSchema).default([]),
  ...CoverageFieldsSchema,
});

export type Violation = z.infer<typeof ViolationSchema>;
export type Smell = z.infer<typeof SmellSchema>;
export type DeadLetter = z.infer<typeof DeadLetterSchema>;

export interface StandardsReview extends z.infer<typeof StandardsReviewSchema> {
  /** Записи без цитаты требования или без прецедента: в MR не идут, но счёт виден в заметке. */
  readonly unproven: readonly Violation[];
}

export type ParseStandardsResult =
  | { readonly ok: true; readonly review: StandardsReview }
  | { readonly ok: false; readonly reason: string };

function stripCodeFence(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text.trim());
  return fence?.[1]?.trim() ?? text;
}

function proven(v: Violation): boolean {
  return v.quote.trim().length > 0 && v.precedent.trim().length > 0;
}

export function parseStandardsOutput(output: string): ParseStandardsResult {
  const raw = extractBetween(output, STANDARDS_BEGIN, STANDARDS_END);
  if (raw === null) return { ok: false, reason: 'standards markers not found in agent output' };
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` };
  }
  const parsed = StandardsReviewSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  return {
    ok: true,
    review: {
      ...parsed.data,
      violations: parsed.data.violations.filter(proven),
      unproven: parsed.data.violations.filter((v) => !proven(v)),
    },
  };
}
