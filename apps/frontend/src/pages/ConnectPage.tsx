// /connect — one-stop "connect an agent or IDE" surface: the canonical /mcp
// URL, per-client recipes (OAuth sign-in vs Bearer PAT), and the UI for
// self-service PAT minting (POST /api/internal/tokens is session-only).
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createToken, fetchMyTokens, revokeToken, type ApiTokenInfo } from '../api/client.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

const mcpUrl = `${window.location.origin}/mcp`;

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy to clipboard"
      className="text-xs text-atl-b-300 hover:underline shrink-0"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function CodeRow({ code, title, children }: { code: string; title?: string; children?: ReactNode }) {
  return (
    <div className="mt-1.5">
      <div className="flex items-start gap-2">
        <pre className="flex-1 text-xs bg-atl-n-10 rounded px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all text-atl-n-700">
          {code}
        </pre>
        <Copy text={code} />
      </div>
      {children && <p className="text-xs text-atl-n-200 mt-1">{children}</p>}
      {title && <span className="sr-only">{title}</span>}
    </div>
  );
}

interface Recipe {
  name: string;
  intro: string;
  codes: { code: string; note?: string }[];
  link?: { href: string; label: string };
}

// OAuth-capable clients: paste the URL, complete sign-in in the browser, done.
const OAUTH_RECIPES: Recipe[] = [
  {
    name: 'Claude Code',
    intro: 'Registers a remote server and runs the OAuth flow in your browser.',
    codes: [{ code: `claude mcp add --transport http trackforge ${mcpUrl}` }],
  },
  {
    name: 'Claude (web & desktop)',
    intro: 'Settings → Connectors → Add custom connector → paste the endpoint URL.',
    codes: [{ code: mcpUrl, note: 'Sign in with your TrackForge account when prompted.' }],
  },
  {
    name: 'VS Code',
    intro: 'One-click install, or add to .vscode/mcp.json in your workspace.',
    link: {
      href: `vscode:mcp/install?${encodeURIComponent(
        JSON.stringify({ name: 'trackforge', type: 'http', url: mcpUrl })
      )}`,
      label: 'Install in VS Code',
    },
    codes: [
      {
        code: JSON.stringify(
          { servers: { trackforge: { type: 'http', url: mcpUrl } } },
          null,
          2
        ),
        note: '.vscode/mcp.json — OAuth sign-in happens in the editor.',
      },
    ],
  },
  {
    name: 'Cursor',
    intro: 'One-click install, or add to ~/.cursor/mcp.json.',
    link: {
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=trackforge&config=${btoa(
        JSON.stringify({ url: mcpUrl })
      )}`,
      label: 'Install in Cursor',
    },
    codes: [
      {
        code: JSON.stringify({ mcpServers: { trackforge: { url: mcpUrl } } }, null, 2),
      },
    ],
  },
  {
    name: 'Windsurf',
    intro: 'Add to ~/.codeium/windsurf/mcp_config.json.',
    codes: [
      {
        code: JSON.stringify({ mcpServers: { trackforge: { serverUrl: mcpUrl } } }, null, 2),
      },
    ],
  },
];

function PatSection() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['my-tokens'], queryFn: fetchMyTokens });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [projects, setProjects] = useState('');
  const [expiry, setExpiry] = useState('');
  const [policy, setPolicy] = useState('');
  const [created, setCreated] = useState<(ApiTokenInfo & { secret: string }) | null>(null);

  const mint = useMutation({
    mutationFn: () =>
      createToken({
        name: name.trim(),
        scopes,
        projectKeys: projects
          .split(',')
          .map((k) => k.trim().toUpperCase())
          .filter(Boolean),
        ...(expiry ? { expiresAt: new Date(`${expiry}T23:59:59`).toISOString() } : {}),
        ...(policy ? { approvalPolicy: policy as 'always' | 'destructiveOnly' | 'never' } : {}),
      }),
    onSuccess: (t) => {
      setCreated(t);
      setName('');
      void qc.invalidateQueries({ queryKey: ['my-tokens'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-tokens'] }),
  });

  const toggle = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <section className="bg-atl-paper rounded shadow-sm p-4 space-y-4">
      <div>
        <h2 className="font-medium text-atl-n-800">Personal access tokens</h2>
        <p className="text-xs text-atl-n-200 mt-1">
          For clients that can't do OAuth — stdio clients, scripts, CI. The secret is shown once;
          treat configs containing it as credentials.
        </p>
      </div>

      <div className="text-sm space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-atl-n-500">Name</span>
            <input
              className="border border-atl-n-40 rounded px-2 py-1.5 text-sm w-48"
              placeholder="e.g. claude-desktop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-atl-n-500">Scopes</span>
            <div className="flex gap-3 pb-1.5">
              {(['read', 'write', 'admin'] as const).map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                  {s}
                </label>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-atl-n-500">Projects (optional, comma-separated keys)</span>
            <input
              className="border border-atl-n-40 rounded px-2 py-1.5 text-sm w-56"
              placeholder="TF, OPS — blank = all projects"
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-atl-n-500">Expires (optional)</span>
            <input
              type="date"
              className="border border-atl-n-40 rounded px-2 py-1.5 text-sm"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-atl-n-500">Approval policy (optional)</span>
            <select
              className="border border-atl-n-40 rounded px-2 py-1.5 text-sm bg-atl-paper"
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
            >
              <option value="">Inherit</option>
              <option value="never">Never — writes execute</option>
              <option value="destructiveOnly">Destructive only — deletes need approval</option>
              <option value="always">Always — every write is a proposal</option>
            </select>
          </label>
          <button
            className="bg-atl-b-300 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={!name.trim() || scopes.length === 0 || mint.isPending}
            onClick={() => mint.mutate()}
          >
            {mint.isPending ? 'Creating…' : 'Create token'}
          </button>
        </div>
        {mint.isError && <div className="text-sm text-atl-r-400">{(mint.error as Error).message}</div>}
      </div>

      {created && (
        <div className="border border-atl-y-300 bg-atl-y-50 rounded p-3 space-y-2">
          <div className="text-sm font-medium text-atl-n-800">
            Token "{created.name}" created — copy the secret now, it won't be shown again:
          </div>
          <CodeRow code={created.secret} />
          <div className="text-xs text-atl-n-500">Ready-made configs for token-based clients:</div>
          <CodeRow
            code={`npx -y mcp-remote ${mcpUrl} --header "Authorization: Bearer ${created.secret}"`}
          >
            Any stdio-only client (Claude Desktop, older IDE plugins) — bridges to the remote endpoint.
          </CodeRow>
          <CodeRow
            code={JSON.stringify(
              {
                mcpServers: {
                  trackforge: {
                    command: 'npx',
                    args: [
                      '-y',
                      'mcp-remote',
                      mcpUrl,
                      '--header',
                      `Authorization: Bearer ${created.secret}`,
                    ],
                  },
                },
              },
              null,
              2
            )}
          >
            Claude Desktop / mcp_config.json equivalent.
          </CodeRow>
        </div>
      )}

      {tokens.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {tokens.data && tokens.data.length === 0 && <EmptyState title="No tokens yet" />}
      {(tokens.data?.length ?? 0) > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
              <th className="py-1.5 pr-3">Name</th>
              <th className="py-1.5 pr-3">Scopes</th>
              <th className="py-1.5 pr-3">Projects</th>
              <th className="py-1.5 pr-3">Last used</th>
              <th className="py-1.5 pr-3">Expires</th>
              <th className="py-1.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.data!.map((t) => (
              <tr key={t.id} className="border-b border-atl-n-20 last:border-0">
                <td className="py-1.5 pr-3 text-atl-n-800">
                  {t.name} <span className="text-xs text-atl-n-100">{t.prefix}…</span>
                </td>
                <td className="py-1.5 pr-3">
                  {t.scopes.map((s) => (
                    <span
                      key={s}
                      className="mr-1 text-[11px] font-medium text-atl-n-500 bg-atl-n-20 rounded px-1.5 py-0.5"
                    >
                      {s}
                    </span>
                  ))}
                </td>
                <td className="py-1.5 pr-3 text-xs text-atl-n-500">
                  {t.projectKeys.length ? t.projectKeys.join(', ') : 'all'}
                </td>
                <td className="py-1.5 pr-3 text-xs text-atl-n-500">
                  {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : '—'}
                </td>
                <td className="py-1.5 pr-3 text-xs text-atl-n-500">
                  {t.expiresAt ? formatDateTime(t.expiresAt) : '—'}
                </td>
                <td className="py-1.5 text-right">
                  {t.revokedAt ? (
                    <span className="text-xs text-atl-n-200">Revoked</span>
                  ) : (
                    <button
                      className="text-sm text-atl-r-400 hover:underline"
                      onClick={() => revoke.mutate(t.id)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function ConnectPage() {
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-atl-n-800">Connect agents &amp; IDEs</h1>
        <p className="text-sm text-atl-n-200 mt-1">
          TrackForge's tools, issues and workflows are available to AI agents over MCP (Model
          Context Protocol). Point your client at the endpoint below.
        </p>
      </div>

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800">MCP endpoint</h2>
        <CodeRow code={mcpUrl}>
          Streamable HTTP. <code className="text-xs">{mcpUrl}/readonly</code> or{' '}
          <code className="text-xs">?toolset=readonly</code> serves a read-only toolset — write tools
          are hidden and refused.
        </CodeRow>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4 space-y-5">
        <div>
          <h2 className="font-medium text-atl-n-800">Recommended — OAuth clients</h2>
          <p className="text-xs text-atl-n-200 mt-1">
            These clients support MCP authorization: they register themselves, open your browser for
            a one-time sign-in + consent, then refresh tokens automatically. Nothing to paste or
            rotate. Grants appear under Profile → Connected apps.
          </p>
        </div>
        {OAUTH_RECIPES.map((r) => (
          <div key={r.name}>
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium text-atl-n-800">{r.name}</h3>
              {r.link && (
                <a
                  href={r.link.href}
                  className="text-xs font-medium text-white bg-atl-b-300 hover:bg-atl-b-400 rounded px-2.5 py-1"
                >
                  {r.link.label}
                </a>
              )}
            </div>
            <p className="text-xs text-atl-n-200 mt-0.5">{r.intro}</p>
            {r.codes.map((c, i) => (
              <CodeRow key={i} code={c.code}>
                {c.note}
              </CodeRow>
            ))}
          </div>
        ))}
      </section>

      <PatSection />

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800">Repo-checkout stdio (developing TrackForge)</h2>
        <CodeRow
          code={`TRACKFORGE_URL=${window.location.origin} TRACKFORGE_TOKEN=<tfp_* PAT> pnpm --filter trackforge-mcp start`}
        >
          For contributors running the MCP server from a local checkout — see docs/mcp.md.
        </CodeRow>
      </section>
    </div>
  );
}
