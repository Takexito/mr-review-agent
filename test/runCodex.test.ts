import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Мокаем execa, чтобы перехватить аргументы вызова и убедиться, что промпт
// уходит в stdin (`input`), а не позиционным argv (иначе большой промпт => E2BIG).
vi.mock('execa', () => {
  class ExecaError extends Error {}
  return {
    execa: vi.fn(async () => ({
      stdout: JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'codex-ok' } }),
      stderr: '',
    })),
    ExecaError,
  };
});

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runCodex } from '../src/codex/run.js';
import { sessionDayDir } from '../src/codex/subagentSessions.js';
import type { AgentAccess, NamedConnector } from '../src/connectors/engineConfig.js';
import type { AppConfig } from '../src/config.js';
import type { ToolCall } from '../src/agent/journal.js';
import { AgentRateLimitError } from '../src/agent/types.js';

const config = {
  codexBin: 'codex',
  codexHome: '/data/codex',
  codexReasoning: 'xhigh',
  codexTimeoutMs: 600_000,
} as AppConfig;

const NO_ACCESS: AgentAccess = { connectors: [], agentNetwork: false, cliTools: [] };
const linear: NamedConnector = {
  name: 'linear',
  config: { command: 'npx', args: ['-y', 'mcp-linear'], env: { LINEAR_API_TOKEN: 'lin_secret' }, headers: {} },
};

const mockedExeca = vi.mocked(execa);

beforeEach(() => {
  mockedExeca.mockClear();
});

describe('runCodex: промпт через stdin, не через argv', () => {
  it('передаёт большой промпт в stdin (input), а не позиционным аргументом', async () => {
    // >128 КБ: как позиционный argv это упало бы с E2BIG (MAX_ARG_STRLEN).
    const prompt = 'X'.repeat(200_000);

    const out = await runCodex(prompt, { cwd: '/tmp/wt', config });
    expect(out).toBe('codex-ok');

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockedExeca.mock.calls[0] as unknown as [
      string,
      readonly string[],
      Record<string, unknown>,
    ];

    expect(bin).toBe('codex');
    // Промпт НЕ должен присутствовать в argv.
    expect(args).not.toContain(prompt);
    // Обязателен stdin-маркер `-` (codex exec читает промпт из stdin).
    expect(args).toContain('-');
    // Промпт уходит в stdin через execa input.
    expect(opts.input).toBe(prompt);
    // Старый режим `stdin: 'ignore'` больше не используется.
    expect(opts.stdin).not.toBe('ignore');
  });

  it('прокидывает reasoning-effort и не кладёт промпт в argv', async () => {
    await runCodex('короткий промпт', { cwd: '/tmp/wt', config });
    const [, args] = mockedExeca.mock.calls[0] as unknown as [
      string,
      readonly string[],
      Record<string, unknown>,
    ];
    expect(args).toEqual(['exec', '--json', '--sandbox', 'read-only', '-c', 'model_reasoning_effort=xhigh', '-']);
  });
});

/**
 * Окружение агента раньше собиралось как `{...process.env}` — то есть GitLab-токен и
 * webhook-секрет доезжали до codex вопреки README. Пока сети не было, это оставалось
 * латентным; с `network_access` то же самое стало каналом утечки.
 */
describe('runCodex: окружение по allowlist', () => {
  const dirty = {
    PATH: '/usr/bin',
    HOME: '/root',
    GITLAB_TOKEN: 'glpat-secret',
    CLAUDE_GITLAB_TOKEN: 'glpat-secret-2',
    WEBHOOK_SECRET: 'hook-secret',
    REDIS_URL: 'redis://redis:6379',
    LINEAR_API_KEY: 'lin_secret',
  };

  beforeEach(() => {
    vi.stubEnv('GITLAB_TOKEN', dirty.GITLAB_TOKEN);
    vi.stubEnv('CLAUDE_GITLAB_TOKEN', dirty.CLAUDE_GITLAB_TOKEN);
    vi.stubEnv('WEBHOOK_SECRET', dirty.WEBHOOK_SECRET);
    vi.stubEnv('REDIS_URL', dirty.REDIS_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function envOf(call: number): Record<string, unknown> {
    const [, , opts] = mockedExeca.mock.calls[call] as unknown as [
      string,
      readonly string[],
      Record<string, unknown>,
    ];
    return opts.env as Record<string, unknown>;
  }

  it('не пропускает секреты бота в окружение агента', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config });

    const env = envOf(0);
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.CLAUDE_GITLAB_TOKEN).toBeUndefined();
    expect(env.WEBHOOK_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    // Значение не должно просочиться и под другим именем.
    expect(Object.values(env)).not.toContain(dirty.GITLAB_TOKEN);
  });

  it('оставляет базовые переменные, без которых процесс не запустится', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config });

    const env = envOf(0);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.CODEX_HOME).toBe('/data/codex');
    // Наследование поверх allowlist должно быть отключено.
    const [, , opts] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[], Record<string, unknown>];
    expect(opts.extendEnv).toBe(false);
  });

  it('кладёт в окружение агента переменные CLI-инструментов профиля', async () => {
    const glab = { name: 'glab', env: { GITLAB_TOKEN: 'glpat-cli' } };
    await runCodex('p', { cwd: '/tmp/wt', config, access: { ...NO_ACCESS, agentNetwork: true, cliTools: [glab] } });
    expect(envOf(0).GITLAB_TOKEN).toBe('glpat-cli');
    expect(envOf(0).CODEX_HOME).toBe('/data/codex');
  });

  it('не кладёт секреты коннекторов в окружение агента: они уходят в MCP-процесс', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config, access: { ...NO_ACCESS, connectors: [linear] } });
    expect(Object.values(envOf(0))).not.toContain('lin_secret');
  });
});

describe('runCodex: песочница', () => {
  it('остаётся read-only без сети, когда сеть профилем не открыта', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config, access: { ...NO_ACCESS, connectors: [linear] } });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args).toContain('read-only');
    expect(args.join(' ')).not.toContain('network_access');
  });

  it('переходит в workspace-write с сетью, когда профиль открыл agentNetwork', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config, access: { ...NO_ACCESS, agentNetwork: true } });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args).toContain('workspace-write');
    expect(args).toContain('sandbox_workspace_write.network_access=true');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('даёт запись без сети, когда прогону нужна запись в каталог джобы', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config, needsWrite: true });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args).toContain('workspace-write');
    expect(args.join(' ')).not.toContain('network_access');
  });
});

describe('runCodex: коннекторы', () => {
  it('регистрирует каждый коннектор профиля через -c, не снимая песочницу', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config, access: { ...NO_ACCESS, connectors: [linear] } });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    const override = args[args.findIndex((a) => a.startsWith('mcp_servers.linear='))];
    expect(override).toContain('default_tools_approval_mode="approve"');
    expect(args[args.indexOf(override!) - 1]).toBe('-c');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('runCodex: сбой не раскрывает токены коннекторов', () => {
  it('не включает командную строку с -c mcp_servers в текст ошибки', async () => {
    const { ExecaError } = await import('execa');
    const failure = Object.assign(new (ExecaError as unknown as new (m: string) => Error)('failed'), {
      shortMessage: 'Command failed with exit code 1: codex exec -c mcp_servers.linear={env={"T"="lin_secret"}} -',
      stderr: '',
      stdout: '',
      exitCode: 1,
      timedOut: false,
    });
    mockedExeca.mockRejectedValueOnce(failure);

    const error = await runCodex('p', { cwd: '/tmp/wt', config, access: { ...NO_ACCESS, connectors: [linear] } }).catch(
      (e: unknown) => e as Error,
    );
    expect(String(error)).not.toContain('lin_secret');
    expect(String(error)).toContain('1');
  });
});

/** Строки `codex exec --json` в том виде, в каком их отдаёт codex 0.165–0.166. */
function events(...items: readonly object[]): string {
  return items.map((e) => JSON.stringify(e)).join('\n');
}
const message = (text: string): object => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const mcpCall = (tool: string, args: object, status: string): object => ({
  type: 'item.completed',
  item: { type: 'mcp_tool_call', server: 'linear', tool, arguments: args, result: null, error: null, status },
});

describe('runCodex: поток событий --json', () => {
  it('возвращает последнее сообщение агента, а не промежуточные', async () => {
    mockedExeca.mockResolvedValueOnce({
      stdout: events({ type: 'thread.started' }, message('Сейчас посмотрю.'), message('ИТОГ')),
      stderr: '',
    } as never);

    expect(await runCodex('p', { cwd: '/tmp/wt', config })).toBe('ИТОГ');
  });

  it('записывает в журнал завершённые вызовы коннекторов с исходом', async () => {
    mockedExeca.mockResolvedValueOnce({
      stdout: events(
        { type: 'item.started', item: { type: 'mcp_tool_call', server: 'linear', tool: 'get_issue', status: 'in_progress' } },
        mcpCall('get_issue', { id: 'PRJ-7' }, 'completed'),
        mcpCall('get_issue', { id: 'BAD-1' }, 'failed'),
        { type: 'item.completed', item: { type: 'command_execution', command: 'ls', status: 'completed' } },
        message('OK'),
      ),
      stderr: '',
    } as never);

    const journal: ToolCall[] = [];
    await runCodex('p', { cwd: '/tmp/wt', config, journal });
    expect(journal).toEqual([
      { server: 'linear', tool: 'get_issue', arguments: { id: 'PRJ-7' }, ok: true },
      { server: 'linear', tool: 'get_issue', arguments: { id: 'BAD-1' }, ok: false },
    ]);
  });

  it('узнаёт лимит подписки по событию turn.failed: с --json codex пишет ошибки в stdout', async () => {
    const { ExecaError } = await import('execa');
    const failure = Object.assign(new (ExecaError as unknown as new (m: string) => Error)('failed'), {
      shortMessage: 'Command failed with exit code 1',
      stderr: '',
      stdout: events(
        // Предупреждения конфигурации приходят тем же типом `error`, но элементом, а не событием.
        { type: 'item.completed', item: { type: 'error', message: 'quota of something is deprecated' } },
        { type: 'turn.failed', error: { message: "You've hit your usage limit." } },
      ),
      exitCode: 1,
      timedOut: false,
    });
    mockedExeca.mockRejectedValueOnce(failure);

    await expect(runCodex('p', { cwd: '/tmp/wt', config })).rejects.toBeInstanceOf(AgentRateLimitError);
  });

  it('не принимает предупреждение-элемент и промежуточную ошибку переподключения за причину сбоя', async () => {
    const { ExecaError } = await import('execa');
    const failure = Object.assign(new (ExecaError as unknown as new (m: string) => Error)('failed'), {
      shortMessage: 'Command failed with exit code 1',
      stderr: '',
      stdout: events(
        { type: 'item.completed', item: { type: 'error', message: 'quota of something is deprecated' } },
        { type: 'error', message: 'Reconnecting... 1/5 (429 Too Many Requests)' },
        mcpCall('get_issue', { id: 'PRJ-7' }, 'completed'),
        { type: 'error', message: 'stream disconnected before completion' },
      ),
      exitCode: 1,
      timedOut: false,
    });
    mockedExeca.mockRejectedValueOnce(failure);

    const journal: ToolCall[] = [];
    const error = await runCodex('p', { cwd: '/tmp/wt', config, journal }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeInstanceOf(AgentRateLimitError);
    expect(error?.message).toContain('stream disconnected');
    // Упавшее дочитывание тоже открывало источники.
    expect(journal).toHaveLength(1);
  });
});

/** Сессия codex в `$CODEX_HOME/sessions/ГГГГ/ММ/ДД` — как её пишет codex 0.166. */
async function writeSession(home: string, id: string, parent: string | null, calls: readonly object[]): Promise<string> {
  const dir = sessionDayDir(home, new Date());
  await mkdir(dir, { recursive: true });
  const meta = { type: 'session_meta', payload: { id, ...(parent ? { parent_thread_id: parent } : {}) } };
  const items = calls.map((item) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: id, item } }));
  const path = join(dir, `rollout-x-${id}.jsonl`);
  // Недописанная строка в конце: codex мог ещё сбрасывать сессию, когда родитель завершился.
  await writeFile(path, `${[meta, ...items].map((l) => JSON.stringify(l)).join('\n')}\n{"type":"event_ms`);
  return path;
}
const sessionCall = (tool: string, id: string, ok: boolean): object => ({
  type: 'McpToolCall',
  server: 'linear',
  tool,
  arguments: { id },
  status: 'completed',
  result: { content: [], isError: !ok },
});

describe('runCodex: вызовы суб-агентов из их сессий', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('добавляет в журнал вызовы суб-агентов любой глубины и только этого прогона', async () => {
    await writeSession(home, 'root', null, [sessionCall('linear_getIssueById', 'ROOT-1', true)]);
    await writeSession(home, 'child', 'root', [sessionCall('linear_getIssueById', 'OPS-219', true)]);
    await writeSession(home, 'grandchild', 'child', [sessionCall('linear_getIssueById', 'BAD-1', false)]);
    await writeSession(home, 'stranger', 'other-root', [sessionCall('linear_getIssueById', 'X-1', true)]);
    // Сессия того же дерева, но давняя: id суб-агентов уникальны, так что попасть сюда она может только по ошибке фильтра.
    const old = await writeSession(home, 'old', 'root', [sessionCall('linear_getIssueById', 'OLD-1', true)]);
    await utimes(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    mockedExeca.mockResolvedValueOnce({
      stdout: events({ type: 'thread.started', thread_id: 'root' }, mcpCall('linear_getIssueById', { id: 'ROOT-1' }, 'completed'), message('OK')),
      stderr: '',
    } as never);

    const journal: ToolCall[] = [];
    await runCodex('p', { cwd: '/tmp/wt', config: { ...config, codexHome: home }, journal });

    expect(journal).toEqual([
      { server: 'linear', tool: 'linear_getIssueById', arguments: { id: 'ROOT-1' }, ok: true },
      { server: 'linear', tool: 'linear_getIssueById', arguments: { id: 'OPS-219' }, ok: true },
      { server: 'linear', tool: 'linear_getIssueById', arguments: { id: 'BAD-1' }, ok: false },
    ]);
  });

  it('добавляет вызовы суб-агентов и упавшего прогона', async () => {
    await writeSession(home, 'child', 'root', [sessionCall('linear_getIssueById', 'OPS-219', true)]);
    const { ExecaError } = await import('execa');
    const failure = Object.assign(new (ExecaError as unknown as new (m: string) => Error)('failed'), {
      shortMessage: 'Command failed with exit code 1',
      stderr: '',
      stdout: events({ type: 'thread.started', thread_id: 'root' }, { type: 'turn.failed', error: { message: 'stream disconnected' } }),
      exitCode: 1,
      timedOut: false,
    });
    mockedExeca.mockRejectedValueOnce(failure);

    const journal: ToolCall[] = [];
    await runCodex('p', { cwd: '/tmp/wt', config: { ...config, codexHome: home }, journal }).catch(() => undefined);
    expect(journal.map((c) => c.arguments)).toEqual([{ id: 'OPS-219' }]);
  });

  it('не роняет прогон, когда каталога сессий нет', async () => {
    mockedExeca.mockResolvedValueOnce({
      stdout: events({ type: 'thread.started', thread_id: 'root' }, message('OK')),
      stderr: '',
    } as never);

    const journal: ToolCall[] = [];
    expect(await runCodex('p', { cwd: '/tmp/wt', config: { ...config, codexHome: join(home, 'none') }, journal })).toBe('OK');
    expect(journal).toEqual([]);
  });
});
