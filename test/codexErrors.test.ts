import { describe, it, expect } from 'vitest';
import { codexErrorLines, looksAuthInvalid, looksRateLimited, conciseCodexError } from '../src/codex/run.js';

// Реальный дамп codex при протухшем токене (из инцидента) + эхо промпта после «user».
const AUTH_DUMP = [
  'Reading additional input from stdin...',
  '2026-07-21T08:09:20Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try signing in again., auth error: 401, auth error code: token_invalidated',
  'OpenAI Codex v0.144.6',
  'workdir: /tmp/codex-wt-XLmB8m/repo',
  'user',
  'Ты выступаешь ревьюером предложенного изменения кода (merge request)...',
  'Дифф (unified): diff --git a/docs/... секретные детали диффа',
].join('\n');

describe('classification', () => {
  it('detects an invalidated auth token, not a rate limit', () => {
    expect(looksAuthInvalid(AUTH_DUMP)).toBe(true);
    expect(looksRateLimited(AUTH_DUMP)).toBe(false);
  });

  it('detects rate limits distinctly from auth', () => {
    expect(looksRateLimited('Error: 429 Too Many Requests')).toBe(true);
    expect(looksAuthInvalid('Error: 429 Too Many Requests')).toBe(false);
  });

  it('is negative on ordinary output', () => {
    expect(looksAuthInvalid('all good, pong')).toBe(false);
    expect(looksRateLimited('all good, pong')).toBe(false);
  });
});

describe('conciseCodexError', () => {
  it('extracts a single error line, not the echoed prompt/diff', () => {
    const msg = conciseCodexError(AUTH_DUMP, '', 'Command failed with exit code 1');
    expect(msg).toMatch(/401|invalidated|unauthorized/i);
    expect(msg.length).toBeLessThanOrEqual(201);
    expect(msg).not.toContain('ревьюером');
    expect(msg).not.toContain('diff --git');
  });

  it('caps very long single error lines', () => {
    const msg = conciseCodexError(`error: ${'x'.repeat(500)}`, '', 'sm');
    expect(msg.length).toBeLessThanOrEqual(201);
    expect(msg.endsWith('…')).toBe(true);
  });

  it('falls back to shortMessage when no error line is present', () => {
    expect(conciseCodexError('just some plain output', '', 'Command failed')).toBe('Command failed');
  });
});

describe('codexErrorLines', () => {
  // Задача из постановки и код из диффа легко содержат «429», «quota», «rate limit».
  const NOISY = [
    'user',
    'Критерий: при ответе 429 показываем «rate limit, попробуйте позже»; quota считается на сервере.',
    'exec',
    "/bin/bash -lc 'grep -n quota src' in /tmp/wt",
    '\u001b[2m2026-10-12T14:11:30Z\u001b[0m \u001b[31mERROR\u001b[0m codex_core::session: stream disconnected before completion',
    'ERROR: stream disconnected before completion',
  ].join('\n');

  it('should keep only the lines codex itself reports as errors', () => {
    expect(codexErrorLines(NOISY).split('\n')).toHaveLength(2);
    expect(codexErrorLines(NOISY)).not.toContain('quota');
  });

  it('should not read an ordinary failure as a rate limit because of prompt or command text', () => {
    expect(looksRateLimited(NOISY)).toBe(true);
    expect(looksRateLimited(codexErrorLines(NOISY))).toBe(false);
  });

  it('should still detect a real limit and a real auth failure', () => {
    expect(looksRateLimited(codexErrorLines("ERROR: You've hit your usage limit. Try again later."))).toBe(true);
    expect(looksAuthInvalid(codexErrorLines(AUTH_DUMP))).toBe(true);
  });
});
