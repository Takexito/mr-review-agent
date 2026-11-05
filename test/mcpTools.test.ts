import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadLinearEnv, type LinearConfig } from '../src/config.js';
import { linearGetIssue, linearSearchIssues } from '../src/mcp/tools.js';
import { collectMentions, docFileName } from '../src/linear/materialize.js';

/**
 * Инструменты ctxmcp отдают агенту текст, а не бросают: недоступность Linear —
 * это повод продолжить ревью без требований, а не уронить джобу.
 */

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function config(over: Record<string, string> = {}): LinearConfig {
  return loadLinearEnv({
    LINEAR_API_KEY: 'lin_key',
    ...over,
  } as NodeJS.ProcessEnv);
}

function graphqlOk(data: unknown): void {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });
}

const ISSUE_NODE = {
  identifier: 'PRJ-137',
  title: 'Экспорт маршрутов',
  description: 'Критерии приёмки: экспорт в GPX. Зависит от PRJ-90.',
  url: 'https://linear.app/x/issue/PRJ-137',
  labels: { nodes: [{ name: 'android' }] },
  documents: { nodes: [{ title: 'Спека экспорта', content: 'Формат GPX 1.1' }] },
  parent: { identifier: 'PRJ-100', title: 'Эпик экспорта' },
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('linear_get_issue', () => {
  it('should render issue with documents when key resolves', async () => {
    graphqlOk({ issues: { nodes: [ISSUE_NODE] } });

    const result = await linearGetIssue(config(), 'PRJ-137');

    expect(result.isError).toBe(false);
    expect(result.text).toContain('PRJ-137');
    expect(result.text).toContain('Критерии приёмки');
    expect(result.text).toContain('Спека экспорта');
    expect(result.text).toContain('PRJ-100');
  });

  it('should report a usable error when key is missing', async () => {
    const result = await linearGetIssue(config(), '');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should report not found instead of throwing when issue is absent', async () => {
    graphqlOk({ issues: { nodes: [] } });

    const result = await linearGetIssue(config(), 'PRJ-999');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('не найдена');
  });

  it('should degrade with a message when API key is absent', async () => {
    const result = await linearGetIssue(config({ LINEAR_API_KEY: '' }), 'PRJ-137');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('LINEAR_API_KEY');
  });

  it('should degrade with a message when Linear returns an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    const result = await linearGetIssue(config(), 'PRJ-137');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('503');
  });
});

describe('linear_search_issues', () => {
  it('should return compact headers when matches exist', async () => {
    graphqlOk({ searchIssues: { nodes: [ISSUE_NODE] } });

    const result = await linearSearchIssues(config(), 'экспорт', 5);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('PRJ-137: Экспорт маршрутов');
    // Полный текст в поиск не тянем — он берётся точечно.
    expect(result.text).not.toContain('Формат GPX');
  });

  it('should say so plainly when nothing matched', async () => {
    graphqlOk({ searchIssues: { nodes: [] } });

    const result = await linearSearchIssues(config(), 'ничего', undefined);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('ничего не найдено');
  });

  it('should clamp limit to the allowed range when caller overshoots', async () => {
    graphqlOk({ searchIssues: { nodes: [] } });

    await linearSearchIssues(config(), 'x', 1000);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.variables.first).toBe(25);
  });

  it('should require a query when it is empty', async () => {
    const result = await linearSearchIssues(config(), '   ', 5);

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('раскладка Linear на диск', () => {
  it('should find referenced issue keys when description mentions them', () => {
    const found = collectMentions('Зависит от PRJ-90 и BE-12, см. также PRJ-90.', new Set(['PRJ-137']));

    expect(found).toEqual(['PRJ-90', 'BE-12']);
  });

  it('should not re-fetch issues already materialized', () => {
    const found = collectMentions('см. PRJ-100', new Set(['PRJ-100']));

    expect(found).toEqual([]);
  });

  it('should ignore lowercase words that look like keys', () => {
    expect(collectMentions('utf-8 и http-2 не задачи', new Set())).toEqual([]);
  });

  it('should build a filesystem-safe name from a document title', () => {
    expect(docFileName('Спека: экспорт / GPX', 0)).toBe('01-спека-экспорт-gpx.md');
    expect(docFileName('', 4)).toBe('05-document.md');
  });

  it('should keep document names free of path separators', () => {
    expect(docFileName('../../etc/passwd', 0)).not.toContain('/');
  });
});
