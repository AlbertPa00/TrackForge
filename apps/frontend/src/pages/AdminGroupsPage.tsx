// 021 US1 — /admin/groups: group CRUD + member management.
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createGroup, deleteGroup, fetchGroupMembers,
  addGroupMember, removeGroupMember, searchUsers,
  fetchProjects, fetchProjectRoles, fetchProjectRoleActors,
  addProjectRoleActors, removeProjectRoleActor,
  ApiError,
} from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import UserPicker from '../components/UserPicker.js';
import UserAvatar from '../components/UserAvatar.js';
import { usePagedGroups, PagedGroupsFooter } from '../hooks/usePagedGroups.js';
import { useFlag } from '../components/Flag.js';
import { imeComposing } from '../lib/ime.js';

function MembersPanel({ group }: { group: string }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const [pick, setPick] = useState('');
  const [pickName, setPickName] = useState('');
  // Members list: server-filtered search + "show more" paging (big groups
  // used to silently truncate at the first 100 rows).
  const [memberQuery, setMemberQuery] = useState('');
  const [debouncedMember, setDebouncedMember] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedMember(memberQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [memberQuery]);
  const members = useInfiniteQuery({
    queryKey: ['group-members', group, debouncedMember],
    queryFn: ({ pageParam }) => fetchGroupMembers(group, pageParam, debouncedMember),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.isLast ? undefined : last.startAt + last.values.length),
  });
  const acc = members.data?.pages.flatMap((p) => p.values) ?? [];
  const lastPage = members.data?.pages.at(-1);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['group-members', group] });
    void qc.invalidateQueries({ queryKey: ['admin-groups'] });
  };
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Update failed');
  const add = useMutation({
    mutationFn: (accountId: string) => addGroupMember(group, accountId),
    onSuccess: () => { flag.success(`${pickName || 'User'} added to ${group}`); invalidate(); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (accountId: string) => removeGroupMember(group, accountId),
    onSuccess: () => { flag.success('Member removed'); invalidate(); },
    onError,
  });

  const memberIds = new Set(acc.map((m) => m.accountId));

  return (
    <div className="mt-3 bg-atl-paper border border-atl-n-30 rounded">
      <div className="px-4 py-2 border-b border-atl-n-30 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm font-medium text-atl-n-800">
          Members of {group}
          {lastPage != null && <span className="ml-1 text-xs font-normal text-atl-n-200">({lastPage.total})</span>}
        </span>
        <div className="flex gap-2 items-center">
          <input
            type="search"
            value={memberQuery}
            onChange={(e) => setMemberQuery(e.target.value)}
            placeholder="Filter members…"
            aria-label="Filter members"
            className="h-8 w-44 rounded-[3px] border border-atl-n-40 px-2 text-sm focus:border-atl-b-300 outline-none"
          />
          <div className="w-64">
            <UserPicker
              search={(q) => searchUsers(q).then((us) => us.filter((u) => !memberIds.has(u.accountId)))}
              value={pick}
              onChange={(id, u) => { setPick(id); setPickName(u?.displayName ?? ''); }}
              placeholder="Search people to add…"
            />
          </div>
          <button
            className="px-2.5 py-1 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
            disabled={!pick || add.isPending}
            onClick={() => { add.mutate(pick); setPick(''); }}
          >
            Add
          </button>
        </div>
      </div>
      {members.isLoading && <div className="px-4 py-3 text-sm text-atl-n-200">Loading…</div>}
      {!members.isLoading && acc.length === 0 && (
        <div className="px-4 py-3 text-sm text-atl-n-200">
          {debouncedMember ? `No members match "${debouncedMember}".` : 'No members.'}
        </div>
      )}
      <ul>
        {acc.map((m) => (
          <li key={m.accountId} className="px-4 py-2 border-b border-atl-n-20 last:border-0 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-atl-n-800">
              <UserAvatar displayName={m.displayName} size={24} />
              {m.displayName}
              {m.active === false && <span className="ml-1 text-[11px] text-atl-n-200">(inactive)</span>}
            </span>
            <button
              className="text-sm text-atl-r-400 hover:underline"
              disabled={remove.isPending}
              onClick={() => remove.mutate(m.accountId)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {members.hasNextPage && (
        <div className="border-t border-atl-n-20 px-4 py-2 text-center">
          <button
            type="button"
            disabled={members.isFetchingNextPage}
            onClick={() => void members.fetchNextPage()}
            className="text-sm text-atl-b-300 hover:underline disabled:opacity-50"
          >
            {members.isFetchingNextPage ? 'Loading…' : `Show more (${acc.length} of ${lastPage?.total ?? acc.length})`}
          </button>
        </div>
      )}
    </div>
  );
}

/** Project-permission grants for a group: pick a project, see the roles the
 *  group holds there, add or remove it. "Administrators" = project admin. */
function ProjectRolesPanel({ group }: { group: string }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const [projectKey, setProjectKey] = useState('');
  const [roleId, setRoleId] = useState('');

  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const roles = useQuery({
    queryKey: ['project-roles', projectKey],
    queryFn: () => fetchProjectRoles(projectKey),
    enabled: Boolean(projectKey),
  });
  // Jira returns {roleName: ".../role/{id}"} — the id is the URL tail.
  const roleList = Object.entries(roles.data ?? {}).map(([name, url]) => ({
    name,
    id: url.split('/').filter(Boolean).pop()!,
  }));
  const actors = useQueries({
    queries: roleList.map((r) => ({
      queryKey: ['project-role-actors', projectKey, r.id],
      queryFn: () => fetchProjectRoleActors(projectKey, r.id),
    })),
  });

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['project-role-actors', projectKey] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Update failed');
  const add = useMutation({
    mutationFn: () => addProjectRoleActors(projectKey, roleId, { group: [group] }),
    onSuccess: () => { flag.success(`${group} added to ${projectKey} role`); invalidate(); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (rid: string) => removeProjectRoleActor(projectKey, rid, { group }),
    onSuccess: () => { flag.success(`${group} removed from ${projectKey} role`); invalidate(); },
    onError,
  });

  const memberOf = new Map<string, string>(); // roleId -> roleName where group is an actor
  roleList.forEach((r, i) => {
    const a = actors[i]?.data;
    if (a?.actors.some((x) => x.type === 'atlassian-group-role-actor' && x.name === group)) {
      memberOf.set(r.id, r.name);
    }
  });
  const addable = roleList.filter((r) => !memberOf.has(r.id));

  return (
    <div className="mt-3 bg-atl-paper border border-atl-n-30 rounded">
      <div className="px-4 py-2 border-b border-atl-n-30 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-sm font-medium text-atl-n-800">Project roles for {group}</span>
        <div className="flex gap-2 items-center flex-wrap">
          <select
            className="border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm bg-atl-paper"
            value={projectKey}
            onChange={(e) => { setProjectKey(e.target.value); setRoleId(''); }}
          >
            <option value="">Select a project…</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.key} value={p.key}>{p.name} ({p.key})</option>
            ))}
          </select>
          {projectKey && (
            <>
              <select
                className="border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm bg-atl-paper"
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                disabled={addable.length === 0}
              >
                <option value="">
                  {addable.length ? 'Select a role…' : 'Already in every role'}
                </option>
                {addable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}{r.name === 'Administrators' ? ' (project admin)' : ''}
                  </option>
                ))}
              </select>
              <button
                className="px-2.5 py-1 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
                disabled={!roleId || add.isPending}
                onClick={() => { add.mutate(); }}
              >
                Add to role
              </button>
            </>
          )}
        </div>
      </div>
      {projectKey && (
        <ul>
          {memberOf.size === 0 && !actors.some((a) => a.isLoading) && (
            <li className="px-4 py-3 text-sm text-atl-n-200">
              {group} has no roles in {projectKey} — it gets no project permissions there.
            </li>
          )}
          {[...memberOf.entries()].map(([rid, name]) => (
            <li key={rid} className="px-4 py-2 border-b border-atl-n-20 last:border-0 flex items-center justify-between text-sm">
              <span className="text-atl-n-800">
                {name}
                {name === 'Administrators' && (
                  <span className="ml-2 text-[11px] font-medium text-atl-b-400 bg-atl-b-50 rounded px-1.5 py-0.5">
                    project admin
                  </span>
                )}
              </span>
              <button
                className="text-sm text-atl-r-400 hover:underline"
                disabled={remove.isPending}
                onClick={() => remove.mutate(rid)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {!projectKey && (
        <div className="px-4 py-3 text-sm text-atl-n-200">
          Pick a project to grant this group a role — e.g. Administrators gives its members project-admin rights.
        </div>
      )}
    </div>
  );
}

export default function AdminGroupsPage() {
  const qc = useQueryClient();
  const flag = useFlag();
  // Server-side name filter + paging — the picker no longer truncates the
  // table at the first 100 groups; the hook debounces the input.
  const [groupQuery, setGroupQuery] = useState('');
  const groups = usePagedGroups(groupQuery);
  const [name, setName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-groups'] });
  const create = useMutation({
    mutationFn: () => createGroup(name.trim()),
    onSuccess: () => { flag.success(`Group ${name.trim()} created`); setName(''); invalidate(); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Create failed'),
  });
  const del = useMutation({
    mutationFn: (g: string) => deleteGroup(g),
    onSuccess: (_d, g) => { flag.success(`Group ${g} deleted`); invalidate(); setConfirmDelete(null); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Groups</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">Groups drive permission-scheme and project-role membership.</p>

      <div className="flex gap-2 mb-4">
        <input
          className="w-72 border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm"
          placeholder="New group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e) && name.trim()) create.mutate(); }}
        />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create group
        </button>
      </div>
      {create.isError && <div className="mb-3 text-sm text-atl-r-400">{(create.error as Error).message}</div>}

      <input
        type="search"
        className="w-72 border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm mb-4"
        placeholder="Filter groups by name…"
        aria-label="Filter groups"
        value={groupQuery}
        onChange={(e) => setGroupQuery(e.target.value)}
      />

      {groups.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {!groups.isLoading && groups.groups.length === 0 && (
        <EmptyState
          title={groups.debounced ? 'No groups found' : 'No groups yet'}
          description={groups.debounced ? `No group matches "${groups.debounced}".` : undefined}
        />
      )}

      {groups.groups.length > 0 && (
        <div className="bg-atl-paper border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Members</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.groups.map((g) => (
                <tr key={g.name} className="border-b border-atl-n-20 last:border-0">
                  <td className="px-4 py-2 text-atl-n-800">{g.name}</td>
                  <td className="px-4 py-2 text-atl-n-500">{g.memberCount}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === g.name ? null : g.name)}>
                      {expanded === g.name ? 'Hide' : 'Members & roles'}
                    </button>
                    <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDelete(g.name)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {groups.hasNextPage && (
            <PagedGroupsFooter
              loaded={groups.groups.length}
              total={groups.total}
              isFetchingNextPage={groups.isFetchingNextPage}
              fetchNextPage={() => void groups.fetchNextPage()}
            />
          )}
        </div>
      )}
      {expanded && (
        <>
          <MembersPanel group={expanded} />
          <ProjectRolesPanel group={expanded} />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete ?? ''}?`}
        body="Members lose this group's permissions immediately. Deletion is refused while the group is still referenced by permission grants or project roles."
        confirmLabel="Delete group"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDelete) del.mutate(confirmDelete); }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
