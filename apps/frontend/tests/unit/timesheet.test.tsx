import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  fetchMyTimesheet: vi.fn(),
  fetchIssue: vi.fn(),
  fetchUserProfile: vi.fn(),
}));
vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

import TimeLoggedCard, { MyMonthLogStrip } from '../../src/components/TimeLoggedCard.js';
import { formatSeconds } from '../../src/lib/format.js';

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (el: ReactElement) =>
  render(<QueryClientProvider client={qc()}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>);

const now = new Date();
const y = now.getUTCFullYear();
const m = now.getUTCMonth();
const pad = (n: number) => String(n).padStart(2, '0');
const day1 = `${y}-${pad(m + 1)}-01`;

const sheet = {
  from: `${day1}T00:00:00.000Z`,
  to: `${y}-${pad(m + 1)}-28T23:59:59.999Z`,
  workdaySec: 28800,
  totalSec: 30600, // 8h 30m
  expectedSec: 144000,
  expectedToDateSec: 57600,
  days: { [day1]: 21600, [`${y}-${pad(m + 1)}-02`]: 9000 },
  issues: [
    { key: 'TF-1', summary: 'First task', statusCategoryKey: 'indeterminate', totalSec: 21600 },
    { key: 'TF-2', summary: 'Second task', statusCategoryKey: 'new', totalSec: 9000 },
  ],
};

describe('TimeLoggedCard', () => {
  beforeEach(() => {
    mocks.fetchMyTimesheet.mockResolvedValue(sheet);
  });
  afterEach(() => vi.clearAllMocks());

  it('shows the month total, expected progress, and per-issue rows', async () => {
    wrap(<TimeLoggedCard />);
    expect(mocks.fetchMyTimesheet).toHaveBeenCalledWith(day1, expect.any(String));
    await vi.waitFor(() => expect(screen.getByText('8h 30m')).toBeTruthy());
    expect(screen.getByText(/of ~16h so far/)).toBeTruthy(); // expectedToDateSec for the current month
    expect(screen.getByText('First task')).toBeTruthy();
    expect(screen.getByText('6h')).toBeTruthy();
    expect(screen.getByText('2h 30m')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'TF-1' }).getAttribute('href')).toBe('/browse/TF-1');
  });

  it('month navigation refetches the adjacent period and disables next at the current month', async () => {
    wrap(<TimeLoggedCard />);
    const next = screen.getByLabelText('Next month');
    expect(next.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Previous month'));
    await vi.waitFor(() =>
      expect(mocks.fetchMyTimesheet).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${m === 0 ? y - 1 : y}-`)),
        expect.any(String),
      ),
    );
    expect(next.hasAttribute('disabled')).toBe(false);
  });

  it('shows the percentage when the total exceeds expected', async () => {
    mocks.fetchMyTimesheet.mockResolvedValue({ ...sheet, totalSec: 853200 }); // 237h > ~16h expected
    wrap(<TimeLoggedCard />);
    await vi.waitFor(() => expect(screen.getByText('237h')).toBeTruthy());
    expect(screen.getByText(/· 1481%/)).toBeTruthy();
  });

  it('renders the empty state when nothing was logged', async () => {
    mocks.fetchMyTimesheet.mockResolvedValue({ ...sheet, totalSec: 0, days: {}, issues: [] });
    wrap(<TimeLoggedCard />);
    await vi.waitFor(() => expect(screen.getByText(/No work logged in/)).toBeTruthy());
  });
});

describe('MyMonthLogStrip', () => {
  beforeEach(() => {
    mocks.fetchMyTimesheet.mockResolvedValue(sheet);
  });
  afterEach(() => vi.clearAllMocks());

  it('summarizes the current month in one line', async () => {
    const { container } = wrap(<MyMonthLogStrip />);
    await vi.waitFor(() => expect(container.textContent).toContain('8h 30m'));
    expect(container.textContent).toContain('across 2 issues');
  });

  it('renders nothing when the month is empty', async () => {
    mocks.fetchMyTimesheet.mockResolvedValue({ ...sheet, totalSec: 0, days: {}, issues: [] });
    const { container } = wrap(<MyMonthLogStrip />);
    await vi.waitFor(() => expect(mocks.fetchMyTimesheet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('formatSeconds', () => {
  it('formats hours and minutes', () => {
    expect(formatSeconds(30600)).toBe('8h 30m');
    expect(formatSeconds(9000)).toBe('2h 30m');
    expect(formatSeconds(600)).toBe('10m');
    expect(formatSeconds(28800)).toBe('8h');
  });
});
