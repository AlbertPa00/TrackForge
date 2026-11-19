import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWorkReceipt } from '../api/client.js';
import { useModalDialog } from '../lib/useModalDialog.js';
import { formatDateTime } from '../lib/format.js';

const TIER_META: Record<string, { label: string; cls: string; explain: string }> = {
  digest_only: {
    label: 'digest only',
    cls: 'bg-atl-y-50 text-atl-y-500 border-atl-y-75',
    explain: 'Client declared a SHA-256 digest without uploading bytes. TrackForge has not verified the artifact content.',
  },
  unverified: {
    label: 'digest only',
    cls: 'bg-atl-y-50 text-atl-y-500 border-atl-y-75',
    explain: 'Client declared a SHA-256 digest without uploading bytes.',
  },
  hash_verified: {
    label: 'hash verified',
    cls: 'bg-atl-b-50 text-atl-b-500 border-atl-b-75',
    explain: 'TrackForge computed SHA-256 over the stored artifact bytes and verified an exact match.',
  },
  scm_corroborated: {
    label: 'SCM corroborated',
    cls: 'bg-atl-g-50 text-atl-g-500 border-atl-g-75',
    explain: 'Corroborated against an ingested Git commit or passing CI build webhook.',
  },
  human_attested: {
    label: 'human attested',
    cls: 'bg-atl-g-50 text-atl-g-500 border-atl-g-75',
    explain: 'Hash-verified artifact reviewed and pinned by a human maintainer via Deliverable Sign-Off.',
  },
  signed_ci: {
    label: 'signed CI',
    cls: 'bg-atl-g-50 text-atl-g-500 border-atl-g-75',
    explain: 'Produced and signed by a dedicated CI attestation token.',
  },
};

function DiffOrLogViewer({ content, isDiff }: { content: string; isDiff: boolean }) {
  const lines = content.split(/\r?\n/);
  if (!isDiff) {
    return (
      <pre className="max-h-[60vh] overflow-auto rounded border border-atl-n-30 bg-atl-n-10 p-3 font-mono text-xs leading-relaxed text-atl-n-800">
        {content}
      </pre>
    );
  }
  return (
    <div className="max-h-[60vh] overflow-auto rounded border border-atl-n-30 bg-atl-n-10 font-mono text-xs leading-5">
      {lines.map((line, i) => {
        let rowCls = 'text-atl-n-700';
        if (line.startsWith('+++') || line.startsWith('---')) {
          rowCls = 'bg-atl-n-20 font-semibold text-atl-n-800';
        } else if (line.startsWith('@@')) {
          rowCls = 'bg-atl-b-50 text-atl-b-500';
        } else if (line.startsWith('+')) {
          rowCls = 'bg-atl-g-50 text-atl-g-500';
        } else if (line.startsWith('-')) {
          rowCls = 'bg-atl-r-50 text-atl-r-500';
        }
        return (
          <div key={i} className={`flex px-3 ${rowCls}`}>
            <span className="mr-3 w-8 shrink-0 select-none text-right text-[10px] text-atl-n-200">{i + 1}</span>
            <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function ReceiptInspectorDrawer({
  receiptId,
  onClose,
}: {
  receiptId: string | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);

  useModalDialog({ ref: dialogRef, open: Boolean(receiptId), onClose });

  const { data: receipt, isLoading, isError } = useQuery({
    queryKey: ['work-receipt', receiptId],
    queryFn: () => fetchWorkReceipt(receiptId!),
    enabled: Boolean(receiptId),
  });

  if (!receiptId) return null;

  const tier = TIER_META[receipt?.verification ?? 'digest_only'] ?? TIER_META.digest_only;
  const isDiff =
    receipt?.kind === 'diff' ||
    receipt?.contentType === 'text/x-diff' ||
    Boolean(receipt?.content && (receipt.content.startsWith('--- ') || receipt.content.startsWith('diff --git')));

  const metricsEntries = receipt?.metrics ? Object.entries(receipt.metrics) : [];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="tf-drawer m-0 ml-auto h-full max-h-full w-full border-0 border-l border-atl-n-30 bg-atl-paper p-0 shadow-2xl outline-none open:flex open:flex-col sm:w-[min(780px,94vw)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-atl-n-30 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-atl-n-20 px-2 py-0.5 font-mono text-xs font-semibold uppercase text-atl-n-700">
            {receipt?.kind ?? 'receipt'}
          </span>
          <h2 id={titleId} className="truncate text-sm font-semibold text-atl-n-800" title={receipt?.summary ?? 'Work Receipt'}>
            {receipt?.summary ?? 'Loading work receipt…'}
          </h2>
        </div>
        <button
          type="button"
          autoFocus
          data-autofocus
          onClick={onClose}
          aria-label="Close receipt inspector"
          title="Close receipt inspector (Esc)"
          className="rounded px-2 py-1 text-xs font-medium text-atl-n-500 hover:bg-atl-n-20 hover:text-atl-n-800"
        >
          Close
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {isLoading && <p className="text-sm text-atl-n-300">Loading receipt artifact…</p>}
        {isError && <p className="text-sm text-atl-r-500">Could not load work receipt.</p>}
        {receipt && (
          <>
            <div className={`rounded border p-3 text-xs ${tier.cls}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold uppercase tracking-wide">{tier.label}</span>
                <span className="text-[11px] opacity-80">
                  {receipt.author?.displayName ?? 'Agent'} · {formatDateTime(receipt.createdAt)}
                </span>
              </div>
              <p className="mt-1">{tier.explain}</p>
            </div>

            <dl className="grid grid-cols-1 gap-2 rounded border border-atl-n-30 bg-atl-n-10 p-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-atl-n-400">SHA-256 Digest</dt>
                <dd className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-atl-n-800">
                  <span className="truncate" title={receipt.sha256}>{receipt.sha256}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(receipt.sha256);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="shrink-0 rounded border border-atl-n-40 bg-atl-paper px-1.5 py-0.5 text-[10px] hover:bg-atl-n-20"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </dd>
              </div>
              {(receipt.gitBranch || receipt.gitCommitSha) && (
                <div>
                  <dt className="font-semibold text-atl-n-400">Git Reference</dt>
                  <dd className="mt-0.5 font-mono text-[11px] text-atl-n-800">
                    {receipt.gitBranch ?? 'detached'}
                    {receipt.gitCommitSha ? ` @ ${receipt.gitCommitSha.slice(0, 12)}` : ''}
                  </dd>
                </div>
              )}
              {receipt.issueKey && (
                <div>
                  <dt className="font-semibold text-atl-n-400">Bound Issue</dt>
                  <dd className="mt-0.5 font-medium text-atl-n-800">{receipt.issueKey}</dd>
                </div>
              )}
              {receipt.artifactUri && (
                <div>
                  <dt className="font-semibold text-atl-n-400">External Artifact URI</dt>
                  <dd className="mt-0.5 truncate font-mono text-[11px] text-atl-n-700" title={receipt.artifactUri}>
                    {receipt.artifactUri}
                  </dd>
                </div>
              )}
            </dl>

            {metricsEntries.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase text-atl-n-400">Recorded Metrics</h3>
                <div className="flex flex-wrap gap-1.5">
                  {metricsEntries.map(([k, v]) => (
                    <span key={k} className="rounded bg-atl-n-20 px-2 py-0.5 font-mono text-xs text-atl-n-700">
                      {k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {receipt.changedFiles.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase text-atl-n-400">
                  Changed Files ({receipt.changedFiles.length})
                </h3>
                <ul className="flex flex-wrap gap-1.5">
                  {receipt.changedFiles.map((f) => (
                    <li key={f} className="rounded border border-atl-n-30 bg-atl-n-10 px-2 py-0.5 font-mono text-xs text-atl-n-800">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {receipt.attachment && (
              <div className="flex items-center justify-between rounded border border-atl-n-30 bg-atl-n-10 px-3 py-2 text-xs">
                <div>
                  <span className="font-semibold text-atl-n-800">{receipt.attachment.filename}</span>
                  <span className="ml-2 text-atl-n-400">
                    ({Math.max(1, Math.round(receipt.attachment.size / 1024))} KiB · {receipt.attachment.mimeType})
                  </span>
                </div>
                <a
                  href={receipt.attachment.contentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-atl-b-400 px-2.5 py-1 font-medium text-white hover:bg-atl-b-500"
                >
                  Download Artifact
                </a>
              </div>
            )}

            <div>
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase text-atl-n-400">
                  {isDiff ? 'Unified Diff' : 'Artifact Transcript / Output'}
                </h3>
                {receipt.contentByteLength !== null && (
                  <span className="text-[11px] text-atl-n-300">{receipt.contentByteLength.toLocaleString()} bytes</span>
                )}
              </div>
              {receipt.content !== null ? (
                <DiffOrLogViewer content={receipt.content} isDiff={isDiff} />
              ) : (
                <div className="rounded border border-dashed border-atl-n-40 p-4 text-xs text-atl-n-400">
                  No inline text was uploaded with this receipt.{' '}
                  {receipt.attachment
                    ? 'Use Download Artifact above to inspect the full file.'
                    : 'Agents should pass content (<= 64 KiB) or attachmentId when submitting receipts so humans can inspect the proof directly.'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
