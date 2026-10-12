import { describe, it, expect } from 'vitest';
import { isValidWebhookToken } from '../src/webhook/verify.js';

describe('isValidWebhookToken', () => {
  const secret = 's3cr3t-token';

  it('should accept a matching token', () => {
    expect(isValidWebhookToken(secret, secret)).toBe(true);
  });

  it('should reject a wrong token', () => {
    expect(isValidWebhookToken('nope', secret)).toBe(false);
  });

  it('should reject an undefined header', () => {
    expect(isValidWebhookToken(undefined, secret)).toBe(false);
  });

  it('should reject an empty string', () => {
    expect(isValidWebhookToken('', secret)).toBe(false);
  });

  it('should not throw on differing lengths (hashed compare)', () => {
    expect(() => isValidWebhookToken('short', 'a-much-longer-secret-value')).not.toThrow();
    expect(isValidWebhookToken('short', 'a-much-longer-secret-value')).toBe(false);
  });
});
