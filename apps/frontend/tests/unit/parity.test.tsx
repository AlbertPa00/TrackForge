import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import TopNav from '../../src/components/TopNav';
import IssueSearchView from '../../src/components/IssueSearchView';
import IssueTable, { DEFAULT_COLUMNS } from '../../src/components/IssueTable';
import EmptyState from '../../src/components/EmptyState';
import { initI18n } from '../../src/i18n.js';

/**
 * 042 SC-004 — DOM parity guards for the deterministic audit items:
 * nav item order, default column set/order, basic-filter chip order,
 * empty-state copy convention. No screenshot diffing.
 */
const ISSUE = {
  id: 'i1',
  key: 'TF-1',
  fields: {
    summary: 'Sample issue',
    issuetype: { id: 't1', name: 'Task', subtask: false },
    status: { id: 's1', name: 'To Do', statusCategory: { key: 'new' } },
    priority: { id: 'p1', name: 'High' },
    assignee: null,
    reporter: { accountId: 'u1', displayName: 'Alice' },
    project: { id: 'pr1', key: 'TF', name: 'TrackForge' },
    created: '2026-11-01T10:00:00Z',
    updated: '2026-11-02T10:00:00Z',
    duedate: null,
    resolution: null,
    labels: [],
  },
};

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Alice', emailAddress: 'a@t', isAdmin: false, active: true })),
  fetchFavouriteFilters: vi.fn(async () => []),
  fetchMyFilters: vi.fn(async () => []),
  fetchNotifications: vi.fn(async () => ({ notifications: [], total: 0 })),
  fetchProposals: vi.fn(async () => ({ proposals: [] })),
  fetchDashboards: vi.fn(async () => []),
  searchIssues: vi.fn(async () => ({ issues: [], total: 0, startAt: 0, maxResults: 50 })),
  fetchStatuses: vi.fn(async () => [{ id: 's1', name: 'To Do' }]),
  fetchPriorities: vi.fn(async () => [{ id: 'p1', name: 'High' }]),
  fetchIssueTypes: vi.fn(async () => [{ id: 't1', name: 'Task', subtask: false }]),
  fetchProjects: vi.fn(async () => [{ id: 'pr1', key: 'TF', name: 'TrackForge' }]),
  fetchPreferences: vi.fn(async () => ({})),
  putPreference: vi.fn(async () => ({})),
  searchAssignableUsers: vi.fn(async () => []),
  parseJqlQueries: vi.fn(async () => [{ errors: [] }]),
  fetchResolutions: vi.fn(async () => [{ id: 'r1', name: 'Done' }]),
  fetchLabels: vi.fn(async () => []),
  fetchFilter: vi.fn(async () => null),
}));

vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

function wrap(el: ReactElement, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>{el}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('042 DOM parity guards', () => {
  beforeEach(() => { initI18n('en'); vi.clearAllMocks(); });

  it('TopNav order matches Jira: Projects · Filters · Dashboards (logo = Your work)', () => {
    wrap(<TopNav />);
    const nav = document.querySelector('nav')!;
    const labels = [...nav.querySelectorAll('a,button')].map((e) => e.textContent?.trim());
    // Audited divergence: the TrackForge logo doubles as Jira's "Your work"
    // link, and Approvals is contextual (issue panel / Your work banner), not
    // a permanent primary-nav item.
    expect(labels.slice(0, 3)).toEqual(['Projects', 'Filters', 'Dashboards']);
    expect(labels).not.toContain('Approvals');
  });

  it('default column order: T·Key·Summary·Status·Assignee·Due·P·Reporter·Updated', () => {
    expect(DEFAULT_COLUMNS).toEqual([
      'issuetype', 'key', 'summary', 'status', 'assignee', 'duedate',
      'priority', 'reporter', 'updated',
    ]);
  });

  it('basic filter chips ordered Type → Status → Assignee → Priority', async () => {
    wrap(<IssueSearchView />, '/issues');
    await waitFor(() => expect(screen.getByLabelText('Filter by issue type')).toBeTruthy());
    const labels = [
      'Filter by issue type',
      'Filter by status',
      'Filter by assignee',
      'Filter by priority',
    ].map((l) => screen.getByLabelText(l));
    // each select follows the previous in document order (DOCUMENT_POSITION_FOLLOWING = 4)
    const ordered = labels.every((el, i) => i === 0 || (labels[i - 1].compareDocumentPosition(el) & 4) !== 0);
    expect(ordered).toBeTruthy();
  });

  it('"More" catch-all exposes Resolution and Labels criteria', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    wrap(<IssueSearchView />, '/issues');
    await waitFor(() => expect(screen.getByLabelText('Filter by issue type')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /^More/ }));
    expect(screen.getByRole('button', { name: 'Resolution' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Labels' })).toBeTruthy();
  });

  it('priority cell is icon-only (icon keeps an accessible name)', () => {
    wrap(<IssueTable issues={[ISSUE as never]} />);
    const icon = screen.getByRole('img', { name: 'High' });
    const cell = icon.closest('td')!;
    expect(cell.textContent?.trim()).toBe('');
  });

  it('resolution renders — when unset (never literal "Unresolved")', () => {
    wrap(<IssueTable issues={[ISSUE as never]} columns={['key', 'resolution']} />);
    const cells = [...document.querySelectorAll('td')].map((c) => c.textContent?.trim());
    expect(cells).toContain('—');
    expect(cells).not.toContain('Unresolved');
  });

  it('EmptyState keeps the Jira copy convention: title + helper + optional action', () => {
    const { container } = wrap(
      <EmptyState
        title="No issues found"
        description="Try changing your search criteria."
        action={<button>Create issue</button>}
      />
    );
    expect(screen.getByText('No issues found')).toBeTruthy();
    expect(screen.getByText('Try changing your search criteria.')).toBeTruthy();
    expect(container.querySelector('button')).toBeTruthy();
  });
});
