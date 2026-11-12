import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';

/** Строки-токены сессии подписки из `$CODEX_HOME/auth.json`; нет файла — пусто. */
export function codexAuthSecrets(codexHome: string): string[] {
  let auth: { tokens?: Record<string, unknown>; OPENAI_API_KEY?: unknown };
  try {
    auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')) as typeof auth;
  } catch {
    return [];
  }
  const { account_id: _accountId, ...tokens } = auth.tokens ?? {};
  return [auth.OPENAI_API_KEY, ...Object.values(tokens)].filter((v): v is string => typeof v === 'string');
}

/**
 * Все секреты, которые могут оказаться в тексте агента. `auth.json` читается при каждом вызове:
 * codex ротирует токены сессии, и прочитанные при старте значения устаревают.
 */
export function knownSecrets(config: AppConfig): readonly string[] {
  return [...config.secretValues, ...codexAuthSecrets(config.codexHome)];
}
