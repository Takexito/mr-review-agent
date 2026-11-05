import { describe, expect, it } from 'vitest';
import { chooseRelatedRef } from '../src/related/checkout.js';

describe('chooseRelatedRef', () => {
  const branches = { defaultBranch: 'main', has: (b: string) => ['main', 'feature/x'].includes(b) };

  it('should take the default branch when ref is not set', () => {
    expect(chooseRelatedRef(undefined, 'feature/x', branches)).toBe('main');
  });

  it('should take a fixed ref as is', () => {
    expect(chooseRelatedRef('release', 'feature/x', branches)).toBe('release');
  });

  it('should take the MR branch for same-branch when the related repository has it', () => {
    expect(chooseRelatedRef('same-branch', 'feature/x', branches)).toBe('feature/x');
  });

  it('should fall back to the default branch for same-branch when the related repository lacks it', () => {
    expect(chooseRelatedRef('same-branch', 'feature/y', branches)).toBe('main');
  });
});
