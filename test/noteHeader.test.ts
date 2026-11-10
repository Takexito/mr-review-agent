import { describe, it, expect } from 'vitest';
import { noteHeader, withHeader } from '../src/gitlab/noteHeader.js';
import type { ToolCall } from '../src/agent/journal.js';

const call = (args: unknown, ok = true, tool = 'get_issue'): ToolCall => ({ server: 'linear', tool, arguments: args, ok });

describe('noteHeader', () => {
  it('should list opened calls once each with their arguments, and failed ones separately', () => {
    const header = noteHeader({
      calls: [call({ id: 'PRJ-7' }), call({ id: 'PRJ-7' }), call({ id: 'BAD-1' }, false)],
      related: [],
    });
    expect(header).toEqual([
      '',
      '_Открыто агентом: `linear · get_issue · PRJ-7`._',
      '_Не открылось: `linear · get_issue · BAD-1`._',
    ]);
  });

  it('should not report a call as failed when a retry of it succeeded', () => {
    const header = noteHeader({ calls: [call({ id: 'X-1' }, false), call({ id: 'X-1' })], related: [] });
    expect(header.join('\n')).not.toContain('Не открылось');
  });

  it('should be empty when nothing was opened and there are no related repositories', () => {
    expect(noteHeader({ calls: [], related: [] })).toEqual([]);
  });

  it('should show the branch taken for each related repository', () => {
    expect(
      noteHeader({
        calls: [],
        related: [
          { project: 'acme/docs', ref: 'main' },
          { project: 'acme/backend', ref: '34-feature' },
        ],
      }),
    ).toEqual(['', '_Смежные репозитории: `acme/docs` (`main`), `acme/backend` (`34-feature`)._']);
  });

  it('should keep a branch name chosen by the MR author inside its code span', () => {
    const [, line] = noteHeader({ calls: [], related: [{ project: 'g/docs', ref: 'x`@all`' }] });
    expect(line).toBe("_Смежные репозитории: `g/docs` (`x'@all'`)._");
  });

  it('should keep agent-made arguments inside a single code span on one line', () => {
    const [, line] = noteHeader({
      calls: [call({ query: 'a`b\n/close @all **x**', limit: 5, nested: { deep: 1 } })],
      related: [],
    });
    expect(line).toBe('_Открыто агентом: `linear · get_issue · a\'b /close @all **x**, 5`._');
  });

  it('should keep a failed call visible when it differs from an opened one only past the cut', () => {
    const long = 'z'.repeat(100);
    const header = noteHeader({ calls: [call({ q: `${long}-a` }), call({ q: `${long}-b` }, false)], related: [] });
    expect(header.join('\n')).toContain('Не открылось');
  });

  it('should cut long arguments and long lists', () => {
    const calls = Array.from({ length: 25 }, (_, i) => call({ id: `X-${i}`, text: 'y'.repeat(200) }));
    const [, line] = noteHeader({ calls, related: [] });
    expect(line).toContain('…');
    expect(line).toContain('и ещё 5');
    expect(line!.length).toBeLessThan(25 * 120);
  });
});

describe('withHeader', () => {
  it('should put the header right under the heading line', () => {
    expect(withHeader('## 🤖 Codex review\n\nтекст', ['', '_шапка_'])).toBe('## 🤖 Codex review\n\n_шапка_\n\nтекст');
  });

  it('should leave the body as is when the header is empty', () => {
    expect(withHeader('## h\n\nтекст', [])).toBe('## h\n\nтекст');
  });
});
