// 067 — resolution insight: the card + Apply through the real transition
// path (screen preselection, accepted vs edited outcomes, thin-evidence state).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Issue, ResolutionInsight, Transition } from '../../src/api/client.js';

const mocks = vi.hoisted(() => ({
  fetchSimilarIssues: vi.fn(async () => ({ issues: [] })),
  aiSuggestResolution: vi.fn(),
  fetchTransitions: vi.fn(),
  executeTransition: vi.fn(async () => undefined),
  fetchResolutions: vi.fn(async () => [
    { id: 'r1', name: 'Done', description: '' },
    { id: 'r2', name: "Won't Do", description: '' },
  ]),
  postAiOutcome: vi.fn(),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

import { AiPanel } from '../../src/components/IssueDetailView.js';

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (el: ReactElement) =>
  render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>
  );

const issue = {
  key: 'TF-1',
  fields: {
    summary: 'csv export wizard dies on delimiter',
    description: '',
    issuetype: { name: 'Task' },
    status: { name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
    resolution: null,
    project: { key: 'TF' },
  },
} as unknown as Issue;

const insight: ResolutionInsight = {
  resolution: { id: 'r2', name: "Won't Do" },
  confidence: 'medium',
  diagnosis: 'Delimiter parser encoding bug.',
  basedOn: [{ key: 'TF-9', summary: 'earlier twin', resolution: "Won't Do", score: 0.9 }],
  reason: null,
};

const doneStatus = { id: 's2', name: 'Done', statusCategory: { key: 'done', name: 'Done' } };
const screenedDone: Transition = {
  id: 't-done',
  name: 'Resolve',
  hasScreen: true,
  fields: { resolution: { required: true, name: 'Resolution', schema: { type: 'resolution' }, operations: ['set'] } },
  to: doneStatus,
};
const plainDone: Transition = { id: 't-done', name: 'Done', hasScreen: false, to: doneStatus };

async function openCard() {
  mocks.aiSuggestResolution.mockResolvedValue(insight);
  wrap(<AiPanel issue={issue} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Suggest resolution' }));
  expect(await screen.findByText("Won't Do")).toBeTruthy();
}

beforeEach(() => vi.clearAllMocks());

describe('067 — resolution insight card', () => {
  it('renders suggestion, confidence, diagnosis and evidence chips', async () => {
    await openCard();
    expect(screen.getByText('medium confidence')).toBeTruthy();
    expect(screen.getByText('Delimiter parser encoding bug.')).toBeTruthy();
    const chip = screen.getByRole('link', { name: /TF-9/ });
    expect(chip.getAttribute('href')).toBe('/browse/TF-9');
    expect(mocks.aiSuggestResolution).toHaveBeenCalledWith('TF-1');
  });

  it('SC-006: screened transition opens the modal preselected; changing resolution posts edited', async () => {
    mocks.fetchTransitions.mockResolvedValue([screenedDone]);
    await openCard();
    await userEvent.click(screen.getByRole('button', { name: "Apply Won't Do" }));
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(select.value).toBe("Won't Do"); // suggestion preselected, user can change it
    await userEvent.selectOptions(select, 'Done');
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(mocks.executeTransition).toHaveBeenCalledWith('TF-1', 't-done', {
        fields: { resolution: { name: 'Done' } },
        comment: undefined,
      })
    );
    expect(mocks.postAiOutcome).toHaveBeenCalledWith('resolution', 'edited');
    expect(await screen.findByText('Issue resolved as Done from an AI suggestion.')).toBeTruthy();
  });

  it('unscreened transition applies the suggestion directly and posts accepted', async () => {
    mocks.fetchTransitions.mockResolvedValue([plainDone]);
    await openCard();
    await userEvent.click(screen.getByRole('button', { name: "Apply Won't Do" }));
    await waitFor(() =>
      expect(mocks.executeTransition).toHaveBeenCalledWith('TF-1', 't-done', {
        fields: { resolution: { name: "Won't Do" } },
      })
    );
    expect(mocks.postAiOutcome).toHaveBeenCalledWith('resolution', 'accepted');
    expect(await screen.findByText("Issue resolved as Won't Do from an AI suggestion.")).toBeTruthy();
  });

  it('no done-category transition → hint row instead of Apply', async () => {
    mocks.fetchTransitions.mockResolvedValue([
      { id: 't1', name: 'Start Progress', to: { id: 's1', name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } } },
    ]);
    await openCard();
    await userEvent.click(screen.getByRole('button', { name: "Apply Won't Do" }));
    expect(await screen.findByText('No resolving transition from To Do.')).toBeTruthy();
    expect(mocks.executeTransition).not.toHaveBeenCalled();
  });

  it('resolution:null renders the honest thin-evidence line', async () => {
    mocks.aiSuggestResolution.mockResolvedValue({
      resolution: null, confidence: null, diagnosis: null, basedOn: [], reason: 'insufficient_evidence',
    });
    wrap(<AiPanel issue={issue} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest resolution' }));
    expect(await screen.findByText(/Not enough resolved similar issues/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
    expect(mocks.postAiOutcome).not.toHaveBeenCalled();
  });

  it('Dismiss posts a discarded outcome', async () => {
    await openCard();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(mocks.postAiOutcome).toHaveBeenCalledWith('resolution', 'discarded');
  });
});
