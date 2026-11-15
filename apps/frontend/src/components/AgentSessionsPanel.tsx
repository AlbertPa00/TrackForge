// Sprint 047 US2/US3 — agent sessions panel on the issue page: inspectable
// agent work (activities timeline, status) + the question inbox with inline
// answering. Hidden when the issue has no sessions and no open questions.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  answerAgentQuestion,
  fetchIssueSessions,
  fetchOpenQuestions,
  type AgentQuestion,
  type AgentSessionView,
} from '../api/client.js';
import StatusLozenge from './StatusLozenge.js';
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

function SessionBlock({ s }: { s: AgentSessionView }) {
  const [expanded, setExpanded] = useState(s.status === 'running' || s.status === 'needs-answer');
  return (
    <li className="rounded border border-atl-n-30">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-atl-n-10"
      >
        <span className="text-xs text-atl-n-200">{expanded ? '▾' : '▸'}</span>
        <span className="truncate text-sm font-medium text-atl-n-800" title={s.agent}>{s.agent}</span>
        <span className="text-xs text-atl-n-200">{s.trigger}</span>
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
          </li>
        </ul>
      )}
    </li>
  );
}

export default function AgentSessionsPanel({ issueKey }: { issueKey: string }) {
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
  const open = questions?.questions ?? [];
  const list = sessions?.sessions ?? [];
  if (!open.length && !list.length) return null;
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
    </section>
  );
}
