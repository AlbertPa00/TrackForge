import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  answerAgentQuestion,
  fetchOpenQuestions,
  type AgentActivity,
} from '../api/client.js';
import { markIssueWrite } from '../lib/issueWrites.js';
import { imeComposing } from '../lib/ime.js';

/**
 * 058 US5 — live agent-presence badge for board/backlog cards. Data comes from
 * the page-level `['agent-activity', project]` query (SSE-invalidated), so a
 * board of 100 cards costs one fetch. The needs-answer state opens an inline
 * question/answer popover — answering resumes the agent session.
 */
export default function AgentBadge({
  issueKey,
  activity,
}: {
  issueKey: string;
  activity?: AgentActivity;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  if (!activity || (!activity.running && !activity.blocked && !activity.needsAnswer)) return null;
  const needsAnswer = activity.needsAnswer > 0;
  const title = needsAnswer
    ? `${activity.needsAnswer} question${activity.needsAnswer === 1 ? '' : 's'} needs an answer — ${activity.agents.join(', ')}`
    : `Agent working — ${activity.agents.join(', ')}${activity.blocked ? ' (blocked)' : ''}`;

  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <button
        ref={anchorRef}
        type="button"
        title={title}
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && anchorRef.current) {
            const r = anchorRef.current.getBoundingClientRect();
            setPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 340) });
          }
          setOpen((o) => !o);
        }}
        className={`relative rounded-full flex items-center justify-center text-[9px] font-bold text-white ${
          needsAnswer ? 'bg-atl-y-500' : activity.blocked ? 'bg-atl-r-400' : 'bg-atl-b-400'
        }`}
        style={{ height: 18, width: 18 }}
      >
        {needsAnswer ? '?' : (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
          </svg>
        )}
        {!needsAnswer && (
          <span className="absolute inset-0 rounded-full animate-ping bg-atl-b-300 opacity-40" aria-hidden />
        )}
      </button>
      {open && pos &&
        createPortal(
          <QuestionsPopover issueKey={issueKey} top={pos.top} left={pos.left} onClose={() => setOpen(false)} />,
          document.body
        )}
    </span>
  );
}

function QuestionsPopover({
  issueKey,
  top,
  left,
  onClose,
}: {
  issueKey: string;
  top: number;
  left: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ['agent-questions', issueKey],
    queryFn: () => fetchOpenQuestions(issueKey),
  });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => answerAgentQuestion(id, text),
    onSuccess: () => {
      markIssueWrite(issueKey);
      qc.invalidateQueries({ queryKey: ['agent-questions', issueKey] });
      qc.invalidateQueries({ queryKey: ['agent-activity'] });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  const questions = data?.questions ?? [];
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Agent questions on ${issueKey}`}
      className="fixed z-[60] w-80 rounded-md border border-atl-n-30 bg-atl-paper shadow-2xl"
      style={{ top, left }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-atl-n-30 text-xs font-semibold text-atl-n-800">
        Agent needs an answer
      </div>
      <div className="max-h-72 overflow-y-auto p-3 space-y-3">
        {questions.length === 0 && (
          <div className="text-xs text-atl-n-300">No open questions — the agent may have resumed.</div>
        )}
        {questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            <div className="text-xs text-atl-n-800">{q.question}</div>
            {q.options?.length ? (
              <div className="flex flex-wrap gap-1">
                {q.options.map((o) => (
                  <button
                    key={o}
                    disabled={answer.isPending}
                    onClick={() => answer.mutate({ id: q.id, text: o })}
                    className="rounded-full border border-atl-b-200 px-2 py-0.5 text-[11px] text-atl-b-400 hover:bg-atl-b-50 disabled:opacity-50"
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex gap-1">
              <input
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !imeComposing(e) && (answers[q.id] ?? '').trim()) {
                    answer.mutate({ id: q.id, text: answers[q.id]!.trim() });
                  }
                }}
                placeholder="Type an answer…"
                className="h-7 flex-1 rounded border border-atl-n-30 px-2 text-xs outline-none focus:border-atl-b-300"
              />
              <button
                disabled={answer.isPending || !(answers[q.id] ?? '').trim()}
                onClick={() => answer.mutate({ id: q.id, text: answers[q.id]!.trim() })}
                className="h-7 px-2 rounded bg-atl-b-300 text-white text-xs font-medium disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
