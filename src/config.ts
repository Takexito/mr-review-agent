import { z } from 'zod';

/** Какой CLI-движок исполняет ревью. */
export type EngineName = 'codex' | 'claude';

/**
 * Привязка «GitLab-хендл → движок → токен постинга». По ней роутим mention и выбираем,
 * от чьего имени постить. Codex присутствует всегда; claude — если сконфигурен и включён.
 */
export interface EngineBinding {
  readonly engine: EngineName;
  /** GitLab-username бота, который тегают (без @). */
  readonly handle: string;
  /** PAT (scope api) этого бот-юзера — им постятся комменты/реакции от его имени. */
  readonly gitlabToken: string;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),

  WEBHOOK_SECRET: z.string().min(1, 'WEBHOOK_SECRET is required'),

  GITLAB_HOST: z.string().url().default('https://gitlab.com'),
  GITLAB_TOKEN: z.string().min(1, 'GITLAB_TOKEN is required'),
  /** Токен только для clone/fetch. Пусто = используем GITLAB_TOKEN. Хватает `read_repository`. */
  GITLAB_CLONE_TOKEN: z.string().optional(),
  /**
   * Токен, который получает АГЕНТ для чтения тредов/описания MR (scope `read_api`).
   * Намеренно отдельный: `GITLAB_TOKEN` умеет писать и агенту не отдаётся никогда.
   * Пусто = агент читает только тот срез тредов, что вклеен в промпт.
   */
  GITLAB_READ_TOKEN: z.string().optional(),
  BOT_USERNAME: z.string().min(1, 'BOT_USERNAME is required'),
  PROJECT_ALLOWLIST: z.string().optional(),

  CODEX_HOME: z.string().default('/data/codex'),
  CODEX_BIN: z.string().default('codex'),
  CODEX_MODEL: z.string().optional(),
  CODEX_REASONING: z.string().optional(),
  // Agentic-обход большого MR — это десятки tool-call'ов, старых 10 мин не хватает.
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  /**
   * Подключать ли MCP к codex. Выключено: `codex exec` авто-отклоняет любой tools/call
   * под песочницей («user cancelled MCP tool call») — проверено на 0.145.0 и 0.147.0,
   * не лечится ни approval_mode, ни config.toml. Регистрация сервера при этом работает,
   * поэтому код готов и включится флагом, когда апстрим починит вызовы.
   */
  CODEX_MCP_ENABLED: z.string().optional(),
  /**
   * On-demand доступ codex к Linear через shell-CLI (`linear issue PRJ-137`).
   * Требует сети, а её даёт только `workspace-write` + `sandbox_workspace_write.network_access`
   * (в read-only DNS не резолвится — проверено). Включено: цена — агент может писать в свой
   * одноразовый worktree и ходить в сеть; секреты в его окружение при этом не попадают
   * (см. `agent/env.ts`). Выключить → вернётся read-only + раскладка Linear на диск.
   */
  CODEX_ONDEMAND_LINEAR: z.string().optional(),

  // --- Claude Code движок (подписка через CLAUDE_CODE_OAUTH_TOKEN) ---
  // Включён, если задан хендл + GitLab-токен (и не выключен явно). Пустой OAuth-токен
  // не отключает движок — джоба упадёт с понятной remedy-заметкой (ротация токена).
  CLAUDE_ENABLED: z.string().optional(),
  CLAUDE_BOT_USERNAME: z.string().optional(),
  CLAUDE_GITLAB_TOKEN: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_BIN: z.string().default('claude'),
  CLAUDE_MODEL: z.string().default('sonnet'),
  CLAUDE_PERMISSION_MODE: z.string().default('dontAsk'),
  // `mcp__ctxmcp` — префикс сервера, разрешает все его инструменты (проверено).
  // ls-files/blame нужны для пофайлового обхода в agentic-режиме.
  CLAUDE_ALLOWED_TOOLS: z
    .string()
    .default(
      'Read,Glob,Grep,Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git ls-files *),Bash(git blame *),mcp__ctxmcp',
    ),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),

  REPOS_CACHE_DIR: z.string().default('/data/repos'),
  /**
   * Порог переключения inline → agentic (НЕ размер усечения: усечения больше нет).
   * Меньше порога — тело диффа уезжает в промпт; больше — агент читает его сам.
   */
  MAX_DIFF_BYTES: z.coerce.number().int().positive().default(400_000),
  /** Второй, более дешёвый гейт: по нему отсекаемся, не материализуя дифф вообще. */
  MAX_DIFF_LINES: z.coerce.number().int().positive().default(20_000),

  /** Дочитывание пропущенных агентом файлов на большом диффе: прогонов на ось и файлов на прогон. */
  COVERAGE_FOLLOWUP_RUNS: z.coerce.number().int().nonnegative().default(5),
  COVERAGE_FOLLOWUP_BATCH: z.coerce.number().int().positive().default(40),

  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // --- SPEC-режим: требования (Linear) + документация (docs-repo) ---
  LINEAR_API_KEY: z.string().optional(),
  LINEAR_API_URL: z.string().url().default('https://api.linear.app/graphql'),
  DOCS_REPO_PROJECT: z.string().default('acme/docs'),
  DOCS_REPO_REF: z.string().default('master'),

  REDIS_URL: z.string().default('redis://redis:6379'),
});

export interface AppConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly webhookSecret: string;
  readonly gitlabHost: string;
  readonly gitlabToken: string;
  /** Токен для clone/fetch (может быть урезан до `read_repository`). */
  readonly gitlabCloneToken: string;
  /** Read-only токен, отдаваемый агенту для чтения MR. Пусто = on-demand по MR недоступен. */
  readonly gitlabReadToken?: string;
  readonly botUsername: string;
  /** Пустой массив = разрешены все проекты. */
  readonly projectAllowlist: readonly string[];
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
  readonly claudeBotUsername?: string;
  readonly claudeGitlabToken?: string;
  readonly claudeOauthToken?: string;
  readonly claudeBin: string;
  readonly claudeModel?: string;
  readonly claudePermissionMode: string;
  readonly claudeAllowedTools: string;
  readonly claudeTimeoutMs: number;
  /** Движки, доступные сервису: codex всегда, claude — если включён и сконфигурен. */
  readonly bindings: readonly EngineBinding[];
  readonly reposCacheDir: string;
  /** Порог переключения inline → agentic по байтам тела диффа. */
  readonly maxDiffBytes: number;
  /** Порог переключения inline → agentic по числу изменённых строк. */
  readonly maxDiffLines: number;
  readonly coverageFollowup: { readonly runs: number; readonly batch: number };
  readonly queueConcurrency: number;
  /** Linear API-ключ (read issues). Пусто = SPEC-режим без критериев приёмки. */
  readonly linearApiKey?: string;
  readonly linearApiUrl: string;
  /** Проект с документацией/контрактами (path_with_namespace). */
  readonly docsRepoProject: string;
  readonly docsRepoRef: string;
  readonly redisUrl: string;
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Мягкий парс булева env: 'false'/'0'/'no'/'off' → false, всё прочее непустое → true. */
function parseBoolLoose(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  return !['false', '0', 'no', 'off'].includes(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);

  const claudeBotUsername = parsed.CLAUDE_BOT_USERNAME || undefined;
  const claudeGitlabToken = parsed.CLAUDE_GITLAB_TOKEN || undefined;
  // Claude включён: явный CLAUDE_ENABLED, иначе авто — по наличию идентичности (хендл + токен).
  const identityReady = !!(claudeBotUsername && claudeGitlabToken);
  const explicit = parseBoolLoose(parsed.CLAUDE_ENABLED);
  const claudeEnabled = (explicit ?? identityReady) && identityReady;

  const bindings: EngineBinding[] = [
    { engine: 'codex', handle: parsed.BOT_USERNAME, gitlabToken: parsed.GITLAB_TOKEN },
  ];
  if (claudeEnabled && claudeBotUsername && claudeGitlabToken) {
    bindings.push({ engine: 'claude', handle: claudeBotUsername, gitlabToken: claudeGitlabToken });
  }

  return {
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    webhookSecret: parsed.WEBHOOK_SECRET,
    gitlabHost: parsed.GITLAB_HOST,
    gitlabToken: parsed.GITLAB_TOKEN,
    gitlabCloneToken: parsed.GITLAB_CLONE_TOKEN || parsed.GITLAB_TOKEN,
    gitlabReadToken: parsed.GITLAB_READ_TOKEN || undefined,
    botUsername: parsed.BOT_USERNAME,
    projectAllowlist: parseAllowlist(parsed.PROJECT_ALLOWLIST),
    codexHome: parsed.CODEX_HOME,
    codexBin: parsed.CODEX_BIN,
    codexModel: parsed.CODEX_MODEL || undefined,
    codexReasoning: parsed.CODEX_REASONING || undefined,
    codexTimeoutMs: parsed.CODEX_TIMEOUT_MS,
    codexMcpEnabled: parseBoolLoose(parsed.CODEX_MCP_ENABLED) ?? false,
    // On-demand имеет смысл только при наличии ключа: без него CLI всё равно нечего звать,
    // и ослаблять песочницу незачем.
    codexOndemandLinear: (parseBoolLoose(parsed.CODEX_ONDEMAND_LINEAR) ?? true) && !!parsed.LINEAR_API_KEY,
    claudeEnabled,
    claudeBotUsername,
    claudeGitlabToken,
    claudeOauthToken: parsed.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    claudeBin: parsed.CLAUDE_BIN,
    claudeModel: parsed.CLAUDE_MODEL || undefined,
    claudePermissionMode: parsed.CLAUDE_PERMISSION_MODE,
    claudeAllowedTools: parsed.CLAUDE_ALLOWED_TOOLS,
    claudeTimeoutMs: parsed.CLAUDE_TIMEOUT_MS,
    bindings,
    reposCacheDir: parsed.REPOS_CACHE_DIR,
    maxDiffBytes: parsed.MAX_DIFF_BYTES,
    maxDiffLines: parsed.MAX_DIFF_LINES,
    coverageFollowup: { runs: parsed.COVERAGE_FOLLOWUP_RUNS, batch: parsed.COVERAGE_FOLLOWUP_BATCH },
    queueConcurrency: parsed.QUEUE_CONCURRENCY,
    linearApiKey: parsed.LINEAR_API_KEY || undefined,
    linearApiUrl: parsed.LINEAR_API_URL,
    docsRepoProject: parsed.DOCS_REPO_PROJECT,
    docsRepoRef: parsed.DOCS_REPO_REF,
    redisUrl: parsed.REDIS_URL,
  };
}

export function isProjectAllowed(config: AppConfig, projectPath: string): boolean {
  if (config.projectAllowlist.length === 0) return true;
  return config.projectAllowlist.includes(projectPath);
}
