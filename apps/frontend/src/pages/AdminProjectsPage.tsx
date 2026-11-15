// 060 US4 — /admin/projects: Jira's "Ver proyectos" surface — project list
// with issue counts + last activity, category CRUD, and the archived view.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAdminProjects, archiveProject, restoreProject,
  fetchProjectCategories, createProjectCategory, updateProjectCategory, deleteProjectCategory,
  ApiError, type AdminProjectOverview, type ProjectCategory,
} from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { useFlag } from '../components/Flag.js';
import { formatDate } from '../lib/format.js';

const input = 'border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';

function ProjectsTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const projects = useQuery({ queryKey: ['admin-projects'], queryFn: fetchAdminProjects });
  const [confirmArch, setConfirmArch] = useState<AdminProjectOverview | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-projects'] });
  const arch = useMutation({
    mutationFn: (key: string) => archiveProject(key),
    onSuccess: () => { flag.success('Project archived'); invalidate(); setConfirmArch(null); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Archive failed'),
  });

  const rows = (projects.data ?? []).filter((p) => !p.archived);
  return (
    <>
      {projects.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {projects.data && rows.length === 0 && <EmptyState title="No active projects" />}
      {rows.length > 0 && (
        <table className="w-full text-sm border border-atl-n-30 rounded-[3px] overflow-hidden">
          <thead>
            <tr className="bg-atl-n-10 text-left text-xs uppercase text-atl-n-200">
              <th className="px-3 py-2">Project</th>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Lead</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">Issues</th>
              <th className="px-3 py-2">Last issue update</th>
              <th className="px-3 py-2 w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-atl-n-30 hover:bg-atl-n-10">
                <td className="px-3 py-2 font-medium text-atl-n-800">{p.name}</td>
                <td className="px-3 py-2 text-atl-n-500">{p.key}</td>
                <td className="px-3 py-2 text-xs text-atl-n-300">{p.projectTypeKey === 'software' ? 'Software' : p.projectTypeKey}</td>
                <td className="px-3 py-2 text-xs text-atl-n-500">{p.lead?.displayName ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-atl-n-500">{p.projectCategory?.name ?? '—'}</td>
                <td className="px-3 py-2 text-right text-atl-n-700">{p.issues}</td>
                <td className="px-3 py-2 text-xs text-atl-n-300">{p.lastIssueUpdate ? formatDate(p.lastIssueUpdate) : '—'}</td>
                <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
                  <Link to={`/projects/${p.key}/settings`} className="text-xs font-medium text-atl-b-400 hover:underline">Settings</Link>
                  <button className="text-xs font-medium text-atl-r-400 hover:underline" onClick={() => setConfirmArch(p)}>Archive</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={confirmArch !== null}
        title={`Archive "${confirmArch?.name ?? ''}"?`}
        body="Archived projects become read-only and disappear from project pickers. They can be restored from the Archived tab."
        confirmLabel="Archive project"
        pending={arch.isPending}
        error={arch.isError ? (arch.error as Error).message : null}
        onConfirm={() => { if (confirmArch) arch.mutate(confirmArch.key); }}
        onClose={() => setConfirmArch(null)}
      />
    </>
  );
}

function CategoriesTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const categories = useQuery({ queryKey: ['project-categories'], queryFn: fetchProjectCategories });
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [confirmDel, setConfirmDel] = useState<ProjectCategory | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['project-categories'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createProjectCategory({ name: newName.trim(), description: newDesc.trim() || undefined }),
    onSuccess: () => { flag.success(`Category ${newName.trim()} created`); setNewName(''); setNewDesc(''); invalidate(); },
    onError,
  });
  const update = useMutation({
    mutationFn: () => updateProjectCategory(editing!, { name: editName.trim(), description: editDesc.trim() || undefined }),
    onSuccess: () => { flag.success('Category updated'); setEditing(null); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteProjectCategory(id),
    onSuccess: () => { flag.success('Category deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-64`} placeholder="New category name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input className={`${input} w-64`} placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create category
        </button>
      </div>

      {categories.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {categories.data && categories.data.length === 0 && <EmptyState title="No project categories" />}

      {(categories.data?.length ?? 0) > 0 && (
        <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
          {(categories.data ?? []).map((c) => (
            <div key={c.id} className="px-4 py-2.5 flex items-center justify-between">
              {editing === c.id ? (
                <div className="flex flex-1 items-center gap-2">
                  <input className={input} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <input className={`${input} w-64`} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" />
                  <button
                    className="text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded px-2.5 py-1.5 disabled:opacity-50"
                    disabled={!editName.trim() || update.isPending}
                    onClick={() => update.mutate()}
                  >
                    Save
                  </button>
                  <button className="text-sm text-atl-n-300 hover:underline" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              ) : (
                <>
                  <div>
                    <span className="text-sm font-medium text-atl-n-800">{c.name}</span>
                    {c.description && <span className="ml-2 text-xs text-atl-n-200">{c.description}</span>}
                  </div>
                  <div className="space-x-2">
                    <button
                      className="text-sm text-atl-b-400 hover:underline"
                      onClick={() => { setEditing(c.id); setEditName(c.name); setEditDesc(c.description ?? ''); }}
                    >
                      Edit
                    </button>
                    <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(c)}>Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body="Deletion is refused while projects are assigned to this category."
        confirmLabel="Delete category"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

function ArchivedTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const projects = useQuery({ queryKey: ['admin-projects'], queryFn: fetchAdminProjects });
  const [confirmRestore, setConfirmRestore] = useState<AdminProjectOverview | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-projects'] });
  const restore = useMutation({
    mutationFn: (key: string) => restoreProject(key),
    onSuccess: () => { flag.success('Project restored'); invalidate(); setConfirmRestore(null); },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Restore failed'),
  });

  const rows = (projects.data ?? []).filter((p) => p.archived);
  return (
    <>
      {projects.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {projects.data && rows.length === 0 && <EmptyState title="No archived projects" />}
      {rows.length > 0 && (
        <table className="w-full text-sm border border-atl-n-30 rounded-[3px] overflow-hidden">
          <thead>
            <tr className="bg-atl-n-10 text-left text-xs uppercase text-atl-n-200">
              <th className="px-3 py-2">Project</th>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">Issues</th>
              <th className="px-3 py-2 w-20" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-atl-n-30 hover:bg-atl-n-10">
                <td className="px-3 py-2 font-medium text-atl-n-800">{p.name}</td>
                <td className="px-3 py-2 text-atl-n-500">{p.key}</td>
                <td className="px-3 py-2 text-xs text-atl-n-500">{p.projectCategory?.name ?? '—'}</td>
                <td className="px-3 py-2 text-right text-atl-n-700">{p.issues}</td>
                <td className="px-3 py-2 text-right">
                  <button className="text-xs font-medium text-atl-b-400 hover:underline" onClick={() => setConfirmRestore(p)}>Restore</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={confirmRestore !== null}
        title={`Restore "${confirmRestore?.name ?? ''}"?`}
        body="The project becomes writable and visible in pickers again."
        confirmLabel="Restore project"
        pending={restore.isPending}
        error={restore.isError ? (restore.error as Error).message : null}
        onConfirm={() => { if (confirmRestore) restore.mutate(confirmRestore.key); }}
        onClose={() => setConfirmRestore(null)}
      />
    </>
  );
}

export default function AdminProjectsPage() {
  const [tab, setTab] = useState<'projects' | 'categories' | 'archived'>('projects');
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Projects</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">All projects with activity stats, categories, and the archive.</p>
      <div className="flex gap-1 mb-4 border-b border-atl-n-30">
        {([
          ['projects', 'Projects'],
          ['categories', 'Categories'],
          ['archived', 'Archived'],
        ] as const).map(([k, l]) => (
          <button
            key={k}
            className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-atl-b-400 text-atl-b-400' : 'border-transparent text-atl-n-300 hover:text-atl-n-500'}`}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'archived' && <ArchivedTab />}
    </div>
  );
}
