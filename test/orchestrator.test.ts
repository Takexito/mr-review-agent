import { describe, it, expect } from 'vitest';
import {
  buildOrchestratorPrompt,
  ORCHESTRATOR_BEGIN,
  ORCHESTRATOR_END,
  type AxisTask,
} from '../src/codex/orchestratorPrompt.js';
import { applyDuplicates, parseOrchestratorOutput, type AxisReviews } from '../src/codex/parseOrchestrator.js';
import { buildCombinedNote } from '../src/gitlab/postCombinedReview.js';

const task = (axis: AxisTask['axis']): AxisTask => ({
  axis,
  promptFile: `/job/review/${axis}.prompt.md`,
  outputFile: `/job/review/${axis}.out.md`,
});

const REVIEWS: AxisReviews = {
  bugs: {
    summary: '',
    comments: [{ path: 'A.kt', line: 1, severity: 'warn', body: 'баг' }],
    disputed: [],
    reviewedFiles: [],
    skippedFiles: [],
  },
  standards: {
    summary: '',
    standardsRead: ['AGENTS.md'],
    deadLetters: [],
    unproven: [],
    violations: [{ path: 'A.kt', line: 1, standard: 'AGENTS.md › 1', quote: 'q', precedent: 'B.kt:1', body: 'нарушение' }],
    smells: [{ smell: 'Middle Man', path: 'B.kt', line: 2, body: 'возможно' }],
    reviewedFiles: [],
    skippedFiles: [],
  },
  spec: {
    summary: '',
    items: [{ requirement: 'текст', status: 'violated', evidence: 'A.kt:1', note: 'не тот текст' }],
    extras: [],
    ignoredSources: [],
    reviewedFiles: [],
    skippedFiles: [],
  },
};

function consolidation(duplicates: { drop: string; keep: string }[]) {
  const parsed = parseOrchestratorOutput(
    `${ORCHESTRATOR_BEGIN}\n${JSON.stringify({ summary: 'итог', duplicates })}\n${ORCHESTRATOR_END}`,
  );
  if (!parsed) throw new Error('consolidation not parsed');
  return parsed;
}

describe('orchestrator prompt', () => {
  it('should give each axis its prompt and output file and list only its finding ids', () => {
    const prompt = buildOrchestratorPrompt({
      projectPath: 'g/p',
      sourceBranch: 'f',
      targetBranch: 'main',
      tasks: [task('bugs'), task('standards')],
    });

    expect(prompt).toContain('/job/review/bugs.prompt.md');
    expect(prompt).toContain('/job/review/standards.out.md');
    expect(prompt).toContain('`standards:smells:N`');
    expect(prompt).not.toContain('spec:items');
    expect(prompt).not.toContain('spec.prompt.md');
  });
});

describe('parseOrchestratorOutput', () => {
  it('should return null when markers or json are broken', () => {
    expect(parseOrchestratorOutput('без маркеров')).toBeNull();
    expect(parseOrchestratorOutput(`${ORCHESTRATOR_BEGIN}\n{oops\n${ORCHESTRATOR_END}`)).toBeNull();
  });
});

describe('applyDuplicates', () => {
  it('should drop the duplicate and mark the kept finding with the other axis', () => {
    const result = applyDuplicates(REVIEWS, consolidation([{ drop: 'standards:violations:0', keep: 'bugs:comments:0' }]));

    expect(result.standards?.violations).toEqual([]);
    expect(result.standards?.smells).toHaveLength(1);
    expect(result.bugs?.comments[0]?.body).toContain('Также отмечено осью «стандарты»');
  });

  it('should keep a dropped spec item in the checklist and only suppress its inline thread', () => {
    const result = applyDuplicates(REVIEWS, consolidation([{ drop: 'spec:items:0', keep: 'bugs:comments:0' }]));

    expect(result.spec?.items).toHaveLength(1);
    expect(result.specSkipInline.has(0)).toBe(true);
  });

  it('should ignore same-axis pairs and unknown ids', () => {
    const result = applyDuplicates(
      REVIEWS,
      consolidation([
        { drop: 'standards:smells:0', keep: 'standards:violations:0' },
        { drop: 'bugs:comments:7', keep: 'spec:items:0' },
        { drop: 'bugs:nope:0', keep: 'spec:items:0' },
      ]),
    );

    expect(result.bugs?.comments).toHaveLength(1);
    expect(result.standards?.smells).toHaveLength(1);
    expect(result.specSkipInline.size).toBe(0);
  });

  it('should leave everything in place when there is no consolidation', () => {
    const result = applyDuplicates(REVIEWS, null);
    expect(result.bugs?.comments[0]?.body).toBe('баг');
    expect(result.standards?.violations).toHaveLength(1);
  });
});

describe('buildCombinedNote', () => {
  it('should render three sections in a fixed order and demote axis subheadings', () => {
    const note = buildCombinedNote(
      'итог',
      {
        bugs: { state: 'ok', lines: ['', 'Замечаний: **0**', '', '### Не удалось привязать к строкам'] },
        standards: { state: 'missing' },
        spec: { state: 'skipped', reason: 'Источник постановки не найден — сверка не запускалась.' },
      },
      true,
    );

    expect(note.indexOf('### 🐞 Баги')).toBeLessThan(note.indexOf('### 📏 Стандарты'));
    expect(note.indexOf('### 📏 Стандарты')).toBeLessThan(note.indexOf('### 📋 Постановка'));
    expect(note).toContain('#### Не удалось привязать к строкам');
    expect(note).toContain('Ось «стандарты» не отработала');
    expect(note).toContain('_Источник постановки не найден — сверка не запускалась._');
    expect(note).not.toContain('Сведение осей не получено');
  });

  it('should warn about possible repeats when consolidation is missing', () => {
    const note = buildCombinedNote(
      '',
      { bugs: { state: 'raw', text: 'сырой ответ' }, standards: { state: 'missing' }, spec: { state: 'missing' } },
      false,
    );

    expect(note).toContain('Сведение осей не получено');
    expect(note).toContain('сырой ответ');
  });
});
