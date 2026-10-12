import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLinearIssue } from '../src/linear/client.js';
import { fetchRequirements, formatIssue } from '../src/linear/requirements.js';
import type { AppConfig } from '../src/config.js';

const config = {
  linearApiKey: 'lin_test',
  linearApiUrl: 'https://api.linear.app/graphql',
} as AppConfig;

/** Мокает global fetch: отдаёт узел по ключу `TEAM-number` из variables. */
function mockGraphql(nodesByKey: Record<string, unknown>) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { variables: { teamKey: string; number: number } };
    const key = `${body.variables.teamKey}-${body.variables.number}`;
    const node = nodesByKey[key];
    return {
      ok: true,
      json: async () => ({ data: { issues: { nodes: node ? [node] : [] } } }),
    } as unknown as Response;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchLinearIssue', () => {
  it('maps a GraphQL node to a LinearIssue', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphql({
        'PRJ-137': {
          identifier: 'PRJ-137',
          title: 'T13',
          description: 'критерии',
          url: 'u',
          labels: { nodes: [{ name: 'route-editing' }] },
          documents: { nodes: [{ title: 'Спека', content: 'тело спеки' }] },
          parent: { identifier: 'PRJ-122', title: 'EPIC' },
        },
      }),
    );
    const issue = await fetchLinearIssue(config, 'PRJ-137');
    expect(issue?.identifier).toBe('PRJ-137');
    expect(issue?.labels).toEqual(['route-editing']);
    expect(issue?.documents).toEqual([{ title: 'Спека', content: 'тело спеки' }]);
    expect(issue?.parentIdentifier).toBe('PRJ-122');
  });

  it('defaults documents to empty when absent', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphql({
        'PRJ-1': { identifier: 'PRJ-1', title: 'x', description: '', url: 'u', labels: { nodes: [] }, parent: null },
      }),
    );
    const issue = await fetchLinearIssue(config, 'PRJ-1');
    expect(issue?.documents).toEqual([]);
  });

  it('returns null for a malformed key (no request needed)', async () => {
    vi.stubGlobal('fetch', mockGraphql({}));
    expect(await fetchLinearIssue(config, 'garbage')).toBeNull();
  });

  it('throws when no API key is configured', async () => {
    await expect(
      fetchLinearIssue({ ...config, linearApiKey: undefined } as AppConfig, 'PRJ-1'),
    ).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe('fetchRequirements', () => {
  it('bundles the task with its parent epic', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphql({
        'PRJ-137': {
          identifier: 'PRJ-137',
          title: 'T13',
          description: 'task body',
          url: 'u',
          labels: { nodes: [] },
          parent: { identifier: 'PRJ-122', title: 'EPIC' },
        },
        'PRJ-122': {
          identifier: 'PRJ-122',
          title: 'EPIC',
          description: 'epic body',
          url: 'u',
          labels: { nodes: [] },
          documents: { nodes: [{ title: 'Требования', content: 'полная спека' }] },
          parent: null,
        },
      }),
    );
    const req = await fetchRequirements(config, 'PRJ-137');
    expect(req.task).toContain('T13');
    expect(req.epicKey).toBe('PRJ-122');
    expect(req.epic).toContain('epic body');
    expect(req.spec).toContain('полная спека');
    expect(req.spec).toContain('## Требования');
  });

  it('returns nulls when the task is not found', async () => {
    vi.stubGlobal('fetch', mockGraphql({}));
    const req = await fetchRequirements(config, 'PRJ-999');
    expect(req.task).toBeNull();
    expect(req.epicKey).toBeNull();
    expect(req.spec).toBeNull();
  });
});

describe('formatIssue', () => {
  it('renders header, labels and description', () => {
    const s = formatIssue({
      identifier: 'PRJ-1',
      title: 'Title',
      description: 'Desc',
      url: 'u',
      labels: ['a', 'b'],
      documents: [],
    });
    expect(s).toContain('### PRJ-1: Title');
    expect(s).toContain('Метки: a, b');
    expect(s).toContain('Desc');
  });
});
