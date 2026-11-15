import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { Issue } from '../../src/api/client.js';

// --- mock the API client (hovercard lazy fetch + pickers pulled in transitively) ---
const mocks = vi.hoisted(() => ({
  fetchIssue: vi.fn(),
  fetchUserProfile: vi.fn(),
  fetchMyself: vi.fn(async () => ({ accountId: 'me-1', displayName: 'Me User', emailAddress: 'me@x' })),
  fetchMyPermissions: vi.fn(async () => ({ permissions: {} })),
  searchAssignableUsers: vi.fn(async () => []),
  assignIssue: vi.fn(async () => ({})),
  fetchTransitions: vi.fn(async () => ({ transitions: [] })),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

import OverflowText from '../../src/components/OverflowText.js';
import IssueTable from '../../src/components/IssueTable.js';
import { IssueKeyLink } from '../../src/components/IssueKey.js';
import UserHoverCard from '../../src/components/UserHoverCard.js';

// jsdom has no ResizeObserver — OverflowText no-ops without it, so stub a
// capturable one and drive `check()` manually after faking element metrics.
let roCallback: ResizeObserverCallback | null = null;
class MockResizeObserver implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (el: ReactElement) =>
  render(<QueryClientProvider client={qc()}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);

const mkIssue = (over: Partial<Issue['fields']> = {}): Issue =>
  ({
    id: 'i-1',
    key: 'TF-1',
    self: '',
    fields: {
      summary: 'Fetched summary text',
      issuetype: { id: 't1', name: 'Bug', iconUrl: '', subtask: false },
      status: { id: 's1', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
      priority: { id: 'p1', name: 'High' },
      project: { key: 'TF', name: 'TrackForge' },
      reporter: { accountId: 'r1', displayName: 'Integración DUNA JIRA' },
      assignee: { accountId: 'a1', displayName: 'Ana Agent' },
      updated: '2026-01-02T00:00:00Z',
      created: '2026-01-01T00:00:00Z',
      labels: [],
      ...over,
    },
  }) as unknown as Issue;

const setMetrics = (el: Element, { scrollW = 0, clientW = 0, scrollH = 0, clientH = 0 }) => {
  Object.defineProperties(el, {
    scrollWidth: { configurable: true, value: scrollW },
    clientWidth: { configurable: true, value: clientW },
    scrollHeight: { configurable: true, value: scrollH },
    clientHeight: { configurable: true, value: clientH },
  });
};

describe('OverflowText', () => {
  beforeEach(() => {
    roCallback = null;
  });

  it('no title when the text fits (jsdom metrics are 0/0)', () => {
    const { container } = wrap(<OverflowText text="short" className="truncate" />);
    expect(container.firstElementChild?.getAttribute('title')).toBeNull();
  });

  it('sets title to the text when horizontally clipped', () => {
    const { container } = wrap(<OverflowText text="a very long reporter name" className="truncate" />);
    const el = container.firstElementChild!;
    setMetrics(el, { scrollW: 300, clientW: 120 });
    act(() => roCallback?.([], {} as ResizeObserver));
    expect(el.getAttribute('title')).toBe('a very long reporter name');
  });

  it('prefers the explicit title prop when clipped', () => {
    const { container } = wrap(<OverflowText text="sum" title="custom tip" className="truncate" />);
    const el = container.firstElementChild!;
    setMetrics(el, { scrollW: 300, clientW: 120 });
    act(() => roCallback?.([], {} as ResizeObserver));
    expect(el.getAttribute('title')).toBe('custom tip');
  });

  it('detects vertical clipping (line-clamp) via scrollHeight', () => {
    const { container } = wrap(<OverflowText as="p" text="multi line" className="line-clamp-3" />);
    const el = container.firstElementChild!;
    setMetrics(el, { scrollH: 90, clientH: 48 });
    act(() => roCallback?.([], {} as ResizeObserver));
    expect(el.getAttribute('title')).toBe('multi line');
  });

  it('drops the title when the element stops being clipped (resize)', () => {
    const { container } = wrap(<OverflowText text="text" className="truncate" />);
    const el = container.firstElementChild!;
    setMetrics(el, { scrollW: 300, clientW: 120 });
    act(() => roCallback?.([], {} as ResizeObserver));
    expect(el.getAttribute('title')).toBe('text');
    setMetrics(el, { scrollW: 120, clientW: 120 });
    act(() => roCallback?.([], {} as ResizeObserver));
    expect(el.getAttribute('title')).toBeNull();
  });
});

describe('IssueTable reporter cell (regression: name painting over Updated)', () => {
  it('td clips + inner flex is shrinkable; name renders through truncate', () => {
    const { container } = wrap(<IssueTable issues={[mkIssue()]} columns={['reporter']} />);
    const td = container.querySelector('td')!;
    expect(td.className).toContain('overflow-hidden');
    const flex = td.querySelector('span.flex')!;
    expect(flex.className).toContain('min-w-0');
    expect(flex.querySelector('.truncate')?.textContent).toBe('Integración DUNA JIRA');
  });

  it('td title falls back to the full name when the ref has no accountId', () => {
    const issue = mkIssue({
      reporter: { displayName: 'Integración DUNA JIRA' } as Issue['fields']['reporter'],
    });
    const { container } = wrap(<IssueTable issues={[issue]} columns={['reporter']} />);
    expect(container.querySelector('td')!.getAttribute('title')).toBe('Integración DUNA JIRA');
  });

  it('td title is suppressed when the person card owns the reveal', () => {
    const { container } = wrap(<IssueTable issues={[mkIssue()]} columns={['reporter']} />);
    expect(container.querySelector('td')!.getAttribute('title')).toBeNull();
  });
});

describe('IssueKeyLink hovercard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchIssue.mockResolvedValue(mkIssue());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const hover = (key: string) => fireEvent.mouseEnter(screen.getByText(key));

  it('opens on hover intent with the provided issue (no fetch)', async () => {
    wrap(<IssueKeyLink issueKey="TF-1" issue={mkIssue()} />);
    hover('TF-1');
    await act(async () => vi.advanceTimersByTime(400));
    expect(screen.getByText('Fetched summary text')).toBeTruthy();
    expect(screen.getByText('Ana Agent')).toBeTruthy();
    expect(mocks.fetchIssue).not.toHaveBeenCalled();
  });

  it('does not open on pointer pass-through (leave before the delay)', async () => {
    wrap(<IssueKeyLink issueKey="TF-1" issue={mkIssue()} />);
    hover('TF-1');
    await act(async () => vi.advanceTimersByTime(100));
    fireEvent.mouseLeave(screen.getByText('TF-1'));
    await act(async () => vi.advanceTimersByTime(400));
    expect(screen.queryByText('Fetched summary text')).toBeNull();
  });

  it('opens on keyboard focus and closes on Escape', async () => {
    wrap(<IssueKeyLink issueKey="TF-1" issue={mkIssue()} />);
    fireEvent.focusIn(screen.getByRole('link'));
    await act(async () => vi.advanceTimersByTime(400));
    expect(screen.getByText('Fetched summary text')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Fetched summary text')).toBeNull();
  });

  it('lazy-fetches when the caller has no issue object', async () => {
    wrap(<IssueKeyLink issueKey="TF-9" />);
    hover('TF-9');
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(mocks.fetchIssue).toHaveBeenCalledWith('TF-9');
    // vi.waitFor advances fake timers while polling — findBy* would hang.
    await vi.waitFor(() => expect(screen.getByText('Fetched summary text')).toBeTruthy());
  });

  it('preview={false} renders a plain link with no card', async () => {
    wrap(<IssueKeyLink issueKey="TF-1" issue={mkIssue()} preview={false} />);
    hover('TF-1');
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.queryByText('Fetched summary text')).toBeNull();
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('anchor wrapper is shrink-0 — a squeezed key must not paint over the summary', () => {
    wrap(<IssueKeyLink issueKey="TF-1" issue={mkIssue()} />);
    // Regression: key text colliding with summary in the grouped search list —
    // the anchor is atomic so flex rows can only ever squeeze the summary.
    const anchor = screen.getByRole('link').parentElement!;
    expect(anchor.className).toContain('shrink-0');
    expect(screen.getByRole('link').className).toContain('truncate');
  });
});

describe('UserHoverCard (person card)', () => {
  const profile = {
    user: {
      accountId: 'r1',
      displayName: 'Integración DUNA JIRA',
      emailAddress: 'duna@trackforge.local',
      timezone: 'Europe/Madrid',
    },
    openIssuesByProject: [
      { project: { key: 'TF', name: 'TrackForge' }, issues: [
        { key: 'TF-1', summary: 'a', status: 'To Do', statusCategory: 'new', type: 'Bug', priority: null },
        { key: 'TF-2', summary: 'b', status: 'To Do', statusCategory: 'new', type: 'Bug', priority: null },
      ] },
    ],
    recentComments: [],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchUserProfile.mockResolvedValue(profile);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('lazy-fetches the profile on open and renders it', async () => {
    wrap(
      <UserHoverCard user={{ accountId: 'r1', displayName: 'Integración DUNA JIRA' }}>
        <button>reporter</button>
      </UserHoverCard>,
    );
    fireEvent.mouseEnter(screen.getByText('reporter'));
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(mocks.fetchUserProfile).toHaveBeenCalledWith('r1');
    await vi.waitFor(() => expect(screen.getByText('duna@trackforge.local')).toBeTruthy());
    expect(screen.getByText(/2 open issues/)).toBeTruthy();
    // The card is aria-hidden (supplemental), so getByRole can't reach the
    // link — assert via text + closest('a').
    const link = screen.getByText(/View profile/).closest('a')!;
    expect(link.getAttribute('href')).toBe('/profile/r1');
  });

  it('renders the ref immediately and does not fetch without accountId', async () => {
    wrap(<UserHoverCard displayName="Ghost User"><span>who</span></UserHoverCard>);
    fireEvent.mouseEnter(screen.getByText('who'));
    await act(async () => vi.advanceTimersByTime(400));
    expect(screen.getByText('Ghost User')).toBeTruthy();
    expect(mocks.fetchUserProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /View profile/ })).toBeNull();
  });

  it('closes on Escape', async () => {
    wrap(
      <UserHoverCard user={{ accountId: 'r1', displayName: 'Integración DUNA JIRA' }}>
        <button>reporter</button>
      </UserHoverCard>,
    );
    fireEvent.focusIn(screen.getByText('reporter'));
    await act(async () => vi.advanceTimersByTime(400));
    // The ref renders inside the card immediately (fetch resolves later).
    await vi.waitFor(() => expect(screen.getByText('Integración DUNA JIRA')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Integración DUNA JIRA')).toBeNull();
  });
});
