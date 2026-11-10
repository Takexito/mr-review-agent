import type { ChangedFile, DiffMode } from '../git/diff.js';

export const REVIEW_BEGIN = '=== BEGIN_REVIEW_JSON ===';
export const REVIEW_END = '=== END_REVIEW_JSON ===';
export const ANSWER_BEGIN = '=== BEGIN_ANSWER ===';
export const ANSWER_END = '=== END_ANSWER ===';
export const SPEC_BEGIN = '=== BEGIN_SPEC_JSON ===';
export const SPEC_END = '=== END_SPEC_JSON ===';

/**
 * Всё, что нужно, чтобы показать агенту дифф — в одном месте, потому что раньше
 * инструкция «дочитай остальное сам» жила ТОЛЬКО в review-промпте, а ASK и SPEC
 * получали одну строку «дифф усечён» и молча ревьюили половину.
 */
export interface DiffPromptInput {
  readonly diffMode: DiffMode;
  /** Тело диффа; в режиме `agentic` пустое и в промпт не идёт. */
  readonly diff: string;
  /** Полный diffstat (ВСЕ затронутые файлы). */
  readonly diffStat?: string;
  /** Полный список изменённых файлов — из него строится чеклист обхода. */
  readonly files?: readonly ChangedFile[];
  readonly baseSha?: string;
  readonly headSha?: string;
  /** Пути, исключённые из диффа (`exclude` из `.review.yml`). */
  readonly exclude?: readonly string[];
}

/** Те же pathspec, что у бота в `computeDiff`: иначе агент сам прочитает исключённое. */
function excludeSpec(exclude: readonly string[] | undefined): string {
  return exclude && exclude.length > 0 ? ` -- ${exclude.map((p) => `':(exclude,glob)${p}'`).join(' ')}` : '';
}

/** Сколько файлов перечисляем поимённо, прежде чем отослать к diffstat. */
const MAX_CHECKLIST = 200;

function checklist(files: readonly ChangedFile[]): string[] {
  const shown = files.slice(0, MAX_CHECKLIST);
  const lines = shown.map((f, i) => `${i + 1}. ${f.path} (+${f.added}/-${f.deleted})`);
  if (files.length > shown.length) {
    lines.push(`…и ещё ${files.length - shown.length} файлов — полный список в diffstat выше.`);
  }
  return lines;
}

/**
 * Секция диффа. `inline` — тело целиком в промпте. `agentic` — тела нет вовсе:
 * вместо него полный состав изменения и требование обойти его пофайлово самому.
 *
 * Важно, что здесь НЕТ формулировки «ревьюй присланное»: именно она когда-то и
 * порождала ложную уверенность на усечённом диффе.
 */
export function diffSection(input: DiffPromptInput): string[] {
  if (input.diffMode === 'inline') {
    return ['', 'Дифф MR (unified):', '```diff', input.diff, '```'];
  }

  const range = input.baseSha && input.headSha ? `${input.baseSha}..${input.headSha}` : 'base..head';
  const stat = input.diffStat?.trim() ? input.diffStat.trim() : '(diffstat недоступен)';
  const files = (input.files ?? []).filter((f) => !f.binary);
  const binaries = (input.files ?? []).length - files.length;

  return [
    '',
    'ДИФФ НЕ ПРИЛОЖЕН: он слишком большой для промпта. Репозиторий выкачан в рабочую директорию —',
    'прочитай дифф сам, пофайлово. Это не опция: без чтения ты не видишь изменений вообще.',
    '',
    `Команда на файл: \`git diff ${range} -- <файл>\``,
    `Весь дифф разом: \`git diff ${range}${excludeSpec(input.exclude)}\` (может быть очень большим — лучше по файлам).`,
    '',
    'Полный состав изменения (git diff --stat):',
    '```',
    stat,
    '```',
    ...(files.length > 0
      ? [
          '',
          `ЧЕКЛИСТ — ${files.length} изменённых файлов. Иди сверху вниз, ни один не пропускай:`,
          ...checklist(files),
        ]
      : []),
    ...(binaries > 0
      ? [
          '',
          `Бинарные файлы (${binaries}, в diffstat помечены \`Bin\`) читать не нужно и в "reviewedFiles"/"skippedFiles" не включай.`,
        ]
      : []),
    '',
    'Читай связанный код (Read/Grep) там, где нужно понять влияние правки.',
    'В ответном JSON обязательно заполни "reviewedFiles" — пути, которые ты РЕАЛЬНО прочитал,',
    'и "skippedFiles" — что не смотрел и почему. Не приписывай себе непрочитанное:',
    'по этим полям в MR публикуется честная отметка о полноте ревью.',
  ];
}

/** Поля самоотчёта в JSON-схеме — нужны только когда агент обходит дифф сам. */
export function coverageFields(mode: DiffMode): string[] {
  if (mode === 'inline') return [];
  return [
    '  "reviewedFiles": ["путь/который/прочитал.kt"],',
    '  "skippedFiles": [{ "path": "путь/пропущен.kt", "reason": "почему" }],',
  ];
}

/**
 * Поле "disputed" показываем, только когда есть треды: без прошлых обсуждений оспаривать
 * нечего, а лишнее поле в схеме провоцирует агента что-нибудь туда положить.
 */
function disputedField(existingThreads: string | undefined): string[] {
  if (!existingThreads || existingThreads.trim().length === 0) return [];
  return [
    '  "disputed": [',
    '    { "path": "относительный/путь.kt", "line": 42, "body": "в чём проблема",',
    '      "reason": "почему довод автора её не снимает" }',
    '  ],',
  ];
}

export interface ReviewPromptInput extends DiffPromptInput {
  readonly projectPath: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  /** Существующие треды MR (для дедупа и учёта ответов автора). Пусто = нет. */
  readonly existingThreads?: string;
  /** Где искать требования и доки (собирается в `contextSection`). Пусто = нечего показать. */
  readonly contextHints?: readonly string[];
}

/**
 * Общая граница для осей с находками по коду (баги, стандарты). Это запреты, и сформулировать
 * их как цель нельзя: каждый пункт — повторяющийся класс ложных срабатываний.
 */
export function outOfScopeSection(): string[] {
  return [
    '',
    'ВНЕ ЗОНЫ НАХОДОК — такое в ответ не идёт:',
    '- то, что ловит компилятор, линтер или форматтер, и то, что подавлено (`@Suppress`, `lint-ignore`) с пояснением;',
    '- строки, которые этот MR не добавил и не изменил, даже если проблема в них настоящая;',
    '- изменение поведения, которое соответствует цели MR из его описания или задачи;',
    '- «может сломаться при некоторых входах» без конкретного сценария: какие входы, какие шаги, что получится.',
  ];
}

export function contextSection(hints: readonly string[] | undefined): string[] {
  if (!hints || hints.length === 0) return [];
  return ['', 'ГДЕ ИСКАТЬ КОНТЕКСТ:', ...hints.map((h) => `- ${h}`)];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return [
    'Ты выступаешь ревьюером предложенного изменения кода (merge request), сделанного другим инженером.',
    `Проект: ${input.projectPath}. Ветка ${input.sourceBranch} → ${input.targetBranch}.`,
    'Репозиторий выкачан в рабочую директорию — читай связанные файлы, чтобы проверить влияние изменений.',
    '',
    'ЧТО ФЛАГАТЬ (проблему стоит выписать, если выполняются критерии):',
    '1. Существенно влияет на корректность, производительность, безопасность или поддерживаемость.',
    '2. Проблема дискретная и actionable — не «общая проблема кодбазы» и не комбинация нескольких.',
    '3. Внесена ЭТИМ изменением (диффом).',
    '4. Не спекулируй: если правка ломает что-то в другом месте — укажи конкретный, доказуемо затронутый код (прочитай файлы, чтобы убедиться).',
    '5. Не опирайся на недосказанные предположения о намерениях автора; это явно не намеренное поведение.',
    '6. Автор, скорее всего, захотел бы это починить.',
    '',
    'СКОЛЬКО НАХОДОК:',
    '- Выпиши ВСЕ подходящие под критерии проблемы. НЕ останавливайся на первой.',
    '- Если нет ни одной, которую автор точно захотел бы увидеть и починить — верни пустой comments (лучше ноль, чем спекулятивный шум).',
    '- Игнорируй тривиальный стиль, если он не мешает пониманию и не нарушает документированный стандарт.',
    ...outOfScopeSection(),
    '',
    'КАК ПИСАТЬ body замечания:',
    '- Ясно, ПОЧЕМУ это баг и при каких условиях/входах он проявляется.',
    '- Кратко (≤1 абзац), тон нейтральный, без похвал и лести. Код-фрагменты ≤3 строк в inline-code.',
    '',
    'severity: "blocker" — критично (баг/уязвимость/потеря данных; ≈P0/P1); "warn" — риск/плохая практика (≈P2); "info" — мелочь/nice-to-have (≈P3).',
    '',
    `Верни РОВНО один JSON между маркерами ${REVIEW_BEGIN} и ${REVIEW_END}, без текста вокруг:`,
    REVIEW_BEGIN,
    '{',
    '  "summary": "краткое резюме ревью (markdown, 1-4 предложения)",',
    ...coverageFields(input.diffMode),
    ...disputedField(input.existingThreads),
    '  "comments": [',
    '    { "path": "относительный/путь.kt", "line": 42, "severity": "warn", "body": "суть замечания" }',
    '  ]',
    '}',
    REVIEW_END,
    'Поле "line" — номер строки в НОВОЙ версии файла; привязывай каждое замечание к изменённой строке. Если находок нет — comments: [].',
    ...contextSection(input.contextHints),
    ...(input.existingThreads && input.existingThreads.trim().length > 0
      ? [
          '',
          'УЖЕ ОБСУЖДЕНО В ЭТОМ MR (существующие треды — автор мог их пофиксить или ответить):',
          input.existingThreads,
          '',
          'С учётом тредов выше:',
          '- НЕ повторяй уже поднятые замечания (даже перефразированные) в "comments".',
          '- Ответ «уже починил» — ПРОВЕРЬ по текущему коду. Правка на месте → замечание закрыто,',
          '  не поднимай. Правки нет → подними снова в "comments" и сошлись на тред.',
          '- Ответ «так задумано / не буду чинить» — inline повторно НЕ дублируй. Но и не принимай',
          '  на веру: проверь сам аргумент. Если он снимает проблему — вопрос закрыт.',
          '  Если НЕ снимает, а проблема серьёзная (уровень blocker, вред доказуем) — положи её в',
          '  "disputed": в MR это отдельный раздел сводки, а не новый тред.',
          '- В "disputed" клади ТОЛЬКО проверенное: где ты разобрал довод автора и он не выдерживает.',
          '  Не спорь ради спора — промолчать это нормальный и частый исход.',
          '- В "comments" — только новые проблемы, не покрытые существующими тредами.',
        ]
      : []),
    ...diffSection(input),
  ].join('\n');
}

export interface AskPromptInput extends DiffPromptInput {
  readonly projectPath: string;
  readonly question: string;
  readonly contextHints?: readonly string[];
  /**
   * Обсуждения MR, включая прошлые замечания самого бота. Без них реплай на собственное
   * замечание («а почему ты пометил это blocker?») приходил как вопрос из ниоткуда:
   * ответ уходил в тот же тред, но контекста треда в промпте не было.
   */
  readonly existingThreads?: string;
}

/** Блок с обсуждениями MR — общий для ASK. Пусто, если тредов нет. */
function threadsBlock(existingThreads: string | undefined): string[] {
  if (!existingThreads || existingThreads.trim().length === 0) return [];
  return [
    '',
    'ОБСУЖДЕНИЯ В ЭТОМ MR (включая твои прошлые замечания и ответы на них):',
    existingThreads.trim(),
    '',
    'Если вопрос — реплай на твоё замечание (тред помечен «ВОПРОС ЗАДАН В ЭТОМ ТРЕДЕ»),',
    'отвечай именно про него: что ты имел в виду, на чём основывался, и признай ошибку,',
    'если автор прав. Не переобъясняй весь MR заново.',
  ];
}

export function buildAskPrompt(input: AskPromptInput): string {
  return [
    'Ты помогаешь ревьюеру в merge request. Ответь на вопрос по этому MR.',
    `Проект: ${input.projectPath}. Репозиторий выкачан в текущую рабочую директорию — можешь читать файлы.`,
    'Отвечай по существу, кратко, ссылайся на конкретные файлы и строки. Markdown.',
    '',
    `Верни ответ РОВНО между маркерами ${ANSWER_BEGIN} и ${ANSWER_END}, без текста вокруг.`,
    '',
    `Вопрос: ${input.question}`,
    ...threadsBlock(input.existingThreads),
    ...contextSection(input.contextHints),
    ...diffSection(input),
    '',
    ANSWER_BEGIN,
    '(твой ответ здесь)',
    ANSWER_END,
  ].join('\n');
}
