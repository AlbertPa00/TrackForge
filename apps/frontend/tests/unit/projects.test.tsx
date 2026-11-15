import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ProjectsPage from '../../src/pages/ProjectsPage';

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Alice', emailAddress: 'a@t', active: true, isAdmin: true })),
  fetchProjects: vi.fn(async () => [
    { id: 'p1', key: 'PLAT', name: 'Platform', projectTypeKey: 'software', archived: false, projectCategory: { id: 'c1', name: 'Core' } },
    { id: 'p2', key: 'MKT', name: 'Marketing', projectTypeKey: 'software', archived: false },
  ]),
  fetchProjectCategories: vi.fn(async () => [
    { id: 'c1', name: 'Core' },
    { id: 'c2', name: 'Growth' },
  ]),
  fetchPreferences: vi.fn(async () => ({ 'projects.favorites': [] as string[] })),
  putPreference: vi.fn(async () => {}),
}));

vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ProjectsPage category filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters projects by selected category', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Platform')).toBeTruthy());
    expect(screen.getByText('Marketing')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Filter by category'), 'c1');
    await waitFor(() => expect(screen.queryByText('Marketing')).toBeNull());
    expect(screen.getByText('Platform')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Filter by category'), '');
    await waitFor(() => expect(screen.getByText('Marketing')).toBeTruthy());
  });
});

describe('ProjectsPage favorites + row menu (UB-012)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('star toggles persist via user preference', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('Star Platform')).toBeTruthy());
    await userEvent.click(screen.getByLabelText('Star Platform'));
    await waitFor(() =>
      expect(mocks.putPreference).toHaveBeenCalledWith('projects.favorites', ['PLAT'])
    );
  });

  it('starred project sorts first; ⋯ menu links to settings', async () => {
    mocks.fetchPreferences.mockResolvedValueOnce({ 'projects.favorites': ['MKT'] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Marketing')).toBeTruthy());
    const rows = screen.getAllByRole('row');
    // rows[0] is the header — first data row should be Marketing.
    expect(rows[1].textContent).toContain('Marketing');
    await userEvent.click(screen.getByLabelText('Actions for Marketing'));
    expect(screen.getByText('Project settings')).toBeTruthy();
  });
});
