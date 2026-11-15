import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import RoadmapPage from '../../src/pages/RoadmapPage';

const ROADMAP = {
  board: { id: 'b1', name: 'RM board', type: 'scrum', projectKey: 'RM' },
  range: { start: '2026-03-01', end: '2026-08-01' },
  epics: [
    {
      key: 'RM-1', summary: 'Epic one', type: 'Epic', isSubtask: false,
      status: { name: 'To Do', category: 'todo' }, assignee: 'Ada Lovelace', parent: null,
      start: '2026-03-01', due: '2026-06-01',
      progress: { done: 1, total: 2, pct: 50 },
      links: [{ typeId: 'lt1', type: 'blocks', direction: 'outward', key: 'RM-2' }],
    },
    {
      key: 'RM-2', summary: 'Epic two', type: 'Epic', isSubtask: false,
      status: { name: 'To Do', category: 'todo' }, assignee: null, parent: null,
      start: '2026-05-15', due: '2026-08-01',
      progress: { done: 0, total: 1, pct: 0 },
      links: [],
    },
  ],
  issues: [
    {
      key: 'RM-1', summary: 'Epic one', type: 'Epic', isSubtask: false,
      status: { name: 'To Do', category: 'todo' }, assignee: null, parent: null,
      start: '2026-03-01', due: '2026-06-01', progress: { done: 1, total: 2, pct: 50 },
      links: [{ typeId: 'lt1', type: 'blocks', direction: 'outward', key: 'RM-3' }],
    },
    {
      key: 'RM-3', summary: 'Story child', type: 'Story', isSubtask: false,
      status: { name: 'Done', category: 'done' }, assignee: 'Ada', parent: 'RM-1',
      start: '2026-03-05', due: '2026-04-01', progress: { done: 1, total: 1, pct: 100 },
      links: [],
    },
  ],
  versions: [{ name: 'v1.0', releaseDate: '2026-07-01', released: false }],
};

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Test User', emailAddress: 't@t', isAdmin: false })),
  fetchMyPermissions: vi.fn(async () => ({ permissions: {} })),
  fetchRoadmap: vi.fn(async (_b: string, opts?: { level?: string }) => ({
    ...ROADMAP,
    epics: opts?.level === 'issues' ? undefined : ROADMAP.epics,
    issues: opts?.level === 'issues' ? ROADMAP.issues : undefined,
  })),
  fetchBoards: vi.fn(async () => [{ id: 'b1', name: 'RM board', type: 'scrum' }]),
  updateIssueFields: vi.fn(async () => ({})),
  linkIssues: vi.fn(async () => undefined),
}));

vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

const renderPage = (url = '/projects/RM/roadmap') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/projects/:projectKey/roadmap" element={<RoadmapPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('041 RoadmapPage', () => {
  it('renders epic rows with keys, summaries and progress', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Epic one').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Epic two').length).toBeGreaterThan(0);
    expect(screen.getByText('RM-1')).toBeTruthy();
    expect(screen.getAllByText('1/2').length).toBeGreaterThan(0);
    expect(mocks.fetchRoadmap).toHaveBeenCalledWith('RM', { level: 'epics' });
  });

  it('level=issues switches to the Gantt feed', async () => {
    renderPage('/projects/RM/roadmap?level=issues');
    await waitFor(() => expect(mocks.fetchRoadmap).toHaveBeenCalledWith('RM', { level: 'issues' }));
    await waitFor(() => expect(screen.getAllByText('Story child').length).toBeGreaterThan(0));
    expect(screen.getByText('Critical path')).toBeTruthy();
  });

  it('shows the empty state with no scheduled work', async () => {
    mocks.fetchRoadmap.mockResolvedValueOnce({ ...ROADMAP, epics: [], issues: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No scheduled work/)).toBeTruthy());
  });
});
