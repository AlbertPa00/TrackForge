import { describe, it, expect } from 'vitest';
import { toIssueKey } from '../../src/services/issueService.js';

describe('toIssueKey', () => {
  it('formats project key and issue number', () => {
    expect(toIssueKey('PROJ', 1)).toBe('PROJ-1');
    expect(toIssueKey('TF', 42)).toBe('TF-42');
  });
});
