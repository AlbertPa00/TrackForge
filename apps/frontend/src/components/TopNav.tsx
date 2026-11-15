import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchMyself,
  logout,
  fetchFavouriteFilters,
  fetchMyFilters,
  fetchNotifications,
  markNotificationsRead,
  searchIssues,
  fetchDashboards,
  fetchProjects,
  fetchVisibleFilters,
  fetchBanner,
  type Issue,
  type TfNotification,
} from '../api/client.js';
import UserAvatar from './UserAvatar.js';
import IssueKey from './IssueKey.js';
import HelpLink from './HelpLink.js';
import CreateIssueDialog from './CreateIssueDialog.js';
import CreateProjectDialog from './CreateProjectDialog.js';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../lib/format.js';
import { imeComposing } from '../lib/ime.js';

const DISABLED_LINKS: { label: string; sprint: string }[] = [];

const navLinkCls = (active: boolean) =>
  `px-3 py-1.5 rounded text-sm font-medium inline-flex items-center gap-1 whitespace-nowrap transition-colors ${
    active ? 'text-white bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/10'
  }`;

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const RECENT_KEY = 'tf.recentIssues';

export function recordRecentIssue(key: string, summary: string, categoryKey?: string) {
  try {
    const list: { key: string; summary: string; categoryKey?: string }[] = JSON.parse(
      localStorage.getItem(RECENT_KEY) ?? '[]'
    );
    const next = [{ key, summary, categoryKey }, ...list.filter((x) => x.key !== key)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable */
  }
}

function recentIssues(): { key: string; summary: string; categoryKey?: string }[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

// 060 US8 — recent projects for the Projects dropdown (Jira parity).
const RECENT_PROJECTS_KEY = 'tf.recentProjects';

export function recordRecentProject(key: string, name: string) {
  try {
    const list: { key: string; name: string }[] = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]');
    const next = [{ key, name }, ...list.filter((x) => x.key !== key)].slice(0, 5);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable */
  }
}

function recentProjects(): { key: string; name: string }[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function FiltersMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname.startsWith('/issues') || pathname.startsWith('/filters');
  const { data: favourites } = useQuery({
    queryKey: ['filters', 'favourites'],
    queryFn: fetchFavouriteFilters,
    enabled: open,
  });
  const { data: mine } = useQuery({
    queryKey: ['filters', 'mine'],
    queryFn: fetchMyFilters,
    enabled: open,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const item = 'w-full text-left px-4 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10 flex items-center gap-2';

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className={navLinkCls(active)}>
        Filters
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-10 w-72 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          <button
            className={item}
            onClick={() => {
              setOpen(false);
              navigate('/issues');
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="text-atl-n-200">
              <path d="M11.6 10.1a5.5 5.5 0 1 0-1.5 1.5l3.1 3.1 1.4-1.4zM7.5 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
            </svg>
            Advanced issue search
          </button>
          {(favourites ?? []).length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                Starred
              </div>
              {favourites!.map((f) => (
                <button
                  key={f.id}
                  className={item}
                  title={f.name}
                  onClick={() => {
                    setOpen(false);
                    navigate(`/issues?filterId=${f.id}&mode=jql&jql=${encodeURIComponent(f.jql)}`);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-atl-y-400">
                    <path d="M8 1.5 10 6l4.9.4-3.7 3.2 1.1 4.8L8 11.6l-4.3 2.8 1.1-4.8-3.7-3.2L6 6z" />
                  </svg>
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </>
          )}
          {(mine ?? []).filter((f) => !f.favourite).slice(0, 5).length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                My filters
              </div>
              {(mine ?? [])
                .filter((f) => !f.favourite)
                .slice(0, 5)
                .map((f) => (
                  <button
                    key={f.id}
                    className={item}
                    title={f.name}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/issues?filterId=${f.id}&mode=jql&jql=${encodeURIComponent(f.jql)}`);
                    }}
                  >
                    <span className="truncate">{f.name}</span>
                  </button>
                ))}
            </>
          )}
          <div className="border-t border-atl-n-30 mt-1 pt-1">
            <button
              className={item}
              onClick={() => {
                setOpen(false);
                navigate('/filters');
              }}
            >
              View all filters
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 060 US8 — Jira "Proyectos" menu: current project, recents, and the
    create/import entries. Recents are recorded automatically whenever the
    user is inside a project route. */
function ProjectsMenu({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const currentKey = pathname.match(/^\/projects\/([A-Za-z0-9]+)/)?.[1]?.toUpperCase();

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: Boolean(currentKey) || open,
  });
  const { data: myself } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, enabled: open });

  useEffect(() => {
    if (currentKey && projects) {
      const p = projects.find((x) => x.key === currentKey);
      if (p) recordRecentProject(p.key, p.name);
    }
  }, [currentKey, projects]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const item = 'w-full text-left px-4 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10 flex items-center gap-2';
  const current = projects?.find((x) => x.key === currentKey);
  const recents = open ? recentProjects() : [];

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className={navLinkCls(active)} aria-expanded={open}>
        Projects
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-10 w-72 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          {current && (
            <>
              <div className="px-4 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                Current project
              </div>
              <button
                className={item}
                title={`${current.name} (${current.key})`}
                onClick={() => {
                  setOpen(false);
                  navigate(`/projects/${current.key}`);
                }}
              >
                <span className="truncate font-medium">{current.name}</span>
                <span className="text-xs text-atl-n-200">({current.key})</span>
              </button>
            </>
          )}
          {recents.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                Recent projects
              </div>
              {recents.map((p) => (
                <button
                  key={p.key}
                  className={item}
                  title={`${p.name} (${p.key})`}
                  onClick={() => {
                    setOpen(false);
                    navigate(`/projects/${p.key}`);
                  }}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="text-xs text-atl-n-200">({p.key})</span>
                </button>
              ))}
            </>
          )}
          <div className="border-t border-atl-n-30 mt-1 pt-1">
            <button
              className={item}
              onClick={() => {
                setOpen(false);
                navigate('/projects');
              }}
            >
              View all projects
            </button>
            {myself?.isAdmin && (
              <button
                className={item}
                onClick={() => {
                  setOpen(false);
                  navigate('/admin/migration');
                }}
              >
                Import external project
              </button>
            )}
            <button
              className={item}
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              Create project
            </button>
          </div>
        </div>
      )}
      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

// Sprint 026 — replaces the "Coming in Sprint 012" stub.
function DashboardsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname.startsWith('/dashboards');
  const { data } = useQuery({
    queryKey: ['dashboards'],
    queryFn: fetchDashboards,
    enabled: open,
  });
  const dashboards = data?.dashboards ?? [];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const item = 'w-full text-left px-4 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 inline-flex items-center gap-2';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1.5 rounded text-sm font-medium inline-flex items-center gap-1 transition-colors ${
          active ? 'text-white bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/10'
        }`}
      >
        Dashboards
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-10 w-72 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          {dashboards.slice(0, 8).map((d) => (
            <button
              key={d.id}
              className={item}
              title={d.name}
              onClick={() => {
                setOpen(false);
                navigate(`/dashboards/${d.id}`);
              }}
            >
              <span className="truncate">{d.name}</span>
            </button>
          ))}
          {!dashboards.length && <div className="px-4 py-2 text-sm text-atl-n-200">No dashboards yet.</div>}
          <div className="border-t border-atl-n-30 mt-1 pt-1">
            <button
              className={item}
              onClick={() => {
                setOpen(false);
                navigate('/dashboards');
              }}
            >
              Manage dashboards
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GlobalSearch() {
  const [value, setValue] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value.trim()), 250);
    return () => window.clearTimeout(t);
  }, [value]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const { data: results } = useQuery({
    queryKey: ['globalSearch', debounced],
    queryFn: () =>
      searchIssues(`text ~ "${debounced.replace(/"/g, '')}" ORDER BY updated DESC`, {
        maxResults: 6,
        fields: ['key', 'summary', 'issuetype', 'status', 'project'],
      }),
    enabled: debounced.length >= 2 && !ISSUE_KEY_RE.test(debounced.toUpperCase()),
    placeholderData: (prev) => prev,
  });

  // Entity matches alongside issue text-search: projects (filtered client-side
  // — the list is small) and saved filters (server-side name search).
  const { data: allProjects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const { data: filterHits } = useQuery({
    queryKey: ['globalSearchFilters', debounced],
    queryFn: () => fetchVisibleFilters(debounced),
    enabled: debounced.length >= 2,
    placeholderData: (prev) => prev,
  });
  const projectHits = (allProjects ?? [])
    .filter(
      (p) =>
        debounced.length >= 2 &&
        (p.name.toLowerCase().includes(debounced.toLowerCase()) ||
          p.key.toLowerCase().includes(debounced.toLowerCase()))
    )
    .slice(0, 4);

  const submit = () => {
    const q = value.trim();
    if (!q) return;
    if (ISSUE_KEY_RE.test(q.toUpperCase())) {
      setOpen(false);
      navigate(`/browse/${q.toUpperCase()}`);
      setValue('');
      return;
    }
    setOpen(false);
    navigate(`/issues?mode=jql&jql=${encodeURIComponent(`text ~ "${q.replace(/"/g, '')}" ORDER BY updated DESC`)}`);
    setValue('');
  };

  const recent = !debounced ? recentIssues() : [];
  const issues: Issue[] = results?.issues ?? [];

  return (
    <div className="hidden sm:block relative mr-2" ref={ref}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/50 pointer-events-none"
        fill="currentColor"
      >
        <path d="M11.6 10.1a5.5 5.5 0 1 0-1.5 1.5l3.1 3.1 1.4-1.4zM7.5 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
      </svg>
      <input
        data-tf-search
        type="text"
        placeholder="Search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Enter' && !imeComposing(e) && submit()}
        aria-label="Global search"
        title="Search issues, projects, filters (/)"
        className="w-44 h-8 pl-8 pr-3 rounded bg-white/10 text-sm placeholder-white/50 border border-transparent focus:border-atl-b-100 focus:bg-white/15 outline-none"
      />
      {open && (recent.length > 0 || debounced.length >= 2) && (
        <div className="absolute top-9 left-0 w-80 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          {recent.length > 0 && (
            <>
              <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Recent</div>
              {recent.map((r) => (
                <button
                  key={r.key}
                  className="w-full text-left px-4 py-1.5 hover:bg-atl-n-10 flex items-center gap-2"
                  title={`${r.key}: ${r.summary}`}
                  onClick={() => {
                    setOpen(false);
                    navigate(`/browse/${r.key}`);
                  }}
                >
                  <IssueKey
                    issueKey={r.key}
                    categoryKey={r.categoryKey}
                    className="text-xs text-atl-n-200 whitespace-nowrap"
                  />
                  <span className="text-sm text-atl-n-700 truncate">{r.summary}</span>
                </button>
              ))}
            </>
          )}
          {debounced.length >= 2 &&
            (ISSUE_KEY_RE.test(debounced.toUpperCase()) ? (
              // Direct issue key — don't text-search it, offer the jump.
              <button
                className="w-full text-left px-4 py-2 hover:bg-atl-n-10 flex items-center gap-2"
                onClick={() => {
                  setOpen(false);
                  navigate(`/browse/${debounced.toUpperCase()}`);
                  setValue('');
                }}
              >
                <IssueKey issueKey={debounced.toUpperCase()} className="text-xs text-atl-n-200 whitespace-nowrap" />
                <span className="text-sm text-atl-n-700">
                  Go to <span className="font-medium">{debounced.toUpperCase()}</span>
                </span>
              </button>
            ) : (
              <>
                {projectHits.length > 0 && (
                  <>
                    <div className="px-4 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                      Projects
                    </div>
                    {projectHits.map((p) => (
                      <button
                        key={p.id}
                        className="w-full text-left px-4 py-1.5 hover:bg-atl-n-10 flex items-center gap-2"
                        title={`${p.name} (${p.key})`}
                        onClick={() => {
                          setOpen(false);
                          navigate(`/projects/${p.key}`);
                        }}
                      >
                        <span className="text-xs text-atl-n-200 whitespace-nowrap">{p.key}</span>
                        <span className="text-sm text-atl-n-700 truncate">{p.name}</span>
                      </button>
                    ))}
                  </>
                )}
                {(filterHits ?? []).length > 0 && (
                  <>
                    <div className="px-4 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                      Filters
                    </div>
                    {filterHits!.slice(0, 4).map((f) => (
                      <button
                        key={f.id}
                        className="w-full text-left px-4 py-1.5 hover:bg-atl-n-10 flex items-center gap-2"
                        title={f.name}
                        onClick={() => {
                          setOpen(false);
                          navigate(`/issues?filterId=${f.id}&mode=jql&jql=${encodeURIComponent(f.jql)}`);
                        }}
                      >
                        <span className="text-sm text-atl-n-700 truncate">{f.name}</span>
                        {f.favourite && <span className="text-[10px] text-atl-y-400">★</span>}
                      </button>
                    ))}
                  </>
                )}
                <div className="px-4 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
                  Issues
                </div>
                {issues.map((i) => (
                  <button
                    key={i.id}
                    className="w-full text-left px-4 py-1.5 hover:bg-atl-n-10 flex items-center gap-2"
                    title={`${i.key}: ${i.fields.summary}`}
                    onClick={() => {
                      setOpen(false);
                      navigate(`/browse/${i.key}`);
                    }}
                  >
                    <IssueKey
                      issueKey={i.key}
                      categoryKey={i.fields.status.statusCategory.key}
                      className="text-xs text-atl-n-200 whitespace-nowrap"
                    />
                    <span className="text-sm text-atl-n-700 truncate">{i.fields.summary}</span>
                  </button>
                ))}
                {issues.length === 0 && <div className="px-4 py-1.5 text-xs text-atl-n-200">No matching issues</div>}
                <button
                  onClick={submit}
                  className="w-full text-left px-4 py-1.5 text-sm text-atl-b-300 hover:bg-atl-b-50 border-t border-atl-n-30 mt-1 pt-1.5"
                >
                  View all results in advanced search
                </button>
              </>
            ))}
        </div>
      )}
    </div>
  );
}

const REASON_LABEL: Record<string, string> = {
  assigned: 'assigned to you',
  mentioned: 'mentioned you',
  watching: "issue you're watching",
  proposal_pending: 'requested approval on',
  proposal_approved: 'approved your request on',
  proposal_rejected: 'rejected your request on',
  proposal_resolved: 'resolved your request on',
  agent_question: 'an agent needs your answer',
  agent_stalled: 'an agent session stalled',
  agent_failed: 'an agent session failed',
};

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Freshness comes from the SSE stream (events.ts invalidates 'notifications'
  // on every domain event) — no polling needed.
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => fetchNotifications(false),
  });
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const openItem = async (n: TfNotification) => {
    setOpen(false);
    if (!n.read) {
      void markNotificationsRead([n.id])
        .then(() => qc.invalidateQueries({ queryKey: ['notifications'] }))
        .catch(() => undefined);
    }
    // Proposals land where review happens: the issue's inline panel when the
    // write targets an issue, otherwise the approvals inbox detail.
    if (n.issueKey) navigate(`/browse/${n.issueKey}`);
    else if (n.proposalId) navigate(`/approvals?proposal=${n.proposalId}`);
  };

  const markAll = async () => {
    await markNotificationsRead(undefined, true).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div className="relative mr-3" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        className="relative h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2zm5-4V7.5a5 5 0 0 0-4-4.9V2a1 1 0 0 0-2 0v.6a5 5 0 0 0-4 4.9V11L1.6 12.4a.5.5 0 0 0 .4.6h12a.5.5 0 0 0 .4-.6z" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-atl-r-400 text-[10px] font-semibold text-white flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-[380px] max-h-[480px] overflow-auto rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-atl-n-30">
            <span className="text-sm font-semibold text-atl-n-800">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-atl-b-300 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {(data?.notifications ?? []).length === 0 && (
            <p className="px-4 py-6 text-sm text-atl-n-200 text-center">You're all caught up.</p>
          )}
          {(data?.notifications ?? []).slice(0, 25).map((n) => (
            <button
              key={n.id}
              onClick={() => void openItem(n)}
              className={`w-full text-left px-4 py-2.5 hover:bg-atl-n-10 border-b border-atl-n-10 last:border-0 ${
                n.read ? 'opacity-60' : ''
              }`}
            >
              <div className="flex items-start gap-2.5">
                {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-atl-b-300" />}
                <div className={n.read ? 'ml-[18px] min-w-0' : 'min-w-0'}>
                  <div className="text-[13px] text-atl-n-800">
                    <span className="font-medium">{n.event.actor?.displayName ?? 'Someone'}</span>{' '}
                    {REASON_LABEL[n.reason] ?? n.reason}{' '}
                    {n.issueKey && <span className="font-medium text-atl-b-300">{n.issueKey}</span>}
                  </div>
                  {n.summary && (
                    <div className="text-[12px] text-atl-n-700 truncate" title={n.summary}>{n.summary}</div>
                  )}
                  {n.comment && (
                    <div className="text-[11px] text-atl-n-200 truncate" title={n.comment}>{n.comment}</div>
                  )}
                  <div className="text-[11px] text-atl-n-200 mt-0.5">{formatDateTime(n.created)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ['myself'],
    queryFn: fetchMyself,
    staleTime: Infinity,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const signOut = async () => {
    await logout().catch(() => undefined);
    queryClient.clear();
    // Don't leak the previous user's recents to the next session on this machine.
    try {
      localStorage.removeItem(RECENT_KEY);
      localStorage.removeItem(RECENT_PROJECTS_KEY);
    } catch {
      /* localStorage unavailable */
    }
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={me?.displayName ? `Account: ${me.displayName}` : 'Account'}
        aria-label="Account"
        className="rounded-full hover:ring-2 hover:ring-white/40"
      >
        <UserAvatar displayName={me?.displayName} emoji={me?.avatarEmoji} size={28} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-64 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          <div className="px-4 py-2 flex items-center gap-3">
            <UserAvatar displayName={me?.displayName} emoji={me?.avatarEmoji} size={32} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-atl-n-800 truncate" title={me?.displayName}>{me?.displayName}</div>
              <div className="text-xs text-atl-n-200 truncate" title={me?.emailAddress}>{me?.emailAddress}</div>
            </div>
          </div>
          <div className="border-t border-atl-n-30 mt-1.5 pt-1.5">
            <button
              onClick={() => {
                setOpen(false);
                navigate('/profile');
              }}
              className="w-full text-left px-4 py-2 text-sm text-atl-n-700 hover:bg-atl-n-10"
            >
              Profile
            </button>
            <button
              onClick={() => {
                setOpen(false);
                navigate('/connect');
              }}
              className="w-full text-left px-4 py-2 text-sm text-atl-n-700 hover:bg-atl-n-10"
            >
              Connect agents
            </button>
            {me?.isAdmin && (
              <button
                onClick={() => {
                  setOpen(false);
                  navigate('/admin/users');
                }}
                className="w-full text-left px-4 py-2 text-sm font-medium text-atl-n-700 hover:bg-atl-n-10"
              >
                Administration
              </button>
            )}
            <button onClick={signOut} className="w-full text-left px-4 py-2 text-sm text-atl-n-700 hover:bg-atl-n-10">
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopNav() {
  const [createOpen, setCreateOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { t } = useTranslation();
  const navigate = useNavigate();
  // 060 stretch — Jira announcement banner: site-wide strip when set.
  const { data: banner } = useQuery({ queryKey: ['banner'], queryFn: fetchBanner, staleTime: 60_000 });
  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener('tf:nav-create', onCreate);
    return () => window.removeEventListener('tf:nav-create', onCreate);
  }, []);
  const { pathname } = useLocation();

  const projectsActive = pathname.startsWith('/projects') || pathname.startsWith('/browse');

  // Create dialog defaults to the project you're looking at (Jira parity).
  const ctxProject = (
    pathname.match(/^\/projects\/([A-Za-z0-9_]+)/)?.[1] ?? pathname.match(/^\/browse\/([A-Za-z0-9_]+)-/)?.[1]
  )?.toUpperCase();

  return (
    <>
      {banner?.message && (
        <div className="bg-atl-y-100 text-atl-n-800 text-sm px-4 py-1.5 text-center shrink-0" role="alert">
          {banner.message}
        </div>
      )}
      <header className="relative h-12 bg-atl-topbar text-white flex items-center px-3 gap-1 shrink-0">
        {/* Mobile nav — the md+ link row has no small-screen fallback otherwise. */}
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Navigation menu"
          title="Navigation menu"
          aria-expanded={mobileOpen}
          className="md:hidden h-8 w-8 mr-1 rounded hover:bg-white/10 flex items-center justify-center shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M2 3.5h12v1.6H2zM2 7.2h12v1.6H2zM2 11h12v1.6H2z" />
          </svg>
        </button>
        {mobileOpen && (
          <div className="md:hidden absolute top-12 left-2 w-56 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
            {[
              ['Projects', '/projects'],
              ['Advanced issue search', '/issues'],
              ['Dashboards', '/dashboards'],
              ['Filters', '/filters'],
            ].map(([label, to]) => (
              <button
                key={to}
                className="w-full text-left px-4 py-2 text-sm text-atl-n-700 hover:bg-atl-n-10"
                onClick={() => {
                  setMobileOpen(false);
                  navigate(to);
                }}
              >
                {label}
              </button>
            ))}
            <div className="border-t border-atl-n-30 mt-1 pt-1">
              <button
                className="w-full text-left px-4 py-2 text-sm font-medium text-atl-n-700 hover:bg-atl-n-10"
                onClick={() => {
                  setMobileOpen(false);
                  setCreateOpen(true);
                }}
              >
                Create issue
              </button>
            </div>
          </div>
        )}
        <Link to="/" className="flex items-center gap-2 px-2 mr-1">
          <svg width="22" height="22" viewBox="0 0 24 24" className="text-atl-b-100">
            <path
              fill="currentColor"
              d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.3 6.5 3.2L12 10.7 5.5 7.5 12 4.3zM5 9.2l6 3v7.1l-6-3V9.2zm14 0v7.1l-6 3v-7.1l6-3z"
            />
          </svg>
          <span className="text-[17px] font-semibold tracking-tight">TrackForge</span>
        </Link>

        <nav className="hidden md:flex items-center">
          {/* Jira parity: the logo is the "Your work" home link; People lives
              under admin User management — neither is a top-nav item. */}
          <ProjectsMenu active={projectsActive} />
          <FiltersMenu />
          <DashboardsMenu />
          {DISABLED_LINKS.map((l) => (
            <span
              key={l.label}
              title={`Coming in Sprint ${l.sprint}`}
              aria-disabled="true"
              className="px-3 py-1.5 rounded text-sm font-medium text-white/40 cursor-not-allowed inline-flex items-center gap-1"
            >
              {l.label}
              <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60" aria-hidden="true">
                <path
                  d="M1.5 3.5 5 7l3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          ))}
        </nav>

        <div className="flex-1" />

        <GlobalSearch />

        {/* 068 — sparkle opens the Copilot workbench dock; ⌘K opens the command palette. */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('tf:open-copilot'))}
          title="Copilot (Ctrl+J)"
          aria-label="Copilot"
          className="h-8 w-8 mr-1 rounded hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
          </svg>
        </button>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('tf:open-palette'))}
          title="Commands (⌘K)"
          aria-label="Command palette"
          className="h-8 w-8 mr-2 rounded hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white text-[11px] font-semibold"
        >
          ⌘K
        </button>

        <button
          onClick={() => setCreateOpen(true)}
          title="Create issue (c)"
          className="h-8 px-3 rounded bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium mr-3"
        >
          {t('nav.create')}
        </button>

        <NotificationBell />
        <HelpLink dark />
        <UserMenu />
      </header>

      <CreateIssueDialog open={createOpen} onClose={() => setCreateOpen(false)} defaultProjectKey={ctxProject} />
    </>
  );
}
