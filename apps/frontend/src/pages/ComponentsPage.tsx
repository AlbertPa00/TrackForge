import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createComponent,
  deleteComponent,
  fetchComponents,
  fetchMyPermissions,
  fetchMyself,
  searchAssignableUsers,
  updateComponent,
  type Component,
  type UserRef,
} from '../api/client.js';
import EmptyState from '../components/EmptyState.js';
import Modal from '../components/Modal.js';
import PageHeader from '../components/PageHeader.js';
import RowMenu from '../components/RowMenu.js';
import UserAvatar from '../components/UserAvatar.js';
import UserHoverCard from '../components/UserHoverCard.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';

const ASSIGNEE_TYPES = [
  { value: 'PROJECT_DEFAULT', label: 'Project default' },
  { value: 'COMPONENT_LEAD', label: 'Component lead' },
  { value: 'PROJECT_LEAD', label: 'Project lead' },
  { value: 'UNASSIGNED', label: 'Unassigned' },
] as const;

export default function ComponentsPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const qc = useQueryClient();
  const { data: components } = useQuery({
    queryKey: ['components', projectKey],
    queryFn: () => fetchComponents(projectKey!),
    enabled: Boolean(projectKey),
  });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  const { data: myPerms } = useQuery({
    queryKey: ['mypermissions', projectKey],
    queryFn: () => fetchMyPermissions({ projectKey: projectKey!, permissions: ['ADMINISTER_PROJECTS'] }),
    enabled: Boolean(projectKey),
  });
  const canAdmin = Boolean(me?.isAdmin) || Boolean(myPerms?.permissions?.ADMINISTER_PROJECTS?.havePermission);
  const { data: people } = useQuery({
    queryKey: ['assignable', projectKey],
    queryFn: () => searchAssignableUsers(projectKey!, ''),
    enabled: Boolean(projectKey),
  });

  const [editing, setEditing] = useState<Component | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Component | null>(null);
  const [swapTo, setSwapTo] = useState('');
  const [err, setErr] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['components', projectKey] });
  const del = useMutation({
    mutationFn: (c: Component) => deleteComponent(c.id, swapTo || undefined),
    onSuccess: () => { setDeleting(null); setSwapTo(''); invalidate(); },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <div className="px-6 py-5 max-w-4xl">
      <PageHeader
        crumbs={[{ label: 'Projects' }, { label: projectKey ?? '' }]}
        title="Components"
        actions={
          canAdmin ? (
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="h-8 px-3 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400"
            >
              Create component
            </button>
          ) : undefined
        }
      />
      <p className="text-sm text-atl-n-200 mb-6">
        Components group issues within {projectKey}. Issues in a component can default to the component lead.
      </p>

      <div className="border border-atl-n-30 rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-atl-n-30 text-left text-xs text-atl-n-300">
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">Lead</th>
              <th className="px-4 py-2.5 font-semibold">Default assignee</th>
              <th className="px-4 py-2.5 font-semibold text-right">Issues</th>
              {canAdmin && <th className="px-4 py-2.5 font-semibold text-right w-24">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {(components ?? []).map((c) => (
              <tr key={c.id} className="border-b border-atl-n-20 last:border-0 hover:bg-atl-n-10">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-atl-n-800">{c.name}</div>
                  {c.description && <div className="text-xs text-atl-n-200 mt-0.5">{c.description}</div>}
                </td>
                <td className="px-4 py-2.5">
                  {c.lead ? (
                    <UserHoverCard user={c.lead}>
                      <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
                        <UserAvatar displayName={c.lead.displayName} size={20} />
                        <span className="text-atl-n-600 truncate" title={c.lead.displayName}>{c.lead.displayName}</span>
                      </span>
                    </UserHoverCard>
                  ) : (
                    <span className="text-atl-n-100">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-atl-n-600">
                  {ASSIGNEE_TYPES.find((t) => t.value === c.assigneeType)?.label ?? 'Project default'}
                </td>
                <td className="px-4 py-2.5 text-right text-atl-n-600">
                  {(c.issueCount ?? 0) > 0 ? (
                    <Link
                      to={`/issues?mode=jql&jql=${encodeURIComponent(`project = "${projectKey}" AND component = "${c.name}"`)}`}
                      className="text-atl-b-400 hover:underline"
                      title={`Issues in ${c.name}`}
                    >
                      {c.issueCount}
                    </Link>
                  ) : (
                    0
                  )}
                </td>
                {canAdmin && (
                  <td className="px-4 py-2.5 text-right">
                    <RowMenu
                      ariaLabel={`Actions for ${c.name}`}
                      items={[
                        { label: 'Edit', onClick: () => setEditing(c) },
                        { label: 'Delete', onClick: () => setDeleting(c), danger: true },
                      ]}
                    />
                  </td>
                )}
              </tr>
            ))}
            {components?.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    title="No components yet"
                    description={canAdmin ? 'Create one to start grouping issues.' : undefined}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ComponentModal
        editing={editing}
        people={people ?? []}
        projectKey={projectKey!}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />

      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)}>
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
          <h2 className="text-lg font-semibold text-atl-n-800">Delete {deleting?.name}?</h2>
        </div>
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-atl-n-600">
            {deleting?.issueCount
              ? `${deleting.issueCount} issue(s) reference this component.`
              : 'No issues reference this component.'}
          </p>
          {(deleting?.issueCount ?? 0) > 0 && (
            <div>
              <label className={LABEL}>Move issues to another component (optional)</label>
              <select className={INPUT} value={swapTo} onChange={(e) => setSwapTo(e.target.value)}>
                <option value="">Just remove the reference</option>
                {(components ?? []).filter((c) => c.id !== deleting?.id).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          {err && <p className="text-xs text-atl-r-400">{err}</p>}
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button type="button" onClick={() => setDeleting(null)} className="h-8 px-3 rounded-[3px] bg-atl-n-20 text-sm text-atl-n-700 hover:bg-atl-n-30">
            Cancel
          </button>
          <button
            type="button"
            disabled={del.isPending}
            onClick={() => deleting && del.mutate(deleting)}
            className="h-8 px-3 rounded-[3px] bg-atl-r-300 text-white text-sm font-medium hover:bg-atl-r-400 disabled:opacity-40"
          >
            {del.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function ComponentModal({
  editing,
  people,
  projectKey,
  onClose,
  onSaved,
}: {
  editing: Component | 'new' | null;
  people: UserRef[];
  projectKey: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = editing === 'new';
  const c = isNew ? null : editing;
  const [name, setName] = useState(c?.name ?? '');
  const [description, setDescription] = useState(c?.description ?? '');
  const [leadId, setLeadId] = useState(c?.lead?.accountId ?? '');
  const [assigneeType, setAssigneeType] = useState(c?.assigneeType ?? 'PROJECT_DEFAULT');
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? createComponent({
            project: projectKey,
            name,
            description: description || undefined,
            leadAccountId: leadId || undefined,
            assigneeType,
          })
        : updateComponent(c!.id, {
            name,
            description,
            leadAccountId: leadId,
            assigneeType,
          }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal open={Boolean(editing)} onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-lg font-semibold text-atl-n-800">{isNew ? 'Create component' : `Edit ${c?.name}`}</h2>
      </div>
      <div className="px-6 py-4 space-y-4">
        {err && <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{err}</div>}
        <div>
          <label className={LABEL}>Name</label>
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className={LABEL}>Component lead</label>
          <select className={INPUT} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">No lead</option>
            {people.map((u) => (
              <option key={u.accountId} value={u.accountId}>{u.displayName}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL}>Description</label>
          <textarea className={INPUT + ' h-16 py-2 resize-y'} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className={LABEL}>Default assignee</label>
          <select className={INPUT} value={assigneeType} onChange={(e) => setAssigneeType(e.target.value as typeof assigneeType)}>
            {ASSIGNEE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <p className="text-[11px] text-atl-n-200 mt-1">
            Assignee for new issues in this component when none is set.
          </p>
        </div>
      </div>
      <div className="px-6 pb-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-8 px-3 rounded-[3px] bg-atl-n-20 text-sm text-atl-n-700 hover:bg-atl-n-30">
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
          className="h-8 px-3 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400 disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
