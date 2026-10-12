import { describe, it, expect } from 'vitest';
import { parseSpecOutput } from '../src/codex/parseSpec.js';
import { SPEC_BEGIN, SPEC_END } from '../src/codex/prompts.js';

function wrap(json: string): string {
  return `какой-то префикс\n${SPEC_BEGIN}\n${json}\n${SPEC_END}\nхвост`;
}

describe('parseSpecOutput', () => {
  it('parses a valid checklist', () => {
    const out = wrap(
      JSON.stringify({
        summary: 'в целом ок',
        items: [{ requirement: 'A', status: 'met', evidence: 'F.kt:1', note: 'нашёл' }],
      }),
    );
    const r = parseSpecOutput(out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.items).toHaveLength(1);
    expect(r.spec.items[0]!.status).toBe('met');
    expect(r.spec.summary).toBe('в целом ок');
  });

  it('defaults a missing status to unclear and summary to empty', () => {
    const out = wrap(JSON.stringify({ items: [{ requirement: 'A' }] }));
    const r = parseSpecOutput(out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.items[0]!.status).toBe('unclear');
    expect(r.spec.summary).toBe('');
  });

  it('tolerates a ```json fence inside the markers', () => {
    const out = wrap(`\`\`\`json\n${JSON.stringify({ items: [] })}\n\`\`\``);
    expect(parseSpecOutput(out).ok).toBe(true);
  });

  it('fails when markers are absent', () => {
    expect(parseSpecOutput('нет маркеров').ok).toBe(false);
  });

  it('fails on invalid JSON', () => {
    expect(parseSpecOutput(wrap('{ битый json')).ok).toBe(false);
  });

  it('fails on schema mismatch (item without requirement)', () => {
    const out = wrap(JSON.stringify({ items: [{ status: 'met' }] }));
    expect(parseSpecOutput(out).ok).toBe(false);
  });
});
