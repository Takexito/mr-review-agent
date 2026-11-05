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

  it('should leave ordinary urls and text alone', () => {
    const text = 'see https://gitlab.com/g/p/-/issues/1 and user@example.com';
    expect(redactSecrets(text)).toBe(text);
  });
});
