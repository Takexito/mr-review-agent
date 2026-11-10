import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { NamedConnector } from './engineConfig.js';

/** Первый запуск `npx -y <сервер>` скачивает пакет — это десятки секунд. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface ToolImage {
  /** base64, как в MCP `ImageContent`. */
  readonly data: string;
  readonly mimeType: string;
}

export interface ToolResult {
  readonly isError: boolean;
  /** Текстовые части ответа подряд, без разбора. */
  readonly text: string;
  readonly images: readonly ToolImage[];
}

/** Подключение бота к MCP-серверу коннектора на время одной джобы. */
export interface ConnectorSession {
  call(tool: string, args: Readonly<Record<string, string>>): Promise<ToolResult>;
  close(): Promise<void>;
}

export type OpenConnector = (connector: NamedConnector) => Promise<ConnectorSession>;

function toResult(raw: Record<string, unknown>): ToolResult {
  const content = Array.isArray(raw['content']) ? (raw['content'] as Record<string, unknown>[]) : [];
  const texts = content.filter((c) => c['type'] === 'text').map((c) => String(c['text'] ?? ''));
  // Сервер, отдающий только structuredContent, иначе выглядел бы пустым ответом.
  if (texts.length === 0 && raw['structuredContent'] !== undefined) {
    texts.push(JSON.stringify(raw['structuredContent'], null, 2));
  }
  const images = content
    .filter((c) => c['type'] === 'image' && typeof c['data'] === 'string')
    .map((c) => ({ data: String(c['data']), mimeType: String(c['mimeType'] ?? 'application/octet-stream') }));
  return { isError: raw['isError'] === true, text: texts.join('\n\n'), images };
}

/** Тот же сервер, что получает агент (`claudeMcpConfig`, `codexMcpOverrides`), но клиентом выступает бот. */
export const openConnector: OpenConnector = async ({ name, config }) => {
  const transport =
    config.command !== undefined
      ? // stderr сервера может цитировать его env с токеном — в лог бота он попасть не должен.
        new StdioClientTransport({ command: config.command, args: [...config.args], env: { ...config.env }, stderr: 'ignore' })
      : new StreamableHTTPClientTransport(new URL(config.url ?? ''), { requestInit: { headers: { ...config.headers } } });
  const client = new Client({ name: `mr-review-agent-prefetch-${name}`, version: '1.0.0' });
  await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
  return {
    call: async (tool, args) =>
      toResult((await client.callTool({ name: tool, arguments: { ...args } }, undefined, { timeout: REQUEST_TIMEOUT_MS })) as Record<string, unknown>),
    close: () => client.close(),
  };
};
