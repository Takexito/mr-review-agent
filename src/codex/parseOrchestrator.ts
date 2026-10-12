import { z } from 'zod';
import { extractBetween, type Review } from './parseReview.js';
import type { SpecReview } from './parseSpec.js';
import type { StandardsReview } from './parseStandards.js';
import { AXIS_LABEL, AXIS_LISTS, ORCHESTRATOR_BEGIN, ORCHESTRATOR_END, type AxisName } from './orchestratorPrompt.js';

export const ConsolidationSchema = z.object({
  summary: z.string().default(''),
  duplicates: z
    .array(z.object({ drop: z.string(), keep: z.string(), reason: z.string().default('') }))
    .default([]),
});

export type Consolidation = z.infer<typeof ConsolidationSchema>;

/** null — сведения нет: оси публикуются как есть, без дедупа. */
export function parseOrchestratorOutput(output: string): Consolidation | null {
  const raw = extractBetween(output, ORCHESTRATOR_BEGIN, ORCHESTRATOR_END);
  if (raw === null) return null;
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(raw.trim());
  try {
    const parsed = ConsolidationSchema.safeParse(JSON.parse(fence?.[1]?.trim() ?? raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Разобранные результаты осей; оси без результата здесь нет. */
export interface AxisReviews {
  readonly bugs?: Review;
  readonly standards?: StandardsReview;
  readonly spec?: SpecReview;
}

export interface Deduplicated extends AxisReviews {
  /** Пункты `spec.items`, чей inline-тред не нужен: место уже получило тред другой оси. */
  readonly specSkipInline: ReadonlySet<number>;
}

interface FindingId {
  readonly axis: AxisName;
  readonly list: string;
  readonly index: number;
}

function parseId(raw: string, reviews: AxisReviews): FindingId | null {
  const m = /^(bugs|standards|spec):([a-z]+):(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const axis = m[1] as AxisName;
  const list = m[2]!;
  const index = Number(m[3]);
  if (!AXIS_LISTS[axis].includes(list)) return null;
  const items = (reviews[axis] as Record<string, unknown> | undefined)?.[list];
  return Array.isArray(items) && index < items.length ? { axis, list, index } : null;
}

const key = (id: FindingId): string => `${id.axis}:${id.list}:${id.index}`;

/**
 * Применяет повторы, найденные оркестратором. Запись с несуществующим идентификатором или
 * с парой из одной оси пропускается: сводятся только оси между собой.
 * Пункт `spec:items` не удаляется — строка чек-листа остаётся, гасится только её inline-тред.
 */
export function applyDuplicates(reviews: AxisReviews, consolidation: Consolidation | null): Deduplicated {
  const dropped = new Set<string>();
  const alsoSeenBy = new Map<string, Set<AxisName>>();

  for (const duplicate of consolidation?.duplicates ?? []) {
    const drop = parseId(duplicate.drop, reviews);
    const keep = parseId(duplicate.keep, reviews);
    if (!drop || !keep || drop.axis === keep.axis) continue;
    // Цепочку «A повтор B, B повтор A» модель иногда отдаёт: оставляем то, что уже решено оставить.
    if (alsoSeenBy.has(key(drop)) || dropped.has(key(keep))) continue;
    dropped.add(key(drop));
    const axes = alsoSeenBy.get(key(keep)) ?? new Set<AxisName>();
    axes.add(drop.axis);
    alsoSeenBy.set(key(keep), axes);
  }

  const mark = (axis: AxisName, list: string, index: number, text: string): string => {
    const axes = alsoSeenBy.get(`${axis}:${list}:${index}`);
    if (!axes) return text;
    const labels = [...axes].map((a) => `«${AXIS_LABEL[a]}»`).join(', ');
    return `${text}\n\n_Также отмечено осью ${labels}._`;
  };
  const alive = (axis: AxisName, list: string) => (_: unknown, index: number): boolean =>
    !dropped.has(`${axis}:${list}:${index}`);

  const specSkipInline = new Set<number>();
  reviews.spec?.items.forEach((_, index) => {
    if (dropped.has(`spec:items:${index}`)) specSkipInline.add(index);
  });

  return {
    ...(reviews.bugs
      ? {
          bugs: {
            ...reviews.bugs,
            comments: reviews.bugs.comments
              .map((c, i) => ({ ...c, body: mark('bugs', 'comments', i, c.body) }))
              .filter(alive('bugs', 'comments')),
          },
        }
      : {}),
    ...(reviews.standards
      ? {
          standards: {
            ...reviews.standards,
            violations: reviews.standards.violations
              .map((v, i) => ({ ...v, body: mark('standards', 'violations', i, v.body) }))
              .filter(alive('standards', 'violations')),
            smells: reviews.standards.smells
              .map((s, i) => ({ ...s, body: mark('standards', 'smells', i, s.body) }))
              .filter(alive('standards', 'smells')),
          },
        }
      : {}),
    ...(reviews.spec
      ? {
          spec: {
            ...reviews.spec,
            items: reviews.spec.items.map((item, i) => ({ ...item, note: mark('spec', 'items', i, item.note) })),
            extras: reviews.spec.extras
              .map((e, i) => ({ ...e, note: mark('spec', 'extras', i, e.note) }))
              .filter(alive('spec', 'extras')),
          },
        }
      : {}),
    specSkipInline,
  };
}
