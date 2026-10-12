#!/usr/bin/env node
import { gitlabFetchUrl, gitlabMrInfo, gitlabMrNotes } from '../mcp/tools.js';

/**
 * CLI-доступ к текущему MR для codex (у claude то же самое доступно MCP-инструментами).
 *
 * Какой именно MR — берётся из окружения процесса (`GITLAB_PROJECT_ID`, `GITLAB_MR_IID`),
 * а не из аргументов: агенту незачем это выбирать. Это удобство, а не граница
 * безопасности — токен всё равно лежит в окружении, см. README.
 *
 * Использование:
 *   gitlab mr-info    — заголовок, автор, метки, полное описание MR
 *   gitlab mr-notes   — все треды MR целиком
 *   gitlab fetch <url|#34|!12> — любая ссылка GitLab: задача, MR, файл, вложение
 */

function usage(): string {
  return [
    'Использование:',
    '  gitlab mr-info   — заголовок, автор, ветки, метки и полное описание MR',
    '  gitlab mr-notes  — все обсуждения MR целиком (file:line, resolved, реплики)',
    '  gitlab fetch <url|#34|!12> — задача, MR, файл или вложение GitLab (картинка сохраняется на диск)',
  ].join('\n');
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return command ? 0 : 1;
  }

  if (command === 'mr-info' || command === 'mr-notes') {
    const result =
      command === 'mr-info' ? await gitlabMrInfo(process.env) : await gitlabMrNotes(process.env);
    process.stdout.write(`${result.text}\n`);
    return result.isError ? 1 : 0;
  }

  if (command === 'fetch') {
    const result = await gitlabFetchUrl(process.env, process.argv[3]);
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
