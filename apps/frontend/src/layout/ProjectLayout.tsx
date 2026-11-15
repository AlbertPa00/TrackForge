import { Suspense } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchProject } from '../api/client.js';
import ProjectSidebar, { ProjectSettingsSidebar } from '../components/ProjectSidebar.js';

export default function ProjectLayout() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const { pathname } = useLocation();
  const { data: project } = useQuery({
    queryKey: ['project', projectKey],
    queryFn: () => fetchProject(projectKey!),
    enabled: Boolean(projectKey),
  });
  const onSettings = pathname.endsWith('/settings');

  return (
    <div className="flex flex-1 min-h-0">
      {onSettings ? (
        <ProjectSettingsSidebar projectKey={projectKey ?? ''} projectName={project?.name ?? projectKey ?? ''} />
      ) : (
        <ProjectSidebar projectKey={projectKey ?? ''} projectName={project?.name ?? projectKey ?? ''} />
      )}
      <main className="flex-1 min-w-0 overflow-y-auto bg-atl-paper">
        {/* Inner boundary: lazy project pages suspend here so the project
            sidebar stays mounted during nav. */}
        <Suspense fallback={<div className="p-8 text-sm text-atl-n-300">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
