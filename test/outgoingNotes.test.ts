import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardNoteBodies, type GitlabClient } from '../src/gitlab/client.js';
import { codexAuthSecrets } from '../src/util/knownSecrets.js';

function fakeClient() {
  const sent: unknown[][] = [];
  const record = (...args: unknown[]) => {
    sent.push(args);
    return Promise.resolve({});
  };
  const client = {
    MergeRequestNotes: { create: record },
    MergeRequestDiscussions: { create: record, addNote: record },
  } as unknown as GitlabClient;
  return { client, sent };
}

describe('guardNoteBodies', () => {
  it('should strip known secret values and token formats from every outgoing note body', async () => {
    const { client, sent } = fakeClient();
    guardNoteBodies(client, () => ['hook-secret-value-0123', 'refresh-token-value-xyz']);

    await client.MergeRequestNotes.create(1, 2, 'секрет hook-secret-value-0123 и glpat-AbCdEf');
    await client.MergeRequestDiscussions.create(1, 2, 'токен refresh-token-value-xyz', {});
    await client.MergeRequestDiscussions.addNote(1, 2, 'd', 3, '/approve\nBearer abc.def-0123456789xyz');

    expect(sent.map((args) => args.find((a) => typeof a === 'string' && a.length > 1))).toEqual([
      'секрет *** и glpat-***',
      'токен ***',
      '\\/approve\nBearer ***',
    ]);
  });

  it('should read secrets on every post so a refreshed session is covered too', async () => {
    const { client, sent } = fakeClient();
    let current = 'first-token-value-111';
    guardNoteBodies(client, () => [current]);
    current = 'second-token-value-222';

    await client.MergeRequestNotes.create(1, 2, 'second-token-value-222');

    expect(sent[0]?.[2]).toBe('***');
  });
});

describe('codexAuthSecrets', () => {
  it('should return the token strings of the subscription session and nothing else', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    await writeFile(
      join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { id_token: 'id-token-value', access_token: 'access-token-value', refresh_token: 'refresh-value', account_id: 'acc-1' },
        last_refresh: '2026-11-01T00:00:00Z',
      }),
    );

    expect(codexAuthSecrets(home).sort()).toEqual(['access-token-value', 'id-token-value', 'refresh-value'].sort());
  });

  it('should return nothing when there is no session file', () => {
    expect(codexAuthSecrets(join(tmpdir(), 'no-such-codex-home'))).toEqual([]);
  });
});
