import type { EngineName } from '../config.js';

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

/**
 * stdio-MCP-сервер, который движок должен поднять на время прогона.
 * Описываем структурно, а не готовой строкой: claude ждёт JSON-файл, codex — TOML в `-c`.
 */
export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Только то, что движку правда нужно. GITLAB_TOKEN сюда не попадает никогда. */
  readonly env: Readonly<Record<string, string>>;
}

export interface RunOptions {
  /** Рабочая директория агента — worktree с кодом MR. */
  readonly cwd: string;
  /** Каталог джобы (родитель cwd): туда пишутся временные файлы вроде mcp.json. */
  readonly jobDir: string;
  /**
   * Каталоги вне cwd, которые агент должен уметь читать (чекаут доки, раскладка Linear).
   * codex читает их и так; claude — только через `--add-dir`.
   */
  readonly readDirs?: readonly string[];
  /** Прогону нужна запись в каталог джобы — codex поднимается в `workspace-write`. */
  readonly needsWrite?: boolean;
  /** MCP-сервер для этого прогона. Пусто — движок работает без MCP. */
  readonly mcp?: McpServerSpec;
  /** Какой MR читают shell-CLI движка (у codex). Пусто — чтение MR недоступно. */
  readonly mrContext?: { readonly projectId: number; readonly mrIid: number; readonly downloadDir?: string };
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
