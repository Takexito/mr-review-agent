import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { agentEnv } from './agent/env.js';

export interface AuthHealth {
  readonly ok: boolean;
  readonly detail: string;
  readonly lastRefresh?: string;
}

/**
 * Проверка подписочного auth.json без запуска codex: файл читается, парсится и содержит
 * либо OAuth-tokens (подписка), либо OPENAI_API_KEY. Наличие токенов ≠ их живость:
 * отозванный refresh-токен этой проверкой не ловится — для этого `probeCodexSession`.
 */
export async function checkCodexAuth(codexHome: string): Promise<AuthHealth> {
  const path = join(codexHome, 'auth.json');
  try {
    const raw = await readFile(path, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const hasTokens = typeof json['tokens'] === 'object' && json['tokens'] !== null;
    const key = json['OPENAI_API_KEY'];
    const hasKey = typeof key === 'string' && key.length > 0;
    if (!hasTokens && !hasKey) {
      return { ok: false, detail: 'auth.json: нет ни tokens, ни OPENAI_API_KEY' };
    }
    const lastRefresh = typeof json['last_refresh'] === 'string' ? json['last_refresh'] : undefined;
    return { ok: true, detail: hasTokens ? 'subscription tokens present' : 'api key present', lastRefresh };
  } catch (error) {
    return { ok: false, detail: `не читается ${path}: ${String(error)}` };
  }
}

/**
 * Лёгкая проверка Claude-движка: наличие `CLAUDE_CODE_OAUTH_TOKEN`. Боевую валидацию
 * не гоняем (стоила бы квоты подписки) — протухший токен вскроется на первой джобе
 * и вернётся понятной remedy-заметкой (ротация через `claude setup-token`).
 */
export function checkClaudeAuth(oauthToken?: string): AuthHealth {
  if (oauthToken && oauthToken.length > 0) {
    return { ok: true, detail: 'CLAUDE_CODE_OAUTH_TOKEN present (не валидируем боевым запросом)' };
  }
  return { ok: false, detail: 'CLAUDE_CODE_OAUTH_TOKEN не задан' };
}

const PROBE_TIMEOUT_MS = 20_000;
const RATE_LIMITS_REQUEST_ID = 2;
const MAX_DETAIL_LENGTH = 200;

function concise(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH)}…` : flat;
}

/**
 * Живая проверка сессии Codex: `codex app-server` → `account/rateLimits/read`. Запрос идёт
 * в бэкенд подписки с тем же refresh-on-401, что и у `codex exec`, но модель не вызывает —
 * квоту не тратит.
 */
export function probeCodexSession(codexBin: string, codexHome: string): Promise<AuthHealth> {
  return new Promise((resolve) => {
    const child = spawn(codexBin, ['app-server'], {
      cwd: tmpdir(),
      env: agentEnv(process.env, { CODEX_HOME: codexHome }),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const finish = (health: AuthHealth): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(health);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: `codex app-server не ответил за ${PROBE_TIMEOUT_MS / 1000} с` }),
      PROBE_TIMEOUT_MS,
    );
    child.on('error', (error) => finish({ ok: false, detail: `codex не запустился: ${error.message}` }));
    child.on('exit', (code) => finish({ ok: false, detail: `codex app-server завершился (код ${code}) без ответа` }));
    child.stdin.on('error', () => undefined);

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: { id?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.id !== RATE_LIMITS_REQUEST_ID) return;
      finish(
        message.error
          ? { ok: false, detail: concise(String(message.error.message ?? 'неизвестная ошибка')) }
          : { ok: true, detail: 'сессия подписки принята бэкендом' },
      );
    });

    // stdin не закрываем: по EOF app-server выходит, не дождавшись ответа бэкенда.
    const send = (payload: object): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mr-review-agent-healthz', title: 'healthz', version: '0' } } });
    send({ method: 'initialized' });
    send({ id: RATE_LIMITS_REQUEST_ID, method: 'account/rateLimits/read' });
  });
}

const GITLAB_TIMEOUT_MS = 10_000;

/** Живая проверка GitLab-токена: `GET /user` — доступен с любым scope, включая project access token. */
export async function checkGitlabToken(host: string, token: string): Promise<AuthHealth> {
  try {
    const response = await fetch(`${host.replace(/\/+$/, '')}/api/v4/user`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, detail: 'токен принят GitLab' };
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = body['error_description'] ?? body['message'] ?? body['error'] ?? '';
    return { ok: false, detail: concise(`GitLab ответил ${response.status} ${String(reason)}`) };
  } catch (error) {
    return { ok: false, detail: concise(`GitLab недоступен: ${String(error)}`) };
  }
}

/**
 * Мемоизация проверки на `ttlMs`. Без неё каждый опрос `/healthz` порождал бы процесс
 * codex и запросы во внешние API; параллельные опросы делят один прогон.
 */
export function cached<T>(ttlMs: number, check: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let pending: Promise<T> | undefined;
  let expiresAt = 0;
  return () => {
    if (!pending || now() >= expiresAt) {
      pending = check();
      expiresAt = now() + ttlMs;
    }
    return pending;
  };
}
