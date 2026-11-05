import { describe, expect, it } from 'vitest';
import { claudeAllowedTools, claudeMcpConfig, codexMcpOverrides } from '../src/connectors/engineConfig.js';

describe('codexMcpOverrides', () => {
  it('should register a stdio connector with approve mode when tools are not filtered', () => {
    const overrides = codexMcpOverrides([
      { name: 'linear', config: { command: 'npx', args: ['-y', 'mcp-linear'], env: { LINEAR_API_TOKEN: 'lin_x' }, headers: {} } },
    ]);
    expect(overrides).toEqual([
      'mcp_servers.linear={command="npx",args=["-y","mcp-linear"],env={"LINEAR_API_TOKEN"="lin_x"},default_tools_approval_mode="approve"}',
    ]);
  });
});

describe('codexMcpOverrides: http', () => {
  it('should pass url, headers and the tool filter of an http connector', () => {
    const overrides = codexMcpOverrides([
      {
        name: 'sentry',
        config: { url: 'https://mcp.example/sse', args: [], env: {}, headers: { Authorization: 'Bearer t' }, tools: ['get_issue'] },
      },
    ]);
    expect(overrides).toEqual([
      'mcp_servers.sentry={url="https://mcp.example/sse",http_headers={"Authorization"="Bearer t"},enabled_tools=["get_issue"],default_tools_approval_mode="approve"}',
    ]);
  });
});

describe('claudeMcpConfig', () => {
  it('should describe stdio and http connectors in mcp.json format', () => {
    const config = claudeMcpConfig([
      { name: 'linear', config: { command: 'npx', args: ['-y', 'mcp-linear'], env: { T: '1' }, headers: {} } },
      { name: 'sentry', config: { url: 'https://mcp.example/mcp', args: [], env: {}, headers: { Authorization: 'Bearer t' } } },
    ]);
    expect(config).toEqual({
      mcpServers: {
        linear: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-linear'], env: { T: '1' } },
        sentry: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } },
      },
    });
  });
});

describe('claudeAllowedTools', () => {
  const base = ['Read', 'Grep'];

  it('should allow the whole server when its tools are not filtered and each listed tool otherwise', () => {
    const tools = claudeAllowedTools(base, {
      connectors: [
        { name: 'linear', config: { command: 'x', args: [], env: {}, headers: {} } },
        { name: 'gitlab', config: { command: 'x', args: [], env: {}, headers: {}, tools: ['get_issue', 'mr_discussions'] } },
      ],
      agentNetwork: false,
      cliTools: [],
    });
    expect(tools).toEqual(['Read', 'Grep', 'mcp__linear', 'mcp__gitlab__get_issue', 'mcp__gitlab__mr_discussions']);
  });

  it('should add web tools with agentNetwork and a Bash rule per cli tool', () => {
    const tools = claudeAllowedTools(base, { connectors: [], agentNetwork: true, cliTools: ['glab'] });
    expect(tools).toEqual(['Read', 'Grep', 'WebFetch', 'WebSearch', 'Bash(glab *)']);
  });
});
