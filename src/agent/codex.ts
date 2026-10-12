import type { AppConfig } from '../config.js';
import type { Agent } from './types.js';
import { runCodex } from '../codex/run.js';

/**
 * Движок Codex под ChatGPT-подпиской (`CODEX_HOME` → auth.json). Тонкая обёртка над
 * существующим `runCodex`: config захвачен в замыкании, наружу — общий интерфейс Agent.
 * runCodex бросает `Codex*Error`, которые наследуют `Agent*Error` (см. codex/run.ts).
 */
export function createCodexAgent(config: AppConfig): Agent {
  return {
    name: 'codex',
    // readDirs не передаём: под `--sandbox read-only` codex читает соседние каталоги
    // штатно, отдельного разрешения (в отличие от claude `--add-dir`) ему не нужно.
    run: (prompt, { cwd, mcp, mrContext, needsWrite }) =>
      runCodex(prompt, { cwd, config, mcp, mrContext, needsWrite }),
  };
}
