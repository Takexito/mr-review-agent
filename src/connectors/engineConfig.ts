import type { ConnectorConfig } from '../config/schema.js';

export interface NamedConnector {
  readonly name: string;
  readonly config: Pick<ConnectorConfig, 'command' | 'args' | 'env' | 'url' | 'headers' | 'tools' | 'hint'>;
}

/** Значение `-c` парсится как TOML; JSON-строка совпадает с TOML basic string для всего, что тут бывает. */
function toml(value: string): string {
  return JSON.stringify(value);
}

function tomlTable(record: Readonly<Record<string, string>>): string {
  return `{${Object.entries(record)
    .map(([k, v]) => `${toml(k)}=${toml(v)}`)
    .join(',')}}`;
}

/**
 * Значения `-c` для `codex exec`: по одной таблице `mcp_servers.<name>` на коннектор.
 * Без `default_tools_approval_mode="approve"` `codex exec` отклоняет каждый tools/call
 * («requires approval, but approval policy is never»).
 */
export function codexMcpOverrides(connectors: readonly NamedConnector[]): string[] {
  return connectors.map(({ name, config }) => {
    const fields: string[] = [];
    if (config.command !== undefined) {
      fields.push(`command=${toml(config.command)}`, `args=[${config.args.map(toml).join(',')}]`);
      fields.push(`env=${tomlTable(config.env)}`);
    } else if (config.url !== undefined) {
      fields.push(`url=${toml(config.url)}`, `http_headers=${tomlTable(config.headers)}`);
    }
    if (config.tools) fields.push(`enabled_tools=[${config.tools.map(toml).join(',')}]`);
    fields.push('default_tools_approval_mode="approve"');
    return `mcp_servers.${name}={${fields.join(',')}}`;
  });
}

/** Что профиль проекта открывает агенту сверх чтения worktree. */
export interface AgentAccess {
  readonly connectors: readonly NamedConnector[];
  readonly agentNetwork: boolean;
  readonly cliTools: readonly string[];
}

export const NO_ACCESS: AgentAccess = { connectors: [], agentNetwork: false, cliTools: [] };

type ClaudeMcpServer =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export function claudeMcpConfig(connectors: readonly NamedConnector[]): { mcpServers: Record<string, ClaudeMcpServer> } {
  const mcpServers: Record<string, ClaudeMcpServer> = {};
  for (const { name, config } of connectors) {
    mcpServers[name] =
      config.command !== undefined
        ? { type: 'stdio', command: config.command, args: [...config.args], env: { ...config.env } }
        : { type: 'http', url: config.url ?? '', headers: { ...config.headers } };
  }
  return { mcpServers };
}

/**
 * `--allowedTools` для claude. В режиме `dontAsk` всё, чего нет в списке, запрещено, —
 * так коннектор без `tools` открыт целиком (`mcp__<name>`), а с `tools` — только перечисленное.
 */
export function claudeAllowedTools(base: readonly string[], access: AgentAccess): string[] {
  const tools = [...base];
  for (const { name, config } of access.connectors) {
    if (config.tools) tools.push(...config.tools.map((t) => `mcp__${name}__${t}`));
    else tools.push(`mcp__${name}`);
  }
  if (access.agentNetwork) tools.push('WebFetch', 'WebSearch');
  tools.push(...access.cliTools.map((t) => `Bash(${t} *)`));
  return tools;
}
