import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  previewDeleteIssue,
  deleteIssue,
  cloneIssue,
  moveIssue,
  fetchProjects,
  fetchIssueTypes,
  fetchProject,
  updateIssueFields,
  type DeletePreview,
} from '../api/client.js';
import Modal from './Modal.js';
import IssuePicker from './IssuePicker.js';
import { MoreIcon } from './icons.js';
import { useFlag } from './Flag.js';
import { markIssueWrite } from '../lib/issueWrites.js';

/** 042 — seeded system CF (reserved id, docs: customFieldService SYSTEM_FIELD_ALIASES). */
const FLAG_FIELD = 'customfield_10002';

/** "…" menu on the issue page — Jira action set: flag, link, clone, move, delete. */
export default function IssueActionsMenu({
  issueKey,
  hasSubtasks,
  flagged,
  issuetypeName,
  issuetypeSubtask,
  projectKey,
  compact,
  can,
}: {
  issueKey: string;
  hasSubtasks: boolean;
  flagged?: boolean;
  issuetypeName?: string;
  issuetypeSubtask?: boolean;
  projectKey?: string;
  /** Icon-only trigger for dense surfaces (board cards). */
  compact?: boolean;
  /** Permission gate per action; everything defaults to allowed. */
  can?: { flag?: boolean; link?: boolean; clone?: boolean; move?: boolean; convert?: boolean; delete?: boolean };
}) {
  const allow = {
    flag: can?.flag ?? true,
    link: can?.link ?? true,
    clone: can?.clone ?? true,
    move: can?.move ?? true,
    convert: can?.convert ?? true,
    delete: can?.delete ?? true,
  };
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<DeletePreview | null>(null);
  const [cloning, setCloning] = useState(false);
  const [moving, setMoving] = useState(false);
  const [converting, setConverting] = useState<false | 'subtask' | 'issue'>(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const toast = useFlag();

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const del = useMutation({
    mutationFn: async () => {
      await deleteIssue(issueKey, hasSubtasks, confirming!.confirmToken);
    },
    onSuccess: () => {
      setConfirming(null);
      navigate(-1);
    },
  });

  const beginDelete = async () => {
    setOpen(false);
    const preview = await previewDeleteIssue(issueKey, hasSubtasks);
    setConfirming(preview);
  };

  const queryClient = useQueryClient();
  const isSubtaskType = Boolean(issuetypeSubtask);
  const flag = useMutation({
    mutationFn: (on: boolean) => updateIssueFields(issueKey, { [FLAG_FIELD]: on ? [{ value: 'Impediment' }] : [] }),
    onSuccess: () => {
      markIssueWrite(issueKey);
      queryClient.invalidateQueries({ queryKey: ['issue', issueKey] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });

  if (!Object.values(allow).some(Boolean)) return null;

  return (
    <div ref={ref} className="relative">
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Issue actions"
          title="Issue actions"
          className="h-6 w-6 grid place-items-center rounded text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-600"
        >
          <MoreIcon size={14} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Issue actions"
          title="Issue actions"
          className="rounded border border-atl-n-30 bg-atl-paper px-2.5 py-1 text-sm font-medium text-atl-n-500 hover:bg-atl-n-10"
        >
          ⋯
        </button>
      )}
      {open && (
        <ul className="absolute right-0 top-full z-20 mt-1 w-44 rounded border border-atl-n-30 bg-atl-paper py-1 shadow-lg">
          <li>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                const url = `${window.location.origin}/browse/${issueKey}`;
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast.success('Link copied to clipboard'))
                  .catch(() => toast.error('Could not copy link'));
              }}
              className="w-full px-3 py-1.5 text-left text-sm text-atl-n-500 hover:bg-atl-n-10"
            >
              Copy link
            </button>
          </li>
          {allow.flag && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  flag.mutate(!flagged);
                }}
                disabled={flag.isPending}
                className="w-full px-3 py-1.5 text-left text-sm text-atl-n-500 hover:bg-atl-n-10 disabled:opacity-60"
              >
                {flagged ? 'Remove flag' : 'Add flag'}
              </button>
            </li>
          )}
          {allow.link && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent(`tf:link-issue:${issueKey}`));
                  document.querySelector('[data-tf-linked-issues]')?.scrollIntoView({ block: 'center' });
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-atl-n-500 hover:bg-atl-n-10"
              >
                Link issue
              </button>
            </li>
          )}
          {allow.clone && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCloning(true);
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-atl-n-500 hover:bg-atl-n-10"
              >
                Clone
              </button>
            </li>
          )}
          {allow.move && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setMoving(true);
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-atl-n-500 hover:bg-atl-n-10"
              >
                Move
              </button>
            </li>
          )}
          {allow.convert && issuetypeName && issuetypeName !== 'Epic' && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setConverting(isSubtaskType ? 'issue' : 'subtask');
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-atl-n-500 hover:bg-atl-n-10"
              >
                {isSubtaskType ? 'Convert to issue' : 'Convert to subtask'}
              </button>
            </li>
          )}
          {allow.delete && (
            <li className="mt-1 border-t border-atl-n-30 pt-1">
              <button
                type="button"
                onClick={() => void beginDelete()}
                className="w-full px-3 py-1.5 text-left text-sm text-atl-r-400 hover:bg-atl-n-10"
              >
                Delete
              </button>
            </li>
          )}
        </ul>
      )}
      <CloneDialog issueKey={issueKey} open={cloning} onClose={() => setCloning(false)} />
      <MoveDialog issueKey={issueKey} open={moving} onClose={() => setMoving(false)} />
      {converting && <ConvertDialog issueKey={issueKey} projectKey={projectKey} mode={converting} onClose={() => setConverting(false)} />}
      <Modal open={!!confirming} onClose={() => setConfirming(null)}>
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
          <h2 className="text-lg font-semibold text-atl-n-800">Delete {issueKey}?</h2>
        </div>
        {confirming && (
          <div className="px-6 py-4">
            <p className="text-sm text-atl-n-600">
              This will permanently delete <strong>{issueKey}</strong>
              {confirming.deletesSubtasks.length > 0 && (
                <>
                  {' '}
                  and its {confirming.deletesSubtasks.length} subtask(s) ({confirming.deletesSubtasks.join(', ')})
                </>
              )}
              {confirming.clearsParentOn.length > 0 && (
                <>. {confirming.clearsParentOn.length} child issue(s) will lose their parent link</>
              )}
              .
            </p>
            {del.isError && <p className="mt-2 text-xs text-atl-r-400">{(del.error as Error).message}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => del.mutate()}
                className="rounded bg-atl-r-300 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-r-400 disabled:opacity-50"
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Sprint 022: Jira "Clone" dialog — summary + carry-over options. */
function CloneDialog({ issueKey, open, onClose }: { issueKey: string; open: boolean; onClose: () => void }) {
  const [summary, setSummary] = useState('');
  const [includeLinks, setIncludeLinks] = useState(true);
  const [includeSubtasks, setIncludeSubtasks] = useState(true);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const navigate = useNavigate();
  const clone = useMutation({
    mutationFn: () =>
      cloneIssue(issueKey, { summary: summary || undefined, includeLinks, includeSubtasks, includeAttachments }),
    onSuccess: (r) => {
      onClose();
      if (r.key) navigate(`/browse/${r.key}`);
    },
  });
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-lg font-semibold text-atl-n-800">Clone {issueKey}</h2>
      </div>
      <div className="px-6 py-4 space-y-3">
        <label className="block text-sm">
          <span className="text-atl-n-400">Summary</span>
          <input
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
            placeholder={`CLONE - <original summary>`}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        {(
          [
            ['Include links', includeLinks, setIncludeLinks],
            ['Include subtasks', includeSubtasks, setIncludeSubtasks],
            ['Include attachments', includeAttachments, setIncludeAttachments],
          ] as const
        ).map(([label, val, set]) => (
          <label key={label} className="flex items-center gap-2 text-sm text-atl-n-500">
            <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} />
            {label}
          </label>
        ))}
        {clone.isError && <p className="text-xs text-atl-r-400">{(clone.error as Error).message}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={clone.isPending}
            onClick={() => clone.mutate()}
            className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
          >
            {clone.isPending ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Sprint 022: Jira "Move" dialog — target project with dryRun preview of drops. */
function MoveDialog({ issueKey, open, onClose }: { issueKey: string; open: boolean; onClose: () => void }) {
  const [projectKey, setProjectKey] = useState('');
  const [preview, setPreview] = useState<{
    newKey?: string;
    dropped?: { components: string[]; versions: string[] };
  } | null>(null);
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const navigate = useNavigate();
  const dry = useMutation({
    mutationFn: () => moveIssue(issueKey, { projectKey, dryRun: true }),
    onSuccess: setPreview,
  });
  const move = useMutation({
    mutationFn: () => moveIssue(issueKey, { projectKey }),
    onSuccess: (r) => {
      onClose();
      if (r.key) navigate(`/browse/${r.key}`);
    },
  });
  const drops = preview?.dropped;
  const hasDrops = (drops?.components.length ?? 0) + (drops?.versions.length ?? 0) > 0;
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-lg font-semibold text-atl-n-800">Move {issueKey}</h2>
      </div>
      <div className="px-6 py-4 space-y-3">
        <label className="block text-sm">
          <span className="text-atl-n-400">Target project</span>
          <select
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm bg-atl-paper"
            value={projectKey}
            onChange={(e) => {
              setProjectKey(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Select a project…</option>
            {projects?.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </select>
        </label>
        {preview && (
          <div className="rounded border border-atl-n-30 bg-atl-n-10 p-3 text-sm">
            <p>
              New key: <strong>{preview.newKey}</strong>
            </p>
            {hasDrops && (
              <p className="mt-1 text-atl-y-300">
                Will drop: {[...(drops?.components ?? []), ...(drops?.versions ?? [])].join(', ')}
              </p>
            )}
            {!hasDrops && <p className="mt-1 text-atl-g-300">No fields will be dropped.</p>}
          </div>
        )}
        {(dry.isError || move.isError) && (
          <p className="text-xs text-atl-r-400">{((dry.error ?? move.error) as Error).message}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          {!preview ? (
            <button
              type="button"
              disabled={!projectKey || dry.isPending}
              onClick={() => dry.mutate()}
              className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
            >
              {dry.isPending ? 'Checking…' : 'Preview'}
            </button>
          ) : (
            <button
              type="button"
              disabled={move.isPending}
              onClick={() => move.mutate()}
              className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
            >
              {move.isPending ? 'Moving…' : 'Move'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** UB-015 — Jira "Convert to subtask"/"Convert to issue": type swap + parent
 *  assignment/clear via the standard fields write. */
function ConvertDialog({
  issueKey,
  projectKey,
  mode,
  onClose,
}: {
  issueKey: string;
  projectKey?: string;
  mode: 'subtask' | 'issue';
  onClose: () => void;
}) {
  // Types from the project's issue-type scheme — the global /issuetype list
  // carries ~100 imported legacy types. Falls back to global when the project
  // key isn't passed (menu on surfaces without the full issue).
  const { data: issueTypes } = useQuery({
    queryKey: projectKey ? ['project', projectKey] : ['issuetypes'],
    queryFn: () => (projectKey ? fetchProject(projectKey).then((p) => p.issueTypes ?? []) : fetchIssueTypes()),
    enabled: true,
  });
  const [parentKey, setParentKey] = useState('');
  const [typeName, setTypeName] = useState('');
  const queryClient = useQueryClient();

  const options = (issueTypes ?? []).filter((t) => (mode === 'subtask' ? t.subtask : !t.subtask && t.name !== 'Epic'));
  const convert = useMutation({
    mutationFn: () =>
      updateIssueFields(issueKey, {
        issuetype: { name: typeName || options[0]?.name || '' },
        parent: mode === 'subtask' ? { key: parentKey.trim().toUpperCase() } : null,
      }),
    onSuccess: () => {
      markIssueWrite(issueKey);
      queryClient.invalidateQueries({ queryKey: ['issue', issueKey] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      onClose();
    },
  });

  return (
    <Modal open onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-lg font-semibold text-atl-n-800">
          {mode === 'subtask' ? `Convert ${issueKey} to a subtask` : `Convert ${issueKey} to an issue`}
        </h2>
      </div>
      <div className="px-6 py-4 space-y-3">
        <label className="block text-sm">
          <span className="text-atl-n-400">New issue type</span>
          <select
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm bg-atl-paper"
            value={typeName || options[0]?.name || ''}
            onChange={(e) => setTypeName(e.target.value)}
          >
            {options.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {mode === 'subtask' && (
          <div className="block text-sm">
            <span className="text-atl-n-400">Parent issue</span>
            <div className="mt-1">
              <IssuePicker
                value={parentKey}
                onChange={setParentKey}
                excludeKey={issueKey}
                placeholder="Parent issue key or summary…"
                className="w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        )}
        {convert.isError && <p className="text-xs text-atl-r-400">{(convert.error as Error).message}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={convert.isPending || (mode === 'subtask' && !parentKey.trim())}
            onClick={() => convert.mutate()}
            className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
          >
            {convert.isPending ? 'Converting…' : 'Convert'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
