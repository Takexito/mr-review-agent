import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ConnectorConfig } from '../src/config.js';
import type { NamedConnector } from '../src/connectors/engineConfig.js';
import type { ConnectorSession, ToolResult } from '../src/connectors/mcpClient.js';
import { prefetchTargets } from '../src/spec/prefetch.js';
import type { DirectTarget } from '../src/spec/targets.js';
import type { Logger } from '../src/logger.js';

const log = { warn: () => undefined, info: () => undefined } as unknown as Logger;

function connector(prefetch: ConnectorConfig['prefetch']): ConnectorConfig {
  return { command: 'npx', args: [], env: {}, headers: {}, prefetch };
}

const connectors: Record<string, ConnectorConfig> = {
  linear: connector({ tool: 'linear_getIssueById', arguments: { id: '{key}' } }),
  gitlab: connector({ tool: 'get_issue', arguments: { project_id: '{project}', issue_iid: '{number}' } }),
};

const prj: DirectTarget = { label: 'PRJ-137', connector: 'linear', number: '137', project: 'g/p' };
const issue: DirectTarget = { label: 'g/docs#7', connector: 'gitlab', number: '7', project: 'g/docs' };

const text = (value: string): ToolResult => ({ isError: false, text: value, images: [] });

interface Call {
  readonly connector: string;
  readonly tool: string;
  readonly args: Record<string, string>;
}

function fakeOpen(reply: (call: Call) => ToolResult | Error) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const open = async ({ name }: NamedConnector): Promise<ConnectorSession> => {
    opened.push(name);
    return {
      call: async (tool, args) => {
        const call = { connector: name, tool, args };
        calls.push(call);
        const result = reply(call);
        if (result instanceof Error) throw result;
        return result;
      },
      close: async () => {
        closed.push(name);
      },
    };
  };
  return { open, calls, opened, closed };
}

async function deps(open: ReturnType<typeof fakeOpen>['open']) {
  return { connectors, open, imagesDir: await mkdtemp(join(tmpdir(), 'prefetch-')), log };
}

describe('prefetchTargets', () => {
  it('should call the prefetch tool with the target filled into the argument template and keep the reply as is', async () => {
    const fake = fakeOpen(() => text('# PRJ-137 Экран ника\n\nКритерии приёмки…'));
    const result = await prefetchTargets([prj, issue], await deps(fake.open));

    expect(fake.calls).toEqual([
      { connector: 'linear', tool: 'linear_getIssueById', args: { id: 'PRJ-137' } },
      { connector: 'gitlab', tool: 'get_issue', args: { project_id: 'g/docs', issue_iid: '7' } },
    ]);
    expect(result.fetched.map((f) => [f.target.label, f.text])).toEqual([
      ['PRJ-137', '# PRJ-137 Экран ника\n\nКритерии приёмки…'],
      ['g/docs#7', '# PRJ-137 Экран ника\n\nКритерии приёмки…'],
    ]);
    expect(result.degraded).toEqual([]);
  });

  it('should open each connector once for all its targets and close it afterwards', async () => {
    const fake = fakeOpen(() => text('ok'));
    const second: DirectTarget = { ...prj, label: 'PRJ-138', number: '138' };
    await prefetchTargets([prj, issue, second], await deps(fake.open));

    expect(fake.opened).toEqual(['linear', 'gitlab']);
    expect(fake.closed.sort()).toEqual(['gitlab', 'linear']);
    expect(fake.calls).toHaveLength(3);
  });

  it('should report a target the tool answered with an error and keep the others', async () => {
    const fake = fakeOpen((call) =>
      call.args['id'] === 'PRJ-137' ? { isError: true, text: 'Issue not found', images: [] } : text('ok'),
    );
    const result = await prefetchTargets([prj, issue], await deps(fake.open));

    expect(result.fetched.map((f) => f.target.label)).toEqual(['g/docs#7']);
    expect(result.degraded).toEqual(['Цель PRJ-137 не скачалась (linear): Issue not found']);
  });

  it('should report an empty reply as a target that did not download', async () => {
    const fake = fakeOpen(() => text('  '));
    const result = await prefetchTargets([prj], await deps(fake.open));

    expect(result.fetched).toEqual([]);
    expect(result.degraded).toEqual(['Цель PRJ-137 не скачалась (linear): пустой ответ инструмента linear_getIssueById']);
  });

  it('should report every target of a connector that failed to start', async () => {
    const fake = fakeOpen(() => text('ok'));
    const open: typeof fake.open = async (c) => {
      if (c.name === 'linear') throw new Error('spawn npx ENOENT');
      return fake.open(c);
    };
    const second: DirectTarget = { ...prj, label: 'PRJ-138', number: '138' };
    const result = await prefetchTargets([prj, second, issue], await deps(open));

    expect(result.fetched.map((f) => f.target.label)).toEqual(['g/docs#7']);
    expect(result.degraded).toEqual([
      'Цель PRJ-137 не скачалась (linear): spawn npx ENOENT',
      'Цель PRJ-138 не скачалась (linear): spawn npx ENOENT',
    ]);
  });

  it('should save images of the reply to files and point to them after the text', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const fake = fakeOpen(() => ({ isError: false, text: 'Макет ниже', images: [{ data: png, mimeType: 'image/png' }] }));
    const d = await deps(fake.open);
    const result = await prefetchTargets([prj], d);

    const body = result.fetched[0]!.text;
    const saved = /Картинка из ответа сохранена: (\S+)/.exec(body)?.[1];
    expect(body.startsWith('Макет ниже')).toBe(true);
    expect(saved?.startsWith(d.imagesDir)).toBe(true);
    expect(saved?.endsWith('.png')).toBe(true);
    expect((await readFile(saved!)).toString()).toBe('fake-png');
  });
});
