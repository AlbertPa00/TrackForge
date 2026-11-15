// 021 US3 — /admin/schemes: permission-scheme grant tables (with grant-impact
// preview) and issue-security-scheme level editors.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchPermissionSchemes, fetchPermissionScheme, createPermissionScheme, deletePermissionScheme,
  addSchemeGrant, removeSchemeGrant, previewSchemeGrant,
  fetchAdminSecuritySchemes, createSecurityScheme, deleteSecurityScheme,
  addSecurityLevel, deleteSecurityLevel,
  fetchGroups, fetchRoleDefs, fetchAdminUsers, listCustomFields,
  fetchIssueTypeSchemes, createIssueTypeScheme, updateIssueTypeScheme, deleteIssueTypeScheme,
  fetchWorkflowSchemes, createWorkflowScheme, updateWorkflowScheme, deleteWorkflowScheme,
  fetchIssueTypes, fetchWorkflows, fetchProjects,
  ApiError, type GrantPreview, type PermissionGrant, type AdminSecurityScheme,
  type IssueTypeSchemeDetail, type WorkflowSchemeDetail,
} from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { useFlag } from '../components/Flag.js';

const PERMISSIONS = [
  'ADMINISTER_PROJECTS', 'BROWSE_PROJECTS', 'MANAGE_SPRINTS', 'VIEW_DEV_TOOLS',
  'VIEW_READONLY_WORKFLOW', 'ASSIGNABLE_USER', 'ASSIGN_ISSUES', 'CLOSE_ISSUES',
  'CREATE_ISSUES', 'DELETE_ISSUES', 'EDIT_ISSUES', 'LINK_ISSUES',
  'MODIFY_REPORTER', 'MOVE_ISSUES', 'RESOLVE_ISSUES', 'SCHEDULE_ISSUES',
  'SET_ISSUE_SECURITY', 'TRANSITION_ISSUES', 'MANAGE_WATCHERS',
  'VIEW_VOTERS_AND_WATCHERS', 'ADD_COMMENTS', 'EDIT_ALL_COMMENTS',
  'EDIT_OWN_COMMENTS', 'DELETE_ALL_COMMENTS', 'DELETE_OWN_COMMENTS',
  'CREATE_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS',
  'WORK_ON_ISSUES', 'EDIT_ALL_WORKLOGS', 'EDIT_OWN_WORKLOGS',
  'DELETE_ALL_WORKLOGS', 'DELETE_OWN_WORKLOGS', 'ARCHIVE_ISSUES', 'RESTORE_ISSUES',
];
const HOLDER_TYPES = [
  { v: 'applicationRole', l: 'Any logged-in user' },
  { v: 'group', l: 'Group' },
  { v: 'user', l: 'User' },
  { v: 'projectRole', l: 'Project role' },
  { v: 'projectLead', l: 'Project lead' },
  { v: 'reporter', l: 'Reporter' },
  { v: 'assignee', l: 'Assignee' },
  { v: 'userCustomField', l: 'User custom field' },
  { v: 'groupCustomField', l: 'Group custom field' },
];
const input = 'border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';

function HolderParamField({
  type, value, onChange,
}: { type: string; value: string; onChange: (v: string) => void }) {
  const groups = useQuery({ queryKey: ['admin-groups'], queryFn: () => fetchGroups(), enabled: type === 'group' });
  const roles = useQuery({ queryKey: ['role-defs'], queryFn: fetchRoleDefs, enabled: type === 'projectRole' });
  const users = useQuery({ queryKey: ['admin-users'], queryFn: fetchAdminUsers, enabled: type === 'user' });
  const isCf = type === 'userCustomField' || type === 'groupCustomField';
  const customFields = useQuery({ queryKey: ['admin-custom-fields'], queryFn: () => listCustomFields(false), enabled: isCf });

  if (type === 'group') {
    return (
      <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select group…</option>
        {(groups.data?.groups ?? []).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
      </select>
    );
  }
  if (type === 'projectRole') {
    return (
      <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select role…</option>
        {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    );
  }
  if (type === 'user') {
    return (
      <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select user…</option>
        {(users.data ?? []).map((u) => <option key={u.accountId} value={u.accountId}>{u.displayName}</option>)}
      </select>
    );
  }
  if (type === 'userCustomField' || type === 'groupCustomField') {
    // 061 US7 — field picker instead of guessing customfield_10000.
    const wanted = type === 'userCustomField' ? ['user'] : ['group'];
    const fields = (customFields.data?.fields ?? []).filter((f) => wanted.length === 0 || wanted.includes(f.type));
    return (
      <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select field…</option>
        {(fields.length ? fields : (customFields.data?.fields ?? [])).map((f) => (
          <option key={f.id} value={f.id}>{f.name} ({f.id})</option>
        ))}
      </select>
    );
  }
  return null;
}

function GrantEditor({ schemeId }: { schemeId: string }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const scheme = useQuery({ queryKey: ['perm-scheme', schemeId], queryFn: () => fetchPermissionScheme(schemeId) });
  const [perm, setPerm] = useState(PERMISSIONS[1]);
  const [holderType, setHolderType] = useState('applicationRole');
  const [param, setParam] = useState('');
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsParam = ['group', 'user', 'projectRole', 'userCustomField', 'groupCustomField'].includes(holderType);
  const holder = { type: holderType, ...(needsParam && param ? { parameter: param } : {}) };

  const refresh = () => void qc.invalidateQueries({ queryKey: ['perm-scheme', schemeId] });
  const add = useMutation({
    mutationFn: () => addSchemeGrant(schemeId, { permission: perm, holder }),
    onSuccess: () => { refresh(); setPreview(null); setError(null); },
    onError: (e) => setError(e instanceof ApiError ? e.errorMessages[0] ?? e.message : 'Add failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeSchemeGrant(schemeId, id),
    onSuccess: () => { flag.success('Permission grant removed'); refresh(); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Remove failed'),
  });
  const peek = useMutation({
    mutationFn: () => previewSchemeGrant(schemeId, holder),
    onSuccess: setPreview,
    onError: (e) => { setPreview(null); setError(e instanceof ApiError ? e.errorMessages[0] ?? e.message : 'Preview failed'); },
  });

  return (
    <div className="px-4 py-3 bg-atl-n-10 border-t border-atl-n-30">
      <table className="w-full text-sm mb-3">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200">
            <th className="py-1">Permission</th>
            <th className="py-1">Granted to</th>
            <th className="py-1 w-16" />
          </tr>
        </thead>
        <tbody>
          {(scheme.data?.grants ?? []).map((g: PermissionGrant) => (
            <tr key={g.id} className="border-t border-atl-n-20">
              <td className="py-1.5"><code className="text-[12px] text-atl-n-700">{g.permission}</code></td>
              <td className="py-1.5 text-atl-n-500 text-xs">
                {HOLDER_TYPES.find((h) => h.v === g.holder.type)?.l ?? g.holder.type}
                {g.holder.parameter ? ` — ${g.holder.parameter}` : ''}
              </td>
              <td className="py-1.5 text-right">
                <button className="text-xs text-atl-r-400 hover:underline" onClick={() => remove.mutate(g.id)}>Remove</button>
              </td>
            </tr>
          ))}
          {scheme.data && scheme.data.grants?.length === 0 && (
            <tr><td colSpan={3} className="py-2 text-xs text-atl-n-200">No grants — nothing is permitted.</td></tr>
          )}
        </tbody>
      </table>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Permission</span>
          <select className={`${input} block`} value={perm} onChange={(e) => setPerm(e.target.value)}>
            {PERMISSIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Grant to</span>
          <select className={`${input} block`} value={holderType} onChange={(e) => { setHolderType(e.target.value); setParam(''); setPreview(null); }}>
            {HOLDER_TYPES.map((h) => <option key={h.v} value={h.v}>{h.l}</option>)}
          </select>
        </label>
        {needsParam && <HolderParamField type={holderType} value={param} onChange={(v) => { setParam(v); setPreview(null); }} />}
        <button
          className="px-2.5 py-1.5 text-sm text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded disabled:opacity-50"
          disabled={needsParam && !param || peek.isPending}
          onClick={() => peek.mutate()}
        >
          Preview impact
        </button>
        <button
          className="px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={needsParam && !param || add.isPending}
          onClick={() => add.mutate()}
        >
          Grant
        </button>
      </div>

      {preview && (
        <div className="mt-2 text-xs text-atl-n-500 bg-atl-b-50 border border-atl-b-75 rounded px-3 py-2">
          {preview.dynamic
            ? `Dynamic holder — ${preview.detail}.`
            : `Would reach ${preview.directUserCount} user(s) directly (${preview.detail}) across ${preview.projects.length || 'no'} bound project(s).`}
        </div>
      )}
      {error && <div className="mt-2 text-sm text-atl-r-400">{error}</div>}
    </div>
  );
}

function PermissionSchemes() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['perm-schemes'], queryFn: fetchPermissionSchemes });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string; preview?: { projects: string[]; grants: number; wouldReassignTo: string } } | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['perm-schemes'] });
  const create = useMutation({
    mutationFn: () => createPermissionScheme({ name: newName.trim() }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); invalidate(); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Create failed'),
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const dry = (await deletePermissionScheme(id, true)) as { projects: string[]; grants: number; wouldReassignTo: string };
      if (dry && typeof dry === 'object' && 'wouldReassignTo' in dry) return { dry };
      await deletePermissionScheme(id);
      return { dry: undefined };
    },
    onSuccess: () => { flag.success('Permission scheme deleted'); invalidate(); setConfirmDel(null); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-72`} placeholder="New scheme name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create scheme
        </button>
      </div>
      {create.isError && <div className="mb-3 text-sm text-atl-r-400">{(create.error as Error).message}</div>}

      {schemes.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {schemes.data && schemes.data.permissionSchemes.length === 0 && <EmptyState title="No permission schemes" />}

      {(schemes.data?.permissionSchemes.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data?.permissionSchemes ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide grants' : 'Grants'}
                </button>
                <button
                  className="text-sm text-atl-r-400 hover:underline"
                  onClick={async () => {
                    const dry = (await deletePermissionScheme(s.id, true).catch(() => null)) as { projects: string[]; grants: number; wouldReassignTo: string } | null;
                    setConfirmDel({ id: s.id, name: s.name, preview: dry ?? undefined });
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            {expanded === s.id && <GrantEditor schemeId={s.id} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body={confirmDel?.preview
          ? `${confirmDel.preview.grants} grant(s) removed; ${confirmDel.preview.projects.length ? `projects ${confirmDel.preview.projects.join(', ')} reassign to ${confirmDel.preview.wouldReassignTo}` : 'no projects are bound to it'}.`
          : 'Bound projects will be reassigned to the default scheme.'}
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

function LevelMembers({ level }: { level: AdminSecurityScheme['levels'][number] }) {
  return (
    <span className="text-xs text-atl-n-500">
      {level.members.length
        ? level.members.map((m) => `${m.type}${m.parameter ? `:${m.parameter}` : ''}`).join(', ')
        : 'no members — level matches nothing'}
    </span>
  );
}

function SecuritySchemes() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['sec-schemes'], queryFn: fetchAdminSecuritySchemes });
  const groups = useQuery({ queryKey: ['admin-groups'], queryFn: () => fetchGroups() });
  const [newName, setNewName] = useState('');
  const [levelFor, setLevelFor] = useState<string | null>(null);
  const [levelForm, setLevelForm] = useState({ name: '', description: '', isDefault: false, memberGroup: '' });
  const [confirmDel, setConfirmDel] = useState<AdminSecurityScheme | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['sec-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Update failed');
  const create = useMutation({
    mutationFn: () => createSecurityScheme({ name: newName.trim() }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteSecurityScheme(id),
    onSuccess: () => { flag.success('Security scheme deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });
  const addLevel = useMutation({
    mutationFn: (schemeId: string) => addSecurityLevel(schemeId, {
      name: levelForm.name.trim(),
      description: levelForm.description || undefined,
      isDefault: levelForm.isDefault || undefined,
      members: levelForm.memberGroup ? [{ kind: 'group', ref: levelForm.memberGroup }] : [],
    }),
    onSuccess: () => { flag.success(`Level ${levelForm.name.trim()} added`); invalidate(); setLevelFor(null); setLevelForm({ name: '', description: '', isDefault: false, memberGroup: '' }); },
    onError,
  });
  const delLevel = useMutation({
    mutationFn: (id: string) => deleteSecurityLevel(id),
    onSuccess: () => { flag.success('Security level removed'); invalidate(); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-72`} placeholder="New scheme name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create scheme
        </button>
      </div>

      {schemes.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {schemes.data && schemes.data.length === 0 && <EmptyState title="No security schemes" />}

      {(schemes.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data ?? []).map((s) => (
          <div key={s.id} className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setLevelFor(levelFor === s.id ? null : s.id)}>
                  {levelFor === s.id ? 'Cancel' : 'Add level'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {s.levels.map((l) => (
                  <tr key={l.id} className="border-t border-atl-n-20">
                    <td className="py-1.5 text-atl-n-800">
                      {l.name}
                      {l.isDefault && <span className="ml-2 text-[11px] font-medium text-atl-b-400 bg-atl-b-50 rounded px-1.5 py-0.5">default</span>}
                    </td>
                    <td className="py-1.5"><LevelMembers level={l} /></td>
                    <td className="py-1.5 text-right w-16">
                      <button className="text-xs text-atl-r-400 hover:underline" onClick={() => delLevel.mutate(l.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
                {s.levels.length === 0 && <tr><td className="py-2 text-xs text-atl-n-200">No levels — issues are unrestricted under this scheme.</td></tr>}
              </tbody>
            </table>
            {levelFor === s.id && (
              <div className="mt-2 flex flex-wrap items-end gap-2 bg-atl-n-10 rounded px-3 py-3">
                <label className="block">
                  <span className="text-xs font-medium text-atl-n-200">Level name</span>
                  <input className={`${input} block`} value={levelForm.name} onChange={(e) => setLevelForm({ ...levelForm, name: e.target.value })} />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-atl-n-200">Description</span>
                  <input className={`${input} block`} value={levelForm.description} onChange={(e) => setLevelForm({ ...levelForm, description: e.target.value })} />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-atl-n-200">Member group</span>
                  <select className={`${input} block`} value={levelForm.memberGroup} onChange={(e) => setLevelForm({ ...levelForm, memberGroup: e.target.value })}>
                    <option value="">—</option>
                    {(groups.data?.groups ?? []).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-sm text-atl-n-500">
                  <input type="checkbox" checked={levelForm.isDefault} onChange={(e) => setLevelForm({ ...levelForm, isDefault: e.target.checked })} />
                  Default
                </label>
                <button
                  className="px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
                  disabled={!levelForm.name.trim() || addLevel.isPending}
                  onClick={() => addLevel.mutate(s.id)}
                >
                  Add level
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body="Projects bound to this scheme lose their issue-security restriction."
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

// ---------- 060 US1 — issue type schemes ----------

/** Scheme-expanded editor: rename, ordered type list, bound projects. */
function IssueTypeSchemeEditor({ scheme }: { scheme: IssueTypeSchemeDetail }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const types = useQuery({ queryKey: ['issue-types'], queryFn: fetchIssueTypes });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [name, setName] = useState(scheme.name);
  const [description, setDescription] = useState(scheme.description ?? '');
  const [typeIds, setTypeIds] = useState<string[]>(scheme.issueTypeIds);
  const [addId, setAddId] = useState('');

  const bound = (projects.data ?? []).filter((p) => p.schemeIds?.issueType === scheme.id).map((p) => p.key);
  const allTypes = types.data ?? [];
  const byId = new Map(allTypes.map((t) => [t.id, t]));
  const typeName = (id: string) =>
    byId.get(id)?.name ?? scheme.issueTypes.find((t) => t.id === id)?.name ?? id;
  const typeIsSubtask = (id: string) =>
    byId.get(id)?.subtask ?? scheme.issueTypes.find((t) => t.id === id)?.isSubtask ?? false;
  const addable = allTypes.filter((t) => !typeIds.includes(t.id));

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['its-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Update failed');
  const save = useMutation({
    mutationFn: () => updateIssueTypeScheme(scheme.id, {
      name: name.trim(), description: description.trim() || undefined, issueTypeIds: typeIds,
    }),
    onSuccess: () => { flag.success(`Scheme ${name.trim()} saved`); invalidate(); },
    onError,
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= typeIds.length) return;
    const next = [...typeIds];
    [next[i], next[j]] = [next[j], next[i]];
    setTypeIds(next);
  };

  return (
    <div className="px-4 py-3 bg-atl-n-10 border-t border-atl-n-30 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Name</span>
          <input className={`${input} block`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Description</span>
          <input className={`${input} block w-64`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button
          className="px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200">
            <th className="py-1">Issue types (in order)</th>
            <th className="py-1 w-24" />
          </tr>
        </thead>
        <tbody>
          {typeIds.map((id, i) => (
            <tr key={id} className="border-t border-atl-n-20">
              <td className="py-1.5 text-atl-n-800">
                {typeName(id)}
                {typeIsSubtask(id) && <span className="ml-2 text-[11px] text-atl-n-200">sub-task</span>}
              </td>
              <td className="py-1.5 text-right space-x-2 whitespace-nowrap">
                <button className="text-xs text-atl-n-300 hover:text-atl-n-700 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button className="text-xs text-atl-n-300 hover:text-atl-n-700 disabled:opacity-30" disabled={i === typeIds.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button className="text-xs text-atl-r-400 hover:underline" onClick={() => setTypeIds(typeIds.filter((t) => t !== id))}>Remove</button>
              </td>
            </tr>
          ))}
          {typeIds.length === 0 && <tr><td colSpan={2} className="py-2 text-xs text-atl-n-200">No issue types — bound projects offer nothing until you add types.</td></tr>}
        </tbody>
      </table>
      <div className="flex items-end gap-2">
        <select className={input} value={addId} onChange={(e) => setAddId(e.target.value)}>
          <option value="">Add issue type…</option>
          {addable.map((t) => <option key={t.id} value={t.id}>{t.name}{t.subtask ? ' (sub-task)' : ''}</option>)}
        </select>
        <button
          className="px-2.5 py-1.5 text-sm text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded disabled:opacity-50"
          disabled={!addId}
          onClick={() => { setTypeIds([...typeIds, addId]); setAddId(''); }}
        >
          Add
        </button>
        <span className="text-xs text-atl-n-200 ml-auto">
          {bound.length ? `Bound to: ${bound.join(', ')}` : 'Not bound to any project'}
        </span>
      </div>
    </div>
  );
}

function IssueTypeSchemes() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['its-schemes'], queryFn: fetchIssueTypeSchemes });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [confirmDel, setConfirmDel] = useState<IssueTypeSchemeDetail | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['its-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createIssueTypeScheme({ name: newName.trim(), description: newDesc.trim() || undefined }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); setNewDesc(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteIssueTypeScheme(id),
    onSuccess: () => { flag.success('Issue type scheme deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-64`} placeholder="New scheme name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input className={`${input} w-64`} placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create scheme
        </button>
      </div>

      {schemes.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {schemes.data && schemes.data.length === 0 && <EmptyState title="No issue type schemes" />}

      {(schemes.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">
                  {s.issueTypes.length} type{s.issueTypes.length === 1 ? '' : 's'} · {s.projectsUsed} project{s.projectsUsed === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            {expanded === s.id && <IssueTypeSchemeEditor scheme={s} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body={confirmDel?.projectsUsed
          ? `Bound to ${confirmDel.projectsUsed} project(s) — unbind them first.`
          : 'The scheme is not bound to any project.'}
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

// ---------- 060 US1 — workflow schemes ----------

/** Scheme-expanded editor: default workflow + per-issue-type mappings. */
function WorkflowSchemeEditor({ scheme }: { scheme: WorkflowSchemeDetail }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: fetchWorkflows });
  const types = useQuery({ queryKey: ['issue-types'], queryFn: fetchIssueTypes });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [name, setName] = useState(scheme.name);
  const [description, setDescription] = useState(scheme.description ?? '');
  const [defaultWfId, setDefaultWfId] = useState(scheme.defaultWorkflow.id);
  const [mappings, setMappings] = useState<Record<string, string>>(
    Object.fromEntries(scheme.mappings.map((m) => [m.issueType.id, m.workflowId])),
  );

  const bound = (projects.data ?? []).filter((p) => p.schemeIds?.workflow === scheme.id).map((p) => p.key);
  const wfName = (id: string) => (workflows.data ?? []).find((w) => w.id === id)?.name ?? id;

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['wf-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Update failed');
  const save = useMutation({
    mutationFn: () => updateWorkflowScheme(scheme.id, {
      name: name.trim(), description: description.trim() || undefined,
      defaultWorkflowId: defaultWfId, mappings,
    }),
    onSuccess: () => { flag.success(`Scheme ${name.trim()} saved`); invalidate(); },
    onError,
  });

  return (
    <div className="px-4 py-3 bg-atl-n-10 border-t border-atl-n-30 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Name</span>
          <input className={`${input} block`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Description</span>
          <input className={`${input} block w-64`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Default workflow</span>
          <select className={`${input} block`} value={defaultWfId} onChange={(e) => setDefaultWfId(e.target.value)}>
            {(workflows.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <button
          className="px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!name.trim() || !defaultWfId || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200">
            <th className="py-1">Issue type</th>
            <th className="py-1">Workflow</th>
          </tr>
        </thead>
        <tbody>
          {(types.data ?? []).map((t) => (
            <tr key={t.id} className="border-t border-atl-n-20">
              <td className="py-1.5 text-atl-n-800">
                {t.name}
                {t.subtask && <span className="ml-2 text-[11px] text-atl-n-200">sub-task</span>}
              </td>
              <td className="py-1.5">
                <select
                  className={input}
                  value={mappings[t.id] ?? ''}
                  onChange={(e) => {
                    const next = { ...mappings };
                    if (e.target.value) next[t.id] = e.target.value; else delete next[t.id];
                    setMappings(next);
                  }}
                >
                  <option value="">Default ({wfName(defaultWfId)})</option>
                  {(workflows.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-xs text-atl-n-200">
        {bound.length ? `Bound to: ${bound.join(', ')} — mapping changes may require re-mapping issue statuses.` : 'Not bound to any project'}
      </div>
    </div>
  );
}

function WorkflowSchemes() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['wf-schemes'], queryFn: fetchWorkflowSchemes });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: fetchWorkflows });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newWfId, setNewWfId] = useState('');
  const [confirmDel, setConfirmDel] = useState<WorkflowSchemeDetail | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['wf-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createWorkflowScheme({ name: newName.trim(), defaultWorkflowId: newWfId }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); setNewWfId(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteWorkflowScheme(id),
    onSuccess: () => { flag.success('Workflow scheme deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-64`} placeholder="New scheme name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select className={input} value={newWfId} onChange={(e) => setNewWfId(e.target.value)}>
          <option value="">Default workflow…</option>
          {(workflows.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || !newWfId || create.isPending}
          onClick={() => create.mutate()}
        >
          Create scheme
        </button>
      </div>

      {schemes.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {schemes.data && schemes.data.length === 0 && <EmptyState title="No workflow schemes" />}

      {(schemes.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">
                  default: {s.defaultWorkflow.name} · {s.mappings.length} mapping{s.mappings.length === 1 ? '' : 's'} · {s.projectsUsed} project{s.projectsUsed === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            {expanded === s.id && <WorkflowSchemeEditor scheme={s} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body={confirmDel?.projectsUsed
          ? `Bound to ${confirmDel.projectsUsed} project(s) — unbind them first.`
          : 'The scheme is not bound to any project.'}
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

export default function AdminSchemesPage() {
  const [tab, setTab] = useState<'permission' | 'security' | 'issuetype' | 'workflow'>('permission');
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Schemes</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">Shared configuration objects — permissions, issue security, issue types, and workflows.</p>
      <div className="flex gap-1 mb-4 border-b border-atl-n-30">
        {([
          ['permission', 'Permission schemes'],
          ['security', 'Issue security schemes'],
          ['issuetype', 'Issue type schemes'],
          ['workflow', 'Workflow schemes'],
        ] as const).map(([k, l]) => (
          <button
            key={k}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-atl-b-400 text-atl-b-400' : 'border-transparent text-atl-n-300 hover:text-atl-n-500'}`}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'permission' && <PermissionSchemes />}
      {tab === 'security' && <SecuritySchemes />}
      {tab === 'issuetype' && <IssueTypeSchemes />}
      {tab === 'workflow' && <WorkflowSchemes />}
    </div>
  );
}
