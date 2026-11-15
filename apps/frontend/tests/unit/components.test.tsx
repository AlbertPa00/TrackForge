import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

// --- mock the API client (all tests) ---
const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Test User', emailAddress: 't@t', isAdmin: false })),
  fetchMyPermissions: vi.fn(async () => ({ permissions: {} })),
  fetchLabels: vi.fn(async () => ['backend', 'bug', 'frontend']),
  fetchProjects: vi.fn(async () => [{ key: 'TF', name: 'TrackForge' }]),
  fetchMyself: vi.fn(async () => ({ accountId: 'me-1', displayName: 'Me User', emailAddress: 'me@x' })),
  searchAssignableUsers: vi.fn(async () => [
    { accountId: 'me-1', displayName: 'Me User', emailAddress: 'me@x' },
    { accountId: 'u-2', displayName: 'Other User', emailAddress: 'o@x' },
  ]),
  assignIssue: vi.fn(async () => ({})),
  previewDeleteIssue: vi.fn(async () => ({ confirmToken: 'tok-1', deletesSubtasks: ['TF-2'], clearsParentOn: ['TF-9'] })),
  deleteIssue: vi.fn(async () => ({})),
  cloneIssue: vi.fn(async () => ({ key: 'TF-9' })),
  moveIssue: vi.fn(async () => ({ key: 'TF-1' })),
  updateIssueFields: vi.fn(async () => ({})),
  fetchIssueTypes: vi.fn(async () => [
    { id: 't-story', name: 'Story', subtask: false },
    { id: 't-task', name: 'Task', subtask: false },
    { id: 't-sub', name: 'Subtask', subtask: true },
  ]),
  fetchComments: vi.fn(async () => ({
    comments: [{ id: 'c1', body: 'a **comment**', author: { accountId: 'u-2', displayName: 'Other User' }, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', self: '' }],
    total: 1, startAt: 0, maxResults: 50,
  })),
  addComment: vi.fn(async () => ({})),
  editComment: vi.fn(async () => ({})),
  deleteComment: vi.fn(async () => ({})),
  renderMentions: vi.fn((s: string) => s),
  fetchAttachmentMeta: vi.fn(async () => ({ enabled: true, uploadLimit: 1e6 })),
  uploadAttachments: vi.fn(async () => []),
  deleteAttachment: vi.fn(async () => undefined),
  attachmentPath: vi.fn((u: string) => u),
  // IssuePicker (convert/link/move dialogs) — /issue/picker sections.
  pickIssues: vi.fn(async () => ({
    sections: [{ label: 'Issues', issues: [
      { id: 'i9', key: 'TF-9', keyHtml: 'TF-9', summary: 'Parent candidate', issueType: 'Task', status: 'To Do' },
    ] }],
  })),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

import InlineEdit from '../../src/components/InlineEdit.js';
import LabelsEditor from '../../src/components/LabelsEditor.js';
import { Markdown, MarkdownEditor } from '../../src/components/Markdown.js';
import IssueActionsMenu from '../../src/components/IssueActionsMenu.js';
import AssigneePicker from '../../src/components/AssigneePicker.js';
import ActivitySection from '../../src/components/ActivitySection.js';

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (el: ReactElement) =>
  render(<QueryClientProvider client={qc()}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);
beforeEach(() => vi.clearAllMocks());

describe('Markdown sanitisation (XSS)', () => {
  it('strips <img onerror> and event attributes', () => {
    const { container } = wrap(<Markdown text={'<img src=x onerror=alert(1)> hi'} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('onerror')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });
  it('neutralises javascript: URLs but keeps normal links', () => {
    const { container } = wrap(<Markdown text={'[x](javascript:alert(1)) [ok](https://a.b)'} />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
    expect(hrefs).toContain('https://a.b');
  });
  it('renders markdown (bold/code) without raw HTML injection', () => {
    const { container } = wrap(<Markdown text={'**b** `c` <script>alert(1)</script>'} />);
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('code')?.textContent).toBe('c');
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('MarkdownEditor', () => {
  it('Write/Preview toggle; Save calls onSave; failure shows error', async () => {
    const onSave = vi.fn(async () => {});
    wrap(<MarkdownEditor value="init" onSave={onSave} onCancel={() => {}} />);
    await userEvent.click(screen.getByText('Preview'));
    expect(screen.getByText('init')).toBeTruthy(); // preview shows draft
    await userEvent.click(screen.getByText('Write'));
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('init'));
  });
});

describe('InlineEdit', () => {
  const display = (v: string) => <span>{v}</span>;
  it('click → editor; Enter commits onSave; Escape cancels', async () => {
    const onSave = vi.fn(async () => {});
    wrap(<InlineEdit value="old" display={display} onSave={onSave} />);
    await userEvent.click(screen.getByLabelText('Edit'));
    const input = screen.getByDisplayValue('old');
    await userEvent.clear(input);
    await userEvent.type(input, 'new{Enter}');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('new'));

    onSave.mockClear();
    await userEvent.click(screen.getByLabelText('Edit'));
    const input2 = screen.getByDisplayValue('old');
    await userEvent.type(input2, 'changed{Escape}');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Edit')).toBeTruthy(); // back in display mode
  });
  it('blur commits; save rejection shows the error and stays editing', async () => {
    const onSave = vi.fn(async () => { throw new Error('boom'); });
    wrap(<InlineEdit value="v" display={display} onSave={onSave} />);
    await userEvent.click(screen.getByLabelText('Edit'));
    const input = screen.getByDisplayValue('v');
    await userEvent.type(input, '2');
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.getByDisplayValue('v2')).toBeTruthy(); // still editing
  });
  it('required field blocks empty save', async () => {
    const onSave = vi.fn(async () => {});
    wrap(<InlineEdit value="x" display={display} onSave={onSave} allowEmpty={false} />);
    await userEvent.click(screen.getByLabelText('Edit'));
    const input = screen.getByDisplayValue('x');
    await userEvent.clear(input);
    await userEvent.type(input, '{Enter}');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('This field is required')).toBeTruthy();
  });
});

describe('LabelsEditor', () => {
  it('renders chips; Enter adds merged label; × removes one', async () => {
    const onSave = vi.fn(async () => {});
    wrap(<LabelsEditor labels={['backend']} onSave={onSave} />);
    expect(screen.getByText('backend')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Edit labels'));
    await userEvent.type(screen.getByPlaceholderText(''), 'newlab{Enter}');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['backend', 'newlab']));
  });
  it('Escape cancels without saving; suggestion click saves', async () => {
    const onSave = vi.fn(async () => {});
    wrap(<LabelsEditor labels={[]} onSave={onSave} />);
    await userEvent.click(screen.getByLabelText('Edit labels'));
    const input = screen.getByPlaceholderText('Add labels…');
    await userEvent.type(input, 'fro{Escape}');
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('IssueActionsMenu', () => {
  it('opens menu → Delete → preview modal → confirm calls deleteIssue with token', async () => {
    wrap(<IssueActionsMenu issueKey="TF-1" hasSubtasks={true} />);
    await userEvent.click(screen.getByLabelText('Issue actions'));
    await userEvent.click(screen.getByText('Delete'));
    expect(mocks.previewDeleteIssue).toHaveBeenCalledWith('TF-1', true);
    await screen.findByText('Delete TF-1?');
    expect(screen.getByText(/TF-2/)).toBeTruthy(); // subtask impact shown
    await userEvent.click(screen.getAllByText('Delete').pop()!);
    await waitFor(() => expect(mocks.deleteIssue).toHaveBeenCalledWith('TF-1', true, 'tok-1'));
  });

  it('Add flag → updateIssueFields(customfield_10002, [Impediment]); flagged shows Remove flag', async () => {
    wrap(<IssueActionsMenu issueKey="TF-1" hasSubtasks={false} flagged={false} />);
    await userEvent.click(screen.getByLabelText('Issue actions'));
    await userEvent.click(screen.getByText('Add flag'));
    await waitFor(() =>
      expect(mocks.updateIssueFields).toHaveBeenCalledWith('TF-1', {
        customfield_10002: [{ value: 'Impediment' }],
      })
    );
  });

  it('flagged=true → Remove flag clears the field', async () => {
    wrap(<IssueActionsMenu issueKey="TF-1" hasSubtasks={false} flagged={true} />);
    await userEvent.click(screen.getByLabelText('Issue actions'));
    await userEvent.click(screen.getByText('Remove flag'));
    await waitFor(() =>
      expect(mocks.updateIssueFields).toHaveBeenCalledWith('TF-1', { customfield_10002: [] })
    );
  });

  it('Link issue dispatches tf:link-issue event', async () => {
    const spy = vi.fn();
    window.addEventListener('tf:link-issue:TF-1', spy);
    wrap(<IssueActionsMenu issueKey="TF-1" hasSubtasks={false} />);
    await userEvent.click(screen.getByLabelText('Issue actions'));
    await userEvent.click(screen.getByText('Link issue'));
    expect(spy).toHaveBeenCalled();
    window.removeEventListener('tf:link-issue:TF-1', spy);
  });

  it('Convert to subtask → dialog writes issuetype + parent', async () => {
    wrap(<IssueActionsMenu issueKey="TF-1" hasSubtasks={false} issuetypeName="Story" />);
    await userEvent.click(screen.getByLabelText('Issue actions'));
    await userEvent.click(await screen.findByText('Convert to subtask'));
    // Dialog: type select (subtask types) + IssuePicker combobox for the parent.
    const parent = await screen.findByPlaceholderText('Parent issue key or summary…');
    await userEvent.type(parent, 'TF-9');
    await userEvent.click(await screen.findByRole('button', { name: /TF-9/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() =>
      expect(mocks.updateIssueFields).toHaveBeenCalledWith('TF-1', {
        issuetype: { name: 'Subtask' },
        parent: { key: 'TF-9' },
      })
    );
  });

  it('Convert to issue shown for subtask types, writes parent: null', async () => {
    wrap(<IssueActionsMenu issueKey="TF-2" hasSubtasks={false} issuetypeName="Subtask" issuetypeSubtask />);
    await userEvent.click(screen.getByLabelText('Issue actions'));
    await userEvent.click(await screen.findByText('Convert to issue'));
    await userEvent.click(await screen.findByText('Convert'));
    await waitFor(() =>
      expect(mocks.updateIssueFields).toHaveBeenCalledWith('TF-2', {
        issuetype: { name: 'Story' },
        parent: null,
      })
    );
  });
});

describe('AssigneePicker', () => {
  it('opens dropdown, lists people + "Assign to me", pick calls assignIssue', async () => {
    wrap(<AssigneePicker issueKey="TF-1" projectKey="TF" assignee={null} />);
    await userEvent.click(screen.getByText('Unassigned'));
    await screen.findByText('Other User');
    await userEvent.click(screen.getByText('Other User'));
    await waitFor(() => expect(mocks.assignIssue).toHaveBeenCalledWith('TF-1', 'u-2'));
  });
  it('"Assign to me" calls assignIssue with own accountId', async () => {
    wrap(<AssigneePicker issueKey="TF-1" projectKey="TF" assignee={null} />);
    await userEvent.click(screen.getByText('Unassigned'));
    await userEvent.click(await screen.findByText('Assign to me'));
    await waitFor(() => expect(mocks.assignIssue).toHaveBeenCalledWith('TF-1', 'me-1'));
  });
});

describe('ActivitySection', () => {
  const issue = {
    key: 'TF-1',
    self: '',
    fields: {
      project: { key: 'TF' },
      summary: 's',
    },
    changelog: {
      histories: [{
        id: 'h1',
        author: { accountId: 'u-2', displayName: 'Other User' },
        created: '2026-01-02T00:00:00Z',
        channel: 'api',
        items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
      }],
    },
  };
  it('shows comments + history merged; History tab filters to history only', async () => {
    wrap(<ActivitySection issue={issue as never} me={{ accountId: 'me-1' }} />);
    await screen.findByText('comment');
    expect(screen.getByText(/Status: To Do → Done/)).toBeTruthy();
    await userEvent.click(screen.getByText('History'));
    await waitFor(() => expect(screen.queryByText('comment')).toBeNull());
    expect(screen.getByText(/Status: To Do → Done/)).toBeTruthy();
  });
});

// ---- Sprint 018/019 components (020 gate coverage) ----
import AttachmentsPanel from '../../src/components/AttachmentsPanel.js';
import EntityRefPicker from '../../src/components/EntityRefPicker.js';

const attIssue = (atts: unknown[] = []) =>
  ({ key: 'TF-1', self: '', fields: { project: { key: 'TF' }, summary: 's', attachment: atts } }) as never;

describe('AttachmentsPanel', () => {
  const img = {
    id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 1234,
    content: 'http://x/rest/api/2/attachment/content/a1',
    thumbnail: 'http://x/rest/api/2/attachment/thumbnail/a1',
    created: '2026-01-01T00:00:00Z', self: '', author: { accountId: 'me-1', displayName: 'Me User' },
  };
  const doc = {
    id: 'a2', filename: 'spec.pdf', mimeType: 'application/pdf', size: 99999,
    content: 'http://x/rest/api/2/attachment/content/a2',
    created: '2026-01-01T00:00:00Z', self: '', author: { accountId: 'me-1', displayName: 'Me User' },
  };

  // The panel gates upload/delete on /mypermissions — grant the attachment
  // permissions for this describe, then restore the empty default.
  beforeEach(() =>
    mocks.fetchMyPermissions.mockResolvedValue({ permissions: {
      CREATE_ATTACHMENTS: { havePermission: true },
      DELETE_ALL_ATTACHMENTS: { havePermission: true },
      DELETE_OWN_ATTACHMENTS: { havePermission: true },
    }})
  );
  afterAll(() => mocks.fetchMyPermissions.mockResolvedValue({ permissions: {} }));

  it('renders image thumbs and file rows; empty state when none', () => {
    wrap(<AttachmentsPanel issue={attIssue([img, doc])} />);
    expect(screen.getByText('spec.pdf')).toBeTruthy();
    expect(screen.getAllByTitle('shot.png').length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeTruthy();
    const { unmount } = wrap(<AttachmentsPanel issue={attIssue([])} />);
    expect(screen.getAllByText('None').length).toBeGreaterThan(0);
    unmount();
  });

  it('rejects files over the advertised limit before uploading', async () => {
    mocks.fetchAttachmentMeta.mockResolvedValue({ enabled: true, uploadLimit: 10 });
    mocks.uploadAttachments.mockResolvedValue([]);
    const { container } = wrap(<AttachmentsPanel issue={attIssue([])} />);
    await screen.findByText(/max 10 B/);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const big = new File([new Uint8Array(11)], 'big.bin');
    fireEvent.change(input, { target: { files: [big] } });
    await screen.findByText(/exceeds the 10 B attachment limit/);
    expect(mocks.uploadAttachments).not.toHaveBeenCalled();
  });

  it('calls uploadAttachments on file input and deleteAttachment on ×', async () => {
    mocks.fetchAttachmentMeta.mockResolvedValue({ enabled: true, uploadLimit: 1e6 });
    mocks.uploadAttachments.mockResolvedValue([]);
    mocks.deleteAttachment.mockResolvedValue(undefined);
    const { container } = wrap(<AttachmentsPanel issue={attIssue([doc])} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(mocks.uploadAttachments).toHaveBeenCalledWith('TF-1', expect.any(Array)));
    await userEvent.click(screen.getByLabelText('Delete spec.pdf'));
    await waitFor(() => expect(mocks.deleteAttachment).toHaveBeenCalledWith('a2'));
  });
});

describe('EntityRefPicker', () => {
  const opts = [
    { id: 'v1', name: '1.0' },
    { id: 'v2', name: '1.1' },
    { id: 'v3', name: '2.0-beta' },
  ];

  it('toggles options on/off via the dropdown and saves the new set', async () => {
    const onSave = vi.fn(async () => undefined);
    wrap(<EntityRefPicker values={[opts[0]]} options={opts} onSave={onSave} label="Fix versions" />);
    expect(screen.getByText('1.0')).toBeTruthy();
    await userEvent.click(screen.getByText('1.0')); // open dropdown
    await userEvent.click(await screen.findByText('1.1'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([opts[0], opts[1]]));
  });

  it('filters suggestions by typed text', async () => {
    wrap(<EntityRefPicker values={[]} options={opts} onSave={async () => undefined} />);
    await userEvent.click(screen.getByText('None'));
    const input = screen.getByPlaceholderText(/type to filter|search/i);
    await userEvent.type(input, 'beta');
    await screen.findByText('2.0-beta');
    expect(screen.queryByText('1.1')).toBeNull();
  });
});
