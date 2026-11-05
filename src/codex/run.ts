import { writeFile } from 'node:fs/promises';
import { execa, ExecaError } from 'execa';
import type { AppConfig } from '../config.js';
import { AgentAuthError, AgentRateLimitError, AgentRunError, type McpServerSpec } from '../agent/types.js';
import { agentEnv } from '../agent/env.js';

/** Codex упёрся в лимит подписки — такие джобы НЕ ретраим. Наследник общего Agent*Error. */
export class CodexRateLimitError extends AgentRateLimitError {
  constructor(message: string) {
    super(message);
    this.name = 'CodexRateLimitError';
  }
}

/** Токен подписки Codex недействителен (401/invalidated) — ретраибельно; remedy = перепровизия auth.json. */
export class CodexAuthError extends AgentAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

/** Прочий сбой запуска codex (ненулевой код, таймаут, отсутствие бинаря). */
export class CodexRunError extends AgentRunError {
  constructor(message: string) {
    super(message);
    this.name = 'CodexRunError';
  }
}

const AUTH_MARKERS = [
  'token_invalidated',
  'token has been invalidated',
  'authentication token has been invalidated',
  'try signing in again',
  'auth error: 401',
  '401 unauthorized',
];

const RATE_LIMIT_MARKERS = [
  'rate limit',
  'rate-limit',
  'usage limit',
  'quota',
  'too many requests',
  '429',
];

/** Токен протух/отозван (401). Отличаем от лимита, чтобы дать понятную инструкцию. */
export function looksAuthInvalid(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_MARKERS.some((m) => lower.includes(m));
}

export function looksRateLimited(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => lower.includes(m));
}

/**
 * Строки, которыми codex сам сообщает об ошибке (`ERROR: …`, `<время> ERROR codex_api: …`).
 * Классифицировать сбой можно только по ним: stderr целиком содержит эхо промпта и вывод
 * команд агента, а там «429», «quota» и «rate limit» встречаются в тексте задач и кода —
 * обычный сбой тогда читается как лимит подписки и джоба не ретраится.
 */
export function codexErrorLines(stderr: string): string {
  return stderr
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => /^(?:\S+\s+)?ERROR\b/.test(line))
    .join('\n');
}

/**
 * Достаёт из шумного вывода codex ОДНУ осмысленную строку ошибки (не эхо промпта/диффа)
 * и жёстко ограничивает длину — чтобы не постить в MR весь stderr.
 */
export function conciseCodexError(stderr: string, stdout: string, shortMessage: string): string {
  const errorLine = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) =>
      l.length > 0 && /\b(error|unauthorized|forbidden|failed|panic|not found|invalid|denied)\b/i.test(l),
    );
  const detail = (errorLine ?? shortMessage ?? 'неизвестная ошибка').replace(/\s+/g, ' ').trim();
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

export interface RunCodexOptions {
  readonly cwd: string;
  readonly config: AppConfig;
  readonly mcp?: McpServerSpec;
  /** Запись в TMPDIR (каталог джобы) нужна и без on-demand Linear. Сеть при этом не открывается. */
  readonly needsWrite?: boolean;
  /** Какой MR читают shell-CLI. Пусто — чтение MR агенту недоступно. */
  readonly mrContext?: { readonly projectId: number; readonly mrIid: number; readonly downloadDir?: string };
}

/** Строка в TOML basic-form. JSON-экранирование совпадает с TOML для всего, что тут бывает. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Inline-таблица `mcp_servers.<name>` для `-c`. Значение `-c` парсится как TOML,
 * поэтому сервер регистрируется без правки пользовательского `config.toml`.
 */
export function mcpOverride(mcp: McpServerSpec): string {
  const args = mcp.args.map(tomlString).join(',');
  const env = Object.entries(mcp.env)
    .map(([k, v]) => `${k}=${tomlString(v)}`)
    .join(',');
  return `mcp_servers.${mcp.name}={command=${tomlString(mcp.command)},args=[${args}],env={${env}}}`;
}

/**
 * Запускает `codex exec` в read-only-песочнице под подпиской (CODEX_HOME → auth.json).
 * Возвращает stdout. GitLab-токен НЕ прокидываем в окружение Codex.
 *
 * MCP подключается только если явно включён (`CODEX_MCP_ENABLED`). По умолчанию выключено:
 * `codex exec` регистрирует сервер, но каждый `tools/call` авто-отклоняет
 * («user cancelled MCP tool call») — проверено на 0.145.0 и 0.147.0, не лечится ни
 * `default_tools_approval_mode`, ни per-tool `approval_mode`, ни `approval_policy`,
 * ни объявлением в `config.toml`. Проходит только
 * `--dangerously-bypass-approvals-and-sandbox`, то есть ценой снятия песочницы.
 * Поэтому Linear для codex раскладывается на диск (см. `linear/materialize.ts`).
 */
export async function runCodex(prompt: string, options: RunCodexOptions): Promise<string> {
  const { cwd, config, mcp, mrContext, needsWrite } = options;

  // On-demand Linear требует сети, а её codex даёт только в workspace-write
  // (в read-only DNS не резолвится — curl отдаёт exit 6).
  //
  // Что при этом становится доступно на запись: workspace (worktree джобы) и весь TMPDIR.
  // Проверено, что bare-кэш при продовой раскладке защищён (`Operation not permitted`), —
  // но ровно потому, что `git.cacheDir: /data/repos` лежит ВНЕ TMPDIR. Если увести кэш
  // в /tmp, агент получит запись в общий кэш всех проектов. Это условие держит
  // безопасность режима, поэтому его нельзя нарушать бездумно.
  const args = config.codexOndemandLinear
    ? ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']
    : ['exec', '--sandbox', needsWrite ? 'workspace-write' : 'read-only'];

  if (config.codexModel) args.push('-m', config.codexModel);
  if (config.codexReasoning) args.push('-c', `model_reasoning_effort=${config.codexReasoning}`);
  if (mcp && config.codexMcpEnabled) args.push('-c', mcpOverride(mcp));
  // Промпт передаём через stdin (`-`), а не позиционным argv: большие SPEC/REVIEW-промпты
  // (дифф + требования + docs-repo) превышают MAX_ARG_STRLEN (128 КБ) и падают с E2BIG на execve.
  args.push('-');

  try {
    const result = await execa(config.codexBin, args, {
      cwd,
      timeout: config.codexTimeoutMs,
      // `codex exec -` читает промпт из stdin. execa пишет `input` и закрывает stdin (EOF),
      // поэтому codex не виснет в ожидании ввода до таймаута.
      input: prompt,
      // Явный allowlist вместо `...process.env`: GitLab-токен и webhook-секрет в окружение
      // агента не попадают. Критично именно теперь, когда у него может быть сеть.
      env: agentEnv(process.env, {
        CODEX_HOME: config.codexHome,
        // Нужны shell-CLI (`linear`, `gitlab`); сам codex эти переменные не использует.
        // GITLAB_READ_TOKEN — read_api и только он: пишущий GITLAB_TOKEN сюда не попадает.
        ...(config.codexOndemandLinear
          ? {
              LINEAR_API_KEY: config.linearApiKey,
              LINEAR_API_URL: config.linearApiUrl,
              ...(mrContext && config.gitlabReadToken
                ? {
                    GITLAB_READ_TOKEN: config.gitlabReadToken,
                    GITLAB_HOST: config.gitlabHost,
                    GITLAB_PROJECT_ID: String(mrContext.projectId),
                    GITLAB_MR_IID: String(mrContext.mrIid),
                    GITLAB_DOWNLOAD_DIR: mrContext.downloadDir,
                  }
                : {}),
            }
          : {}),
      }),
      // execa не должен наследовать окружение поверх нашего allowlist.
      extendEnv: false,
    });
    return result.stdout;
  } catch (error) {
    if (error instanceof ExecaError) {
      const stderr = String(error.stderr ?? '');
      const stdout = String(error.stdout ?? '');
      const failLog = process.env['CODEX_FAIL_LOG'];
      if (failLog) await writeFile(failLog, `${error.shortMessage}\n\n${stderr}`, 'utf8').catch(() => undefined);
      const errors = codexErrorLines(stderr);
      const haystack = `${errors}\n${error.shortMessage}`;
      // Порядок важен: auth (401) отличаем от rate-limit — у них разные инструкции.
      if (looksAuthInvalid(haystack)) {
        throw new CodexAuthError('Codex subscription token invalidated (401)');
      }
      if (looksRateLimited(haystack)) {
        throw new CodexRateLimitError('Codex rate/usage limit reached');
      }
      if (error.timedOut) {
        throw new CodexRunError('таймаут выполнения codex');
      }
      throw new CodexRunError(conciseCodexError(errors, '', error.shortMessage));
    }
    throw new CodexRunError(conciseCodexError('', '', String(error)));
  }
}
