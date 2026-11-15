// 068 — shared copilot step/result rows (extracted from CommandPalette so the
// palette and the CopilotDock render the same human display contract, FR-003:
// server-computed `display` first, raw payloads behind a Details disclosure).
import { Link } from 'react-router-dom';
import { Markdown } from './Markdown.js';
import type { CopilotResult, CopilotStep } from '../api/client.js';

export function FieldRow({ f }: { f: { label: string; from?: string | null; to?: string | null } }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-20 shrink-0 text-atl-n-300">{f.label}</span>
      <span className="min-w-0 text-atl-n-700">
        {f.from !== undefined && f.from !== null && <s className="text-atl-n-300">{f.from}</s>}
        {f.from !== undefined && f.from !== null && f.to !== undefined && f.to !== null && ' → '}
        {f.to !== undefined && f.to !== null ? (
          <span>{f.to}</span>
        ) : f.from === undefined || f.from === null ? (
          <span className="text-atl-n-300">—</span>
        ) : null}
      </span>
    </div>
  );
}

export function IssueRows({
  issues,
}: {
  issues: { key: string; summary?: string; status?: string; meta?: string; noLink?: boolean }[];
}) {
  return (
    <div className="mt-1 space-y-0.5">
      {issues.map((i, idx) => (
        <div key={i.key || idx} className="flex items-baseline gap-2 text-xs">
          {i.key && !i.noLink ? (
            <Link to={`/browse/${i.key}`} className="shrink-0 font-medium text-atl-b-300 hover:underline">
              {i.key}
            </Link>
          ) : i.key ? (
            <span className="shrink-0 font-medium text-atl-n-700">{i.key}</span>
          ) : (
            <span className="shrink-0 text-atl-n-300">—</span>
          )}
          {i.summary && <span className="min-w-0 truncate text-atl-n-600" title={i.summary}>{i.summary}</span>}
          {(i.status || i.meta) && (
            <span className="ml-auto shrink-0 text-[10px] text-atl-n-300">{i.status ?? i.meta}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function StepRow({ step, checked, onToggle }: { step: CopilotStep; checked?: boolean; onToggle?: () => void }) {
  const d = step.display;
  const raw = step.preview ?? step.result;
  return (
    <div
      className={`rounded border px-3 py-2 ${step.destructive ? 'border-atl-r-300 bg-atl-r-50' : 'border-atl-n-30'}`}
    >
      <div className="flex items-start gap-2">
        {step.kind === 'write' && (
          <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {step.destructive && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-atl-r-400 text-white">
                delete
              </span>
            )}
            <span className="text-sm text-atl-n-800">{d?.text ?? step.title ?? step.tool}</span>
          </div>
          {!!d?.fields?.length && (
            <div className="mt-1 space-y-0.5">
              {d.fields.map((f, i) => (
                <FieldRow key={i} f={f} />
              ))}
            </div>
          )}
          {!!d?.issues?.length && <IssueRows issues={d.issues} />}
          {d?.markdown && <Markdown text={d.markdown} className="mt-1" />}
          {step.error && <div className="mt-1.5 text-xs text-atl-r-500">{step.error}</div>}
          {raw !== undefined && raw !== null && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-atl-n-300 hover:text-atl-n-500">
                Details · {step.tool}
              </summary>
              <pre className="mt-1 text-[11px] bg-atl-n-10 rounded p-2 overflow-auto max-h-32 text-atl-n-600">
                {JSON.stringify(raw, null, 2).slice(0, 1500)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export function ResultRow({ r }: { r: CopilotResult }) {
  const created = r.display?.issues?.[0]?.key;
  return (
    <div
      className={`rounded border px-3 py-2 ${
        r.skipped
          ? 'border-atl-n-30 bg-atl-n-10'
          : r.ok
            ? 'border-atl-g-300 bg-atl-g-50'
            : 'border-atl-r-300 bg-atl-r-50'
      }`}
    >
      <span className="text-sm text-atl-n-800">{r.display?.text ?? r.tool}</span>
      {created && (
        <Link to={`/browse/${created}`} className="ml-2 text-xs font-medium text-atl-b-300 hover:underline">
          {created}
        </Link>
      )}
      <span
        className={`ml-2 text-xs font-medium ${
          r.skipped ? 'text-atl-n-300' : r.ok ? 'text-atl-g-500' : 'text-atl-r-500'
        }`}
      >
        {r.skipped ? 'skipped' : r.ok ? 'done' : (r.error ?? `failed (${r.status})`)}
      </span>
    </div>
  );
}

export const PLAN_STEP_LABEL: Record<string, string> = {
  context: 'Gathering context…',
  llm: 'Asking the model…',
  resolve: 'Checking the steps…',
  finalize: 'Filling in the details…',
};
