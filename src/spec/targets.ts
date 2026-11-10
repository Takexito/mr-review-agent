/** Префикс ключа задач GitLab в `issueKeys`: `#34`, `group/project#34`. */
export const GITLAB_ISSUE_PREFIX = '#';

/** Прямая цель MR: задача, которую по правилам привязки он реализует. */
export interface DirectTarget {
  /** Как цель названа в заметке и в чек-листе: `PRJ-137`, `#34`, `group/project#34`. */
  readonly label: string;
  /** Коннектор, правило `prefetch` которого скачивает цель. */
  readonly connector: string;
  readonly number: string;
  /** Проект задачи GitLab; для остальных — проект MR. */
  readonly project: string;
}

export interface MrTargetFields {
  readonly title: string;
  readonly branch: string;
  readonly description: string;
  /** Аргумент команды `spec`; непустой — цели берутся только из него. */
  readonly args?: readonly string[];
}

export interface TargetRules {
  readonly issueKeys: Readonly<Record<string, string>>;
  readonly gitlabHost: string;
  readonly projectPath: string;
  /** Проекты, задачи которых могут быть целью, — см. `KindContext.allowedProjects`. */
  readonly allowedProjects: readonly string[];
}

export interface FoundTargets {
  readonly targets: readonly DirectTarget[];
  /** Токены аргумента команды, не подошедшие ни под один префикс. */
  readonly unmatched: readonly string[];
  /** Задачи GitLab проектов вне профиля: не скачиваются. */
  readonly foreign: readonly string[];
}

interface Found {
  readonly index: number;
  readonly target: DirectTarget;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyTargets(text: string, rules: TargetRules): Found[] {
  const found: Found[] = [];
  for (const [prefix, connector] of Object.entries(rules.issueKeys)) {
    if (prefix === GITLAB_ISSUE_PREFIX) continue;
    // Регистр не важен: ветки пишут `prj-137`, а мусор вроде `utf-8` отсекает сам список префиксов.
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(prefix)}-(\\d+)(?!\\d)`, 'gi');
    for (const m of text.matchAll(re)) {
      found.push({
        index: m.index ?? 0,
        target: { label: `${prefix}-${m[1]}`, connector, number: m[1]!, project: rules.projectPath },
      });
    }
  }
  return found;
}

const ISSUE_URL_RE = /https?:\/\/[^\s)<>\]"']+?\/-\/(?:issues|work_items)\/(\d+)/g;
const ANY_URL_RE = /https?:\/\/[^\s)<>\]"']+/g;
/** Lookbehind отсекает якоря URL (`…/page#34`) и HTML-сущности. */
const SHORT_REF_RE = /(?<![\w/&#])((?:[\w.-]+\/)+[\w.-]+)?#(\d{1,7})(?![\w-])/g;
/** GitLab, создавая ветку из задачи, ставит её номер в начало: `34-nick-change`. */
const BRANCH_ISSUE_RE = /^(\d+)-/g;

function issueTarget(project: string, number: string, connector: string, rules: TargetRules): DirectTarget {
  const label = project === rules.projectPath ? `#${number}` : `${project}#${number}`;
  return { label, connector, number, project };
}

function blank(text: string, re: RegExp): string {
  return text.replace(re, (match) => ' '.repeat(match.length));
}

function gitlabTargets(text: string, rules: TargetRules, inBranch: boolean): Found[] {
  const connector = rules.issueKeys[GITLAB_ISSUE_PREFIX];
  if (!connector) return [];
  const found: Found[] = [];
  const push = (index: number, project: string, number: string): void => {
    found.push({ index, target: issueTarget(project, number, connector, rules) });
  };
  if (inBranch) {
    for (const m of text.matchAll(BRANCH_ISSUE_RE)) push(m.index ?? 0, rules.projectPath, m[1]!);
    return found;
  }
  let base: URL | null = null;
  try {
    base = new URL(rules.gitlabHost);
  } catch {
    // Без своего хоста ссылки не разобрать: задача чужого GitLab — не задача этого MR.
  }
  const basePath = base?.pathname.replace(/\/+$/, '') ?? '';
  for (const m of text.matchAll(ISSUE_URL_RE)) {
    let path: string;
    try {
      const url = new URL(m[0]);
      if (!base || url.origin !== base.origin) continue;
      path = decodeURIComponent(url.pathname);
    } catch {
      continue;
    }
    if (!path.startsWith(`${basePath}/`)) continue;
    const project = path.slice(basePath.length + 1).replace(/\/-\/.*$/, '');
    push(m.index ?? 0, project, m[1]!);
  }
  // Куски URL не должны совпасть повторно как короткие ссылки.
  for (const m of blank(text, ANY_URL_RE).matchAll(SHORT_REF_RE)) {
    push(m.index ?? 0, m[1] ?? rules.projectPath, m[2]!);
  }
  return found;
}

function targetsIn(text: string, rules: TargetRules, inBranch = false): DirectTarget[] {
  return [...keyTargets(text, rules), ...gitlabTargets(text, rules, inBranch)]
    .sort((a, b) => a.index - b.index)
    .map((f) => f.target);
}

/** Строка привязки — с начала строки, после маркера списка или цитаты: «Closes PRJ-1, PRJ-2». */
const LINK_LINE_RE =
  /^[\s>*_-]*(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|implement(?:s|ed|ing)?|refs?|references?)\b[\s:*_]*(.*)$/gim;

const REF_SEPARATOR_RE = /\s*[,;]\s*|\s+(?:and|и)\s+|\s+/i;

/** Как у GitLab: цели — список ссылок сразу за ключевым словом; «Fix crash in PRJ-45» цели не даёт. */
function linkLineTargets(description: string, rules: TargetRules): DirectTarget[] {
  const targets: DirectTarget[] = [];
  for (const m of description.matchAll(LINK_LINE_RE)) {
    for (const token of m[1]!.split(REF_SEPARATOR_RE)) {
      const found = targetsIn(token.replace(/[.:!?]+$/, ''), rules);
      if (found.length === 0) break;
      targets.push(...found);
    }
  }
  return targets;
}

function keepAllowed(targets: readonly DirectTarget[], unmatched: readonly string[], rules: TargetRules): FoundTargets {
  const allowed = new Set(rules.allowedProjects);
  const seen = new Set<string>();
  const kept: DirectTarget[] = [];
  const foreign: string[] = [];
  for (const t of targets) {
    if (seen.has(t.label)) continue;
    seen.add(t.label);
    if (allowed.has(t.project)) kept.push(t);
    else foreign.push(t.label);
  }
  return { targets: kept, unmatched, foreign };
}

/**
 * Ключ с префиксом из `issueKeys` в заголовке MR, в имени ветки, в строке `Closes/Fixes/Resolves/Refs`
 * описания или в аргументе команды. Описание вне этих строк не смотрим: там `UTF-8` и соседние задачи.
 */
export function findDirectTargets(sources: MrTargetFields, rules: TargetRules): FoundTargets {
  if (sources.args && sources.args.length > 0) {
    const targets: DirectTarget[] = [];
    const unmatched: string[] = [];
    for (const token of sources.args) {
      const found = targetsIn(token, rules);
      if (found.length === 0) unmatched.push(token);
      targets.push(...found);
    }
    return keepAllowed(targets, unmatched, rules);
  }
  const targets = [
    ...targetsIn(sources.title, rules),
    ...targetsIn(sources.branch, rules, true),
    ...linkLineTargets(sources.description, rules),
  ];
  return keepAllowed(targets, [], rules);
}
