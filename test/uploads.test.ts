import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadImages } from '../src/gitlab/uploads.js';

const HOST = 'https://gitlab.com';
const SECRET = 'b'.repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
});

async function config() {
  return { host: HOST, token: 'secret', dir: await mkdtemp(join(tmpdir(), 'uploads-')), project: 'g/p', allowedProjects: ['g/p'], prefix: 'mr' };
}

describe('downloadImages', () => {
  it('should save a relative upload of the project and keep the file inside the directory', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const mock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', mock);
    const cfg = await config();

    const result = await downloadImages(`Макет: ![shot](/uploads/${SECRET}/..%2Fshot.png)`, cfg);

    expect(String(mock.mock.calls[0]![0])).toContain(`/projects/g%2Fp/uploads/${SECRET}/`);
    const saved = result.saved[0]!.path;
    expect(saved.startsWith(cfg.dir)).toBe(true);
    expect(new Uint8Array(await readFile(saved))).toEqual(png);
  });

  it('should count images on foreign hosts without any request', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);

    const result = await downloadImages(`![a](https://evil.example/g/p/uploads/${SECRET}/a.png)`, await config());

    expect(result).toEqual({ saved: [], failed: [], foreign: 1 });
    expect(mock).not.toHaveBeenCalled();
  });

  it('should not download uploads of a project outside the profile', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);

    const result = await downloadImages(`![a](${HOST}/secret/vault/uploads/${SECRET}/a.png)`, await config());

    expect(result.foreign).toBe(1);
    expect(mock).not.toHaveBeenCalled();
  });

  it('should follow a redirect to storage without the token header', async () => {
    const mock = vi.fn(async (input: string | URL, _init?: RequestInit) =>
      String(input).startsWith(HOST)
        ? new Response(null, { status: 302, headers: { location: 'https://storage.example/signed' } })
        : new Response('img', { status: 200 }),
    );
    vi.stubGlobal('fetch', mock);

    const result = await downloadImages(`![a](${HOST}/g/p/uploads/${SECRET}/a.png)`, await config());

    expect(result.saved).toHaveLength(1);
    const second = mock.mock.calls[1]!;
    expect(String(second[0])).toBe('https://storage.example/signed');
    expect(JSON.stringify(second[1]?.headers ?? {})).not.toContain('secret');
  });
});
