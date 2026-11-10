import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
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
  readonly related: readonly RelatedRepo[];
  /** Glob по `path_with_namespace`: какие смежные репозитории может добавить `.review.yml`. */
  readonly relatedAllowlist: readonly string[];
  /** Префикс ключа задачи → коннектор, скачивающий её как прямую цель. */
  readonly issueKeys: Readonly<Record<string, string>>;
}

export interface RelatedRepo {
  readonly project: string;
  /** Ветка или `same-branch`, см. `chooseRelatedRef`. */
  readonly ref?: string;
  readonly hint?: string;
}

export interface AppConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly webhookSecret: string;
  readonly gitlabHost: string;
  /** Токен бота codex: им ходит общий GitLab-клиент (dry-run, картинки из описания MR и целей). */
  readonly gitlabToken: string;
  /** Токен для clone/fetch (может быть урезан до `read_repository`). */
  readonly gitlabCloneToken: string;
  readonly codexHome: string;
  readonly codexBin: string;
  readonly codexModel?: string;
  readonly codexReasoning?: string;
  readonly codexTimeoutMs: number;
  // --- Claude ---
  readonly claudeEnabled: boolean;
  readonly claudeOauthToken?: string;
  readonly claudeBin: string;
  readonly claudeModel?: string;
  readonly claudePermissionMode: string;
  readonly claudeAllowedTools: readonly string[];
  readonly claudeTimeoutMs: number;
  /** Бот-аккаунты настроенных движков, в порядке `engines` файла. */
  readonly bindings: readonly EngineBinding[];
  readonly reposCacheDir: string;
  /** Порог переключения inline → agentic по байтам тела диффа. */
  readonly maxDiffBytes: number;
  /** Порог переключения inline → agentic по числу изменённых строк. */
  readonly maxDiffLines: number;
  readonly targetsInlineMaxChars: number;
  readonly coverageFollowup: { readonly runs: number; readonly batch: number };
  readonly queueConcurrency: number;
  readonly redisUrl: string;
  readonly connectors: Readonly<Record<string, ConnectorConfig>>;
  /** Порядок важен: побеждает первый совпавший, см. `resolveProfile`. */
  readonly profiles: readonly ProjectProfile[];
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Разбор `service.yaml`; `env` нужен для ссылок `secret:NAME`. */
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
  const { codex, claude } = file.engines;

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
    codexHome: codex.home,
    codexBin: codex.bin,
    codexModel: codex.model,
    codexReasoning: codex.reasoning,
    codexTimeoutMs: codex.timeoutMs,
    claudeEnabled: !!claude,
    claudeOauthToken: claude?.oauthToken,
    claudeBin: claude?.bin ?? CLAUDE_DEFAULTS.bin,
    claudeModel: claude?.model,
    claudePermissionMode: claude?.permissionMode ?? CLAUDE_DEFAULTS.permissionMode,
    claudeAllowedTools: claude?.allowedTools ?? CLAUDE_DEFAULTS.allowedTools,
    claudeTimeoutMs: claude?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bindings,
    reposCacheDir: file.git.cacheDir,
    maxDiffBytes: file.review.maxDiffBytes,
    maxDiffLines: file.review.maxDiffLines,
    targetsInlineMaxChars: file.review.targetsInlineMaxChars,
    coverageFollowup: file.review.coverageFollowup,
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
