import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ProjectProfile } from '../config.js';
import { matchesProjectGlob } from './glob.js';
import { RELATED_REPO } from './schema.js';

/** Читается из target-ветки: из head MR автор выключил бы себе проверки в том же MR. */
export const REPO_CONFIG_FILE = '.review.yml';

export interface RepoSettings {
  readonly profile: ProjectProfile;
  readonly exclude: readonly string[];
  readonly standards: readonly string[];
}

export interface RepoConfigResult extends RepoSettings {
  /** Непусто — файл проигнорирован целиком. */
  readonly errors: readonly string[];
}

// Путь уходит в git pathspec (`:(exclude,glob)<путь>`) и в команды, которые агент копирует в shell:
// кавычка или `$(` стали бы командой, `:` в начале — магией pathspec, `/` и `..` — выходом из репозитория.
const PATH_RULE = 'путь от корня репозитория: латиница, цифры и `_.-*?[]/`, без `/` в начале и `..`';
const REPO_PATH = z
  .string()
  .regex(/^[A-Za-z0-9_.*?[\]-][A-Za-z0-9_.*?[\]/-]*$/, PATH_RULE)
  .refine((p) => !p.split('/').includes('..'), PATH_RULE);

const MAX_QUOTED_CHARS = 80;

/** Значение из файла идёт в заметку MR: в коде-спане GitLab не рендерит markdown и не шлёт упоминания. */
function quoted(value: string): string {
  const flat = value.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return `\`${flat.length > MAX_QUOTED_CHARS ? `${flat.slice(0, MAX_QUOTED_CHARS)}…` : flat}\``;
}

function repoFileSchema(profile: ProjectProfile) {
  return z
    .object({
      connectors: z
        .array(z.string())
        .optional()
        .superRefine((names, ctx) => {
          for (const name of names ?? []) {
            if (!profile.connectors.includes(name)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: `коннектор ${quoted(name)} не подключён к профилю проекта` });
            }
          }
        }),
      related: z
        .array(RELATED_REPO)
        .default([])
        .superRefine((repos, ctx) => {
          const seen = new Set<string>();
          repos.forEach((r, i) => {
            const fail = (message: string): void => {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'project'], message });
            };
            if (seen.has(r.project)) fail(`${r.project} указан дважды`);
            else if (profile.related.some((p) => p.project === r.project)) fail(`${r.project} уже выложен профилем`);
            else if (!profile.relatedAllowlist.some((glob) => matchesProjectGlob(glob, r.project))) {
              fail(`${r.project} не входит в relatedAllowlist профиля`);
            }
            seen.add(r.project);
          });
        }),
      exclude: z.array(REPO_PATH).default([]),
      standards: z.array(REPO_PATH).default([]),
    })
    .strict();
}

function issueText(issue: z.ZodIssue): string {
  const where = issue.path.join('.') || '(корень)';
  if (issue.code === z.ZodIssueCode.unrecognized_keys) return `${where}: неизвестный ключ ${issue.keys.map(quoted).join(', ')}`;
  return `${where}: ${issue.message}`;
}

/** Слияние `.review.yml` с профилем: файл может только сузить коннекторы и добавить разрешённое профилем. */
export function applyRepoConfig(text: string | null, profile: ProjectProfile): RepoConfigResult {
  const profileOnly: RepoConfigResult = { profile, exclude: [], standards: [], errors: [] };
  if (text === null) return profileOnly;
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    // Текст ошибки `yaml` цитирует строку файла, а файл пишет кто угодно с доступом к target-ветке.
    const { linePos } = error as { linePos?: { line: number; col: number }[] };
    const at = linePos?.[0] ? ` (строка ${linePos[0].line}, столбец ${linePos[0].col})` : '';
    return { ...profileOnly, errors: [`невалидный YAML${at}`] };
  }
  const parsed = repoFileSchema(profile).safeParse(raw ?? {});
  if (!parsed.success) return { ...profileOnly, errors: parsed.error.issues.map(issueText) };
  const file = parsed.data;

  const connectors = file.connectors ?? profile.connectors;
  const issueKeys = Object.fromEntries(Object.entries(profile.issueKeys).filter(([, c]) => connectors.includes(c)));
  const merged = { ...profile, connectors, issueKeys, related: [...profile.related, ...file.related] };
  return { profile: merged, exclude: file.exclude, standards: file.standards, errors: [] };
}
