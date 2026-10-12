export type SpecRef =
  | { readonly kind: 'gitlab'; readonly target: string }
  | { readonly kind: 'linear'; readonly key: string };

export interface ExtractOptions {
  /**
   * Принимать ключ Linear в любом регистре. Только для аргумента команды: в описании MR
   * `utf-8` или `feature-34` иначе читались бы как задачи.
   */
  readonly looseLinearCase?: boolean;
}

/** Задача или файл на GitLab; MR сюда не входит — чужой MR не постановка. */
const GITLAB_URL_RE = /https?:\/\/[^\s)<>\]"']+\/-\/(?:issues|work_items|blob|raw)\/[^\s)<>\]"']+/g;
const LINEAR_URL_RE = /https?:\/\/linear\.app\/[^\s/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/g;
/** `#34`, `group/project#34`. Lookbehind отсекает якоря URL (`…/page#34`) и HTML-сущности. */
const SHORT_REF_RE = /(?<![\w/&#])((?:[\w.-]+\/)+[\w.-]+)?#(\d{1,7})(?![\w-])/g;
const LINEAR_KEY_RE = /(?<![\w/-])([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/g;
const LINEAR_KEY_LOOSE_RE = /(?<![\w/-])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![\w-])/g;

function refId(ref: SpecRef): string {
  return ref.kind === 'gitlab' ? `g:${ref.target}` : `l:${ref.key}`;
}

/** Все ссылки в порядке появления, без повторов. `gitlabHost` — чужие хосты не берём. */
export function extractSpecRefs(text: string, gitlabHost: string, options: ExtractOptions = {}): SpecRef[] {
  let origin: string;
  try {
    origin = new URL(gitlabHost).origin;
  } catch {
    origin = '';
  }
  const found: { index: number; ref: SpecRef }[] = [];
  // URL вырезаем из текста, чтобы их куски не совпали повторно как короткие ссылки и ключи.
  let rest = text;
  const cut = (re: RegExp, toRef: (m: RegExpMatchArray) => SpecRef | null): void => {
    for (const m of rest.matchAll(re)) {
      const ref = toRef(m);
      if (ref) found.push({ index: m.index ?? 0, ref });
    }
    rest = rest.replace(re, (match) => ' '.repeat(match.length));
  };

  cut(GITLAB_URL_RE, (m) => {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    return origin && url.startsWith(`${origin}/`) ? { kind: 'gitlab', target: url } : null;
  });
  cut(LINEAR_URL_RE, (m) => ({ kind: 'linear', key: m[1]!.toUpperCase() }));
  cut(/https?:\/\/\S+/g, () => null);
  cut(SHORT_REF_RE, (m) => ({ kind: 'gitlab', target: `${m[1] ?? ''}#${m[2]}` }));
  cut(options.looseLinearCase ? LINEAR_KEY_LOOSE_RE : LINEAR_KEY_RE, (m) => ({
    kind: 'linear',
    key: m[1]!.toUpperCase(),
  }));

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => f.ref)
    .filter((ref) => {
      const id = refId(ref);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

/** Обратно в строку — для JobData (сериализуется в Redis) и подписей в заметке. */
export function specRefLabel(ref: SpecRef): string {
  return ref.kind === 'gitlab' ? ref.target : ref.key;
}
