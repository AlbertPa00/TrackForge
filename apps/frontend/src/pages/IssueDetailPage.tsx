import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchIssue } from '../api/client.js';
import ProjectSidebar from '../components/ProjectSidebar.js';
import IssueDetailView from '../components/IssueDetailView.js';

/**
 * Jira Server/DC issue view: the project sidebar stays visible on /browse/:key
 * (issue navigator → Issues), and the issue detail renders full-fidelity in the
 * main column — the same IssueDetailView used by the navigator's split pane.
 */
export default function IssueDetailPage() {
  const { issueKey } = useParams<{ issueKey: string }>();
  const { data: issue } = useQuery({
    queryKey: ['issue', issueKey],
    queryFn: () => fetchIssue(issueKey!),
    enabled: Boolean(issueKey),
    retry: false,
  });
  const projectKey = issue?.fields.project.key;
  return (
    <div className="flex flex-1 min-h-0">
      {projectKey && (
        <ProjectSidebar projectKey={projectKey} projectName={issue!.fields.project.name} activeItem="list" />
      )}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-atl-paper">
        {issueKey && <IssueDetailView issueKey={issueKey} />}
      </main>
    </div>
  );
}
