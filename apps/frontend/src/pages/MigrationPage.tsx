// Migration wizard — staged import: source → dry-run report →
// import progress → validation report. Mirrors Jira's own importer UI flow.
// 061 US6 — all backend sources get a tab: cloud, server, CSV, XML, export.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listImports,
  getImport,
  startJiraImport,
  startJiraServerImport,
  startCsvImport,
  previewCsv,
  startXmlImport,
  exportProjectFixture,
  fetchProjects,
  resumeImport,
  type ImportJobView,
} from '../api/client.js';

const STAGES = ['discovering', 'mapping', 'planned', 'importing', 'verifying', 'done'];

const inputCls = 'mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px]';
const labelCls = 'text-[12px] font-medium text-atl-n-200';

function stageBadge(stage: string) {
  const colors: Record<string, string> = {
    done: 'bg-atl-g-50 text-atl-g-500',
    failed: 'bg-atl-r-50 text-atl-r-500',
    importing: 'bg-atl-b-75 text-atl-b-500',
    planned: 'bg-atl-p-50 text-atl-p-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase ${colors[stage] ?? 'bg-atl-n-40 text-atl-n-500'}`}>
      {stage}
    </span>
  );
}

function SourceForm({ onStarted }: { onStarted: (job: ImportJobView) => void }) {
  const [f, setF] = useState({ baseUrl: '', email: '', apiToken: '', secretRef: '', projectKeys: '', deltaFrom: '' });
  const [error, setError] = useState('');
  const start = useMutation({
    mutationFn: (dryRun: boolean) =>
      startJiraImport({
        baseUrl: f.baseUrl || undefined,
        email: f.email || undefined,
        apiToken: f.apiToken || undefined,
        secretRef: f.secretRef || undefined,
        projectKeys: f.projectKeys.split(/[,\s]+/).filter(Boolean),
        deltaFrom: f.deltaFrom || undefined,
        dryRun,
      }),
    onSuccess: onStarted,
    onError: (e) => setError((e as Error).message),
  });
  const valid = f.baseUrl && f.email && (f.apiToken || f.secretRef) && f.projectKeys.trim();

  return (
    <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-5 w-[480px]">
      <h2 className="text-[16px] font-medium text-atl-n-800 mb-4">Import from Jira Cloud</h2>
      <div className="space-y-3">
        <label className="block">
          <span className={labelCls}>Site URL</span>
          <input className={inputCls} placeholder="https://org.atlassian.net" value={f.baseUrl}
            onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Email</span>
          <input className={inputCls} placeholder="you@company.com" value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>API token <span className="font-normal">(or env secret ref)</span></span>
          <input className={inputCls} type="password" placeholder="ATATT3x…" value={f.apiToken}
            onChange={(e) => setF({ ...f, apiToken: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Secret ref</span>
          <input className={inputCls} placeholder="JIRA_API_TOKEN" value={f.secretRef}
            onChange={(e) => setF({ ...f, secretRef: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Project keys</span>
          <input className={inputCls} placeholder="TF, DEMO" value={f.projectKeys}
            onChange={(e) => setF({ ...f, projectKeys: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Delta from (optional ISO date)</span>
          <input className={inputCls} placeholder="2026-01-01T00:00:00Z" value={f.deltaFrom}
            onChange={(e) => setF({ ...f, deltaFrom: e.target.value })} />
        </label>
      </div>
      {error && <div className="mt-3 text-[13px] text-atl-r-500">{error}</div>}
      <div className="mt-4 flex gap-2">
        <button
          disabled={!valid || start.isPending}
          onClick={() => start.mutate(true)}
          className="px-3 py-1.5 text-[14px] font-medium text-atl-n-800 bg-atl-n-20 hover:bg-atl-n-30 rounded-[3px] disabled:opacity-50"
        >
          Run dry-run
        </button>
        <button
          disabled={!valid || start.isPending}
          onClick={() => start.mutate(false)}
          className="px-3 py-1.5 text-[14px] font-medium text-white bg-atl-b-400 hover:bg-atl-b-300 rounded-[3px] disabled:opacity-50"
        >
          Start import
        </button>
      </div>
      <p className="mt-3 text-[12px] text-atl-n-200">
        Dry-run plans the whole import and writes nothing — review the report before committing.
      </p>
    </div>
  );
}

/** 061 US6 — Jira Server/DC over live REST (048 backend). */
function ServerForm({ onStarted }: { onStarted: (job: ImportJobView) => void }) {
  const [f, setF] = useState({
    baseUrl: '', authMode: 'pat' as 'basic' | 'pat', username: '', apiToken: '', secretRef: '',
    projectKeys: '', deltaFrom: '', insecureSkipVerify: false, allowPrivate: false,
  });
  const [error, setError] = useState('');
  const start = useMutation({
    mutationFn: (dryRun: boolean) =>
      startJiraServerImport({
        baseUrl: f.baseUrl,
        authMode: f.authMode,
        username: f.authMode === 'basic' ? f.username : undefined,
        apiToken: f.apiToken || undefined,
        secretRef: f.secretRef || undefined,
        projectKeys: f.projectKeys.split(/[,\s]+/).filter(Boolean),
        deltaFrom: f.deltaFrom || undefined,
        insecureSkipVerify: f.insecureSkipVerify || undefined,
        allowPrivate: f.allowPrivate || undefined,
        dryRun,
      }),
    onSuccess: onStarted,
    onError: (e) => setError((e as Error).message),
  });
  const valid = f.baseUrl && f.projectKeys.trim() &&
    ((f.authMode === 'basic' && f.username) || f.apiToken || f.secretRef);

  return (
    <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-5 w-[480px]">
      <h2 className="text-[16px] font-medium text-atl-n-800 mb-4">Import from Jira Server / Data Center</h2>
      <div className="space-y-3">
        <label className="block">
          <span className={labelCls}>Server URL</span>
          <input className={inputCls} placeholder="https://jira.company.local" value={f.baseUrl}
            onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Authentication</span>
          <select className={inputCls} value={f.authMode}
            onChange={(e) => setF({ ...f, authMode: e.target.value as 'basic' | 'pat' })}>
            <option value="pat">Personal access token (Bearer)</option>
            <option value="basic">Basic (username + password/token)</option>
          </select>
        </label>
        {f.authMode === 'basic' && (
          <label className="block">
            <span className={labelCls}>Username</span>
            <input className={inputCls} value={f.username}
              onChange={(e) => setF({ ...f, username: e.target.value })} />
          </label>
        )}
        <label className="block">
          <span className={labelCls}>{f.authMode === 'basic' ? 'Password / token' : 'API token'} <span className="font-normal">(or env secret ref)</span></span>
          <input className={inputCls} type="password" value={f.apiToken}
            onChange={(e) => setF({ ...f, apiToken: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Secret ref</span>
          <input className={inputCls} placeholder="JIRA_SERVER_TOKEN" value={f.secretRef}
            onChange={(e) => setF({ ...f, secretRef: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Project keys</span>
          <input className={inputCls} placeholder="TF, DEMO" value={f.projectKeys}
            onChange={(e) => setF({ ...f, projectKeys: e.target.value })} />
        </label>
        <label className="block">
          <span className={labelCls}>Delta from (optional ISO date)</span>
          <input className={inputCls} placeholder="2026-01-01T00:00:00Z" value={f.deltaFrom}
            onChange={(e) => setF({ ...f, deltaFrom: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-atl-n-500">
          <input type="checkbox" checked={f.insecureSkipVerify}
            onChange={(e) => setF({ ...f, insecureSkipVerify: e.target.checked })} />
          Skip TLS verification (self-signed certificates)
        </label>
        <label className="flex items-center gap-2 text-[13px] text-atl-n-500">
          <input type="checkbox" checked={f.allowPrivate}
            onChange={(e) => setF({ ...f, allowPrivate: e.target.checked })} />
          Allow private/LAN addresses (SSRF guard opt-out)
        </label>
      </div>
      {error && <div className="mt-3 text-[13px] text-atl-r-500">{error}</div>}
      <div className="mt-4 flex gap-2">
        <button disabled={!valid || start.isPending} onClick={() => start.mutate(true)}
          className="px-3 py-1.5 text-[14px] font-medium text-atl-n-800 bg-atl-n-20 hover:bg-atl-n-30 rounded-[3px] disabled:opacity-50">
          Run dry-run
        </button>
        <button disabled={!valid || start.isPending} onClick={() => start.mutate(false)}
          className="px-3 py-1.5 text-[14px] font-medium text-white bg-atl-b-400 hover:bg-atl-b-300 rounded-[3px] disabled:opacity-50">
          Start import
        </button>
      </div>
    </div>
  );
}

/** 061 US6 — CSV upload with the 039 header→field preview. */
function CsvForm({ onStarted }: { onStarted: (job: ImportJobView) => void }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [error, setError] = useState('');
  const preview = useMutation({ mutationFn: () => previewCsv({ csv, maxRows: 10 }), onError: (e) => setError((e as Error).message) });
  const start = useMutation({
    mutationFn: (dryRun: boolean) =>
      startCsvImport({ csv, projectKey: projectKey || undefined, dryRun }),
    onSuccess: onStarted,
    onError: (e) => setError((e as Error).message),
  });
  const load = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
  };

  return (
    <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-5 w-[480px]">
      <h2 className="text-[16px] font-medium text-atl-n-800 mb-4">Import from CSV</h2>
      <div className="space-y-3">
        <label className="block">
          <span className={labelCls}>CSV file</span>
          <input className={inputCls} type="file" accept=".csv,text/csv"
            onChange={(e) => void load(e.target.files?.[0])} />
        </label>
        {fileName && <div className="text-[12px] text-atl-n-200">{fileName} — {csv.split('\n').length - 1} row(s)</div>}
        <label className="block">
          <span className={labelCls}>Project key <span className="font-normal">(optional — defaults to the key prefix in each row)</span></span>
          <input className={inputCls} placeholder="TF" value={projectKey}
            onChange={(e) => setProjectKey(e.target.value.toUpperCase())} />
        </label>
      </div>
      {preview.data && (
        <div className="mt-3 border border-atl-n-30 rounded-[3px] p-3 text-[12px] max-h-44 overflow-auto">
          <div className="font-medium text-atl-n-500 mb-1">Column mapping ({preview.data.rows.length} sample rows)</div>
          {Object.entries(preview.data.mapping).map(([col, field]) => (
            <div key={col} className="flex justify-between gap-2">
              <span className="text-atl-n-800">{col}</span>
              <span className="text-atl-n-200">{field}</span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="mt-3 text-[13px] text-atl-r-500">{error}</div>}
      <div className="mt-4 flex gap-2">
        <button disabled={csv.length < 10 || preview.isPending} onClick={() => { setError(''); preview.mutate(); }}
          className="px-3 py-1.5 text-[14px] font-medium text-atl-n-800 bg-atl-n-20 hover:bg-atl-n-30 rounded-[3px] disabled:opacity-50">
          Preview mapping
        </button>
        <button disabled={csv.length < 10 || start.isPending} onClick={() => start.mutate(true)}
          className="px-3 py-1.5 text-[14px] font-medium text-atl-n-800 bg-atl-n-20 hover:bg-atl-n-30 rounded-[3px] disabled:opacity-50">
          Run dry-run
        </button>
        <button disabled={csv.length < 10 || start.isPending} onClick={() => start.mutate(false)}
          className="px-3 py-1.5 text-[14px] font-medium text-white bg-atl-b-400 hover:bg-atl-b-300 rounded-[3px] disabled:opacity-50">
          Start import
        </button>
      </div>
    </div>
  );
}

/** 061 US6 — Jira Server/DC XML backup zip → fixture → pipeline (039 backend). */
function XmlForm({ onStarted }: { onStarted: (job: ImportJobView) => void }) {
  const [zipBase64, setZipBase64] = useState('');
  const [fileName, setFileName] = useState('');
  const [projectKeys, setProjectKeys] = useState('');
  const [error, setError] = useState('');
  const start = useMutation({
    mutationFn: (dryRun: boolean) =>
      startXmlImport({
        zipBase64,
        projectKeys: projectKeys.split(/[,\s]+/).filter(Boolean),
        dryRun,
      }),
    onSuccess: onStarted,
    onError: (e) => setError((e as Error).message),
  });
  const load = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setZipBase64(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  };

  return (
    <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-5 w-[480px]">
      <h2 className="text-[16px] font-medium text-atl-n-800 mb-4">Import from Jira XML backup</h2>
      <p className="text-[12px] text-atl-n-200 mb-3">
        The <code>entities.xml</code> export zip from a Jira Server/DC backup — no server access needed.
      </p>
      <div className="space-y-3">
        <label className="block">
          <span className={labelCls}>Backup zip</span>
          <input className={inputCls} type="file" accept=".zip,application/zip"
            onChange={(e) => load(e.target.files?.[0])} />
        </label>
        {fileName && <div className="text-[12px] text-atl-n-200">{fileName}</div>}
        <label className="block">
          <span className={labelCls}>Project keys <span className="font-normal">(optional — imports everything found)</span></span>
          <input className={inputCls} placeholder="TF, DEMO" value={projectKeys}
            onChange={(e) => setProjectKeys(e.target.value)} />
        </label>
      </div>
      {error && <div className="mt-3 text-[13px] text-atl-r-500">{error}</div>}
      <div className="mt-4 flex gap-2">
        <button disabled={zipBase64.length < 100 || start.isPending} onClick={() => start.mutate(true)}
          className="px-3 py-1.5 text-[14px] font-medium text-atl-n-800 bg-atl-n-20 hover:bg-atl-n-30 rounded-[3px] disabled:opacity-50">
          Run dry-run
        </button>
        <button disabled={zipBase64.length < 100 || start.isPending} onClick={() => start.mutate(false)}
          className="px-3 py-1.5 text-[14px] font-medium text-white bg-atl-b-400 hover:bg-atl-b-300 rounded-[3px] disabled:opacity-50">
          Start import
        </button>
      </div>
    </div>
  );
}

/** 061 US6 — round-trip export: project → Jira-Cloud-shaped fixture JSON (039). */
function ExportForm() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const exp = useMutation({
    mutationFn: async () => {
      const r = await exportProjectFixture(key);
      const blob = new Blob([JSON.stringify(r.fixture, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${key}-export.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-5 w-[480px]">
      <h2 className="text-[16px] font-medium text-atl-n-800 mb-4">Export a project</h2>
      <p className="text-[12px] text-atl-n-200 mb-3">
        Downloads a Jira-Cloud-shaped fixture JSON — it feeds straight back into the Jira Cloud tab as a file import.
      </p>
      <label className="block">
        <span className={labelCls}>Project</span>
        <select className={inputCls} value={key} onChange={(e) => setKey(e.target.value)}>
          <option value="">Choose…</option>
          {(projects.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
        </select>
      </label>
      {error && <div className="mt-3 text-[13px] text-atl-r-500">{error}</div>}
      <div className="mt-4">
        <button disabled={!key || exp.isPending} onClick={() => exp.mutate()}
          className="px-3 py-1.5 text-[14px] font-medium text-white bg-atl-b-400 hover:bg-atl-b-300 rounded-[3px] disabled:opacity-50">
          {exp.isPending ? 'Exporting…' : 'Download export'}
        </button>
      </div>
    </div>
  );
}

function JobDetail({ job }: { job: ImportJobView }) {
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => resumeImport(job.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imports'] }),
  });
  const plan = job.report?.plan ?? {};
  const progress = job.stageData?.progress ?? {};
  const stageIdx = STAGES.indexOf(job.stage);
  const entities = [...new Set([...Object.keys(plan), ...Object.keys(progress)])];

  return (
    <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-5 flex-1 min-w-[420px]">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[16px] font-medium text-atl-n-800">
          {job.projectKeys.join(', ')} {job.dryRun && <span className="text-atl-n-200 font-normal">(dry-run)</span>}
        </h2>
        <div className="flex items-center gap-2">
          {job.stage === 'failed' && (
            <button onClick={() => resume.mutate()}
              className="px-2.5 py-1 text-[12px] font-medium text-white bg-atl-b-400 rounded-[3px]">
              Resume
            </button>
          )}
          {stageBadge(job.stage)}
        </div>
      </div>
      <div className="text-[12px] text-atl-n-200 mb-4">{job.baseUrl} · {job.source}</div>

      {/* stage progress bar */}
      <div className="flex gap-1 mb-4">
        {STAGES.map((s, i) => (
          <div key={s} title={s}
            className={`h-1.5 flex-1 rounded ${i <= stageIdx ? 'bg-atl-b-400' : 'bg-atl-n-30'} ${job.stage === 'failed' && i === stageIdx ? '!bg-atl-r-500' : ''}`} />
        ))}
      </div>
      {job.error && <div className="mb-3 text-[13px] text-atl-r-500">{job.error}</div>}

      {/* per-entity plan + progress */}
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-atl-n-200 border-b border-atl-n-40">
            <th className="py-1 font-medium">Entity</th>
            <th className="py-1 font-medium text-right">Creates</th>
            <th className="py-1 font-medium text-right">Updates</th>
            <th className="py-1 font-medium text-right">Skips</th>
            <th className="py-1 font-medium text-right">Progress</th>
            <th className="py-1 font-medium text-right">Errors</th>
          </tr>
        </thead>
        <tbody>
          {entities.map((e) => {
            const p = plan[e] ?? { creates: 0, updates: 0, skips: 0, errors: 0 };
            const pr = progress[e];
            return (
              <tr key={e} className="border-b border-atl-n-20">
                <td className="py-1.5 text-atl-n-800">{e}</td>
                <td className="py-1.5 text-right text-atl-g-500">{p.creates || ''}</td>
                <td className="py-1.5 text-right text-atl-b-500">{p.updates || ''}</td>
                <td className="py-1.5 text-right text-atl-n-200">{p.skips || ''}</td>
                <td className="py-1.5 text-right text-atl-n-500">{pr ? `${pr.done}/${pr.total}` : ''}</td>
                <td className="py-1.5 text-right text-atl-r-500">{p.errors || ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!!job.report?.unsupported?.length && (
        <div className="mt-3 text-[12px] text-atl-n-200">
          Not yet supported: {job.report.unsupported.join(', ')}
        </div>
      )}

      {/* verify diffs */}
      {!!job.report?.verify?.length && (
        <div className="mt-4">
          <h3 className="text-[13px] font-medium text-atl-n-800 mb-1">Validation</h3>
          {job.report.verify.map((v) => (
            <div key={v.entity} className="text-[12px] flex justify-between py-0.5">
              <span className="text-atl-n-500">{v.entity}</span>
              <span className={v.diffs.length ? 'text-atl-r-500' : 'text-atl-g-500'}>
                {v.diffs.length ? v.diffs.join('; ') : `${v.imported}/${v.expected} ✓`}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* warnings + apply errors */}
      {!!job.report?.applyErrors?.length && (
        <div className="mt-4">
          <h3 className="text-[13px] font-medium text-atl-r-500 mb-1">Apply errors</h3>
          {job.report.applyErrors.slice(0, 10).map((w, i) => (
            <div key={i} className="text-[12px] text-atl-r-500">{w.entity}:{w.externalId} — {w.message}</div>
          ))}
        </div>
      )}
      {!!job.report?.warnings?.length && (
        <div className="mt-4">
          <h3 className="text-[13px] font-medium text-atl-n-800 mb-1">Warnings ({job.report.warnings.length})</h3>
          {job.report.warnings.slice(0, 10).map((w, i) => (
            <div key={i} className="text-[12px] text-atl-n-200">{w.entityType}:{w.externalId} — {w.message}</div>
          ))}
          {job.report.warnings.length > 10 && (
            <div className="text-[12px] text-atl-n-200">…and {job.report.warnings.length - 10} more</div>
          )}
        </div>
      )}
    </div>
  );
}

type Source = 'jira-cloud' | 'jira-server' | 'csv' | 'xml' | 'export';

const SOURCES: { id: Source; label: string }[] = [
  { id: 'jira-cloud', label: 'Jira Cloud' },
  { id: 'jira-server', label: 'Jira Server / DC' },
  { id: 'csv', label: 'CSV file' },
  { id: 'xml', label: 'XML backup' },
  { id: 'export', label: 'Export project' },
];

export default function MigrationPage() {
  const [source, setSource] = useState<Source>('jira-cloud');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: jobs } = useQuery({ queryKey: ['imports'], queryFn: listImports });
  const { data: selected } = useQuery({
    queryKey: ['imports', selectedId],
    queryFn: () => getImport(selectedId!),
    enabled: !!selectedId,
    refetchInterval: (q) => {
      const s = q.state.data?.stage;
      return s && s !== 'done' && s !== 'failed' ? 2000 : false;
    },
  });

  return (
    <div className="p-6 max-w-[1200px]">
      <h1 className="text-xl font-semibold text-atl-n-800 mb-6">Migration</h1>
      <div className="flex gap-6 items-start flex-wrap">
        <div className="space-y-4">
          <div className="flex gap-1 bg-atl-n-20 rounded-[3px] p-1 w-[480px]" role="tablist">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={source === s.id}
                onClick={() => setSource(s.id)}
                className={`flex-1 px-2 py-1.5 text-[13px] font-medium rounded-[3px] ${source === s.id ? 'bg-atl-paper text-atl-n-800 shadow-sm' : 'text-atl-n-300 hover:text-atl-n-500'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {source === 'jira-cloud' && <SourceForm onStarted={(j) => setSelectedId(j.id)} />}
          {source === 'jira-server' && <ServerForm onStarted={(j) => setSelectedId(j.id)} />}
          {source === 'csv' && <CsvForm onStarted={(j) => setSelectedId(j.id)} />}
          {source === 'xml' && <XmlForm onStarted={(j) => setSelectedId(j.id)} />}
          {source === 'export' && <ExportForm />}
          {!!jobs?.length && (
            <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] p-4 w-[480px]">
              <h3 className="text-[13px] font-medium text-atl-n-200 mb-2">Recent imports</h3>
              {jobs.map((j) => (
                <button key={j.id} onClick={() => setSelectedId(j.id)}
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left hover:bg-atl-n-20 ${selectedId === j.id ? 'bg-atl-b-75' : ''}`}>
                  <span className="text-[13px] text-atl-n-800">
                    {j.projectKeys.join(', ')} {j.dryRun && <span className="text-atl-n-200">(dry-run)</span>}
                  </span>
                  {stageBadge(j.stage)}
                </button>
              ))}
            </div>
          )}
        </div>
        {selected && <JobDetail job={selected} />}
      </div>
    </div>
  );
}
