import { z } from 'zod';

export const ENGINE_NAMES = ['codex', 'claude'] as const;

const SECRET_PREFIX = 'secret:';

export const DEFAULT_TIMEOUT_MS = 1_800_000;

export const CLAUDE_DEFAULTS = {
  bin: 'claude',
  model: 'sonnet',
  permissionMode: 'dontAsk',
  // `mcp__ctxmcp` — префикс сервера, разрешает все его инструменты.
  // ls-files/blame нужны для пофайлового обхода в agentic-режиме.
  allowedTools: [
    'Read',
    'Glob',
    'Grep',
    'Bash(git diff *)',
    'Bash(git log *)',
    'Bash(git show *)',
    'Bash(git ls-files *)',
    'Bash(git blame *)',
    'mcp__ctxmcp',
  ],
} as const;

type Env = Readonly<Record<string, string | undefined>>;

function resolveSecret(raw: string, env: Env, ctx: z.RefinementCtx): string {
  const name = raw.slice(SECRET_PREFIX.length);
  const value = env[name];
  if (!value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `переменная окружения ${name} не задана или пуста` });
    return z.NEVER;
  }
  return value;
}

/**
 * Схема `service.yaml`. Строится от env, потому что ссылки `secret:NAME` разрешаются при разборе.
 * Сообщения об ошибках не должны содержать значение поля: в поле-секрет по ошибке могли вписать сам токен.
 */
export function buildServiceSchema(env: Env) {
  const secret = z.string().transform((raw, ctx) => {
    if (!raw.startsWith(SECRET_PREFIX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ожидается ссылка secret:NAME, значение в файле не допускается' });
      return z.NEVER;
    }
    return resolveSecret(raw, env, ctx);
  });
  const maybeSecret = z
    .string()
    .transform((raw, ctx) => (raw.startsWith(SECRET_PREFIX) ? resolveSecret(raw, env, ctx) : raw));

  const bot = z.object({ username: z.string().min(1), token: secret }).strict();
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
      agentNetwork: z.boolean().default(false),
      cliTools: z.array(z.string().min(1)).default([]),
    })
    .strict();

  return z
    .object({
      server: z
        .object({
          port: z.number().int().positive().default(8080),
          logLevel: z.string().default('info'),
          webhookSecret: secret,
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
      connectors: z.record(connector).default({}),
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
