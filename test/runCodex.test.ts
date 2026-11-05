import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Мокаем execa, чтобы перехватить аргументы вызова и убедиться, что промпт
// уходит в stdin (`input`), а не позиционным argv (иначе большой промпт => E2BIG).
vi.mock('execa', () => {
  class ExecaError extends Error {}
  return {
    execa: vi.fn(async () => ({ stdout: 'codex-ok', stderr: '' })),
    ExecaError,
  };
});

import { execa } from 'execa';
import { runCodex } from '../src/codex/run.js';
import type { AgentAccess, NamedConnector } from '../src/connectors/engineConfig.js';
import type { AppConfig } from '../src/config.js';

const config = {
  codexBin: 'codex',
  codexHome: '/data/codex',
  codexReasoning: 'xhigh',
  codexTimeoutMs: 600_000,
  linearApiUrl: 'https://api.linear.app/graphql',
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
    expect(args).toEqual(['exec', '--sandbox', 'read-only', '-c', 'model_reasoning_effort=xhigh', '-']);
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
