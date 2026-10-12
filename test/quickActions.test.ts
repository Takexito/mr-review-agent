import { describe, it, expect } from 'vitest';
import { neutralizeQuickActions } from '../src/gitlab/quickActions.js';

describe('neutralizeQuickActions', () => {
  it('should escape a quick action at the start of a line, including an indented one', () => {
    expect(neutralizeQuickActions('Готово.\n/merge\n  /approve')).toBe('Готово.\n\\/merge\n  \\/approve');
  });

  it('should leave slashes that do not start a line', () => {
    const text = 'путь features/src/A.kt и /tmp/x\n> /approve в цитате\n| /close | в таблице |';
    expect(neutralizeQuickActions(text)).toBe(text);
  });

  it('should escape any leading slash without guessing what GitLab treats as a command name', () => {
    expect(neutralizeQuickActions('/Merge\n/assign_reviewer @x\n/2fa\n\t/close')).toBe(
      '\\/Merge\n\\/assign_reviewer @x\n\\/2fa\n\t\\/close',
    );
  });

  it('should escape commands inside fenced code blocks too', () => {
    expect(neutralizeQuickActions('```bash\n/merge\n```')).toBe('```bash\n\\/merge\n```');
  });

  it('should escape a command after a fence that is never closed', () => {
    expect(neutralizeQuickActions('```\nкод\n/approve')).toBe('```\nкод\n\\/approve');
  });
});
