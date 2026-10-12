import { describe, it, expect } from 'vitest';
import { makeBlobLinker } from '../src/gitlab/links.js';

describe('makeBlobLinker', () => {
  const link = makeBlobLinker(
    '/tmp/codex-wt-xP8q6q/repo',
    'https://gitlab.com',
    'acme/android-app',
    'abc123',
  );

  it('should rewrite a worktree path:line to a blob url with #L anchor', () => {
    const out = link('см [File.kt:29](/tmp/codex-wt-xP8q6q/repo/features/src/File.kt:29).');
    expect(out).toContain(
      'https://gitlab.com/acme/android-app/-/blob/abc123/features/src/File.kt#L29',
    );
    expect(out).not.toContain('/tmp/codex-wt-');
    // текст ссылки [File.kt:29] не трогаем — у него нет префикса worktree
    expect(out).toContain('[File.kt:29]');
  });

  it('should rewrite a worktree path without a line (no #L)', () => {
    const out = link('(/tmp/codex-wt-xP8q6q/repo/a/b/File.kt)');
    expect(out).toBe('(https://gitlab.com/acme/android-app/-/blob/abc123/a/b/File.kt)');
  });

  it('should leave repo-relative paths untouched', () => {
    expect(link('features/src/File.kt:29')).toBe('features/src/File.kt:29');
  });

  it('should strip a trailing slash in the host', () => {
    const l2 = makeBlobLinker('/tmp/wt', 'https://gitlab.com/', 'g/p', 'sha');
    expect(l2('/tmp/wt/x.kt:1')).toBe('https://gitlab.com/g/p/-/blob/sha/x.kt#L1');
  });
});
