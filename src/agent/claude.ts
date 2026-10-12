import { execa, ExecaError } from 'execa';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Agent, McpServerSpec } from './types.js';
import { AgentAuthError, AgentRateLimitError, AgentRunError } from './types.js';
import { agentEnv } from './env.js';

/** OAuth-токен подписки протух/отозван/невалиден. */
const AUTH_MARKERS = [
  'oauth token',
  'oauth_token',
  'invalid api key',
  'authentication_error',
  'authentication error',
  'please run /login',
  'not authenticated',
  'token has been revoked',
  'token expired',
  'expired token',
  'invalid bearer token',
  'unauthorized',
  '401',
];

/** Лимит подписки/перегруз провайдера (Anthropic 429/529). */
const RATE_LIMIT_MARKERS = [
  'rate limit',
  'rate-limit',
  'usage limit',
  'quota',
  'too many requests',
  '429',
  'overloaded',
  '529',
];

function looks(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

/**
 * Достаёт из шумного вывода claude ОДНУ осмысленную строку ошибки (не эхо промпта)
 * и жёстко ограничивает длину — чтобы не постить в MR весь stderr.
 */
export function conciseClaudeError(stderr: string, stdout: string, shortMessage: string): string {
  const errorLine = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length > 0 &&
        /\b(error|unauthorized|forbidden|failed|invalid|denied|overloaded|panic)\b/i.test(l),
    );
  const detail = (errorLine ?? shortMessage ?? 'неизвестная ошибка').replace(/\s+/g, ' ').trim();
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

interface ClaudeResultEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
}

/**
 * Извлекает текст ассистента из JSON-обёртки `claude -p --output-format json`
 * (`{ "type":"result", "is_error":false, "result":"…" }`). Если вернулся не-JSON —
 * отдаём stdout как есть (marker-парсеры разберутся/деградируют). is_error → бросаем.
 */
export function extractClaudeResult(stdout: string): string {
  let json: ClaudeResultEnvelope;
  try {
    json = JSON.parse(stdout.trim()) as ClaudeResultEnvelope;
  } catch {
    return stdout;
  }
  if (json.is_error) {
    throw new AgentRunError(`claude вернул ошибку: ${json.subtype ?? 'unknown'}`);
  }
  return typeof json.result === 'string' ? json.result : stdout;
}

/**
 * Пишет `mcp.json` для `--mcp-config`. Файл кладём в каталог джобы (его сносит processor)
 * и закрываем правами: внутри лежит `LINEAR_API_KEY`.
 */
async function writeMcpConfig(jobDir: string, mcp: McpServerSpec): Promise<string> {
  const path = join(jobDir, 'mcp.json');
  const body = {
    mcpServers: {
      [mcp.name]: { command: mcp.command, args: [...mcp.args], env: { ...mcp.env } },
    },
  };
  await writeFile(path, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 });
  return path;
}

/**
 * Движок Claude Code под ПОДПИСКОЙ (Pro/Max) через `CLAUDE_CODE_OAUTH_TOKEN`.
 * Read-only: `--permission-mode dontAsk` + белый список read-инструментов, БЕЗ
 * `--dangerously-skip-permissions` и БЕЗ `--bare` (в bare OAuth-токен игнорируется).
 * Промпт — через stdin (`input`), НЕ argv: большой промпт в argv → E2BIG на execve.
 * GitLab/Anthropic-ключ в окружение claude не прокидываем (форсим OAuth-подписку).
 *
 * `--add-dir` открывает Read/Grep соседние каталоги (чекаут доки, раскладка Linear) —
 * без него они вне досягаемости, даже когда лежат рядом с worktree.
 * `--strict-mcp-config` — чтобы в прогон не подмешался MCP из настроек хоста.
 */
export function createClaudeAgent(config: AppConfig): Agent {
  return {
    name: 'claude',
    run: async (prompt, { cwd, jobDir, readDirs, mcp }) => {
      const args = [
        '--print',
        '--output-format',
        'json',
        '--permission-mode',
        config.claudePermissionMode,
        '--allowedTools',
        config.claudeAllowedTools,
      ];
      if (config.claudeModel) args.push('--model', config.claudeModel);
      for (const dir of readDirs ?? []) args.push('--add-dir', dir);
      if (mcp) {
        args.push('--mcp-config', await writeMcpConfig(jobDir, mcp), '--strict-mcp-config');
      }

      try {
        const result = await execa(config.claudeBin, args, {
          cwd,
          timeout: config.claudeTimeoutMs,
          // Промпт через stdin (подтверждено: `claude -p` читает stdin как промпт).
          // execa пишет `input` и закрывает stdin (EOF) → claude не виснет и нет E2BIG.
          input: prompt,
          // Явный allowlist вместо `...process.env`: GitLab-токен, webhook-секрет и ключ
          // Linear в окружение claude не попадают (Linear он получает через MCP-процесс).
          env: agentEnv(process.env, { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken }),
          extendEnv: false,
        });
        return extractClaudeResult(result.stdout);
      } catch (error) {
        // is_error из JSON-обёртки уже AgentRunError — не заворачиваем повторно.
        if (error instanceof AgentRunError) throw error;
        if (error instanceof ExecaError) {
          const stderr = String(error.stderr ?? '');
          const stdout = String(error.stdout ?? '');
          const haystack = `${stderr}\n${stdout}\n${error.shortMessage}`;
          // Порядок важен: auth (401) отличаем от rate-limit — у них разные remedy.
          if (looks(haystack, AUTH_MARKERS)) {
            throw new AgentAuthError('Claude subscription OAuth token invalid/expired');
          }
          if (looks(haystack, RATE_LIMIT_MARKERS)) {
            throw new AgentRateLimitError('Claude rate/usage limit reached');
          }
          if (error.timedOut) {
            throw new AgentRunError('таймаут выполнения claude');
          }
          throw new AgentRunError(conciseClaudeError(stderr, stdout, error.shortMessage));
        }
        throw new AgentRunError(conciseClaudeError('', '', String(error)));
      }
    },
  };
}
