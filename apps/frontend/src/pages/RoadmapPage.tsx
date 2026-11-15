/**
 * Sprint 041: Roadmap & Gantt — one surface, two levels.
 * level=epics : Jira roadmap — epic bars, child-rollup progress, version pins,
 *               Blocks arrows, unscheduled ghost bars.
 * level=issues: BigPicture-style Gantt — every issue row, parent tree with
 *               expand/collapse, per-type arrows, critical-path highlight,
 *               drag-link creation.
 * All scheduling writes go through PUT /issue (FR-001 — the view is an API
 * client, never a backdoor). Row virtualization for 2k+ rows.
 */
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  fetchRoadmap, fetchBoards, fetchSprints, updateIssueFields, linkIssues, linkIssuesById, unlinkIssue,
  type RoadmapRow, type RoadmapData,
} from '../api/client.js';
import EmptyState from '../components/EmptyState.js';
import SelectMenu from '../components/SelectMenu.js';
import IssueKey from '../components/IssueKey.js';
import IssueDrawer from '../components/IssueDrawer.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { parseDate } from '../lib/format.js';
import { CHART, SVG } from '../lib/palette.js';

const DAY = 86400_000;
const ROW_H = 32;
const TREE_W = 264;
const PX_PER_DAY: Record<string, number> = { day: 36, week: 14, month: 6, quarter: 2 };
const day = (iso: string) => Math.floor(parseDate(iso).getTime() / DAY);
const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const today = () => Math.floor(Date.now() / DAY);

/** Longest outward-link chain ending at the latest-due row (cycle-capped). */
function criticalPath(rows: RoadmapRow[]): Set<string> {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const edges = new Map<string, string[]>();
  for (const r of rows) for (const l of r.links) if (l.direction === 'outward' && byKey.has(l.key)) {
    edges.set(r.key, [...(edges.get(r.key) ?? []), l.key]);
  }
  let best = 0;
  const memo = new Map<string, number>();
  const depth = (k: string, seen: Set<string>): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (seen.has(k)) return 0; // cycle — cap traversal
    seen.add(k);
    let d = 0;
    for (const n of edges.get(k) ?? []) d = Math.max(d, 1 + depth(n, seen));
    seen.delete(k);
    memo.set(k, d);
    best = Math.max(best, d);
    return d;
  };
  for (const r of rows) depth(r.key, new Set());
  // rebuild the winning chain from any node whose depth == best
  const path = new Set<string>();
  const start = rows.find((r) => memo.get(r.key) === best);
  if (start && best > 0) {
    let curKey: string | undefined = start.key;
    while (curKey) {
      path.add(curKey);
      const curDepth: number = memo.get(curKey) ?? 0;
      const nxt: string | undefined = (edges.get(curKey) ?? []).find((k): boolean => memo.get(k) === curDepth - 1);
      curKey = nxt;
    }
  }
  return path;
}

interface Drag {
  key: string; mode: 'move' | 'l' | 'r' | 'link' | 'pan';
  /** link-mode: 'out' = source blocks target (right dot), 'in' = source is
   *  blocked by target (left dot). */
  dir?: 'out' | 'in';
  startX: number; startY: number; oStart: number; oDue: number; dx: number; dropKey?: string;
  /** client coords at pointerup — positions the link-type menu (A4). */
  dropX?: number; dropY?: number;
  /** link-mode: source anchor + live pointer position in rows-pane content coords. */
  ax: number; ay: number; cx: number; cy: number;
  /** link-mode: last pointer position in client coords — lets scroll events
   *  re-anchor the connector while the cursor stays still. */
  pcx?: number; pcy?: number;
  /** pan-mode: scroll position at drag start. */
  oScrollL?: number; oScrollT?: number;
  /** move-mode: Shift held at press → shift dependent issues by the same delta (Jira cascade). */
  cascade?: boolean;
}

const ZOOM_ORDER = ['day', 'week', 'month', 'quarter'];
const fmtDay = (d: number) =>
  new Date(d * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Ctrl+Z stack — inverse ops for drags/links performed on this surface. */
type LaneHeader = { _header: true; id: string; label: string; count: number };
type DisplayItem = (RoadmapRow & { _depth?: number }) | LaneHeader;

type UndoOp =
  | { kind: 'schedule'; key: string; prevStart: string | null; prevDue: string | null }
  | { kind: 'schedule-batch'; items: { key: string; prevStart: string | null; prevDue: string | null }[] }
  | { kind: 'link'; linkId: string }
  | { kind: 'unlink'; typeId: string; outward: string; inward: string }
  // F23 scenario drafts — never hit the API
  | { kind: 'draft-schedule'; key: string; prev: { start: number | null; due: number | null } | undefined }
  | { kind: 'draft-unlink' };

type DraftDates = { start: number | null; due: number | null };
type DraftLink = { type: string; outward: string; inward: string };

export default function RoadmapPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const boardRef = searchParams.get('board') ?? projectKey!;
  const level = searchParams.get('level') === 'issues' ? 'issues' : 'epics';
  const zoom = searchParams.get('zoom') ?? 'month';
  const [showCritical, setShowCritical] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [unscheduledOnly, setUnscheduledOnly] = useState(false);
  // a real drag must not trigger the click→drawer open that follows pointerup
  const suppressClick = useRef(false);
  const openIssue = (key: string) =>
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('selectedIssue', key); return n; }, { replace: true });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => {
    if (!linkError) return;
    const t = window.setTimeout(() => setLinkError(null), 6_000);
    return () => window.clearTimeout(t);
  }, [linkError]);
  const [vpH, setVpH] = useState(560);
  const [paneW, setPaneW] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  // clicked dependency arrow → detail popover (Jira: select line → view/remove)
  const [linkSel, setLinkSel] = useState<{ x: number; y: number; from: string; to: string; type: string; typeId: string; id: string } | null>(null);
  // link drop → pick a type before creating (Jira asks what relationship)
  const [pendingLink, setPendingLink] = useState<{ x: number; y: number; source: string; target: string; dir: 'in' | 'out' } | null>(null);
  const zoomAnchor = useRef<{ day: number; offX: number } | null>(null);
  const undoStack = useRef<UndoOp[]>([]);
  const [colorBy, setColorBy] = useState<'type' | 'status'>('type');
  // D15 — swimlanes: group the tree into lanes by a row field
  const [groupBy, setGroupBy] = useState<'none' | 'assignee' | 'status'>('none');
  // F21 — when on, moving a bar pushes successors whose start is violated
  const [autoSchedule, setAutoSchedule] = useState(false);
  // F23 — scenario mode: non-null Map = active; drags write drafts, not the API
  const [scenario, setScenario] = useState<Map<string, DraftDates> | null>(null);
  // ref mirror so `commit` reads the current map without re-subscribing
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const [draftLinks, setDraftLinks] = useState<DraftLink[]>([]);
  const scenarioChanges = (scenario?.size ?? 0) + draftLinks.length;
  // F20 — baseline snapshot (client-side MVP): {key → planned s/e} per board
  const [baseline, setBaseline] = useState<{ savedAt: string; items: Record<string, { s: number | null; e: number | null }> } | null>(null);
  const [showBaseline, setShowBaseline] = useState(false);
  useEffect(() => {
    try { setBaseline(JSON.parse(localStorage.getItem(`tf-roadmap-baseline:${boardRef}`) ?? 'null')); }
    catch { setBaseline(null); }
    setShowBaseline(false);
  }, [boardRef]);

  const pushUndo = (op: UndoOp) => {
    undoStack.current.push(op);
    if (undoStack.current.length > 50) undoStack.current.shift();
  };

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => { setVpH(el.clientHeight); setPaneW(el.clientWidth); };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const { data: boards } = useQuery({ queryKey: ['boards', projectKey], queryFn: () => fetchBoards(projectKey!), enabled: !!projectKey });
  const { data } = useQuery<RoadmapData>({
    queryKey: ['roadmap', boardRef, level],
    queryFn: () => fetchRoadmap(boardRef, { level }),
    enabled: !!boardRef,
  });
  // F22 — sprint boundary markers for the board's open sprints
  const { data: sprints } = useQuery({
    queryKey: ['sprints', boardRef],
    queryFn: () => fetchSprints(boardRef, ['active', 'future']),
    enabled: !!boardRef,
  });
  const board = boards?.find((b) => b.id === (searchParams.get('board') ?? '')) ?? boards?.[0];
  // 058 US6 — read-only viewers can pan/zoom but never drag bars or links.
  const { can } = usePermissions({ projectKey }, ['SCHEDULE_ISSUES', 'EDIT_ISSUES', 'LINK_ISSUES']);
  const canSchedule = can('SCHEDULE_ISSUES') || can('EDIT_ISSUES');
  const canLink = can('LINK_ISSUES');

  const px = PX_PER_DAY[zoom] ?? PX_PER_DAY.month;
  const rows = useMemo(() => (level === 'issues' ? data?.issues ?? [] : data?.epics ?? []), [data, level]);

  // search filter — keep matches plus their ancestors so context isn't lost
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    let base = rows;
    if (q) {
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const keep = new Set<string>();
      for (const r of rows) {
        if (!r.key.toLowerCase().includes(q) && !r.summary.toLowerCase().includes(q)) continue;
        let cur: RoadmapRow | undefined = r;
        while (cur && !keep.has(cur.key)) {
          keep.add(cur.key);
          cur = cur.parent ? byKey.get(cur.parent) : undefined;
        }
      }
      base = rows.filter((r) => keep.has(r.key));
    }
    // unscheduled view = flat "to schedule" list — ancestors aren't needed
    if (unscheduledOnly) base = base.filter((r) => !r.start && !r.due);
    return base;
  }, [rows, q, unscheduledOnly]);

  // tree order + collapse (issues level): parent rows first, children nested.
  // Search auto-expands so matches are always visible.
  const tree = useMemo(() => {
    if (level !== 'issues') return filtered;
    const byParent = new Map<string | null, RoadmapRow[]>();
    for (const r of filtered) byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), r]);
    const out: RoadmapRow[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null, depth: number) => {
      for (const r of byParent.get(parent) ?? []) {
        seen.add(r.key);
        out.push({ ...r, _depth: depth } as RoadmapRow & { _depth: number });
        if (q || unscheduledOnly || !collapsed.has(r.key)) walk(r.key, depth + 1);
      }
    };
    walk(null, 0);
    // orphans whose parents aren't on screen
    for (const r of filtered) if (!seen.has(r.key) && (q || unscheduledOnly || !collapsed.has(r.parent ?? ''))) out.push(r);
    return out;
  }, [filtered, level, collapsed, q, unscheduledOnly]);

  const hasKids = useMemo(() => new Set(filtered.filter((r) => filtered.some((c) => c.parent === r.key)).map((r) => r.key)), [filtered]);
  const crit = useMemo(() => (showCritical && level === 'issues' ? criticalPath(filtered) : new Set<string>()), [showCritical, filtered, level]);

  // D15 — display list = real rows interleaved with lane headers when
  // grouping. keyIdx/virtualization run over `display`; commit/undo/arrows
  // stay on `tree` (real rows only).
  const display = useMemo<DisplayItem[]>(() => {
    if (groupBy === 'none' || level !== 'issues') return tree;
    const laneOf = (r: RoadmapRow) => (groupBy === 'assignee' ? r.assignee ?? 'Unassigned' : r.status.name);
    const lanes = new Map<string, RoadmapRow[]>();
    for (const r of tree) {
      const k = laneOf(r);
      lanes.set(k, [...(lanes.get(k) ?? []), r]);
    }
    const out: DisplayItem[] = [];
    for (const [label, items] of lanes) {
      out.push({ _header: true, id: `lane-${label}`, label, count: items.length });
      out.push(...items);
    }
    return out;
  }, [tree, groupBy, level]);
  const keyIdx = useMemo(() => new Map(display.map((r, i) => [('_header' in r ? r.id : r.key), i])), [display]);

  const t0 = useMemo(() => {
    const dates = rows.flatMap((r) => [r.start, r.due]).filter(Boolean).map((s) => day(s!));
    const t = today();
    return Math.min(...dates, t) - 14;
  }, [rows]);
  const t1 = useMemo(() => {
    const dates = rows.flatMap((r) => [r.start, r.due]).filter(Boolean).map((s) => day(s!));
    return Math.max(...dates, today()) + 30;
  }, [rows]);
  const x = (d: number) => (d - t0) * px;
  const width = Math.max((t1 - t0) * px, paneW);

  // F20 — capture the current plan as the comparison baseline
  const saveBaseline = () => {
    const items: Record<string, { s: number | null; e: number | null }> = {};
    for (const r of rows) {
      if (!r.start && !r.due) continue;
      items[r.key] = { s: r.start ? day(r.start) : null, e: r.due ? day(r.due) : null };
    }
    const b = { savedAt: new Date().toISOString(), items };
    localStorage.setItem(`tf-roadmap-baseline:${boardRef}`, JSON.stringify(b));
    setBaseline(b);
    setShowBaseline(true);
  };

  // weekend stripes across the visible range (B6)
  const weekends = useMemo(() => {
    const spans: { s: number; e: number }[] = [];
    for (let d = t0; d <= t1; d++) {
      const wd = new Date(d * DAY).getDay();
      if (wd !== 0 && wd !== 6) continue;
      const last = spans[spans.length - 1];
      if (last && last.e === d - 1) last.e = d;
      else spans.push({ s: d, e: d });
    }
    return spans;
  }, [t0, t1]);

  // header health summary (E19) — over the currently filtered rows
  const health = useMemo(() => {
    const byKey = new Map(filtered.map((r) => [r.key, r]));
    let overdue = 0, conflicts = 0, unscheduled = 0;
    for (const r of filtered) {
      if (r.due && day(r.due) < today() && r.status.category !== 'done') overdue++;
      if (!r.start && !r.due) unscheduled++;
      for (const l of r.links) {
        const pre = l.direction === 'inward' ? byKey.get(l.key) : undefined;
        if (pre?.due && r.start && day(pre.due) > day(r.start)) { conflicts++; break; }
      }
    }
    return { overdue, conflicts, unscheduled };
  }, [filtered]);

  // B9 — Shift-drag cascade: transitive dependents reached via outward
  // ("blocks") links shift by the same delta.
  const cascadeKeys = useMemo(() => {
    const out = new Set<string>();
    if (drag?.mode !== 'move' || !drag.cascade) return out;
    const adj = new Map<string, string[]>();
    for (const r of filtered)
      for (const l of r.links)
        if (l.direction === 'outward') adj.set(r.key, [...(adj.get(r.key) ?? []), l.key]);
    const queue = [drag.key];
    while (queue.length) {
      const k = queue.pop()!;
      for (const n of adj.get(k) ?? []) if (!out.has(n)) { out.add(n); queue.push(n); }
    }
    return out;
  }, [drag, filtered]);

  // Ctrl/Cmd+wheel zooms in/out anchored at the cursor's date (ClickUp pattern).
  // Native non-passive listener — ctrl+wheel is browser zoom by default and
  // React attaches passive handlers so preventDefault() requires this path.
  useEffect(() => {
    const p = paneRef.current;
    if (!p) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const offX = e.clientX - p.getBoundingClientRect().left;
      zoomAnchor.current = { day: t0 + (p.scrollLeft + offX) / px, offX };
      const i = ZOOM_ORDER.indexOf(zoom);
      const next = ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, i + (e.deltaY < 0 ? -1 : 1)))];
      if (next !== zoom) {
        setSearchParams((sp) => { sp.set('zoom', next); return sp; }, { replace: true });
      }
    };
    p.addEventListener('wheel', onWheel, { passive: false });
    return () => p.removeEventListener('wheel', onWheel);
  }, [zoom, t0, px, setSearchParams]);

  // keep the anchored date under the cursor after the zoom changes px/day
  useEffect(() => {
    const p = paneRef.current;
    if (!p || !zoomAnchor.current) return;
    const { day: anchorDay, offX } = zoomAnchor.current;
    zoomAnchor.current = null;
    p.scrollLeft = (anchorDay - t0) * px - offX;
  }, [zoom, t0, px]);

  const barRange = (r: RoadmapRow): { s: number; e: number; ghost: boolean } => {
    // F23 — a scenario draft overrides the persisted dates
    const draft = scenario?.get(r.key);
    if (draft) {
      if (draft.start !== null && draft.due !== null) return { s: draft.start, e: draft.due, ghost: false };
      if (draft.due !== null) return { s: draft.due - 13, e: draft.due, ghost: true };
      if (draft.start !== null) return { s: draft.start, e: draft.start + 13, ghost: true };
      return { s: today(), e: today() + 13, ghost: true };
    }
    if (drag?.key === r.key && drag.mode !== 'link') {
      const dDays = Math.round(drag.dx / px);
      if (drag.mode === 'move') return { s: drag.oStart + dDays, e: drag.oDue + dDays, ghost: false };
      if (drag.mode === 'l') return { s: Math.min(drag.oStart + dDays, drag.oDue), e: drag.oDue, ghost: false };
      return { s: drag.oStart, e: Math.max(drag.oStart, drag.oDue + dDays), ghost: false };
    }
    if (r.start && r.due) return { s: day(r.start), e: day(r.due), ghost: false };
    // 058 US6 — a lone due date anchors the bar's END; a lone start anchors
    // its START. Only a fully unscheduled row floats at today.
    if (r.due) return { s: day(r.due) - 13, e: day(r.due), ghost: true };
    if (r.start) return { s: day(r.start), e: day(r.start) + 13, ghost: true };
    return { s: today(), e: today() + 13, ghost: true };
  };

  const delLink = useMutation({
    mutationFn: (l: { id: string }) => unlinkIssue(l.id),
    onSuccess: () => {
      const sel = linkSel;
      if (sel) pushUndo({ kind: 'unlink', typeId: sel.typeId, outward: sel.from, inward: sel.to });
      setLinkSel(null);
      qc.invalidateQueries({ queryKey: ['roadmap'] });
      qc.invalidateQueries({ queryKey: ['issue'] });
    },
    onError: (e) => {
      setLinkSel(null);
      setLinkError(e instanceof Error ? e.message : 'Delete failed');
    },
  });

  const commit = useCallback((d: Drag) => {
    const dDays = Math.round(d.dx / px);
    // any real drag (or a link/pan press) must not open the issue drawer on the
    // click event that follows pointerup
    suppressClick.current = d.mode !== 'move' || dDays !== 0;
    if (d.mode === 'link') {
      if (d.dropKey && d.dropKey !== d.key) {
        // A4 — don't commit immediately: offer the relationship menu at the
        // drop point first (Jira's "blocks / is blocked by / relates to")
        setPendingLink({ x: d.dropX ?? 0, y: d.dropY ?? 0, source: d.key, target: d.dropKey, dir: d.dir ?? 'out' });
      }
      return;
    }
    if (!dDays || d.mode === 'pan') return;
    const r = tree.find((x) => x.key === d.key);
    if (!r) return;
    // milestones stay point-in-time: a move shifts the single date
    const milestone = (!r.start && r.due) || (r.start !== null && r.start === r.due);
    if (scenarioRef.current) {
      // F23 — record the draft instead of writing; milestones keep their
      // point-in-time shape (due only), everything else drafts both ends
      const prev = scenarioRef.current.get(d.key);
      const next: DraftDates = d.mode === 'move' && milestone
        ? { start: prev?.start ?? (r.start ? day(r.start) : null), due: d.oDue + dDays }
        : d.mode === 'l'
          ? { start: Math.min(d.oStart + dDays, d.oDue), due: prev?.due ?? (r.due ? day(r.due) : d.oDue) }
          : d.mode === 'r'
            ? { start: prev?.start ?? (r.start ? day(r.start) : d.oStart), due: Math.max(d.oStart, d.oDue + dDays) }
            : { start: d.oStart + dDays, due: d.oDue + dDays };
      setScenario((m) => (m ? new Map(m).set(d.key, next) : m));
      pushUndo({ kind: 'draft-schedule', key: d.key, prev });
      return;
    }
    if (d.mode === 'move' && milestone) {
      const day = d.oDue + dDays;
      pushUndo({ kind: 'schedule', key: d.key, prevStart: r.start, prevDue: r.due });
      updateIssueFields(d.key, (r.start ? { startdate: iso(day), duedate: iso(day) } : { duedate: iso(day) }) as never)
        .then(() => qc.invalidateQueries({ queryKey: ['roadmap'] }));
      return;
    }
    let s = d.oStart, e = d.oDue;
    if (d.mode === 'move') { s += dDays; e += dDays; }
    if (d.mode === 'l') s = Math.min(s + dDays, e);
    if (d.mode === 'r') e = Math.max(s, e + dDays);
    if (d.mode === 'move' && d.cascade) {
      // Shift-drag cascade — dependents move by the same delta in one batch
      const byKey = new Map(tree.map((x) => [x.key, x]));
      const items = [{ key: d.key, prevStart: r.start, prevDue: r.due }];
      const writes = [updateIssueFields(d.key, { startdate: iso(s), duedate: iso(e) } as never)];
      const adj = new Map<string, string[]>();
      for (const x of tree)
        for (const l of x.links)
          if (l.direction === 'outward') adj.set(x.key, [...(adj.get(x.key) ?? []), l.key]);
      const seen = new Set<string>([d.key]);
      const queue = [...(adj.get(d.key) ?? [])];
      while (queue.length) {
        const k = queue.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push(...(adj.get(k) ?? []));
        const dr = byKey.get(k);
        if (!dr || (!dr.start && !dr.due)) continue;
        items.push({ key: k, prevStart: dr.start, prevDue: dr.due });
        const f: Record<string, string | null> = {};
        if (dr.start) f.startdate = iso(day(dr.start) + dDays);
        if (dr.due) f.duedate = iso(day(dr.due) + dDays);
        writes.push(updateIssueFields(k, f as never));
      }
      pushUndo({ kind: 'schedule-batch', items });
      Promise.all(writes)
        .then(() => qc.invalidateQueries({ queryKey: ['roadmap'] }))
        .catch((err) => setLinkError(err instanceof Error ? err.message : 'Cascade failed'));
      return;
    }
    // F21 — auto-schedule: propagate the move to successors whose start would
    // now be violated (successor starts on/after predecessor's new due+1).
    if (d.mode === 'move' && autoSchedule) {
      const byKey = new Map(tree.map((x) => [x.key, x]));
      const adj = new Map<string, string[]>();
      for (const x of tree)
        for (const l of x.links)
          if (l.direction === 'outward') adj.set(x.key, [...(adj.get(x.key) ?? []), l.key]);
      const items = [{ key: d.key, prevStart: r.start, prevDue: r.due }];
      const writes = [updateIssueFields(d.key, { startdate: iso(s), duedate: iso(e) } as never)];
      const dueOf = new Map<string, number>([[d.key, e]]);
      const seen = new Set<string>([d.key]);
      // BFS — only changed nodes propagate further
      const bfs = [d.key];
      while (bfs.length) {
        const pk = bfs.pop()!;
        const predDue = dueOf.get(pk)!;
        for (const n of adj.get(pk) ?? []) {
          if (seen.has(n)) continue;
          const dr = byKey.get(n);
          if (!dr) continue;
          const s0 = dr.start ? day(dr.start) : null;
          const e0 = dr.due ? day(dr.due) : null;
          let ns = s0, ne = e0;
          if (s0 !== null && predDue > s0 - 1) {
            const shift = predDue + 1 - s0;
            ns = s0 + shift;
            if (e0 !== null) ne = e0 + shift;
          } else if (s0 === null && e0 !== null && predDue >= e0) {
            ne = predDue + 1;
          } else continue;
          seen.add(n);
          dueOf.set(n, ne ?? ns ?? predDue);
          items.push({ key: n, prevStart: dr.start, prevDue: dr.due });
          const f: Record<string, string | null> = {};
          if (ns !== null) f.startdate = iso(ns);
          if (ne !== null) f.duedate = iso(ne);
          writes.push(updateIssueFields(n, f as never));
          bfs.push(n);
        }
      }
      pushUndo(items.length > 1 ? { kind: 'schedule-batch', items } : { kind: 'schedule', ...items[0] });
      Promise.all(writes)
        .then(() => qc.invalidateQueries({ queryKey: ['roadmap'] }))
        .catch((err) => setLinkError(err instanceof Error ? err.message : 'Auto-schedule failed'));
      return;
    }
    pushUndo({ kind: 'schedule', key: d.key, prevStart: r.start, prevDue: r.due });
    updateIssueFields(d.key, { startdate: iso(s), duedate: iso(e) } as never)
      .then(() => qc.invalidateQueries({ queryKey: ['roadmap'] }));
  }, [px, tree, qc, autoSchedule]);

  // outward = the issue that carries the link's outward description
  const doLink = (type: string, outward: string, inward: string) => {
    setPendingLink(null);
    if (scenario) {
      // F23 — queue the link as a draft instead of creating it
      pushUndo({ kind: 'draft-unlink' });
      setDraftLinks((l) => [...l, { type, outward, inward }]);
      return;
    }
    linkIssues(type, outward, inward)
      .then((res) => {
        pushUndo({ kind: 'link', linkId: res.id });
        qc.invalidateQueries({ queryKey: ['roadmap'] });
        qc.invalidateQueries({ queryKey: ['issue', outward] });
        qc.invalidateQueries({ queryKey: ['issue', inward] });
      })
      .catch((err) => setLinkError(err instanceof Error ? err.message : 'Link failed'));
  };

  // F23 — persist all drafted dates + links, then leave scenario mode
  const applyScenario = async () => {
    if (!scenario) return;
    try {
      await Promise.all([
        ...[...scenario.entries()].map(([key, d]) =>
          updateIssueFields(key, { startdate: d.start !== null ? iso(d.start) : null, duedate: d.due !== null ? iso(d.due) : null } as never)),
        ...draftLinks.map((l) => linkIssues(l.type, l.outward, l.inward)),
      ]);
      setScenario(null);
      setDraftLinks([]);
      qc.invalidateQueries({ queryKey: ['roadmap'] });
      qc.invalidateQueries({ queryKey: ['issue'] });
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Apply failed');
    }
  };

  const undo = useCallback(() => {
    const op = undoStack.current.pop();
    if (!op) return;
    const done = () => {
      qc.invalidateQueries({ queryKey: ['roadmap'] });
      qc.invalidateQueries({ queryKey: ['issue'] });
    };
    const fail = (e: unknown) => setLinkError(e instanceof Error ? e.message : 'Undo failed');
    if (op.kind === 'draft-schedule') {
      setScenario((m) => {
        if (!m) return m;
        const n = new Map(m);
        if (op.prev === undefined) n.delete(op.key);
        else n.set(op.key, op.prev);
        return n;
      });
      return;
    }
    if (op.kind === 'draft-unlink') {
      setDraftLinks((l) => l.slice(0, -1));
      return;
    }
    if (op.kind === 'schedule') {
      updateIssueFields(op.key, { startdate: op.prevStart, duedate: op.prevDue } as never).then(done).catch(fail);
    } else if (op.kind === 'schedule-batch') {
      Promise.all(op.items.map((i) => updateIssueFields(i.key, { startdate: i.prevStart, duedate: i.prevDue } as never)))
        .then(done).catch(fail);
    } else if (op.kind === 'link') {
      unlinkIssue(op.linkId).then(done).catch(fail);
    } else {
      linkIssuesById(op.typeId, op.outward, op.inward).then(done).catch(fail);
    }
  }, [qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (!undoStack.current.length) return;
      e.preventDefault();
      undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo]);

  // pointer position in rows-container coords — the svg/arrows live in that
  // space, and the container's own rect already accounts for pane scroll
  // (unlike pane coords, which include the 36px sticky axis offset).
  const rowsRef = useRef<HTMLDivElement>(null);
  const paneLocal = (e: { clientX: number; clientY: number }) => {
    const p = rowsRef.current;
    if (!p) return { x: 0, y: 0 };
    const rect = p.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startPan = (e: React.PointerEvent) => {
    const p = paneRef.current;
    if (!p) return;
    e.preventDefault();
    const loc = paneLocal(e);
    setDrag({
      key: '', mode: 'pan', startX: e.clientX, startY: e.clientY,
      oStart: 0, oDue: 0, dx: 0, ax: 0, ay: 0, cx: loc.x, cy: loc.y,
      oScrollL: p.scrollLeft, oScrollT: p.scrollTop,
    });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onBarDown = (e: React.PointerEvent, r: RoadmapRow, mode: Drag['mode'], dir?: Drag['dir']) => {
    if (e.ctrlKey || e.metaKey) return startPan(e);
    if (mode === 'link' ? !canLink : !canSchedule) return;
    e.preventDefault(); e.stopPropagation();
    const b = barRange(r);
    const ri = keyIdx.get(r.key) ?? 0;
    const loc = paneLocal(e);
    setDrag({
      key: r.key, mode, dir, startX: e.clientX, startY: e.clientY, oStart: b.s, oDue: b.e, dx: 0,
      cascade: mode === 'move' && e.shiftKey,
      // link dots sit ~14px past the bar's edge on the dragged side
      ax: x(dir === 'in' ? b.s : b.e) + (dir === 'in' ? -14 : 14),
      ay: ri * ROW_H + ROW_H / 2, cx: loc.x, cy: loc.y,
      pcx: e.clientX, pcy: e.clientY,
    });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.mode === 'pan') {
      const p = paneRef.current;
      if (p) {
        p.scrollLeft = (drag.oScrollL ?? p.scrollLeft) - (e.clientX - drag.startX);
        p.scrollTop = (drag.oScrollT ?? p.scrollTop) - (e.clientY - drag.startY);
      }
      return;
    }
    const upd: Drag = { ...drag, dx: e.clientX - drag.startX };
    if (drag.mode === 'link') {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-row]');
      upd.dropKey = el?.getAttribute('data-row') ?? undefined;
      upd.pcx = e.clientX;
      upd.pcy = e.clientY;
      // edge auto-scroll first — content coords under the cursor shift with
      // the scroll, so cx/cy must be measured AFTER the mutation
      const p = paneRef.current;
      if (p) {
        const rect = p.getBoundingClientRect();
        if (e.clientY < rect.top + 48) p.scrollTop -= 14;
        else if (e.clientY > rect.bottom - 48) p.scrollTop += 14;
        if (e.clientX < rect.left + 48) p.scrollLeft -= 14;
        else if (e.clientX > rect.right - 48) p.scrollLeft += 14;
      }
      const loc = paneLocal(e);
      upd.cx = loc.x;
      upd.cy = loc.y;
    }
    setDrag(upd);
  };

  // virtualization window
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const endIdx = Math.min(display.length, Math.ceil((scrollTop + vpH) / ROW_H) + 8);
  const visRows = display.slice(startIdx, endIdx);

  // Month ticks start on the 1st of t0's month — starting at t0 itself put a
  // "Mon YYYY" label next to the next month's tick and they overlapped.
  const months: { d: number; label: string }[] = [];
  const first = new Date(t0 * DAY);
  for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m.getTime() / DAY < t1; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const d = day(m.toISOString());
    months.push({ d, label: m.toLocaleString('default', { month: 'short', year: 'numeric' }) });
  }

  const typeColor = (r: RoadmapRow) =>
    r.type === 'Epic' ? 'bg-atl-b-400' : r.isSubtask ? 'bg-atl-n-200' : 'bg-atl-g-400';
  // Jira colors timeline bars by status category (new / indeterminate / done)
  const statusColor = (r: RoadmapRow) =>
    r.status.category === 'done' ? 'bg-atl-g-400' : r.status.category === 'indeterminate' ? 'bg-atl-b-400' : 'bg-atl-n-300';
  const barColor = (r: RoadmapRow) => (colorBy === 'status' ? statusColor(r) : typeColor(r));
  const isMilestone = (r: RoadmapRow) => (!r.start && r.due) || (r.start !== null && r.start === r.due);

  const linkDots = (r: RoadmapRow) =>
    canLink && (
      <>
        {/* left dot — "is blocked by" (incoming dependency) */}
        <div
          className="absolute right-full top-1/2 mr-1 -translate-y-1/2 cursor-crosshair touch-none p-1 opacity-0 transition-opacity group-hover:opacity-100"
          role="button"
          aria-label={`${r.key} is blocked by — drag to a blocker`}
          title="Drag to the issue that blocks this one"
          onPointerDown={(e) => onBarDown(e, r, 'link', 'in')}
        >
          <div className="h-3 w-3 rounded-full bg-atl-paper ring-2 ring-atl-n-200 transition-transform hover:scale-125" />
        </div>
        {/* right dot — "blocks" (outgoing dependency) */}
        <div
          className="absolute left-full top-1/2 ml-1 -translate-y-1/2 cursor-crosshair touch-none p-1 opacity-0 transition-opacity group-hover:opacity-100"
          role="button"
          aria-label={`${r.key} blocks — drag to the blocked issue`}
          title="Drag to the issue this one blocks"
          onPointerDown={(e) => onBarDown(e, r, 'link', 'out')}
        >
          <div className="h-3 w-3 rounded-full bg-atl-paper ring-2 ring-atl-b-300 transition-transform hover:scale-125" />
        </div>
      </>
    );

  return (
    <div className={`relative flex h-full flex-col ${drag?.mode === 'link' ? 'cursor-crosshair' : ''}`} onPointerMove={onMove}
      onPointerUp={(e) => {
        if (!drag) return;
        // Re-resolve the drop target from the up-event itself: pointermove
        // updates are continuous and may not have flushed to state when the
        // discrete pointerup commits, so `drag.dropKey` can lag the cursor.
        const upd = { ...drag };
        if (drag.mode === 'link') {
          upd.dropKey = document
            .elementFromPoint(e.clientX, e.clientY)
            ?.closest('[data-row]')
            ?.getAttribute('data-row') ?? undefined;
          upd.dropX = e.clientX;
          upd.dropY = e.clientY;
        }
        commit(upd);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}>
      <div className="flex items-center gap-3 border-b border-atl-n-30 px-4 py-2">
        <h1 className="text-xl font-semibold text-atl-n-800">{level === 'issues' ? 'Timeline — Gantt' : 'Timeline'}</h1>
        {linkError && (
          <button
            onClick={() => setLinkError(null)}
            className="ml-3 rounded border border-atl-r-300 bg-atl-r-50 px-2 py-0.5 text-xs text-atl-r-500"
          >
            {linkError} ✕
          </button>
        )}
        {boards && boards.length > 1 && (
          <SelectMenu
            value={board?.id ?? ''}
            title="Switch board"
            label={<span className="text-sm text-atl-n-600">{board?.name ?? 'Select board'}</span>}
            options={boards.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(v) => setSearchParams((p) => { p.set('board', v); return p; }, { replace: true })}
          />
        )}
        <div className="ml-auto flex items-center gap-2 text-sm">
          {(health.overdue + health.conflicts + health.unscheduled > 0) && (
            <div className="flex items-center gap-1.5 text-xs" title="Timeline health">
              {health.overdue > 0 && (
                <span className="rounded bg-atl-r-50 px-1.5 py-0.5 font-medium text-atl-r-500">{health.overdue} overdue</span>
              )}
              {health.conflicts > 0 && (
                <span className="rounded bg-atl-y-50 px-1.5 py-0.5 font-medium text-atl-y-500">{health.conflicts} conflicts</span>
              )}
              {health.unscheduled > 0 && (
                <button
                  onClick={() => setUnscheduledOnly((v) => !v)}
                  className={`rounded px-1.5 py-0.5 font-medium ${unscheduledOnly ? 'bg-atl-b-50 text-atl-b-400' : 'bg-atl-n-20 text-atl-n-500 hover:bg-atl-n-30'}`}
                  title={unscheduledOnly ? 'Show all issues' : 'Show only unscheduled issues'}
                >
                  {health.unscheduled} unscheduled
                </button>
              )}
            </div>
          )}
          <button
            onClick={() => {
              const p = paneRef.current;
              if (p) p.scrollTo({ left: x(today()) - p.clientWidth / 3, behavior: 'smooth' });
            }}
            className="rounded border border-atl-n-60 px-2.5 py-1 text-atl-n-500 hover:bg-atl-n-20"
            title="Scroll to today"
          >
            Today
          </button>
          <div className="flex rounded border border-atl-n-60">
            {(['epics', 'issues'] as const).map((l) => (
              <button key={l} onClick={() => setSearchParams((p) => { if (l === 'epics') p.delete('level'); else p.set('level', 'issues'); return p; }, { replace: true })}
                className={`px-2.5 py-1 ${level === l ? 'bg-atl-b-50 text-atl-b-400 font-medium' : 'text-atl-n-300'}`}>
                {l === 'epics' ? 'Epics' : 'Gantt'}
              </button>
            ))}
          </div>
          <SelectMenu
            value={zoom}
            title="Zoom"
            label={<span className="text-sm capitalize text-atl-n-600">{zoom}</span>}
            options={['day', 'week', 'month', 'quarter'].map((z) => ({ value: z, label: z[0].toUpperCase() + z.slice(1) }))}
            onChange={(v) => setSearchParams((p) => { p.set('zoom', v); return p; }, { replace: true })}
          />
          {level === 'issues' && (
            <SelectMenu
              value={groupBy}
              title="Group rows"
              label={<span className="text-sm text-atl-n-600">Group: {groupBy === 'none' ? 'off' : groupBy}</span>}
              options={[
                { value: 'none', label: 'No grouping' },
                { value: 'assignee', label: 'Assignee' },
                { value: 'status', label: 'Status' },
              ]}
              onChange={(v) => setGroupBy(v as 'none' | 'assignee' | 'status')}
            />
          )}
          <SelectMenu
            value={colorBy}
            title="Bar colors"
            label={<span className="text-sm text-atl-n-600">Color: {colorBy}</span>}
            options={[
              { value: 'type', label: 'Issue type' },
              { value: 'status', label: 'Status' },
            ]}
            onChange={(v) => setColorBy(v as 'type' | 'status')}
          />
          {level === 'issues' && (
            <label className="flex items-center gap-1 text-atl-n-400">
              <input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} />
              Critical path
            </label>
          )}
          {level === 'issues' && canSchedule && (
            <label className="flex items-center gap-1 text-atl-n-400" title="Moving a bar pushes successors whose start is violated">
              <input type="checkbox" checked={autoSchedule} onChange={(e) => setAutoSchedule(e.target.checked)} />
              Auto-schedule
            </label>
          )}
          {baseline && (
            <label className="flex items-center gap-1 text-atl-n-400" title={`Saved ${new Date(baseline.savedAt).toLocaleString()}`}>
              <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} />
              Baseline
            </label>
          )}
          <button
            onClick={saveBaseline}
            className="text-xs text-atl-n-300 hover:text-atl-n-500"
            title="Snapshot current dates as the baseline plan"
          >
            {baseline ? 'Update baseline' : 'Save baseline'}
          </button>
          {scenario === null && canSchedule && (
            <button
              onClick={() => { setScenario(new Map()); setDraftLinks([]); }}
              className="rounded border border-atl-p-200 px-2.5 py-1 text-atl-p-700 hover:bg-atl-p-50"
              title="Plan changes without saving until you apply them (Jira Plans)"
            >
              New scenario
            </button>
          )}
          <details className="relative">
            <summary className="cursor-pointer list-none text-atl-n-300 hover:text-atl-n-500">Legend</summary>
            <div className="absolute right-0 top-8 z-30 w-48 rounded border border-atl-n-30 bg-atl-paper p-3 shadow-lg">
              <div className="space-y-1.5 text-xs text-atl-n-500">
                {colorBy === 'type' ? (
                  <>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-b-400" /> Epic</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-g-400" /> Standard</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-n-200" /> Subtask</div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-n-300" /> To do</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-b-400" /> In progress</div>
                    <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-g-400" /> Done</div>
                  </>
                )}
                <div className="flex items-center gap-2"><span className="ml-1 h-2.5 w-2.5 rotate-45 bg-atl-p-400" /><span className="ml-1">Milestone</span></div>
                <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm bg-atl-r-400" /> Overdue / critical</div>
                <div className="flex items-center gap-2"><span className="h-2.5 w-6 rounded-sm border border-dashed border-atl-n-200 opacity-60" /> Unscheduled</div>
                <div className="flex items-center gap-2"><span className="h-1.5 w-6 rounded-full bg-atl-n-100/80" /> Baseline</div>
                <div className="flex items-center gap-2"><svg width="24" height="8"><path d="M0 4 C 8 4, 16 4, 20 4" fill="none" stroke={CHART.gray} /><path d="M22 4 l-5 -2 v4 z" fill={CHART.gray} /></svg> Dependency</div>
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* F23 — scenario banner: drafts are local until applied */}
      {scenario !== null && (
        <div className="flex items-center gap-3 border-b border-atl-p-200 bg-atl-p-50 px-4 py-1.5 text-sm">
          <span className="font-medium text-atl-p-700">Scenario</span>
          <span className="text-atl-n-400">
            {scenarioChanges === 0 ? 'Drag bars or links — nothing is saved yet' : `${scenarioChanges} unsaved change${scenarioChanges === 1 ? '' : 's'}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={applyScenario}
              disabled={scenarioChanges === 0}
              className="rounded bg-atl-b-300 px-2.5 py-1 text-white hover:bg-atl-b-400 disabled:opacity-40"
            >
              Apply
            </button>
            <button
              onClick={() => { setScenario(null); setDraftLinks([]); }}
              className="rounded px-2.5 py-1 text-atl-n-400 hover:bg-atl-n-20"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* tree grid */}
        <div className="shrink-0 border-r border-atl-n-30" style={{ width: TREE_W }}>
          <div className="flex h-9 items-center gap-1 border-b border-atl-n-30 px-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter issues"
              name="roadmap-filter"
              autoComplete="off"
              className="min-w-0 flex-1 rounded border border-atl-n-60 bg-atl-paper px-1.5 py-0.5 text-xs text-atl-n-600 outline-none focus:border-atl-b-300"
            />
            {level === 'issues' && (
              <>
                <button
                  className="rounded px-1 text-xs text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-500"
                  aria-label="Expand all" title="Expand all"
                  onClick={() => setCollapsed(new Set())}
                >+</button>
                <button
                  className="rounded px-1 text-xs text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-500"
                  aria-label="Collapse all" title="Collapse all"
                  onClick={() => setCollapsed(new Set(hasKids))}
                >−</button>
              </>
            )}
          </div>
          <div className="overflow-hidden" style={{ height: vpH }}>
            <div style={{ transform: `translateY(${-scrollTop}px)` }}>
              {display.map((r) => '_header' in r ? (
                <div key={r.id} className="flex h-8 items-center bg-atl-n-20 px-3 text-[11px] font-semibold uppercase tracking-wider text-atl-n-400">
                  {r.label} <span className="ml-1.5 font-normal normal-case text-atl-n-200">{r.count}</span>
                </div>
              ) : (
                <div key={r.key} data-row={r.key}
                  className={`flex h-8 items-center gap-1.5 px-2 text-sm hover:bg-atl-n-20 ${drag?.mode === 'link' && drag.dropKey === r.key && r.key !== drag.key ? 'bg-atl-b-50' : ''}`}
                  style={{ paddingLeft: 8 + ((r as RoadmapRow & { _depth?: number })._depth ?? 0) * 14 }}>
                  {hasKids.has(r.key) ? (
                    <button className="w-4 text-atl-n-200" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>
                      {collapsed.has(r.key) ? '▸' : '▾'}
                    </button>
                  ) : <span className="w-4" />}
                  <button className="truncate text-left hover:underline" title={`${r.key}: ${r.summary}`} onClick={() => openIssue(r.key)}>
                    <IssueKey issueKey={r.key} categoryKey={r.status.category} className="text-atl-n-200" />{' '}
                    <span className="text-atl-n-500">{r.summary}</span>
                  </button>
                  {r.assignee && <span className="ml-auto shrink-0 rounded bg-atl-n-30 px-1.5 text-[11px] text-atl-n-300">{r.assignee.split(' ')[0]}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* timeline pane — Ctrl/Cmd+drag anywhere pans the canvas */}
        <div
          ref={paneRef}
          className={`relative flex-1 overflow-auto ${drag?.mode === 'pan' ? 'cursor-grabbing' : ''}`}
          onScroll={(e) => {
            setScrollTop(e.currentTarget.scrollTop);
            // link drag + stationary cursor: the row/connector under the
            // pointer moves with the scroll — re-anchor from stored client xy
            if (drag?.mode === 'link' && drag.pcx != null && drag.pcy != null) {
              const loc = paneLocal({ clientX: drag.pcx, clientY: drag.pcy });
              const el = document.elementFromPoint(drag.pcx, drag.pcy)?.closest('[data-row]');
              setDrag({ ...drag, cx: loc.x, cy: loc.y, dropKey: el?.getAttribute('data-row') ?? undefined });
            }
          }}
          onPointerDown={(e) => { if (e.ctrlKey || e.metaKey) startPan(e); }}
        >
          {/* axis */}
          <div className="sticky top-0 z-10 h-9 border-b border-atl-n-30 bg-atl-paper" style={{ width }}>
            {months.filter((m) => x(m.d) > -80).map((m) => (
              <div key={m.d} className="absolute top-0 h-full border-l border-atl-n-30 px-1.5 pt-1.5 text-[11px] text-atl-n-300 whitespace-nowrap" style={{ left: x(m.d) }}>{m.label}</div>
            ))}
            {data?.versions.map((v) => v.releaseDate && (
              <div key={v.name} className="absolute top-1 z-20" style={{ left: x(day(v.releaseDate)) - 5 }} title={`${v.name} — ${v.releaseDate}`}>
                <div className="h-3 w-3 rotate-45 bg-atl-y-400" />
              </div>
            ))}
            {(sprints ?? []).filter((s) => s.startDate).map((s) => (
              <div
                key={s.id}
                className="absolute bottom-0.5 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-atl-b-50 px-1 text-[9px] font-medium text-atl-b-400"
                style={{ left: x(day(s.startDate!)) + 2 }}
                title={`${s.name}: ${s.startDate}${s.endDate ? ` → ${s.endDate}` : ''}`}
              >
                {s.name}
              </div>
            ))}
          </div>
          {/* today line */}
          <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-atl-r-400" style={{ left: x(today()) }} />
          {/* sprint boundaries — dashed blue at start/end of open sprints (F22) */}
          {(sprints ?? []).filter((s) => s.startDate).map((s) => (
            <div key={s.id}>
              <div
                className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-atl-b-200"
                style={{ left: x(day(s.startDate!)) }}
                title={`${s.name} starts ${s.startDate}`}
              />
              {s.endDate && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-atl-b-200 opacity-60"
                  style={{ left: x(day(s.endDate)) }}
                  title={`${s.name} ends ${s.endDate}`}
                />
              )}
            </div>
          ))}

          {/* rows + arrows */}
          <div ref={rowsRef} className="relative" style={{ width, height: display.length * ROW_H }}>
            {/* weekend shading */}
            {weekends.map((w) => (
              <div
                key={w.s}
                className="pointer-events-none absolute top-0 bottom-0 bg-atl-n-20/60"
                style={{ left: x(w.s), width: (w.e - w.s + 1) * px }}
              />
            ))}
            <div style={{ transform: `translateY(${startIdx * ROW_H}px)` }}>
              {visRows.map((r) => {
                if ('_header' in r) {
                  // lane separator — full-width band aligned with the tree header
                  return (
                    <div
                      key={r.id}
                      className="absolute flex h-8 items-center border-b border-atl-n-30 bg-atl-n-20/50"
                      style={{ left: 0, right: 0, top: (keyIdx.get(r.id)! - startIdx) * ROW_H }}
                    />
                  );
                }
                const b = barRange(r);
                const conflict = r.links.some((l) => l.direction === 'inward' && tree.find((s) => s.key === l.key)?.due && r.start && day(tree.find((s) => s.key === l.key)!.due!) > day(r.start));
                const isCrit = crit.has(r.key);
                const isDropTarget = drag?.mode === 'link' && drag.dropKey === r.key && drag.key !== r.key;
                const overdue = r.due !== null && day(r.due) < today() && r.status.category !== 'done';
                const milestone = isMilestone(r);
                const isCascade = cascadeKeys.has(r.key);
                const drafted = scenario?.has(r.key) ?? false;
                return (
                  <div key={r.key} data-row={r.key} className={`group absolute flex h-8 items-center ${isDropTarget ? 'bg-atl-b-50/70' : ''}`} style={{ left: 0, right: 0, top: (keyIdx.get(r.key)! - startIdx) * ROW_H }}>
                    {/* F20 — baseline ghost under the live bar */}
                    {showBaseline && (() => {
                      const bl = baseline?.items[r.key];
                      if (!bl || bl.s === null || bl.e === null) return null;
                      return (
                        <div
                          className="pointer-events-none absolute bottom-0.5 h-1.5 rounded-full bg-atl-n-100/80"
                          style={{ left: x(bl.s), width: Math.max((bl.e - bl.s + 1) * px, 4) }}
                          title={`Baseline: ${fmtDay(bl.s)} → ${fmtDay(bl.e)}`}
                        />
                      );
                    })()}
                    {milestone ? (
                      /* milestone — a single due date renders as a diamond, not a bar */
                      <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: x(b.e) }}>
                        <div
                          className={`h-3.5 w-3.5 rotate-45 touch-none ${overdue || isCrit ? 'bg-atl-r-400' : 'bg-atl-p-400'} ${drafted ? 'ring-2 ring-atl-p-200' : ''} ${canSchedule ? 'cursor-grab' : 'cursor-pointer'}`}
                          onPointerDown={(e) => onBarDown(e, r, 'move')}
                          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } openIssue(r.key); }}
                          title={`${r.key} — ${r.due} (milestone${overdue ? ', overdue' : ''})`}
                        />
                        {linkDots(r)}
                      </div>
                    ) : (
                      <div
                        className={`absolute h-5 rounded-sm touch-none ${isCrit || overdue ? 'bg-atl-r-400' : barColor(r)} ${b.ghost ? 'opacity-30 border border-dashed border-atl-n-200' : ''} ${conflict ? 'ring-2 ring-atl-r-400' : ''} ${isCascade ? 'ring-2 ring-atl-b-300' : ''} ${drafted ? 'ring-1 ring-atl-p-300' : ''} ${canSchedule ? 'cursor-grab' : 'cursor-pointer'}`}
                        style={{ left: x(b.s), width: Math.max((b.e - b.s + 1) * px, 6) }}
                        onPointerDown={(e) => onBarDown(e, r, 'move')}
                        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } openIssue(r.key); }}
                        title={`${r.key}: ${r.summary} — ${r.start ?? 'unscheduled'} → ${r.due ?? '…'} (${r.progress.pct}%${overdue ? ', overdue' : ''})`}
                      >
                        <div className="h-full rounded-l-sm bg-black/20" style={{ width: `${r.progress.pct}%` }} />
                        {/* in-bar summary when the bar is wide enough (C13) */}
                        {(b.e - b.s + 1) * px > 80 && (
                          <span className="pointer-events-none absolute inset-x-1 top-0 flex h-full items-center overflow-hidden whitespace-nowrap text-[10px] font-medium text-white">
                            {r.summary}
                          </span>
                        )}
                        {/* dependency count badges at both ends (A3, Jira Plans) */}
                        {(b.e - b.s + 1) * px > 44 && (
                          <>
                            {r.links.some((l) => l.direction === 'inward') && (
                              <span
                                className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 rounded-sm bg-black/25 px-0.5 text-[9px] font-semibold leading-3 text-white"
                                title={`${r.links.filter((l) => l.direction === 'inward').length} incoming`}
                              >
                                {r.links.filter((l) => l.direction === 'inward').length}
                              </span>
                            )}
                            {r.links.some((l) => l.direction === 'outward') && (
                              <span
                                className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 rounded-sm bg-black/25 px-0.5 text-[9px] font-semibold leading-3 text-white"
                                title={`${r.links.filter((l) => l.direction === 'outward').length} outgoing`}
                              >
                                {r.links.filter((l) => l.direction === 'outward').length}
                              </span>
                            )}
                          </>
                        )}
                        {/* live date range while moving/resizing */}
                        {drag?.key === r.key && drag.mode !== 'link' && drag.mode !== 'pan' && (
                          <div className="pointer-events-none absolute -top-6 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded bg-atl-n-800 px-1.5 py-0.5 text-[10px] font-medium text-white shadow">
                            {fmtDay(barRange(r).s)} → {fmtDay(barRange(r).e)}
                            {drag.cascade && cascadeKeys.size > 0 && ` · +${cascadeKeys.size} linked`}
                          </div>
                        )}
                        {canSchedule && (
                          <>
                            <div className="absolute -left-1 top-0 h-full w-2 cursor-ew-resize" onPointerDown={(e) => onBarDown(e, r, 'l')} />
                            <div className="absolute -right-1 top-0 h-full w-2 cursor-ew-resize" onPointerDown={(e) => onBarDown(e, r, 'r')} />
                          </>
                        )}
                        {linkDots(r)}
                      </div>
                    )}
                    {/* pointer-events-none: this label overlaps the link dot's
                        hit area — it must never intercept the drag press. */}
                    <span
                      className="pointer-events-none absolute whitespace-nowrap text-[11px] text-atl-n-300 transition-transform group-hover:translate-x-6"
                      style={{ left: x(b.e) + 8 }}
                    >
                      {r.progress.done}/{r.progress.total}
                    </span>
                  </div>
                );
              })}
            </div>
            {/* dependency arrows */}
            <svg className="pointer-events-none absolute top-0 left-0" width={Math.max(width, (drag?.cx ?? 0) + 40)} height={display.length * ROW_H}>
              {/* elastic connector while link-dragging: bar edge → pointer */}
              {drag?.mode === 'link' && (
                <g>
                  <path
                    d={`M${drag.ax} ${drag.ay} C ${drag.ax + 30} ${drag.ay}, ${drag.cx - 30} ${drag.cy}, ${drag.cx} ${drag.cy}`}
                    fill="none" stroke={SVG.blue} strokeWidth={1.6} strokeDasharray="5 4"
                  />
                  <circle cx={drag.ax} cy={drag.ay} r={3.5} fill={SVG.blue} />
                  <circle
                    cx={drag.cx} cy={drag.cy} r={5}
                    fill={SVG.white}
                    stroke={drag.dropKey && drag.dropKey !== drag.key ? SVG.blue : SVG.n80}
                    strokeWidth={2}
                  />
                </g>
              )}
              {/* F23 — dashed preview arrows for drafted (unsaved) links */}
              {draftLinks.map((l, i) => {
                const sr = tree.find((t) => t.key === l.outward);
                const dr = tree.find((t) => t.key === l.inward);
                if (!sr || !dr) return null;
                const src = barRange(sr); const dst = barRange(dr);
                const x1 = x(src.e) + 2, x2 = x(dst.s) - 2;
                const y1 = (keyIdx.get(l.outward) ?? 0) * ROW_H + ROW_H / 2;
                const y2 = (keyIdx.get(l.inward) ?? 0) * ROW_H + ROW_H / 2;
                return (
                  <path
                    key={`draft-${i}`}
                    d={`M${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 24} ${y2}, ${x2} ${y2}`}
                    fill="none" stroke={CHART.purple} strokeWidth={1.5} strokeDasharray="4 4"
                  />
                );
              })}
              {tree.flatMap((r) => r.links.filter((l) => l.direction === 'outward' && keyIdx.has(l.key)).map((l) => {
                // keyIdx indexes `display` (includes lane headers) — look the
                // target row up in `tree`, never tree[ti].
                const ti = keyIdx.get(l.key)!;
                const ri = keyIdx.get(r.key) ?? 0;
                const dstRow = tree.find((t) => t.key === l.key)!;
                const src = barRange(r); const dst = barRange(dstRow);
                const x1 = x(src.e) + 2; const x2 = x(dst.s) - 2;
                const y1 = ri * ROW_H + ROW_H / 2; const y2 = ti * ROW_H + ROW_H / 2;
                const conflicted = r.due && dstRow.start && day(r.due) > day(dstRow.start);
                const cls = conflicted ? SVG.red : isCrit2(crit, r.key, l.key) ? SVG.red : CHART.gray;
                const mid = Math.max(x1 + 12, x2 - 12);
                return (
                  <g key={`${r.key}-${l.key}`}>
                    {/* fat transparent hit-path — the parent svg is pointer-events-none,
                        so the visible stroke needs its own clickable layer. Inset ~20px
                        at both ends: the svg paints above the bars, so an untrimmed
                        hit-path covers the link dots at the bar edges — hovering it
                        steals the row's :hover and the dots vanish before the press. */}
                    <path
                      d={`M${x1 + Math.min(20, Math.max(0, (x2 - x1 - 20) / 2))} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 6 - Math.min(20, Math.max(0, (x2 - x1 - 20) / 2))} ${y2}`}
                      fill="none" stroke="transparent" strokeWidth={14}
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLinkSel({ x: e.clientX, y: e.clientY, from: r.key, to: l.key, type: l.type, typeId: l.typeId, id: l.id });
                      }}
                    />
                    <path d={`M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 6} ${y2}`} fill="none" stroke={cls} strokeWidth={conflicted ? 2 : 1.2} />
                    <path d={`M${x2} ${y2} l-7 -3 v6 z`} fill={cls} />
                    <title>{l.type} {conflicted ? '(conflict: dependency ends after dependent starts)' : ''}</title>
                  </g>
                );
              }))}
            </svg>
          </div>
        </div>
      </div>
      {rows.length === 0 && (
        <div className="absolute inset-0 grid place-items-center">
          <EmptyState title="No scheduled work" description="Set Start date / Due date on epics — or drag a bar to schedule." />
        </div>
      )}

      {/* dependency detail popover — click an arrow (Jira: select line → view/remove) */}
      {linkSel && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setLinkSel(null)} />
          <div
            className="fixed z-50 w-60 rounded border border-atl-n-30 bg-atl-paper p-3 shadow-lg"
            style={{ left: Math.min(linkSel.x + 8, window.innerWidth - 250), top: linkSel.y + 8 }}
          >
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Dependency</div>
            <div className="mb-3 text-sm text-atl-n-700">
              <span className="font-medium">{linkSel.from}</span>{' '}
              <span className="text-atl-n-300">{linkSel.type}</span>{' '}
              <span className="font-medium">{linkSel.to}</span>
            </div>
            <button
              onClick={() => delLink.mutate(linkSel)}
              disabled={delLink.isPending}
              className="w-full rounded px-2 py-1 text-left text-sm text-atl-r-500 hover:bg-atl-r-50 disabled:opacity-50"
            >
              {delLink.isPending ? 'Removing…' : 'Remove link'}
            </button>
          </div>
        </>
      )}
      {/* link-type menu after a dependency drop */}
      {pendingLink && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPendingLink(null)} />
          <div
            className="fixed z-50 w-64 rounded border border-atl-n-30 bg-atl-paper p-3 shadow-lg"
            style={{ left: Math.min(pendingLink.x + 8, window.innerWidth - 270), top: Math.min(pendingLink.y + 8, window.innerHeight - 160) }}
          >
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Link issues</div>
            <div className="mb-2 text-sm text-atl-n-700">
              <span className="font-medium">{pendingLink.source}</span>
              <span className="text-atl-n-300"> → </span>
              <span className="font-medium">{pendingLink.target}</span>
            </div>
            {(pendingLink.dir === 'in'
              ? [
                  { label: 'is blocked by', run: () => doLink('Blocks', pendingLink.target, pendingLink.source) },
                  { label: 'relates to', run: () => doLink('Relates', pendingLink.source, pendingLink.target) },
                ]
              : [
                  { label: 'blocks', run: () => doLink('Blocks', pendingLink.source, pendingLink.target) },
                  { label: 'relates to', run: () => doLink('Relates', pendingLink.source, pendingLink.target) },
                ]
            ).map((o) => (
              <button
                key={o.label}
                onClick={o.run}
                className="w-full rounded px-2 py-1.5 text-left text-sm text-atl-n-600 hover:bg-atl-n-20"
              >
                {pendingLink.source} <span className="text-atl-n-300">{o.label}</span> {pendingLink.target}
              </button>
            ))}
          </div>
        </>
      )}
      <IssueDrawer />
    </div>
  );
}

function isCrit2(crit: Set<string>, a: string, b: string) { return crit.has(a) && crit.has(b); }
