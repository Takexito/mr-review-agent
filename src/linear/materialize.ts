import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { fetchLinearIssue, type LinearIssue } from './client.js';
import { formatIssue } from './requirements.js';

/**
 * Раскладка требований на диск рядом с worktree.
 *
 * Зачем файлами, а не одним блоком в промпте: `codex exec` не может звать MCP под
 * песочницей (каждый tools/call авто-отклоняется), а сеть ему оттуда недоступна — то есть
 * дотянуться до Linear по ходу ревью он не может в принципе. Зато читать соседний каталог
 * умеет. Поэтому всё, что может понадобиться, кладём заранее и отдельными файлами:
 * агент сам решает, что открыть, вместо того чтобы получить склеенный блоб.
 *
 * Claude ту же информацию берёт через MCP on-demand, но раскладка ему не мешает.
 */

/** Упоминания задач в тексте: `PRJ-137`, `BE-12`. */
const ISSUE_MENTION_RE = /\b([A-Z]{2,})-(\d+)\b/g;

/** Сколько упомянутых задач дочитываем. Ограничение и по стоимости, и по шуму. */
const MAX_MENTIONED = 10;

export interface MaterializedLinear {
  /** Каталог с раскладкой. null — раскладывать было нечего. */
  readonly dir: string | null;
  /** Ключи задач, которые реально записаны. */
  readonly issueKeys: readonly string[];
}

export function collectMentions(text: string, exclude: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(ISSUE_MENTION_RE)) {
    const key = `${m[1]}-${m[2]}`;
    if (!exclude.has(key)) found.add(key);
  }
  return [...found].slice(0, MAX_MENTIONED);
}

/** Имя файла из заголовка документа: без путей, без сюрпризов в ФС. */
export function docFileName(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${String(index + 1).padStart(2, '0')}-${slug || 'document'}.md`;
}

function issueBody(issue: LinearIssue): string {
  const head = [formatIssue(issue), '', `URL: ${issue.url}`];
  if (issue.parentIdentifier) {
    head.push(`Родительская задача: ${issue.parentIdentifier} — ${issue.parentTitle ?? ''}`.trim());
  }
  return `${head.join('\n')}\n`;
}

/**
 * Пишет задачу, эпик, привязанные документы и упомянутые в описании задачи в `<jobDir>/linear`.
 * Ничего не бросает: недоступность источника — это `degraded`, а не падение джобы.
 */
export async function materializeLinear(
  config: AppConfig,
  jobDir: string,
  rootKey: string,
  log: Logger,
): Promise<MaterializedLinear> {
  if (!config.linearApiKey) return { dir: null, issueKeys: [] };

  const dir = join(jobDir, 'linear');
  const written: string[] = [];
  const index: string[] = ['# Требования из Linear', ''];

  const write = async (name: string, body: string): Promise<void> => {
    await writeFile(join(dir, name), body, 'utf8');
  };

  let root: LinearIssue | null;
  try {
    root = await fetchLinearIssue(config, rootKey);
  } catch (error) {
    log.warn({ err: String(error), issueKey: rootKey }, 'linear materialize failed');
    return { dir: null, issueKeys: [] };
  }
  if (!root) return { dir: null, issueKeys: [] };

  await mkdir(join(dir, 'docs'), { recursive: true });

  await write(`${root.identifier}.md`, issueBody(root));
  written.push(root.identifier);
  index.push(`- \`${root.identifier}.md\` — задача MR: ${root.title}`);

  const seen = new Set<string>([root.identifier]);
  const docs = [...root.documents];

  if (root.parentIdentifier) {
    const epic = await fetchLinearIssue(config, root.parentIdentifier).catch(() => null);
    if (epic) {
      await write(`${epic.identifier}.md`, issueBody(epic));
      written.push(epic.identifier);
      seen.add(epic.identifier);
      index.push(`- \`${epic.identifier}.md\` — родительский эпик: ${epic.title}`);
      docs.push(...epic.documents);
    }
  }

  // Каждый документ отдельным файлом: раньше всё склеивалось в один блок и резалось по байтам.
  const docNames: string[] = [];
  for (const [i, doc] of docs.entries()) {
    const name = docFileName(doc.title, i);
    await write(join('docs', name), `# ${doc.title}\n\n${doc.content.trim()}\n`);
    docNames.push(`- \`docs/${name}\` — ${doc.title}`);
  }
  if (docNames.length > 0) {
    index.push('', 'Спецификации (снапшоты документов):', ...docNames);
  }

  // Смежные задачи, упомянутые в описании — то, чего боту раньше не хватало.
  const mentions = collectMentions(root.description, seen);
  const related: string[] = [];
  for (const key of mentions) {
    const issue = await fetchLinearIssue(config, key).catch(() => null);
    if (!issue) continue;
    await write(`${issue.identifier}.md`, issueBody(issue));
    written.push(issue.identifier);
    related.push(`- \`${issue.identifier}.md\` — упомянута в описании: ${issue.title}`);
  }
  if (related.length > 0) {
    index.push('', 'Смежные задачи:', ...related);
  }

  index.push(
    '',
    'Это снапшот на момент запуска ревью. Критерии приёмки ищи в описании задачи MR.',
  );
  await write('INDEX.md', `${index.join('\n')}\n`);

  return { dir, issueKeys: written };
}
