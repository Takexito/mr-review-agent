import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cached, checkGitlabToken, probeCodexSession } from '../src/health.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Подставной `codex`: на запрос лимитов (id 2) отвечает заданной JSON-RPC-строкой. */
async function fakeCodex(reply: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'));
  const bin = join(dir, 'codex');
  await writeFile(
    bin,
    `#!/usr/bin/env node
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).id === 2) console.log(${JSON.stringify(reply)});
});
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

describe('probeCodexSession', () => {
  it('should report ok when the backend returns rate limits', async () => {
    const bin = await fakeCodex('{"id":2,"result":{"rateLimits":{}}}');
    expect(await probeCodexSession(bin, '/nonexistent')).toMatchObject({ ok: true });
  });

  it('should report not ok with the backend reason when the session is rejected', async () => {
    const bin = await fakeCodex('{"id":2,"error":{"code":-32603,"message":"wham/usage failed: 401 Unauthorized"}}');
    const health = await probeCodexSession(bin, '/nonexistent');
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('401 Unauthorized');
  });

  it('should report not ok when the binary is missing', async () => {
    const health = await probeCodexSession('/nonexistent/codex', '/nonexistent');
    expect(health.ok).toBe(false);
  });
});

describe('checkGitlabToken', () => {
  it('should report ok when GitLab accepts the token', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('{"id":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkGitlabToken('https://gitlab.com/', 'tok')).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gitlab.com/api/v4/user');
  });

  it('should report not ok with the GitLab reason when the token is expired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"invalid_token","error_description":"Token is expired."}', { status: 401 })),
    );
    const health = await checkGitlabToken('https://gitlab.com', 'tok');
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('401');
    expect(health.detail).toContain('Token is expired.');
  });

  it('should report not ok when GitLab is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ENOTFOUND'))));
    expect((await checkGitlabToken('https://gitlab.com', 'tok')).ok).toBe(false);
  });
});

describe('cached', () => {
  it('should reuse the result within the ttl and re-run after it', async () => {
    let clock = 0;
    const check = vi.fn(async () => clock);
    const get = cached(100, check, () => clock);
    await get();
    clock = 99;
    await get();
    expect(check).toHaveBeenCalledTimes(1);
    clock = 100;
    expect(await get()).toBe(100);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
