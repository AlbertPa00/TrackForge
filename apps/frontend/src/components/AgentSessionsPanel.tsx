// Sprint 047 US2/US3 — agent sessions panel on the issue page: inspectable
// agent work (activities timeline, status) + the question inbox with inline
// answering. Hidden when the issue has no sessions and no open questions.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  answerAgentQuestion,
  fetchIssueLedger,
  fetchIssueSessions,
  fetchOpenQuestions,
  fetchTownHallTopics,
  type AgentQuestion,
  type AgentSessionView,
  type IssueLedgerEntry,
} from '../api/client.js';
import StatusLozenge from './StatusLozenge.js';
import ReceiptInspectorDrawer from './ReceiptInspectorDrawer.js';
import { formatDateTime } from '../lib/format.js';
import { imeComposing } from '../lib/ime.js';

const SESSION_CATEGORY: Record<string, string> = {
  running: 'indeterminate',
  'needs-answer': 'new',
  blocked: 'new',
  done: 'done',
  failed: 'new',
};

const ACTIVITY_STYLE: Record<string, string> = {
  thought: 'text-atl-n-300',
  action: 'text-atl-n-700',
  error: 'text-atl-r-400',
};

function QuestionRow({ q, issueKey }: { q: AgentQuestion; issueKey: string }) {
  const [answer, setAnswer] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (text: string) => answerAgentQuestion(q.id, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-questions', issueKey] });
      queryClient.invalidateQueries({ queryKey: ['agent-sessions', issueKey] });
      setAnswer('');
    },
  });
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) mutation.mutate(trimmed);
  };
  return (
    <li className="rounded border border-atl-b-100 bg-atl-b-50/40 p-3 space-y-2">
      <div className="text-sm text-atl-n-800">{q.question}</div>
      {q.status === 'open' ? (
        <div className="space-y-1.5">
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <button
                  key={o}
                  onClick={() => submit(o)}
                  disabled={mutation.isPending}
                  className="rounded border border-atl-n-40 bg-atl-paper px-2 py-1 text-xs text-atl-n-700 hover:bg-atl-n-10"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !imeComposing(e)) submit(answer);
              }}
              placeholder="Answer the agent…"
              className="h-8 flex-1 rounded border border-atl-n-40 px-2 text-sm outline-none focus:border-atl-b-300"
            />
            <button
              onClick={() => submit(answer)}
              disabled={mutation.isPending || !answer.trim()}
              className="h-8 rounded bg-atl-b-500 px-3 text-xs font-semibold text-white hover:bg-atl-b-700 disabled:opacity-50"
            >
              Answer
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-atl-n-300">
          {q.answer} — {q.answeredBy ?? 'expired'}
        </div>
      )}
    </li>
  );
}

const ROLE_STYLE: Record<string, string> = {
  driver: 'bg-atl-b-100 text-atl-b-700',
  reviewer: 'bg-atl-n-30 text-atl-n-600',
  observer: 'bg-atl-n-20 text-atl-n-400',
};

// 072 FR-010 — ledger kind → lozenge style + label. The ledger is the
// immutable audit trail of what the fleet actually did to this issue.
const LEDGER_STYLE: Record<string, { label: string; cls: string }> = {
  lease_claimed: { label: 'claimed', cls: 'bg-atl-b-50 text-atl-b-500' },
  lease_handed_off: { label: 'handed off', cls: 'bg-atl-p-50 text-atl-p-500' },
  lease_ready_for_review: { label: 'ready for review', cls: 'bg-atl-y-50 text-atl-y-500' },
  lease_completed: { label: 'completed', cls: 'bg-atl-g-50 text-atl-g-500' },
  lease_failed: { label: 'failed', cls: 'bg-atl-r-50 text-atl-r-500' },
  lease_broken: { label: 'broken', cls: 'bg-atl-r-50 text-atl-r-500' },
  lease_expired: { label: 'expired', cls: 'bg-atl-n-20 text-atl-n-400' },
  receipt_submitted: { label: 'receipt', cls: 'bg-atl-y-50 text-atl-y-500' },
  receipt_verified: { label: 'receipt', cls: 'bg-atl-g-50 text-atl-g-500' },
  deliverable_approved: { label: 'approved', cls: 'bg-atl-g-50 text-atl-g-500' },
  deliverable_changes_requested: { label: 'changes req', cls: 'bg-atl-r-50 text-atl-r-500' },
  peer_question_answered: { label: 'q&a', cls: 'bg-atl-b-50 text-atl-b-500' },
  topic_compiled: { label: 'decision', cls: 'bg-atl-p-50 text-atl-p-500' },
  drift_flagged: { label: 'drift', cls: 'bg-atl-r-50 text-atl-r-500' },
};

const VERIFY_STYLE: Record<string, string> = {
  digest_only: 'bg-atl-y-50 text-atl-y-500',
  unverified: 'bg-atl-y-50 text-atl-y-500',
  hash_verified: 'bg-atl-b-50 text-atl-b-500',
  scm_corroborated: 'bg-atl-g-50 text-atl-g-500',
  human_attested: 'bg-atl-g-50 text-atl-g-500',
  signed_ci: 'bg-atl-g-50 text-atl-g-500',
};

function LedgerRow({ e, onInspectReceipt }: { e: IssueLedgerEntry; onInspectReceipt: (id: string) => void }) {
  const st = LEDGER_STYLE[e.kind] ?? { label: e.kind.replace(/_/g, ' '), cls: 'bg-atl-n-20 text-atl-n-500' };
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${st.cls}`} title={`Ledger: ${e.kind}`}>
        {st.label}
      </span>
      <span className="min-w-0 flex-1 text-atl-n-700">{e.summary}</span>
      {e.receipt && (
        <button
          type="button"
          onClick={() => onInspectReceipt(e.receipt!.id)}
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium hover:underline ${VERIFY_STYLE[e.receipt.verification] ?? VERIFY_STYLE.digest_only}`}
          title={`Inspect ${e.receipt.kind} receipt — ${e.receipt.verification.replace(/_/g, ' ')}`}
        >
          {e.receipt.verification.replace(/_/g, ' ')} · inspect
        </button>
      )}
      <span className="shrink-0 text-atl-n-200" title={formatDateTime(e.createdAt)}>
        {e.actor?.displayName ? `${e.actor.displayName} · ` : ''}
        {new Date(e.createdAt).toLocaleTimeString()}
      </span>
    </li>
  );
}

function SessionBlock({ s }: { s: AgentSessionView }) {
  const [expanded, setExpanded] = useState(s.status === 'running' || s.status === 'needs-answer');
  const leaseOpen = s.role === 'driver' && s.leaseExpiresAt && ['running', 'blocked', 'needs-answer'].includes(s.status);
  const leaseLeft = leaseOpen ? Math.max(0, new Date(s.leaseExpiresAt!).getTime() - Date.now()) : 0;
  return (
    <li className="rounded border border-atl-n-30">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-atl-n-10"
      >
        <span className="text-xs text-atl-n-200">{expanded ? '▾' : '▸'}</span>
        <span className="truncate text-sm font-medium text-atl-n-800" title={s.agent}>{s.agent}</span>
        <span className="text-xs text-atl-n-200">{s.trigger}</span>
        {s.role && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${ROLE_STYLE[s.role] ?? 'bg-atl-n-20 text-atl-n-400'}`}
            title={leaseOpen ? `Driver lease — expires ${formatDateTime(s.leaseExpiresAt!)} (~${Math.ceil(leaseLeft / 60_000)}m left), fence ${s.fenceToken}` : `Session role: ${s.role}`}
          >
            {s.role}
          </span>
        )}
        {s.worktreeRef && (
          <span className="rounded bg-atl-n-20 px-1.5 py-0.5 font-mono text-[10px] text-atl-n-500" title={`worktree: ${s.worktreeRef}`}>
            {s.worktreeRef}
          </span>
        )}
        {s.driftStatus && !['untracked', 'clean'].includes(s.driftStatus) && (
          <span
            className="rounded bg-atl-r-50 px-1.5 py-0.5 text-[10px] font-semibold text-atl-r-500"
            title={`Drift flag: ${s.driftStatus.replace(/_/g, ' ')} — declared work diverges from observed output`}
          >
            {s.driftStatus.replace(/_/g, ' ')}
          </span>
        )}
        <StatusLozenge name={s.status} categoryKey={SESSION_CATEGORY[s.status] ?? 'new'} className="ml-auto" />
      </button>
      {expanded && (
        <ul className="border-t border-atl-n-30 px-3 py-2 space-y-1">
          {s.activities.length === 0 && (
            <li className="text-xs text-atl-n-200">No activity yet — the agent is starting up.</li>
          )}
          {s.activities.map((a, i) => (
            <li key={i} className="flex gap-2 text-xs">
              <span className="shrink-0 text-atl-n-100">{new Date(a.at).toLocaleTimeString()}</span>
              <span className={`shrink-0 uppercase text-[10px] font-semibold ${ACTIVITY_STYLE[a.type] ?? ''}`}>
                {a.type}
              </span>
              <span className="min-w-0 text-atl-n-700">{a.text}</span>
            </li>
          ))}
          <li className="pt-1 text-[11px] text-atl-n-200">
            started {formatDateTime(s.startedAt)}
            {s.finishedAt ? ` · finished ${formatDateTime(s.finishedAt)}` : ''}
            {s.delegator ? ` · delegated by ${s.delegator}` : ''}
            {s.leaseExpiresAt ? ` · lease ${formatDateTime(s.leaseExpiresAt)}` : ''}
            {s.heartbeatAt ? ` · last heartbeat ${formatDateTime(s.heartbeatAt)}` : ''}
          </li>
        </ul>
      )}
    </li>
  );
}

export default function AgentSessionsPanel({ issueKey }: { issueKey: string }) {
  const [inspectReceiptId, setInspectReceiptId] = useState<string | null>(null);
  // Live via SSE: agent_session.*/agent_question.* events invalidate these keys
  // (events.ts); the slow interval is only a reconnect-failure fallback.
  const { data: sessions } = useQuery({
    queryKey: ['agent-sessions', issueKey],
    queryFn: () => fetchIssueSessions(issueKey),
    refetchInterval: 60_000,
  });
  const { data: questions } = useQuery({
    queryKey: ['agent-questions', issueKey],
    queryFn: () => fetchOpenQuestions(issueKey),
    refetchInterval: 60_000,
  });
  // 071 — town-hall topics deliberating on this issue (discusses/compiled edges).
  const { data: topics } = useQuery({
    queryKey: ['town-hall-topics', 'issue', issueKey],
    queryFn: () => fetchTownHallTopics({ issue: issueKey, limit: 8 }),
    refetchInterval: 60_000,
  });
  // 072 — immutable ledger: claims, handoffs, drift flags, verified receipts.
  const { data: ledger } = useQuery({
    queryKey: ['issue-ledger', issueKey],
    queryFn: () => fetchIssueLedger(issueKey, { limit: 15 }),
    refetchInterval: 60_000,
  });
  const open = questions?.questions ?? [];
  const list = sessions?.sessions ?? [];
  const deliberations = topics?.topics ?? [];
  const entries = ledger?.entries ?? [];
  if (!open.length && !list.length && !deliberations.length && !entries.length) return null;
  return (
    <section className="bg-atl-paper rounded shadow-sm p-4 space-y-3">
      <h2 className="text-sm font-semibold text-atl-n-800">Agent activity</h2>
      {open.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-atl-n-300 mb-1">Questions for you ({open.length})</div>
          <ul className="space-y-2">
            {open.map((q) => (
              <QuestionRow key={q.id} q={q} issueKey={issueKey} />
            ))}
          </ul>
        </div>
      )}
      {list.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-atl-n-300 mb-1">Sessions ({list.length})</div>
          <ul className="space-y-1.5">
            {list.map((s) => (
              <SessionBlock key={s.id} s={s} />
            ))}
          </ul>
        </div>
      )}
      {entries.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-atl-n-300 mb-1">Ledger ({entries.length})</div>
          <ul className="space-y-1">
            {entries.map((e) => (
              <LedgerRow key={e.id} e={e} onInspectReceipt={(rid) => setInspectReceiptId(rid)} />
            ))}
          </ul>
        </div>
      )}
      {deliberations.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-atl-n-300 mb-1">Town hall ({deliberations.length})</div>
          <ul className="space-y-1">
            {deliberations.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/town-hall?topic=${t.id}`}
                  className="flex items-center gap-2 rounded border border-atl-n-30 px-2 py-1.5 text-sm hover:bg-atl-n-10"
                  title={`${t.kind} · ${t.status} — open in Town Hall`}
                >
                  <span className="rounded bg-atl-n-30 px-1 text-[10px] font-semibold uppercase text-atl-n-600">{t.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-atl-n-800">{t.title}</span>
                  <span className={`text-[10px] font-medium ${t.status === 'decided' ? 'text-atl-g-500' : 'text-atl-n-300'}`}>{t.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ReceiptInspectorDrawer receiptId={inspectReceiptId} onClose={() => setInspectReceiptId(null)} />
    </section>
  );
}
