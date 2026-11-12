import { describe, it, expect } from 'vitest';
import type { AppConfig, ProjectProfile } from '../src/config.js';
import type { JobData } from '../src/queue/job.js';
import { specSkipNote, type SpecTargetInput } from '../src/queue/kinds/spec.js';

const config = {
  gitlabHost: 'https://gitlab.com',
  bindings: [{ engine: 'codex', handle: 'codex', gitlabToken: 't' }],
} as unknown as AppConfig;

const profile = {
  name: 'acme',
  projects: ['g/*'],
  engines: ['codex'],
  connectors: ['linear'],
  triggerRole: 'developer',
  internalNotes: 'ignore',
  agentNetwork: false,
  cliTools: [],
  related: [],
  relatedAllowlist: [],
  issueKeys: { PRJ: 'linear' },
} as unknown as ProjectProfile;

const data = { kind: 'SPEC', engine: 'codex', projectId: 1, projectPath: 'g/p', mrIid: 2, noteId: 3, authorUsername: 'a' } as JobData;

function input(title: string, overrides: Partial<SpecTargetInput> = {}): SpecTargetInput {
  return {
    config,
    data,
    mr: { title, sourceBranch: 'feature', description: '' },
    profile,
    allowedProjects: ['g/p'],
    ...overrides,
  };
}

describe('specSkipNote', () => {
  it('should explain how to name a target when the MR has none', () => {
    const note = specSkipNote(input('Поправить кнопку'));
    expect(note).toContain('Прямая цель не найдена');
    expect(note).toContain('@codex spec PRJ-123');
  });

  it('should let the job go on when a target is named', () => {
    expect(specSkipNote(input('PRJ-7 Поправить кнопку'))).toBeNull();
  });

  it('should say that issueKeys are missing in the profile', () => {
    expect(specSkipNote(input('PRJ-7', { profile: { ...profile, issueKeys: {} } }))).toContain('issueKeys');
  });

  it('should list command tokens that match no prefix', () => {
    const note = specSkipNote(input('x', { data: { ...data, specRefs: ['ABC-1'] } }));
    expect(note).toContain('`ABC-1` из команды не подходит');
  });
});
