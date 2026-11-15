import { describe, it, expect } from 'vitest';
import { describeProposal } from '../../src/lib/proposalDisplay.js';

// The Approvals inbox + issue panel read `describeProposal`'s sentence, never
// the raw REST payload — cover each dry-run shape the backend can store.

describe('describeProposal', () => {
  it('renders a field update as labeled change rows', () => {
    const d = describeProposal({
      method: 'PUT',
      path: '/rest/api/2/issue/TF-1',
      diff: {
        changes: [{ field: 'summary', fromString: 'old', toString: 'new' }],
      },
    });
    expect(d.text).toBe('Update TF-1');
    expect(d.fields).toEqual([{ label: 'Summary', from: 'old', to: 'new' }]);
  });

  it('renders a transition as "from → to" with non-status rows kept', () => {
    const d = describeProposal({
      method: 'POST',
      path: '/rest/api/2/issue/TF-2/transitions',
      diff: {
        changes: [
          { field: 'status', fromString: 'To Do', toString: 'Done' },
          { field: 'resolution', fromString: null, toString: 'Fixed' },
        ],
      },
    });
    expect(d.text).toBe('TF-2: To Do → Done');
    expect(d.fields).toEqual([{ label: 'Resolution', from: null, to: 'Fixed' }]);
  });

  it('renders a comment proposal as its body', () => {
    const d = describeProposal({
      method: 'POST',
      path: '/rest/api/2/issue/TF-3/comment',
      diff: { dryRun: true, comment: { body: 'agent note' } },
    });
    expect(d.text).toBe('Comment on TF-3');
    expect(d.markdown).toBe('agent note');
  });

  it('marks deletes destructive and mentions subtasks', () => {
    const d = describeProposal({
      method: 'DELETE',
      path: '/rest/api/2/issue/TF-4',
      diff: { key: 'TF-4', deletesSubtasks: ['TF-5'], clearsParentOn: [], confirmToken: 'x' },
    });
    expect(d.destructive).toBe(true);
    expect(d.text).toContain('Delete TF-4');
    expect(d.text).toContain('subtask');
  });

  it('renders composite multi-step edits', () => {
    const d = describeProposal({
      method: 'PUT',
      path: '/rest/api/2/issue/TF-6',
      diff: {
        dryRun: true,
        steps: {
          fields: { changes: [{ field: 'summary', fromString: 'a', toString: 'b' }] },
          transition: { changes: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }] },
          comment: { body: 'took it' },
        },
      },
    });
    expect(d.text).toContain('TF-6');
    expect(d.fields?.length).toBe(2);
    expect(d.markdown).toBe('took it');
  });

  it('renders internal ops in human terms', () => {
    expect(
      describeProposal({ method: 'POST', path: '/api/internal/issues/TF-7/move', body: { target: { projectKey: 'OPS' } } }).text
    ).toBe('Move TF-7 to OPS');
    expect(
      describeProposal({ method: 'POST', path: '/api/internal/bulk/delete', body: { issueKeys: ['TF-1', 'TF-2'] } })
    ).toMatchObject({ text: 'Bulk delete on 2 issue(s)', destructive: true });
    expect(describeProposal({ method: 'POST', path: '/api/internal/issues/TF-8/clone' }).text).toBe('Clone TF-8');
  });

  it('falls back to method+path for unknown or malformed input', () => {
    expect(describeProposal({ method: 'POST', path: '/rest/api/2/gadget' }).text).toBe('POST /rest/api/2/gadget');
    // A null-shaped diff must not throw.
    expect(describeProposal({ method: 'PUT', path: '/rest/api/2/issue/TF-9', diff: null }).text).toBe('Update TF-9');
  });
});
