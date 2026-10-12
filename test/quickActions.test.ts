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

  it('should escape commands inside fenced code blocks too', () => {
    expect(neutralizeQuickActions('```bash\n/merge\n```')).toBe('```bash\n\\/merge\n```');
  });

  it('should escape a command after a fence that is never closed', () => {
    expect(neutralizeQuickActions('```\nкод\n/approve')).toBe('```\nкод\n\\/approve');
  });
});
