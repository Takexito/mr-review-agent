import { describe, it, expect } from 'vitest';
import { applyRepoConfig } from '../src/config/repoConfig.js';
import type { ProjectProfile } from '../src/config.js';

const profile: ProjectProfile = {
  name: 'acme',
  projects: ['acme/android-app'],
  engines: ['codex'],
  connectors: ['linear', 'gitlab'],
  agentNetwork: false,
  cliTools: [],
  related: [{ project: 'acme/docs' }],
  relatedAllowlist: ['acme/**'],
  issueKeys: { PRJ: 'linear', '#': 'gitlab' },
};

describe('applyRepoConfig', () => {
  it('should keep the profile as is when the repository has no .review.yml', () => {
    expect(applyRepoConfig(null, profile)).toEqual({ profile, exclude: [], standards: [], errors: [] });
  });

  it('should narrow connectors and drop issue keys of the connectors left out', () => {
    const result = applyRepoConfig('connectors: [linear]', profile);
    expect(result.errors).toEqual([]);
    expect(result.profile.connectors).toEqual(['linear']);
    expect(result.profile.issueKeys).toEqual({ PRJ: 'linear' });
  });

  it('should ignore the whole file when it names a connector the profile does not give', () => {
    const result = applyRepoConfig('connectors: [linear, sentry]\nexclude: ["**/generated/**"]', profile);
    expect(result).toMatchObject({ profile, exclude: [] });
    expect(result.errors).toEqual(['connectors: коннектор `sentry` не подключён к профилю проекта']);
  });

  it('should report invalid YAML by position without quoting the file', () => {
    const result = applyRepoConfig('connectors: [linear\nsecret: glpat-xyz', profile);
    expect(result.profile).toBe(profile);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^невалидный YAML/);
    expect(result.errors[0]).not.toContain('glpat');
  });

  it('should report unknown keys', () => {
    expect(applyRepoConfig('agentNetwork: true', profile).errors).toEqual([
      '(корень): неизвестный ключ `agentNetwork`',
    ]);
  });

  it('should quote names from the file so they cannot format the note or mention anyone', () => {
    const [error] = applyRepoConfig('connectors: ["x` @all\\n# Заголовок"]', profile).errors;
    expect(error).toBe("connectors: коннектор `x' @all # Заголовок` не подключён к профилю проекта");
  });

  describe('related repositories', () => {
    it('should add a repository the profile allowlist lets in after those of the profile', () => {
      const result = applyRepoConfig(
        'related:\n  - { project: acme/backend, ref: same-branch, hint: API-контракты }',
        profile,
      );
      expect(result.errors).toEqual([]);
      expect(result.profile.related).toEqual([
        { project: 'acme/docs' },
        { project: 'acme/backend', ref: 'same-branch', hint: 'API-контракты' },
      ]);
    });

    it('should refuse a repository outside the allowlist', () => {
      const result = applyRepoConfig('related: [{ project: secret/vault }]', profile);
      expect(result.profile).toBe(profile);
      expect(result.errors).toEqual(['related.0.project: secret/vault не входит в relatedAllowlist профиля']);
    });

    it('should refuse any repository when the profile has no allowlist', () => {
      const result = applyRepoConfig('related: [{ project: acme/backend }]', { ...profile, relatedAllowlist: [] });
      expect(result.errors).toEqual(['related.0.project: acme/backend не входит в relatedAllowlist профиля']);
    });

    it('should refuse a ref that is not a plain branch name', () => {
      const result = applyRepoConfig('related: [{ project: acme/backend, ref: "--upload-pack=x" }, { project: acme/api, ref: "../../HEAD" }]', profile);
      expect(result.errors).toEqual([
        'related.0.ref: ожидается имя ветки или same-branch',
        'related.1.ref: ожидается имя ветки или same-branch',
      ]);
    });

    it('should refuse a repository listed twice', () => {
      const result = applyRepoConfig('related: [{ project: acme/backend }, { project: acme/backend, ref: dev }]', profile);
      expect(result.errors).toEqual(['related.1.project: acme/backend указан дважды']);
    });

    it('should refuse a repository the profile already lays out', () => {
      const result = applyRepoConfig('related: [{ project: acme/docs, ref: dev }]', profile);
      expect(result.errors).toEqual(['related.0.project: acme/docs уже выложен профилем']);
    });
  });

  it('should pass exclude patterns and standards documents through', () => {
    const result = applyRepoConfig('exclude: ["**/generated/**", "*.lock"]\nstandards: [docs/style.md, AGENTS.md]', profile);
    expect(result).toMatchObject({
      exclude: ['**/generated/**', '*.lock'],
      standards: ['docs/style.md', 'AGENTS.md'],
      errors: [],
    });
  });

  it('should refuse paths that leave the repository or carry git pathspec magic', () => {
    const result = applyRepoConfig('exclude: [":(top)x", "/abs"]\nstandards: [../outside.md]', profile);
    expect(result.errors).toEqual([
      'exclude.0: путь от корня репозитория: латиница, цифры и `_.-*?[]/`, без `/` в начале и `..`',
      'exclude.1: путь от корня репозитория: латиница, цифры и `_.-*?[]/`, без `/` в начале и `..`',
      'standards.0: путь от корня репозитория: латиница, цифры и `_.-*?[]/`, без `/` в начале и `..`',
    ]);
  });

  it('should refuse paths with quotes, spaces or shell characters', () => {
    const result = applyRepoConfig(`exclude: ["x'; rm -rf ~; echo '", "a b/**"]\nstandards: ["docs/$(id).md"]`, profile);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.every((e) => e.endsWith('без `/` в начале и `..`'))).toBe(true);
  });

  it('should treat an empty file as no settings', () => {
    expect(applyRepoConfig('', profile)).toEqual({ profile, exclude: [], standards: [], errors: [] });
  });
});
