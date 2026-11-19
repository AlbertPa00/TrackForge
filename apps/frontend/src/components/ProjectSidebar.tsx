import { Link, NavLink, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PROJECT_COLORS } from '../lib/palette.js';
import { fetchBoard, fetchMyself, fetchProject, fetchWorkflows } from '../api/client.js';
import { usePermissions } from '../hooks/usePermissions.js';

function ProjectAvatar({ projectKey, name }: { projectKey: string; name: string }) {
  const sum = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const bg = PROJECT_COLORS[sum % PROJECT_COLORS.length];
  return (
    <span
      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white text-[11px] font-bold shrink-0"
      style={{ backgroundColor: bg }}
    >
      {projectKey.slice(0, 2)}
    </span>
  );
}

const ICONS = {
  search: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  ),
  list: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="3" width="3" height="2" rx="0.5" />
      <rect x="1.5" y="7" width="3" height="2" rx="0.5" />
      <rect x="1.5" y="11" width="3" height="2" rx="0.5" />
      <rect x="6.5" y="3" width="8" height="2" rx="0.5" />
      <rect x="6.5" y="7" width="8" height="2" rx="0.5" />
      <rect x="6.5" y="11" width="8" height="2" rx="0.5" />
    </svg>
  ),
  board: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="2" width="3.5" height="12" rx="1" />
      <rect x="6.25" y="2" width="3.5" height="8" rx="1" />
      <rect x="11" y="2" width="3.5" height="10" rx="1" />
    </svg>
  ),
  backlog: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M2.5 4h11M2.5 8h8M2.5 12h5.5" />
    </svg>
  ),
  timeline: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="3" width="7" height="2" rx="1" />
      <rect x="5" y="7" width="8" height="2" rx="1" />
      <rect x="3" y="11" width="10" height="2" rx="1" />
    </svg>
  ),
  releases: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1.5 13.5 4v3.5L8 11 2.5 7.5V4L8 1.5z" opacity="0.45" />
      <path d="M2.5 8.5 8 12l5.5-3.5v3L8 15l-5.5-3.5v-3z" />
    </svg>
  ),
  components: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </svg>
  ),
  reports: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="2" y="8" width="3" height="6" rx="0.5" />
      <rect x="6.5" y="5" width="3" height="9" rx="0.5" />
      <rect x="11" y="2" width="3" height="12" rx="0.5" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.9 6.1 12.7 4.9l.4-1.7-1.5-.6-1 1.4-1.4-.3L8.6 2h-1.6l-.5 1.7-1.4.3-1-1.4-1.5.6.4 1.7-1.2 1.2L2 8c0 .1 0 .3.1.4l1.2 1.2-.4 1.7 1.5.6 1-1.4 1.4.3.5 1.7h1.6l.5-1.7 1.4-.3 1 1.4 1.5-.6-.4-1.7 1.2-1.2c.1-.1.1-.3.1-.4zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" />
    </svg>
  ),
  automation: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1 3 9h3.5L6.5 15 13 7H9.5L9.5 1z" />
    </svg>
  ),
  townhall: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5v3M4.5 3.5 6 5.5M11.5 3.5 10 5.5" />
      <circle cx="8" cy="9" r="2.5" />
      <path d="M2.5 13.5c1-2 3-3 5.5-3s4.5 1 5.5 3" />
    </svg>
  ),
};

const COLLAPSE_KEY = 'tf.sidebar.collapsed';

/** Collapse state persisted in localStorage; a custom event keeps every mounted
    sidebar (project pages render their own) in sync. */
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  useEffect(() => {
    const sync = () => setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    window.addEventListener('tf-sidebar-toggle', sync);
    return () => window.removeEventListener('tf-sidebar-toggle', sync);
  }, []);
  const toggle = () => {
    const next = !collapsed;
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    setCollapsed(next);
    window.dispatchEvent(new Event('tf-sidebar-toggle'));
  };
  return [collapsed, toggle];
}

function CollapseButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      className="absolute -right-3 top-16 z-10 flex items-center justify-center w-6 h-6 rounded-full border border-atl-n-30 bg-atl-paper text-atl-n-300 shadow-sm hover:text-atl-b-400 hover:border-atl-b-300"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {collapsed ? <path d="M3 1.5 6.5 5 3 8.5" /> : <path d="M7 1.5 3.5 5 7 8.5" />}
      </svg>
    </button>
  );
}

function NavItem({
  to,
  icon,
  label,
  disabledSprint,
  forceActive,
  collapsed,
}: {
  to?: string;
  icon: keyof typeof ICONS;
  label: string;
  disabledSprint?: string;
  forceActive?: boolean;
  collapsed?: boolean;
}) {
  const cls = `flex items-center gap-2.5 rounded text-sm ${
    collapsed ? 'justify-center px-0 py-2' : 'px-3 py-1.5'
  } ${
    disabledSprint
      ? 'text-atl-n-300 cursor-not-allowed'
      : 'text-atl-n-500 hover:bg-atl-n-20'
  }`;

  if (disabledSprint || !to) {
    return (
      <span
        className={cls}
        title={`Coming in Sprint ${disabledSprint}`}
        aria-disabled="true"
      >
        {ICONS[icon]}
        {!collapsed && label}
      </span>
    );
  }

  return (
    <NavLink
      to={to}
      end
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        isActive || forceActive
          ? `flex items-center gap-2.5 rounded text-sm bg-atl-b-50 text-atl-b-400 font-medium ${
              collapsed ? 'justify-center px-0 py-2' : 'px-3 py-1.5'
            }`
          : cls
      }
    >
      {ICONS[icon]}
      {!collapsed && label}
    </NavLink>
  );
}

export default function ProjectSidebar({
  projectKey,
  projectName,
  activeItem,
}: {
  projectKey: string;
  projectName: string;
  activeItem?: 'list' | 'settings';
}) {
  const { data: board } = useQuery({
    queryKey: ['board', projectKey],
    queryFn: () => fetchBoard(projectKey),
  });
  const { canAdmin } = usePermissions({ projectKey }, ['ADMINISTER_PROJECTS']);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const scrum = board?.type === 'scrum';
  return (
    <aside
      className={`relative shrink-0 border-r border-atl-n-30 bg-atl-paper flex flex-col transition-[width] ${
        collapsed ? 'w-[56px]' : 'w-[240px]'
      }`}
    >
      <CollapseButton collapsed={collapsed} onClick={toggleCollapsed} />
      <div className={`${collapsed ? 'px-2' : 'px-3'} pt-4 pb-3`}>
        <Link
          to={`/projects/${projectKey}`}
          className={`flex items-center gap-2.5 ${collapsed ? 'justify-center' : 'px-1'}`}
          title={collapsed ? projectName : undefined}
        >
          <ProjectAvatar projectKey={projectKey} name={projectName} />
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-sm font-semibold text-atl-n-800 truncate" title={projectName}>{projectName}</div>
              <div className="text-xs text-atl-n-100">Software project</div>
            </div>
          )}
        </Link>
      </div>

      <div className={`${collapsed ? 'px-2' : 'px-3'} pb-2`}>
        {!collapsed && (
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
            Planning
          </div>
        )}
        <nav className="space-y-0.5">
          {/* Jira order: Timeline → Backlog → Board → List → Reports,
              then a Releases/Components group, then Automation. */}
          <NavItem icon="timeline" label="Timeline" to={`/projects/${projectKey}/timeline`} collapsed={collapsed} />
          {scrum !== false && (
            <NavItem icon="backlog" label="Backlog" to={`/projects/${projectKey}/backlog`} collapsed={collapsed} />
          )}
          <NavItem icon="board" label="Board" to={`/projects/${projectKey}/board`} collapsed={collapsed} />
          {/* 058 US7 — the index is the project summary; List is the real
              issue navigator scoped to this project. */}
          <NavItem
            icon="list"
            label="Summary"
            to={`/projects/${projectKey}`}
            forceActive={activeItem === 'list'}
            collapsed={collapsed}
          />
          <NavItem
            icon="search"
            label="List"
            to={`/projects/${projectKey}/issues`}
            collapsed={collapsed}
          />
          {scrum && (
            <NavItem icon="reports" label="Reports" to={`/projects/${projectKey}/reports`} collapsed={collapsed} />
          )}
        </nav>
        <hr className="border-atl-n-30 my-2" />
        <nav className="space-y-0.5">
          <NavItem icon="releases" label="Releases" to={`/projects/${projectKey}/releases`} collapsed={collapsed} />
          <NavItem icon="components" label="Components" to={`/projects/${projectKey}/components`} collapsed={collapsed} />
          <NavItem icon="automation" label="Automation" to={`/projects/${projectKey}/automation`} collapsed={collapsed} />
          <NavItem icon="townhall" label="Town Hall" to={`/projects/${projectKey}/town-hall`} collapsed={collapsed} />
        </nav>
      </div>

      <div className="flex-1" />

      {canAdmin && (
        <div className={`${collapsed ? 'px-2' : 'px-3'} pb-4`}>
          <hr className="border-atl-n-30 mb-2" />
          <NavItem
            icon="settings"
            label="Project settings"
            to={`/projects/${projectKey}/settings`}
            forceActive={activeItem === 'settings'}
            collapsed={collapsed}
          />
        </div>
      )}
    </aside>
  );
}

/** Jira parity: on the settings route the project sidebar is replaced by a
    settings nav — "Back to project" + section links driving ?section=. */
export function ProjectSettingsSidebar({
  projectKey,
  projectName,
}: {
  projectKey: string;
  projectName: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = searchParams.get('section') ?? 'details';
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  const { data: project } = useQuery({
    queryKey: ['project', projectKey],
    queryFn: () => fetchProject(projectKey),
  });
  const { data: workflows } = useQuery({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows,
    enabled: Boolean(me?.isAdmin),
  });

  const items: readonly (readonly [string, string])[] = [
    ['details', 'Details'],
    ['people', 'People'],
    ...(me?.isAdmin && project?.schemeIds ? ([['schemes', 'Schemes']] as const) : []),
    ...(me?.isAdmin && workflows ? ([['workflow', 'Workflow']] as const) : []),
    ...(me?.isAdmin ? ([['archived', 'Archived issues']] as const) : []),
    ...(me?.isAdmin ? ([['danger', 'Danger zone']] as const) : []),
  ];

  return (
    <aside className="w-[240px] shrink-0 border-r border-atl-n-30 bg-atl-paper flex flex-col">
      <div className="px-3 pt-4 pb-3">
        <div className="px-1 text-sm font-semibold text-atl-n-800">Project settings</div>
        <div className="px-1 text-xs text-atl-n-100">{projectName}</div>
      </div>
      <nav className="px-3 space-y-0.5" aria-label="Project settings sections">
        {items.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSearchParams(id === 'details' ? {} : { section: id }, { replace: true })}
            className={`w-full flex items-center px-3 py-1.5 rounded text-sm text-left ${
              section === id
                ? 'bg-atl-b-50 text-atl-b-400 font-medium'
                : 'text-atl-n-500 hover:bg-atl-n-20'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      <div className="px-3 pb-4">
        <hr className="border-atl-n-30 mb-2" />
        <Link
          to={`/projects/${projectKey}`}
          className="flex items-center gap-2.5 px-3 py-1.5 rounded text-sm text-atl-n-500 hover:bg-atl-n-20"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3 5 8l5 5" />
          </svg>
          Back to project
        </Link>
      </div>
    </aside>
  );
}
