import { z } from 'zod';
import { RESERVED_AGENT_ENV } from '../agent/env.js';

export const ENGINE_NAMES = ['codex', 'claude'] as const;

const SECRET_PREFIX = 'secret:';

export const CONNECTOR_NAME_PATTERN = '[A-Za-z0-9-]+';
const CONNECTOR_NAME = new RegExp(`^${CONNECTOR_NAME_PATTERN}$`);
// Значение уходит в `Bash(<tool> *)` у claude: `*` или пробел открыли бы любую команду.
const CLI_TOOL_NAME = /^[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Сравнивается с `URL.hostname` целиком: шаблон или схема в строке тихо не совпали бы ни с чем.
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Префикс ключа задачи (`PRJ` в `PRJ-137`) или `#` — задачи GitLab, см. `findDirectTargets`.
const ISSUE_KEY_PREFIX = /^(#|[A-Z][A-Z0-9]{0,9})$/;
// Путь уходит в URL клона и в имя каталога рядом с worktree: `..` вывел бы его за каталог джобы.
const PROJECT_PATH = /^[A-Za-z0-9_][\w.-]*(\/[A-Za-z0-9_][\w.-]*)+$/;

/** Роли GitLab по возрастанию прав; значение — `access_level` API участников проекта. */
export const TRIGGER_ROLES = { reporter: 20, developer: 30, maintainer: 40, owner: 50 } as const;
export type TriggerRole = keyof typeof TRIGGER_ROLES;

const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** `ref` смежного репозитория: ветка с тем же именем, что у MR, если она есть. */
export const SAME_BRANCH = 'same-branch';

// `ref` пишут и авторы `.review.yml`, а уходит он в `refs/heads/<ref>`, в промпт и в заметку:
// `..`, `@{`, `~`, `^`, `:` превратили бы имя ветки в выражение ревизии git.
const BRANCH_NAME = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![/.])$/;

export const RELATED_REPO = z
  .object({
    project: z.string().regex(PROJECT_PATH, 'ожидается путь group/project'),
    ref: z.string().regex(BRANCH_NAME, `ожидается имя ветки или ${SAME_BRANCH}`).optional(),
    hint: z.string().optional(),
  })
  .strict();

export const DEFAULT_TIMEOUT_MS = 1_800_000;

export const CLAUDE_DEFAULTS = {
  bin: 'claude',
  model: 'sonnet',
  permissionMode: 'dontAsk',
  // ls-files/blame нужны для пофайлового обхода в agentic-режиме. Коннекторы — см. `claudeAllowedTools`.
  allowedTools: [
    'Read',
    'Glob',
    'Grep',
    'Bash(git diff *)',
    'Bash(git log *)',
    'Bash(git show *)',
    'Bash(git ls-files *)',
    'Bash(git blame *)',
  ],
} as const;

type Env = Readonly<Record<string, string | undefined>>;

function resolveSecret(raw: string, env: Env, ctx: z.RefinementCtx, resolved: string[]): string {
  const name = raw.slice(SECRET_PREFIX.length);
  const value = env[name];
  if (!value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `переменная окружения ${name} не задана или пуста` });
    return z.NEVER;
  }
  resolved.push(value);
  return value;
}

/**
 * Схема `service.yaml`. Строится от env, потому что ссылки `secret:NAME` разрешаются при разборе.
 * Сообщения об ошибках не должны содержать значение поля: в поле-секрет по ошибке могли вписать сам токен.
 * В `resolved` складываются значения всех разрешённых ссылок `secret:NAME`.
 */
export function buildServiceSchema(env: Env, resolved: string[] = []) {
  const secret = z.string().transform((raw, ctx) => {
    if (!raw.startsWith(SECRET_PREFIX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ожидается ссылка secret:NAME, значение в файле не допускается' });
      return z.NEVER;
    }
    return resolveSecret(raw, env, ctx, resolved);
  });
  const maybeSecret = z
    .string()
    .transform((raw, ctx) => (raw.startsWith(SECRET_PREFIX) ? resolveSecret(raw, env, ctx, resolved) : raw));

  const bot = z.object({ username: z.string().min(1), token: secret }).strict();

  const cliToolName = z.string().regex(CLI_TOOL_NAME, 'имя команды без шаблонов и пробелов');
  // Переменные уходят в окружение самого агента: всё, что в них лежит, агент может прочитать и отправить наружу.
  const cliToolEnv = z.record(maybeSecret).superRefine((vars, ctx) => {
    for (const name of Object.keys(vars)) {
      if (!ENV_NAME.test(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'имя переменной окружения' });
      else if (RESERVED_AGENT_ENV.has(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} бот задаёт агенту сам` });
      }
    }
  });
  const cliTool = z.union([
    cliToolName.transform((name) => ({ name, env: {} as Record<string, string> })),
    z.object({ name: cliToolName, env: cliToolEnv.default({}) }).strict(),
  ]);
  const timeoutMs = z.number().int().positive().default(DEFAULT_TIMEOUT_MS);

  const connector = z
    .object({
      command: z.string().min(1).optional(),
      args: z.array(z.string()).default([]),
      env: z.record(maybeSecret).default({}),
      url: z.string().url().optional(),
      headers: z.record(maybeSecret).default({}),
      tools: z.array(z.string().min(1)).optional(),
      hint: z.string().optional(),
      prefetch: z
        .object({ tool: z.string().min(1), arguments: z.record(z.string()).default({}) })
        .strict()
        .optional(),
      attachments: z
        .object({
          hosts: z.array(z.string().regex(HOST_NAME, 'имя хоста без схемы, пути и шаблонов')).min(1),
          headers: z.record(maybeSecret).default({}),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((c) => (c.command === undefined) !== (c.url === undefined), {
      message: 'нужно ровно одно из command (stdio) или url (http)',
    });

  const profile = z
    .object({
      name: z.string().min(1),
      projects: z.array(z.string().min(1)).min(1),
      engines: z.array(z.enum(ENGINE_NAMES)).min(1).optional(),
      connectors: z.array(z.string()).default([]),
      triggerRole: z.enum(Object.keys(TRIGGER_ROLES) as [TriggerRole, ...TriggerRole[]]).default('developer'),
      internalNotes: z.enum(['ignore', 'include']).default('ignore'),
      agentNetwork: z.boolean().default(false),
      cliTools: z.array(cliTool).default([]),
      related: z.array(RELATED_REPO).default([]),
      relatedAllowlist: z.array(z.string().min(1)).default([]),
      issueKeys: z.record(z.string()).default({}),
      models: z
        .object({
          codex: z.object({ model: z.string().min(1).optional(), reasoning: z.string().min(1).optional() }).strict().optional(),
          claude: z.object({ model: z.string().min(1).optional() }).strict().optional(),
        })
        .strict()
        .default({}),
    })
    .strict();

  return z
    .object({
      server: z
        .object({
          port: z.number().int().positive().default(8080),
          logLevel: z.string().default('info'),
          // Неразрешённая ссылка уже дала свою ошибку; длина z.NEVER — ложная вторая.
          webhookSecret: secret.refine((value) => typeof value !== 'string' || value.length >= MIN_WEBHOOK_SECRET_LENGTH, {
            message: `секрет короче ${MIN_WEBHOOK_SECRET_LENGTH} символов; сгенерируй: openssl rand -hex 32`,
          }),
          redisUrl: z.string().default('redis://redis:6379'),
          queueConcurrency: z.number().int().positive().default(2),
        })
        .strict(),
      gitlab: z
        .object({
          host: z.string().url().default('https://gitlab.com'),
          cloneToken: secret.optional(),
        })
        .strict()
        .default({}),
      git: z.object({ cacheDir: z.string().default('/data/repos') }).strict().default({}),
      review: z
        .object({
          maxDiffBytes: z.number().int().positive().default(400_000),
          maxDiffLines: z.number().int().positive().default(20_000),
          // Выше порога прямые цели уходят агенту файлами, а не текстом промпта.
          targetsInlineMaxChars: z.number().int().positive().default(60_000),
          prefetchTimeoutMs: z.number().int().positive().default(300_000),
          coverageFollowup: z
            .object({
              runs: z.number().int().nonnegative().default(5),
              batch: z.number().int().positive().default(40),
            })
            .strict()
            .default({}),
        })
        .strict()
        .default({}),
      engines: z
        .object({
          codex: z
            .object({
              bot,
              bin: z.string().default('codex'),
              home: z.string().default('/data/codex'),
              model: z.string().optional(),
              reasoning: z.string().optional(),
              timeoutMs,
            })
            .strict(),
          claude: z
            .object({
              bot,
              oauthToken: secret,
              bin: z.string().default(CLAUDE_DEFAULTS.bin),
              model: z.string().default(CLAUDE_DEFAULTS.model),
              permissionMode: z.string().default(CLAUDE_DEFAULTS.permissionMode),
              allowedTools: z.array(z.string().min(1)).default([...CLAUDE_DEFAULTS.allowedTools]),
              timeoutMs,
            })
            .strict()
            .optional(),
        })
        .strict(),
      // codex делит ключ `-c mcp_servers.<имя>` по точкам, claude склеивает `mcp__<имя>__<инструмент>`.
      connectors: z
        .record(connector)
        .default({})
        .superRefine((connectors, ctx) => {
          for (const name of Object.keys(connectors)) {
            if (!CONNECTOR_NAME.test(name)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [name],
                message: 'имя коннектора — только латиница, цифры и дефис',
              });
            }
          }
        }),
      profiles: z.array(profile).min(1),
    })
    .strict()
    .superRefine((config, ctx) => {
      const names = new Set<string>();
      config.profiles.forEach((p, i) => {
        if (names.has(p.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', i, 'name'], message: `профиль ${p.name} уже объявлен` });
        }
        names.add(p.name);
        for (const c of p.connectors) {
          if (!(c in config.connectors)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', i, 'connectors'], message: `коннектор ${c} не объявлен` });
          }
        }
        for (const e of p.engines ?? []) {
          if (!config.engines[e]) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', i, 'engines'], message: `движок ${e} не настроен` });
          }
        }
        for (const e of ENGINE_NAMES) {
          if (p.models[e] && !config.engines[e]) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', i, 'models', e], message: `движок ${e} не настроен` });
          }
        }
        const seen = new Set<string>();
        for (const r of p.related) {
          if (seen.has(r.project)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['profiles', i, 'related'],
              message: `смежный репозиторий ${r.project} указан дважды`,
            });
          }
          seen.add(r.project);
        }
        for (const [prefix, connector] of Object.entries(p.issueKeys)) {
          const path = ['profiles', i, 'issueKeys', prefix];
          if (!ISSUE_KEY_PREFIX.test(prefix)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'префикс — заглавная латиница и цифры (PRJ) или #' });
          }
          if (!p.connectors.includes(connector)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `коннектор ${connector} не подключён к профилю` });
          } else if (!config.connectors[connector]?.prefetch) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `у коннектора ${connector} нет правила prefetch` });
          }
        }
        const variables = new Set<string>();
        for (const tool of p.cliTools) {
          for (const name of Object.keys(tool.env)) {
            if (variables.has(name)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['profiles', i, 'cliTools'],
                message: `переменную ${name} задают два инструмента`,
              });
            }
            variables.add(name);
          }
        }
        if (p.cliTools.length > 0 && !p.agentNetwork) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['profiles', i, 'cliTools'],
            message: 'cliTools требует agentNetwork: true',
          });
        }
      });
    });
}

export type ServiceFile = z.output<ReturnType<typeof buildServiceSchema>>;
export type ConnectorConfig = ServiceFile['connectors'][string];
