// 050 docs portal — OpenAPI explorer: tag-grouped, expandable operation rows.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchDocsOpenApi, type OpenApiSpec } from '../../api/client.js';
import { ChevronRightIcon, SearchIcon } from '../../components/icons.js';

interface SpecOp {
  method: string; path: string; summary: string; tags: string[]; extension: boolean;
  params: { name: string; in: string; required?: boolean }[];
}

function opsByTag(spec: OpenApiSpec) {
  const groups = new Map<string, SpecOp[]>();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!op || typeof op !== 'object') continue;
      const o = op as Record<string, unknown>;
      const tags = Array.isArray(o.tags) && o.tags.length ? (o.tags as string[]) : ['untagged'];
      const entry: SpecOp = {
        method: method.toUpperCase(),
        path,
        summary: String(o.summary ?? ''),
        tags: tags as string[],
        extension: 'x-trackforge-extension' in o,
        params: Array.isArray(o.parameters)
          ? (o.parameters as { name?: string; in?: string; required?: boolean }[])
              .filter((p) => p.name && p.in)
              .map((p) => ({ name: p.name!, in: p.in!, required: p.required }))
          : [],
      };
      for (const t of entry.tags) {
        const list = groups.get(t) ?? [];
        list.push(entry);
        groups.set(t, list);
      }
    }
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const METHOD_CLASS: Record<string, string> = {
  GET: 'm-get', POST: 'm-post', PUT: 'm-put', PATCH: 'm-patch', DELETE: 'm-delete',
};

export function ApiExplorer() {
  const spec = useQuery({ queryKey: ['docs-openapi'], queryFn: fetchDocsOpenApi, retry: false });
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  if (spec.isLoading) {
    return <div className="min-w-0 flex-1 p-10 text-sm text-[var(--d-faint)]">Loading API reference…</div>;
  }
  if (spec.isError) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-10">
        <div className="text-lg font-semibold text-[var(--d-text)]">API reference requires sign-in</div>
        <div className="mt-1 text-sm text-[var(--d-muted)]">
          Set <code className="text-[var(--d-text)]">DOCS_PUBLIC=on</code> to publish it, or{' '}
          <Link className="text-[var(--d-accent)] hover:underline" to="/login">sign in</Link>.
        </div>
      </div>
    );
  }

  const allGroups = opsByTag(spec.data!);
  const total = allGroups.reduce((n, [, ops]) => n + ops.length, 0);
  const matches = (o: SpecOp, tag: string) =>
    !filter ||
    tag.toLowerCase().includes(filter) ||
    o.path.toLowerCase().includes(filter) ||
    o.summary.toLowerCase().includes(filter);
  const groups = allGroups
    .map(([tag, ops]) => [tag, ops.filter((o) => matches(o, tag))] as const)
    .filter(([, ops]) => ops.length);

  return (
    <div className="d-scrollbar min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 pb-16 pt-7 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[30px] font-bold leading-tight tracking-tight text-[var(--d-text)]">
              API reference
            </h1>
            <p className="mt-2 text-[15px] text-[var(--d-muted)]">
              Rendered from the served OpenAPI document — always in sync with this build.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {spec.data?.info?.version && <span className="d-chip">v{spec.data.info.version}</span>}
            <span className="d-chip">{total} endpoints</span>
          </div>
        </div>

        <div className="relative mt-5 max-w-sm">
          <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--d-faint)]" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value.toLowerCase())}
            placeholder="Filter endpoints…"
            className="d-input pl-8"
          />
        </div>

        {groups.map(([tag, ops]) => (
          <section key={tag} className="mt-8">
            <h2 className="border-b border-[var(--d-border)] pb-1.5 text-[15px] font-semibold tracking-tight text-[var(--d-text)]">
              {tag} <span className="font-normal text-[var(--d-faint)]">({ops.length})</span>
            </h2>
            <div className="mt-1 divide-y divide-[var(--d-border-soft)]">
              {ops.map((o) => {
                const key = `${o.method} ${o.path}`;
                const isOpen = open === key;
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : key)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-[var(--d-hover)]"
                    >
                      <span className={`m-chip ${METHOD_CLASS[o.method] ?? 'm-other'}`}>{o.method}</span>
                      <code className="truncate font-mono text-[13px] text-[var(--d-text)]" title={o.path}>{o.path}</code>
                      {o.extension && (
                        <Link
                          to="/docs/page/compatibility"
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 rounded bg-[var(--d-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--d-accent)]"
                          title="TrackForge extension — see compatibility notes"
                        >
                          ext
                        </Link>
                      )}
                      <span className="ml-auto hidden truncate text-xs text-[var(--d-faint)] md:block md:max-w-[40%]" title={o.summary}>
                        {o.summary}
                      </span>
                      <ChevronRightIcon
                        size={12}
                        className={`shrink-0 text-[var(--d-faint)] transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="mx-2 mb-2 rounded-lg border border-[var(--d-border-soft)] bg-[var(--d-surface)] px-4 py-3 text-[13px]">
                        {o.summary && <div className="text-[var(--d-text-subtle)]">{o.summary}</div>}
                        {o.params.length > 0 && (
                          <table className="mt-2 w-full">
                            <thead>
                              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--d-faint)]">
                                <th className="pb-1 pr-3 font-semibold">Parameter</th>
                                <th className="pb-1 pr-3 font-semibold">In</th>
                                <th className="pb-1 font-semibold">Required</th>
                              </tr>
                            </thead>
                            <tbody>
                              {o.params.map((p) => (
                                <tr key={p.name} className="border-t border-[var(--d-border-soft)]">
                                  <td className="py-1.5 pr-3 font-mono text-xs text-[var(--d-text)]">{p.name}</td>
                                  <td className="py-1.5 pr-3 text-xs text-[var(--d-muted)]">{p.in}</td>
                                  <td className="py-1.5 text-xs text-[var(--d-muted)]">
                                    {p.required ? 'required' : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {o.extension && (
                          <div className="mt-2 text-xs text-[var(--d-muted)]">
                            TrackForge extension — not part of the Jira-compatible surface. See{' '}
                            <Link to="/docs/page/compatibility" className="text-[var(--d-accent)] hover:underline">
                              compatibility notes
                            </Link>.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {!groups.length && (
          <div className="mt-8 text-sm text-[var(--d-faint)]">No endpoints match “{filter}”.</div>
        )}
      </div>
    </div>
  );
}
