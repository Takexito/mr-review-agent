import Fastify from 'fastify';
import { loadConfig, resolveProfile, type EngineName } from './config.js';
import { createLogger } from './logger.js';
import { isValidWebhookToken } from './webhook/verify.js';
import { parseNoteHook } from './webhook/parse.js';
import { route } from './webhook/intent.js';
import { createConnection, createQueue, createWorker } from './queue/queue.js';
import { createProcessor } from './queue/processor.js';
import { AgentAuthError } from './agent/types.js';
import { createCodexAgent } from './agent/codex.js';
import { createClaudeAgent } from './agent/claude.js';
import type { Agent } from './agent/types.js';
import { cached, checkCodexAuth, checkClaudeAuth, checkGitlabToken, probeCodexSession, type AuthHealth } from './health.js';
import { createGitlabWithToken, type GitlabClient } from './gitlab/client.js';
import { redactSecrets } from './util/redact.js';
import type { JobData } from './queue/job.js';

const CODEX_PROBE_TTL_MS = 5 * 60_000;
const GITLAB_PROBE_TTL_MS = 60_000;

function isAuthError(err: Error): boolean {
  return err instanceof AgentAuthError || err.name.endsWith('AuthError');
}

/** Движко-осознанная remedy-заметка после исчерпания ретраев. */
function failureNote(engine: EngineName, isAuth: boolean, reason: string): string {
  const label = engine === 'claude' ? 'Claude' : 'Codex';
  if (isAuth) {
    return engine === 'claude'
      ? '🔑 Claude: OAuth-токен подписки недействителен (не восстановился после повторов) — требуется ротация `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`). Запрос не выполнен.'
      : '🔑 Codex: токен подписки недействителен (не восстановился после повторов) — требуется перепровизия `auth.json`. Запрос не выполнен.';
  }
  return `⚠️ ${label} не смог обработать запрос:\n\n\`\`\`\n${reason}\n\`\`\``;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  const queueConn = createConnection(config.redisUrl);
  const workerConn = createConnection(config.redisUrl);
  const queue = createQueue(queueConn);

  // Движки строятся всегда; GitLab-клиенты — по одному на бот-идентичность из bindings.
  const engines: Record<EngineName, Agent> = {
    codex: createCodexAgent(config),
    claude: createClaudeAgent(config),
  };
  const clients: Partial<Record<EngineName, GitlabClient>> = {};
  for (const b of config.bindings) {
    clients[b.engine] = createGitlabWithToken(config.gitlabHost, b.gitlabToken);
  }

  const worker = createWorker(
    workerConn,
    createProcessor(config, log, { engines, clients }),
    config.queueConcurrency,
  );

  worker.on('failed', (job, err) => {
    // Страховка поверх `gitWithToken`: любой путь, донёсший токен в текст ошибки, не дойдёт до MR.
    const message = redactSecrets(err.message);
    log.error({ jobId: job?.id, err: message }, 'job failed');
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // ещё будут ретраи — не спамим
    const d = job.data;
    const client = clients[d.engine];
    if (!client) return;
    // Auth-ошибка пережила все ретраи → токен реально отозван (не транзиент): даём
    // понятную инструкцию вместо дампа. Тип берём по name (устойчиво к сериализации BullMQ).
    const isAuth = isAuthError(err);
    // Кап на всякий случай — в MR не должен попадать длинный дамп.
    const reason = message.length > 300 ? `${message.slice(0, 300)}…` : message;
    void client.MergeRequestNotes.create(d.projectId, d.mrIid, failureNote(d.engine, isAuth, reason)).catch(
      () => undefined,
    );
  });

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  const probeCodex = cached(CODEX_PROBE_TTL_MS, () => probeCodexSession(config.codexBin, config.codexHome));
  const gitlabTokens = new Map<string, string>([
    ...config.bindings.map((b): [string, string] => [`${b.engine}Bot`, b.gitlabToken]),
    ['clone', config.gitlabCloneToken],
    ...(config.gitlabReadToken ? [['read', config.gitlabReadToken] as [string, string]] : []),
  ]);
  // Один токен часто стоит сразу в нескольких ролях — в GitLab ходим по разу на значение.
  const gitlabProbes = new Map<string, () => Promise<AuthHealth>>();
  for (const token of gitlabTokens.values()) {
    if (!gitlabProbes.has(token)) {
      gitlabProbes.set(token, cached(GITLAB_PROBE_TTL_MS, () => checkGitlabToken(config.gitlabHost, token)));
    }
  }

  app.get('/healthz', async (_req, reply) => {
    const codexFile = await checkCodexAuth(config.codexHome);
    // Без файла живая проверка бессмысленна, а её текст ошибки только затрёт причину.
    const codex = codexFile.ok ? { ...(await probeCodex()), lastRefresh: codexFile.lastRefresh } : codexFile;
    const claude = config.claudeEnabled ? checkClaudeAuth(config.claudeOauthToken) : undefined;
    const gitlab: Record<string, AuthHealth> = {};
    for (const [role, token] of gitlabTokens) {
      const probe = gitlabProbes.get(token);
      if (probe) gitlab[role] = await probe();
    }
    let redisOk = true;
    try {
      await queueConn.ping();
    } catch {
      redisOk = false;
    }
    // Claude репортим информационно: его отсутствие/протухший токен не роняет сервис
    // (claude-джоба упадёт с remedy отдельно).
    const ok = codex.ok && redisOk && Object.values(gitlab).every((g) => g.ok);
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      engines: { codex, ...(claude ? { claude } : {}) },
      gitlab,
      redis: redisOk ? 'ok' : 'down',
    });
  });

  app.post('/webhook', async (req, reply) => {
    log.info('webhook received');
    const token = req.headers['x-gitlab-token'];
    const received = Array.isArray(token) ? token[0] : token;
    if (!isValidWebhookToken(received, config.webhookSecret)) {
      log.warn('webhook: invalid X-Gitlab-Token (secret mismatch)');
      return reply.code(401).send({ error: 'invalid token' });
    }

    const parsed = parseNoteHook(req.body);
    if (!parsed.ok) {
      log.info({ reason: parsed.reason }, 'webhook: ignored (not an MR note)');
      return reply.code(200).send({ ignored: true, reason: parsed.reason });
    }
    const event = parsed.event;

    const profile = resolveProfile(config, event.projectPath);
    if (!profile) {
      log.info({ project: event.projectPath }, 'webhook: ignored (no project profile)');
      return reply.code(200).send({ ignored: true, reason: `project ${event.projectPath} matches no profile` });
    }

    const routed = route(event, config.bindings, profile.engines);
    if (!routed) {
      log.info({ mr: event.mrIid }, 'webhook: ignored (no bot mention / own note)');
      return reply.code(200).send({ ignored: true, reason: 'no bot mention or own note' });
    }
    const intent = routed.intent;

    const jobData: JobData = {
      kind: intent.kind,
      engine: routed.engine,
      projectId: event.projectId,
      projectPath: event.projectPath,
      mrIid: event.mrIid,
      noteId: event.noteId,
      discussionId: event.discussionId,
      authorUsername: event.authorUsername,
      question: intent.kind === 'ASK' ? intent.question : undefined,
      specRefs: intent.kind === 'SPEC' ? intent.specRefs : undefined,
    };
    // Дедуп по заметке-триггеру: повторная доставка вебхука не создаст вторую джобу.
    const jobId = `${event.projectId}-${event.mrIid}-${event.noteId}`;
    await queue.add(intent.kind, jobData, { jobId });
    log.info(
      { jobId, project: event.projectPath, profile: profile.name, mr: event.mrIid, kind: intent.kind, engine: routed.engine },
      'job queued',
    );

    return reply.code(202).send({ queued: true, intent: intent.kind, engine: routed.engine });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    await app.close().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await Promise.all([queueConn.quit(), workerConn.quit()]).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info(
    { port: config.port, bots: config.bindings.map((b) => `${b.handle}:${b.engine}`) },
    'mr-review-agent listening',
  );
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', error);
  process.exit(1);
});
