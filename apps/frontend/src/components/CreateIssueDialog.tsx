import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  aiDraft,
  createIssue,
  fetchComponents,
  fetchCreateMetaValues,
  fetchPriorities,
  fetchProject,
  fetchProjects,
  fetchVersions,
  searchSimilarByText,
} from '../api/client.js';
import Modal from './Modal.js';
import IconSelect from './IconSelect.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import PriorityIcon from './PriorityIcon.js';
import IssuePicker from './IssuePicker.js';
import IssueKey from './IssueKey.js';
import UserPicker from './UserPicker.js';
import LabelsEditor from './LabelsEditor.js';
import EntityRefPicker, { type EntityRef } from './EntityRefPicker.js';
import { CfFormInput } from './CustomFields.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';
const SELECT = INPUT + ' pr-8';

export default function CreateIssueDialog({
  open,
  onClose,
  defaultProjectKey,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectKey?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [priority, setPriority] = useState('Medium');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState(false);
  const [debouncedSummary, setDebouncedSummary] = useState('');
  const [cfValues, setCfValues] = useState<Record<string, unknown>>({});
  const [components, setComponents] = useState<EntityRef[]>([]);
  const [fixVersions, setFixVersions] = useState<EntityRef[]>([]);
  const [affectsVersions, setAffectsVersions] = useState<EntityRef[]>([]);
  const [assignee, setAssignee] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [parentKey, setParentKey] = useState('');

  // Duplicate detection — soft-off when embeddings aren't configured.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSummary(summary.trim()), 400);
    return () => window.clearTimeout(t);
  }, [summary]);
  const { data: similar } = useQuery({
    queryKey: ['similarText', debouncedSummary, projectKey],
    queryFn: () => searchSimilarByText(debouncedSummary, projectKey || undefined),
    enabled: open && debouncedSummary.length >= 8,
    retry: false,
  });

  const draftDesc = useMutation({
    mutationFn: () => aiDraft(undefined, { summary, existing: description, projectKey }),
    onSuccess: (r) => setDescription(r.draft),
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: open,
  });
  // Types come from the *selected project's* issue-type scheme — the global
  // /issuetype list carries ~100 imported legacy types (062 US4, same as the
  // backlog inline create). Refetches when the project picker changes.
  const { data: issueTypes } = useQuery({
    queryKey: ['project', projectKey],
    queryFn: () => fetchProject(projectKey),
    select: (p) => p.issueTypes ?? [],
    enabled: open && Boolean(projectKey),
  });
  const { data: priorities } = useQuery({
    queryKey: ['priorities'],
    queryFn: fetchPriorities,
    enabled: open,
  });
  const selectedType = issueTypes?.find((t) => t.name === issueType);
  const selectedTypeId = selectedType?.id;
  // Sub-task types need a parent (backend rejects parentless sub-tasks).
  const isSubtask = Boolean(selectedType?.subtask);
  const { data: createMeta } = useQuery({
    queryKey: ['createmeta', projectKey, selectedTypeId],
    queryFn: () => fetchCreateMetaValues(projectKey, selectedTypeId!),
    enabled: open && Boolean(projectKey) && Boolean(selectedTypeId),
    staleTime: 60_000,
  });
  const cfMetas = (createMeta?.values ?? []).filter(
    (m) => (m.fieldId ?? m.key ?? '').startsWith('customfield_') && m.operations.includes('set')
  );
  const { data: projectComponents } = useQuery({
    queryKey: ['components', projectKey],
    queryFn: () => fetchComponents(projectKey),
    enabled: open && Boolean(projectKey),
  });
  const { data: projectVersions } = useQuery({
    queryKey: ['versions', projectKey],
    queryFn: () => fetchVersions(projectKey),
    enabled: open && Boolean(projectKey),
  });
  // Assignee options are fetched by UserPicker on demand.
  // Reset once per open — depending on `projects` here meant any refetch of
  // the list (e.g. invalidation after "Create another") wiped the form mid-typing.
  const resetDone = useRef(false);
  useEffect(() => {
    if (!open) {
      resetDone.current = false;
      return;
    }
    if (resetDone.current) return;
    resetDone.current = true;
    setIssueType('Task');
    setPriority('Medium');
    setSummary('');
    setDescription('');
    setTouched(false);
    setCfValues({});
    setComponents([]);
    setFixVersions([]);
    setAffectsVersions([]);
    setAssignee('');
    setLabels([]);
    setDueDate('');
    setParentKey('');
    setCreatedKeys([]);
  }, [open]);
  // Projects load async — apply the contextual default once a choice exists.
  useEffect(() => {
    if (open && !projectKey) {
      setProjectKey(defaultProjectKey ?? projects?.[0]?.key ?? '');
    }
  }, [open, projectKey, defaultProjectKey, projects]);
  // Fallbacks when the preferred defaults don't exist in this instance's
  // scheme (e.g. no "Task" type or no "Medium" priority).
  useEffect(() => {
    if (open && issueTypes?.length && !issueTypes.some((t) => t.name === issueType)) {
      setIssueType(issueTypes.find((t) => !t.subtask)?.name ?? issueTypes[0].name);
    }
  }, [open, issueTypes, issueType]);
  useEffect(() => {
    if (open && priorities?.length && !priorities.some((p) => p.name === priority)) {
      setPriority(priorities[0].name);
    }
  }, [open, priorities, priority]);

  const [createAnother, setCreateAnother] = useState(false);
  const createAnotherRef = useRef(createAnother);
  createAnotherRef.current = createAnother;
  const [createdKeys, setCreatedKeys] = useState<string[]>([]);
  const summaryRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: createIssue,
    onSuccess: (issue) => {
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (createAnotherRef.current) {
        setCreatedKeys((k) => [...k, issue.key]);
        setSummary('');
        setDescription('');
        setTouched(false);
        summaryRef.current?.focus();
      } else {
        onClose();
        navigate(`/browse/${issue.key}`);
      }
    },
  });

  const error = mutation.error as ApiError | undefined;
  const summaryEmpty = touched && !summary.trim();

  return (
    <Modal open={open} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!summary.trim() || (isSubtask && !parentKey.trim())) {
            setTouched(true);
            return;
          }
          const customFields = Object.fromEntries(
            Object.entries(cfValues).filter(([, v]) => v !== null && v !== undefined)
          );
          mutation.mutate({
            projectKey,
            summary: summary.trim(),
            description: description.trim() || undefined,
            issueTypeName: issueType,
            priorityName: priority,
            customFields: Object.keys(customFields).length ? customFields : undefined,
            components: components.map((r) => ({ id: r.id })),
            fixVersions: fixVersions.map((r) => ({ id: r.id })),
            affectsVersions: affectsVersions.map((r) => ({ id: r.id })),
            assigneeId: assignee || undefined,
            labels: labels.length ? labels : undefined,
            dueDate: dueDate || undefined,
            parentKey: parentKey || undefined,
          });
        }}
      >
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
          <h2 className="text-lg font-semibold text-atl-n-800">Create issue</h2>
          <p className="text-xs text-atl-n-200 mt-1">
            Required fields are marked with an asterisk <span className="text-atl-r-400">*</span>
          </p>
        </div>

        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {error && (
            <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
              {error.message}
            </div>
          )}

          <div>
            <label className={LABEL}>
              Project <span className="text-atl-r-400">*</span>
            </label>
            <select
              className={SELECT}
              value={projectKey}
              onChange={(e) => {
                setProjectKey(e.target.value);
                setAssignee('');
                setCfValues({});
                // Project-scoped picks don't transfer to the new project.
                setComponents([]);
                setFixVersions([]);
                setAffectsVersions([]);
                setParentKey('');
              }}
            >
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL}>Issue type</label>
            <IconSelect
              value={issueType}
              onChange={(v) => {
                setIssueType(v);
                setCfValues({}); // createmeta is per-type — drop values for the old type's fields
              }}
              options={(issueTypes ?? []).map((t) => ({
                value: t.name,
                label: t.subtask ? `${t.name} (sub-task)` : t.name,
                icon: <IssueTypeIcon name={t.name} hierarchyLevel={t.hierarchyLevel} />,
              }))}
            />
          </div>

          <div>
            <label className={LABEL}>
              Summary <span className="text-atl-r-400">*</span>
            </label>
            <input
              ref={summaryRef}
              className={`${INPUT} ${summaryEmpty ? 'border-atl-r-300' : ''}`}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onBlur={() => setTouched(true)}
              autoFocus
            />
            {summaryEmpty && (
              <p className="text-xs text-atl-r-400 mt-1">Summary is required.</p>
            )}
            {(similar?.issues.length ?? 0) > 0 && (
              <div className="mt-2 rounded border border-atl-y-300 bg-atl-y-50 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-atl-y-500 mb-1">
                  Possibly similar
                </div>
                <ul className="space-y-0.5">
                  {similar!.issues.slice(0, 4).map((s) => (
                    <li key={s.key}>
                      <Link
                        to={`/browse/${s.key}`}
                        target="_blank"
                        className="flex items-center gap-1.5 text-xs hover:underline"
                      >
                        <IssueKey issueKey={s.key} categoryKey={s.statusCategory} className="text-atl-b-300" />
                        <span className="text-atl-n-700 truncate" title={s.summary}>{s.summary}</span>
                        <span className="ml-auto text-[10px] text-atl-n-200">{s.status}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {(projectComponents?.length ?? 0) > 0 && (
            <div>
              <label className={LABEL}>Components</label>
              <EntityRefPicker
                label="Components"
                values={components}
                options={projectComponents ?? []}
                onSave={async (refs) => setComponents(refs)}
              />
            </div>
          )}

          <div>
            <label className={LABEL}>Priority</label>
            <IconSelect
              value={priority}
              onChange={setPriority}
              options={(priorities ?? []).map((p) => ({
                value: p.name,
                label: p.name,
                icon: <PriorityIcon name={p.name} />,
              }))}
            />
          </div>

          <div>
            <label className={LABEL}>Due date</label>
            <input
              type="date"
              className={INPUT}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          {/* 042 F-010: Jira create-dialog field parity. */}
          <div>
            <label className={LABEL}>Assignee</label>
            <UserPicker
              projectKey={projectKey}
              value={assignee}
              onChange={(id) => setAssignee(id)}
            />
          </div>

          {(projectVersions?.filter((v) => !v.archived).length ?? 0) > 0 && (
            <div>
              <label className={LABEL}>Fix versions</label>
              <EntityRefPicker
                label="Fix versions"
                values={fixVersions}
                options={(projectVersions ?? []).filter((v) => !v.archived)}
                onSave={async (refs) => setFixVersions(refs)}
              />
            </div>
          )}

          {(projectVersions?.filter((v) => !v.archived).length ?? 0) > 0 && (
            <div>
              <label className={LABEL}>Affects versions</label>
              <EntityRefPicker
                label="Affects versions"
                values={affectsVersions}
                options={(projectVersions ?? []).filter((v) => !v.archived)}
                onSave={async (refs) => setAffectsVersions(refs)}
              />
            </div>
          )}

          <div>
            <label className={LABEL}>Labels</label>
            <LabelsEditor labels={labels} onSave={async (l) => setLabels(l)} />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className={LABEL}>Description</label>
              <button
                type="button"
                onClick={() => draftDesc.mutate()}
                disabled={draftDesc.isPending}
                className="mb-1 inline-flex items-center gap-1 text-xs text-atl-b-300 hover:underline disabled:opacity-50"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
                </svg>
                {draftDesc.isPending ? 'Drafting…' : 'Draft with AI'}
              </button>
            </div>
            <textarea
              className={`${INPUT} h-24 py-2 resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {draftDesc.isError && (
              <p className="text-xs text-atl-r-400 mt-1">
                {draftDesc.error instanceof Error ? draftDesc.error.message : 'Draft failed'}
              </p>
            )}
          </div>

          <div>
            <label className={LABEL}>
              Parent{isSubtask && <span className="text-atl-r-400"> *</span>}
            </label>
            <IssuePicker
              value={parentKey}
              onChange={setParentKey}
              placeholder={isSubtask ? 'Parent issue (required for sub-tasks)…' : 'Parent issue key or summary…'}
              className={INPUT}
            />
            {touched && isSubtask && !parentKey.trim() && (
              <p className="text-xs text-atl-r-400 mt-1">Sub-tasks require a parent issue.</p>
            )}
          </div>

          {cfMetas.map((m) => {
            const fid = m.fieldId ?? m.key!;
            return (
              <div key={fid}>
                <label className={LABEL}>
                  {m.name}
                  {m.required && <span className="text-atl-r-400"> *</span>}
                </label>
                <CfFormInput
                  meta={m}
                  value={cfValues[fid]}
                  projectKey={projectKey}
                  onChange={(v) => setCfValues((cur) => ({ ...cur, [fid]: v }))}
                />
              </div>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t border-atl-n-30 flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm text-atl-n-500 mr-auto cursor-pointer">
            <input
              type="checkbox"
              checked={createAnother}
              onChange={(e) => setCreateAnother(e.target.checked)}
              className="accent-atl-b-400"
            />
            Create another
          </label>
          {createdKeys.length > 0 && (
            <span className="text-xs text-atl-g-400 mr-2">
              Created{' '}
              {createdKeys.map((k, i) => (
                <span key={k}>
                  {i > 0 && ', '}
                  <Link to={`/browse/${k}`} className="text-atl-b-300 hover:underline">{k}</Link>
                </span>
              ))}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-[3px] text-sm font-medium text-atl-n-500 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !projectKey}
            className="h-9 px-4 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white disabled:opacity-60"
          >
            {mutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
