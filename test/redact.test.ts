import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/util/redact.js';

describe('redactSecrets', () => {
  it('should strip credentials from a git url inside an execa message', () => {
    const message =
      "Command failed with exit code 128: git -C /data/repos/x.git fetch --quiet 'https://oauth2:glpat-AbC.01.xyz@gitlab.com/g/p.git' '+refs/heads/*'";
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain('AbC');
    expect(redacted).toContain("'https://***@gitlab.com/g/p.git'");
  });

  it('should strip bare GitLab and Linear tokens', () => {
    expect(redactSecrets('token glpat-SeCrEt_1 and lin_api_SeCrEt2')).toBe('token glpat-*** and lin_api_***');
  });

  it('should strip every GitLab token type, Anthropic and OpenAI keys, JWTs and bearer headers', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const text = [
      'glptt-abc123 gldt-abc123 glrt-abc123 glsoat-abc123 glcbt-abc123',
      'sk-ant-oat01-AbC_d-123 sk-proj-AbCdEfGhIjKlMnOpQrSt',
      `id_token ${jwt}`,
      'Authorization: Bearer abc.DEF-123_xyz7890',
    ].join('\n');
    expect(redactSecrets(text)).toBe(
      [
        'glptt-*** gldt-*** glrt-*** glsoat-*** glcbt-***',
        'sk-ant-*** sk-***',
        'id_token ***',
        'Authorization: Bearer ***',
      ].join('\n'),
    );
  });

  it('should leave ordinary urls and text alone', () => {
    const text = 'see https://gitlab.com/g/p/-/issues/1 and user@example.com, task-runner and sk-1.\nuse the Bearer token scheme; Bearer\nheader';
    expect(redactSecrets(text)).toBe(text);
  });
});
