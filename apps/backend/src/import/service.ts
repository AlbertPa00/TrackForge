import type { PrismaClient, ImportJob } from '@prisma/client';
import { prisma as db } from '../prisma.js';
import { getDurableRunner } from '../lib/jobs.js';
import { createJiraSource, createFixtureSource } from './jiraClient.js';
import {
  createJiraServerSource,
  assertServerBaseUrl,
  SERVER_FIELD_ALIASES,
  SERVER_FIELD_SCHEMAS,
} from './jiraServerClient.js';
import { importerRegistry } from './importers.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { resolveSecret } from '../services/directoryService.js';
import type { ImportCtx, JiraSource, PlanOp, PlanReport, VerifyResult } from './types.js';

// 064 US5: import secretRef goes through the shared resolver — bare env names
// get the env: prefix, protected TrackForge secrets are refused.
const importToken = (sd: StageData) =>
  sd.cred ??
  (sd.secretRef ? resolveSecret(sd.secretRef.startsWith('env:') ? sd.secretRef : `env:${sd.secretRef}`) : undefined);

export const IMPORT_JOB_QUEUE = 'import';

export interface StartImportInput {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  secretRef?: string; // env var holding the token — nothing persisted
  projectKeys: string[];
  dryRun?: boolean;
  deltaFrom?: string; // ISO date — only entities updated >= this
  fixture?: Record<string, unknown>; // fixture source (tests / offline dry-runs)
  source?: string; // 039/048 — 'csv' | 'jira-server-xml' | 'jira-server' | ...
  // ---- 048 jira-server fields (all non-secret — secrets stay cred/secretRef) ----
  authMode?: 'basic' | 'pat';
  username?: string; // Server basic login (distinct from Cloud email)
  fieldAliases?: Record<string, string>; // canonical → customfield id overrides
  groups?: string[]; // user-discovery union members (FR-006)
  allowPrivate?: boolean; // SSRF opt-in for intranet baseUrls
  insecureSkipVerify?: boolean; // self-signed intranet TLS opt-in
}

interface StageData {
  cred?: string; // v1: api token kept for resume (see threat-model)
  secretRef?: string;
  fixture?: Record<string, unknown>;
  deltaFrom?: string;
  email?: string;
  // ---- 048 jira-server (non-secret) ----
  authMode?: 'basic' | 'pat';
  username?: string;
  fieldAliases?: Record<string, string>;
  fieldAliasesInput?: Record<string, string>; // user overrides — merged over each run's auto-resolution
  labelsFieldIds?: string[]; // every labels-type CF id — values merge into Issue.labels
  groups?: string[];
  allowPrivate?: boolean;
  insecureSkipVerify?: boolean;
  serverInfo?: { version?: string; buildNumber?: number; baseUrl?: string };
  progress?: Record<string, { total: number; done: number }>;
  cursor?: { entityIndex: number };
}

async function sourceFor(job: ImportJob, onWarn?: (msg: string) => void): Promise<JiraSource> {
  const sd = (job.stageData ?? {}) as StageData;
  if (job.source === 'jira-server') {
    return createJiraServerSource({
      baseUrl: job.baseUrl,
      authMode: sd.authMode ?? 'basic',
      username: sd.username ?? sd.email,
      token: importToken(sd),
      projectKeys: job.projectKeys,
      groups: sd.groups,
      fieldAliases: sd.fieldAliases,
      allowPrivate: sd.allowPrivate,
      insecureSkipVerify: sd.insecureSkipVerify,
      inner: sd.fixture ? createFixtureSource(sd.fixture) : undefined,
      onWarn,
    });
  }
  if (sd.fixture) return createFixtureSource(sd.fixture, { allowPrivate: sd.allowPrivate });
  const token = importToken(sd);
  if (!token) throw new Error('import job has no usable credential (apiToken or secretRef)');
  return createJiraSource({ baseUrl: job.baseUrl, email: sd.email ?? '', apiToken: token });
}

export async function startImport(actorId: string, input: StartImportInput, prisma: PrismaClient = db) {
  const isServer = input.source === 'jira-server';
  if (!input.fixture) {
    if (!input.baseUrl || (!input.apiToken && !input.secretRef)) {
      throw new JiraApiError(400, jiraError(['baseUrl and apiToken|secretRef are required']));
    }
    if (isServer) {
      if ((input.authMode ?? 'basic') === 'basic' && !input.username) {
        throw new JiraApiError(400, jiraError(['username is required for basic auth on jira-server']));
      }
      await assertServerBaseUrl(input.baseUrl, { allowPrivate: input.allowPrivate });
    } else if (!input.email) {
      throw new JiraApiError(400, jiraError(['email is required for jira-cloud basic auth']));
    }
  }
  if (!input.projectKeys?.length) {
    throw new JiraApiError(400, jiraError(['projectKeys[] is required']));
  }
  const stageData: StageData = {
    email: input.email,
    secretRef: input.secretRef,
    deltaFrom: input.deltaFrom,
  };
  if (isServer) {
    stageData.authMode = input.authMode ?? 'basic';
    stageData.username = input.username;
    stageData.fieldAliasesInput = input.fieldAliases; // user overrides win over auto-resolution each run
    stageData.groups = input.groups;
    stageData.allowPrivate = input.allowPrivate;
    stageData.insecureSkipVerify = input.insecureSkipVerify;
  }
  if (input.apiToken) stageData.cred = input.apiToken;
  if (input.fixture) stageData.fixture = input.fixture;
  const job = await prisma.importJob.create({
    data: {
      source: input.source ?? (input.fixture ? 'fixture' : 'jira-cloud'),
      baseUrl: input.baseUrl ?? 'fixture://jira',
      projectKeys: input.projectKeys.map((k) => k.toUpperCase()),
      dryRun: input.dryRun ?? false,
      actorId,
      stageData: stageData as object,
    },
  });
  await getDurableRunner().enqueue(IMPORT_JOB_QUEUE, { jobId: job.id }, { key: `import:${job.id}` });
  return job;
}

export async function getImport(jobId: string, prisma: PrismaClient = db) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw new JiraApiError(404, jiraError(['Import not found']));
  // never leak the persisted credential through the API
  const sd = { ...(job.stageData as StageData | null) };
  delete sd.cred;
  delete sd.fixture;
  return { ...job, stageData: sd };
}

export async function listImports(prisma: PrismaClient = db) {
  const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return jobs.map((j) => {
    const sd = { ...(j.stageData as StageData | null) };
    delete sd.cred;
    delete sd.fixture;
    return { ...j, stageData: sd };
  });
}

/** Re-enqueue an interrupted/failed job — resume is free because ops are idempotent. */
export async function resumeImport(jobId: string, prisma: PrismaClient = db) {
  await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
  await prisma.importJob.update({
    where: { id: jobId },
    data: { stage: 'discovering', error: null },
  });
  await getDurableRunner().enqueue(IMPORT_JOB_QUEUE, { jobId }, { key: `import:${jobId}:${Date.now()}` });
}

/**
 * Durable handler — runs every stage. Resumability model: each stage is
 * idempotent (plan ops converge via ExternalIdMap + natural keys), so a
 * crashed job simply re-runs its incomplete stage on the next attempt.
 */
export async function runImport(jobId: string, prisma: PrismaClient = db): Promise<void> {
  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
  const warnings: { entityType: string; externalId: string; message: string }[] = [];
  const warn = (msg: string) => warnings.push({ entityType: 'source', externalId: '', message: msg });
  const src = await sourceFor(job, warn);

  const ctx: ImportCtx = {
    prisma,
    job,
    resolve: async (entityType, externalId) =>
      (
        await prisma.externalIdMap.findUnique({
          where: { importJobId_entityType_externalId: { importJobId: job.id, entityType, externalId } },
        })
      )?.internalId ?? null,
    record: async (entityType, externalId, internalId) => {
      await prisma.externalIdMap.upsert({
        where: { importJobId_entityType_externalId: { importJobId: job.id, entityType, externalId } },
        create: { importJobId: job.id, entityType, externalId, internalId },
        update: { internalId },
      });
    },
    warn: (entityType, externalId, message) => {
      warnings.push({ entityType, externalId, message });
    },
    source: src,
  };

  const setStage = async (stage: string, stageData?: Partial<StageData>) => {
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        stage,
        ...(stageData
          ? { stageData: { ...(job.stageData as object), ...(job.stageData as StageData), ...stageData } as object }
          : {}),
        lastRunAt: new Date(),
      },
    });
  };

  try {
    // Clear any error a previous attempt left — a re-run in flight should not
    // keep advertising a stale failure through GET /migration/:id.
    await prisma.importJob.update({ where: { id: job.id }, data: { error: null } });

    // Self-heal legacy poison: older builds recorded internalId = externalId
    // whenever apply() warned and returned the source id. The hardened apply
    // contract can't create those rows, but they still sit in jobs imported
    // before the fix — purge so the affected ops re-plan and apply honestly.
    // (customField is exempt: its TrackForge PK literally is the Jira id.)
    await prisma.$executeRaw`
      DELETE FROM "ExternalIdMap"
      WHERE "importJobId" = ${job.id}
        AND "entityType" <> 'customField'
        AND "internalId" = "externalId"
    `;

    // ---- 048 preflight: confirm Server/DC + resolve instance-specific CF ids ----
    if (job.source === 'jira-server') {
      const sd = (job.stageData ?? {}) as StageData;
      const info = await src
        .get<{
          deploymentType?: string;
          version?: string;
          buildNumber?: number;
          baseUrl?: string;
        }>('/rest/api/2/serverInfo')
        .catch(() => null);
      if (info?.deploymentType === 'Cloud') {
        throw new JiraApiError(
          400,
          jiraError(['baseUrl is a Jira Cloud instance — use POST /api/internal/migration/jira-cloud instead'])
        );
      }
      const next: Partial<StageData> = {};
      if (info) {
        next.serverInfo = { version: info.version, buildNumber: info.buildNumber, baseUrl: info.baseUrl };
        const [maj, min] = String(info.version ?? '')
          .split('.')
          .map(Number);
        if (Number.isFinite(maj) && (maj < 8 || (maj === 8 && min < 20))) {
          warn(`Jira ${info.version} predates 8.20.6 — user enumeration may cap ~100 results (JSWSERVER-21156)`);
        }
      } else {
        warn('serverInfo unreachable — skipping version gate');
      }
      // FR-007: resolve instance-specific CF ids — schema.custom suffix first
      // (locale-independent: 'Enlace de épica' still ends in gh-epic-link),
      // then the name list. Re-resolved every run so new mappings reach
      // existing jobs; explicit overrides always win.
      const fields = await src
        .get<{ id: string; name: string; schema?: { custom?: string } }[]>('/rest/api/2/field')
        .catch(() => null);
      if (Array.isArray(fields)) {
        const resolved: Record<string, string> = {};
        for (const [alias, names] of Object.entries(SERVER_FIELD_ALIASES)) {
          const hit =
            fields.find((f) =>
              (SERVER_FIELD_SCHEMAS[alias] ?? []).some((s) => (f.schema?.custom ?? '').endsWith(s))
            ) ?? fields.find((f) => names.some((n) => f.name.toLowerCase() === n.toLowerCase()));
          if (hit) resolved[alias] = hit.id;
        }
        // Overrides: fieldAliasesInput on new jobs; pre-split jobs stored user
        // input (or a stale auto-map) in fieldAliases — merging it back keeps
        // both stable across renames without ever overriding fresh matches.
        const overrides = sd.fieldAliasesInput ?? sd.fieldAliases ?? {};
        next.fieldAliases = { ...resolved, ...overrides };
        if (!next.fieldAliases.storyPoints)
          warn('no Story Points field found by name — story points will not map');
        // labels-type CFs (com.atlassian.jira…customfieldtypes:labels) are
        // free-tag fields — their values merge into Issue.labels natively,
        // so issue map must know every id, not just a first match.
        next.labelsFieldIds = fields
          .filter((f) => String(f.schema?.custom ?? '').endsWith(':labels'))
          .map((f) => f.id);
      }
      if (Object.keys(next).length) {
        await prisma.importJob.update({
          where: { id: job.id },
          data: { stageData: { ...sd, ...next } as object },
        });
        (job as { stageData?: unknown }).stageData = { ...sd, ...next };
      }
    }

    // ---- discovering → planned: build the op list per entity ----
    await setStage('discovering');
    const reports: PlanReport[] = [];
    const progress: Record<string, { total: number; done: number }> = {};
    const plannedOps: (PlanOp & { importer: (typeof importerRegistry)[number] })[] = [];
    // Persist progress periodically — discovery and apply can each run for
    // tens of minutes; the API must not sit on stale counters the whole time.
    let lastProgressAt = Date.now();
    const persistProgress = async (force = false) => {
      if (!force && Date.now() - lastProgressAt < 15_000) return;
      lastProgressAt = Date.now();
      await prisma.importJob
        .update({
          where: { id: job.id },
          data: { stageData: { ...(job.stageData as StageData), progress } as object },
        })
        .catch(() => {});
    };

    for (const imp of importerRegistry) {
      const report: PlanReport = {
        entity: imp.entity,
        creates: 0,
        updates: 0,
        skips: 0,
        warnings: [],
        errors: [],
        ops: [],
      };
      let count = 0;
      // One entity's discovery must never abort the job — an unreachable or
      // misbehaving endpoint degrades to a report error and the run continues
      // with the remaining importers.
      try {
        for await (const raw of imp.discover(src, ctx)) {
          count++;
          try {
            const mapped = await imp.map(raw, ctx);
            for (const w of (mapped as any)?.warnings ?? [])
              report.warnings.push({ externalId: '', message: String(w) });
            const op = await imp.plan(mapped, ctx);
            report.ops.push(op);
            if (op.kind === 'create') report.creates++;
            else if (op.kind === 'update') report.updates++;
            else if (op.kind === 'skip' || op.kind === 'unsupported') report.skips++;
          } catch (e) {
            report.errors.push({ externalId: '?', message: (e as Error).message });
          }
        }
      } catch (e) {
        report.errors.push({ externalId: '', message: `discover aborted: ${(e as Error).message}` });
        ctx.warn(imp.entity, '', `discover aborted: ${(e as Error).message}`);
      }
      // zero-row importers still surface their unsupported marker
      if (count === 0 && imp.entity) {
        const ops = await plannedOpsForEmpty(imp);
        for (const op of ops) {
          report.ops.push(op);
          report.skips++;
        }
      }
      progress[imp.entity] = { total: count, done: 0 };
      reports.push(report);
      for (const op of report.ops) plannedOps.push({ ...op, importer: imp });
      await persistProgress();
    }

    const planSummary = Object.fromEntries(
      reports.map((r) => [
        r.entity,
        { creates: r.creates, updates: r.updates, skips: r.skips, errors: r.errors.length },
      ])
    );
    const unsupportedList = reports.flatMap((r) => r.ops.filter((o) => o.kind === 'unsupported').map((o) => o.entity));

    await setStage('mapping');
    await setStage('planned', { progress });
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        report: {
          plan: planSummary,
          unsupported: unsupportedList,
          warnings,
          reports: reports.map((r) => ({ ...r, ops: r.ops.slice(0, 200) })),
        } as object,
      },
    });

    if (job.dryRun) {
      await setStage('done');
      return;
    }

    // ---- importing: apply create/update ops ----
    await setStage('importing');
    const applyErrors: { entity: string; externalId: string; message: string }[] = [];
    for (const op of plannedOps) {
      if (op.kind !== 'create' && op.kind !== 'update') continue;
      try {
        // eslint-disable-next-line prefer-spread -- EntityImporter contract method, not Function.apply
        const internalId = await op.importer.apply(op, ctx);
        // Structural guard: a fake success returning the source id would
        // poison ExternalIdMap and make every later run "already imported".
        // (customField is exempt — its TrackForge PK literally is the Jira id.)
        if (internalId === op.externalId && op.entity !== 'customField')
          throw new Error(
            `${op.entity} ${op.externalId}: apply returned the external id — ` +
              `throw for retryable failures, return null for handled skips`
          );
        if (internalId != null) await ctx.record(op.entity, op.externalId, internalId);
        progress[op.entity].done++;
      } catch (e) {
        applyErrors.push({ entity: op.entity, externalId: op.externalId, message: (e as Error).message });
      }
      await persistProgress();
    }
    const report0 = ((await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).report ?? {}) as Record<
      string,
      unknown
    >;
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        stageData: { ...(job.stageData as StageData), progress } as object,
        report: { ...report0, applyErrors, warnings } as object,
      },
    });
    if (
      applyErrors.length &&
      applyErrors.length === plannedOps.filter((o) => o.kind === 'create' || o.kind === 'update').length
    ) {
      throw new Error(`all ${applyErrors.length} apply ops failed: ${applyErrors[0].message}`);
    }

    // ---- verifying ----
    await setStage('verifying');
    const verifies: VerifyResult[] = [];
    for (const imp of importerRegistry) {
      if (!imp.verify) continue;
      try {
        verifies.push(await imp.verify(src, ctx));
      } catch (e) {
        verifies.push({
          entity: imp.entity,
          expected: -1,
          imported: -1,
          diffs: [`verify failed: ${(e as Error).message}`],
        });
      }
    }
    const report1 = (await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).report as Record<
      string,
      unknown
    >;
    await prisma.importJob.update({
      where: { id: job.id },
      data: { report: { ...report1, verify: verifies } as object, stage: 'done' },
    });
  } catch (e) {
    await prisma.importJob
      .update({
        where: { id: job.id },
        data: { stage: 'failed', error: (e as Error).message },
      })
      .catch(() => {});
    throw e;
  }
}

/** Importers with zero discoverable rows still emit their unsupported marker once. */
async function plannedOpsForEmpty(imp: (typeof importerRegistry)[number]): Promise<PlanOp[]> {
  // call plan with a sentinel — unsupportedImporter returns its marker for any input
  try {
    const op = await imp.plan(null, null as unknown as ImportCtx);
    return op.kind === 'unsupported' ? [op] : [];
  } catch {
    return [];
  }
}

/** Called by the durable runner registration. */
export function registerImportHandlers(): void {
  getDurableRunner().register(IMPORT_JOB_QUEUE, async (payload) => {
    await runImport((payload as { jobId: string }).jobId);
  });
}
