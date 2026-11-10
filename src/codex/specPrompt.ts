import {
  contextSection,
  coverageFields,
  diffSection,
  SPEC_BEGIN,
  SPEC_END,
  type DiffPromptInput,
} from './prompts.js';

export interface SpecPromptTarget {
  /** `PRJ-137`, `#34` — агент ставит её в "target" каждого пункта. */
  readonly label: string;
  readonly text: string;
  readonly file: string;
}

/** `inline` — текст целей в промпте; `files` — в промпте оглавление, текст в файлах. */
export type TargetsMode = 'inline' | 'files';

export interface SpecPromptInput extends DiffPromptInput {
  readonly projectPath: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  /** Скачанные прямые цели: всё это — постановка MR. */
  readonly targets: readonly SpecPromptTarget[];
  readonly targetsMode: TargetsMode;
  /** Повторный прогон только по целям, по которым первый не выписал ни одного пункта. */
  readonly followup?: boolean;
  readonly mrTitle?: string;
  readonly mrDescription?: string;
  /** Существующие треды MR (для дедупа). */
  readonly existingThreads?: string;
  /** Пометки о недоступных источниках — попадут в контекст. */
  readonly degraded?: readonly string[];
  /** Где искать доки/смежные задачи — вместо вклейки контрактов в промпт. */
  readonly contextHints?: readonly string[];
}

/** Добавляет секцию `## ЗАГОЛОВОК\n<тело>` в аккумулятор, если тело непустое. */
function pushSection(lines: string[], title: string, body?: string): void {
  if (body && body.trim().length > 0) {
    lines.push('', `## ${title}`, body.trim());
  }
}

function targetLines(input: SpecPromptInput): string[] {
  if (input.targetsMode === 'inline') {
    const lines: string[] = [];
    input.targets.forEach((t, i) => pushSection(lines, `ЦЕЛЬ ${i + 1}: ${t.label}`, t.text));
    return lines;
  }
  return [
    '',
    `## ЦЕЛИ MR — ${input.targets.length}, текст в файлах (он слишком большой для промпта)`,
    ...input.targets.map((t, i) => `${i + 1}. ${t.label} — \`${t.file}\` (${t.text.length} символов)`),
    'Прочитай каждый файл целиком, прежде чем выписывать пункты: без чтения ты не знаешь, что просили.',
  ];
}

export function buildSpecPrompt(input: SpecPromptInput): string {
  const labels = input.targets.map((t) => `"${t.label}"`).join(', ');
  const lines: string[] = [
    'Ты ревьюер merge request по оси ПОСТАНОВКА: сверяешь изменение с тем, что просили сделать.',
    'Результат — что из постановки выполнено, что нет и что сделано сверх неё. Баги вне постановки — ось другого ревьюера.',
    `Проект: ${input.projectPath}. Ветка ${input.sourceBranch} → ${input.targetBranch}.`,
    'Репозиторий выкачан в рабочую директорию — каждый статус подтверждай чтением кода.',
  ];
  if (input.followup) {
    lines.push(
      '',
      'ДОЧИТЫВАНИЕ ЦЕЛЕЙ. По остальным целям этого MR пункты уже выписаны предыдущим проходом — не повторяй их.',
      'В этом проходе выпиши пункты ТОЛЬКО по целям ниже, по каждой. "extras" оставь пустым.',
    );
  }

  pushSection(
    lines,
    `ОПИСАНИЕ MR${input.mrTitle ? ` — ${input.mrTitle}` : ''} (пишет автор изменения — это его отчёт, а не постановка)`,
    input.mrDescription,
  );
  lines.push(...targetLines(input));
  lines.push(...contextSection(input.contextHints));

  if (input.degraded && input.degraded.length > 0) {
    lines.push(
      '',
      'ЧАСТЬ ИСТОЧНИКОВ НЕДОСТУПНА (сверяй по тому, что есть; недоказуемое — "unclear"):',
      ...input.degraded.map((d) => `- ${d}`),
    );
  }

  lines.push(
    '',
    'ШАГ 1 — ПУНКТЫ ПОСТАНОВКИ.',
    'Цели выше — задачи, которые этот MR реализует; бот определил их по заголовку, ветке, строкам Closes/Refs или команде.',
    'Прочее, что в них упомянуто (соседние задачи, ссылки), — фон: открывай через MCP-серверы, если нужно для понимания, но пункты бери только из целей.',
    'Выпиши проверяемые пункты: критерии приёмки, пункты DoD/тестов и пункты привязанных документов в объёме MR.',
    'Каждый пункт опирается на текст цели, который ты можешь процитировать; в "target" — метка этой цели.',
    'Одно требование, повторённое в задаче и в документе, — один пункт (формулировка из более конкретного источника).',
    'Описание MR — отчёт автора о сделанном: требований оно не добавляет.',
    'Статус каждого пункта — по фактическому коду MR:',
    '- "met" — реализовано, есть конкретный код-подтверждение;',
    '- "violated" — противоречит требованию либо должно быть, но не сделано;',
    '- "unclear" — подтвердить по коду и источникам не удалось;',
    '- "na" — пункт постановки, который этот MR закрывать не должен (например, чистый бэкенд-контракт).',
    '"evidence" — относительный путь и строка в НОВОЙ версии (`путь/Файл.kt:42`), лучший доступный якорь; "note" — почему такой статус.',
    `Шаг завершён, когда по каждой цели (${labels}) есть хотя бы один пункт и каждый её критерий приёмки учтён ровно в одном пункте.`,
    '',
    'ШАГ 2 — СВЕРХ ПОСТАНОВКИ.',
    'Пройди изменённые файлы: каждый относится либо к пункту из шага 1 (включая его обвязку — тесты, DI, ресурсы, навигацию),',
    'либо к "extras" — поведение или объём, которого постановка не просит. В "extras" пиши, что именно добавлено и почему это вне постановки.',
    'Сделанное, о котором сказано только в описании MR, — тоже "extras": автор сообщил о нём сам, постановка его не просила.',
    'Шаг завершён, когда каждый изменённый файл отнесён к пункту или к "extras".',
  );

  if (input.existingThreads && input.existingThreads.trim().length > 0) {
    lines.push(
      '',
      'УЖЕ ОБСУЖДЕНО В ЭТОМ MR (если пункт закрыт тредом — учитывай это в статусе):',
      input.existingThreads.trim(),
      '',
      'Ответы автора в тредах — это довод, а не приговор. «Уже починил» проверяй по текущему коду;',
      '«так задумано» проверяй по существу. Если довод не снимает несоответствие — оставляй',
      '"violated" и объясни в "note", почему аргумент не закрывает пункт.',
    );
  }

  lines.push(
    '',
    `Верни РОВНО один JSON между маркерами ${SPEC_BEGIN} и ${SPEC_END}, без текста вокруг:`,
    SPEC_BEGIN,
    '{',
    '  "summary": "краткий вывод о соответствии (markdown, 1-4 предложения)",',
    ...coverageFields(input.diffMode),
    '  "items": [',
    '    { "target": "метка цели", "requirement": "формулировка требования", "status": "met|violated|unclear|na", "evidence": "относит/путь.kt:42", "note": "почему такой статус" }',
    '  ],',
    '  "extras": [',
    '    { "what": "что сделано сверх постановки", "evidence": "относит/путь.kt:42", "note": "почему это вне постановки" }',
    '  ]',
    '}',
    SPEC_END,
    'Пустой "extras" — нормальный ответ; пустой "items" — только если цель не открылась, и тогда объясни это в summary.',
  );

  lines.push(...diffSection(input));
  return lines.join('\n');
}
