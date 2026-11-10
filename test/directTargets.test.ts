import { describe, it, expect } from 'vitest';
import { findDirectTargets, type TargetRules } from '../src/spec/targets.js';

const rules: TargetRules = {
  issueKeys: { PRJ: 'linear', '#': 'gitlab' },
  gitlabHost: 'https://gitlab.com',
  projectPath: 'acme/android-app',
};

const mr = { title: '', branch: 'main', description: '' };

function labels(input: Partial<typeof mr> & { args?: string[] }, r = rules): string[] {
  return findDirectTargets({ ...mr, ...input }, r).targets.map((t) => t.label);
}

describe('findDirectTargets', () => {
  it('should take a key with a configured prefix from the MR title', () => {
    expect(labels({ title: 'PRJ-137: экран смены ника' })).toEqual(['PRJ-137']);
  });

  it('should take a lowercase key from the branch name', () => {
    expect(labels({ branch: 'dev/prj-137-nick-change' })).toEqual(['PRJ-137']);
  });

  it('should ignore keys mentioned in free text of the description', () => {
    expect(labels({ description: 'По мотивам PRJ-140, дальше будет PRJ-141.' })).toEqual([]);
  });

  it('should take every key from Closes and Refs lines of the description', () => {
    const description = ['Сделал экран.', '', 'Closes PRJ-137, PRJ-138', '- refs: PRJ-139', 'Related PRJ-140'].join('\n');
    expect(labels({ description })).toEqual(['PRJ-137', 'PRJ-138', 'PRJ-139']);
  });

  it('should take only the references right after the keyword, not the rest of the line', () => {
    const description = ['- Fix crash seen in PRJ-45 (regression from PRJ-40)', 'Closes PRJ-1 и PRJ-2, see PRJ-3'].join('\n');
    expect(labels({ description })).toEqual(['PRJ-1', 'PRJ-2']);
  });

  it('should not read words with unconfigured prefixes as keys', () => {
    expect(labels({ title: 'UTF-8 и ISO-8601 в PRJ-1' })).toEqual(['PRJ-1']);
  });

  it('should list each target once in order title, branch, description', () => {
    expect(
      labels({ title: 'PRJ-2 и PRJ-1', branch: 'prj-1-x', description: 'Fixes PRJ-3 and PRJ-2' }),
    ).toEqual(['PRJ-2', 'PRJ-1', 'PRJ-3']);
  });

  describe('GitLab issues', () => {
    it('should resolve a bare #N to the MR project', () => {
      const [target] = findDirectTargets({ ...mr, title: 'Экран ника (#34)' }, rules).targets;
      expect(target).toEqual({ label: '#34', connector: 'gitlab', number: '34', project: 'acme/android-app' });
    });

    it('should keep the project of a cross-project reference and of an issue url on our host', () => {
      const description = 'Closes acme/docs#7 https://gitlab.com/acme/backend/-/issues/9';
      const targets = findDirectTargets({ ...mr, description }, rules).targets;
      expect(targets.map((t) => [t.label, t.project, t.number])).toEqual([
        ['acme/docs#7', 'acme/docs', '7'],
        ['acme/backend#9', 'acme/backend', '9'],
      ]);
    });

    it('should name an issue of the MR project by its short form whatever way it is written', () => {
      const description = 'Fixes https://gitlab.com/acme/android-app/-/work_items/34 и acme/android-app#34';
      expect(labels({ title: '#34', description })).toEqual(['#34']);
    });

    it('should take the project of an issue url relative to a GitLab installed under a sub-path', () => {
      const found = findDirectTargets(
        { ...mr, description: 'Closes https://host.dev/gitlab/g/docs/-/issues/7' },
        { ...rules, gitlabHost: 'https://host.dev/gitlab' },
      );
      expect(found.targets.map((t) => t.project)).toEqual(['g/docs']);
    });

    it('should ignore url anchors, foreign hosts and merge requests', () => {
      const description = 'Closes https://x.dev/page#34 https://evil.example/g/p/-/issues/1 !12';
      expect(labels({ description })).toEqual([]);
    });

    it('should take the issue number GitLab puts at the start of a branch name', () => {
      expect(labels({ branch: '34-nick-change' })).toEqual(['#34']);
      expect(labels({ branch: 'feature-34' })).toEqual([]);
    });

    it('should not look for GitLab issues when the profile has no # prefix', () => {
      expect(labels({ title: '#34 PRJ-1' }, { ...rules, issueKeys: { PRJ: 'linear' } })).toEqual(['PRJ-1']);
    });
  });

  describe('command argument', () => {
    it('should take targets only from the argument when it is given', () => {
      const found = findDirectTargets({ title: 'PRJ-1', branch: 'prj-2', description: 'Closes PRJ-3', args: ['prj-9', '#5'] }, rules);
      expect(found.targets.map((t) => t.label)).toEqual(['PRJ-9', '#5']);
    });

    it('should report argument tokens that match no configured prefix', () => {
      const found = findDirectTargets({ ...mr, args: ['OPS-176', 'PRJ-1'] }, rules);
      expect(found.targets.map((t) => t.label)).toEqual(['PRJ-1']);
      expect(found.unmatched).toEqual(['OPS-176']);
    });
  });
});
