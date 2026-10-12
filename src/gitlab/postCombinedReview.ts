import { AXIS_LABEL, type AxisName } from '../codex/orchestratorPrompt.js';

export const REVIEW_HEADING = '## 🤖 Codex review';

/** Что получилось у оси: готовые секции её заметки либо причина, по которой их нет. */
export type AxisSection =
  | { readonly state: 'ok'; readonly lines: readonly string[] }
  /** Суб-агент ответил, но не в формате оси — показываем как есть. */
  | { readonly state: 'raw'; readonly text: string }
  /** Файла результата нет: ось не отработала. */
  | { readonly state: 'missing' }
  /** Ось намеренно не запускалась (нет источника постановки). */
  | { readonly state: 'skipped'; readonly reason: string };

const AXIS_TITLE: Record<AxisName, string> = {
  bugs: '🐞 Баги',
  standards: '📏 Стандарты',
  spec: '📋 Постановка',
};

const AXIS_ORDER: readonly AxisName[] = ['bugs', 'standards', 'spec'];

/** Подзаголовки оси (`###`) в общей заметке уходят на уровень ниже заголовка раздела. */
function demote(lines: readonly string[]): string[] {
  return lines.map((line) => (line.startsWith('### ') ? `#${line}` : line));
}

function axisBody(axis: AxisName, section: AxisSection): string[] {
  switch (section.state) {
    case 'ok':
      return demote(section.lines);
    case 'raw':
      return ['', '_Ответ оси не разобран — показан как есть._', '', section.text.trim()];
    case 'missing':
      return ['', `> ⚠️ Ось «${AXIS_LABEL[axis]}» не отработала: результат не получен. Запустите её отдельной командой.`];
    case 'skipped':
      return ['', `_${section.reason}_`];
  }
}

/**
 * Одна заметка общего ревью: вывод оркестратора и по разделу на ось. Разделы идут в
 * фиксированном порядке и не ранжируются между собой — оси независимы.
 */
export function buildCombinedNote(
  summary: string,
  sections: Readonly<Record<AxisName, AxisSection>>,
  consolidated: boolean,
): string {
  const lines: string[] = [REVIEW_HEADING];
  if (summary.trim().length > 0) lines.push('', summary.trim());
  if (!consolidated) {
    lines.push('', '> ⚠️ Сведение осей не получено: разделы ниже показаны как есть, возможны повторы между ними.');
  }
  for (const axis of AXIS_ORDER) {
    lines.push('', `### ${AXIS_TITLE[axis]}`, ...axisBody(axis, sections[axis]));
  }
  return lines.join('\n');
}
