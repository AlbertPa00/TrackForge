import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchVisibleFilters,
  setFilterFavourite,
  deleteFilter,
  updateFilter,
  createFilter,
  fetchMyself,
  fetchProjects,
  listFilterPermissions,
  addFilterPermission,
  deleteFilterPermission,
  fetchAdminUsers,
  fetchGroups,
  fetchRoleDefs,
  searchUsers,
  type FilterSharePermission,
  type SavedFilter,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import EmptyState from '../components/EmptyState.js';
import UserPicker from '../components/UserPicker.js';

function Star({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={active ? 'text-atl-y-400' : 'text-atl-n-100 hover:text-atl-y-400'}
      aria-label={active ? 'Unstar' : 'Star'}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4">
        <path d="M8 1.5 10 6l4.9.4-3.7 3.2 1.1 4.8L8 11.6l-4.3 2.8 1.1-4.8-3.7-3.2L6 6z" />
      </svg>
    </button>
  );
}

const SHARE_TYPES: { value: string; label: string; target: boolean; hint?: string }[] = [
  { value: 'global', label: 'Everyone (all users)', target: false },
  { value: 'authenticated', label: 'Logged-in users', target: false },
  { value: 'group', label: 'Group', target: true, hint: 'group name' },
  { value: 'project', label: 'Project', target: true, hint: 'project key' },
  { value: 'projectRole', label: 'Project role', target: true, hint: 'project key + role name' },
  { value: 'user', label: 'User', target: true, hint: 'user name or email' },
];

function permLabel(p: FilterSharePermission) {
  switch (p.type) {
    case 'global':
      return 'Everyone';
    case 'authenticated':
      return 'Logged-in users';
    case 'group':
      return `Group: ${p.groupname ?? '?'}`;
    case 'project':
      return `Project: ${p.projectKey ?? p.projectId ?? '?'}`;
    case 'projectRole':
      return `Role: ${p.roleName ?? p.roleId ?? '?'} in ${p.projectKey ?? p.projectId ?? '?'}`;
    case 'user':
      return `User: ${p.userDisplayName ?? p.userKey ?? '?'}`;
    default:
      return p.type;
  }
}

function ShareEditor({ filter }: { filter: SavedFilter }) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<string>('group');
  const [target, setTarget] = useState('');
  const [roleName, setRoleName] = useState('');
  const { data: perms } = useQuery({
    queryKey: ['filter-perms', filter.id],
    queryFn: () => listFilterPermissions(filter.id),
    initialData: filter.sharePermissions ?? [],
  });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  // /groups/picker is admin-only — non-admins keep the free-text input.
  const { data: groups } = useQuery({
    queryKey: ['groups-picker', target],
    queryFn: () => fetchGroups(target || undefined),
    enabled: type === 'group' && me?.isAdmin === true,
  });
  const { data: roleDefs } = useQuery({
    queryKey: ['role-defs'],
    queryFn: fetchRoleDefs,
    enabled: type === 'projectRole',
  });
  const inv = () => {
    queryClient.invalidateQueries({ queryKey: ['filter-perms', filter.id] });
    queryClient.invalidateQueries({ queryKey: ['filters'] });
  };
  const add = useMutation({
    mutationFn: async () => {
      const t = target.trim();
      const body =
        type === 'group'
          ? { type, groupname: t }
          : type === 'project'
            ? { type, projectKey: t }
            : type === 'projectRole'
              ? { type, projectKey: t, roleName: roleName.trim() }
              : type === 'user'
                ? { type, userKey: t }
                : { type };
      return addFilterPermission(filter.id, body as Parameters<typeof addFilterPermission>[1]);
    },
    onSuccess: () => {
      setTarget('');
      setRoleName('');
      inv();
    },
  });
  const remove = useMutation({
    mutationFn: (permId: string) => deleteFilterPermission(filter.id, permId),
    onSuccess: inv,
  });
  const needsTarget = SHARE_TYPES.find((s) => s.value === type)?.target;

  return (
    <div className="px-3 py-3 bg-atl-n-10 border-t border-atl-n-30">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 mb-2">
        Shared with
      </div>
      {(perms ?? []).length === 0 && <p className="text-xs text-atl-n-300 mb-2">Private — only you can see this filter.</p>}
      <ul className="mb-3 space-y-1">
        {(perms ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-xs text-atl-n-600">
            <span>{permLabel(p)}</span>
            <button onClick={() => remove.mutate(p.id)} className="text-atl-r-400 hover:underline">
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="h-7 px-2 rounded-[3px] border-2 border-atl-n-40 text-xs bg-atl-paper"
        >
          {SHARE_TYPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {needsTarget &&
          (type === 'user' ? (
            <div className="w-48">
              <UserPicker
                search={searchUsers}
                value={target}
                onChange={(id) => setTarget(id)}
                placeholder="Select a user…"
                className="text-xs"
              />
            </div>
          ) : (
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={type === 'projectRole' ? 'project key' : SHARE_TYPES.find((s) => s.value === type)?.hint}
              list={type === 'project' ? 'share-projects' : type === 'group' && me?.isAdmin ? 'share-groups' : undefined}
              className="h-7 w-40 px-2 rounded-[3px] border-2 border-atl-n-40 text-xs"
            />
          ))}
        {type === 'projectRole' && (
          <input
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder="role name"
            list="share-roles"
            className="h-7 w-32 px-2 rounded-[3px] border-2 border-atl-n-40 text-xs"
          />
        )}
        <datalist id="share-projects">
          {(projects ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </datalist>
        <datalist id="share-groups">
          {(groups?.groups ?? []).map((g) => (
            <option key={g.name} value={g.name} />
          ))}
        </datalist>
        <datalist id="share-roles">
          {(roleDefs ?? []).map((r) => (
            <option key={r.id} value={r.name} />
          ))}
        </datalist>
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || (needsTarget && !target.trim()) || (type === 'projectRole' && !roleName.trim())}
          className="h-7 px-3 rounded-[3px] bg-atl-b-400 text-white text-xs font-medium hover:bg-atl-b-500 disabled:opacity-50"
        >
          Add
        </button>
        {add.isError && <span className="text-xs text-atl-r-400">{(add.error as Error).message}</span>}
      </div>
    </div>
  );
}

const INPUT = 'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';

function EditFilterDialog({
  filter,
  onClose,
}: {
  filter: SavedFilter | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(filter?.name ?? '');
  const [description, setDescription] = useState(filter?.description ?? '');
  const mut = useMutation({
    mutationFn: () =>
      updateFilter(filter!.id, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filters'] });
      onClose();
    },
  });
  return (
    <Modal open={filter !== null} onClose={onClose}>
      {filter && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) mut.mutate();
          }}
        >
          <header className="px-5 py-4 border-b border-atl-n-30">
            <h2 className="text-base font-semibold text-atl-n-800">Edit filter</h2>
          </header>
          <div className="px-5 py-4 space-y-3">
            <div>
              <label htmlFor="ef-name" className="block text-xs font-semibold text-atl-n-200 mb-1">Name</label>
              <input id="ef-name" className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div>
              <label htmlFor="ef-desc" className="block text-xs font-semibold text-atl-n-200 mb-1">Description</label>
              <input id="ef-desc" className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {mut.isError && <p className="text-xs text-atl-r-500">{(mut.error as Error).message}</p>}
          </div>
          <footer className="px-5 py-3 border-t border-atl-n-30 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-atl-n-400 hover:bg-atl-n-20">
              Cancel
            </button>
            <button type="submit" disabled={mut.isPending || !name.trim()} className="rounded-[3px] px-3 py-1.5 text-sm font-medium bg-atl-b-400 text-white hover:bg-atl-b-300 disabled:opacity-50">
              Save
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

function DeleteFilterDialog({
  filter,
  onClose,
  onDelete,
  error,
}: {
  filter: SavedFilter | null;
  onClose: () => void;
  onDelete: () => void;
  error?: string | null;
}) {
  return (
    <Modal open={filter !== null} onClose={onClose}>
      {filter && (
        <div>
          <header className="px-5 py-4 border-b border-atl-n-30">
            <h2 className="text-base font-semibold text-atl-n-800">Delete filter</h2>
          </header>
          <div className="px-5 py-4">
            <p className="text-sm text-atl-n-700">
              Delete <span className="font-medium">{filter.name}</span>? This can't be undone.
            </p>
            {error && <p className="text-xs text-atl-r-500 mt-2">{error}</p>}
          </div>
          <footer className="px-5 py-3 border-t border-atl-n-30 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-atl-n-400 hover:bg-atl-n-20">
              Cancel
            </button>
            <button onClick={onDelete} className="rounded-[3px] px-3 py-1.5 text-sm font-medium bg-atl-r-400 text-white hover:bg-atl-r-300">
              Delete
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}

export default function FiltersPage() {
  const [nameFilter, setNameFilter] = useState('');
  const [shareOpen, setShareOpen] = useState<string | null>(null);
  const [editFilter, setEditFilter] = useState<SavedFilter | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedFilter | null>(null);
const [ownerTarget, setOwnerTarget] = useState<SavedFilter | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const { data: filters, isLoading } = useQuery({
    queryKey: ['filters', 'visible', nameFilter],
    queryFn: () => fetchVisibleFilters(nameFilter),
  });

  const fav = useMutation({
    mutationFn: ({ id, f }: { id: string; f: boolean }) => setFilterFavourite(id, f),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['filters'] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFilter(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filters'] });
      setDeleteTarget(null);
    },
  });
  const copy = useMutation({
    mutationFn: (f: SavedFilter) =>
      createFilter({ name: `Copy of ${f.name}`, jql: f.jql, description: f.description }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['filters'] }),
  });

  const openFilter = (f: SavedFilter) =>
    navigate(`/issues?filterId=${f.id}&mode=jql&jql=${encodeURIComponent(f.jql)}`);

  return (
    <div className="px-6 py-5 max-w-7xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs text-atl-n-200 mb-0.5">Filters</div>
          <h1 className="text-xl font-semibold text-atl-n-800">Manage filters</h1>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter name"
            className="h-8 w-56 px-3 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none"
          />
          {/* Jira flow: filters are created via "Save as" in the navigator. */}
          <Link
            to="/issues"
            className="h-8 px-3 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400 inline-flex items-center"
          >
            Create filter
          </Link>
        </div>
      </div>

      {isLoading && <p className="text-sm text-atl-n-200 py-6">Loading filters…</p>}
      {!isLoading && (filters ?? []).length === 0 && (
        <div className="border border-atl-n-30 rounded">
          <EmptyState
            title="No filters yet"
            description={
              <>
                Build a query in{' '}
                <Link to="/issues" className="text-atl-b-300 hover:underline">advanced search</Link>{' '}
                and click "Save as".
              </>
            }
          />
        </div>
      )}

      {(filters ?? []).length > 0 && (
        <div className="border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-atl-n-10 border-b border-atl-n-30 text-left">
                <th className="px-3 py-2 w-8" />
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Name</th>
                <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">JQL</th>
                <th className="px-3 py-2 w-32 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Owner</th>
                <th className="px-3 py-2 w-24 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Shared</th>
                <th className="px-3 py-2 w-20" />
              </tr>
            </thead>
            <tbody>
              {(filters ?? []).map((f) => (
                <Fragment key={f.id}>
                  <tr className="border-b border-atl-n-30 hover:bg-atl-n-10">
                    <td className="px-3 py-2">
                      <Star active={f.favourite} onClick={() => fav.mutate({ id: f.id, f: !f.favourite })} />
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => openFilter(f)} className="text-atl-b-300 hover:underline font-medium">
                        {f.name}
                      </button>
                      {f.description && <div className="text-xs text-atl-n-200">{f.description}</div>}
                    </td>
                  <td className="px-3 py-2 font-mono text-xs text-atl-n-400 max-w-0 truncate" title={f.jql}>
                    {f.jql}
                  </td>
                  <td className="px-3 py-2 text-atl-n-500">{f.owner.displayName}</td>
                  <td className="px-3 py-2 text-atl-n-400">
                    {f.owner.accountId === me?.accountId ? (
                      <button
                        onClick={() => setShareOpen(shareOpen === f.id ? null : f.id)}
                        className="text-atl-b-300 hover:underline"
                      >
                        {(f.sharePermissions ?? []).length === 0
                          ? 'Private'
                          : (f.sharePermissions ?? []).map(permLabel).join(', ')}
                      </button>
                    ) : (
                      (f.sharePermissions ?? []).length === 0
                        ? 'Private'
                        : (f.sharePermissions ?? []).map(permLabel).join(', ')
                    )}
                  </td>
                  <td className="px-3 py-2 text-right space-x-3 whitespace-nowrap">
                    <button
                      onClick={() => copy.mutate(f)}
                      className="text-xs text-atl-b-300 hover:underline"
                    >
                      Copy
                    </button>
                    {(f.owner.accountId === me?.accountId || me?.isAdmin) && (
                      <>
                        <button
                          onClick={() => setEditFilter(f)}
                          className="text-xs text-atl-b-300 hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setOwnerTarget(f)}
                          className="text-xs text-atl-b-300 hover:underline"
                        >
                          Change owner
                        </button>
                        <button
                          onClick={() => setDeleteTarget(f)}
                          className="text-xs text-atl-r-400 hover:underline"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                  </tr>
                  {shareOpen === f.id && (
                    <tr className="border-b border-atl-n-30 last:border-0 bg-atl-n-10/40">
                      <td colSpan={6} className="px-4 py-3">
                        <ShareEditor filter={f} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EditFilterDialog filter={editFilter} onClose={() => setEditFilter(null)} />
      <ChangeOwnerDialog
        filter={ownerTarget}
        isAdmin={Boolean(me?.isAdmin)}
        onClose={() => setOwnerTarget(null)}
        onDone={() => {
          setOwnerTarget(null);
          queryClient.invalidateQueries({ queryKey: ['filters'] });
        }}
      />
      <DeleteFilterDialog
        filter={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDelete={() => deleteTarget && del.mutate(deleteTarget.id)}
        error={del.isError ? (del.error as Error).message : null}
      />
    </div>
  );
}

/** UB-016 — Jira "Change owner": admins get the full user list; everyone
 *  else searches the open /user/search directory. Both store accountId. */
function ChangeOwnerDialog({
  filter,
  isAdmin,
  onClose,
  onDone,
}: {
  filter: SavedFilter | null;
  isAdmin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState('');
  const { data: users } = useQuery({
    queryKey: ['admin-users'],
    queryFn: fetchAdminUsers,
    enabled: isAdmin && Boolean(filter),
  });
  const change = useMutation({
    mutationFn: () => updateFilter(filter!.id, { ownerAccountId: accountId }),
    onSuccess: onDone,
  });
  if (!filter) return null;
  return (
    <Modal open onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-xl font-semibold text-atl-n-800">Change owner of {filter.name}</h2>
      </div>
      <div className="px-6 py-4 space-y-3">
        {isAdmin ? (
          <label className="block text-sm">
            <span className="text-atl-n-400">New owner</span>
            <select
              className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm bg-atl-paper"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Select a user…</option>
              {(users ?? []).map((u) => (
                <option key={u.accountId} value={u.accountId}>
                  {u.displayName} ({u.emailAddress ?? u.accountId})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="block text-sm">
            <span className="text-atl-n-400">New owner</span>
            <div className="mt-1">
              <UserPicker
                search={searchUsers}
                value={accountId}
                onChange={(id) => setAccountId(id)}
                placeholder="Search people…"
              />
            </div>
          </div>
        )}
        {change.isError && (
          <p className="text-xs text-atl-r-400">{(change.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20">
            Cancel
          </button>
          <button
            type="button"
            disabled={!accountId || change.isPending}
            onClick={() => change.mutate()}
            className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
          >
            {change.isPending ? 'Saving…' : 'Change owner'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
