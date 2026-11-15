// 068 — CopilotDock contract: markdown answers, multi-turn context, clarify
// options, apply-bound execution, persisted thread reload.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { CopilotStep } from '../../src/api/client.js';

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => ({ accountId: 'u1', displayName: 'Test User', emailAddress: 't@t', isAdmin: false })),
  planCopilot: vi.fn(),
  executeCopilot: vi.fn(),
  fetchCopilotThreads: vi.fn(async () => ({ threads: [] })),
  fetchCopilotThread: vi.fn(async (id: string) => ({
    thread: { id, title: null, createdAt: '', updatedAt: '', turns: [] },
  })),
  deleteCopilotThread: vi.fn(async () => undefined),
  postAiOutcome: vi.fn(),
  fetchAiCapabilities: vi.fn(async () => ({ configured: true, embeddings: false, speech: false })),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...((await orig()) as object), ...mocks }));

import CopilotDock from '../../src/components/CopilotDock.js';

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (el: ReactElement, route = '/') =>
  render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter initialEntries={[route]}>{el}</MemoryRouter>
    </QueryClientProvider>
  );

const writeStep: CopilotStep = {
  tool: 'transition_issue',
  kind: 'write',
  title: 'Transition TF-1',
  args: { key: 'TF-1', transition: '21' },
  previewable: true,
  preview: { raw: true },
  display: { text: 'Change TF-1 status: To Do → In Progress' },
};

async function ask(text: string) {
  const ta = screen.getByLabelText(/message copilot/i);
  await userEvent.type(ta, `${text}{Enter}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('CopilotDock (068 workbench)', () => {
  it('renders a markdown answer for a data question', async () => {
    mocks.planCopilot.mockResolvedValue({
      threadId: 't1',
      turnId: 'u1',
      answer: 'You have **3** open issues.',
      steps: [],
    });
    wrap(<CopilotDock onClose={() => {}} />);
    await ask('how many open issues?');
    const answer = await screen.findByTestId('copilot-answer');
    expect(answer.querySelector('strong')?.textContent).toBe('3');
  });

  it('keeps turns stacked and sends threadId on the follow-up', async () => {
    mocks.planCopilot
      .mockResolvedValueOnce({ threadId: 't1', turnId: 'u1', answer: 'first', steps: [] })
      .mockResolvedValueOnce({ threadId: 't1', turnId: 'u2', answer: 'second', steps: [] });
    wrap(<CopilotDock onClose={() => {}} />);
    await ask('turn one');
    await screen.findByText('first');
    await ask('and those?');
    await screen.findByText('second');
    expect(mocks.planCopilot).toHaveBeenLastCalledWith('and those?', expect.anything(), 't1');
    // Both turns stay on screen — follow-ups never wipe prior results.
    expect(screen.getByText('first')).toBeTruthy();
  });

  it('clarify renders clickable options that resubmit as a turn', async () => {
    mocks.planCopilot
      .mockResolvedValueOnce({
        threadId: 't1',
        turnId: 'u1',
        clarify: { question: 'Which project?', options: ['TF', 'OPS'] },
      })
      .mockResolvedValueOnce({ threadId: 't1', turnId: 'u2', answer: 'TF it is', steps: [] });
    wrap(<CopilotDock onClose={() => {}} />);
    await ask('close it');
    await userEvent.click(await screen.findByRole('button', { name: 'TF' }));
    await waitFor(() => expect(mocks.planCopilot).toHaveBeenLastCalledWith('close it — TF', expect.anything(), 't1'));
  });

  it('Apply sends planId + checked writes + turnId, results render inline', async () => {
    mocks.planCopilot.mockResolvedValue({
      threadId: 't1',
      turnId: 'u1',
      planId: 'p-1',
      steps: [writeStep],
    });
    mocks.executeCopilot.mockResolvedValue({
      results: [{ index: 0, tool: 'transition_issue', ok: true, status: 204, display: { text: 'TF-1 → In Progress' } }],
    });
    wrap(<CopilotDock onClose={() => {}} />);
    await ask('move TF-1 along');
    await userEvent.click(await screen.findByRole('button', { name: /Apply 1 change/ }));
    await waitFor(() => expect(mocks.executeCopilot).toHaveBeenCalledWith('p-1', [writeStep], 'u1'));
    expect(await screen.findByText('done')).toBeTruthy();
  });

  it('restores a persisted thread with its answers + outcomes', async () => {
    localStorage.setItem('tf.copilot.threadId', 't9');
    mocks.fetchCopilotThread.mockResolvedValue({
      thread: {
        id: 't9',
        title: 'old work',
        createdAt: '',
        updatedAt: '',
        turns: [
          { id: 'u1', index: 1, instruction: 'how many?', answer: '**7**', outcome: 'answered', createdAt: '' },
          {
            id: 'u2',
            index: 2,
            instruction: 'assign them',
            outcome: 'applied',
            createdAt: '',
            writesApplied: [{ tool: 'assign_issue', target: 'TF-4', status: 'done' }],
          },
        ],
      },
    });
    wrap(<CopilotDock onClose={() => {}} />);
    expect(await screen.findByText('how many?')).toBeTruthy();
    const answer = await screen.findByTestId('copilot-answer');
    expect(answer.querySelector('strong')?.textContent).toBe('7');
    expect(await screen.findByText(/assign_issue TF-4/)).toBeTruthy();
  });

  it('shows the mic only when the speech capability is on', async () => {
    mocks.fetchAiCapabilities.mockResolvedValue({ configured: true, embeddings: false, speech: true });
    wrap(<CopilotDock onClose={() => {}} />);
    expect(await screen.findByTestId('copilot-mic')).toBeTruthy();
  });

  it('renders no mic button when no speech model is configured', async () => {
    mocks.fetchAiCapabilities.mockResolvedValue({ configured: true, embeddings: false, speech: false });
    wrap(<CopilotDock onClose={() => {}} />);
    await waitFor(() => expect(mocks.fetchAiCapabilities).toHaveBeenCalled());
    expect(screen.queryByTestId('copilot-mic')).toBeNull();
  });
});
