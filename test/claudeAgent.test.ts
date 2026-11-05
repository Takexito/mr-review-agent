import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Мокаем execa: перехватываем аргументы и подсовываем JSON-обёртку claude.
vi.mock('execa', () => {
  class ExecaError extends Error {}
  return {
    execa: vi.fn(async () => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CLAUDE_OK' }),
      stderr: '',
    })),
    ExecaError,
  };
});

import { execa } from 'execa';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAgent, extractClaudeResult } from '../src/agent/claude.js';
import { AgentRunError } from '../src/agent/types.js';
import type { AppConfig } from '../src/config.js';

const config = {
  claudeBin: 'claude',
  claudeModel: 'sonnet',
  claudePermissionMode: 'dontAsk',
  claudeAllowedTools: ['Read', 'Glob', 'Grep', 'Bash(git diff *)'],
  claudeTimeoutMs: 900_000,
  claudeOauthToken: 'tok-xxx',
} as unknown as AppConfig;

const mockedExeca = vi.mocked(execa);

beforeEach(() => {
  mockedExeca.mockClear();
});

describe('createClaudeAgent.run: read-only, промпт через stdin', () => {
  it('передаёт большой промпт в stdin (input), не в argv, и извлекает .result', async () => {
    const prompt = 'X'.repeat(200_000); // как argv → E2BIG
    const agent = createClaudeAgent(config);
    const out = await agent.run(prompt, { cwd: '/tmp/wt', jobDir: '/tmp/job' });
    expect(out).toBe('CLAUDE_OK');

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockedExeca.mock.calls[0] as unknown as [
      string,
      readonly string[],
      Record<string, unknown>,
    ];

    expect(bin).toBe('claude');
    expect(agent.name).toBe('claude');
    // Промпт НЕ в argv, а в stdin.
    expect(args).not.toContain(prompt);
    expect(opts.input).toBe(prompt);
    // Read-only headless-набор флагов.
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('dontAsk');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read,Glob,Grep,Bash(git diff *)');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    // Категорически НЕ должно быть: --bare (игнорит OAuth) и bypass прав.
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    // OAuth-токен подписки прокинут, случайный ANTHROPIC_API_KEY подавлен.
    const env = opts.env as Record<string, unknown>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-xxx');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('не пропускает секреты бота в окружение claude', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'glpat-secret');
    vi.stubEnv('WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('LINEAR_API_KEY', 'lin_secret');
    try {
      const agent = createClaudeAgent(config);
      await agent.run('p', { cwd: '/tmp/wt', jobDir: '/tmp/job' });

      const [, , opts] = mockedExeca.mock.calls[0] as unknown as [
        string,
        readonly string[],
        Record<string, unknown>,
      ];
      const env = opts.env as Record<string, unknown>;
      expect(env.GITLAB_TOKEN).toBeUndefined();
      expect(env.WEBHOOK_SECRET).toBeUndefined();
      expect(env.LINEAR_API_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(opts.extendEnv).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('не добавляет --add-dir и --mcp-config, когда контекста нет', async () => {
    const agent = createClaudeAgent(config);
    await agent.run('p', { cwd: '/tmp/wt', jobDir: '/tmp/job' });

    const args = mockedExeca.mock.calls[0]![1] as unknown as string[];
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--mcp-config');
  });
});

/**
 * Read/Grep у claude ограничены cwd — соседний чекаут доки и файлы MR видны
 * только через `--add-dir` (проверено вживую). MCP-конфиг несёт LINEAR_API_KEY,
 * поэтому файл обязан быть закрыт по правам.
 */
describe('createClaudeAgent.run: доступ к контексту вне cwd', () => {
  let jobDir: string;

  beforeEach(async () => {
    jobDir = await mkdtemp(join(tmpdir(), 'claude-agent-test-'));
  });

  afterEach(async () => {
    await rm(jobDir, { recursive: true, force: true });
  });

  it('открывает соседние каталоги через --add-dir', async () => {
    const agent = createClaudeAgent(config);
    await agent.run('p', {
      cwd: join(jobDir, 'repo'),
      jobDir,
      readDirs: [join(jobDir, 'docs-repo'), join(jobDir, 'linear')],
    });

    const args = mockedExeca.mock.calls[0]![1] as unknown as string[];
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(args).toContain(join(jobDir, 'docs-repo'));
    expect(args).toContain(join(jobDir, 'linear'));
  });

  it('пишет mcp.json коннекторов с правами 600, включает строгий режим и разрешает их инструменты', async () => {
    const agent = createClaudeAgent(config);
    await agent.run('p', {
      cwd: join(jobDir, 'repo'),
      jobDir,
      access: {
        connectors: [
          { name: 'linear', config: { command: 'npx', args: [], env: { LINEAR_API_TOKEN: 'lin_secret' }, headers: {} } },
        ],
        agentNetwork: false,
        cliTools: [],
      },
    });

    const args = mockedExeca.mock.calls[0]![1] as unknown as string[];
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,Bash(git diff *),mcp__linear');
    const path = args[args.indexOf('--mcp-config') + 1]!;

    const written = JSON.parse(await readFile(path, 'utf8'));
    expect(written.mcpServers.linear.env.LINEAR_API_TOKEN).toBe('lin_secret');

    // В файле лежат токены коннекторов.
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('extractClaudeResult', () => {
  it('достаёт result из успешной JSON-обёртки', () => {
    expect(
      extractClaudeResult(JSON.stringify({ type: 'result', is_error: false, result: 'HELLO' })),
    ).toBe('HELLO');
  });

  it('бросает AgentRunError на is_error', () => {
    expect(() =>
      extractClaudeResult(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns' })),
    ).toThrow(AgentRunError);
  });

  it('отдаёт вход как есть, если это не JSON', () => {
    expect(extractClaudeResult('=== BEGIN_REVIEW_JSON ===\n{}\n=== END_REVIEW_JSON ===')).toContain(
      'BEGIN_REVIEW_JSON',
    );
  });
});
