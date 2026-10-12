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
import { mcpOverride, runCodex } from '../src/codex/run.js';
import type { McpServerSpec } from '../src/agent/types.js';
import type { AppConfig } from '../src/config.js';

const config = {
  codexBin: 'codex',
  codexHome: '/data/codex',
  codexReasoning: 'xhigh',
  codexTimeoutMs: 600_000,
  linearApiUrl: 'https://api.linear.app/graphql',
} as AppConfig;

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

  it('отдаёт агенту read-токен GitLab, но НИКОГДА пишущий', async () => {
    await runCodex('p', {
      cwd: '/tmp/wt',
      config: {
        ...config,
        codexOndemandLinear: true,
        gitlabReadToken: 'glpat-readonly',
        gitlabToken: 'glpat-write',
        gitlabHost: 'https://gitlab.com',
      },
      mrContext: { projectId: 42, mrIid: 7 },
    });

    const env = envOf(0);
    expect(env.GITLAB_READ_TOKEN).toBe('glpat-readonly');
    expect(env.GITLAB_PROJECT_ID).toBe('42');
    expect(env.GITLAB_MR_IID).toBe('7');
    // Пишущий токен не должен просочиться ни под каким именем.
    expect(Object.values(env)).not.toContain('glpat-write');
  });

  it('не отдаёт read-токен, когда контекста MR нет', async () => {
    await runCodex('p', {
      cwd: '/tmp/wt',
      config: { ...config, codexOndemandLinear: true, gitlabReadToken: 'glpat-readonly' },
    });

    expect(envOf(0).GITLAB_READ_TOKEN).toBeUndefined();
  });

  it('даёт ключ Linear только когда включён on-demand CLI', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config: { ...config, linearApiKey: 'lin_secret' } });
    expect(envOf(0).LINEAR_API_KEY).toBeUndefined();

    await runCodex('p', {
      cwd: '/tmp/wt',
      config: { ...config, linearApiKey: 'lin_secret', codexOndemandLinear: true },
    });
    expect(envOf(1).LINEAR_API_KEY).toBe('lin_secret');
  });
});

/**
 * Сеть codex доступна только в workspace-write: под read-only DNS не резолвится
 * (проверено — curl отдаёт exit 6). Поэтому on-demand Linear и режим песочницы связаны.
 */
describe('runCodex: песочница под on-demand', () => {
  it('остаётся read-only, пока on-demand выключен', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args).toContain('read-only');
    expect(args.join(' ')).not.toContain('network_access');
  });

  it('переходит в workspace-write с сетью, когда on-demand включён', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config: { ...config, codexOndemandLinear: true } });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args).toContain('workspace-write');
    expect(args).toContain('sandbox_workspace_write.network_access=true');
    // Полное снятие песочницы недопустимо ни при каких флагах.
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

/**
 * `codex exec` регистрирует MCP-сервер через `-c`, но авто-отклоняет каждый tools/call
 * под песочницей (проверено на 0.145.0 и 0.147.0). Поэтому по умолчанию MCP к codex не
 * подключается — код готов и ждёт флага, а Linear ему раскладывается на диск.
 */
describe('runCodex: MCP за флагом', () => {
  const mcp: McpServerSpec = {
    name: 'ctxmcp',
    command: '/usr/bin/node',
    args: ['/app/dist/mcp/server.js'],
    env: { LINEAR_API_KEY: 'lin_secret' },
  };

  it('не подключает MCP, пока CODEX_MCP_ENABLED не выставлен', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config, mcp });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args.join(' ')).not.toContain('mcp_servers');
  });

  it('подключает MCP, когда флаг включён', async () => {
    await runCodex('p', { cwd: '/tmp/wt', config: { ...config, codexMcpEnabled: true }, mcp });

    const [, args] = mockedExeca.mock.calls[0] as unknown as [string, readonly string[]];
    expect(args.some((a) => a.startsWith('mcp_servers.ctxmcp='))).toBe(true);
    // Песочница остаётся: включение MCP не должно её снимать.
    expect(args).toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('строит валидную inline-TOML-таблицу', () => {
    expect(mcpOverride(mcp)).toBe(
      'mcp_servers.ctxmcp={command="/usr/bin/node",args=["/app/dist/mcp/server.js"],env={LINEAR_API_KEY="lin_secret"}}',
    );
  });

  it('экранирует пути с кавычками и бэкслэшами', () => {
    const tricky: McpServerSpec = { ...mcp, args: ['/a/"b"\\c.js'], env: {} };
    expect(mcpOverride(tricky)).toContain('args=["/a/\\"b\\"\\\\c.js"]');
  });
});
