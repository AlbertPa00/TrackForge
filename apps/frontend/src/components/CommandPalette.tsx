import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMyself } from '../api/client.js';
import CreateIssueDialog from './CreateIssueDialog.js';
import Modal from './Modal.js';
import { localCommands, matchCommands, paletteIntent, type LocalCommand } from '../lib/commands.js';
import { imeComposing } from '../lib/ime.js';
import { openCopilot } from '../lib/copilotBus.js';

// 052+058+068 — the palette is the deterministic launcher: local commands,
// issue-key jumps and an explicit "Ask Copilot" handoff into the dock (Ctrl+J).
// Multi-turn reasoning lives in CopilotDock, not in a modal.

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { data: me } = useQuery({
    queryKey: ['myself'],
    queryFn: fetchMyself,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (open) {
      setInstruction('');
      setHighlight(0);
      setNotice(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const context = () => {
    const issueMatch = location.pathname.match(/^\/browse\/([A-Z][A-Z0-9]*-\d+)/);
    const projectMatch = location.pathname.match(/^\/projects\/([A-Z][A-Z0-9]*)/);
    return {
      issueKey: issueMatch?.[1] ?? searchParams.get('selectedIssue') ?? undefined,
      projectKey: projectMatch?.[1],
      route: location.pathname,
    };
  };

  if (!open && !createOpen) return null;

  const issueKeyMatch = instruction
    .trim()
    .toUpperCase()
    .match(/^[A-Z][A-Z0-9]*-\d+$/);
  const openIssue = () => {
    if (!issueKeyMatch) return;
    onClose();
    navigate(`/browse/${issueKeyMatch[0]}`);
  };

  // 058 US3 — deterministic local commands run whether or not AI is configured.
  // 068 — an explicit `ai:` prefix or copilot-intent text hands off to the dock
  // instead of letting substring command matches hijack real questions.
  const aiForced = /^ai:\s*/i.test(instruction);
  const aiQuery = instruction.replace(/^ai:\s*/i, '');
  const copilotIntent = aiForced || paletteIntent(instruction) === 'copilot';
  const cmdCtx = {
    navigate: (to: string) => {
      onClose();
      navigate(to);
    },
    qc,
    issueKey: context().issueKey,
    projectKey: context().projectKey,
    me,
    openCreate: () => {
      onClose();
      setCreateOpen(true);
    },
  };
  const cmds = matchCommands(
    localCommands(cmdCtx).filter((c) => !c.when || c.when(cmdCtx)),
    instruction
  ).slice(0, 8);
  const showAskRow = Boolean(instruction.trim()) && !issueKeyMatch;
  // Copilot-intent input puts the Ask row first so Enter asks, not navigates;
  // command-intent input keeps Enter on the top local command.
  const askFirst = copilotIntent && showAskRow;
  const optionCount = cmds.length + (showAskRow ? 1 : 0);
  const askIndex = askFirst ? 0 : cmds.length;

  const runCommand = async (cmd: LocalCommand) => {
    try {
      const msg = await cmd.run(cmdCtx, instruction);
      if (msg) {
        setNotice(msg);
        setInstruction('');
        setHighlight(0);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Command failed');
    }
  };

  const askCopilot = () => {
    const text = aiForced ? aiQuery : instruction;
    if (!text.trim()) return;
    onClose();
    openCopilot(text);
  };

  const ctx = context();
  const chips: string[] = [
    ...(ctx.issueKey ? [`Summarize ${ctx.issueKey}`] : []),
    'List my assigned issues',
    'Find stale issues with no update in 30 days',
  ].slice(0, 4);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        label="Command palette"
        className="mx-auto mt-[12vh] w-[640px] max-w-[92vw] overflow-hidden rounded-lg border border-atl-n-30 bg-atl-paper p-0 shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-4 border-b border-atl-n-30">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" className="text-atl-b-300 shrink-0">
            <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
          </svg>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={optionCount > 0}
            aria-controls={optionCount ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={optionCount ? `${listboxId}-opt-${Math.min(highlight, optionCount - 1)}` : undefined}
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
              setNotice(null);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, optionCount - 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
                return;
              }
              if (e.key !== 'Enter' || imeComposing(e)) return;
              if (issueKeyMatch) {
                openIssue();
                return;
              }
              const idx = Math.min(highlight, optionCount - 1);
              if (showAskRow && idx === askIndex) {
                askCopilot();
                return;
              }
              if (idx < cmds.length) {
                void runCommand(cmds[idx]!);
                return;
              }
              if (showAskRow) {
                askCopilot();
                return;
              }
              if (instruction.trim()) askCopilot();
            }}
            placeholder="Type a command, an issue key (TF-123), or a question…"
            className="h-12 flex-1 text-[15px] outline-none placeholder:text-atl-n-200"
          />
          <kbd className="text-[10px] text-atl-n-200 border border-atl-n-30 rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div className="max-h-[55vh] overflow-auto p-4 space-y-2">
          {notice && <div className="rounded bg-atl-g-50 px-3 py-2 text-sm text-atl-g-600">{notice}</div>}
          {optionCount > 0 && (
            <div className="space-y-0.5" role="listbox" id={listboxId} aria-label="Commands">
              {askFirst && (
                <AskRow
                  id={`${listboxId}-opt-0`}
                  selected={highlight === 0}
                  text={aiForced ? aiQuery : instruction}
                  onRun={askCopilot}
                  onHover={() => setHighlight(0)}
                />
              )}
              {cmds.map((c, i) => {
                const optIdx = askFirst ? i + 1 : i;
                return (
                  <button
                    key={c.id}
                    id={`${listboxId}-opt-${optIdx}`}
                    role="option"
                    aria-selected={optIdx === highlight}
                    onMouseEnter={() => setHighlight(optIdx)}
                    onClick={() => void runCommand(c)}
                    className={`w-full text-left rounded px-3 py-2 flex items-center gap-2 text-sm ${
                      optIdx === highlight ? 'bg-atl-b-50 text-atl-n-800' : 'text-atl-n-600'
                    }`}
                  >
                    <span className="min-w-0 truncate" title={c.title}>{c.title}</span>
                    {c.hint && <span className="ml-auto shrink-0 text-[10px] text-atl-n-300">{c.hint}</span>}
                  </button>
                );
              })}
              {showAskRow && !askFirst && (
                <AskRow
                  id={`${listboxId}-opt-${askIndex}`}
                  selected={highlight === askIndex}
                  text={instruction}
                  onRun={askCopilot}
                  onHover={() => setHighlight(askIndex)}
                />
              )}
            </div>
          )}
          {issueKeyMatch && (
            <button
              onClick={openIssue}
              className="w-full text-left rounded border border-atl-n-30 px-3 py-2.5 text-sm text-atl-n-700 hover:bg-atl-n-10 flex items-center gap-2"
            >
              <span className="font-medium text-atl-b-300">{issueKeyMatch[0]}</span>
              <span>Open issue</span>
              <kbd className="ml-auto text-[10px] text-atl-n-200 border border-atl-n-30 rounded px-1.5 py-0.5">↵</kbd>
            </button>
          )}
          {!issueKeyMatch && optionCount === 0 && (
            <div className="space-y-3">
              <div className="text-xs text-atl-n-200 leading-relaxed">
                Type a command, or ask the copilot a question — it opens in the side panel and keeps context across
                follow-ups.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      onClose();
                      openCopilot(c);
                    }}
                    className="rounded-full border border-atl-n-30 bg-atl-n-10 px-2.5 py-1 text-xs text-atl-n-600 hover:bg-atl-n-20 hover:text-atl-n-800"
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
      <CreateIssueDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function AskRow({
  id,
  selected,
  text,
  onRun,
  onHover,
}: {
  id: string;
  selected: boolean;
  text: string;
  onRun: () => void;
  onHover: () => void;
}) {
  return (
    <button
      id={id}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onRun}
      className={`w-full text-left rounded px-3 py-2 flex items-center gap-2 text-sm ${
        selected ? 'bg-atl-b-50 text-atl-n-800' : 'text-atl-n-600'
      }`}
    >
      <span className="min-w-0 truncate" title={`Ask Copilot — ${text}`}>
        Ask Copilot — <span className="text-atl-n-400">{text}</span>
      </span>
      <span className="ml-auto shrink-0 text-[10px] text-atl-n-300">Ctrl+J</span>
    </button>
  );
}
