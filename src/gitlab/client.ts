import { Gitlab } from '@gitbeaker/rest';
import type { AppConfig } from '../config.js';

export type GitlabClient = InstanceType<typeof Gitlab>;

/** Клиент под конкретный бот-токен — им постятся комменты от имени этого бот-юзера. */
export function createGitlabWithToken(host: string, token: string): GitlabClient {
  return new Gitlab({ host, token });
}

/** Клиент по дефолтному (codex) токену. */
export function createGitlab(config: AppConfig): GitlabClient {
  return createGitlabWithToken(config.gitlabHost, config.gitlabToken);
}
