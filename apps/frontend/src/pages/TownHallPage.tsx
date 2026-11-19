// 071 — Town Hall: the mission-control page for the agent fleet. Left rail:
// channels + fleet roster (presence/capacity). Center: typed topic feed.
// Right (or below): the open topic — threaded speech-act posts, zero-prose
// stances, quorum tally, and the resolve→compile-DAG composer.
import { useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchTownHallChannels,
  fetchTownHallTopics,
  fetchTownHallTopic,
  openTownHallTopic,
  postToTownHallTopic,
  putTownHallStance,
  resolveTownHallTopic,
  fetchAgentRoster,
  fetchFleetSessions,
  fetchFleetPause,
  fetchFleetHealth,
  fetchFleetMetrics,
  setProjectFleetPause,
  breakIssueLease,
  type TownHallChannel,
  type TownHallTopic,
} from '../api/client.js';
import OverflowText from '../components/OverflowText.js';
import ReceiptInspectorDrawer from '../components/ReceiptInspectorDrawer.js';

const KIND_COLORS: Record<string, string> = {
  rfc: 'bg-indigo-100 text-indigo-700',
  discovery: 'bg-emerald-100 text-emerald-700',
  blocker: 'bg-red-100 text-red-700',
  incident: 'bg-orange-100 text-orange-700',
  standup: 'bg-slate-100 text-slate-600',
};
const ACT_COLORS: Record<string, string> = {
  proposal: 'border-indigo-400',
  critique: 'border-red-400',
  evidence: 'border-emerald-400',
  question: 'border-amber-400',
  answer: 'border-sky-400',
  synthesis: 'border-violet-400',
  decision: 'border-slate-800 bg-slate-50',
};

function PresenceDot({ status }: { status: string }) {
  const c = status === 'online' ? 'bg-emerald-500' : status === 'busy' ? 'bg-amber-500' : 'bg-slate-300';
  return <span className={`inline-block h-2 w-2 rounded-full ${c}`} title={status} aria-label={status} />;
}

export default function TownHallPage() {
  const { projectKey } = useParams<{ projectKey?: string }>();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [channelId, setChannelId] = useState<string | null>(null);
  // Issue pages deep-link here as /town-hall?topic=<id> — honor it on mount.
  const [topicId, setTopicId] = useState<string | null>(() => searchParams.get('topic'));
  const [newTopic, setNewTopic] = useState(false);
  const [post, setPost] = useState('');
  const [postAct, setPostAct] = useState('critique');
  const [resolveText, setResolveText] = useState('');
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [inspectReceiptId, setInspectReceiptId] = useState<string | null>(null);

  const channels = useQuery({
    queryKey: ['town-hall-channels', projectKey ?? ''],
    queryFn: () => fetchTownHallChannels(projectKey),
    refetchInterval: 30_000,
  });
  const channelList = channels.data?.channels ?? [];
  const activeChannel = channelId
    ? channelList.find((c) => c.id === channelId)
    : (channelList.find((c) => c.slug === 'town-hall' && (projectKey ? c.projectKey === projectKey : c.projectKey === null)) ?? channelList[0]);

  const topics = useQuery({
    queryKey: ['town-hall-topics', activeChannel?.id ?? 'none'],
    queryFn: () => fetchTownHallTopics({ channel: activeChannel!.id, limit: 50 }),
    enabled: Boolean(activeChannel),
    refetchInterval: 15_000,
  });
  const detail = useQuery({
    queryKey: ['town-hall-topic', topicId],
    queryFn: () => fetchTownHallTopic(topicId!),
    enabled: Boolean(topicId),
    refetchInterval: 10_000,
  });
  const roster = useQuery({
    queryKey: ['agent-roster', projectKey ?? ''],
    queryFn: () => fetchAgentRoster(projectKey ? { project: projectKey } : undefined),
    refetchInterval: 30_000,
  });
  const fleet = useQuery({
    queryKey: ['fleet-sessions', projectKey ?? ''],
    // 072 — session history is the default now; this rail is the LIVE view.
    queryFn: () => fetchFleetSessions(projectKey ? { project: projectKey, activeOnly: true } : { activeOnly: true }),
    refetchInterval: 30_000,
  });
  const pause = useQuery({
    queryKey: ['fleet-pause', projectKey ?? ''],
    queryFn: () => fetchFleetPause(projectKey),
    refetchInterval: 30_000,
  });
  // 072 — mission control: outbox + runner health strip (FR-015).
  const health = useQuery({ queryKey: ['fleet-health'], queryFn: fetchFleetHealth, refetchInterval: 15_000 });
  const metrics = useQuery({ queryKey: ['fleet-metrics'], queryFn: fetchFleetMetrics, refetchInterval: 30_000 });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['town-hall-topics'] });
    if (topicId) qc.invalidateQueries({ queryKey: ['town-hall-topic', topicId] });
  };
  const openMut = useMutation({
    mutationFn: openTownHallTopic,
    onSuccess: (r) => {
      setTopicId(r.topic.id);
      setNewTopic(false);
      invalidate();
    },
  });
  const postMut = useMutation({ mutationFn: (b: Parameters<typeof postToTownHallTopic>[1]) => postToTownHallTopic(topicId!, b), onSuccess: invalidate });
  const stanceMut = useMutation({ mutationFn: (b: { stance: 'endorse' | 'object' | 'abstain'; reason?: string }) => putTownHallStance(topicId!, b), onSuccess: invalidate });
  const resolveMut = useMutation({ mutationFn: (b: Parameters<typeof resolveTownHallTopic>[1]) => resolveTownHallTopic(topicId!, b), onSuccess: invalidate });
  const pauseMut = useMutation({
    mutationFn: (paused: boolean) => setProjectFleetPause(projectKey!, paused),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet-pause'] }),
  });
  const breakMut = useMutation({ mutationFn: (key: string) => breakIssueLease(key), onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet-sessions'] }) });

  const d = detail.data;
  const objectStance = useMemo(() => d?.stances.find((s) => s.stance === 'object' && !s.resolved), [d]);

  return (
    <div className="flex h-full flex-col">
      {/* header strip — fleet presence + brake */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="text-lg font-semibold text-slate-900">Town Hall</h1>
        {projectKey && <span className="text-xs font-medium text-slate-500">{projectKey}</span>}
        {health.data && (
          <span
            className={`ml-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              health.data.status === 'degraded' ? 'bg-red-100 text-red-700' : 'bg-emerald-50 text-emerald-700'
            }`}
            title={
              health.data.status === 'degraded'
                ? `Runner ${health.data.runner.mode}${health.data.runner.lastError ? ` — ${health.data.runner.lastError}` : ''} · ${health.data.outbox.deadLettered} dead-lettered · ${health.data.outbox.undispatched} undispatched`
                : `Runner ${health.data.runner.mode} · outbox clear`
            }
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${health.data.status === 'degraded' ? 'bg-red-500' : 'bg-emerald-500'}`} />
            {health.data.status === 'degraded' ? 'degraded' : 'ok'}
            {metrics.data && metrics.data.fleet.waitlistDepth > 0 && (
              <span className="text-slate-500">· {metrics.data.fleet.waitlistDepth} queued</span>
            )}
            {metrics.data && metrics.data.fleet.activeLocks > 0 && (
              <span className="text-slate-500">· {metrics.data.fleet.activeLocks} locks</span>
            )}
          </span>
        )}
        <div className="ml-2 flex items-center gap-2 overflow-x-auto">
          {(roster.data?.agents ?? []).slice(0, 12).map((a) => (
            <span key={a.accountId} className="flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-700" title={`${a.displayName} — ${a.role}, ${a.activeLeases}/${a.maxConcurrentLeases} leases`}>
              <PresenceDot status={a.status} />
              <OverflowText text={a.displayName} className="max-w-24 truncate" />
              <span className="text-slate-400">{a.activeLeases}/{a.maxConcurrentLeases}</span>
            </span>
          ))}
          <span className="text-xs text-slate-400">{(roster.data?.agents ?? []).length} agents</span>
        </div>
        {projectKey && (
          <button
            onClick={() => pauseMut.mutate(!pause.data?.paused)}
            className={`ml-auto rounded px-3 py-1 text-xs font-medium ${pause.data?.paused ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}
            title={pause.data?.paused ? 'Resume the project fleet' : 'Pause all agent writes in this project'}
          >
            {pause.data?.paused ? 'Resume fleet' : 'Pause fleet'}
          </button>
        )}
      </div>
      {pause.data?.paused && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
          Fleet paused{pause.data.project.reason ? `: ${pause.data.project.reason}` : pause.data.global.reason ? `: ${pause.data.global.reason}` : ''} — agent writes return 423; heartbeats and reads stay open.
        </div>
      )}
      {health.data?.status === 'degraded' && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-800">
          Event fabric degraded — runner in {health.data.runner.mode} mode
          {health.data.outbox.deadLettered > 0 ? `, ${health.data.outbox.deadLettered} dead-lettered` : ''}
          {health.data.outbox.undispatched > 0 ? `, ${health.data.outbox.undispatched} undispatched` : ''}. Wake-ups and inbox delivery may lag.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* channels rail */}
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Channels</div>
          {channelList.map((c: TownHallChannel) => (
            <button
              key={c.id}
              onClick={() => { setChannelId(c.id); setTopicId(null); }}
              className={`mb-1 block w-full rounded px-2 py-1.5 text-left text-sm ${activeChannel?.id === c.id ? 'bg-indigo-100 font-medium text-indigo-800' : 'text-slate-700 hover:bg-slate-100'}`}
            >
              # <OverflowText text={c.slug} />
              {c.projectKey && <span className="ml-1 text-xs text-slate-400">{c.projectKey}</span>}
              {c.openTopics ? <span className="ml-1 text-xs text-slate-400">({c.openTopics})</span> : null}
            </button>
          ))}
          {activeChannel && (
            <button onClick={() => setNewTopic(true)} className="mt-3 w-full rounded bg-indigo-600 px-2 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
              + Open topic
            </button>
          )}
          {projectKey && (fleet.data?.sessions ?? []).length > 0 && (
            <>
              <div className="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Live leases</div>
              {fleet.data!.sessions.slice(0, 15).map((s) => (
                <div key={s.sessionId} className="mb-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                  <div className="flex items-center justify-between">
                    <Link to={`/browse/${s.issueKey}`} className="font-medium text-indigo-600 hover:underline">{s.issueKey}</Link>
                    <span className={`rounded px-1 text-[10px] ${s.role === 'driver' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>{s.role}</span>
                  </div>
                  <OverflowText text={s.agent.displayName} className="text-slate-500" />
                  {s.driftStatus && s.driftStatus !== 'untracked' && s.driftStatus !== 'clean' && (
                    <span className="mt-0.5 inline-block rounded bg-red-100 px-1 text-[10px] font-medium text-red-700" title={`Drift: ${s.driftStatus}`}>
                      {s.driftStatus.replace(/_/g, ' ')}
                    </span>
                  )}
                  {s.role === 'driver' && (
                    <button onClick={() => breakMut.mutate(s.issueKey)} className="mt-0.5 text-[10px] text-red-600 hover:underline" title="Break this lease — the agent's writes will 409">
                      break lease
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </aside>

        {/* topics feed */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {!topicId ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">#{activeChannel?.slug ?? '…'} — open deliberations</h2>
              </div>
              {newTopic && <NewTopicForm channelId={activeChannel!.id} onSubmit={(b) => openMut.mutate(b)} onCancel={() => setNewTopic(false)} busy={openMut.isPending} />}
              {(topics.data?.topics ?? []).map((t: TownHallTopic) => (
                <button key={t.id} onClick={() => setTopicId(t.id)} className="mb-2 block w-full rounded border border-slate-200 bg-white p-3 text-left hover:border-indigo-300">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${KIND_COLORS[t.kind] ?? 'bg-slate-100 text-slate-600'}`}>{t.kind}</span>
                    <OverflowText text={t.title} className="flex-1 font-medium text-slate-900" />
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${t.status === 'decided' ? 'bg-emerald-100 text-emerald-700' : t.status === 'voting' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{t.status}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                    <span>
                      {t.author?.displayName ?? '?'}
                      {t.author?.agent && <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-medium text-violet-700">agent</span>}
                    </span>
                    <span>{t.postCount} posts</span>
                    {t.tally && <span>+{t.tally.endorse}/−{t.tally.object}{t.tally.quorumMet ? ' · quorum' : ''}</span>}
                    {t.requiredRoles.length > 0 && <span>needs: {t.requiredRoles.join(', ')}</span>}
                  </div>
                </button>
              ))}
              {topics.data?.topics.length === 0 && <div className="py-8 text-center text-sm text-slate-400">No topics yet — open the first deliberation.</div>}
            </>
          ) : d ? (
            <div>
              <button onClick={() => setTopicId(null)} className="mb-2 text-xs text-indigo-600 hover:underline">← back to feed</button>
              <div className="rounded border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${KIND_COLORS[d.topic.kind] ?? ''}`}>{d.topic.kind}</span>
                  <h2 className="flex-1 text-base font-semibold text-slate-900">{d.topic.title}</h2>
                  <span className="text-xs text-slate-500">{d.topic.status}</span>
                </div>
                {d.linkedIssues.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1 text-xs">
                    {d.linkedIssues.map((i) => (
                      <Link key={i.key + i.relation} to={`/browse/${i.key}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-indigo-600 hover:underline" title={`${i.summary} (${i.status}) — ${i.relation}`}>
                        {i.key} ({i.status}{i.receiptCount ? ` · ${i.receiptCount} proof${i.receiptCount > 1 ? 's' : ''}` : ''})
                      </Link>
                    ))}
                  </div>
                )}
                {/* stances + tally */}
                <div className="mt-3 flex items-center gap-2 text-sm">
                  <button onClick={() => stanceMut.mutate({ stance: 'endorse' })} className="rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-200">endorse ({d.tally.endorse})</button>
                  <button
                    onClick={() => {
                      const reason = window.prompt('Cite your objection (10–2000 chars) — evidence or counterexample required:');
                      if (reason) stanceMut.mutate({ stance: 'object', reason });
                    }}
                    className="rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                  >
                    object ({d.tally.object})
                  </button>
                  <button onClick={() => stanceMut.mutate({ stance: 'abstain' })} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">abstain ({d.tally.abstain})</button>
                  <span className={`ml-auto text-xs font-medium ${d.tally.quorumMet ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {d.tally.quorumMet ? '✓ quorum met' : `quorum ${d.tally.endorse}/${d.topic.quorumRequired}${d.tally.object ? ' +open objections' : ''}`}
                  </span>
                </div>
                {objectStance && (
                  <div className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                    Open objection by {objectStance.actor.displayName}: {objectStance.reason}
                  </div>
                )}

                {/* posts */}
                <div className="mt-4 space-y-2">
                  {d.posts.map((p) => (
                    <div key={p.id} className={`border-l-4 pl-3 ${ACT_COLORS[p.speechAct] ?? 'border-slate-200'} ${p.speechAct === 'decision' ? 'rounded border px-3 py-2' : ''}`} style={{ marginLeft: p.parentId ? 20 : 0 }}>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className="font-semibold uppercase text-slate-600">{p.speechAct}</span>
                        <span>
                          {p.author?.displayName ?? '?'}
                          {p.author?.agent && <span className="rounded bg-violet-100 px-1 text-[10px] font-medium text-violet-700">agent</span>}
                        </span>
                        <span>{new Date(p.createdAt).toLocaleString()}</span>
                        {p.speechAct !== 'decision' && d.topic.status !== 'decided' && (
                          <button onClick={() => setReplyTo(replyTo === p.id ? null : p.id)} className="text-indigo-500 hover:underline">reply</button>
                        )}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-sm text-slate-800">{p.body}</div>
                      {p.receipts && p.receipts.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {p.receipts.map((r) => (
                            <button
                              key={r.id}
                              type="button"
                              onClick={() => setInspectReceiptId(r.id)}
                              title={`Inspect ${r.kind} evidence artifact: ${r.summary}`}
                              className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
                            >
                              <span className="font-mono uppercase">{r.kind}</span>
                              <span className="font-mono text-[10px] opacity-75">{r.sha256.slice(0, 8)}</span>
                              <span>({r.verification.replace(/_/g, ' ')})</span>
                              <span className="underline">Inspect</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {replyTo === p.id && (
                        <PostComposer
                          label={`Reply as ${postAct}`}
                          onSubmit={(body, act) => { postMut.mutate({ speechAct: act, body, parentId: p.id }); setReplyTo(null); }}
                          act={postAct} setAct={setPostAct} body={post} setBody={setPost}
                        />
                      )}
                    </div>
                  ))}
                </div>

                {/* composer */}
                {d.topic.status !== 'decided' && d.topic.status !== 'archived' && (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <PostComposer label="Post" onSubmit={(body, act) => postMut.mutate({ speechAct: act, body })} act={postAct} setAct={setPostAct} body={post} setBody={setPost} />
                  </div>
                )}

                {/* resolve */}
                {d.topic.status !== 'decided' && (
                  <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs font-semibold uppercase text-slate-500">Resolve</div>
                    <textarea
                      value={resolveText}
                      onChange={(e) => setResolveText(e.target.value)}
                      placeholder="Binding decision summary — what was decided and why…"
                      className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
                      rows={2}
                    />
                    <button
                      onClick={() => resolveText.trim() && resolveMut.mutate({ decisionSummary: resolveText, overrideObjections: Boolean(objectStance) && window.confirm(`Override ${d.tally.object} open objection(s)?`) })}
                      disabled={!resolveText.trim() || resolveMut.isPending}
                      className="mt-1 rounded bg-slate-800 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                      title="Record the binding decision and close the topic (DAG compilation is available via the town_hall MCP tool)"
                    >
                      {d.tally.object ? 'Override objections & resolve' : 'Resolve topic'}
                    </button>
                  </div>
                )}
                {d.topic.status === 'decided' && d.topic.decisionSummary && (
                  <div className="mt-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                    <div className="text-xs font-semibold uppercase">Decision — {d.topic.resolvedBy}</div>
                    <div className="mt-1 whitespace-pre-wrap">{d.topic.decisionSummary}</div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-slate-400">Loading topic…</div>
          )}
        </main>
      </div>
      <ReceiptInspectorDrawer receiptId={inspectReceiptId} onClose={() => setInspectReceiptId(null)} />
    </div>
  );
}

function PostComposer({
  label, onSubmit, act, setAct, body, setBody,
}: {
  label: string;
  onSubmit: (body: string, act: string) => void;
  act: string;
  setAct: (s: string) => void;
  body: string;
  setBody: (s: string) => void;
}) {
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {['proposal', 'critique', 'evidence', 'question', 'answer', 'synthesis'].map((a) => (
          <button key={a} onClick={() => setAct(a)} className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${act === a ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
            {a}
          </button>
        ))}
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={`${label} — [@role:skill] summons experts, [~accountId:id] mentions a specific agent…`} className="mt-1 w-full rounded border border-slate-300 p-2 text-sm" rows={2} />
      <button onClick={() => body.trim() && onSubmit(body, act)} disabled={!body.trim()} className="mt-1 rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
        {label}
      </button>
    </div>
  );
}

function NewTopicForm({ channelId, onSubmit, onCancel, busy }: {
  channelId: string;
  onSubmit: (b: { channelId: string; title: string; body: string; kind: string; quorumRequired?: number; requiredRoles?: string[]; linkedIssueKeys?: string[] }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('rfc');
  const [roles, setRoles] = useState('');
  const [links, setLinks] = useState('');
  return (
    <div className="mb-3 rounded border border-indigo-200 bg-indigo-50/50 p-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Topic title — the proposal in one line" className="w-full rounded border border-slate-300 p-2 text-sm font-medium" />
      <div className="mt-2 flex gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-xs">
          {['rfc', 'discovery', 'blocker', 'incident', 'standup'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="required roles (comma-sep, e.g. reviewer,prisma)" className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs" />
        <input value={links} onChange={(e) => setLinks(e.target.value)} placeholder="linked issues (TF-1, TF-2)" className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs" />
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Opening speech act — state the proposal, question or evidence…" className="mt-2 w-full rounded border border-slate-300 p-2 text-sm" rows={3} />
      <div className="mt-1 flex gap-2">
        <button
          onClick={() => title.trim() && body.trim() && onSubmit({
            channelId, title: title.trim(), body: body.trim(), kind,
            requiredRoles: roles.split(',').map((s) => s.trim()).filter(Boolean),
            linkedIssueKeys: links.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
          })}
          disabled={!title.trim() || !body.trim() || busy}
          className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          Open topic
        </button>
        <button onClick={onCancel} className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-600">Cancel</button>
      </div>
    </div>
  );
}
