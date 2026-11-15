// Sprint 038 US2 — Jira "Development" panel on the issue page.
import { useQuery } from '@tanstack/react-query';
import { fetchDevPanel, type DevItem } from '../api/client.js';
import { isSafeHref } from '../lib/url.js';

function Row({ i, mono }: { i: DevItem; mono?: boolean }) {
  return (
    <li className="flex items-center gap-2 py-0.5">
      <span className={`truncate ${mono ? 'font-mono text-xs' : ''}`} title={i.title}>
        {i.url && isSafeHref(i.url) ? (
          <a className="text-atl-b-300 hover:underline" href={i.url} target="_blank" rel="noreferrer">
            {i.title}
          </a>
        ) : (
          i.title
        )}
      </span>
      {i.state && <span className="text-[11px] px-1.5 rounded bg-atl-n-10 text-atl-n-300">{i.state}</span>}
      <span className="ml-auto text-xs text-atl-n-200 shrink-0">{i.repo}</span>
    </li>
  );
}

function Section({ title, items, mono }: { title: string; items: DevItem[]; mono?: boolean }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="text-xs font-semibold text-atl-n-300 mb-1">
        {title} <span className="font-normal">({items.length})</span>
      </div>
      <ul>
        {items.map((i) => (
          <Row key={i.id} i={i} mono={mono} />
        ))}
      </ul>
    </div>
  );
}

export default function DevelopmentPanel({ issueKey }: { issueKey: string }) {
  const { data } = useQuery({ queryKey: ['dev', issueKey], queryFn: () => fetchDevPanel(issueKey) });
  if (!data) return null;
  const total =
    data.branches.length +
    data.commits.length +
    data.pullRequests.length +
    data.builds.length +
    data.deployments.length;
  if (total === 0) return null; // FR-005: hidden when nothing linked
  return (
    <section className="mb-4 border border-atl-n-30 rounded">
      <div className="px-4 py-2.5 border-b border-atl-n-30">
        <h3 className="text-xs font-semibold text-atl-n-300">Development</h3>
      </div>
      <div className="px-4 py-3 space-y-3">
        <Section title="Branches" items={data.branches} mono />
        <Section title="Pull requests" items={data.pullRequests} />
        <Section title="Commits" items={data.commits} mono />
        <Section title="Builds" items={data.builds} />
        <Section title="Deployments" items={data.deployments} />
      </div>
    </section>
  );
}
