import { describe, expect, it } from 'vitest';
import { parseServiceConfig, resolveProfile } from '../src/config.js';
import { matchesProjectGlob } from '../src/config/glob.js';

const ENV = {
  WEBHOOK_SECRET: 'whsec',
  CODEX_BOT_TOKEN: 'glpat-codex',
  CLAUDE_BOT_TOKEN: 'glpat-claude',
  CLAUDE_OAUTH: 'oauth',
  LINEAR_KEY: 'lin_api_x',
};

const MINIMAL = `
server:
  webhookSecret: secret:WEBHOOK_SECRET
engines:
  codex:
    bot: { username: codex, token: secret:CODEX_BOT_TOKEN }
profiles:
  - name: all
    projects: ["**"]
`;

const FULL = `
server:
  port: 9090
  webhookSecret: secret:WEBHOOK_SECRET
gitlab:
  host: https://gitlab.example.com
engines:
  codex:
    bot: { username: codex, token: secret:CODEX_BOT_TOKEN }
    model: gpt-5
  claude:
    bot: { username: claude_bot, token: secret:CLAUDE_BOT_TOKEN }
    oauthToken: secret:CLAUDE_OAUTH
connectors:
  linear:
    command: npx
    args: [-y, linear-mcp]
    env: { LINEAR_API_KEY: secret:LINEAR_KEY, PLAIN: value }
    tools: [get_issue]
    hint: Задачи Linear
profiles:
  - name: android
    projects: ["acme/android-app"]
    engines: [claude]
    connectors: [linear]
  - name: acme
    projects: ["acme/*"]
`;

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return String(error);
  }
  throw new Error('expected an error');
}

describe('parseServiceConfig', () => {
  it('should apply defaults when only required fields are set', () => {
    const config = parseServiceConfig(MINIMAL, ENV);
    expect(config.port).toBe(8080);
    expect(config.gitlabHost).toBe('https://gitlab.com');
    expect(config.webhookSecret).toBe('whsec');
    expect(config.gitlabCloneToken).toBe('glpat-codex');
    expect(config.bindings).toEqual([{ engine: 'codex', handle: 'codex', gitlabToken: 'glpat-codex' }]);
    expect(config.claudeEnabled).toBe(false);
  });

  it('should enable claude when its section is present', () => {
    const config = parseServiceConfig(FULL, ENV);
    expect(config.claudeEnabled).toBe(true);
    expect(config.claudeOauthToken).toBe('oauth');
    expect(config.bindings.map((b) => b.handle)).toEqual(['codex', 'claude_bot']);
    expect(config.codexModel).toBe('gpt-5');
  });

  it('should resolve secret references inside connector env and keep plain values', () => {
    const config = parseServiceConfig(FULL, ENV);
    expect(config.connectors['linear']).toMatchObject({
      command: 'npx',
      env: { LINEAR_API_KEY: 'lin_api_x', PLAIN: 'value' },
      tools: ['get_issue'],
    });
  });

  it('should reject a plaintext token in a secret field', () => {
    const yaml = MINIMAL.replace('secret:CODEX_BOT_TOKEN', 'glpat-leaked');
    const message = errorOf(() => parseServiceConfig(yaml, ENV));
    expect(message).toContain('engines.codex.bot.token');
    expect(message).not.toContain('glpat-leaked');
  });

  it('should report every missing secret at once without values', () => {
    const message = errorOf(() => parseServiceConfig(FULL, { CODEX_BOT_TOKEN: 'glpat-codex' }));
    for (const name of ['WEBHOOK_SECRET', 'CLAUDE_BOT_TOKEN', 'CLAUDE_OAUTH', 'LINEAR_KEY']) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain('glpat-codex');
  });

  it('should treat an empty env variable as a missing secret', () => {
    const message = errorOf(() => parseServiceConfig(MINIMAL, { ...ENV, WEBHOOK_SECRET: '' }));
    expect(message).toContain('WEBHOOK_SECRET');
  });

  it('should reject a profile that references an unknown connector or engine', () => {
    const yaml = `${MINIMAL}    connectors: [jira]\n    engines: [claude]\n`;
    const message = errorOf(() => parseServiceConfig(yaml, ENV));
    expect(message).toContain('jira');
    expect(message).toContain('claude');
  });

  it('should reject cliTools without agentNetwork', () => {
    const yaml = `${MINIMAL}    cliTools: [glab]\n`;
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('agentNetwork');
    expect(() => parseServiceConfig(`${yaml}    agentNetwork: true\n`, ENV)).not.toThrow();
  });

  it('should reject a connector with both command and url or neither', () => {
    const both = MINIMAL.replace('profiles:', 'connectors:\n  x: { command: a, url: "https://x" }\nprofiles:');
    const neither = MINIMAL.replace('profiles:', 'connectors:\n  x: { hint: h }\nprofiles:');
    expect(errorOf(() => parseServiceConfig(both, ENV))).toContain('connectors.x');
    expect(errorOf(() => parseServiceConfig(neither, ENV))).toContain('connectors.x');
  });

  it('should reject a connector name that cannot be a codex config key or claude tool prefix', () => {
    const yaml = MINIMAL.replace('profiles:', 'connectors:\n  my.linear: { command: a }\nprofiles:');
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('my.linear');
  });

  it('should reject a cli tool that is a pattern rather than a command name', () => {
    const yaml = `${MINIMAL}    agentNetwork: true\n    cliTools: ["*"]\n`;
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('cliTools');
  });

  it('should read related repositories of a profile with ref defaulting to the default branch', () => {
    const yaml = `${MINIMAL}    related:\n      - { project: acme/docs, hint: Контракты API }\n      - { project: acme/backend, ref: same-branch }\n`;
    const config = parseServiceConfig(yaml, ENV);
    expect(config.profiles[0]!.related).toEqual([
      { project: 'acme/docs', hint: 'Контракты API' },
      { project: 'acme/backend', ref: 'same-branch' },
    ]);
  });

  it('should reject the same related repository listed twice in a profile', () => {
    const yaml = `${MINIMAL}    related:\n      - { project: g/docs }\n      - { project: g/docs, ref: dev }\n`;
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('g/docs');
  });

  it('should reject a related repository that is not a group/project path', () => {
    const yaml = `${MINIMAL}    related:\n      - { project: "../etc" }\n`;
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('related');
  });

  it('should reject unknown keys to catch typos', () => {
    const yaml = MINIMAL.replace('server:', 'server:\n  prot: 1');
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('prot');
  });

  it('should reject a config without profiles', () => {
    const yaml = MINIMAL.slice(0, MINIMAL.indexOf('profiles:'));
    expect(errorOf(() => parseServiceConfig(yaml, ENV))).toContain('profiles');
  });
});

describe('resolveProfile', () => {
  const config = parseServiceConfig(FULL, ENV);

  it('should pick the first matching profile', () => {
    expect(resolveProfile(config, 'acme/android-app')?.name).toBe('android');
    expect(resolveProfile(config, 'acme/ios-app')?.name).toBe('acme');
  });

  it('should return undefined for a project outside every profile', () => {
    expect(resolveProfile(config, 'other/repo')).toBeUndefined();
    expect(resolveProfile(config, 'acme/sub/repo')).toBeUndefined();
  });

  it('should default profile engines to every configured engine', () => {
    expect(resolveProfile(config, 'acme/ios-app')?.engines).toEqual(['codex', 'claude']);
    expect(resolveProfile(config, 'acme/android-app')?.engines).toEqual(['claude']);
  });
});

describe('matchesProjectGlob', () => {
  it.each([
    ['group/*', 'group/repo', true],
    ['group/*', 'group/sub/repo', false],
    ['group/**', 'group/sub/repo', true],
    ['group/**', 'group', false],
    ['**/mobile-*', 'a/b/mobile-ios', true],
    ['group/repo', 'group/repo', true],
    ['group/repo', 'group/repo2', false],
    ['group.x/*', 'groupyx/repo', false],
  ])('%s vs %s → %s', (glob, path, expected) => {
    expect(matchesProjectGlob(glob, path)).toBe(expected);
  });
});
