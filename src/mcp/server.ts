#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import {
  gitlabFetchUrl,
  gitlabMrInfo,
  gitlabMrNotes,
  linearGetIssue,
  linearSearchIssues,
  type ToolResult,
} from './tools.js';

/**
 * stdio-MCP `ctxmcp`: даёт агенту дотянуться до Linear по ходу ревью.
 *
 * Запускается движком как дочерний процесс (`claude --mcp-config`), не сервером бота.
 * Поэтому в его окружение НЕ передаётся `GITLAB_TOKEN` — только `LINEAR_API_KEY`
 * (ключ на чтение). Документация сюда не заведена намеренно: чекаут docs-repo лежит
 * на диске рядом с worktree и читается обоими движками напрямую.
 *
 * Отдельная точка входа: `dist/mcp/server.js`, поднимается движком, не сервером.
 */

// loadConfig требует WEBHOOK_SECRET/GITLAB_TOKEN/BOT_USERNAME, которых у MCP-процесса нет
// и быть не должно. Подставляем заглушки: из конфига здесь нужны только поля Linear.
function loadMcpConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    ...process.env,
    WEBHOOK_SECRET: process.env['WEBHOOK_SECRET'] ?? 'mcp-unused',
    GITLAB_TOKEN: process.env['GITLAB_TOKEN'] ?? 'mcp-unused',
    BOT_USERNAME: process.env['BOT_USERNAME'] ?? 'mcp-unused',
  });
}

function toContent(result: ToolResult): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: 'text', text: result.text }], isError: result.isError };
}

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const server = new McpServer({ name: 'ctxmcp', version: '1.0.0' });

  server.registerTool(
    'linear_get_issue',
    {
      title: 'Linear: задача по ключу',
      description:
        'Возвращает задачу Linear по ключу (например PRJ-137): описание с критериями приёмки, ' +
        'метки, ссылку, родительскую задачу и привязанные документы (спеки). ' +
        'Зови, когда нужно свериться с постановкой или дочитать смежную задачу.',
      inputSchema: { key: z.string().describe('Ключ задачи, например "PRJ-137"') },
    },
    async ({ key }) => toContent(await linearGetIssue(config, key)),
  );

  server.registerTool(
    'linear_search_issues',
    {
      title: 'Linear: поиск задач',
      description:
        'Полнотекстовый поиск по задачам Linear. Возвращает список «ключ — заголовок»; ' +
        'полный текст затем бери через linear_get_issue.',
      inputSchema: {
        query: z.string().describe('Поисковый запрос'),
        limit: z.number().int().min(1).max(25).optional().describe('Сколько вернуть (по умолчанию 10)'),
      },
    },
    async ({ query, limit }) => toContent(await linearSearchIssues(config, query, limit)),
  );

  // Read-токен GitLab живёт в этом процессе, а не в окружении claude — так у самого
  // движка доступа к API нет, а инструменты работают.
  server.registerTool(
    'gitlab_mr_info',
    {
      title: 'GitLab: шапка и описание MR',
      description:
        'Заголовок, автор, ветки, метки и ПОЛНОЕ описание текущего merge request. ' +
        'Зови, когда нужно понять намерение автора — в промпт описание не вклеивается.',
      inputSchema: {},
    },
    async () => toContent(await gitlabMrInfo(process.env)),
  );

  server.registerTool(
    'gitlab_mr_notes',
    {
      title: 'GitLab: все треды MR',
      description:
        'Все обсуждения текущего MR целиком (локация file:line, статус resolved, реплики). ' +
        'В промпт попадает только срез — зови, если нужен полный контекст обсуждения.',
      inputSchema: {},
    },
    async () => toContent(await gitlabMrNotes(process.env)),
  );

  server.registerTool(
    'gitlab_fetch_url',
    {
      title: 'GitLab: содержимое по ссылке',
      description:
        'Открывает ссылку GitLab (полную или короткую вида #34 / !12 — относительно проекта текущего MR): задачу (описание и комментарии), merge request, файл репозитория ' +
        'или вложение. Картинки и прочие бинарные файлы сохраняются на диск — в ответе путь для Read. ' +
        'Зови, когда требования или обсуждение ссылаются на GitLab.',
      inputSchema: { url: z.string().describe('Полная ссылка GitLab либо короткая: #34, !12, group/project#34') },
    },
    async ({ url }) => toContent(await gitlabFetchUrl(process.env, url)),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  // stdout занят протоколом — диагностика только в stderr.
  process.stderr.write(`ctxmcp MCP failed to start: ${String(error)}\n`);
  process.exit(1);
});
