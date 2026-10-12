import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Timing-safe сравнение секрета вебхука с заголовком X-Gitlab-Token.
 * Хешируем обе стороны в фиксированную длину, чтобы сравнение не зависело
 * от длины входа и не утекало по времени.
 */
export function isValidWebhookToken(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
