import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ProfilePage from '../../src/pages/ProfilePage';

const mocks = vi.hoisted(() => ({
  fetchProfile: vi.fn(async () => ({
    user: { accountId: 'u1', displayName: 'Alice', email: 'a@test.local', locale: 'en', timezone: 'UTC', dateFormat: 'ymd', totpEnabled: false },
    openIssues: [],
  })),
  updateProfile: vi.fn(async () => ({})),
  changePassword: vi.fn(async () => ({})),
  fetchSessions: vi.fn(async () => []),
  revokeSession: vi.fn(async () => undefined),
  totpEnroll: vi.fn(async () => ({ secret: 's', otpauthUrl: 'otpauth://x' })),
  totpVerify: vi.fn(async () => ({ backupCodes: [] })),
  totpDisable: vi.fn(async () => ({})),
  fetchPreferences: vi.fn(async () => ({})),
  putPreference: vi.fn(async () => ({})),
  fetchMyGrants: vi.fn(async () => ({
    grants: [{ id: 'g1', clientId: 'cid-abc', clientName: 'ci-bot', scopes: ['read', 'write'], projectKeys: ['TF'], createdAt: '2026-11-20T10:00:00Z' }],
  })),
  revokeMyGrant: vi.fn(async () => undefined),
}));

vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ProfilePage /></MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Profile — connected apps (049 grants)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists authorized apps with scopes and project keys', async () => {
    renderPage();
    expect(await screen.findByText('ci-bot')).toBeTruthy();
    expect(screen.getByText('(cid-abc)')).toBeTruthy();
    expect(screen.getByText(/read write/)).toBeTruthy();
  });

  it('revoke calls the grant endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('Revoke'));
    await waitFor(() => expect(mocks.revokeMyGrant).toHaveBeenCalledWith('g1'));
  });
});
