import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchGitlabUrl, parseGitlabUrl, parseShortRef } from '../src/gitlab/fetchUrl.js';

const HOST = 'https://gitlab.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function config(): Promise<{ host: string; token: string; downloadDir: string }> {
  return { host: HOST, token: 'secret', downloadDir: await mkdtemp(join(tmpdir(), 'fetch-url-')) };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Подменяет fetch таблицей «подстрока URL → ответ» и запоминает вызовы. */
function stubFetch(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return key ? routes[key]!() : new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('parseGitlabUrl', () => {
  it('should parse an issue link with a note anchor', () => {
    expect(parseGitlabUrl(HOST, 'https://gitlab.com/acme/android-app/-/issues/42#note_1')).toEqual({
      kind: 'issue',
      project: 'acme/android-app',
      iid: 42,
    });
  });

  it('should parse a merge request link with a trailing tab', () => {
    expect(parseGitlabUrl(HOST, 'https://gitlab.com/g/sub/p/-/merge_requests/7/diffs')).toEqual({
      kind: 'mr',
      project: 'g/sub/p',
      iid: 7,
    });
  });

  it('should parse a blob link and drop the query', () => {
    expect(parseGitlabUrl(HOST, 'https://gitlab.com/g/p/-/blob/master/docs/a%20b.md?ref_type=heads')).toEqual({
      kind: 'file',
      project: 'g/p',
      refAndPath: 'master/docs/a b.md',
    });
  });

  it('should parse an upload link', () => {
    const secret = 'a'.repeat(32);
    expect(parseGitlabUrl(HOST, `https://gitlab.com/g/p/uploads/${secret}/shot.png`)).toEqual({
      kind: 'upload',
      project: 'g/p',
      secret,
      filename: 'shot.png',
    });
  });

  it('should reject a link to another host', () => {
    expect(parseGitlabUrl(HOST, 'https://evil.example/g/p/-/issues/1')).toBeNull();
  });

  it('should reject an unsupported GitLab page', () => {
    expect(parseGitlabUrl(HOST, 'https://gitlab.com/g/p/-/pipelines/1')).toBeNull();
  });
});

describe('parseShortRef', () => {
  it('should resolve a bare issue reference against the default project', () => {
    expect(parseShortRef('#34', '84445514')).toEqual({ kind: 'issue', project: '84445514', iid: 34 });
  });

  it('should prefer an explicit project in a merge request reference', () => {
    expect(parseShortRef('acme/docs!12', '84445514')).toEqual({
      kind: 'mr',
      project: 'acme/docs',
      iid: 12,
    });
  });

  it('should return null when a bare reference has no default project', () => {
    expect(parseShortRef('#34')).toBeNull();
  });

  it('should return null when the input is a url', () => {
    expect(parseShortRef('https://gitlab.com/g/p/-/issues/1', '1')).toBeNull();
  });
});

describe('fetchGitlabUrl', () => {
  it('should render an issue with comments and absolute upload links', async () => {
    stubFetch({
      '/issues/42/notes': () =>
        json([
          { body: 'assigned', system: true, author: { username: 'gitlab' } },
          { body: 'Уточнение: лимит 10', author: { username: 'alice' } },
        ]),
      '/issues/42': () =>
        json({
          title: 'Экспорт',
          state: 'opened',
          author: { username: 'bob' },
          labels: ['spec'],
          web_url: 'https://gitlab.com/g/p/-/issues/42',
          description: 'Макет: ![m](/uploads/abc/m.png)',
        }),
    });

    const text = await fetchGitlabUrl(await config(), 'https://gitlab.com/g/p/-/issues/42');

    expect(text).toContain('# Экспорт (#42)');
    expect(text).toContain('](https://gitlab.com/g/p/uploads/abc/m.png)');
    expect(text).toContain('**alice:** Уточнение: лимит 10');
    expect(text).not.toContain('assigned');
  });

  it('should refuse a foreign host without any request', async () => {
    const mock = stubFetch({});
    await expect(fetchGitlabUrl(await config(), 'https://evil.example/g/p/-/issues/1')).rejects.toThrow(
      'не поддерживается',
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it('should retry with a longer ref when the branch name contains a slash', async () => {
    const mock = stubFetch({
      'files/docs%2Fa.md/raw?ref=feature%2Fx': () => new Response('hello', { status: 200 }),
    });

    const text = await fetchGitlabUrl(await config(), 'https://gitlab.com/g/p/-/blob/feature/x/docs/a.md');

    expect(text).toBe('hello');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('should save a binary upload to disk and return its path', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]);
    stubFetch({ '/uploads/': () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) });
    const cfg = await config();

    const text = await fetchGitlabUrl(cfg, `https://gitlab.com/g/p/uploads/${'b'.repeat(32)}/..%2Fshot.png`);

    const saved = /сохранён: (\S+)/.exec(text)?.[1] ?? '';
    expect(saved.startsWith(cfg.downloadDir)).toBe(true);
    expect(new Uint8Array(await readFile(saved))).toEqual(png);
  });

  it('should follow a redirect to storage without the token header', async () => {
    const mock = vi.fn(async (input: string | URL, _init?: RequestInit) =>
      String(input).startsWith(HOST)
        ? new Response(null, { status: 302, headers: { location: 'https://storage.example/signed' } })
        : new Response('file body', { status: 200 }),
    );
    vi.stubGlobal('fetch', mock);

    const text = await fetchGitlabUrl(await config(), `https://gitlab.com/g/p/uploads/${'c'.repeat(32)}/a.txt`);

    expect(text).toBe('file body');
    const second = mock.mock.calls[1]!;
    expect(String(second[0])).toBe('https://storage.example/signed');
    expect(JSON.stringify(second[1]?.headers ?? {})).not.toContain('secret');
  });

  it('should report the status when GitLab denies access', async () => {
    stubFetch({ '/issues/9': () => new Response('{}', { status: 403 }) });
    await expect(fetchGitlabUrl(await config(), 'https://gitlab.com/g/p/-/issues/9')).rejects.toThrow('403');
  });
});
