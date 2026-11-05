import { writeFile } from 'node:fs/promises';
import { execa, ExecaError } from 'execa';
import type { AppConfig } from '../config.js';
import { AgentAuthError, AgentRateLimitError, AgentRunError } from '../agent/types.js';
import { codexMcpOverrides, type AgentAccess } from '../connectors/engineConfig.js';
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
  readonly access?: AgentAccess;
  /** Запись в каталог джобы (оркестратор). Сеть при этом не открывается. */
  readonly needsWrite?: boolean;
}

/**
 * Запускает `codex exec` под подпиской (CODEX_HOME → auth.json) и возвращает stdout.
 * Коннекторы ходят в сеть из своих MCP-процессов, поэтому песочница остаётся `read-only`,
 * пока профиль не открыл сеть самому агенту. Токены ботов в окружение codex не попадают.
 */
export async function runCodex(prompt: string, options: RunCodexOptions): Promise<string> {
  const { cwd, config, access, needsWrite } = options;

  // Сеть codex даёт только в workspace-write (в read-only DNS не резолвится — curl отдаёт exit 6).
  // Запись при этом открыта в worktree и весь TMPDIR: `git.cacheDir` вне TMPDIR, иначе агент
  // получит запись в общий кэш репозиториев всех проектов.
  const args = access?.agentNetwork
    ? ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']
    : ['exec', '--sandbox', needsWrite ? 'workspace-write' : 'read-only'];

  if (config.codexModel) args.push('-m', config.codexModel);
  if (config.codexReasoning) args.push('-c', `model_reasoning_effort=${config.codexReasoning}`);
  for (const override of codexMcpOverrides(access?.connectors ?? [])) args.push('-c', override);
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
      env: agentEnv(process.env, { CODEX_HOME: config.codexHome }),
      // execa не должен наследовать окружение поверх нашего allowlist.
      extendEnv: false,
    });
    return result.stdout;
  } catch (error) {
    if (error instanceof ExecaError) {
      const stderr = String(error.stderr ?? '');
      const stdout = String(error.stdout ?? '');
      // `shortMessage` execa повторяет командную строку, а в ней `-c mcp_servers…` с токенами
      // коннекторов; текст ошибки уходит в лог и в заметку MR.
      const exitSummary = `codex завершился с кодом ${error.exitCode ?? '?'}`;
      const failLog = process.env['CODEX_FAIL_LOG'];
      if (failLog) await writeFile(failLog, `${exitSummary}\n\n${stderr}`, 'utf8').catch(() => undefined);
      const errors = codexErrorLines(stderr);
      const haystack = errors;
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
      throw new CodexRunError(conciseCodexError(errors, '', exitSummary));
    }
    throw new CodexRunError(conciseCodexError('', '', String(error)));
  }
}
