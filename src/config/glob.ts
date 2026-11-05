function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.+/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.+';
      i += 1;
    } else if (glob[i] === '*') {
      source += '[^/]*';
    } else {
      source += escapeRegExp(glob[i] ?? '');
    }
  }
  return new RegExp(`^${source}$`);
}

/** `*` — внутри одного сегмента пути, `**` — через любые сегменты. */
export function matchesProjectGlob(glob: string, projectPath: string): boolean {
  return globToRegExp(glob).test(projectPath);
}
