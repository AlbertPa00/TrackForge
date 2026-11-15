import { useParams } from 'react-router-dom';
import IssueSearchView from '../components/IssueSearchView.js';

export default function IssueNavigatorPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  return <IssueSearchView fixedProjectKey={projectKey} />;
}
