import { describe, expect, it } from 'vitest';
import { checkTriggerRole, type MembersApi } from '../src/gitlab/access.js';

type Show = (...args: unknown[]) => Promise<{ access_level: number }>;

function members(show: Show): MembersApi {
  return { ProjectMembers: { show } } as unknown as MembersApi;
}

const level = (access_level: number) => members(async () => ({ access_level }));

describe('checkTriggerRole', () => {
  it('should allow a member at or above the required role, counting inherited membership', async () => {
    const calls: unknown[] = [];
    const api = members(async (...args) => {
      calls.push(args);
      return { access_level: 30 };
    });
    expect(await checkTriggerRole(api, 7, 42, 'developer')).toEqual({ ok: true });
    expect(calls).toEqual([[7, 42, { includeInherited: true }]]);
  });

  it('should deny a member below the required role', async () => {
    expect(await checkTriggerRole(level(20), 7, 42, 'developer')).toEqual({ ok: false, reason: 'access_level 20 < 30' });
    expect((await checkTriggerRole(level(30), 7, 42, 'maintainer')).ok).toBe(false);
  });

  it('should deny a user who is not a member of the project', async () => {
    const api = members(async () => {
      throw Object.assign(new Error('Not Found'), { cause: { response: { status: 404 } } });
    });
    expect(await checkTriggerRole(api, 7, 42, 'reporter')).toEqual({ ok: false, reason: 'not a project member' });
  });

  it('should deny without leaking the token when the API call fails', async () => {
    const api = members(async () => {
      throw new Error('fetch https://oauth2:glpat-SECRET@gitlab.com failed');
    });
    const result = await checkTriggerRole(api, 7, 42, 'developer');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('glpat-SECRET');
  });
});
