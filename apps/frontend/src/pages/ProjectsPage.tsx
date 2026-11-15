import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchMyself,
  fetchPreferences,
  fetchProjectCategories,
  fetchProjects,
  putPreference,
} from '../api/client.js';
import UserAvatar from '../components/UserAvatar.js';
import UserHoverCard from '../components/UserHoverCard.js';
import { StarIcon } from '../components/icons.js';
import CreateProjectDialog from '../components/CreateProjectDialog.js';
import EmptyState from '../components/EmptyState.js';
import RowMenu from '../components/RowMenu.js';
import { PROJECT_COLORS } from '../lib/palette.js';

const FAV_PREF_KEY = 'projects.favorites';

function ProjectAvatar({ projectKey, name }: { projectKey: string; name: string }) {
  const sum = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded text-white text-[10px] font-bold shrink-0"
      style={{ backgroundColor: PROJECT_COLORS[sum % PROJECT_COLORS.length] }}
    >
      {projectKey.slice(0, 2)}
    </span>
  );
}

export default function ProjectsPage() {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const { data: categories } = useQuery({ queryKey: ['projectCategories'], queryFn: fetchProjectCategories });
  const qc = useQueryClient();
  const { data: prefs } = useQuery({ queryKey: ['preferences'], queryFn: fetchPreferences });
  const favorites = new Set(
    Array.isArray(prefs?.[FAV_PREF_KEY]) ? (prefs[FAV_PREF_KEY] as string[]) : []
  );
  const favMut = useMutation({
    mutationFn: (keys: string[]) => putPreference(FAV_PREF_KEY, keys),
    onMutate: (keys) => qc.setQueryData(['preferences'], { ...(prefs ?? {}), [FAV_PREF_KEY]: keys }),
  });
  const toggleFav = (key: string) =>
    favMut.mutate(
      favorites.has(key) ? [...favorites].filter((k) => k !== key) : [...favorites, key]
    );

  // Jira: starred projects sort to the top.
  const filtered = (projects ?? [])
    .filter(
      (p) =>
        (!categoryId || p.projectCategory?.id === categoryId) &&
        (p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.key.toLowerCase().includes(search.toLowerCase()))
    )
    .sort(
      (a, b) =>
        Number(favorites.has(b.key)) - Number(favorites.has(a.key)) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );

  const PAGE_SIZE = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageIdx = Math.min(page, pageCount - 1); // clamp after filter changes
  const pageItems = filtered.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-atl-n-800">Projects</h1>
        <button
          onClick={() => setCreateOpen(true)}
          className="h-8 px-3 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white"
        >
          Create project
        </button>
      </div>

      <div className="relative mb-4 max-w-xs">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-atl-n-100"
          fill="currentColor"
        >
          <path d="M11.6 10.1a5.5 5.5 0 1 0-1.5 1.5l3.1 3.1 1.4-1.4zM7.5 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
        </svg>
        <input
          type="text"
          placeholder="Search projects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full h-9 pl-8 pr-3 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none"
        />
      </div>
      {(categories ?? []).length > 0 && (
        <div className="mb-4">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-9 px-2 pr-8 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper"
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {isLoading && <p className="text-sm text-atl-n-200 py-8">Loading projects…</p>}
      {error && <p className="text-sm text-atl-r-400 py-8">Failed to load projects.</p>}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="border border-dashed border-atl-n-40 rounded">
          <EmptyState
            title={(projects ?? []).length === 0 ? 'No projects yet' : 'No projects match your search'}
            description={(projects ?? []).length === 0 ? 'Create your first project to start tracking work.' : 'Try a different name or key.'}
            action={
              (projects ?? []).length === 0 ? (
                <button
                  onClick={() => setCreateOpen(true)}
                  className="h-8 px-3 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white"
                >
                  Create project
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {filtered.length > 0 && (
        <div className="border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-atl-n-10 border-b border-atl-n-30">
                <th className="px-3 py-2 w-8" aria-label="Favorite" />
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 w-28">
                  Key
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 w-40">
                  Type
                </th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 w-48">
                  Lead
                </th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {pageItems.map((p) => (
                <tr key={p.id} className="border-b border-atl-n-30 last:border-0 hover:bg-atl-n-10">
                  <td className="px-3 py-2.5 w-8">
                    <button
                      type="button"
                      onClick={() => toggleFav(p.key)}
                      aria-label={favorites.has(p.key) ? `Unstar ${p.name}` : `Star ${p.name}`}
                      aria-pressed={favorites.has(p.key)}
                      className={`leading-none ${
                        favorites.has(p.key) ? 'text-atl-y-300' : 'text-atl-n-40 hover:text-atl-n-100'
                      }`}
                    >
                      <StarIcon filled={favorites.has(p.key)} size={18} />
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      to={`/projects/${p.key}`}
                      className="inline-flex items-center gap-2.5 text-atl-b-300 hover:underline font-medium min-w-0 max-w-full"
                    >
                      <ProjectAvatar projectKey={p.key} name={p.name} />
                      <span className="truncate" title={p.name}>{p.name}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-atl-n-500">{p.key}</td>
                  <td className="px-3 py-2.5 text-atl-n-500 capitalize">
                    {p.projectTypeKey === 'software' ? 'Software' : p.projectTypeKey}
                  </td>
                  <td className="px-3 py-2.5">
                    {p.lead ? (
                      <UserHoverCard user={p.lead}>
                        <span className="inline-flex items-center gap-2 text-atl-n-500 max-w-full">
                          <UserAvatar displayName={p.lead.displayName} size={20} />
                          <span className="truncate" title={p.lead.displayName}>{p.lead.displayName}</span>
                          {p.lead.accountId === me?.accountId && (
                            <span className="rounded bg-atl-n-20 px-1 text-[10px] font-semibold uppercase text-atl-n-300 shrink-0">You</span>
                          )}
                        </span>
                      </UserHoverCard>
                    ) : (
                      <span className="text-atl-n-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <RowMenu
                      ariaLabel={`Actions for ${p.name}`}
                      items={[
                        { label: 'Project settings', onClick: () => navigate(`/projects/${p.key}/settings`) },
                        { label: 'Board', onClick: () => navigate(`/projects/${p.key}/board`) },
                        { label: 'Backlog', onClick: () => navigate(`/projects/${p.key}/backlog`) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-atl-n-30 px-3 py-2">
              <span className="text-xs text-atl-n-300">
                {pageIdx * PAGE_SIZE + 1}–{Math.min((pageIdx + 1) * PAGE_SIZE, filtered.length)} of{' '}
                {filtered.length.toLocaleString()}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  disabled={pageIdx === 0}
                  onClick={() => setPage(pageIdx - 1)}
                  className="h-7 w-7 rounded-[3px] text-sm text-atl-n-500 hover:bg-atl-n-20 disabled:opacity-40"
                  aria-label="Previous page"
                >
                  ‹
                </button>
                <button
                  type="button"
                  disabled={pageIdx >= pageCount - 1}
                  onClick={() => setPage(pageIdx + 1)}
                  className="h-7 w-7 rounded-[3px] text-sm text-atl-n-500 hover:bg-atl-n-20 disabled:opacity-40"
                  aria-label="Next page"
                >
                  ›
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
