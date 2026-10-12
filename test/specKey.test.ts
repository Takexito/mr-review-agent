import { describe, it, expect } from 'vitest';
import { parseIssueKeyFromBranch } from '../src/linear/requirements.js';
import { splitIssueKey } from '../src/linear/client.js';

describe('parseIssueKeyFromBranch', () => {
  it('extracts and uppercases the key from a real branch', () => {
    expect(parseIssueKeyFromBranch('dev/prj-137-feature')).toBe('PRJ-137');
  });

  it('returns undefined when no key is present', () => {
    expect(parseIssueKeyFromBranch('dev/refactor-things')).toBeUndefined();
  });

  it('does not treat single-letter shorthands like t13 as a key', () => {
    expect(parseIssueKeyFromBranch('feature/t13-only')).toBeUndefined();
  });
});

describe('splitIssueKey', () => {
  it('splits an identifier into team key + number', () => {
    expect(splitIssueKey('PRJ-137')).toEqual({ teamKey: 'PRJ', number: 137 });
  });

  it('uppercases the team key', () => {
    expect(splitIssueKey('prj-1')).toEqual({ teamKey: 'PRJ', number: 1 });
  });

  it('returns null for garbage', () => {
    expect(splitIssueKey('not-a-key')).toBeNull();
    expect(splitIssueKey('X-1')).toBeNull(); // team key needs ≥2 letters
  });
});

