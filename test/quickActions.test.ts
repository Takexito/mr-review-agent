import { describe, it, expect } from 'vitest';
import { neutralizeQuickActions } from '../src/gitlab/quickActions.js';

describe('neutralizeQuickActions', () => {
  it('should escape a quick action at the start of a line, including an indented one', () => {
    expect(neutralizeQuickActions('Готово.\n/merge\n  /approve')).toBe('Готово.\n\\/merge\n  \\/approve');
  });

  it('should leave slashes that cannot be commands', () => {
    const text = 'путь features/src/A.kt и /tmp/x\n> /approve в цитате\n| /close | в таблице |\n/ 2 = половина';
    expect(neutralizeQuickActions(text)).toBe(text.replace('и /tmp/x', 'и /tmp/x'));
  });

  it('should not touch lines inside fenced code blocks', () => {
    const text = '```bash\n/usr/bin/env node\n/merge\n```\n/merge';
    expect(neutralizeQuickActions(text)).toBe('```bash\n/usr/bin/env node\n/merge\n```\n\\/merge');
  });

  it('should keep escaping after a tilde fence that contains backticks', () => {
    expect(neutralizeQuickActions('~~~\n```\n/close\n~~~\n/close')).toBe('~~~\n```\n/close\n~~~\n\\/close');
  });
});
