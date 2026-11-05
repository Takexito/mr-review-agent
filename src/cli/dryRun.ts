#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Job } from 'bullmq';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createCodexAgent } from '../agent/codex.js';
import { createClaudeAgent } from '../agent/claude.js';
import { createGitlab, type GitlabClient } from '../gitlab/client.js';
import { createProcessor } from '../queue/processor.js';
import type { JobData, JobKind } from '../queue/job.js';
import { redactSecrets } from '../util/redact.js';

/**
 * Сухой прогон оси на реальном MR: весь путь джобы, но вместо публикации в GitLab —
 * markdown-файл. Запускать там же, где живёт бот (нужны codex и его песочница):
 *
 *   node dist/cli/dryRun.js --project acme/android-app --mr 163 --kind SPEC \
 *        [--arg '#34 OPS-176' | --arg 'вопрос'] [--out /tmp/dry/spec.md]
 */

const KINDS: readonly JobKind[] = ['REVIEW', 'BUGS', 'STANDARDS', 'SPEC', 'ASK'];
/** Только чтение уходит в GitLab; любой другой метод считается записью и перехватывается. */
const READ_METHODS = new Set(['show', 'all']);

function recordingClient(real: GitlabClient, writes: string[]): GitlabClient {
  const resource = (name: string, target: object): object =>
    new Proxy(target, {
      get(obj, method, receiver) {
        const value = Reflect.get(obj, method, receiver) as unknown;
        if (typeof value !== 'function' || typeof method !== 'string') return value;
        if (READ_METHODS.has(method)) return value.bind(obj);
        return async (...args: unknown[]) => {
          const [, , ...rest] = args;
          const parts = rest.map((a) => (typeof a === 'string' ? a : `\`\`\`json\n${JSON.stringify(a, null, 2)}\n\`\`\``));
          writes.push(`<!-- ${name}.${method} -->\n\n${parts.join('\n\n')}`);
          return {};
        };
      },
    });

  return new Proxy(real, {
    get(obj, name, receiver) {
      const value = Reflect.get(obj, name, receiver) as unknown;
      return typeof name === 'string' && typeof value === 'object' && value !== null
        ? resource(name, value)
        : value;
    },
  });
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<number> {
  const projectPath = option('project');
  const mrIid = Number(option('mr'));
  const kind = (option('kind') ?? '').toUpperCase() as JobKind;
  const arg = option('arg') ?? '';
  const out = option('out') ?? `/tmp/dry-run/${kind.toLowerCase()}.md`;
  if (!projectPath || !Number.isInteger(mrIid) || !KINDS.includes(kind)) {
    process.stderr.write(`Нужны --project <path> --mr <iid> --kind <${KINDS.join('|')}> [--arg …] [--out файл]\n`);
    return 1;
  }

  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const real = createGitlab(config);
  const project = (await real.Projects.show(projectPath)) as { id: number };

  const writes: string[] = [];
  const data: JobData = {
    kind,
    engine: 'codex',
    projectId: project.id,
    projectPath,
    mrIid,
    noteId: 0,
    authorUsername: 'dry-run',
    ...(kind === 'ASK' ? { question: arg } : {}),
    ...(kind === 'SPEC' && arg.trim().length > 0 ? { specRefs: arg.trim().split(/\s+/) } : {}),
  };

  const processor = createProcessor(config, log, {
    engines: { codex: createCodexAgent(config), claude: createClaudeAgent(config) },
    clients: { codex: recordingClient(real, writes) },
  });
  const started = Date.now();
  await processor({ id: `dry-run-${started}`, data } as Job<JobData>);

  const header = `# Сухой прогон ${kind} — ${projectPath}!${mrIid}\n\nЗаписей в GitLab было бы: ${writes.length}. Время: ${Math.round((Date.now() - started) / 1000)} с.`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${[header, ...writes].join('\n\n---\n\n')}\n`, 'utf8');
  process.stdout.write(`${out}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`Сухой прогон упал: ${redactSecrets(String(error))}\n`);
    process.exit(1);
  });
