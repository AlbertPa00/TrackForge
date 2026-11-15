/**
 * 016 perf — short-TTL snapshot of JQL compile-time metadata (statuses,
 * priorities, types, resolutions, projects, CF defs). These tables change
 * rarely; each entry is invalidated by the matching admin/seed write path
 * and by the test harness (beforeEach). Leaf module — no imports — so any
 * service can invalidate without cycles.
 */
export interface JqlCtxSnapshot {
  statuses: Map<string, string>;
  priorities: Map<string, string>;
  issueTypes: Map<string, string>;
  resolutions: Map<string, string>;
  projects: Map<string, string>;
  cfDefs?: unknown[];
}

const TTL_MS = 10_000;
let snap: { t: number; data: JqlCtxSnapshot } | null = null;

export function jqlCtxGet(): JqlCtxSnapshot | null {
  return snap && Date.now() - snap.t < TTL_MS ? snap.data : null;
}
export function jqlCtxSet(data: JqlCtxSnapshot) {
  snap = { t: Date.now(), data };
}
export function invalidateJqlCtxCache() {
  snap = null;
}
