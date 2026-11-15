import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  assignProjectWorkflow,
  deleteProject,
  previewDeleteProject,
  fetchMyself,
  fetchMyPermissions,
  fetchProject,
  fetchProjectRoleActors,
  fetchRoleDefs,
  fetchWorkflow,
  fetchWorkflows,
  addProjectRoleActors,
  removeProjectRoleActor,
  searchAssignableUsers,
  updateProject,
  fetchArchivedIssues,
  restoreIssue,
  type ArchivedIssueRow,
  type UserRef,
} from '../api/client.js';
import UserPicker from '../components/UserPicker.js';
import GroupPicker from '../components/GroupPicker.js';
import {
  assignProjectScheme,
  fetchFieldConfigurationSchemes,
  fetchIssueSecuritySchemes,
  fetchIssueTypeSchemes,
  fetchIssueTypeScreenSchemes,
  fetchPermissionSchemes,
  fetchProjectCategories,
  fetchWorkflowSchemes,
  putProjectPermissionScheme,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import UserAvatar from '../components/UserAvatar.js';
import { PeopleIcon, PersonIcon } from '../components/icons.js';
import { PROJECT_SWATCHES } from '../lib/palette.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';
const COLORS = PROJECT_SWATCHES;

/** Statuses in `from` that don't exist in `to` — these need an explicit mapping. */
function workflowOrphanStatuses(
  from: { statuses: { id: string; name: string }[] },
  to: { statuses: { id: string; name: string }[] }
) {
  const targetIds = new Set(to.statuses.map((s) => s.id));
  const targetNames = new Set(to.statuses.map((s) => s.name));
  return from.statuses.filter((s) => !targetIds.has(s.id) && !targetNames.has(s.name));
}

/** Sprint 015 US4 — project People tab: role membership without scheme knowledge. */
function PeopleSection({ projectKey, canAdmin }: { projectKey: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const actors = useQuery({
    queryKey: ['projectRoles', projectKey],
    queryFn: async () => {
      const defs = await fetchRoleDefs();
      return Promise.all(defs.map((r) => fetchProjectRoleActors(projectKey, r.id)));
    },
    // Role-actor reads are project-admin only (Jira /project/{k}/role contract).
    enabled: canAdmin,
  });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  const [groupName, setGroupName] = useState<Record<string, string>>({});
  const [userId, setUserId] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['projectRoles', projectKey] });
    qc.invalidateQueries({ queryKey: ['assignable', projectKey] });
  };
  const add = useMutation({
    mutationFn: (a: { roleId: string; body: { user?: string[]; group?: string[] } }) =>
      addProjectRoleActors(projectKey, a.roleId, a.body),
    onSuccess: () => { setErr(''); setGroupName({}); setUserId({}); invalidate(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const remove = useMutation({
    mutationFn: (a: { roleId: string; ref: { user?: string; group?: string } }) =>
      removeProjectRoleActor(projectKey, a.roleId, a.ref),
    onSuccess: () => { setErr(''); invalidate(); },
    onError: (e) => setErr((e as ApiError).message),
  });

  if (!actors.data) return null;
  return (
    <section className="mt-6 bg-atl-paper border border-atl-n-30 rounded">
      <div className="px-4 py-2.5 border-b border-atl-n-30 flex items-center justify-between">
        <h2 className="text-sm font-medium text-atl-n-800">People</h2>
        <span className="text-xs text-atl-n-200">Users and groups assigned to project roles</span>
      </div>
      {err && <div className="mx-4 mt-3 rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{err}</div>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
            <th className="px-4 py-2 w-40">Role</th>
            <th className="px-4 py-2">Members</th>
            {canAdmin && <th className="px-4 py-2 w-[420px]">Add to role</th>}
          </tr>
        </thead>
        <tbody>
          {actors.data.map((role) => (
            <tr key={role.id} className="border-b border-atl-n-20 last:border-0 align-top">
              <td className="px-4 py-3 font-medium text-atl-n-800">{role.name}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {role.actors.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-atl-n-20 pl-1.5 pr-2 py-0.5 text-xs text-atl-n-700">
                      {a.type === 'atlassian-group-role-actor' ? <PeopleIcon size={13} className="inline-block align-[-2px]" /> : <PersonIcon size={13} className="inline-block align-[-2px]" />} {a.displayName}
                      {a.type === 'atlassian-group-role-actor' && <span className="text-atl-n-100">(group)</span>}
                      {canAdmin && (
                        <button
                          type="button"
                          aria-label={`Remove ${a.displayName}`}
                          className="text-atl-n-100 hover:text-atl-r-400"
                          onClick={() =>
                            remove.mutate({
                              roleId: role.id,
                              ref: a.actorUser ? { user: a.actorUser.accountId } : { group: a.name },
                            })
                          }
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {role.actors.length === 0 && <span className="text-xs text-atl-n-100">No members</span>}
                </div>
              </td>
              {canAdmin && (
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="w-44">
                      <UserPicker
                        projectKey={projectKey}
                        value={userId[role.id] ?? ''}
                        onChange={(id) => setUserId((m) => ({ ...m, [role.id]: id }))}
                        placeholder="Add user…"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!userId[role.id]}
                      onClick={() => add.mutate({ roleId: role.id, body: { user: [userId[role.id]!] } })}
                      className="h-9 px-2.5 rounded-[3px] bg-atl-n-20 text-xs text-atl-n-700 hover:bg-atl-n-30 disabled:opacity-40"
                    >
                      Add
                    </button>
                    <div className="w-44">
                      <GroupPicker
                        canBrowse={me?.isAdmin === true}
                        value={groupName[role.id] ?? ''}
                        onChange={(v) => setGroupName((m) => ({ ...m, [role.id]: v }))}
                        placeholder="Group name…"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!groupName[role.id]?.trim()}
                      onClick={() => add.mutate({ roleId: role.id, body: { group: [groupName[role.id]!.trim()] } })}
                      className="h-9 px-2.5 rounded-[3px] bg-atl-n-20 text-xs text-atl-n-700 hover:bg-atl-n-30 disabled:opacity-40"
                    >
                      Add group
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Sprint 031 — Schemes tab: bind each scheme layer to this project. */
const SCHEME_KINDS = [
  {
    key: 'issueSecurity' as const,
    endpoint: 'issuesecurityscheme' as const,
    label: 'Issue security scheme',
    useSchemes: () => fetchIssueSecuritySchemes().then((r) => r.issueSecuritySchemes),
  },
  {
    key: 'issueType' as const,
    endpoint: 'issuetypescheme' as const,
    label: 'Issue type scheme',
    useSchemes: () => fetchIssueTypeSchemes(),
  },
  {
    key: 'issueTypeScreen' as const,
    endpoint: 'issuetypescreenscheme' as const,
    label: 'Issue type screen scheme',
    useSchemes: () => fetchIssueTypeScreenSchemes(),
  },
  {
    key: 'fieldConfiguration' as const,
    endpoint: 'fieldconfigurationscheme' as const,
    label: 'Field configuration scheme',
    useSchemes: () => fetchFieldConfigurationSchemes(),
  },
  {
    key: 'workflow' as const,
    endpoint: 'workflowscheme' as const,
    label: 'Workflow scheme',
    useSchemes: () => fetchWorkflowSchemes(),
  },
];

/** 021 US4 — permission scheme rides the Jira PUT route, not the internal POST assign. */
function PermissionSchemeSelect({ projectKey, value }: { projectKey: string; value: string | null | undefined }) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const { data } = useQuery({ queryKey: ['permissionSchemes'], queryFn: fetchPermissionSchemes });
  const assign = useMutation({
    mutationFn: (schemeId: string | null) => putProjectPermissionScheme(projectKey, schemeId),
    onSuccess: () => {
      setErr('');
      qc.invalidateQueries({ queryKey: ['project', projectKey] });
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  const options = (data?.permissionSchemes ?? []).map((s) => ({ id: s.id, name: s.name }));
  return (
    <div>
      <label className={LABEL}>Permission scheme</label>
      {err && <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 mb-1 text-sm text-atl-r-500">{err}</div>}
      <select
        className={INPUT + ' pr-8'}
        value={value ?? ''}
        disabled={assign.isPending}
        onChange={(e) => assign.mutate(e.target.value || null)}
      >
        <option value="">Default permission scheme</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
  );
}

function SchemesSection({ projectKey, schemeIds }: { projectKey: string; schemeIds: NonNullable<import('../api/client.js').Project['schemeIds']> }) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const assign = useMutation({
    mutationFn: (a: { kind: (typeof SCHEME_KINDS)[number]['endpoint']; schemeId: string | null }) =>
      assignProjectScheme(projectKey, a.kind, a.schemeId),
    onSuccess: () => {
      setErr('');
      qc.invalidateQueries({ queryKey: ['project', projectKey] });
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <section className="mt-6 border border-atl-n-30 rounded">
      <div className="px-4 py-2.5 border-b border-atl-n-30">
        <h2 className="text-xs font-semibold text-atl-n-300">Schemes</h2>
      </div>
      <div className="px-4 py-4 space-y-3">
        {err && <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{err}</div>}
        <p className="text-xs text-atl-n-200">
          Schemes control which issue types, screens, fields, workflows and security levels this project uses.
          "None" leaves the project unrestricted.
        </p>
        {SCHEME_KINDS.map((k) => (
          <SchemeSelect
            key={k.key}
            label={k.label}
            value={schemeIds[k.key]}
            fetchSchemes={k.useSchemes}
            disabled={assign.isPending}
            onChange={(schemeId) => assign.mutate({ kind: k.endpoint, schemeId })}
          />
        ))}
        <PermissionSchemeSelect projectKey={projectKey} value={schemeIds.permission} />
      </div>
    </section>
  );
}

function SchemeSelect({
  label, value, fetchSchemes, disabled, onChange,
}: {
  label: string;
  value: string | null;
  fetchSchemes: () => Promise<{ id: string; name: string }[]>;
  disabled: boolean;
  onChange: (schemeId: string | null) => void;
}) {
  const { data } = useQuery({ queryKey: ['schemes', label], queryFn: fetchSchemes });
  return (
    <div>
      <label className={LABEL}>{label}</label>
      <select
        className={INPUT}
        value={value ?? ''}
        disabled={disabled || !data}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">None</option>
        {(data ?? []).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  );
}

export default function ProjectSettingsPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', projectKey],
    queryFn: () => fetchProject(projectKey!),
    enabled: Boolean(projectKey),
    retry: false,
  });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  const { data: myPerms } = useQuery({
    queryKey: ['mypermissions', projectKey],
    queryFn: () => fetchMyPermissions({ projectKey: projectKey!, permissions: ['ADMINISTER_PROJECTS'] }),
    enabled: Boolean(projectKey),
  });
  const canAdminProject = Boolean(me?.isAdmin) || Boolean(myPerms?.permissions?.ADMINISTER_PROJECTS?.havePermission);
  const { data: people } = useQuery({
    queryKey: ['assignable', projectKey],
    queryFn: () => searchAssignableUsers(projectKey!, ''),
    enabled: Boolean(projectKey),
  });
  const { data: workflows } = useQuery({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows,
    enabled: Boolean(me?.isAdmin),
  });
  const [workflowId, setWorkflowId] = useState('');
  const [showAllWf, setShowAllWf] = useState(false);
  const { data: targetWorkflow } = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => fetchWorkflow(workflowId),
    enabled: Boolean(workflowId),
  });
  const { data: currentWorkflow } = useQuery({
    queryKey: ['workflow', project?.workflow?.id],
    queryFn: () => fetchWorkflow(project!.workflow!.id),
    enabled: Boolean(project?.workflow?.id),
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [agentGuidance, setAgentGuidance] = useState('');
  const [leadId, setLeadId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const { data: categories } = useQuery({ queryKey: ['projectCategories'], queryFn: fetchProjectCategories });
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  // Section lives in the URL — the settings sidebar (ProjectSettingsSidebar)
  // navigates by writing ?section=.
  const [searchParams] = useSearchParams();
  const section = searchParams.get('section') ?? 'details';

  const switchWorkflow = useMutation({
    mutationFn: () => assignProjectWorkflow(projectKey!, workflowId, statusMap),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectKey] });
      setStatusMap({});
      setWorkflowId('');
    },
  });

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description ?? '');
      setAgentGuidance(project.agentGuidance ?? '');
      setLeadId(project.lead?.accountId ?? '');
      setCategoryId(project.projectCategory?.id ?? '');
      setColor(project.avatarColor ?? COLORS[0]);
    }
  }, [project]);

  const save = useMutation({
    mutationFn: () =>
      updateProject(projectKey!, {
        name,
        description: description || null,
        agentGuidance: agentGuidance || null,
        avatarColor: color,
        lead: leadId ? { accountId: leadId } : null,
        categoryId: categoryId || null,
      }),
    onSuccess: (updated) => {
      qc.setQueryData(['project', projectKey], updated);
      qc.invalidateQueries({ queryKey: ['projects'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const del = useMutation({
    mutationFn: async () => {
      const preview = await previewDeleteProject(projectKey!);
      return deleteProject(projectKey!, preview.confirmToken);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      navigate('/projects');
    },
  });

  if (isLoading) return <div className="p-8 text-sm text-atl-n-200">Loading…</div>;
  if (error || !project) {
    return (
      <div className="p-8 text-sm text-atl-n-300">
        {error instanceof ApiError && error.status === 404 ? 'Project not found.' : 'Could not load project.'}
      </div>
    );
  }

  const dirty =
    name !== project.name ||
    description !== (project.description ?? '') ||
    agentGuidance !== (project.agentGuidance ?? '') ||
    leadId !== (project.lead?.accountId ?? '') ||
    categoryId !== (project.projectCategory?.id ?? '') ||
    color !== (project.avatarColor ?? COLORS[0]);

  return (
    <>
      <div className="px-8 pt-6">
        <h1 className="text-xl font-semibold text-atl-n-800 mb-1">
          {section === 'details'
            ? 'Details'
            : section === 'people'
              ? 'People'
              : section === 'schemes'
                ? 'Schemes'
                : section === 'workflow'
                  ? 'Workflow'
                  : section === 'archived'
                    ? 'Archived issues'
                    : 'Danger zone'}
        </h1>
        <p className="text-sm text-atl-n-200 mb-6">{project.name} ({project.key})</p>
      </div>
      <div className="px-8 pb-6">
        <div className="max-w-2xl min-w-0">
          {section === 'details' && (
          <section className="border border-atl-n-30 rounded">
            <div className="px-4 py-2.5 border-b border-atl-n-30">
              <h2 className="text-xs font-semibold text-atl-n-300">Details</h2>
            </div>
            <div className="px-4 py-4 space-y-4">
              {!canAdminProject && (
                <div className="rounded-[3px] border border-atl-y-300 bg-atl-y-50 px-3 py-2 text-sm text-atl-n-600">
                  You have read-only access — the Administer Projects permission is required to change these settings.
                </div>
              )}
              {save.isError && (
                <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
                  {(save.error as ApiError).message}
                </div>
              )}
              <div>
                <label className={LABEL}>Name</label>
                <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} disabled={!canAdminProject} />
              </div>
              <div>
                <label className={LABEL}>Key</label>
                <input className={INPUT + ' bg-atl-n-20 text-atl-n-300'} value={project.key} disabled />
                <p className="text-xs text-atl-n-100 mt-1">Project keys can't be changed.</p>
              </div>
              <div>
                <label className={LABEL}>Description</label>
                <textarea
                  className={INPUT + ' h-20 py-2 resize-y'}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!canAdminProject}
                />
              </div>
              <div>
                <label className={LABEL}>Agent guidance</label>
                <textarea
                  className={INPUT + ' h-20 py-2 resize-y'}
                  value={agentGuidance}
                  onChange={(e) => setAgentGuidance(e.target.value)}
                  disabled={!canAdminProject}
                  placeholder="Instructions for agents working this project — conventions, required checks, areas to avoid. Exposed to delegated agents via their session and the copilot."
                />
              </div>
              <div>
                <label className={LABEL}>Project lead</label>
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2">
                    <UserAvatar
                      displayName={(people ?? []).find((u: UserRef) => u.accountId === leadId)?.displayName}
                      size={20}
                    />
                  </span>
                  <select
                    className={INPUT + ' pl-9 pr-8'}
                    value={leadId}
                    onChange={(e) => setLeadId(e.target.value)}
                    disabled={!canAdminProject}
                  >
                    <option value="">No lead</option>
                    {/* 062 US4 — humans first; agents stay reachable but
                        separated (a bot as project lead is rare but valid). */}
                    {(people ?? []).filter((u: UserRef) => !u.agent).map((u: UserRef) => (
                      <option key={u.accountId} value={u.accountId}>
                        {u.displayName}
                      </option>
                    ))}
                    {(people ?? []).some((u: UserRef) => u.agent) && (
                      <optgroup label="Agents">
                        {(people ?? []).filter((u: UserRef) => u.agent).map((u: UserRef) => (
                          <option key={u.accountId} value={u.accountId}>
                            {u.displayName}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              </div>
              <div>
                <label className={LABEL}>Category</label>
                <select
                  className={INPUT + ' pr-8'}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  disabled={!canAdminProject}
                >
                  <option value="">No category</option>
                  {(categories ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>Avatar color</label>
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      disabled={!canAdminProject}
                      onClick={() => setColor(c)}
                      className={`h-7 w-7 rounded-[3px] border-2 ${
                        color === c ? 'border-atl-n-800' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={!dirty || save.isPending || !name.trim() || !canAdminProject}
                  onClick={() => save.mutate()}
                  className="h-9 px-4 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400 disabled:opacity-40"
                >
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
                {saved && <span className="text-xs text-atl-g-400">Saved</span>}
              </div>
            </div>
          </section>
          )}

          {section === 'people' && (
          <PeopleSection
            projectKey={project.key}
            canAdmin={canAdminProject}
          />
          )}

          {section === 'schemes' && me?.isAdmin && project.schemeIds && (
            <SchemesSection projectKey={project.key} schemeIds={project.schemeIds} />
          )}

          {section === 'workflow' && me?.isAdmin && workflows && (
            <section className="mt-6 border border-atl-n-30 rounded">
              <div className="px-4 py-2.5 border-b border-atl-n-30">
                <h2 className="text-xs font-semibold text-atl-n-300">Workflow</h2>
              </div>
              <div className="px-4 py-4 space-y-3">
                <p className="text-sm text-atl-n-600">
                  Current workflow:{' '}
                  <strong>{project.workflow?.name ?? 'None'}</strong>
                </p>
                <div>
                  <label className={LABEL}>Switch workflow</label>
                  {(() => {
                    // 062 US4 — imported Jira instances carry hundreds of
                    // status-less workflows; they can never map, so hide them.
                    const candidates = workflows.filter((w) => w.id !== project.workflow?.id);
                    const usable = candidates.filter((w) => w.statuses.length > 0);
                    const shown = showAllWf ? candidates : usable;
                    const hiddenCount = candidates.length - usable.length;
                    return (
                      <>
                        <select
                          className={INPUT}
                          value={workflowId}
                          onChange={(e) => {
                            setWorkflowId(e.target.value);
                            setStatusMap({});
                          }}
                        >
                          <option value="">Choose a workflow…</option>
                          {shown.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name} ({w.statuses.length} statuses)
                            </option>
                          ))}
                        </select>
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAllWf((v) => !v)}
                            className="mt-1 text-[11px] text-atl-b-300 hover:underline"
                          >
                            {showAllWf
                              ? 'Hide workflows with no statuses'
                              : `Show all ${candidates.length} workflows (${hiddenCount} have no statuses to map)`}
                          </button>
                        )}
                      </>
                    );
                  })()}
                </div>
                {targetWorkflow && currentWorkflow && (
                  <div className="rounded-[3px] border border-atl-n-30 bg-atl-n-10 px-3 py-2">
                    <p className="text-xs font-semibold text-atl-n-300 mb-2">Status mapping</p>
                    <p className="text-[11px] text-atl-n-200 mb-2">
                      Issues in statuses missing from "{targetWorkflow.name}" need a target status.
                    </p>
                    <div className="space-y-1.5">
                      {workflowOrphanStatuses(currentWorkflow, targetWorkflow).map((s) => (
                        <div key={s.id} className="flex items-center gap-2 text-xs">
                          <span className="w-32 font-medium text-atl-n-600">{s.name}</span>
                          <span className="text-atl-n-200">→</span>
                          <select
                            className="rounded-[3px] border border-atl-n-40 px-1.5 py-1 text-xs bg-atl-paper"
                            value={statusMap[s.id] ?? ''}
                            onChange={(e) =>
                              setStatusMap((m) => ({ ...m, [s.id]: e.target.value }))
                            }
                          >
                            <option value="">Pick status…</option>
                            {targetWorkflow.statuses.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                      {workflowOrphanStatuses(currentWorkflow, targetWorkflow).length === 0 && (
                        <p className="text-[11px] text-atl-g-500">
                          All current statuses exist in the target workflow — no remapping needed.
                        </p>
                      )}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  disabled={
                    !workflowId ||
                    switchWorkflow.isPending ||
                    (targetWorkflow && currentWorkflow
                      ? workflowOrphanStatuses(currentWorkflow, targetWorkflow).some(
                          (s) => !statusMap[s.id]
                        )
                      : true)
                  }
                  onClick={() => switchWorkflow.mutate()}
                  className="h-9 px-4 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400 disabled:opacity-40"
                >
                  {switchWorkflow.isPending ? 'Switching…' : 'Switch workflow'}
                </button>
                {switchWorkflow.isError && (
                  <p className="text-xs text-atl-r-400">{(switchWorkflow.error as ApiError).message}</p>
                )}
                {switchWorkflow.isSuccess && (
                  <p className="text-xs text-atl-g-400">
                    Switched — {switchWorkflow.data.remappedIssues} issue(s) remapped.
                  </p>
                )}
              </div>
            </section>
          )}

          {section === 'archived' && me?.isAdmin && (
            <ArchivedIssuesSection projectKey={project.key} />
          )}

          {section === 'danger' && me?.isAdmin && (
            <section className="mt-6 border border-atl-r-300 rounded">
              <div className="px-4 py-2.5 border-b border-atl-r-300 bg-atl-r-50">
                <h2 className="text-xs font-semibold text-atl-r-400">Danger zone</h2>
              </div>
              <div className="px-4 py-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-atl-n-700">Delete this project</p>
                  <p className="text-xs text-atl-n-200 mt-0.5">
                    Permanently deletes {project.key} and all of its issues, sprints, and history.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="h-9 px-4 rounded-[3px] bg-atl-r-300 text-white text-sm font-medium hover:bg-atl-r-400"
                >
                  Delete project
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)}>
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
          <h2 className="text-lg font-semibold text-atl-n-800">Delete {project.key}?</h2>
        </div>
        <div className="px-6 py-4">
          <p className="text-sm text-atl-n-600">
            This permanently deletes <strong>{project.name}</strong> and every issue in it. This can't be
            undone. Type <strong>{project.key}</strong> to confirm.
          </p>
          <input
            className={INPUT + ' mt-3'}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={project.key}
          />
          {del.isError && (
            <p className="mt-2 text-xs text-atl-r-400">{(del.error as ApiError).message}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={confirmText !== project.key || del.isPending}
              onClick={() => del.mutate()}
              className="rounded bg-atl-r-300 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-r-400 disabled:opacity-50"
            >
              {del.isPending ? 'Deleting…' : 'Delete project'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** 060 US7 — Jira DC "Incidencias archivadas": browse archived issues for
    this project and restore them (RESTORE_ISSUES / admin, enforced server-side). */
function ArchivedIssuesSection({ projectKey }: { projectKey: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['archived-issues', projectKey],
    queryFn: () => fetchArchivedIssues(projectKey),
  });
  const restore = useMutation({
    mutationFn: (key: string) => restoreIssue(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['archived-issues', projectKey] });
      void qc.invalidateQueries({ queryKey: ['project-issues'] });
      void qc.invalidateQueries({ queryKey: ['issues'] });
    },
  });

  return (
    <section className="mt-6 border border-atl-n-30 rounded">
      <div className="px-4 py-2.5 border-b border-atl-n-30">
        <h2 className="text-xs font-semibold text-atl-n-300">Archived issues</h2>
      </div>
      {isLoading && <div className="px-4 py-4 text-sm text-atl-n-200">Loading…</div>}
      {data && data.length === 0 && (
        <div className="px-4 py-4 text-sm text-atl-n-200">No archived issues in this project.</div>
      )}
      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
              <th className="px-4 py-2">Key</th>
              <th className="px-4 py-2">Summary</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Archived by</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map((i: ArchivedIssueRow) => (
              <tr key={i.id} className="border-b border-atl-n-20 last:border-0">
                <td className="px-4 py-2 text-atl-n-500">{i.project.key}-{i.issueNumber}</td>
                <td className="px-4 py-2 text-atl-n-700 max-w-[320px] truncate" title={i.summary}>{i.summary}</td>
                <td className="px-4 py-2 text-xs text-atl-n-300">{i.issueType.name}</td>
                <td className="px-4 py-2 text-xs text-atl-n-300">{i.status.name}</td>
                <td className="px-4 py-2 text-xs text-atl-n-300">{i.archivedBy?.displayName ?? '—'}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="text-sm text-atl-b-400 hover:underline disabled:opacity-50"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(`${i.project.key}-${i.issueNumber}`)}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restore.isError && (
        <p className="px-4 pb-3 text-xs text-atl-r-400">{(restore.error as ApiError).message}</p>
      )}
    </section>
  );
}
