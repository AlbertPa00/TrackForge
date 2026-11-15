// 021 US1 — /admin/users: create, activate/deactivate, group membership.
import { useDeferredValue, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAdminUsersFiltered, fetchAdminUsersPage, createAdminUser, patchAdminUser, inviteUser, reinviteUser,
  previewAnonymizeUser, anonymizeUser,
  fetchGroups, addGroupMember, removeGroupMember,
  fetchMyself,
  ApiError, type AdminUser, type AnonymizePreview,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import UserAvatar from '../components/UserAvatar.js';
import { useFlag } from '../components/Flag.js';
import { usePagedGroups, PagedGroupsFooter } from '../hooks/usePagedGroups.js';
import { formatDate } from '../lib/format.js';

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const [groupSearch, setGroupSearch] = useState('');
  const groups = usePagedGroups(groupSearch, open);
  const [form, setForm] = useState({
    email: '', displayName: '', password: '', isAdmin: false,
    type: 'human' as 'human' | 'agent', ownerId: '', isAssignableAgent: true,
    approvalPolicy: 'never' as 'always' | 'destructiveOnly' | 'never',
  });
  // 061 US6 — agent accounts need a human owner (047 backend, first UI surface).
  const humans = useQuery({
    queryKey: ['admin-users', 'human', 'active'],
    queryFn: () => fetchAdminUsersFiltered({ type: 'human', status: 'active' }),
    enabled: open && form.type === 'agent',
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const u = await createAdminUser({
        email: form.email.trim(), displayName: form.displayName.trim(),
        ...(form.type === 'agent'
          ? {
              type: 'agent' as const, ownerId: form.ownerId,
              isAssignableAgent: form.isAssignableAgent, approvalPolicy: form.approvalPolicy,
            }
          : {
              ...(form.password ? { password: form.password } : {}),
              ...(form.isAdmin ? { isAdmin: true } : {}),
            }),
      });
      await Promise.all([...picked].map((g) => addGroupMember(g, u.accountId)));
      return u;
    },
    onSuccess: () => {
      flag.success(`User ${form.displayName.trim()} created`);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      setForm({ email: '', displayName: '', password: '', isAdmin: false, type: 'human', ownerId: '', isAssignableAgent: true, approvalPolicy: 'never' });
      setPicked(new Set());
      setError(null);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.errorMessages[0] ?? e.message : 'Create failed'),
  });

  const input = 'mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';
  return (
    <Modal open={open} onClose={onClose} labelledBy="create-user-title">
      <div className="p-6 w-[480px]">
        <h2 id="create-user-title" className="text-[18px] font-medium text-atl-n-800 mb-4">Create user</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-atl-n-200">Email</span>
            <input className={input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-atl-n-200">Display name</span>
            <input className={input} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-atl-n-200">Account type</span>
            <select className={input} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'human' | 'agent' })}>
              <option value="human">Human</option>
              <option value="agent">Agent</option>
            </select>
          </label>
          {form.type === 'human' ? (
            <>
              <label className="block">
                <span className="text-xs font-medium text-atl-n-200">Password (optional — user can reset)</span>
                <input className={input} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
              <label className="flex items-center gap-2 text-sm text-atl-n-500">
                <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
                Site administrator
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-medium text-atl-n-200">Owner</span>
                <select className={input} value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                  <option value="">Choose a human owner…</option>
                  {(humans.data ?? []).map((u) => (
                    <option key={u.accountId} value={u.accountId}>{u.displayName} — {u.emailAddress}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-atl-n-500">
                <input type="checkbox" checked={form.isAssignableAgent} onChange={(e) => setForm({ ...form, isAssignableAgent: e.target.checked })} />
                Assignable agent (shows in the delegate picker)
              </label>
              <label className="block">
                <span className="text-xs font-medium text-atl-n-200">Approval policy</span>
                <select className={input} value={form.approvalPolicy}
                  onChange={(e) => setForm({ ...form, approvalPolicy: e.target.value as 'always' | 'destructiveOnly' | 'never' })}>
                  <option value="never">never — writes execute immediately</option>
                  <option value="destructiveOnly">destructiveOnly — deletes park as proposals</option>
                  <option value="always">always — every write parks as a proposal</option>
                </select>
              </label>
            </>
          )}
          <div>
            <div className="text-xs font-medium text-atl-n-200 mb-1">Groups</div>
            <input
              type="search"
              className="mb-1.5 w-full border border-atl-n-40 rounded-[3px] px-2 py-1 text-xs"
              placeholder="Filter groups…"
              aria-label="Filter groups"
              value={groupSearch}
              onChange={(e) => setGroupSearch(e.target.value)}
            />
            <div className="max-h-32 overflow-y-auto border border-atl-n-30 rounded-[3px] p-2 space-y-1">
              {groups.groups.map((g) => (
                <label key={g.name} className="flex items-center gap-2 text-sm text-atl-n-500">
                  <input
                    type="checkbox"
                    checked={picked.has(g.name)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(g.name); else next.delete(g.name);
                      setPicked(next);
                    }}
                  />
                  {g.name}
                </label>
              ))}
              {!groups.isLoading && groups.groups.length === 0 && (
                <div className="text-xs text-atl-n-100">
                  {groupSearch.trim() ? `No groups match "${groupSearch.trim()}".` : 'No groups yet — create them under Groups.'}
                </div>
              )}
              {groups.hasNextPage && (
                <PagedGroupsFooter
                  loaded={groups.groups.length}
                  total={groups.total}
                  isFetchingNextPage={groups.isFetchingNextPage}
                  fetchNextPage={() => void groups.fetchNextPage()}
                />
              )}
            </div>
          </div>
          {error && <div className="text-sm text-atl-r-400">{error}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 rounded" onClick={onClose}>Cancel</button>
          <button
            className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
            disabled={!form.email.trim() || !form.displayName.trim() || (form.type === 'agent' && !form.ownerId) || create.isPending}
            onClick={() => create.mutate()}
          >
            Create user
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 061 US6 — rename, password reset, and agent controls (047 fields that had no UI). */
function EditUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const [form, setForm] = useState({
    displayName: user.displayName,
    password: '',
    isAssignableAgent: user.isAssignableAgent ?? false,
    approvalPolicy: (user.approvalPolicy ?? 'never') as 'always' | 'destructiveOnly' | 'never',
  });
  const save = useMutation({
    mutationFn: () =>
      patchAdminUser(user.accountId, {
        displayName: form.displayName.trim(),
        ...(form.password ? { password: form.password } : {}),
        ...(user.agent
          ? { isAssignableAgent: form.isAssignableAgent, approvalPolicy: form.approvalPolicy }
          : {}),
      }),
    onSuccess: () => {
      flag.success(`${form.displayName.trim()} updated`);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Update failed'),
  });
  const input = 'mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';
  return (
    <Modal open onClose={onClose} labelledBy="edit-user-title">
      <div className="p-6 w-[440px]">
        <h2 id="edit-user-title" className="text-[18px] font-medium text-atl-n-800 mb-4">Edit {user.displayName}</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-atl-n-200">Display name</span>
            <input className={input} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          {!user.agent && (
            <label className="block">
              <span className="text-xs font-medium text-atl-n-200">New password <span className="font-normal">(leave blank to keep)</span></span>
              <input className={input} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </label>
          )}
          {user.agent && (
            <>
              <label className="flex items-center gap-2 text-sm text-atl-n-500">
                <input type="checkbox" checked={form.isAssignableAgent} onChange={(e) => setForm({ ...form, isAssignableAgent: e.target.checked })} />
                Assignable agent (shows in the delegate picker)
              </label>
              <label className="block">
                <span className="text-xs font-medium text-atl-n-200">Approval policy</span>
                <select className={input} value={form.approvalPolicy}
                  onChange={(e) => setForm({ ...form, approvalPolicy: e.target.value as 'always' | 'destructiveOnly' | 'never' })}>
                  <option value="never">never — writes execute immediately</option>
                  <option value="destructiveOnly">destructiveOnly — deletes park as proposals</option>
                  <option value="always">always — every write parks as a proposal</option>
                </select>
              </label>
            </>
          )}
          {save.isError && <div className="text-sm text-atl-r-400">{(save.error as Error).message}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 rounded" onClick={onClose}>Cancel</button>
          <button
            className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
            disabled={!form.displayName.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function GroupsDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const [search, setSearch] = useState('');
  // Server-side name filter + paging — the directory can hold hundreds of
  // groups; the old client-side filter only saw the first 100.
  const groups = usePagedGroups(search);
  // 061 US5 — fetchAdminUsers already returns groups[] per user; seed from it
  // instead of fanning out one fetchGroupMembers call per group.
  const [member, setMember] = useState(() => new Set(user.groups ?? []));
  const toggle = useMutation({
    mutationFn: async ({ group, add }: { group: string; add: boolean }) =>
      add ? addGroupMember(group, user.accountId) : removeGroupMember(group, user.accountId),
    onSuccess: (_r, { group, add }) => {
      setMember((s) => {
        const next = new Set(s);
        if (add) next.add(group); else next.delete(group);
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Group membership update failed'),
  });

  return (
    <Modal open onClose={onClose} labelledBy="user-groups-title">
      <div className="p-6 w-[420px]">
        <h2 id="user-groups-title" className="text-[18px] font-medium text-atl-n-800 mb-4">
          Groups — {user.displayName}
        </h2>
        {/* Assigned groups stay visible as removable chips — with hundreds of
            groups in the directory the member rows alone would flood the list. */}
        {member.size > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {[...member].sort().map((g) => (
              <button
                key={g}
                type="button"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ group: g, add: false })}
                title={`Remove from ${g}`}
                className="inline-flex items-center gap-1 rounded-[3px] bg-atl-n-20 px-1.5 py-0.5 text-xs text-atl-n-500 hover:bg-atl-n-30 disabled:opacity-50"
              >
                {g}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}
        <input
          autoFocus
          className="mb-3 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm"
          placeholder="Search groups…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search groups"
        />
        {groups.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {groups.groups.map((g) => (
            <label key={g.name} className="flex items-center gap-2 text-sm text-atl-n-500">
              <input
                type="checkbox"
                checked={member.has(g.name)}
                disabled={toggle.isPending}
                onChange={(e) => toggle.mutate({ group: g.name, add: e.target.checked })}
              />
              {g.name}
            </label>
          ))}
          {!groups.isLoading && groups.groups.length === 0 && (
            <div className="text-xs text-atl-n-100">
              {search.trim() ? `No groups match "${search.trim()}".` : 'No groups defined.'}
            </div>
          )}
          {groups.hasNextPage && (
            <PagedGroupsFooter
              loaded={groups.groups.length}
              total={groups.total}
              isFetchingNextPage={groups.isFetchingNextPage}
              fetchNextPage={() => void groups.fetchNextPage()}
            />
          )}
        </div>
        <div className="mt-5 flex justify-end">
          <button className="px-3 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 rounded" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const flag = useFlag();
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [filter, setFilter] = useState('');
  // 061 US5 — the 060 server-side ?query= param was never wired; defer it so
  // keystrokes batch into one request instead of filtering client-side.
  const deferred = useDeferredValue(filter);
  // Server-paged like /teams People: infinite query so the ['admin-users']
  // invalidations below refetch every loaded page on mutations.
  const users = useInfiniteQuery({
    queryKey: ['admin-users', statusFilter, typeFilter, groupFilter, deferred],
    queryFn: ({ pageParam }) =>
      fetchAdminUsersPage({
        status: statusFilter, type: typeFilter, group: groupFilter, query: deferred, startAt: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.isLast ? undefined : last.startAt + last.values.length),
  });
  // Filter dropdown needs the full list once — picker caps at 1000 server-side.
  const groups = useQuery({ queryKey: ['admin-groups', 'all'], queryFn: () => fetchGroups(undefined, 0, 1000) });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [groupsFor, setGroupsFor] = useState<AdminUser | null>(null);
  const [editFor, setEditFor] = useState<AdminUser | null>(null);
  const [confirm, setConfirm] = useState<AdminUser | null>(null);
  const [adminConfirm, setAdminConfirm] = useState<AdminUser | null>(null);
  const [anonymizePreview, setAnonymizePreview] = useState<AnonymizePreview | null>(null);
  const [inviteLink, setInviteLink] = useState<{ url: string; email: string } | null>(null);
  const rows = (users.data?.pages ?? []).flatMap((p) => p.values);
  const lastPage = users.data?.pages.at(-1);

  const setActive = useMutation({
    mutationFn: ({ u, active }: { u: AdminUser; active: boolean }) =>
      patchAdminUser(u.accountId, { active }),
    onSuccess: (_d, v) => {
      flag.success(v.active ? `${v.u.displayName} reactivated` : `${v.u.displayName} deactivated`);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Update failed'),
  });

  const reinvite = useMutation({
    mutationFn: (accountId: string) => reinviteUser(accountId),
    onSuccess: (d, accountId) => {
      if (!d.mailSent && d.inviteUrl) {
        const u = rows.find((x) => x.accountId === accountId);
        setInviteLink({ url: d.inviteUrl, email: u?.emailAddress ?? '' });
      } else {
        flag.success(d.mailSent ? 'Invite re-sent' : 'Invite re-sent — no link returned');
      }
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Re-invite failed'),
  });

  const anonymize = useMutation({
    mutationFn: (p: AnonymizePreview) => anonymizeUser(p.accountId, p.confirmToken),
    onSuccess: () => {
      flag.success('User anonymized');
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      setAnonymizePreview(null);
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Anonymize failed'),
  });

  const setAdmin = useMutation({
    mutationFn: ({ u, isAdmin }: { u: AdminUser; isAdmin: boolean }) =>
      patchAdminUser(u.accountId, { isAdmin }),
    onSuccess: (_d, v) => {
      flag.success(v.isAdmin ? `${v.u.displayName} is now an admin` : `Admin revoked for ${v.u.displayName}`);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Update failed'),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-atl-n-800">Users</h1>
          <p className="text-sm text-atl-n-200 mt-0.5">Create users, manage activation and group membership.</p>
        </div>
        <div className="space-x-2">
          <button
            className="px-3 py-1.5 text-sm font-medium text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded"
            onClick={() => setInviteOpen(true)}
          >
            Invite users
          </button>
          <button
            className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded"
            onClick={() => setCreateOpen(true)}
          >
            Create user
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <input
          className="w-64 border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm"
          placeholder="Name, username or email"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm bg-atl-paper"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="Filter by group"
        >
          <option value="">Any group</option>
          {(groups.data?.groups ?? []).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
        </select>
        <select
          className="border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm bg-atl-paper"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter by account type"
        >
          <option value="">All types</option>
          <option value="human">Human</option>
          <option value="agent">Agent</option>
        </select>
        <select
          className="border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm bg-atl-paper"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {users.isLoading && (
        <div className="bg-atl-paper border border-atl-n-30 rounded" role="status" aria-label="Loading users">
          {[0, 1, 2, 3, 4].map((r) => (
            <div key={r} className="flex items-center gap-3 px-4 py-3 border-b border-atl-n-20 last:border-0">
              <div className="h-6 w-6 rounded-full bg-atl-n-30 animate-pulse" />
              <div className="h-3 w-40 rounded bg-atl-n-30 animate-pulse" />
              <div className="h-3 w-52 rounded bg-atl-n-20 animate-pulse" />
              <div className="ml-auto h-3 w-24 rounded bg-atl-n-20 animate-pulse" />
            </div>
          ))}
        </div>
      )}
      {users.data && rows.length === 0 && <EmptyState title="No users match" />}
      {lastPage != null && (
        <div className="mb-2 text-xs text-atl-n-200">
          {rows.length} of {lastPage.total} users
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-atl-paper border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Last login</th>
                <th className="px-4 py-2">Groups</th>
                <th className="px-4 py-2">Directory</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.accountId} className="border-b border-atl-n-20 last:border-0">
                  <td className="px-4 py-2 text-atl-n-800">
                    <span className="flex items-center gap-2">
                      <UserAvatar displayName={u.displayName} size={24} />
                      {u.displayName}
                      {u.isAdmin && <span className="ml-1 text-[11px] font-medium text-atl-b-400 bg-atl-b-50 rounded px-1.5 py-0.5">admin</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-atl-n-500">{u.emailAddress}</td>
                  <td className="px-4 py-2 text-atl-n-500">{u.agent ? 'agent' : 'human'}</td>
                  <td className="px-4 py-2">
                    <span className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${
                      u.active ? 'text-atl-g-500 bg-atl-g-50' : u.invitedAt ? 'text-atl-b-400 bg-atl-b-50' : 'text-atl-n-200 bg-atl-n-20'
                    }`}>
                      {u.active ? 'Active' : u.invitedAt ? 'Invited' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-atl-n-300">
                    {u.lastLoginAt ? formatDate(u.lastLoginAt) : 'Never logged in'}
                  </td>
                  <td className="px-4 py-2 text-xs text-atl-n-500 max-w-[140px] truncate" title={(u.groups ?? []).join(', ')}>
                    {(u.groups ?? []).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2 text-xs text-atl-n-500">{u.directory ?? 'Internal'}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setEditFor(u)}>Edit</button>
                    <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setGroupsFor(u)}>Groups</button>
                    {!u.active && u.invitedAt && (
                      <button className="text-sm text-atl-b-400 hover:underline" onClick={() => reinvite.mutate(u.accountId)}>Re-invite</button>
                    )}
                    {u.accountId !== me?.accountId && (
                      <button
                        className="text-sm text-atl-r-400 hover:underline"
                        onClick={async () => {
                          const p = await previewAnonymizeUser(u.accountId).catch(() => null);
                          setAnonymizePreview(p ? { ...p, displayName: u.displayName } : null);
                        }}
                      >
                        Anonymize
                      </button>
                    )}
                    {u.accountId !== me?.accountId && (
                      <>
                        <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setAdminConfirm(u)}>
                          {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                        </button>
                        {(u.active || !u.invitedAt) && (
                          <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setConfirm(u)}>
                            {u.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.hasNextPage && (
            <div className="border-t border-atl-n-20 px-4 py-2 text-center">
              <button
                type="button"
                disabled={users.isFetchingNextPage}
                onClick={() => void users.fetchNextPage()}
                className="text-sm text-atl-b-300 hover:underline disabled:opacity-50"
              >
                {users.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      )}

      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <InviteUserDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onLink={setInviteLink} />
      {groupsFor && <GroupsDialog user={groupsFor} onClose={() => setGroupsFor(null)} />}
      {editFor && <EditUserDialog user={editFor} onClose={() => setEditFor(null)} />}
      <ConfirmDialog
        open={anonymizePreview !== null}
        title={`Anonymize ${anonymizePreview?.displayName ?? ''}?`}
        body={
          anonymizePreview
            ? `Irreversible. Becomes "${String(anonymizePreview.willScrub.displayName)}", revokes ${anonymizePreview.willScrub.activeSessions} session(s) and ${anonymizePreview.willScrub.apiTokens} token(s), removes external identities, and deactivates. Authored content keeps the anonymized attribution.`
            : ''
        }
        confirmLabel="Anonymize user"
        danger
        pending={anonymize.isPending}
        onConfirm={() => { if (anonymizePreview) anonymize.mutate(anonymizePreview); }}
        onClose={() => setAnonymizePreview(null)}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={`${confirm?.active ? 'Deactivate' : 'Reactivate'} ${confirm?.displayName ?? ''}?`}
        body={confirm?.active
          ? 'They will immediately lose login, PAT and assignment access. Authored content stays attributed.'
          : 'They will regain login and assignment access.'}
        confirmLabel={confirm?.active ? 'Deactivate' : 'Reactivate'}
        danger={confirm?.active !== false}
        pending={setActive.isPending}
        onConfirm={() => { if (confirm) { setActive.mutate({ u: confirm, active: !confirm.active }); setConfirm(null); } }}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={adminConfirm !== null}
        title={`${adminConfirm?.isAdmin ? 'Revoke admin from' : 'Make'} ${adminConfirm?.displayName ?? ''}${adminConfirm?.isAdmin ? '?' : ' an admin?'}`}
        body={adminConfirm?.isAdmin
          ? 'They will lose access to admin pages and user management immediately.'
          : 'They will gain full site administration: users, schemes, organization settings.'}
        confirmLabel={adminConfirm?.isAdmin ? 'Revoke admin' : 'Make admin'}
        danger={adminConfirm?.isAdmin === true}
        pending={setAdmin.isPending}
        onConfirm={() => { if (adminConfirm) { setAdmin.mutate({ u: adminConfirm, isAdmin: !adminConfirm.isAdmin }); setAdminConfirm(null); } }}
        onClose={() => setAdminConfirm(null)}
      />
      {inviteLink && <InviteLinkModal link={inviteLink} onClose={() => setInviteLink(null)} />}
    </div>
  );
}

/** 061 US2 — mail unconfigured: surface the accept link so the admin can
    share it manually (the token only exists in the response body/header). */
function InviteLinkModal({ link, onClose }: { link: { url: string; email: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} labelledBy="invite-link-title">
      <div className="p-6 w-[480px]">
        <h2 id="invite-link-title" className="text-[18px] font-medium text-atl-n-800 mb-2">Share the invite link</h2>
        <p className="text-sm text-atl-n-300 mb-3">
          Mail is not configured, so nothing was emailed{link.email ? ` to ${link.email}` : ''}. Send this link yourself —
          it sets their password and activates the account. Expires in 1 hour.
        </p>
        <input
          readOnly
          className="w-full rounded-[3px] border border-atl-n-40 bg-atl-n-10 px-2 py-1.5 text-xs font-mono text-atl-n-700"
          value={link.url}
          onFocus={(e) => e.target.select()}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 rounded" onClick={onClose}>Close</button>
          <button
            className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded"
            onClick={() => { void navigator.clipboard.writeText(link.url).then(() => setCopied(true)); }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 060 US5 — "Invitar usuarios": email + optional display name + groups. */
function InviteUserDialog({ open, onClose, onLink }: { open: boolean; onClose: () => void; onLink: (l: { url: string; email: string }) => void }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const [groupSearch, setGroupSearch] = useState('');
  const groups = usePagedGroups(groupSearch, open);
  const [form, setForm] = useState({ email: '', displayName: '', groups: [] as string[] });
  const invite = useMutation({
    mutationFn: () => inviteUser({
      email: form.email.trim(),
      displayName: form.displayName.trim() || undefined,
      groups: form.groups.length ? form.groups : undefined,
    }),
    onSuccess: (d) => {
      if (!d.mailSent && d.inviteUrl) {
        onLink({ url: d.inviteUrl, email: d.emailAddress });
      } else {
        flag.success(`Invite emailed to ${d.emailAddress}`);
      }
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      setForm({ email: '', displayName: '', groups: [] });
      onClose();
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Invite failed'),
  });
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-xl font-semibold text-atl-n-800">Invite users</h2>
        <p className="mt-1 text-sm text-atl-n-300">They'll get an email link to set a password and activate their account.</p>
      </div>
      <div className="px-6 py-4 space-y-3">
        <label className="block text-sm">
          <span className="text-atl-n-400">Email</span>
          <input
            autoFocus
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="text-atl-n-400">Display name (optional)</span>
          <input
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <fieldset>
          <legend className="text-sm text-atl-n-400">Add to groups</legend>
          {form.groups.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {form.groups.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setForm({ ...form, groups: form.groups.filter((x) => x !== g) })}
                  title={`Remove ${g}`}
                  className="inline-flex items-center gap-1 rounded-[3px] bg-atl-n-20 px-1.5 py-0.5 text-xs text-atl-n-500 hover:bg-atl-n-30"
                >
                  {g}
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          )}
          <input
            type="search"
            className="mt-1.5 w-full border border-atl-n-40 rounded-[3px] px-2 py-1 text-xs"
            placeholder="Filter groups…"
            aria-label="Filter groups"
            value={groupSearch}
            onChange={(e) => setGroupSearch(e.target.value)}
          />
          <div className="mt-1 max-h-32 overflow-y-auto border border-atl-n-30 rounded-[3px] p-2 space-y-1">
            {groups.groups.map((g) => (
              <label key={g.name} className="flex items-center gap-1.5 text-sm text-atl-n-600">
                <input
                  type="checkbox"
                  checked={form.groups.includes(g.name)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      groups: e.target.checked
                        ? [...form.groups, g.name]
                        : form.groups.filter((x) => x !== g.name),
                    })
                  }
                />
                {g.name}
              </label>
            ))}
            {!groups.isLoading && groups.groups.length === 0 && (
              <div className="text-xs text-atl-n-100">
                {groupSearch.trim() ? `No groups match "${groupSearch.trim()}".` : 'No groups defined.'}
              </div>
            )}
            {groups.hasNextPage && (
              <PagedGroupsFooter
                loaded={groups.groups.length}
                total={groups.total}
                isFetchingNextPage={groups.isFetchingNextPage}
                fetchNextPage={() => void groups.fetchNextPage()}
              />
            )}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20">
            Cancel
          </button>
          <button
            type="button"
            disabled={!form.email.trim() || invite.isPending}
            onClick={() => invite.mutate()}
            className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
          >
            {invite.isPending ? 'Inviting…' : 'Send invite'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
