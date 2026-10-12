export const ORCHESTRATOR_BEGIN = '=== BEGIN_ORCHESTRATOR_JSON ===';
export const ORCHESTRATOR_END = '=== END_ORCHESTRATOR_JSON ===';

export type AxisName = 'bugs' | 'standards' | 'spec';

export const AXIS_LABEL: Record<AxisName, string> = {
  bugs: 'баги',
  standards: 'стандарты',
  spec: 'постановка',
};

/** Списки находок каждой оси — из них складывается идентификатор `ось:список:индекс`. */
export const AXIS_LISTS: Record<AxisName, readonly string[]> = {
  bugs: ['comments'],
  standards: ['violations', 'smells'],
  spec: ['items', 'extras'],
};

export interface AxisTask {
  readonly axis: AxisName;
  /** Готовый промпт оси — тот же, что у отдельной команды. */
  readonly promptFile: string;
  /** Куда суб-агент пишет ответ; бот читает этот файл сам, минуя пересказ оркестратора. */
  readonly outputFile: string;
}

export interface OrchestratorPromptInput {
  readonly projectPath: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly tasks: readonly AxisTask[];
}

function assignment(task: AxisTask): string {
  return (
    `Прочитай файл ${task.promptFile} и выполни его как своё задание целиком. Итоговый ответ — ровно тот, ` +
    `которого требует файл, вместе с маркерами — запиши в файл ${task.outputFile} и верни одну строку DONE.`
  );
}

export function buildOrchestratorPrompt(input: OrchestratorPromptInput): string {
  const ids = input.tasks.flatMap((t) => AXIS_LISTS[t.axis].map((list) => `\`${t.axis}:${list}:N\``));
  return [
    'Ты оркестратор ревью merge request. Ревью ведут суб-агенты, по одному на ось; твоя работа — запустить их,',
    'дождаться результатов и найти повторы между осями.',
    `Проект: ${input.projectPath}. Ветка ${input.sourceBranch} → ${input.targetBranch}.`,
    '',
    'ШАГ 1 — ЗАПУСК ОСЕЙ.',
    'Запусти параллельно по одному суб-агенту на каждую ось. Задание суб-агента — строка из списка, дословно;',
    'всё остальное он берёт из своего файла:',
    ...input.tasks.map((t) => `- ${t.axis}: «${assignment(t)}»`),
    'Шаг завершён, когда у каждой оси есть непустой файл результата. Ось без файла после завершения суб-агента',
    'запусти ещё один раз.',
    '',
    'ШАГ 2 — ПОВТОРЫ МЕЖДУ ОСЯМИ.',
    'Прочитай файлы результатов. Повтор — две находки РАЗНЫХ осей про одну и ту же проблему в одном и том же',
    'месте кода. В каждом повторе остаётся ("keep") находка, которая конкретнее и полезнее автору, вторая',
    'убирается ("drop").',
    `Идентификатор находки — ось, список и индекс с нуля: ${ids.join(', ')}.`,
    'Оси независимы: содержание, порядок и статусы находок остаются как в файлах; сводишь только пары из разных осей.',
    'Шаг завершён, когда проверена каждая пара находок разных осей с общим файлом.',
    '',
    'ШАГ 3 — ОТВЕТ.',
    `Верни РОВНО один JSON между маркерами ${ORCHESTRATOR_BEGIN} и ${ORCHESTRATOR_END}, без текста вокруг:`,
    ORCHESTRATOR_BEGIN,
    '{',
    '  "summary": "общий вывод по MR, 2-4 предложения: главное по каждой оси (markdown)",',
    '  "duplicates": [',
    '    { "drop": "standards:violations:0", "keep": "bugs:comments:2", "reason": "одна и та же проблема" }',
    '  ]',
    '}',
    ORCHESTRATOR_END,
    'Пустой "duplicates" — нормальный ответ, когда оси не пересеклись.',
  ].join('\n');
}
