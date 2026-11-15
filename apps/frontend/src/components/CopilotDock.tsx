// 068 — the Copilot workbench: a persistent right rail that keeps multi-turn
// context, renders grounded markdown answers, and carries the write-preview →
// apply contract from Sprint 052. `Ctrl+J` toggles it; it never blocks the app.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteCopilotThread,
  executeCopilot,
  fetchAiCapabilities,
  fetchCopilotThread,
  fetchCopilotThreads,
  fetchMyself,
  planCopilot,
  postAiOutcome,
  transcribeAudio,
  type CopilotPlan,
  type CopilotResult,
  type CopilotThreadSummary,
} from '../api/client.js';
import { Markdown } from './Markdown.js';
import { PLAN_STEP_LABEL, ResultRow, StepRow } from './copilotSteps.js';
import { imeComposing } from '../lib/ime.js';
import { COPILOT_OPEN_EVENT } from '../lib/copilotBus.js';

const THREAD_KEY = 'tf.copilot.threadId';
/** Dictation granularity — a complete audio file is transcribed per slice. */
const VOICE_CHUNK_MS = 5000;

interface UITurn {
  /** server turn id ('' until persisted / for pending turns) */
  id: string;
  instruction: string;
  pending?: boolean;
  error?: string;
  clarify?: { question: string; options?: string[] };
  answer?: string;
  plan?: CopilotPlan;
  selected?: Set<number>;
  results?: CopilotResult[];
  /** restored-from-history hint: plan expired, outcome only */
  outcome?: string;
  writesApplied?: { tool: string; target: string; status: string }[];
}

function TurnBlock({
  turn,
  onToggle,
  onApply,
  onClarify,
  onSuggest,
  applying,
  progressLabel,
}: {
  turn: UITurn;
  onToggle: (i: number) => void;
  onApply: () => void;
  onClarify: (option: string) => void;
  onSuggest: (text: string) => void;
  applying: boolean;
  progressLabel?: string;
}) {
  const steps = turn.plan?.steps ?? [];
  const writes = steps.filter((s, i) => s.kind === 'write' && !s.error && turn.selected?.has(i));
  const anyWrite = steps.some((s) => s.kind === 'write');
  const reads = steps.filter((s) => s.kind !== 'write');
  const failedReads = reads.filter((s) => s.error);
  // Answered turns lead with the markdown; their reads collapse into evidence.
  const evidence = (
    <>
      {reads.map((s, i) => (
        <StepRow key={i} step={s} />
      ))}
    </>
  );
  return (
    <div className="space-y-2" data-turn={turn.id}>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-atl-b-50 px-3 py-2 text-sm text-atl-n-800">{turn.instruction}</div>
      </div>
      {turn.pending && !turn.plan && (
        <div className="flex items-center gap-2 text-xs text-atl-n-300" data-testid="turn-pending">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-atl-b-300" />
          {progressLabel ?? 'Thinking…'}
        </div>
      )}
      {turn.error && <div className="rounded bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{turn.error}</div>}
      {turn.clarify && (
        <div className="rounded bg-atl-b-50 px-3 py-2.5">
          <Markdown text={turn.clarify.question} />
          {!!turn.clarify.options?.length && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {turn.clarify.options.map((o) => (
                <button
                  key={o}
                  onClick={() => onClarify(o)}
                  className="rounded-full border border-atl-b-200 bg-atl-paper px-2.5 py-1 text-xs text-atl-b-400 hover:bg-atl-b-100"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="mt-1.5 text-[11px] text-atl-n-300">Or type a reply below.</div>
        </div>
      )}
      {turn.answer && (
        <div
          className="rounded border border-atl-n-30 border-l-2 border-l-atl-b-200 bg-atl-paper px-3 py-2"
          data-testid="copilot-answer"
        >
          <Markdown text={turn.answer} />
        </div>
      )}
      {!!turn.plan?.suggestions?.length && (
        <div className="flex flex-wrap gap-1.5">
          {turn.plan.suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onSuggest(s)}
              className="rounded-full border border-atl-n-30 bg-atl-n-10 px-2.5 py-1 text-xs text-atl-n-600 hover:bg-atl-n-20 hover:text-atl-n-800"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {turn.plan?.warnings?.map((w, i) => (
        <div key={i} className="rounded bg-atl-y-50 px-3 py-1.5 text-xs text-atl-y-600">
          {w}
        </div>
      ))}
      {!!reads.length &&
        (turn.answer ? (
          <details className="rounded border border-atl-n-30 px-3 py-1.5">
            <summary className="cursor-pointer text-[11px] text-atl-n-300 hover:text-atl-n-500">
              Evidence — {reads.length} read{reads.length === 1 ? '' : 's'}
              {failedReads.length ? `, ${failedReads.length} failed` : ''}
            </summary>
            <div className="mt-2 space-y-2">{evidence}</div>
          </details>
        ) : (
          evidence
        ))}
      {steps.map((s, i) =>
        s.kind === 'write' ? (
          <StepRow key={i} step={s} checked={turn.selected?.has(i)} onToggle={() => onToggle(i)} />
        ) : null
      )}
      {turn.results?.map((r) => (
        <ResultRow key={r.index} r={r} />
      ))}
      {!!turn.writesApplied?.length && !turn.results && (
        <div className="rounded bg-atl-n-10 px-3 py-2 text-xs text-atl-n-500">
          {turn.writesApplied.map((w, i) => (
            <div key={i}>
              {w.tool} {w.target} — {w.status}
            </div>
          ))}
        </div>
      )}
      {turn.outcome && !turn.plan && !turn.answer && !turn.clarify && !turn.results && (
        <div className="text-xs text-atl-n-300 italic">Turn {turn.outcome} — plan expired.</div>
      )}
      {turn.plan?.planId && anyWrite && !turn.results && (
        <div className="flex items-center gap-2">
          <button
            onClick={onApply}
            disabled={applying || writes.length === 0}
            className="h-8 px-4 rounded bg-atl-b-300 hover:bg-atl-b-400 text-white text-sm font-medium disabled:opacity-50"
          >
            {applying
              ? 'Applying…'
              : writes.length
                ? `Apply ${writes.length} change${writes.length === 1 ? '' : 's'}`
                : 'Select a step to apply'}
          </button>
          {writes.some((s) => s.destructive) && (
            <span className="text-xs text-atl-r-500">Includes destructive steps</span>
          )}
        </div>
      )}
    </div>
  );
}

export default function CopilotDock({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [minimized, setMinimized] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(() => localStorage.getItem(THREAD_KEY));
  const [turns, setTurns] = useState<UITurn[]>([]);
  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });

  // Voice input — the mic only exists when an admin configured a speech model
  // (GET /ai/capabilities.speech). While recording, the MediaRecorder rotates
  // every VOICE_CHUNK_MS: each complete audio file is transcribed in order and
  // the words stream into the draft at the recording-start cursor position.
  const { data: aiCaps } = useQuery({
    queryKey: ['ai-capabilities'],
    queryFn: fetchAiCapabilities,
    staleTime: 60_000,
  });
  const speechOn = Boolean(aiCaps?.speech);
  const micSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  /** Provider-reported stats of the last dictation (seconds of audio, USD cost). */
  const [voiceInfo, setVoiceInfo] = useState<{ seconds: number; costUsd: number } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mimeRef = useRef('');
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Serial upload queue — transcripts land in speech order, not arrival order. */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const discardRef = useRef(false);
  const stoppingRef = useRef(false);
  /** finishVoice runs once per dictation — overlapping stops (user stop racing
   *  a chunk rotation) both drain the chain; only the first may finish. */
  const finishedRef = useRef(true);
  /** Draft index where streamed text began, and chars inserted there so far. */
  const anchorRef = useRef(0);
  const insertedLenRef = useRef(0);
  const statsRef = useRef({ seconds: 0, costUsd: 0 });

  const insertAtAnchor = (text: string) => {
    setDraft((d) => {
      const at = Math.min(anchorRef.current + insertedLenRef.current, d.length);
      const sep = at > 0 && !/\s/.test(d.charAt(at - 1)) ? ' ' : '';
      const ins = sep + text;
      insertedLenRef.current += ins.length;
      return d.slice(0, at) + ins + d.slice(at);
    });
  };

  const enqueueChunk = (blob: Blob) => {
    chainRef.current = chainRef.current.then(async () => {
      if (discardRef.current) return;
      try {
        const r = await transcribeAudio(blob);
        if (discardRef.current) return;
        statsRef.current.seconds += r.audioSeconds ?? 0;
        statsRef.current.costUsd += r.costUsd ?? 0;
        const t = r.text.trim();
        if (t) insertAtAnchor(t);
      } catch (e) {
        setVoiceError(e instanceof Error ? e.message : 'Transcription failed');
      }
    });
  };

  const finishVoice = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (discardRef.current) {
      // Esc — remove exactly the streamed span, keep whatever else was typed.
      const anchor = anchorRef.current;
      const len = insertedLenRef.current;
      insertedLenRef.current = 0;
      setDraft((d) => d.slice(0, Math.min(anchor, d.length)) + d.slice(Math.min(anchor + len, d.length)));
    } else {
      setVoiceInfo({ ...statsRef.current });
      requestAnimationFrame(() => taRef.current?.focus());
    }
    setVoice('idle');
  };

  const spawnRecorder = () => {
    if (!streamRef.current) return;
    const mime = mimeRef.current;
    const rec = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data.size) enqueueChunk(e.data);
    };
    rec.onstop = () => {
      // Mid-rotation stops fire with stopping=false and only enqueue their
      // chunk; the user-initiated final stop drains the queue, then finishes.
      if (stoppingRef.current) void chainRef.current.then(finishVoice);
    };
    rec.start();
    recorderRef.current = rec;
  };

  const rotateRecorder = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    spawnRecorder();
  };

  const stopRecording = useCallback((discard = false) => {
    discardRef.current = discard;
    stoppingRef.current = true;
    if (chunkTimerRef.current) {
      clearInterval(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    if (!discard) setVoice('transcribing');
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop(); // onstop → drain chain → finishVoice
    } else {
      void chainRef.current.then(finishVoice);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setVoiceError(null);
    setVoiceInfo(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setVoiceError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : 'Microphone unavailable.'
      );
      return;
    }
    try {
      streamRef.current = stream;
      mimeRef.current = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      anchorRef.current = taRef.current?.selectionStart ?? draft.length;
      insertedLenRef.current = 0;
      statsRef.current = { seconds: 0, costUsd: 0 };
      discardRef.current = false;
      stoppingRef.current = false;
      finishedRef.current = false;
      chainRef.current = Promise.resolve();
      spawnRecorder();
      chunkTimerRef.current = setInterval(rotateRecorder, VOICE_CHUNK_MS);
      setVoice('recording');
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setVoiceError('Recording failed to start.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // A recording in flight is discarded when the dock unmounts.
  useEffect(
    () => () => {
      discardRef.current = true;
      stoppingRef.current = true;
      if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      else streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    []
  );

  // Load an existing thread (on mount or when threadId changes). Hydration runs
  // once per thread and MERGES by turn id — a background refetch must never
  // clobber live turn state (plan selections, results, in-flight previews).
  const [hydratedThread, setHydratedThread] = useState<string | null>(null);
  const threadQuery = useQuery({
    queryKey: ['copilot-thread', threadId],
    queryFn: () => fetchCopilotThread(threadId!),
    enabled: Boolean(threadId),
  });
  useEffect(() => {
    const t = threadQuery.data?.thread;
    if (!t || t.id === hydratedThread) return;
    setHydratedThread(t.id);
    setTurns((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      const merged = t.turns.map((u) => {
        const base: UITurn = {
          id: u.id,
          instruction: u.instruction,
          answer: u.answer,
          outcome: u.outcome,
          writesApplied: u.writesApplied,
          clarify: u.outcome === 'clarified' ? { question: u.answer ?? '' } : undefined,
        };
        const local = byId.get(u.id);
        // Keep the live plan/selection/results; server outcome is fresher.
        return local ? { ...local, outcome: u.outcome, writesApplied: u.writesApplied ?? local.writesApplied } : base;
      });
      // Local-only turns (pending, or not yet synced to the server) survive.
      const seen = new Set(t.turns.map((u) => u.id));
      for (const local of prev) if (!seen.has(local.id)) merged.push(local);
      return merged;
    });
  }, [threadQuery.data, hydratedThread]);

  // Only a real 404 means the stored thread id is gone — a network blip must
  // not silently drop the workbench's context.
  useEffect(() => {
    if (threadQuery.isError && /404|not found/i.test(String(threadQuery.error))) {
      setThreadId(null);
      setHydratedThread(null);
      localStorage.removeItem(THREAD_KEY);
    }
  }, [threadQuery.isError, threadQuery.error]);

  const threadsQuery = useQuery({
    queryKey: ['copilot-threads'],
    queryFn: fetchCopilotThreads,
    enabled: historyOpen,
  });

  const context = useCallback(() => {
    const issueMatch = location.pathname.match(/^\/browse\/([A-Z][A-Z0-9]*-\d+)/);
    const projectMatch = location.pathname.match(/^\/projects\/([A-Z][A-Z0-9]*)/);
    return {
      issueKey: issueMatch?.[1] ?? searchParams.get('selectedIssue') ?? undefined,
      projectKey: projectMatch?.[1],
      route: location.pathname,
    };
  }, [location.pathname, searchParams]);

  const { data: progress } = useQuery<{ step?: string; at?: number } | null>({
    queryKey: ['ai-progress', 'plan'],
    queryFn: () => Promise.resolve(null),
    enabled: false,
    staleTime: Infinity,
  });

  const scrollToBottom = () =>
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });

  const patchTurn = (id: string, patch: Partial<UITurn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const submit = useCallback(
    (text: string) => {
      const instruction = text.trim();
      if (!instruction) return;
      const tempId = `pending-${Date.now()}`;
      setTurns((ts) => [...ts, { id: tempId, instruction, pending: true }]);
      setDraft('');
      setVoiceInfo(null);
      setNotice(null);
      scrollToBottom();
      qc.setQueryData(['ai-progress', 'plan'], { step: 'context', at: Date.now() });
      planCopilot(instruction, context(), threadId ?? undefined)
        .then((p) => {
          if (p.threadId && p.threadId !== threadId) {
            setThreadId(p.threadId);
            localStorage.setItem(THREAD_KEY, p.threadId);
          }
          const turn: Partial<UITurn> = {
            id: p.turnId || tempId,
            pending: false,
            clarify: p.clarify,
            answer: p.answer,
            plan: p,
            selected: new Set(
              (p.steps ?? [])
                .map((s, i) => (s.kind === 'write' && !s.destructive && !s.error ? i : -1))
                .filter((i) => i >= 0)
            ),
          };
          if (p.clarify) postAiOutcome('plan', 'clarified');
          setTurns((ts) => ts.map((t) => (t.id === tempId ? { ...t, ...turn } : t)));
          scrollToBottom();
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : 'Planning failed';
          patchTurn(tempId, { pending: false, error: msg });
          postAiOutcome('plan', 'failed');
        });
    },
    [context, qc, threadId]
  );

  // Palette / TopNav handoff: open with a seeded prompt.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      setMinimized(false);
      if (prompt) {
        submit(prompt);
      } else {
        requestAnimationFrame(() => taRef.current?.focus());
      }
    };
    window.addEventListener(COPILOT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(COPILOT_OPEN_EVENT, onOpen);
  }, [submit]);

  const apply = (turn: UITurn) => {
    const plan = turn.plan;
    if (!plan?.planId) {
      setNotice('This plan expired — ask again.');
      return;
    }
    const steps = (plan.steps ?? []).filter((s, i) => s.kind === 'write' && turn.selected?.has(i));
    const tempId = turn.id;
    patchTurn(tempId, { pending: true });
    executeCopilot(plan.planId, steps, turn.id || undefined)
      .then((r) => {
        patchTurn(tempId, { pending: false, results: r.results });
        void qc.invalidateQueries();
        scrollToBottom();
      })
      .catch((e) => {
        patchTurn(tempId, { pending: false, error: e instanceof Error ? e.message : 'Execute failed' });
        postAiOutcome('plan', 'failed');
      });
  };

  const newThread = () => {
    setThreadId(null);
    setHydratedThread(null);
    localStorage.removeItem(THREAD_KEY);
    setTurns([]);
    setHistoryOpen(false);
    setNotice(null);
  };

  const openThread = (t: CopilotThreadSummary) => {
    setThreadId(t.id);
    setHydratedThread(null);
    setTurns([]);
    setNotice(null);
    localStorage.setItem(THREAD_KEY, t.id);
    setHistoryOpen(false);
  };

  const removeThread = async (t: CopilotThreadSummary) => {
    await deleteCopilotThread(t.id).catch(() => undefined);
    void threadsQuery.refetch();
    if (t.id === threadId) newThread();
  };

  const aiMissing = turns.some((t) => /not configured/i.test(t.error ?? ''));

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        title="Open Copilot (Ctrl+J)"
        aria-label="Open Copilot"
        className="w-12 shrink-0 border-l border-atl-n-30 bg-atl-paper flex flex-col items-center gap-2 pt-4 text-atl-b-300 hover:bg-atl-b-50"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
        </svg>
        <span className="text-[10px] text-atl-n-300 [writing-mode:vertical-lr]">Copilot</span>
      </button>
    );
  }

  const ctx = context();
  const chips = [
    ...(ctx.issueKey ? [`Summarize ${ctx.issueKey}`] : []),
    'List my assigned issues',
    'How many open issues per status?',
    'Find stale issues with no update in 30 days',
  ].slice(0, 4);

  return (
    <aside
      aria-label="Copilot"
      className="flex w-[400px] max-w-[46vw] shrink-0 flex-col border-l border-atl-n-30 bg-atl-paper"
      data-testid="copilot-dock"
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-atl-n-30 px-3">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="text-atl-b-300"
          aria-hidden="true"
        >
          <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
        </svg>
        <span className="text-sm font-medium text-atl-n-800">Copilot</span>
        <span className="ml-1 text-[10px] text-atl-n-200">Ctrl+J</span>
        <span className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            title="Threads"
            aria-label="Thread history"
            className="h-7 w-7 rounded text-xs text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-600"
          >
            ≡
          </button>
          <button
            onClick={newThread}
            title="New thread"
            aria-label="New thread"
            className="h-7 w-7 rounded text-xs text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-600"
          >
            ＋
          </button>
          <button
            onClick={() => setMinimized(true)}
            title="Minimize to rail"
            aria-label="Minimize Copilot"
            className="h-7 w-7 rounded text-xs text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-600"
          >
            ▸
          </button>
          <button
            onClick={onClose}
            title="Close (Ctrl+J)"
            aria-label="Close Copilot"
            className="h-7 w-7 rounded text-xs text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-600"
          >
            ✕
          </button>
        </span>
      </header>

      {historyOpen && (
        <div className="max-h-56 shrink-0 overflow-auto border-b border-atl-n-30 bg-atl-n-10">
          {(threadsQuery.data?.threads ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-1 px-3 py-1.5 hover:bg-atl-n-20">
              <button
                onClick={() => openThread(t)}
                title={t.title || 'Untitled'}
                className={`min-w-0 flex-1 truncate text-left text-xs ${t.id === threadId ? 'font-medium text-atl-b-400' : 'text-atl-n-700'}`}
              >
                {t.title || 'Untitled'} <span className="text-atl-n-300">· {t.turns} turns</span>
              </button>
              <button
                onClick={() => void removeThread(t)}
                aria-label={`Delete thread ${t.title ?? t.id}`}
                className="text-[10px] text-atl-n-300 hover:text-atl-r-400"
              >
                ✕
              </button>
            </div>
          ))}
          {threadsQuery.data && threadsQuery.data.threads.length === 0 && (
            <div className="px-3 py-2 text-xs text-atl-n-300">No threads yet.</div>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-3">
        {notice && <div className="rounded bg-atl-g-50 px-3 py-2 text-sm text-atl-g-600">{notice}</div>}
        {turns.length === 0 && !threadQuery.isLoading && (
          <div className="space-y-3 pt-6">
            <div className="text-sm text-atl-n-500">Ask about your work, then follow up — I keep the context.</div>
            <div className="text-xs text-atl-n-300 leading-relaxed">
              Reads answer inline; writes always preview and wait for your Apply.
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <button
                  key={c}
                  onClick={() => submit(c)}
                  className="rounded-full border border-atl-n-30 bg-atl-n-10 px-2.5 py-1 text-xs text-atl-n-600 hover:bg-atl-n-20 hover:text-atl-n-800"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        {threadQuery.isLoading && <div className="text-xs text-atl-n-300">Loading thread…</div>}
        {turns.map((t) => (
          <TurnBlock
            key={t.id}
            turn={t}
            applying={Boolean(t.pending && t.plan)}
            onToggle={(i) =>
              patchTurn(t.id, {
                selected: (() => {
                  const n = new Set(t.selected ?? []);
                  if (n.has(i)) n.delete(i);
                  else n.add(i);
                  return n;
                })(),
              })
            }
            onApply={() => apply(t)}
            onClarify={(o) => submit(`${t.instruction} — ${o}`)}
            onSuggest={submit}
            progressLabel={t.pending && !t.plan ? (PLAN_STEP_LABEL[progress?.step ?? ''] ?? 'Working…') : undefined}
          />
        ))}
        {aiMissing && (
          <div className="rounded bg-atl-b-50 px-3 py-2.5 text-sm text-atl-n-700">
            The copilot needs an AI provider before it can plan.{' '}
            <Link to="/settings/ai" className="font-medium text-atl-b-300 hover:underline">
              Set one up in AI settings
            </Link>
            .
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-atl-n-30 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && voice === 'recording') {
                e.preventDefault();
                stopRecording(true);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !imeComposing(e)) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={Math.min(6, Math.max(2, draft.split('\n').length + 1))}
            placeholder="Ask, or say what to change… (Enter sends, Shift+Enter new line)"
            aria-label="Message Copilot"
            className="w-full min-w-0 flex-1 rounded border border-atl-n-40 px-3 py-2 text-sm text-atl-n-700 focus:outline-none focus:ring-2 focus:ring-atl-b-200 focus:border-atl-b-300"
          />
          {speechOn && (
            <button
              type="button"
              data-testid="copilot-mic"
              onClick={() =>
                voice === 'recording' ? stopRecording() : voice === 'idle' ? void startRecording() : undefined
              }
              disabled={voice === 'transcribing' || !micSupported}
              title={
                !micSupported
                  ? 'Voice input needs HTTPS or localhost microphone access'
                  : voice === 'recording'
                    ? 'Stop (Esc cancels) — words stream into the draft as you speak'
                    : voice === 'transcribing'
                      ? 'Transcribing…'
                      : 'Dictate an instruction'
              }
              aria-label={voice === 'recording' ? 'Stop recording and transcribe' : 'Dictate an instruction'}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded border text-sm disabled:opacity-50 ${
                voice === 'recording'
                  ? 'animate-pulse border-atl-r-300 bg-atl-r-50 text-atl-r-500'
                  : 'border-atl-n-40 text-atl-n-500 hover:bg-atl-n-10 hover:text-atl-n-800'
              }`}
            >
              {voice === 'recording' ? (
                '■'
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  aria-hidden="true"
                >
                  <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
                  <path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V15" />
                </svg>
              )}
            </button>
          )}
        </div>
        {voice === 'recording' && (
          <div className="mt-1.5 text-[11px] text-atl-r-400">
            Recording — words stream into the draft as you speak. Click to stop, Esc to cancel.
          </div>
        )}
        {voice === 'transcribing' && <div className="mt-1.5 text-[11px] text-atl-n-300">Transcribing…</div>}
        {voice === 'idle' && voiceInfo && (voiceInfo.seconds > 0 || voiceInfo.costUsd > 0) && (
          <div className="mt-1.5 text-[11px] text-atl-n-300">
            Dictated{voiceInfo.seconds > 0 ? ` ${voiceInfo.seconds.toFixed(1)}s` : ''}
            {voiceInfo.costUsd > 0 ? ` · $${voiceInfo.costUsd.toFixed(4)}` : ''}
          </div>
        )}
        {voiceError && <div className="mt-1.5 text-xs text-atl-r-500">{voiceError}</div>}
      </footer>
    </aside>
  );
}
