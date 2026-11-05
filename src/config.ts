import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { matchesProjectGlob } from './config/glob.js';
import {
  buildServiceSchema,
  CLAUDE_DEFAULTS,
  DEFAULT_TIMEOUT_MS,
  ENGINE_NAMES,
  type ConnectorConfig,
} from './config/schema.js';

/** Какой CLI-движок исполняет ревью. */
export type EngineName = (typeof ENGINE_NAMES)[number];

/**
 * Привязка «GitLab-хендл → движок → токен постинга». По ней роутим mention и выбираем,
 * от чьего имени постить.
 */
export interface EngineBinding {
  readonly engine: EngineName;
  /** GitLab-username бота, который тегают (без @). */
  readonly handle: string;
  /** PAT (scope api) этого бот-юзера — им постятся комменты/реакции от его имени. */
  readonly gitlabToken: string;
}

const TransitionalEnvSchema = z.object({
  /**
   * Токен, который получает АГЕНТ для чтения тредов/описания MR (scope `read_api`).
   * Намеренно отдельный от токенов ботов: те умеют писать и агенту не отдаются никогда.
   */
  GITLAB_READ_TOKEN: z.string().optional(),
  /**
   * Подключать ли MCP к codex. Без `default_tools_approval_mode="approve"` на сервере
   * `codex exec` отклоняет каждый tools/call под песочницей.
   */
  CODEX_MCP_ENABLED: z.string().optional(),
  /**
   * On-demand доступ codex к Linear через shell-CLI. Требует сети, а её даёт только
   * `workspace-write` + `network_access`: агент получает запись в worktree и TMPDIR.
   */
  CODEX_ONDEMAND_LINEAR: z.string().optional(),
  LINEAR_API_KEY: z.string().optional(),
  LINEAR_API_URL: z.string().url().default('https://api.linear.app/graphql'),
  DOCS_REPO_PROJECT: z.string().default('acme/docs'),
  DOCS_REPO_REF: z.string().default('master'),
});

export interface LinearConfig {
  /** Linear API-ключ (read issues). Пусто = SPEC-режим без критериев приёмки. */
  readonly linearApiKey?: string;
  readonly linearApiUrl: string;
}

/** Поля Linear и чтения MR — для отдельных процессов (MCP-сервер, shell-CLI), у которых нет `service.yaml`. */
export function loadLinearEnv(env: NodeJS.ProcessEnv = process.env): LinearConfig {
  const parsed = TransitionalEnvSchema.parse(env);
  return { linearApiKey: parsed.LINEAR_API_KEY || undefined, linearApiUrl: parsed.LINEAR_API_URL };
}

export type { ConnectorConfig };

/** Профиль проекта: какие движки отвечают и какие коннекторы доступны в совпавших проектах. */
export interface ProjectProfile {
  readonly name: string;
  /** Glob по `path_with_namespace`, см. `matchesProjectGlob`. */
  readonly projects: readonly string[];
  readonly engines: readonly EngineName[];
  readonly connectors: readonly string[];
  readonly agentNetwork: boolean;
  readonly cliTools: readonly string[];
}

export interface AppConfig extends LinearConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly webhookSecret: string;
  readonly gitlabHost: string;
  /** Токен бота codex: им ходит общий GitLab-клиент (dry-run, запасной токен чтения). */
  readonly gitlabToken: string;
  /** Токен для clone/fetch (может быть урезан до `read_repository`). */
  readonly gitlabCloneToken: string;
  /** Read-only токен, отдаваемый агенту для чтения MR. Пусто = on-demand по MR недоступен. */
  readonly gitlabReadToken?: string;
  readonly codexHome: string;
  readonly codexBin: string;
  readonly codexModel?: string;
  readonly codexReasoning?: string;
  readonly codexTimeoutMs: number;
  readonly codexMcpEnabled: boolean;
  /** codex ходит в Linear сам через shell-CLI; требует ослабления песочницы до workspace-write. */
  readonly codexOndemandLinear: boolean;
  // --- Claude ---
  readonly claudeEnabled: boolean;
  readonly claudeOauthToken?: string;
  readonly claudeBin: string;
  readonly claudeModel?: string;
  readonly claudePermissionMode: string;
  readonly claudeAllowedTools: string;
  readonly claudeTimeoutMs: number;
  /** Бот-аккаунты настроенных движков, в порядке `engines` файла. */
  readonly bindings: readonly EngineBinding[];
  readonly reposCacheDir: string;
  /** Порог переключения inline → agentic по байтам тела диффа. */
  readonly maxDiffBytes: number;
  /** Порог переключения inline → agentic по числу изменённых строк. */
  readonly maxDiffLines: number;
  readonly coverageFollowup: { readonly runs: number; readonly batch: number };
  readonly queueConcurrency: number;
  /** Проект с документацией/контрактами (path_with_namespace). */
  readonly docsRepoProject: string;
  readonly docsRepoRef: string;
  readonly redisUrl: string;
  readonly connectors: Readonly<Record<string, ConnectorConfig>>;
  /** Порядок важен: побеждает первый совпавший, см. `resolveProfile`. */
  readonly profiles: readonly ProjectProfile[];
}

/** Мягкий парс булева env: 'false'/'0'/'no'/'off' → false, всё прочее непустое → true. */
function parseBoolLoose(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  return !['false', '0', 'no', 'off'].includes(v);
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Разбор `service.yaml`; `env` нужен для ссылок `secret:NAME` и временных переменных. */
export function parseServiceConfig(yamlText: string, env: NodeJS.ProcessEnv): AppConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    // Текст ошибки `yaml` цитирует строку файла — в ней может оказаться вписанный по ошибке токен.
    const { code, linePos } = error as { code?: string; linePos?: { line: number; col: number }[] };
    const at = linePos?.[0] ? ` (строка ${linePos[0].line}, столбец ${linePos[0].col})` : '';
    throw new ConfigError(`service.yaml: невалидный YAML: ${code ?? 'parse error'}${at}`);
  }
  const result = buildServiceSchema(env).safeParse(raw ?? {});
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(корень)'}: ${i.message}`);
    throw new ConfigError(`service.yaml:\n${lines.join('\n')}`);
  }
  const file = result.data;
  const legacyResult = TransitionalEnvSchema.safeParse(env);
  if (!legacyResult.success) {
    const lines = legacyResult.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`env:\n${lines.join('\n')}`);
  }
  const legacy = legacyResult.data;
  const { codex, claude } = file.engines;
  const linearApiKey = legacy.LINEAR_API_KEY || undefined;

  const bindings: EngineBinding[] = [{ engine: 'codex', handle: codex.bot.username, gitlabToken: codex.bot.token }];
  if (claude) bindings.push({ engine: 'claude', handle: claude.bot.username, gitlabToken: claude.bot.token });
  const configured = bindings.map((b) => b.engine);

  return {
    port: file.server.port,
    logLevel: file.server.logLevel,
    webhookSecret: file.server.webhookSecret,
    redisUrl: file.server.redisUrl,
    queueConcurrency: file.server.queueConcurrency,
    gitlabHost: file.gitlab.host,
    gitlabToken: codex.bot.token,
    gitlabCloneToken: file.gitlab.cloneToken ?? codex.bot.token,
    gitlabReadToken: legacy.GITLAB_READ_TOKEN || undefined,
    codexHome: codex.home,
    codexBin: codex.bin,
    codexModel: codex.model,
    codexReasoning: codex.reasoning,
    codexTimeoutMs: codex.timeoutMs,
    codexMcpEnabled: parseBoolLoose(legacy.CODEX_MCP_ENABLED) ?? false,
    // Без ключа CLI нечего звать, и ослаблять песочницу незачем.
    codexOndemandLinear: (parseBoolLoose(legacy.CODEX_ONDEMAND_LINEAR) ?? true) && !!linearApiKey,
    claudeEnabled: !!claude,
    claudeOauthToken: claude?.oauthToken,
    claudeBin: claude?.bin ?? CLAUDE_DEFAULTS.bin,
    claudeModel: claude?.model,
    claudePermissionMode: claude?.permissionMode ?? CLAUDE_DEFAULTS.permissionMode,
    claudeAllowedTools: (claude?.allowedTools ?? CLAUDE_DEFAULTS.allowedTools).join(','),
    claudeTimeoutMs: claude?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bindings,
    reposCacheDir: file.git.cacheDir,
    maxDiffBytes: file.review.maxDiffBytes,
    maxDiffLines: file.review.maxDiffLines,
    coverageFollowup: file.review.coverageFollowup,
    linearApiKey,
    linearApiUrl: legacy.LINEAR_API_URL,
    docsRepoProject: legacy.DOCS_REPO_PROJECT,
    docsRepoRef: legacy.DOCS_REPO_REF,
    connectors: file.connectors,
    profiles: file.profiles.map((p) => ({ ...p, engines: p.engines ?? configured })),
  };
}

export const DEFAULT_SERVICE_CONFIG_PATH = '/config/service.yaml';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const path = env['SERVICE_CONFIG'] || DEFAULT_SERVICE_CONFIG_PATH;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`не прочитать ${path} (SERVICE_CONFIG): ${(error as Error).message}`);
  }
  return parseServiceConfig(text, env);
}

/** Профиль проекта или undefined — тогда проект не обслуживается. */
export function resolveProfile(config: AppConfig, projectPath: string): ProjectProfile | undefined {
  return config.profiles.find((p) => p.projects.some((glob) => matchesProjectGlob(glob, projectPath)));
}
