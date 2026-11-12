import { TRIGGER_ROLES, type TriggerRole } from '../config/schema.js';
import { redactSecrets } from '../util/redact.js';
import type { GitlabClient } from './client.js';

export type MembersApi = Pick<GitlabClient, 'ProjectMembers'>;

export type TriggerAccess = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function httpStatus(error: unknown): number | undefined {
  const response = (error as { cause?: { response?: { status?: unknown } } })?.cause?.response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

/**
 * Может ли автор заметки запускать бота в проекте. Любой сбой API — отказ: бот, открытый
 * для всех при недоступном GitLab, исполняет команды посторонних.
 */
export async function checkTriggerRole(
  api: MembersApi,
  projectId: number,
  userId: number,
  role: TriggerRole,
): Promise<TriggerAccess> {
  const required = TRIGGER_ROLES[role];
  try {
    const member = (await api.ProjectMembers.show(projectId, userId, { includeInherited: true })) as { access_level: number };
    if (member.access_level >= required) return { ok: true };
    return { ok: false, reason: `access_level ${member.access_level} < ${required}` };
  } catch (error) {
    if (httpStatus(error) === 404) return { ok: false, reason: 'not a project member' };
    return { ok: false, reason: `members API failed: ${redactSecrets(String(error))}` };
  }
}
