import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';
import RequireAdmin from '../../src/components/RequireAdmin';
import AdminUsersPage from '../../src/pages/AdminUsersPage';
import AdminAuditPage from '../../src/pages/AdminAuditPage';
import AdminIdentityPage from '../../src/pages/AdminIdentityPage';

const USER = {
  accountId: 'u1', displayName: 'Alice Admin', emailAddress: 'alice@test.local',
  active: true, isAdmin: true,
};
const MEMBER = {
  accountId: 'u2', displayName: 'Bob Member', emailAddress: 'bob@test.local', active: true,
};

const mocks = vi.hoisted(() => ({
  fetchMyself: vi.fn(async () => USER),
  fetchAdminUsers: vi.fn(async () => [USER, MEMBER]),
  fetchAdminUsersFiltered: vi.fn(async () => [USER, MEMBER]),
  fetchAdminUsersPage: vi.fn(async () => ({ startAt: 0, maxResults: 50, total: 2, isLast: true, values: [USER, MEMBER] })),
  createAdminUser: vi.fn(async (b: { email: string }) => ({ ...MEMBER, emailAddress: b.email, accountId: 'u3' })),
  patchAdminUser: vi.fn(async () => ({ ...MEMBER, active: false })),
  fetchGroups: vi.fn(async () => ({ groups: [{ name: 'devs', memberCount: 1 }], total: 1 })),
  fetchGroupMembers: vi.fn(async () => ({ startAt: 0, maxResults: 100, total: 1, isLast: true, values: [MEMBER] })),
  addGroupMember: vi.fn(async () => ({})),
  removeGroupMember: vi.fn(async () => undefined),
  fetchAuditEvents: vi.fn(async () => ({
    total: 1,
    events: [{ id: 'e1', action: 'token.created', entityType: 'token', entityId: 'tok1',
      details: { name: 'ci-bot' }, ip: '10.0.0.1', createdAt: '2026-11-20T10:00:00Z',
      actor: { accountId: 'u1', displayName: 'Alice Admin', agent: false } }],
  })),
  auditCsvUrl: vi.fn(() => '/api/internal/audit?format=csv'),
  fetchOAuthClients: vi.fn(async () => ({
    clients: [{ id: 'oc1', clientId: 'cid-abc', name: 'ci-bot', redirectUris: [],
      grantTypes: ['client_credentials'], allowedScopes: ['read', 'write'],
      allowedProjectKeys: [], confidential: true, enabled: true }],
  })),
  createOAuthClient: vi.fn(async () => ({ id: 'oc2', clientId: 'cid-new', name: 'new', redirectUris: [],
    grantTypes: ['authorization_code'], allowedScopes: ['read'], allowedProjectKeys: [],
    confidential: true, enabled: true, clientSecret: 'secret-xyz' })),
  updateOAuthClient: vi.fn(async () => ({})),
  deleteOAuthClient: vi.fn(async () => undefined),
  fetchDirectoryConnections: vi.fn(async () => ({
    connections: [
      { id: 'dc-scim1', type: 'scim', name: 'Okta inbound', config: {}, enabled: true, lastSyncAt: null },
      { id: 'dc-ldap1', type: 'ldap', name: 'Corp LDAP', config: {}, enabled: true, lastSyncAt: '2026-11-20T09:00:00Z' },
    ],
  })),
  createDirectoryConnection: vi.fn(async () => ({})),
  updateDirectoryConnection: vi.fn(async () => ({})),
  deleteDirectoryConnection: vi.fn(async () => undefined),
  mintScimToken: vi.fn(async () => ({ id: 'tok1', scimToken: 'scim-bearer-123' })),
  testLdapConnection: vi.fn(async () => ({ ok: true })),
  syncLdapConnection: vi.fn(async () => ({ ok: true, summary: {} })),
}));

vi.mock('../../src/api/client.js', async (orig) => ({ ...(await orig() as object), ...mocks }));

function renderAt(el: ReactElement, route = '/admin/users') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route element={<RequireAdmin />}>
            <Route path="/admin/users" element={el} />
            <Route path="/admin/audit" element={<AdminAuditPage />} />
            <Route path="/admin/identity" element={<AdminIdentityPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('021 admin console — RequireAdmin + users page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('non-admin sees a 404 page, not the console', async () => {
    mocks.fetchMyself.mockResolvedValueOnce(MEMBER);
    renderAt(<AdminUsersPage />);
    expect(await screen.findByText('404')).toBeTruthy();
    expect(screen.queryByText('Create user')).toBeNull();
  });

  it('admin sees the users table with status badges and actions', async () => {
    renderAt(<AdminUsersPage />);
    expect(await screen.findByText('Alice Admin')).toBeTruthy();
    expect(screen.getByText('Bob Member')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    // The page hides self-actions — only Bob's row offers Deactivate.
    expect(screen.getAllByText('Deactivate').length).toBe(1);
  });

  it('create-user dialog collects fields and posts', async () => {
    const user = userEvent.setup();
    renderAt(<AdminUsersPage />);
    await user.click(await screen.findByText('Create user'));
    await user.type(screen.getByLabelText(/email/i), 'new@test.local');
    await user.type(screen.getByLabelText(/display name/i), 'New Person');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /create user/i }));
    await waitFor(() => expect(mocks.createAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@test.local', displayName: 'New Person' })));
  });

  it('deactivate flow confirms then PATCHes active=false', async () => {
    const user = userEvent.setup();
    renderAt(<AdminUsersPage />);
    const deactivates = await screen.findAllByText('Deactivate');
    await user.click(deactivates[0]); // Bob's row — Alice's self-actions are hidden
    expect(await screen.findByText(/Deactivate Bob Member/)).toBeTruthy();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mocks.patchAdminUser).toHaveBeenCalledWith('u2', { active: false }));
  });

  it('audit page honors deep-linked filters (?entityType&entityId) and shows events', async () => {
    renderAt(<AdminUsersPage />, '/admin/audit?entityType=token&entityId=tok1');
    expect(await screen.findByText('token.created')).toBeTruthy();
    expect((screen.getByPlaceholderText('Entity type') as HTMLInputElement).value).toBe('token');
    expect((screen.getByPlaceholderText('Entity id') as HTMLInputElement).value).toBe('tok1');
    expect(mocks.fetchAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'token', entityId: 'tok1' }));
  });
});

describe('049 admin identity — OAuth clients + directory connections', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists OAuth clients and directory connections', async () => {
    renderAt(<AdminIdentityPage />, '/admin/identity');
    expect(await screen.findByText('ci-bot')).toBeTruthy();
    expect(screen.getByText('cid-abc')).toBeTruthy();
    expect(screen.getByText('Okta inbound')).toBeTruthy();
    expect(screen.getByText('Corp LDAP')).toBeTruthy();
  });

  it('confidential client create shows the one-time secret banner', async () => {
    const user = userEvent.setup();
    renderAt(<AdminIdentityPage />, '/admin/identity');
    await user.click(await screen.findByText('New client'));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getAllByRole('textbox')[0], 'svc-app');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('secret-xyz')).toBeTruthy();
    expect(screen.getByText(/never shown again/)).toBeTruthy();
    expect(mocks.createOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'svc-app', grantTypes: ['authorization_code'] }));
  });

  it('SCIM mint token shows the bearer token once', async () => {
    const user = userEvent.setup();
    renderAt(<AdminIdentityPage />, '/admin/identity');
    await user.click(await screen.findByText('Mint token'));
    const dlg = await screen.findByRole('dialog');
    const input = within(dlg).getByLabelText(/token name/i);
    await user.clear(input);
    await user.type(input, 'ui-minted');
    await user.click(within(dlg).getByRole('button', { name: 'Mint token' }));
    expect(await screen.findByText('scim-bearer-123')).toBeTruthy();
    expect(mocks.mintScimToken).toHaveBeenCalledWith('dc-scim1', 'ui-minted');
  });

  it('LDAP Test reports the bind result in the row', async () => {
    const user = userEvent.setup();
    renderAt(<AdminIdentityPage />, '/admin/identity');
    await user.click(await screen.findByText('Test'));
    expect(await screen.findByText('Bind OK')).toBeTruthy();
    expect(mocks.testLdapConnection).toHaveBeenCalledWith('dc-ldap1');
  });
});
