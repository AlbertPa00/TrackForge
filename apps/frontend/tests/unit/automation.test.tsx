import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';
import { useState } from 'react';
import AutomationPage from '../../src/pages/AutomationPage';
import IssuePicker from '../../src/components/IssuePicker';

const RULE = {
  id: 'r1', name: 'Triage flagger', scope: 'project', enabled: true, version: 3,
  failureCount: 0, trigger: { type: 'issue_created' },
  conditions: [], actions: [{ type: 'add_labels' }, { type: 'comment' }],
  actor: { accountId: 'a1', displayName: 'Admin' },
  project: { id: 'p1', key: 'TF', name: 'TrackForge' },
};

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Test User', emailAddress: 't@t', isAdmin: false })),
  fetchMyPermissions: vi.fn(async () => ({ permissions: {} })),
  fetchAutomationRules: vi.fn(async () => ({ rules: [RULE] })),
  fetchAutomationSchema: vi.fn(async () => ({
    triggers: [{ name: 'issue_created', description: 'x' }],
    conditions: [{ name: 'jql', description: 'x' }],
    actions: [{ name: 'comment', description: 'x' }],
  })),
  createAutomationRule: vi.fn(async () => RULE),
  updateAutomationRule: vi.fn(async () => RULE),
  deleteAutomationRule: vi.fn(async () => undefined),
  toggleAutomationRule: vi.fn(async () => ({ ...RULE, enabled: false })),
  fetchAutomationRuns: vi.fn(async () => ({
    runs: [{
      id: 'run1', ruleId: 'r1', ruleVersion: 3, status: 'success', startedAt: '2026-11-17T10:00:00Z',
      steps: [
        { step: 'trigger', index: 0, detail: 'issue_created event 42', at: '2026-11-17T10:00:00Z' },
        { step: 'action', index: 0, detail: 'comment', result: { issueKey: 'TF-1' }, at: '2026-11-17T10:00:01Z' },
      ],
    }],
  })),
  validateAutomationRule: vi.fn(async () => ({ valid: true, errors: [] })),
  dryRunAutomationRule: vi.fn(async () => ({ status: 'success' })),
  // usePermissions (WIP) — identity + optimistic permission gate.
  fetchMyself: vi.fn(async () => ({ accountId: 'a1', displayName: 'Admin', emailAddress: 'a@x', isAdmin: true })),
  fetchMyPermissions: vi.fn(async () => ({ permissions: {} })),
  pickIssues: vi.fn(async () => ({
    sections: [{ label: 'Issues', issues: [
      { id: 'i1', key: 'TF-1', keyHtml: 'TF-1', summary: 'First', issueType: 'Task', status: 'To Do' },
      { id: 'i2', key: 'TF-2', keyHtml: 'TF-2', summary: 'Second', issueType: 'Bug', status: 'Done' },
    ] }],
  })),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapPage = () => render(
  <QueryClientProvider client={qc()}>
    <MemoryRouter initialEntries={['/projects/TF/automation']}>
      <Routes><Route path="/projects/:projectKey/automation" element={<AutomationPage />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>
);
const wrap = (el: ReactElement) =>
  render(<QueryClientProvider client={qc()}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);

beforeEach(() => vi.clearAllMocks());

describe('AutomationPage (034/W6)', () => {
  it('lists rules with trigger → action summary, actor, version', async () => {
    wrapPage();
    await screen.findByText('Triage flagger');
    expect(screen.getByText(/issue_created → add_labels, comment/)).toBeTruthy();
    expect(screen.getByText(/as Admin/)).toBeTruthy();
    expect(screen.getByText(/v3/)).toBeTruthy();
  });

  it('toggle switch calls toggleAutomationRule(id, enabled)', async () => {
    wrapPage();
    await screen.findByText('Triage flagger');
    await userEvent.click(screen.getByTitle('Enabled'));
    await waitFor(() => expect(mocks.toggleAutomationRule).toHaveBeenCalledWith('r1', false));
  });

  it('audit log expands to step-level entries', async () => {
    wrapPage();
    await screen.findByText('Triage flagger');
    await userEvent.click(screen.getByText('Audit log'));
    await screen.findByText('success');
    await userEvent.click(screen.getByText('success'));
    await screen.findByText(/issue_created event 42/);
    expect(screen.getByText(/"issueKey":"TF-1"/)).toBeTruthy();
  });

  it('create rule opens the editor and save calls createAutomationRule', async () => {
    wrapPage();
    await screen.findByText('Triage flagger');
    await userEvent.click(screen.getByText('Create rule'));
    // name field is the first textbox; the JSON textareas follow
    const inputs = screen.getAllByRole('textbox');
    await userEvent.type(inputs[0], 'My new rule');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mocks.validateAutomationRule).toHaveBeenCalled());
    await waitFor(() => expect(mocks.createAutomationRule).toHaveBeenCalled());
    const body = mocks.createAutomationRule.mock.calls[0][0] as { name: string; scope: string; projectKey: string };
    expect(body.name).toBe('My new rule');
    expect(body.scope).toBe('project');
    expect(body.projectKey).toBe('TF');
  });

  it('shows validation errors instead of saving', async () => {
    mocks.validateAutomationRule.mockResolvedValueOnce({ valid: false, errors: ['trigger: unknown type'] });
    wrapPage();
    await screen.findByText('Triage flagger');
    await userEvent.click(screen.getByText('Create rule'));
    const inputs = screen.getAllByRole('textbox');
    await userEvent.type(inputs[0], 'Bad rule');
    await userEvent.click(screen.getByText('Save'));
    await screen.findByText(/trigger: unknown type/);
    expect(mocks.createAutomationRule).not.toHaveBeenCalled();
  });
});

describe('IssuePicker (033/W6)', () => {
  function Harness({ onSelect }: { onSelect: (i: unknown) => void }) {
    const [v, setV] = useState('');
    return <IssuePicker value={v} onChange={setV} onSelect={onSelect} placeholder="Pick issue" />;
  }
  it('debounces, lists results, onSelect fires with the picked issue', async () => {
    const onSelect = vi.fn();
    wrap(<Harness onSelect={onSelect} />);
    await userEvent.click(screen.getByPlaceholderText('Pick issue'));
    await userEvent.type(screen.getByPlaceholderText('Pick issue'), 'TF');
    await screen.findByText('TF-1', {}, { timeout: 2000 }); // 300ms debounce
    await userEvent.click(screen.getByText('TF-1'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'TF-1' }));
  });
});
