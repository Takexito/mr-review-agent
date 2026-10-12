import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractSpecRefs } from '../src/spec/refs.js';
import { gatherSpecSources } from '../src/spec/sources.js';
import { buildSpecPrompt } from '../src/codex/specPrompt.js';
import { parseSpecOutput } from '../src/codex/parseSpec.js';
import { buildSpecNote } from '../src/gitlab/postSpecReview.js';
import { SPEC_BEGIN, SPEC_END } from '../src/codex/prompts.js';
import type { AppConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';

const HOST = 'https://gitlab.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractSpecRefs', () => {
  it('should collect GitLab short refs and a Linear url in order of appearance', () => {
    const text =
      'Задача: #34. Спека: #31. Linear: [OPS-176](https://linear.app/acme/issue/OPS-176/smena-nika). Это #35.';
    expect(extractSpecRefs(text, HOST)).toEqual([
      { kind: 'gitlab', target: '#34' },
      { kind: 'gitlab', target: '#31' },
      { kind: 'linear', key: 'OPS-176' },
      { kind: 'gitlab', target: '#35' },
    ]);
  });

  it('should take a GitLab issue url on our host and drop trailing punctuation', () => {
    expect(extractSpecRefs('см. https://gitlab.com/g/p/-/work_items/9.', HOST)).toEqual([
      { kind: 'gitlab', target: 'https://gitlab.com/g/p/-/work_items/9' },
    ]);
  });

  it('should ignore foreign hosts, merge request urls and url fragments', () => {
    const text = 'https://evil.example/g/p/-/issues/1 https://gitlab.com/g/p/-/merge_requests/2 https://x.dev/page#34';
    expect(extractSpecRefs(text, HOST)).toEqual([]);
  });

  it('should not read lowercase words as Linear keys in free text', () => {
    expect(extractSpecRefs('кодировка utf-8, ветка feature-34', HOST)).toEqual([]);
  });

  it('should accept a lowercase Linear key in a command argument', () => {
    expect(extractSpecRefs('prj-42', HOST, { looseLinearCase: true })).toEqual([{ kind: 'linear', key: 'PRJ-42' }]);
  });

  it('should deduplicate repeated references', () => {
    expect(extractSpecRefs('#34 и снова #34', HOST)).toEqual([{ kind: 'gitlab', target: '#34' }]);
  });
});

describe('gatherSpecSources', () => {
  const ctx = {
    config: {
      gitlabHost: HOST,
      gitlabToken: 'bot',
      gitlabReadToken: 'read',
      docsRepoProject: 'g/docs',
      projectAllowlist: ['g/p'],
    } as unknown as AppConfig,
    projectId: 7,
    projectPath: 'g/p',
    downloadDir: '/tmp/unused',
    log: { warn: () => undefined } as unknown as Logger,
  };

  it('should fetch a GitLab issue as a source and report an unavailable one as degraded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/issues/34/notes')) return new Response('[]', { status: 200 });
        if (url.includes('/projects/7/issues/34')) {
          return new Response(JSON.stringify({ title: 'Экран ника', description: 'AC', web_url: `${HOST}/g/p/-/issues/34` }), {
            status: 200,
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );

    const result = await gatherSpecSources(ctx, [
      { kind: 'gitlab', target: '#34' },
      { kind: 'gitlab', target: '#99' },
      { kind: 'linear', key: 'OPS-1' },
    ]);

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ label: '#34', title: 'Экран ника (#34)' });
    expect(result.degraded).toHaveLength(2);
    expect(result.degraded[0]).toContain('#99');
    expect(result.degraded[1]).toContain('LINEAR_API_KEY');
  });
});

describe('gatherSpecSources: project boundary', () => {
  const ctx = {
    config: {
      gitlabHost: HOST,
      gitlabToken: 'bot',
      docsRepoProject: 'g/docs',
      projectAllowlist: ['g/p'],
    } as unknown as AppConfig,
    projectId: 7,
    projectPath: 'g/p',
    downloadDir: '/tmp/unused',
    log: { warn: () => undefined } as unknown as Logger,
  };

  it('should refuse a source from a project outside the MR project and the allowlist without any request', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await gatherSpecSources(ctx, [
      { kind: 'gitlab', target: 'secret-group/payroll#1' },
      { kind: 'gitlab', target: 'https://gitlab.com/secret-group/payroll/-/issues/2' },
    ]);

    expect(result.sources).toEqual([]);
    expect(result.degraded).toHaveLength(2);
    expect(result.degraded[0]).toContain('вне проекта этого MR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should accept the docs project and the MR project written by path', async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      String(input).includes('/notes')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ title: 'T', web_url: `${HOST}/g/docs/-/issues/3` }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await gatherSpecSources(ctx, [
      { kind: 'gitlab', target: 'g/docs#3' },
      { kind: 'gitlab', target: 'G/P#4' },
    ]);

    expect(result.sources).toHaveLength(2);
  });
});

describe('spec prompt', () => {
  const base = {
    diffMode: 'inline' as const,
    diff: 'd',
    projectPath: 'g/p',
    sourceBranch: 'f',
    targetBranch: 'main',
    sources: [{ label: '#34', title: 'Экран ника', body: 'Критерии' }],
    mrDescription: 'Задача: #34',
  };

  it('should ask the agent to assign source roles when sources were found automatically', () => {
    const prompt = buildSpecPrompt({ ...base, sourcesOrigin: 'mr' });
    expect(prompt).toContain('ИСТОЧНИК 1: #34 — Экран ника');
    expect(prompt).toContain('"ignoredSources"');
    expect(prompt).toContain('роль каждого определи сам');
  });

  it('should present the MR description as the author report, not as requirements', () => {
    const prompt = buildSpecPrompt({ ...base, sourcesOrigin: 'mr' });
    expect(prompt).toContain('это его отчёт, а не постановка');
    expect(prompt).toContain('Сделанное, о котором сказано только в описании MR, — тоже "extras"');
  });

  it('should treat sources named in the command as the spec', () => {
    const prompt = buildSpecPrompt({ ...base, sourcesOrigin: 'command' });
    expect(prompt).toContain('все они постановка этого MR');
    expect(prompt).not.toContain('роль каждого определи сам');
  });
});

describe('spec output', () => {
  const body = JSON.stringify({
    summary: 'ok',
    items: [{ requirement: 'Строка ника', status: 'met', evidence: 'A.kt:1' }],
    extras: [{ what: 'Новый FloatingToolbar', evidence: 'core/Toolbar.kt:10', note: 'в задаче нет' }],
    ignoredSources: [
      { source: '#35', reason: 'следующая задача' },
      { source: 'OPS-176', reason: 'не найдена' },
    ],
  });

  it('should parse extras and ignored sources and default them to empty', () => {
    const full = parseSpecOutput(`${SPEC_BEGIN}\n${body}\n${SPEC_END}`);
    expect(full.ok && full.spec.extras[0]?.what).toBe('Новый FloatingToolbar');
    const bare = parseSpecOutput(`${SPEC_BEGIN}\n{"summary":"x"}\n${SPEC_END}`);
    expect(bare.ok && bare.spec.extras).toEqual([]);
    expect(bare.ok && bare.spec.ignoredSources).toEqual([]);
  });

  it('should render sources, ignored sources and the scope-creep section', () => {
    const parsed = parseSpecOutput(`${SPEC_BEGIN}\n${body}\n${SPEC_END}`);
    if (!parsed.ok) throw new Error(parsed.reason);
    const note = buildSpecNote(parsed.spec, {
      sources: ['#34', '#35'],
      worktree: '/wt',
      linkify: (t) => t,
    });

    expect(note).toContain('Постановка: `#34`.');
    expect(note).toContain('`#35` (следующая задача)');
    expect(note).not.toContain('OPS-176');
    expect(note).toContain('### Сверх постановки');
    expect(note).toContain('Новый FloatingToolbar — core/Toolbar.kt:10.');
  });
});
