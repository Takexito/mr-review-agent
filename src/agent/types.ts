import type { EngineName } from '../config.js';
import type { AgentAccess } from '../connectors/engineConfig.js';

/**
 * Абстракция движка ревью. Инкапсулирует запуск CLI-агента под подпиской
 * (codex exec / claude -p): на вход — готовый промпт, на выход — сырой текст
 * с маркерами (его дальше разбирают общие parse*-функции). config захвачен
 * в замыкании фабрики движка, поэтому run() принимает только worktree.
 */
export interface Agent {
  readonly name: EngineName;
  run(prompt: string, options: RunOptions): Promise<string>;
}

export interface RunOptions {
  /** Рабочая директория агента — worktree с кодом MR. */
  readonly cwd: string;
  /** Каталог джобы (родитель cwd): туда пишутся временные файлы вроде mcp.json. */
  readonly jobDir: string;
  /**
   * Каталоги вне cwd, которые агент должен уметь читать (чекаут доки, файлы MR).
   * codex читает их и так; claude — только через `--add-dir`.
   */
  readonly readDirs?: readonly string[];
  /** Прогону нужна запись в каталог джобы — codex поднимается в `workspace-write`. */
  readonly needsWrite?: boolean;
  /** Коннекторы, сеть и CLI-инструменты профиля проекта. Пусто — только чтение worktree. */
  readonly access?: AgentAccess;
}

/**
 * Движок упёрся в лимит подписки — такие джобы НЕ ретраим (постим «⏳» и выходим).
 */
export class AgentRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRateLimitError';
  }
}

/**
 * Токен подписки движка недействителен (401/invalidated). РЕТРАИБЕЛЬНО: часть 401
 * транзиентна, поэтому пробрасываем → BullMQ повторит; понятную remedy-заметку постим
 * только после исчерпания ретраев в `worker.on('failed')`.
 */
export class AgentAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAuthError';
  }
}

/** Прочий сбой запуска движка (ненулевой код, таймаут, отсутствие бинаря, битый вывод). */
export class AgentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunError';
  }
}
