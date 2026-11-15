// 049 admin UI — /admin/identity: OAuth clients + directory connections (SCIM/LDAP).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchOAuthClients,
  createOAuthClient,
  updateOAuthClient,
  deleteOAuthClient,
  fetchDirectoryConnections,
  createDirectoryConnection,
  updateDirectoryConnection,
  deleteDirectoryConnection,
  mintScimToken,
  testLdapConnection,
  syncLdapConnection,
  type OAuthClientAdmin,
  type DirectoryConnection,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';
const BTN = 'h-8 px-3 rounded-[3px] text-sm font-medium';
const PRIMARY = BTN + ' bg-atl-b-400 hover:bg-atl-b-500 text-white disabled:opacity-40';
const SUBTLE = BTN + ' text-atl-n-500 hover:bg-atl-n-20';
const ERR = 'rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500';

const GRANT_TYPES = [
  'authorization_code',
  'client_credentials',
  'urn:ietf:params:oauth:grant-type:device_code',
] as const;
const SCOPES = ['read', 'write', 'admin'] as const;

function Checked({
  v,
  onChange,
  options,
}: {
  v: Set<string>;
  onChange: (s: Set<string>) => void;
  options: readonly string[];
}) {
  const toggle = (o: string) => {
    const next = new Set(v);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    onChange(next);
  };
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-1.5 text-sm text-atl-n-600">
          <input type="checkbox" checked={v.has(o)} onChange={() => toggle(o)} />
          <span className="font-mono text-xs">{o.replace('urn:ietf:params:oauth:grant-type:', 'device:')}</span>
        </label>
      ))}
    </div>
  );
}

/** One-time secret banner (client secret / scim token shown exactly once). */
function SecretBanner({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return (
    <Modal open onClose={onDone}>
      <div className="p-5 max-w-lg">
        <h2 className="text-base font-semibold text-atl-n-800 mb-2">{label}</h2>
        <p className="text-sm text-atl-n-500 mb-3">Copy it now — it is never shown again.</p>
        <code className="block break-all rounded bg-atl-n-10 border border-atl-n-30 px-3 py-2 text-xs font-mono text-atl-n-700">
          {value}
        </code>
        <div className="flex justify-end mt-4">
          <button className={PRIMARY} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- OAuth clients ----------------

function ClientDialog({ client, onClose }: { client: OAuthClientAdmin | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(client?.name ?? '');
  const [uris, setUris] = useState((client?.redirectUris ?? []).join('\n'));
  const [grants, setGrants] = useState<Set<string>>(new Set(client?.grantTypes ?? ['authorization_code']));
  const [scopes, setScopes] = useState<Set<string>>(new Set(client?.allowedScopes ?? ['read']));
  const [confidential, setConfidential] = useState(false);
  const [enabled, setEnabled] = useState(client?.enabled ?? true);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        redirectUris: uris
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        grantTypes: [...grants],
        allowedScopes: [...scopes],
        enabled,
        ...(client ? {} : { confidential }),
      };
      if (client) return updateOAuthClient(client.id, body);
      return createOAuthClient(body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['oauth-clients'] });
      const s = (r as { clientSecret?: string }).clientSecret;
      if (s) setSecret(s);
      else onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  if (secret) return <SecretBanner label="Client secret" value={secret} onDone={onClose} />;
  return (
    <Modal open onClose={onClose}>
      <div className="p-5 w-[480px]">
        <h2 className="text-base font-semibold text-atl-n-800 mb-4">{client ? 'Edit client' : 'New OAuth client'}</h2>
        {error && <div className={ERR + ' mb-3'}>{error}</div>}
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Name</label>
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={LABEL}>Redirect URIs (one per line)</label>
            <textarea
              className={INPUT + ' h-16 py-1.5 resize-y font-mono text-xs'}
              value={uris}
              onChange={(e) => setUris(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL}>Grant types</label>
            <Checked v={grants} onChange={setGrants} options={GRANT_TYPES} />
          </div>
          <div>
            <label className={LABEL}>Scopes</label>
            <Checked v={scopes} onChange={setScopes} options={SCOPES} />
          </div>
          {!client && (
            <label className="flex items-center gap-2 text-sm text-atl-n-600">
              <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
              Confidential client (mints a client secret — shown once)
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-atl-n-600">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className={SUBTLE} onClick={onClose}>
            Cancel
          </button>
          <button
            className={PRIMARY}
            disabled={save.isPending || !name.trim() || !grants.size || !scopes.size}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- Directory connections ----------------

const LDAP_DEFAULTS = {
  hosts: '',
  port: '',
  tls: 'ldaps',
  bindDn: '',
  baseDn: '',
  userFilter: '(&(objectClass=person)(uid={login}))',
};

function DirectoryDialog({ conn, onClose }: { conn: DirectoryConnection | null; onClose: () => void }) {
  const qc = useQueryClient();
  const cfg = (conn?.config ?? {}) as Record<string, unknown>;
  const [type, setType] = useState<'scim' | 'ldap'>(conn?.type ?? 'ldap');
  const [name, setName] = useState(conn?.name ?? '');
  const [f, setF] = useState({
    ...LDAP_DEFAULTS,
    hosts: ((cfg.hosts as string[]) ?? []).join(', '),
    port: String(cfg.port ?? ''),
    tls: (cfg.tls as string) ?? 'ldaps',
    bindDn: (cfg.bindDn as string) ?? '',
    baseDn: (cfg.baseDn as string) ?? '',
    userFilter: (cfg.userFilter as string) ?? LDAP_DEFAULTS.userFilter,
  });
  const [secretRef, setSecretRef] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      const config =
        type === 'ldap'
          ? {
              hosts: f.hosts
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              ...(f.port ? { port: Number(f.port) } : {}),
              tls: f.tls,
              bindDn: f.bindDn,
              baseDn: f.baseDn,
              userFilter: f.userFilter,
            }
          : {};
      const body = { type, name: name.trim(), config, ...(secretRef ? { secretRef } : {}) };
      if (conn) return updateDirectoryConnection(conn.id, body);
      return createDirectoryConnection(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['directory'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const fld = (k: keyof typeof LDAP_DEFAULTS, label: string, mono = true) => (
    <div>
      <label className={LABEL}>{label}</label>
      <input
        className={INPUT + (mono ? ' font-mono text-xs' : '')}
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
    </div>
  );
  return (
    <Modal open onClose={onClose}>
      <div className="p-5 w-[480px]">
        <h2 className="text-base font-semibold text-atl-n-800 mb-4">
          {conn ? 'Edit connection' : 'New directory connection'}
        </h2>
        {error && <div className={ERR + ' mb-3'}>{error}</div>}
        <div className="space-y-3">
          {!conn && (
            <div>
              <label className={LABEL}>Type</label>
              <select className={INPUT} value={type} onChange={(e) => setType(e.target.value as 'scim' | 'ldap')}>
                <option value="ldap">LDAP (bind auth + user sync)</option>
                <option value="scim">SCIM 2.0 (inbound provisioning)</option>
              </select>
            </div>
          )}
          <div>
            <label className={LABEL}>Name</label>
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {type === 'ldap' && (
            <>
              {fld('hosts', 'Hosts (comma-separated)')}
              <div className="grid grid-cols-2 gap-3">
                {fld('port', 'Port (blank = default)', false)}
                <div>
                  <label className={LABEL}>TLS mode</label>
                  <select className={INPUT} value={f.tls} onChange={(e) => setF({ ...f, tls: e.target.value })}>
                    <option value="ldaps">ldaps</option>
                    <option value="starttls">starttls</option>
                  </select>
                </div>
              </div>
              {fld('bindDn', 'Bind DN')}
              {fld('baseDn', 'Base DN')}
              {fld('userFilter', 'User filter ({login} = placeholder)')}
              <div>
                <label className={LABEL}>Bind password secret ref (e.g. env:LDAP_BIND_PW)</label>
                <input
                  className={INPUT + ' font-mono text-xs'}
                  value={secretRef}
                  onChange={(e) => setSecretRef(e.target.value)}
                  placeholder={conn ? '(unchanged)' : ''}
                />
              </div>
            </>
          )}
          {type === 'scim' && (
            <p className="text-xs text-atl-n-300">
              Creates an inbound SCIM endpoint. Mint bearer tokens from the connection row after saving.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className={SUBTLE} onClick={onClose}>
            Cancel
          </button>
          <button className={PRIMARY} disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MintTokenDialog({
  conn,
  onToken,
  onClose,
}: {
  conn: DirectoryConnection;
  onToken: (t: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(`${conn.name}-sync`);
  const mint = useMutation({
    mutationFn: () => mintScimToken(conn.id, name.trim()),
    onSuccess: (r) => {
      onToken(r.scimToken);
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} label="Mint SCIM token">
      <form
        className="p-5 w-[420px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !mint.isPending) mint.mutate();
        }}
      >
        <h2 className="text-base font-semibold text-atl-n-800 mb-1">Mint SCIM token</h2>
        <p className="text-xs text-atl-n-300 mb-4">The name labels the token in the token list. The token itself is shown once.</p>
        {mint.isError && (
          <div className={ERR + ' mb-3'}>{mint.error instanceof ApiError ? mint.error.message : 'Mint failed'}</div>
        )}
        <label className={LABEL} htmlFor="scim-token-name">
          Token name
        </label>
        <input
          id="scim-token-name"
          name="scim-token-name"
          autoComplete="off"
          autoFocus
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" className={SUBTLE} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={!name.trim() || mint.isPending}>
            {mint.isPending ? 'Minting…' : 'Mint token'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DirectoryRow({
  conn,
  onEdit,
  onMint,
  onDelete,
}: {
  conn: DirectoryConnection;
  onEdit: (c: DirectoryConnection) => void;
  onMint: (c: DirectoryConnection) => void;
  onDelete: (c: DirectoryConnection) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const inv = () => void qc.invalidateQueries({ queryKey: ['directory'] });
  const act = (fn: () => Promise<unknown>, ok: string) => async () => {
    setNote('');
    try {
      const r = (await fn()) as { ok?: boolean; error?: string; detail?: string };
      setNote(r && r.ok === false ? (r.error ?? 'Failed') : ok);
      inv();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Failed');
    }
  };
  return (
    <tr className="border-b border-atl-n-30 last:border-0">
      <td className="px-3 py-2.5">
        <div className="font-medium text-atl-n-700">{conn.name}</div>
        <div className="text-xs text-atl-n-300 font-mono">{conn.id.slice(0, 8)}</div>
      </td>
      <td className="px-3 py-2.5 uppercase text-xs font-semibold text-atl-n-400">{conn.type}</td>
      <td className="px-3 py-2.5 text-sm">
        {conn.enabled ? (
          <span className="text-atl-g-500 font-medium">Enabled</span>
        ) : (
          <span className="text-atl-n-300">Disabled</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-atl-n-400">
        {conn.lastSyncAt ? formatDateTime(conn.lastSyncAt) : '—'}
        {conn.syncStatus && <div className="text-atl-n-300">{conn.syncStatus}</div>}
      </td>
      <td className="px-3 py-2.5 text-right space-x-1 whitespace-nowrap">
        {conn.type === 'scim' && (
          <button className={SUBTLE} onClick={() => onMint(conn)}>
            Mint token
          </button>
        )}
        {conn.type === 'ldap' && (
          <>
            <button className={SUBTLE} onClick={act(() => testLdapConnection(conn.id), 'Bind OK')}>
              Test
            </button>
            <button className={SUBTLE} onClick={act(() => syncLdapConnection(conn.id), 'Sync queued')}>
              Sync
            </button>
          </>
        )}
        <button
          className={SUBTLE}
          onClick={act(
            () => updateDirectoryConnection(conn.id, { enabled: !conn.enabled }),
            conn.enabled ? 'Disabled' : 'Enabled'
          )}
        >
          {conn.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className={SUBTLE} onClick={() => onEdit(conn)}>
          Edit
        </button>
        <button className={SUBTLE + ' text-atl-r-500'} onClick={() => onDelete(conn)}>
          Delete
        </button>
        {note && <span className="block text-xs text-atl-n-300 mt-1">{note}</span>}
      </td>
    </tr>
  );
}

// ---------------- page ----------------

export default function AdminIdentityPage() {
  const clients = useQuery({ queryKey: ['oauth-clients'], queryFn: fetchOAuthClients });
  const dirs = useQuery({ queryKey: ['directory'], queryFn: fetchDirectoryConnections });
  const [clientDlg, setClientDlg] = useState<OAuthClientAdmin | null | 'new'>(null);
  const [dirDlg, setDirDlg] = useState<DirectoryConnection | null | 'new'>(null);
  const [scimToken, setScimToken] = useState<string | null>(null);
  const [mintFor, setMintFor] = useState<DirectoryConnection | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'client' | 'conn'; id: string; name: string } | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (d: { kind: 'client' | 'conn'; id: string }) =>
      d.kind === 'client' ? deleteOAuthClient(d.id) : deleteDirectoryConnection(d.id),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: [d.kind === 'client' ? 'oauth-clients' : 'directory'] });
      setDeleting(null);
    },
  });

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-atl-n-800">Identity</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-6">OAuth2 clients and external directory connections.</p>

      <section className="border border-atl-n-30 rounded bg-atl-paper mb-6">
        <div className="px-4 py-2.5 border-b border-atl-n-30 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-atl-n-300">OAuth2 clients</h2>
          <button className={PRIMARY} onClick={() => setClientDlg('new')}>
            New client
          </button>
        </div>
        {!clients.data?.clients.length ? (
          <EmptyState title="No clients" description="Register OAuth2 clients for the authorization server." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Client ID</th>
                <th className="px-3 py-2 font-medium">Grants</th>
                <th className="px-3 py-2 font-medium">Scopes</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {clients.data!.clients.map((c) => (
                <tr key={c.id} className="border-b border-atl-n-30 last:border-0">
                  <td className="px-3 py-2.5 font-medium text-atl-n-700">
                    {c.name}
                    {c.confidential && (
                      <span className="ml-2 text-[10px] text-atl-n-300 border border-atl-n-40 rounded px-1">
                        confidential
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs font-mono text-atl-n-400">{c.clientId}</td>
                  <td className="px-3 py-2.5 text-xs text-atl-n-500">
                    {c.grantTypes.map((g) => g.replace('urn:ietf:params:oauth:grant-type:', 'device:')).join(', ')}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-atl-n-500">{c.allowedScopes.join(' ')}</td>
                  <td className="px-3 py-2.5">
                    {c.enabled ? (
                      <span className="text-atl-g-500 text-sm font-medium">Enabled</span>
                    ) : (
                      <span className="text-atl-n-300 text-sm">Disabled</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right space-x-1">
                    <button className={SUBTLE} onClick={() => setClientDlg(c)}>
                      Edit
                    </button>
                    <button
                      className={SUBTLE + ' text-atl-r-500'}
                      onClick={() => setDeleting({ kind: 'client', id: c.id, name: c.name })}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="border border-atl-n-30 rounded bg-atl-paper">
        <div className="px-4 py-2.5 border-b border-atl-n-30 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-atl-n-300">Directory connections</h2>
          <button className={PRIMARY} onClick={() => setDirDlg('new')}>
            New connection
          </button>
        </div>
        {!dirs.data?.connections.length ? (
          <EmptyState
            title="No connections"
            description="Connect an LDAP directory or create an inbound SCIM endpoint."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Last sync</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {dirs.data!.connections.map((c) => (
                <DirectoryRow
                  key={c.id}
                  conn={c}
                  onEdit={setDirDlg}
                  onMint={setMintFor}
                  onDelete={(conn) => setDeleting({ kind: 'conn', id: conn.id, name: conn.name })}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {clientDlg === 'new' && <ClientDialog client={null} onClose={() => setClientDlg(null)} />}
      {clientDlg && clientDlg !== 'new' && <ClientDialog client={clientDlg} onClose={() => setClientDlg(null)} />}
      {dirDlg === 'new' && <DirectoryDialog conn={null} onClose={() => setDirDlg(null)} />}
      {dirDlg && dirDlg !== 'new' && <DirectoryDialog conn={dirDlg} onClose={() => setDirDlg(null)} />}
      {mintFor && (
        <MintTokenDialog conn={mintFor} onClose={() => setMintFor(null)} onToken={setScimToken} />
      )}
      {scimToken && <SecretBanner label="SCIM bearer token" value={scimToken} onDone={() => setScimToken(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ''}"?`}
        body={
          deleting?.kind === 'client'
            ? 'Applications using this client can no longer obtain tokens. Existing access tokens are revoked.'
            : 'Inbound provisioning and sync from this directory stop immediately. Users already provisioned keep their accounts.'
        }
        confirmLabel={deleting?.kind === 'client' ? 'Delete client' : 'Delete connection'}
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => {
          if (deleting) del.mutate(deleting);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
