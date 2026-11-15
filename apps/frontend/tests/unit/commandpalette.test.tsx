// 068 — palette re-scope contract: deterministic commands + issue-key jumps +
// an explicit "Ask Copilot" handoff. Copilot rendering lives in CopilotDock.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Test User', emailAddress: 't@t', isAdmin: false })),
  openCopilot: vi.fn(),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...((await orig()) as object), fetchMyself: mocks.fetchMyself }));
vi.mock('../../src/lib/copilotBus.js', () => ({
  COPILOT_OPEN_EVENT: 'tf:open-copilot',
  openCopilot: mocks.openCopilot,
}));

import CommandPalette from '../../src/components/CommandPalette.js';

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (el: ReactElement, route = '/') =>
  render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter initialEntries={[route]}>{el}</MemoryRouter>
    </QueryClientProvider>
  );

async function typeIntoPalette(text: string, route = '/') {
  wrap(<CommandPalette open onClose={() => {}} />, route);
  const input = screen.getByRole('combobox');
  await userEvent.type(input, `${text}{Enter}`);
}

beforeEach(() => vi.clearAllMocks());

describe('CommandPalette (068 deterministic launcher)', () => {
  it('offers deterministic commands for short imperatives', async () => {
    wrap(<CommandPalette open onClose={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'backlog');
    expect(await screen.findByRole('option', { name: /Go to Backlog/i })).toBeTruthy();
  });

  it('pins "Ask Copilot" first for copilot-intent input — Enter asks, never navigates away', async () => {
    await typeIntoPalette('list sprints');
    await waitFor(() => expect(mocks.openCopilot).toHaveBeenCalledWith('list sprints'));
  });

  it('keeps commands first but offers "Ask Copilot" for command-intent input', async () => {
    wrap(<CommandPalette open onClose={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'watch');
    expect(await screen.findByRole('option', { name: /Ask Copilot/i })).toBeTruthy();
  });

  it('routes an explicit ai: prefix to the copilot without the prefix', async () => {
    await typeIntoPalette('ai: who is unassigned');
    await waitFor(() => expect(mocks.openCopilot).toHaveBeenCalledWith('who is unassigned'));
  });

  it('clicking the Ask row hands off the typed text', async () => {
    wrap(<CommandPalette open onClose={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'summarize open bugs');
    await userEvent.click(await screen.findByRole('option', { name: /Ask Copilot/i }));
    expect(mocks.openCopilot).toHaveBeenCalledWith('summarize open bugs');
  });

  it('bare issue key offers Open issue instead of a copilot handoff', async () => {
    wrap(<CommandPalette open onClose={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'TF-123');
    expect(await screen.findByText('Open issue')).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Ask Copilot/i })).toBeNull();
  });
});
