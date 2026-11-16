import type { ImportJob, PrismaClient } from '../lib/pc.js';

/**
 * Sprint 017 importer extension contract.
 *
 * Every sprint that adds an importable entity must register an EntityImporter
 * here. Stages: discover → map → plan → apply → verify, all resumable through
 * ImportJob.stageData + ExternalIdMap provenance.
 */

/** Read-side abstraction over a Jira Cloud (or fixture) source. */
export interface JiraSource {
  /** Single GET against the Jira REST API (path like '/rest/api/3/project'). */
  get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Auto-paginating stream over a Jira search/list endpoint.
   * `itemsKey` names the array field in the response ('values', 'issues', ...);
   * omitted means the response itself is the array (unpaginated endpoint).
   */
  paged<T = unknown>(path: string, itemsKey?: string, params?: Record<string, unknown>): AsyncIterable<T>;
  /**
   * Binary GET with the same credentials — used by the attachment importer for
   * `content` URLs (Sprint 018). Optional: sources that can't stream bytes cause
   * the attachment importer to skip with a warning rather than crash.
   */
  getBinary?(path: string): Promise<Buffer>;
}

export interface ImportCtx {
  prisma: PrismaClient;
  job: ImportJob;
  /** external→internal ids resolved so far (ExternalIdMap-backed). */
  resolve(entityType: string, externalId: string): Promise<string | null>;
  /** entity→externalId→internalId mapping written by apply(). */
  record(entityType: string, externalId: string, internalId: string): Promise<void>;
  warn(entityType: string, externalId: string, message: string): void;
  signal?: AbortSignal;
  /** The source the job was started with — apply() needs it for binary fetches (attachments). */
  source?: JiraSource;
}

export type PlanOp =
  | { kind: 'create'; entity: string; externalId: string; summary: string; data: unknown }
  | { kind: 'update'; entity: string; externalId: string; internalId: string; summary: string; data: unknown }
  | { kind: 'skip'; entity: string; externalId: string; reason: string }
  | { kind: 'unsupported'; entity: string; externalId: string; sprint: string };

export interface PlanReport {
  entity: string;
  creates: number;
  updates: number;
  skips: number;
  warnings: { externalId: string; message: string }[];
  errors: { externalId: string; message: string }[];
  ops: PlanOp[];
}

export interface VerifyResult {
  entity: string;
  expected: number;
  imported: number;
  diffs: string[];
}

export interface EntityImporter<Raw = unknown, Mapped = unknown> {
  /** 'user' | 'group' | 'project' | 'issue' | ... — used for ExternalIdMap.entityType. */
  entity: string;
  /** Importer dependencies — run after these entities are mapped. */
  dependsOn?: string[];
  /** Raw rows exist on the source for the selected projects. */
  discover(src: JiraSource, ctx: ImportCtx): AsyncIterable<Raw>;
  /** Jira shape → TrackForge write shape (no DB writes). */
  map(raw: Raw, ctx: ImportCtx): Promise<Mapped>;
  /** Mapped row → create/update/skip/unsupported op (no DB writes). */
  plan(mapped: Mapped, ctx: ImportCtx): Promise<PlanOp>;
  /**
   * Execute a create/update op. Returns the real internal id, which is
   * recorded in ExternalIdMap. Return `null` when the op was handled as a
   * permanent skip (already warned) — nothing is recorded and re-runs
   * re-evaluate it honestly. THROW for retryable failures (missing
   * job-scope dependencies, transient errors) so the op surfaces in
   * report.applyErrors instead of being silently mapped. Never return
   * `op.externalId` — the apply loop refuses self-mappings.
   */
  apply(op: PlanOp & { kind: 'create' | 'update' }, ctx: ImportCtx): Promise<string | null>;
  /** Post-import row-count/diff check. */
  verify?(src: JiraSource, ctx: ImportCtx): Promise<VerifyResult>;
}
