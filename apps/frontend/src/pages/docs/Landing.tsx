// 050 docs portal — landing: hero + search + quick links + section cards.
import { Link } from 'react-router-dom';
import { ArrowRightIcon, CodeIcon, RocketIcon, SearchIcon, SwapIcon } from '../../components/icons.js';
import { orderedSections, pagesInSection, sectionIcon } from './nav.js';
import { useManifest } from './Sidebar.js';

function QuickCard({ to, icon: Icon, title, desc }: {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  desc: string;
}) {
  return (
    <Link to={to} className="d-card d-card-link group flex items-start gap-3 p-4">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--d-accent-soft)] text-[var(--d-accent)]">
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--d-text)]">
          {title}
          <ArrowRightIcon size={12} className="text-[var(--d-faint)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--d-accent)]" />
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-[var(--d-muted)]">{desc}</span>
      </span>
    </Link>
  );
}

export function Landing({ onSearch }: { onSearch: () => void }) {
  const manifest = useManifest();
  if (!manifest.data) return <div className="min-w-0 flex-1 p-10 text-sm text-[var(--d-faint)]">Loading…</div>;
  const m = manifest.data;
  const publicOnly = m.pages.every((p) => p.audience === 'public');
  const has = (slug: string) => m.pages.some((p) => p.slug === slug);

  return (
    <div className="d-scrollbar min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pb-16 pt-12 lg:px-10 lg:pt-16">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-bold tracking-tight text-[var(--d-text)]">
            TrackForge documentation
          </h1>
          <p className="mt-3 text-[16px] leading-relaxed text-[var(--d-muted)]">
            A self-hosted, Jira-compatible issue tracker — issues, boards, sprints, JQL,
            automation, a Jira-shaped REST API, and first-class agent tools. These docs
            ship with the product and match the running version.
          </p>
          <button
            type="button"
            onClick={onSearch}
            className="d-input mt-6 flex max-w-md items-center gap-2.5 py-2.5 text-left text-[var(--d-faint)] hover:border-[var(--d-accent)]"
          >
            <SearchIcon size={15} />
            <span className="flex-1">Search documentation…</span>
            <kbd className="d-kbd">Ctrl</kbd>
            <kbd className="d-kbd">K</kbd>
          </button>
          {publicOnly && (
            <div className="tf-callout tf-callout-note mt-6">
              <div className="tf-callout-title">PUBLIC DOCS</div>
              <p>
                You're browsing the public docs.{' '}
                <Link to="/login" className="font-medium text-[var(--d-accent)] hover:underline">
                  Sign in
                </Link>{' '}
                for the full guide set.
              </p>
            </div>
          )}
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          {has('install') && (
            <QuickCard to="/docs/page/install" icon={RocketIcon} title="Install in 10 minutes"
              desc="Single-container deployment with Docker Compose." />
          )}
          <QuickCard to="/docs/api" icon={CodeIcon} title="API reference"
            desc="Jira v2-compatible REST, rendered from the served spec." />
          {has('migration') && (
            <QuickCard to="/docs/page/migration" icon={SwapIcon} title="Migrate from Jira"
              desc="Import projects, issues, and history." />
          )}
        </div>

        <h2 className="mt-12 text-lg font-semibold tracking-tight text-[var(--d-text)]">
          Browse by section
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orderedSections(m).map((sec) => {
            const list = pagesInSection(m, sec);
            if (!list.length) return null;
            const Icon = sectionIcon(m.sectionMeta?.[sec]?.icon);
            return (
              <Link key={sec} to={`/docs/page/${list[0].slug}`} className="d-card d-card-link group flex flex-col p-4">
                <span className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--d-accent-soft)] text-[var(--d-accent)]">
                    <Icon size={16} />
                  </span>
                  <span className="text-sm font-semibold text-[var(--d-text)] group-hover:text-[var(--d-accent)]">
                    {m.sections[sec] ?? sec}
                  </span>
                </span>
                {m.sectionMeta?.[sec]?.description && (
                  <span className="mt-2 text-[13px] leading-snug text-[var(--d-muted)]">
                    {m.sectionMeta[sec].description}
                  </span>
                )}
                <span className="mt-3 flex items-center gap-1 text-xs text-[var(--d-faint)]">
                  {list.length} page{list.length === 1 ? '' : 's'}
                  <ArrowRightIcon size={11} className="transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
