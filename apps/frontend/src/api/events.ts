// Live updates — /api/internal/events/stream (SSE). Each event invalidates
// the TanStack caches it touches: the issue itself, lists/boards carrying it,
// and the notification badge. Resume happens automatically via Last-Event-ID
// (EventSource tracks the last `id:` line across reconnects).

import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { markIssueWrite } from '../lib/issueWrites.js';
import type { TfEvent, Myself, Board } from './client.js';

// ---------- scoped, debounced invalidation ----------

// Broad list queries carry a scope we can compare against the event's
// projectKey: board-issues/sprints/backlog keys hold a board id or project
// key, navigator `issues` keys hold a JQL that may pin `project = X`. Events
// whose project provably doesn't touch a query skip its refetch; anything
// unresolvable still invalidates (safe default).

/** boardId → projectKey, built from boards already in the cache. */
function boardProjectMap(qc: QueryClient): Map<string, string> {
  const map = new Map<string, string>();
  const add = (b: unknown) => {
    const board = b as Partial<Board> | null;
    if (board?.id && board.location?.projectKey) map.set(board.id, board.location.projectKey);
  };
  for (const [, data] of qc.getQueriesData({ queryKey: ['board'] })) add(data);
  for (const [, data] of qc.getQueriesData({ queryKey: ['boards'] })) {
    if (Array.isArray(data)) data.forEach(add);
  }
  return map;
}

const PROJECT_KEYISH = /^[A-Z][A-Z0-9_]{1,9}$/;
const JQL_PROJECT = /project\s*=\s*"?([A-Za-z0-9_]+)"?/i;

function touchesProjects(queryKey: readonly unknown[], projects: Set<string>, boardMap: Map<string, string>): boolean {
  if (!projects.size) return true;
  for (const el of queryKey.slice(1)) {
    if (typeof el !== 'string' || !el) continue;
    const pk = boardMap.get(el) ?? (PROJECT_KEYISH.test(el) ? el : null);
    if (pk) return projects.has(pk);
    const jql = JQL_PROJECT.exec(el);
    if (jql) return projects.has(jql[1].toUpperCase());
  }
  return true;
}

type BroadKind = 'issues' | 'board-issues' | 'notifications' | 'mywork' | 'board-config' | 'sprints' | 'backlog';

export function useEventStream(opts?: { onIssueEvent?: (ev: TfEvent) => void }) {
  const qc = useQueryClient();
  const handler = useRef(opts?.onIssueEvent);
  handler.current = opts?.onIssueEvent;

  useEffect(() => {
    // Coalesce bursts (bulk ops, agent loops): broad list invalidations queue
    // per-kind and flush once on a short trailing edge instead of refetching
    // every list on every event.
    const pending = new Map<BroadKind, { global: boolean; projects: Set<string> }>();
    let flushAt: number | undefined;
    const queue = (kind: BroadKind, ev: TfEvent) => {
      const slot = pending.get(kind) ?? { global: false, projects: new Set<string>() };
      if (ev.projectKey) slot.projects.add(ev.projectKey.toUpperCase());
      else slot.global = true;
      pending.set(kind, slot);
      if (flushAt !== undefined) return;
      flushAt = window.setTimeout(() => {
        flushAt = undefined;
        const boardMap = boardProjectMap(qc);
        for (const [kind, scope] of pending) {
          if (scope.global) {
            qc.invalidateQueries({ queryKey: [kind] });
          } else {
            qc.invalidateQueries({
              queryKey: [kind],
              predicate: (q) => touchesProjects(q.queryKey, scope.projects, boardMap),
            });
          }
        }
        pending.clear();
      }, 300);
    };

    const es = new EventSource('/api/internal/events/stream');
    es.addEventListener('tf-event', (m) => {
      let ev: TfEvent;
      try {
        ev = JSON.parse((m as MessageEvent).data);
      } catch {
        return;
      }
      if (ev.issueKey) {
        // Own writes echo back over the stream — mark them so the issue view's
        // "updated elsewhere" detector doesn't flag the user's own edit.
        const me = qc.getQueryData<Myself>(['myself']);
        if (me?.accountId && ev.actor?.accountId === me.accountId) markIssueWrite(ev.issueKey);
        qc.invalidateQueries({ queryKey: ['issue', ev.issueKey] });
        qc.invalidateQueries({ queryKey: ['comments', ev.issueKey] });
        qc.invalidateQueries({ queryKey: ['watchers', ev.issueKey] });
        handler.current?.(ev);
      }
      queue('board-issues', ev);
      queue('issues', ev);
      queue('notifications', ev);
      queue('mywork', ev);
      if (ev.type === 'board_configuration_changed') {
        queue('board-config', ev);
      }
      if (ev.type.startsWith('sprint_')) {
        queue('sprints', ev);
        queue('backlog', ev);
      }
      // 047 — agent session/question events carry issueKey in the payload.
      if (ev.issueKey && (ev.type.startsWith('agent_session.') || ev.type.startsWith('agent_question.'))) {
        qc.invalidateQueries({ queryKey: ['agent-sessions', ev.issueKey] });
        qc.invalidateQueries({ queryKey: ['agent-questions', ev.issueKey] });
        // 058 US5 — board/backlog badge map follows live agent state.
        qc.invalidateQueries({ queryKey: ['agent-activity'] });
      }
      // Proposal create/resolve events carry issueKey too — refresh the
      // issue-page review panel and any open approvals inbox.
      if (ev.type.startsWith('proposal_')) {
        qc.invalidateQueries({ queryKey: ['proposals'] });
        if (ev.issueKey) qc.invalidateQueries({ queryKey: ['issue-proposals', ev.issueKey] });
      }
    });
    // 047 US5-3 — ephemeral ai.progress frames land in a query slot the
    // palette/intelligence UIs read while their request is in flight.
    es.addEventListener('tf-progress', (m) => {
      try {
        const d = JSON.parse((m as MessageEvent).data) as { feature?: string; step?: string };
        if (d.feature) qc.setQueryData(['ai-progress', d.feature], { step: d.step, at: Date.now() });
      } catch {
        /* malformed frame */
      }
    });
    return () => {
      if (flushAt !== undefined) window.clearTimeout(flushAt);
      es.close();
    };
  }, [qc]);
}
