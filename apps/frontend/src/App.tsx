import { Suspense, lazy, useEffect, useState } from 'react';
import { Routes, Route, Outlet, Navigate, useLocation, Link } from 'react-router-dom';
import TopNav from './components/TopNav.js';
import RequireAuth from './components/RequireAuth.js';
import RequireAdmin from './components/RequireAdmin.js';
import AdminLayout from './layout/AdminLayout.js';
import CommandPalette from './components/CommandPalette.js';
import { COPILOT_OPEN_EVENT } from './lib/copilotBus.js';
import ProjectLayout from './layout/ProjectLayout.js';
import LoginPage from './pages/LoginPage.js';
import InviteAcceptPage from './pages/InviteAcceptPage.js';
import YourWorkPage from './pages/YourWorkPage.js';
// Route-level code splitting: only the app shell + pre-auth routes + the
// default landing page ship in the entry bundle. Every page below loads on
// first visit, suspended at the nearest layout boundary so sidebars/nav stay.
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage.js'));
const AdminGroupsPage = lazy(() => import('./pages/AdminGroupsPage.js'));
const AdminTokensPage = lazy(() => import('./pages/AdminTokensPage.js'));
const AdminAuditPage = lazy(() => import('./pages/AdminAuditPage.js'));
const AdminMetadataPage = lazy(() => import('./pages/AdminMetadataPage.js'));
const AdminSchemesPage = lazy(() => import('./pages/AdminSchemesPage.js'));
const AdminScreensPage = lazy(() => import('./pages/AdminScreensPage.js'));
const AdminFieldConfigPage = lazy(() => import('./pages/AdminFieldConfigPage.js'));
const AdminProjectsPage = lazy(() => import('./pages/AdminProjectsPage.js'));
const AdminOrgPage = lazy(() => import('./pages/AdminOrgPage.js'));
const AdminIdentityPage = lazy(() => import('./pages/AdminIdentityPage.js'));
const AdminIntegrationsPage = lazy(() => import('./pages/AdminIntegrationsPage.js'));
const AdminMailPage = lazy(() => import('./pages/AdminMailPage.js'));
const AdminNotificationsPage = lazy(() => import('./pages/AdminNotificationsPage.js'));
const CopilotDock = lazy(() => import('./components/CopilotDock.js'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage.js'));
const ProjectSummaryPage = lazy(() => import('./pages/ProjectSummaryPage.js'));
const IssueDetailPage = lazy(() => import('./pages/IssueDetailPage.js'));
const BoardPage = lazy(() => import('./pages/BoardPage.js'));
const BoardSettingsPage = lazy(() => import('./pages/BoardSettingsPage.js'));
const AutomationPage = lazy(() => import('./pages/AutomationPage.js'));
const BacklogPage = lazy(() => import('./pages/BacklogPage.js'));
const RoadmapPage = lazy(() => import('./pages/RoadmapPage.js'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.js'));
const ReleasesPage = lazy(() => import('./pages/ReleasesPage.js'));
const ComponentsPage = lazy(() => import('./pages/ComponentsPage.js'));
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage.js'));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage.js'));
const WorkflowEditorPage = lazy(() => import('./pages/WorkflowEditorPage.js'));
const SearchPage = lazy(() => import('./pages/SearchPage.js'));
const IssueNavigatorPage = lazy(() => import('./pages/IssueNavigatorPage.js'));
const TeamsPage = lazy(() => import('./pages/TeamsPage.js'));
const FiltersPage = lazy(() => import('./pages/FiltersPage.js'));
const WebhooksPage = lazy(() => import('./pages/WebhooksPage.js'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage.js'));
const TownHallPage = lazy(() => import('./pages/TownHallPage.js'));
const AiSettingsPage = lazy(() => import('./pages/AiSettingsPage.js'));
const CustomFieldsPage = lazy(() => import('./pages/CustomFieldsPage.js'));
const DashboardsPage = lazy(() => import('./pages/DashboardsPage.js'));
const MigrationPage = lazy(() => import('./pages/MigrationPage.js'));
const SystemPage = lazy(() => import('./pages/SystemPage.js'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.js'));
const UserProfilePage = lazy(() => import('./pages/UserProfilePage.js'));
const ConnectPage = lazy(() => import('./pages/ConnectPage.js'));
// 050 — the docs portal is a heavy chunk (explorer); lazy per route.
const DocsPortalPage = lazy(() => import('./pages/docs/DocsPortalPage.js'));
import { useEventStream } from './api/events.js';
import { useGlobalShortcuts, SHORTCUTS_PREF } from './hooks/useGlobalShortcuts.js';
import { fetchPreferences, fetchProfile } from './api/client.js';
import { useQuery } from '@tanstack/react-query';
import ShortcutsHelp from './components/ShortcutsHelp.js';
import { FlagProvider } from './components/Flag.js';
import { initI18n, setLocale } from './i18n.js';
import { pageTitleFor } from './lib/pageTitle.js';

initI18n();

function AppShell() {
  useEventStream();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const prefs = useQuery({ queryKey: ['preferences'], queryFn: fetchPreferences });
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  useEffect(() => {
    setLocale(profile.data?.user.locale);
  }, [profile.data]);
  const shortcutsOn = (prefs.data as Record<string, unknown> | undefined)?.[SHORTCUTS_PREF] !== false;
  useGlobalShortcuts(shortcutsOn, () => setHelpOpen((o) => !o));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      // 068 — Ctrl+J toggles the Copilot workbench dock.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setCopilotOpen((o) => !o);
      }
    };
    const onOpen = () => setPaletteOpen(true);
    const onCopilot = () => setCopilotOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('tf:open-palette', onOpen);
    window.addEventListener(COPILOT_OPEN_EVENT, onCopilot);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('tf:open-palette', onOpen);
      window.removeEventListener(COPILOT_OPEN_EVENT, onCopilot);
    };
  }, []);
  return (
    <div className="h-full flex flex-col">
      <FlagProvider>
        <TopNav />
        {/* 068 — the dock is a layout column, not an overlay: pages shrink
            beside it and keep working while a thread stays open. */}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Boundary for lazy route chunks — the shell stays put while the
                first visit to a page loads its code. */}
            <Suspense fallback={<div className="p-8 text-sm text-atl-n-300">Loading…</div>}>
              <Outlet />
            </Suspense>
          </div>
          {copilotOpen && (
            <Suspense fallback={null}>
              <CopilotDock onClose={() => setCopilotOpen(false)} />
            </Suspense>
          )}
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} enabled={shortcutsOn} />
      </FlagProvider>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-24">
      <p className="text-lg font-semibold text-atl-n-500 mb-2">Page not found</p>
      <p className="text-sm text-atl-n-200 mb-4">The page you're looking for doesn't exist.</p>
      <Link to="/" className="text-sm text-atl-b-300 hover:underline">
        Back to your work
      </Link>
    </div>
  );
}

function App() {
  const location = useLocation();
  useEffect(() => {
    const title = pageTitleFor(location.pathname);
    document.title = title === 'TrackForge' ? title : `${title} - TrackForge`;
  }, [location.pathname]);
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InviteAcceptPage />} />
      {/* 050 — public per DOCS_PUBLIC + page audience (server-filtered) */}
      <Route
        path="/docs/*"
        element={
          <Suspense fallback={<div className="p-8 text-sm">Loading docs…</div>}>
            <DocsPortalPage />
          </Suspense>
        }
      />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<YourWorkPage />} />
          <Route path="/your-work" element={<YourWorkPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route element={<RequireAdmin />}>
            <Route element={<AdminLayout />}>
              <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/admin/groups" element={<AdminGroupsPage />} />
              <Route path="/admin/people" element={<TeamsPage />} />
              <Route path="/admin/tokens" element={<AdminTokensPage />} />
              <Route path="/admin/audit" element={<AdminAuditPage />} />
              <Route path="/admin/metadata" element={<AdminMetadataPage />} />
              <Route path="/admin/schemes" element={<AdminSchemesPage />} />
              <Route path="/admin/screens" element={<AdminScreensPage />} />
              <Route path="/admin/field-config" element={<AdminFieldConfigPage />} />
              <Route path="/admin/projects" element={<AdminProjectsPage />} />
              <Route path="/admin/organization" element={<AdminOrgPage />} />
              <Route path="/admin/identity" element={<AdminIdentityPage />} />
              <Route path="/admin/integrations" element={<AdminIntegrationsPage />} />
              <Route path="/admin/notifications" element={<AdminNotificationsPage />} />
              <Route path="/admin/migration" element={<MigrationPage />} />
              <Route path="/admin/system" element={<SystemPage />} />
              <Route path="/admin/mail" element={<AdminMailPage />} />
              {/* 042 F-027: admin-linked settings live inside the shell so admin
                  nav persists (Jira: workflow/field/webhook admin is admin-only) */}
              <Route path="/settings/webhooks" element={<WebhooksPage />} />
              <Route path="/settings/customfields" element={<CustomFieldsPage />} />
              <Route path="/settings/workflows" element={<WorkflowsPage />} />
              <Route path="/settings/workflows/:workflowId" element={<WorkflowEditorPage />} />
              <Route path="/settings/ai" element={<AiSettingsPage />} />
            </Route>
          </Route>
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/town-hall" element={<TownHallPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/profile/:accountId" element={<UserProfilePage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/projects/:projectKey" element={<ProjectLayout />}>
            <Route index element={<ProjectSummaryPage />} />
            <Route path="board" element={<BoardPage />} />
            <Route path="board/settings" element={<BoardSettingsPage />} />
            <Route path="backlog" element={<BacklogPage />} />
            <Route path="issues" element={<IssueNavigatorPage />} />
            <Route path="timeline" element={<RoadmapPage />} />
            <Route path="roadmap" element={<Navigate to="../timeline" replace />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:reportId" element={<ReportsPage />} />
            <Route path="releases" element={<ReleasesPage />} />
            <Route path="components" element={<ComponentsPage />} />
            <Route path="settings" element={<ProjectSettingsPage />} />
            <Route path="automation" element={<AutomationPage />} />
            <Route path="town-hall" element={<TownHallPage />} />
          </Route>
          <Route path="/issues" element={<SearchPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/filters" element={<FiltersPage />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/dashboards/:id" element={<DashboardsPage />} />
          <Route path="/browse/:issueKey" element={<IssueDetailPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default App;
