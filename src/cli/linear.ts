#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { linearGetIssue, linearSearchIssues } from '../mcp/tools.js';

/**
 * CLI-доступ к Linear для codex.
 *
 * Зачем отдельная точка входа рядом с MCP: `codex exec` не может звать MCP под песочницей
 * (каждый tools/call авто-отклоняется), но шелл-команды выполнять умеет. Под
 * `--sandbox workspace-write` + `network_access=true` у него есть сеть — значит, дотянуться
 * до Linear он может именно так. Логика та же, что у MCP-инструментов, — `mcp/tools.ts`.
 *
 * Использование:
 *   linear issue PRJ-137
 *   linear search "экспорт маршрутов" [limit]
 */

function usage(): string {
  return [
    'Использование:',
    '  linear issue <KEY>            — задача по ключу (описание, критерии приёмки, спеки)',
    '  linear search <query> [limit] — поиск задач, вернёт «ключ — заголовок»',
  ].join('\n');
}

// loadConfig требует переменных бота, которых у CLI нет и быть не должно:
// из конфига здесь нужны только поля Linear.
function loadCliConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    ...process.env,
    WEBHOOK_SECRET: process.env['WEBHOOK_SECRET'] ?? 'cli-unused',
    GITLAB_TOKEN: process.env['GITLAB_TOKEN'] ?? 'cli-unused',
    BOT_USERNAME: process.env['BOT_USERNAME'] ?? 'cli-unused',
  });
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return command ? 0 : 1;
  }

  const config = loadCliConfig();

  if (command === 'issue') {
    const result = await linearGetIssue(config, rest[0]);
    process.stdout.write(`${result.text}\n`);
    return result.isError ? 1 : 0;
  }

  if (command === 'search') {
    const limitArg = rest.length > 1 ? Number(rest[rest.length - 1]) : NaN;
    const hasLimit = Number.isFinite(limitArg);
    const query = (hasLimit ? rest.slice(0, -1) : rest).join(' ');
    const result = await linearSearchIssues(config, query, hasLimit ? limitArg : undefined);
    process.stdout.write(`${result.text}\n`);
    return result.isError ? 1 : 0;
  }

  process.stdout.write(`Неизвестная команда "${command}".\n${usage()}\n`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stdout.write(`Ошибка: ${String(error)}\n`);
    process.exit(1);
  });
