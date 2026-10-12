/**
 * Окружение, с которым запускается CLI-агент.
 *
 * Раньше здесь стоял `{ ...process.env }`, то есть агент получал всё окружение бота —
 * `GITLAB_TOKEN`, `CLAUDE_GITLAB_TOKEN`, `WEBHOOK_SECRET`, `REDIS_URL`. README при этом
 * утверждал обратное («GitLab-токен не попадает в окружение Codex»). Пока у агента не было
 * сети, это оставалось латентным; как только codex получает `network_access`, то же самое
 * становится каналом утечки.
 *
 * Поэтому — явный allowlist: наследуем только то, без чего процесс не запустится, а всё
 * остальное добавляем поимённо. Новая секретная переменная в `.env` теперь по умолчанию
 * НЕ доедет до агента, и это правильный дефолт.
 */

/** Базовые переменные, без которых не поднимется ни node, ни git, ни сам CLI. */
const INHERITED = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
] as const;

/**
 * Собирает окружение агента: базовое из `source` + явные добавки.
 * Значения `undefined` в `extra` отбрасываются, чтобы не плодить пустые переменные.
 */
export function agentEnv(
  source: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
