import type { EntityImporter, ImportCtx, PlanOp } from './types.js';
import { adfToMarkdown } from './adfToMarkdown.js';
import { importAttachment, MAX_ATTACHMENT_BYTES } from '../services/attachmentService.js';

/**
 * Sprint 017 entity importers. `apply` writes via Prisma directly — bulk import
 * must not emit domain events / notification noise per row; provenance is via
 * ExternalIdMap. Entities out of scope return `not yet supported (sprint NNN)`
 * ops instead of being silently dropped.
 */

const skip = (entity: string, externalId: string, reason: string): PlanOp => ({
  kind: 'skip',
  entity,
  externalId,
  reason,
});
const unsupported = (entity: string, externalId: string, sprint: string): PlanOp => ({
  kind: 'unsupported',
  entity,
  externalId,
  sprint,
});

async function existing(ctx: ImportCtx, entity: string, externalId: string) {
  return ctx.resolve(entity, externalId);
}

/* ------------------------------ users ------------------------------ */

export const userImporter: EntityImporter<any, any> = {
  entity: 'user',
  async *discover(src) {
    yield* src.paged('/rest/api/3/users/search', undefined, { query: '', maxResults: 100 });
  },
  async map(raw) {
    return {
      accountId: String(raw.accountId ?? raw.key ?? raw.name ?? ''),
      email: raw.emailAddress ?? null,
      name: raw.displayName ?? raw.name ?? raw.emailAddress ?? 'Unknown',
      active: raw.active !== false,
    };
  },
  async plan(m, ctx) {
    if (!m.accountId && !m.email) return skip('user', m.accountId || '?', 'no accountId or email');
    const hit = await existing(ctx, 'user', m.accountId);
    if (hit)
      return { kind: 'update', entity: 'user', externalId: m.accountId, internalId: hit, summary: m.name, data: m };
    const byEmail = m.email ? await ctx.prisma.user.findUnique({ where: { email: m.email } }) : null;
    if (byEmail)
      return {
        kind: 'update',
        entity: 'user',
        externalId: m.accountId,
        internalId: byEmail.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'user', externalId: m.accountId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    if (op.kind === 'update') return op.internalId;
    const email = m.email ?? `jira-${m.accountId}@import.local`;
    // Jira users may share an email — a second create on the same address
    // converges onto the existing row so dependents still resolve.
    const existing = await ctx.prisma.user.findUnique({ where: { email } });
    if (existing) {
      ctx.warn('user', m.accountId, `email ${email} already taken — mapped onto user ${existing.id}`);
      return existing.id;
    }
    const u = await ctx.prisma.user
      .create({
        data: { email, displayName: m.name, passwordHash: '!imported', active: m.active },
      })
      .catch(async (e) => {
        const dup = await ctx.prisma.user.findUnique({ where: { email } });
        if (!dup) throw e;
        ctx.warn('user', m.accountId, `email ${email} already taken — mapped onto user ${dup.id}`);
        return dup;
      });
    return u.id;
  },
  async verify(src, ctx) {
    let expected = 0;
    const iter = this.discover(src, ctx)[Symbol.asyncIterator]();
    while (!(await iter.next()).done) expected++;
    const imported = await ctx.prisma.externalIdMap.count({ where: { importJobId: ctx.job.id, entityType: 'user' } });
    return {
      entity: 'user',
      expected,
      imported,
      diffs: expected === imported ? [] : [`${imported}/${expected} users mapped`],
    };
  },
};

/* ----------------------------- projects ----------------------------- */

export const projectImporter: EntityImporter<any, any> = {
  entity: 'project',
  dependsOn: ['user'],
  async *discover(src, ctx) {
    for (const key of ctx.job.projectKeys) {
      yield await src.get(`/rest/api/3/project/${key}`);
    }
  },
  async map(raw) {
    return {
      key: String(raw.key ?? raw.id ?? '').toUpperCase(),
      name: raw.name ?? raw.key ?? 'Imported',
      leadAccountId: raw.lead?.accountId ?? null,
      category: raw.projectCategory?.name ?? null,
      externalId: String(raw.id ?? raw.key),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'project', m.externalId);
    if (hit)
      return { kind: 'update', entity: 'project', externalId: m.externalId, internalId: hit, summary: m.key, data: m };
    const byKey = await ctx.prisma.project.findUnique({ where: { key: m.key } });
    if (byKey)
      return {
        kind: 'update',
        entity: 'project',
        externalId: m.externalId,
        internalId: byKey.id,
        summary: m.key,
        data: m,
      };
    return { kind: 'create', entity: 'project', externalId: m.externalId, summary: m.key, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const leadId = m.leadAccountId ? await ctx.resolve('user', m.leadAccountId) : null;
    const data = { name: m.name, leadId: leadId ?? ctx.job.actorId };
    if (op.kind === 'update') {
      await ctx.prisma.project.update({ where: { id: op.internalId }, data });
      return op.internalId;
    }
    const p = await ctx.prisma.project.create({ data: { key: m.key, ...data } });
    return p.id;
  },
};

/* ------------------------ metadata (types,status,prio,res) ------------------------ */

/** Shared importer shape for name-matched metadata entities. `createData`
 *  translates the mapped row into extra create/update columns (e.g. Status'
 *  required `category`) — apply re-checks by name because two Jira rows can
 *  share a name and both plan as 'create'. */
function metadataImporter(
  entity: string,
  path: string,
  table: 'issueType' | 'status' | 'priority' | 'resolution',
  extra: (raw: any) => Record<string, unknown> = () => ({}),
  createData: (m: any) => Record<string, unknown> = () => ({})
): EntityImporter<any, any> {
  const db = (ctx: ImportCtx) => (ctx.prisma as any)[table];
  return {
    entity,
    async *discover(src) {
      yield* src.paged(path);
    },
    async map(raw) {
      return { externalId: String(raw.id ?? raw.name), name: raw.name ?? '?', ...extra(raw) };
    },
    async plan(m, ctx) {
      const hit = await existing(ctx, entity, m.externalId);
      if (hit) return { kind: 'update', entity, externalId: m.externalId, internalId: hit, summary: m.name, data: m };
      const byName = await db(ctx).findFirst({ where: { name: { equals: m.name, mode: 'insensitive' } } });
      if (byName)
        return { kind: 'update', entity, externalId: m.externalId, internalId: byName.id, summary: m.name, data: m };
      return { kind: 'create', entity, externalId: m.externalId, summary: m.name, data: m };
    },
    async apply(op, ctx) {
      if (op.kind === 'update') {
        const extraCols = createData(op.data);
        if (Object.keys(extraCols).length) {
          await db(ctx).update({ where: { id: op.internalId }, data: extraCols });
        }
        return op.internalId;
      }
      const m = op.data as any;
      const byName = await db(ctx).findFirst({ where: { name: { equals: m.name, mode: 'insensitive' } } });
      if (byName) return byName.id; // same-named row planned 'create' earlier in this batch
      const row = await db(ctx).create({ data: { name: m.name, ...createData(m) } });
      return row.id;
    },
  };
}

export const issueTypeImporter = metadataImporter(
  'issueType',
  '/rest/api/3/issuetype',
  'issueType',
  (r) => ({ subtask: r.subtask === true, hierarchyLevel: r.hierarchyLevel ?? null }),
  // hierarchyLevel drives every epic/subtask surface (epic rail, epicsof JQL,
  // parent validation). Cloud beans carry it; Server/DC does not — subtask
  // types infer -1 there, and epic-level is inferred in issue.apply from
  // gh-epic-link targets. Never write 0 on update: that would clobber a
  // level an earlier issue pass already raised.
  (m) => ({
    isSubtask: m.subtask === true,
    ...(m.hierarchyLevel != null
      ? { hierarchyLevel: m.hierarchyLevel }
      : m.subtask
        ? { hierarchyLevel: -1 }
        : {}),
  })
);
// Jira statusCategory keys → TrackForge's category vocabulary.
const STATUS_CATEGORY: Record<string, string> = {
  new: 'todo',
  indeterminate: 'inprogress',
  done: 'done',
};
export const statusImporter = metadataImporter(
  'status',
  '/rest/api/3/status',
  'status',
  (r) => ({ category: r.statusCategory?.key }),
  (m) => ({ category: STATUS_CATEGORY[String(m.category ?? '')] ?? 'todo' })
);
export const priorityImporter = metadataImporter('priority', '/rest/api/3/priority', 'priority');
export const resolutionImporter = metadataImporter('resolution', '/rest/api/3/resolution', 'resolution');

/* ------------------------------- issues ------------------------------ */

/** Delta reruns narrow discovery to rows updated since the last import. */
function issueJql(ctx: ImportCtx, order = true): string {
  const delta = (ctx.job.stageData as { deltaFrom?: string } | null)?.deltaFrom;
  const base = `project in (${ctx.job.projectKeys.join(',')})`;
  const filter = delta ? `${base} AND updated >= "${delta}"` : base;
  return order ? `${filter} ORDER BY key ASC` : filter;
}

/** The issue bean's parent — Cloud `fields.parent` (subtasks + next-gen
 *  epics) or the Server gh-epic-link CF holding the epic key. Shared by
 *  discover (ordering) and map (data) so they never disagree. */
function rawParentKey(raw: any, parentFields: (string | null)[]): string | null {
  const f = raw.fields ?? {};
  if (f.parent?.key) return String(f.parent.key);
  for (const field of parentFields) {
    const v = field ? f[field] : null;
    const key = typeof v === 'string' ? v : (v?.key ?? v?.value ?? null);
    if (key) return key;
  }
  return null;
}

export const issueImporter: EntityImporter<any, any> = {
  entity: 'issue',
  dependsOn: ['project', 'issueType', 'status', 'priority', 'user'],
  async *discover(src, ctx) {
    const jql = issueJql(ctx);
    const sdAliases = (ctx?.job?.stageData as { fieldAliases?: Record<string, string> } | null)?.fieldAliases;
    const parentFields = [sdAliases?.epicLink ?? null, sdAliases?.jpoParent ?? null];
    // key-ASC order does NOT guarantee parents precede children (an epic
    // created to group existing stories gets a higher key). Buffer children
    // until their parent emits so apply-time parent lookups always resolve;
    // children of out-of-scope/missing parents flush at the end and warn.
    const emitted = new Set<string>();
    const pending = new Map<string, any[]>(); // parentKey -> waiting children
    const release = function* (key: string): Generator<any> {
      for (const child of pending.get(key) ?? []) {
        emitted.add(String(child.key));
        yield child;
        yield* release(String(child.key)); // unblock grandchildren
      }
      pending.delete(key);
    };
    for await (const raw of src.paged<any>('/rest/api/3/search', 'issues', { jql })) {
      const key = String(raw.key);
      const pk = rawParentKey(raw, parentFields);
      if (pk && pk !== key && !emitted.has(pk)) {
        (pending.get(pk) ?? pending.set(pk, []).get(pk)!).push(raw);
        continue;
      }
      emitted.add(key);
      yield raw;
      yield* release(key);
    }
    // Parents that never arrived (out of scope / filtered): emit children
    // anyway — chain roots first so deeper links still resolve; leftovers
    // (cycles) emit last and warn at apply.
    const childKeys = new Set([...pending.values()].flat().map((r) => String(r.key)));
    for (const root of [...pending.keys()].filter((k) => !childKeys.has(k))) yield* release(root);
    for (const children of pending.values()) for (const raw of children) yield raw;
  },
  async map(raw, ctx) {
    const f = raw.fields ?? {};
    const warnings: string[] = [];
    const md = adfToMarkdown(f.description, (m) => warnings.push(`description: ${m}`));
    // 048: CF ids are instance-specific on Server — preflight resolves them by
    // name into stageData.fieldAliases; Cloud jobs keep the conventional ids.
    const sd = ctx?.job?.stageData as
      | { fieldAliases?: Record<string, string>; labelsFieldIds?: string[] }
      | null
      | undefined;
    const aliases = sd?.fieldAliases ?? {};
    const spField = aliases.storyPoints ?? 'customfield_10016';
    const flagField = aliases.flagged ?? 'customfield_10021';
    const sprintField = aliases.sprint ?? null;
    const epicLinkField = aliases.epicLink ?? null;
    const epicNameField = aliases.epicName ?? null;
    const rankField = aliases.rank ?? null;
    const jpoParentField = aliases.jpoParent ?? null;
    // labels-type CFs are free-tag fields — merge their values into the native
    // Issue.labels array rather than opaque CF storage.
    const labelsFieldIds = new Set(sd?.labelsFieldIds ?? []);
    const cfLabels = [...labelsFieldIds]
      .flatMap((id) => (Array.isArray(f[id]) ? f[id] : f[id] == null ? [] : [f[id]]))
      .filter((v): v is string => typeof v === 'string');
    // CF values ride along — the column-mapped fields above are excluded.
    const cfValues: Record<string, unknown> = {};
    const columnFields = new Set(
      [spField, flagField, sprintField, epicLinkField, epicNameField, rankField, jpoParentField].filter(
        (x): x is string => Boolean(x)
      )
    );
    for (const id of labelsFieldIds) columnFields.add(id);
    for (const [k, v] of Object.entries(f)) {
      if (k.startsWith('customfield_') && !columnFields.has(k) && v != null) {
        cfValues[k] = v;
      }
    }
    // Server stores sprints as greenhopper strings/objects under a CF id —
    // the last entry is the current sprint.
    const sprintRef = (sprintField ? f[sprintField] : null) ?? f.sprint;
    // Greenhopper sprint strings embed `name=…` inside a bracketed bean;
    // sprint names legitimately contain ']' ("[26 FEB] Team") — capture up to
    // the next `,key=` pair or the bean's closing bracket, never the first ']'.
    const sprintName = Array.isArray(sprintRef)
      ? (sprintRef
          .map((s) => (typeof s === 'string' ? (s.match(/name=(.*?)(?=,\w+=|\]$)/)?.[1] ?? s) : s?.name))
          .filter(Boolean)
          .pop() ?? null)
      : (sprintRef?.name ?? null);
    // Jira Server epic links live in the gh-epic-link CF holding the epic KEY
    // — folded into parentKey so apply resolves it exactly like fields.parent.
    // Portfolio jpo-parent chains an epic up to its initiative the same way.
    const parentKey = rawParentKey(raw, [epicLinkField, jpoParentField]);
    const epicName = epicNameField ? (typeof f[epicNameField] === 'string' ? f[epicNameField] : null) : null;
    return {
      externalId: String(raw.id ?? raw.key),
      key: raw.key,
      projectKey: String(raw.key ?? '').split('-')[0],
      projectExternalId: String(f.project?.id ?? ''),
      summary: f.summary || epicName || '(no summary)',
      description: md,
      typeName: f.issuetype?.name ?? 'Task',
      statusName: f.status?.name ?? 'To Do',
      priorityName: f.priority?.name ?? null,
      resolutionName: f.resolution?.name ?? null,
      assigneeAccountId: f.assignee?.accountId ?? null,
      reporterAccountId: f.reporter?.accountId ?? null,
      labels: [...new Set([...((f.labels ?? []) as string[]), ...cfLabels])],
      // gh-lexo-rank verbatim — lib/lexorank decodes '0|…' foreign formats by
      // design, so remote backlog order survives the move.
      rank: rankField && typeof f[rankField] === 'string' ? f[rankField] : null,
      dueDate: f.duedate ?? null,
      parentKey,
      storyPoints: f[spField] ?? null,
      originalEstimateSec: f.timeoriginalestimate ?? null,
      remainingEstimateSec: f.timeestimate ?? null,
      flagged: !!(f.flagged?.length || f[flagField]),
      created: f.created ?? null,
      updated: f.updated ?? null,
      // 019: release collections — Jira ids resolved via ctx maps at apply
      // 039: CSV/XML sources emit fields.sprint.name — resolved to an
      // IssueSprint membership at apply (sprintImporter creates the rows).
      sprintName,
      componentIds: (f.components ?? []).map((c: any) => ({ extId: String(c.id), name: c.name ?? null })),
      fixVersionIds: (f.fixVersions ?? []).map((v: any) => ({ extId: String(v.id), name: v.name ?? null })),
      affectsVersionIds: (f.versions ?? []).map((v: any) => ({ extId: String(v.id), name: v.name ?? null })),
      cfValues,
      warnings,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'issue', m.externalId);
    if (hit)
      return { kind: 'update', entity: 'issue', externalId: m.externalId, internalId: hit, summary: m.key, data: m };
    const num = Number(String(m.key).split('-')[1]) || 0;
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (project && num) {
      const byNum = await ctx.prisma.issue.findUnique({
        where: { projectId_issueNumber: { projectId: project.id, issueNumber: num } },
      });
      if (byNum)
        return {
          kind: 'update',
          entity: 'issue',
          externalId: m.externalId,
          internalId: byNum.id,
          summary: m.key,
          data: m,
        };
    }
    return { kind: 'create', entity: 'issue', externalId: m.externalId, summary: m.key, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const projectId =
      (m.projectExternalId ? await ctx.resolve('project', m.projectExternalId) : null) ??
      (await ctx.prisma.project.findUnique({ where: { key: m.projectKey } }))?.id;
    if (!projectId) throw new Error(`issue ${m.key}: project ${m.projectKey} not imported`);
    const metaByName = async (table: 'issueType' | 'status' | 'priority' | 'resolution', name: string | null) => {
      if (!name) return null;
      const row = await (ctx.prisma as any)[table].findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
      });
      return row?.id ?? null;
    };
    const [issueTypeId, statusId, resolutionId, assigneeId, reporterId] = await Promise.all([
      metaByName('issueType', m.typeName).then(
        async (id) => id ?? (await ctx.prisma.issueType.findFirst({ where: { name: 'Task' } }))?.id ?? null
      ),
      metaByName('status', m.statusName).then(
        async (id) => id ?? (await ctx.prisma.status.findFirst({ orderBy: { sequence: 'asc' } }))?.id ?? null
      ),
      metaByName('resolution', m.resolutionName),
      m.assigneeAccountId ? ctx.resolve('user', m.assigneeAccountId) : null,
      m.reporterAccountId ? ctx.resolve('user', m.reporterAccountId) : null,
    ]);
    const priorityId =
      (await metaByName('priority', m.priorityName)) ??
      (await ctx.prisma.priority.findFirst({ where: { name: 'Medium' } }))?.id ??
      (await ctx.prisma.priority.findFirst({ orderBy: { sequence: 'asc' } }))?.id;
    if (!issueTypeId || !statusId || !priorityId) {
      throw new Error(
        `issue ${m.key}: unresolved metadata (type=${m.typeName} status=${m.statusName} priority=${m.priorityName})`
      );
    }
    const parentRow = m.parentKey
      ? await (async () => {
          const [pk, pn] = String(m.parentKey).split('-');
          const pp = await ctx.prisma.project.findUnique({ where: { key: pk } });
          return pp
            ? await ctx.prisma.issue.findUnique({
                where: { projectId_issueNumber: { projectId: pp.id, issueNumber: Number(pn) || 0 } },
                select: { id: true, effSecurityLevelId: true, issueTypeId: true },
              })
            : null;
        })()
      : null;
    if (m.parentKey && !parentRow)
      ctx.warn('issue', m.externalId, `parent ${m.parentKey} not found (unimported or out of scope)`);
    const parentId = parentRow?.id ?? null;
    // Epic inference: a non-subtask issue's parent IS its epic. Server exposes
    // no per-type epic flag (no hierarchyLevel in /issuetype), so gh-epic-link
    // targets are what mark a type epic-level — raise it here, never lower.
    // Generalized to childLevel+1 so Portfolio jpo-parent chains (epic →
    // initiative) promote the parent type above the child's own level.
    if (parentRow && issueTypeId) {
      const childType = await ctx.prisma.issueType.findUnique({
        where: { id: issueTypeId },
        select: { isSubtask: true, hierarchyLevel: true },
      });
      if (childType && !childType.isSubtask) {
        const parentLevel = childType.hierarchyLevel + 1;
        await ctx.prisma.issueType.updateMany({
          where: { id: parentRow.issueTypeId, hierarchyLevel: { lt: parentLevel } },
          data: { hierarchyLevel: parentLevel },
        });
      }
    }
    const num = Number(String(m.key).split('-')[1]) || 0;
    const data = {
      summary: m.summary,
      description: m.description,
      issueTypeId,
      statusId,
      priorityId,
      resolutionId,
      assigneeId,
      reporterId,
      parentId,
      // imports never set an own level — inherited effective level only
      effSecurityLevelId: parentRow?.effSecurityLevelId ?? null,
      dueDate: m.dueDate ? new Date(m.dueDate) : null,
      labels: m.labels,
      storyPoints: m.storyPoints == null ? null : Number(m.storyPoints),
      originalEstimateSec: m.originalEstimateSec == null ? null : Number(m.originalEstimateSec),
      remainingEstimateSec: m.remainingEstimateSec == null ? null : Number(m.remainingEstimateSec),
      ...(m.rank ? { rank: m.rank } : {}),
      ...(m.created ? { createdAt: new Date(m.created) } : {}),
    };
    let issueId: string;
    if (op.kind === 'update') {
      issueId = op.internalId;
      await ctx.prisma.issue.update({ where: { id: issueId }, data });
    } else {
      const issue = await ctx.prisma.issue.create({ data: { issueNumber: num, projectId, ...data } });
      issueId = issue.id;
      await ctx.prisma.project.updateMany({
        where: { id: projectId, issueCounter: { lt: num } },
        data: { issueCounter: num },
      });
    }
    // flagged → system CF (registered 014)
    if (m.flagged) {
      const cf = await ctx.prisma.customField.findFirst({ where: { OR: [{ alias: 'flagged' }, { name: 'Flagged' }] } });
      if (cf) {
        await ctx.prisma.customFieldValue.upsert({
          where: { issueId_fieldId: { issueId, fieldId: cf.id } },
          create: { issueId, fieldId: cf.id, value: ['Impediment'] },
          update: { value: ['Impediment'] },
        });
      }
    }
    // generic CF values
    for (const [extFieldId, rawValue] of Object.entries(m.cfValues ?? {})) {
      await writeImportedCfValue(ctx, issueId, extFieldId, rawValue);
    }
    // 019: component/version joins — resolve via the entity maps first,
    // fall back to project-scoped name match for pre-existing rows.
    const resolveRefs = async (entity: 'component' | 'version', refs: { extId: string; name: string | null }[]) => {
      const ids: string[] = [];
      for (const r of refs ?? []) {
        const hit = await ctx.resolve(entity, r.extId);
        if (hit) {
          ids.push(hit);
          continue;
        }
        const byName = r.name
          ? await (ctx.prisma as any)[entity].findFirst({
              where: { projectId, name: { equals: r.name, mode: 'insensitive' } },
            })
          : null;
        if (byName) ids.push(byName.id);
        else ctx.warn('issue', m.externalId, `${entity} '${r.name ?? r.extId}' not imported`);
      }
      return ids;
    };
    await ctx.prisma.issueComponent.deleteMany({ where: { issueId } });
    for (const componentId of await resolveRefs('component', m.componentIds)) {
      await ctx.prisma.issueComponent.create({ data: { issueId, componentId } });
    }
    for (const [kind, refs] of [
      ['fix', m.fixVersionIds],
      ['affects', m.affectsVersionIds],
    ] as const) {
      await ctx.prisma.issueVersion.deleteMany({ where: { issueId, kind } });
      for (const versionId of await resolveRefs('version', refs)) {
        await ctx.prisma.issueVersion.create({ data: { issueId, versionId, kind } });
      }
    }
    // 039: sprint membership — sprintImporter creates the rows (same job,
    // applies later) but issues resolve by name against whatever exists.
    if (m.sprintName) {
      const sprint = await ctx.prisma.sprint.findFirst({
        where: { projectId, name: { equals: m.sprintName, mode: 'insensitive' } },
      });
      if (sprint) {
        const open = await ctx.prisma.issueSprint.findFirst({
          where: { issueId, sprintId: sprint.id, removedAt: null },
        });
        if (!open) await ctx.prisma.issueSprint.create({ data: { issueId, sprintId: sprint.id } });
        // `Issue.sprintId` is the denormalized "current sprint" pointer board
        // and sprint views read (Jira's fields.sprint = latest association) —
        // the join row alone leaves those views empty.
        await ctx.prisma.issue.update({ where: { id: issueId }, data: { sprintId: sprint.id } });
      } else {
        ctx.warn('issue', m.externalId, `sprint '${m.sprintName}' not found`);
      }
    }
    return issueId;
  },
  async verify(src, ctx) {
    // Headline parity check: source JQL total vs issues this job mapped.
    const page = await src.get<{ total?: number }>('/rest/api/3/search', {
      jql: issueJql(ctx, false),
      maxResults: 0,
    });
    const expected = Number(page?.total ?? -1);
    const imported = await ctx.prisma.externalIdMap.count({
      where: { importJobId: ctx.job.id, entityType: 'issue' },
    });
    const diffs: string[] = [];
    if (expected !== imported) diffs.push(`${imported}/${expected} issues mapped`);
    // Per-status distribution — an all-fallback import (every issue on the
    // default status) hides behind a correct headline count — plus sprint
    // coverage: remote issues carrying a sprint vs local `sprintId` pointers.
    // One extra search pass, fixture-compatible.
    const sprintField =
      (ctx.job.stageData as { fieldAliases?: Record<string, string> } | null)?.fieldAliases?.sprint ??
      'sprint';
    const epicField = (ctx.job.stageData as { fieldAliases?: Record<string, string> } | null)?.fieldAliases
      ?.epicLink;
    const remoteByName = new Map<string, number>();
    let remoteSprint = 0;
    let remoteEpic = 0;
    for await (const i of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx, false),
      fields: `status,issuetype,${sprintField}${epicField ? `,${epicField}` : ''}`,
    })) {
      const name = i.fields?.status?.name ?? '(none)';
      remoteByName.set(name, (remoteByName.get(name) ?? 0) + 1);
      const sv = i.fields?.[sprintField];
      if (sv != null && !(Array.isArray(sv) && sv.length === 0)) remoteSprint++;
      // Epic-linked = non-subtask with a parent (Cloud) or epic-link CF
      // (Server) — only in-scope targets count; links into unimported
      // projects warn at apply instead of diffing here.
      const ev = epicField ? i.fields?.[epicField] : null;
      const parentRef = i.fields?.parent?.key ?? (ev != null && ev !== '' ? ev : null);
      const parentProj = String(typeof parentRef === 'object' ? parentRef?.key ?? '' : parentRef ?? '').split('-')[0];
      if (i.fields?.issuetype?.subtask !== true && parentProj && ctx.job.projectKeys.includes(parentProj))
        remoteEpic++;
    }
    const localRows = await ctx.prisma.issue.groupBy({
      by: ['statusId'],
      where: { project: { key: { in: ctx.job.projectKeys } } },
      _count: { _all: true },
    });
    const names = new Map(
      (
        await ctx.prisma.status.findMany({
          where: { id: { in: localRows.map((r) => r.statusId) } },
        })
      ).map((s) => [s.id, s.name]),
    );
    const localByName = new Map<string, number>();
    for (const r of localRows)
      localByName.set(names.get(r.statusId) ?? r.statusId, r._count._all);
    for (const [name, remoteN] of remoteByName) {
      const localN = localByName.get(name) ?? 0;
      if (localN !== remoteN) diffs.push(`status '${name}': ${localN}/${remoteN} issues`);
    }
    const localSprint = await ctx.prisma.issue.count({
      where: { project: { key: { in: ctx.job.projectKeys } }, sprintId: { not: null } },
    });
    if (localSprint !== remoteSprint)
      diffs.push(`sprint membership: ${localSprint}/${remoteSprint} issues with sprint`);
    // Epic-linked locally = non-subtask issues with a parentId — subtask
    // parents don't count (they're tracked separately via fields.parent).
    const localEpic = await ctx.prisma.issue.count({
      where: {
        project: { key: { in: ctx.job.projectKeys } },
        parentId: { not: null },
        issueType: { isSubtask: false },
      },
    });
    if (localEpic !== remoteEpic)
      diffs.push(`epic links: ${localEpic}/${remoteEpic} issues parented to epics`);
    return { entity: 'issue', expected, imported, diffs };
  },
};

/* ------------------------------ comments ------------------------------ */

export const commentImporter: EntityImporter<any, any> = {
  entity: 'comment',
  dependsOn: ['issue', 'user'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'comment',
    })) {
      for (const c of issue.fields?.comment?.comments ?? []) {
        yield { ...c, _issueId: issue.id, _issueKey: issue.key };
      }
    }
  },
  async map(raw, _ctx) {
    const warnings: string[] = [];
    return {
      externalId: String(raw.id),
      issueExternalId: String(raw._issueId),
      issueKey: raw._issueKey,
      body: adfToMarkdown(raw.body, (m) => warnings.push(`comment ${raw.id}: ${m}`)),
      authorAccountId: raw.author?.accountId ?? null,
      created: raw.created ?? null,
      updated: raw.updated ?? null,
      warnings,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'comment', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'comment',
        externalId: m.externalId,
        internalId: hit,
        summary: m.externalId,
        data: m,
      };
    return { kind: 'create', entity: 'comment', externalId: m.externalId, summary: `${m.issueKey} comment`, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const issueId = await ctx.resolve('issue', m.issueExternalId);
    if (!issueId) throw new Error(`comment ${m.externalId}: parent issue ${m.issueKey} not imported`);
    if (op.kind === 'update') {
      await ctx.prisma.comment.update({ where: { id: op.internalId }, data: { body: m.body } });
      return op.internalId;
    }
    const authorId = m.authorAccountId ? await ctx.resolve('user', m.authorAccountId) : null;
    const c = await ctx.prisma.comment.create({
      data: {
        body: m.body,
        issueId,
        authorId: authorId ?? ctx.job.actorId,
        ...(m.created ? { createdAt: new Date(m.created) } : {}),
        ...(m.updated ? { updatedAt: new Date(m.updated) } : {}),
      },
    });
    return c.id;
  },
};

/* ------------------------------ worklogs (024) -------------------------- */

export const worklogImporter: EntityImporter<any, any> = {
  entity: 'worklog',
  dependsOn: ['issue', 'user'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'summary',
    })) {
      const page = await src.get<any>(`/rest/api/3/issue/${issue.key}/worklog`).catch(() => null);
      for (const w of page?.worklogs ?? []) {
        yield { ...w, _issueId: issue.id, _issueKey: issue.key };
      }
    }
  },
  async map(raw) {
    const warnings: string[] = [];
    return {
      externalId: String(raw.id),
      issueExternalId: String(raw._issueId),
      issueKey: raw._issueKey,
      authorAccountId: raw.author?.accountId ?? null,
      comment: raw.comment ? adfToMarkdown(raw.comment, (m) => warnings.push(`worklog ${raw.id}: ${m}`)) : null,
      started: raw.started ?? null,
      timeSpentSec: Number(raw.timeSpentSeconds ?? 0),
      warnings,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'worklog', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'worklog',
        externalId: m.externalId,
        internalId: hit,
        summary: m.externalId,
        data: m,
      };
    return { kind: 'create', entity: 'worklog', externalId: m.externalId, summary: `${m.issueKey} worklog`, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const issueId = await ctx.resolve('issue', m.issueExternalId);
    if (!issueId) throw new Error(`worklog ${m.externalId}: parent issue ${m.issueKey} not imported`);
    const authorId = m.authorAccountId ? await ctx.resolve('user', m.authorAccountId) : null;
    if (op.kind === 'update') {
      await ctx.prisma.worklog.update({
        where: { id: op.internalId },
        data: {
          comment: m.comment,
          timeSpentSec: m.timeSpentSec,
          ...(m.started ? { started: new Date(m.started) } : {}),
        },
      });
      return op.internalId;
    }
    const w = await ctx.prisma.worklog.create({
      data: {
        issueId,
        authorId: authorId ?? ctx.job.actorId,
        comment: m.comment,
        timeSpentSec: m.timeSpentSec,
        billable: false,
        started: m.started ? new Date(m.started) : new Date(),
      },
    });
    return w.id;
  },
};

/* ------------------------------ attachments (018) ------------------------- */

export const attachmentImporter: EntityImporter<any, any> = {
  entity: 'attachment',
  dependsOn: ['issue', 'user'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'attachment',
    })) {
      for (const a of issue.fields?.attachment ?? []) {
        yield { ...a, _issueId: issue.id, _issueKey: issue.key };
      }
    }
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      issueExternalId: String(raw._issueId),
      issueKey: raw._issueKey,
      filename: raw.filename ?? 'file',
      mimeType: raw.mimeType ?? 'application/octet-stream',
      size: Number(raw.size ?? 0),
      contentUrl: raw.content ?? null,
      authorAccountId: raw.author?.accountId ?? null,
      created: raw.created ?? null,
    };
  },
  async plan(m, ctx) {
    // Dedupe across jobs too — Jira attachment ids are unique per instance, so a
    // re-run/new job must not duplicate bytes (ExternalIdMap is per-job scoped).
    const prev = await ctx.prisma.externalIdMap.findFirst({
      where: { entityType: 'attachment', externalId: m.externalId },
      select: { internalId: true },
    });
    if (prev && (await ctx.prisma.attachment.findUnique({ where: { id: prev.internalId }, select: { id: true } }))) {
      return skip('attachment', m.externalId, 'already imported');
    }
    if (m.size > MAX_ATTACHMENT_BYTES) {
      return skip(
        'attachment',
        m.externalId,
        `file exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB attachment limit`
      );
    }
    if (!m.contentUrl || !ctx.source?.getBinary) {
      return skip('attachment', m.externalId, 'source cannot stream attachment bytes');
    }
    return {
      kind: 'create',
      entity: 'attachment',
      externalId: m.externalId,
      summary: `${m.issueKey} ${m.filename}`,
      data: m,
    };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const issueId = await ctx.resolve('issue', m.issueExternalId);
    if (!issueId) throw new Error(`attachment ${m.externalId}: parent issue ${m.issueKey} not imported`);
    const buffer = await ctx.source!.getBinary!(m.contentUrl);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment ${m.externalId}: downloaded ${buffer.length}B exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB limit`
      );
    }
    const issue = await ctx.prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { id: true, projectId: true },
    });
    const authorId = m.authorAccountId ? await ctx.resolve('user', m.authorAccountId) : null;
    const a = await importAttachment(
      issue,
      { filename: m.filename, mime: m.mimeType, size: buffer.length, buffer },
      { authorId: authorId ?? ctx.job.actorId, createdAt: m.created ? new Date(m.created) : null }
    );
    return a.id;
  },
};

/* ------------------------------ watchers ------------------------------ */

export const watcherImporter: EntityImporter<any, any> = {
  entity: 'watcher',
  dependsOn: ['issue', 'user'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'summary',
    })) {
      const watchers = await src.get<any>(`/rest/api/3/issue/${issue.key}/watchers`).catch(() => null);
      for (const w of watchers?.watchers ?? []) {
        yield { accountId: w.accountId, _issueId: issue.id, _issueKey: issue.key };
      }
    }
  },
  async map(raw) {
    return {
      externalId: `${raw._issueId}:${raw.accountId}`,
      issueExternalId: String(raw._issueId),
      userExternalId: String(raw.accountId),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'watcher', m.externalId);
    if (hit) return skip('watcher', m.externalId, 'already imported');
    return { kind: 'create', entity: 'watcher', externalId: m.externalId, summary: m.externalId, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const issueId = await ctx.resolve('issue', m.issueExternalId);
    const userId = await ctx.resolve('user', m.userExternalId);
    // Missing job-scope deps must throw: warn+return records a bogus mapping
    // and every later run then plans the op as 'already imported' — a
    // permanent silent drop of recoverable data.
    if (!issueId || !userId) {
      throw new Error(`watcher ${m.externalId}: ${!issueId ? 'issue' : 'user'} not imported`);
    }
    const w = await ctx.prisma.watcher.upsert({
      where: { issueId_userId: { issueId, userId } },
      create: { issueId, userId },
      update: {},
    });
    return w.id;
  },
};

/* ------------------------- votes + remote links (022) ------------------------ */

export const issueVoteImporter: EntityImporter<any, any> = {
  entity: 'issueVote',
  dependsOn: ['issue', 'user'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'summary',
    })) {
      const votes = await src.get<any>(`/rest/api/3/issue/${issue.key}/votes`).catch(() => null);
      for (const v of votes?.voters ?? []) {
        yield { accountId: v.accountId, _issueId: issue.id, _issueKey: issue.key };
      }
    }
  },
  async map(raw) {
    return {
      externalId: `${raw._issueId}:${raw.accountId}`,
      issueExternalId: String(raw._issueId),
      userExternalId: String(raw.accountId),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'issueVote', m.externalId);
    if (hit) return skip('issueVote', m.externalId, 'already imported');
    return { kind: 'create', entity: 'issueVote', externalId: m.externalId, summary: m.externalId, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const issueId = await ctx.resolve('issue', m.issueExternalId);
    const userId = await ctx.resolve('user', m.userExternalId);
    if (!issueId || !userId) {
      throw new Error(`issueVote ${m.externalId}: ${!issueId ? 'issue' : 'user'} not imported`);
    }
    const v = await ctx.prisma.issueVote.upsert({
      where: { issueId_userId: { issueId, userId } },
      create: { issueId, userId },
      update: {},
    });
    return v.id;
  },
};

export const remoteLinkImporter: EntityImporter<any, any> = {
  entity: 'remoteLink',
  dependsOn: ['issue'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'summary',
    })) {
      const links = await src.get<any>(`/rest/api/3/issue/${issue.key}/remotelink`).catch(() => null);
      for (const l of links ?? []) {
        yield { ...l, _issueId: issue.id, _issueKey: issue.key };
      }
    }
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      issueExternalId: String(raw._issueId),
      url: raw.object?.url ?? '',
      title: raw.object?.title ?? '',
      summary: raw.object?.summary ?? null,
      globalId: raw.globalId ?? null,
      iconUrl: raw.object?.icon?.url16x16 ?? null,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'remoteLink', m.externalId);
    if (hit) return skip('remoteLink', m.externalId, 'already imported');
    return { kind: 'create', entity: 'remoteLink', externalId: m.externalId, summary: m.title || m.url, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const issueId = await ctx.resolve('issue', m.issueExternalId);
    // The carrying issue is in-scope by construction — a miss means its apply
    // failed, which a retry can heal.
    if (!issueId) throw new Error(`remoteLink ${m.externalId}: issue not imported`);
    const l = await ctx.prisma.remoteIssueLink.create({
      data: { issueId, url: m.url, title: m.title, summary: m.summary, globalId: m.globalId, iconUrl: m.iconUrl },
    });
    return l.id;
  },
};

/* ------------------------------- sprints ------------------------------ */

export const sprintImporter: EntityImporter<any, any> = {
  entity: 'sprint',
  dependsOn: ['project'],
  async *discover(src, ctx) {
    for (const key of ctx.job.projectKeys) {
      const boards = await src.get<any>('/rest/agile/1.0/board', { projectKeyOrId: key }).catch(() => null);
      for (const b of boards?.values ?? []) {
        // Kanban/simple boards have no sprint endpoint (Jira 400s); a single
        // failing board must not abort the whole discovery either.
        if (b.type && String(b.type).toLowerCase() !== 'scrum') continue;
        try {
          for await (const s of src.paged<any>(`/rest/agile/1.0/board/${b.id}/sprint`, 'values')) {
            yield { ...s, _boardId: b.id, _projectKey: key };
          }
        } catch (e) {
          ctx.warn('sprint', String(b.id), `board ${b.id} sprints skipped: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    }
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      name: raw.name ?? 'Sprint',
      state: raw.state ?? 'future',
      goal: raw.goal ?? null,
      startDate: raw.startDate ?? null,
      endDate: raw.endDate ?? null,
      projectKey: raw._projectKey,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'sprint', m.externalId);
    if (hit)
      return { kind: 'update', entity: 'sprint', externalId: m.externalId, internalId: hit, summary: m.name, data: m };
    return { kind: 'create', entity: 'sprint', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (!project) throw new Error(`sprint ${m.externalId}: project ${m.projectKey} not imported`);
    let board = await ctx.prisma.board.findFirst({ where: { projectId: project.id } });
    if (!board) {
      board = await ctx.prisma.board.create({
        data: { projectId: project.id, name: `${project.key} board`, type: 'scrum' },
      });
    }
    const state = m.state === 'closed' ? 'closed' : m.state === 'active' ? 'active' : 'future';
    const data = {
      name: m.name,
      state,
      goal: m.goal,
      startDate: m.startDate ? new Date(m.startDate) : null,
      endDate: m.endDate ? new Date(m.endDate) : null,
    };
    if (op.kind === 'update') {
      await ctx.prisma.sprint.update({ where: { id: op.internalId }, data });
      return op.internalId;
    }
    const s = await ctx.prisma.sprint.create({ data: { ...data, projectId: project.id, boardId: board.id } });
    return s.id;
  },
};

/* -------------------------------- groups ------------------------------ */

export const groupImporter: EntityImporter<any, any> = {
  entity: 'group',
  async *discover(src) {
    const res = await src.get<any>('/rest/api/3/groups/picker', { query: '' }).catch(() => null);
    for (const g of res?.groups ?? []) yield g;
  },
  async map(raw) {
    return { externalId: String(raw.groupId ?? raw.name), name: raw.name ?? String(raw.groupId) };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'group', m.externalId);
    if (hit) return skip('group', m.externalId, 'already imported');
    const byName = await ctx.prisma.group.findUnique({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'group',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'group', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    if (op.kind === 'update') return op.internalId;
    const g = await ctx.prisma.group.create({ data: { name: (op.data as any).name } });
    return g.id;
  },
};

/* --------------------------- issue link types --------------------------- */

export const issueLinkTypeImporter: EntityImporter<any, any> = {
  entity: 'issueLinkType',
  async *discover(src) {
    const res = await src.get<any>('/rest/api/3/issueLinkType').catch(() => null);
    for (const t of res?.issueLinkTypes ?? []) yield t;
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      name: raw.name ?? '?',
      inward: raw.inward ?? 'is linked by',
      outward: raw.outward ?? 'links to',
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'issueLinkType', m.externalId);
    if (hit) return skip('issueLinkType', m.externalId, 'already imported');
    const byName = await ctx.prisma.issueLinkType.findUnique({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'issueLinkType',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'issueLinkType', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    if (op.kind === 'update') return op.internalId;
    const m = op.data as any;
    const t = await ctx.prisma.issueLinkType.create({ data: { name: m.name, inward: m.inward, outward: m.outward } });
    return t.id;
  },
};

/* ------------------------------ issue links ------------------------------ */

export const issueLinkImporter: EntityImporter<any, any> = {
  entity: 'issueLink',
  dependsOn: ['issue', 'issueLinkType'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'issuelinks',
    })) {
      for (const l of issue.fields?.issuelinks ?? []) {
        yield { ...l, _fromId: issue.id, _fromKey: issue.key };
      }
    }
  },
  async map(raw) {
    const other = raw.outwardIssue ?? raw.inwardIssue;
    return {
      externalId: String(raw.id),
      typeExternalId: String(raw.type?.id ?? ''),
      typeName: raw.type?.name ?? '?',
      // Jira: `outwardIssue` on a link means the source issue is the outward
      // end ("A blocks B" shown on A as outwardIssue=B); `inwardIssue` mirrors.
      outwardId: raw.outwardIssue ? String(raw._fromId) : String(raw.inwardIssue?.id ?? ''),
      inwardId: raw.outwardIssue ? String(raw.outwardIssue.id) : String(raw._fromId),
      otherKey: other?.key ?? '?',
      fromKey: raw._fromKey,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'issueLink', m.externalId);
    if (hit) return skip('issueLink', m.externalId, 'already imported');
    return {
      kind: 'create',
      entity: 'issueLink',
      externalId: m.externalId,
      summary: `${m.fromKey} → ${m.otherKey}`,
      data: m,
    };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const [typeId, outwardId, inwardId] = await Promise.all([
      ctx
        .resolve('issueLinkType', m.typeExternalId)
        .then(
          async (id) => id ?? (await ctx.prisma.issueLinkType.findFirst({ where: { name: m.typeName } }))?.id ?? null
        ),
      ctx.resolve('issue', m.outwardId),
      ctx.resolve('issue', m.inwardId),
    ]);
    if (!typeId || !outwardId || !inwardId) {
      // A link whose far end lives in another project is permanently out of
      // migration scope — warn + record nothing so re-runs re-warn honestly.
      const otherProject = String(m.otherKey ?? '').split('-')[0];
      if ((!outwardId || !inwardId) && otherProject && !ctx.job.projectKeys.includes(otherProject)) {
        ctx.warn('issueLink', m.externalId, `skipped — ${m.otherKey} is outside the migration scope`);
        return null;
      }
      throw new Error(`issueLink ${m.externalId}: type=${!!typeId} outward=${!!outwardId} inward=${!!inwardId}`);
    }
    const l = await ctx.prisma.issueLink.upsert({
      where: { typeId_outwardId_inwardId: { typeId, outwardId, inwardId } },
      create: { typeId, outwardId, inwardId },
      update: {},
    });
    return l.id;
  },
};

/* ------------------------------ project roles ------------------------------ */

export const projectRoleImporter: EntityImporter<any, any> = {
  entity: 'role',
  async *discover(src) {
    yield* src.paged('/rest/api/3/role');
  },
  async map(raw) {
    return { externalId: String(raw.id), name: raw.name ?? String(raw.id), description: raw.description ?? '' };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'role', m.externalId);
    if (hit) return skip('role', m.externalId, 'already imported');
    const byName = await ctx.prisma.projectRole.findUnique({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'role',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'role', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    if (op.kind === 'update') return op.internalId;
    const m = op.data as any;
    const r = await ctx.prisma.projectRole.create({ data: { name: m.name, description: m.description } });
    return r.id;
  },
};

export const roleActorImporter: EntityImporter<any, any> = {
  entity: 'roleActor',
  dependsOn: ['role', 'project', 'user', 'group'],
  async *discover(src, ctx) {
    for (const key of ctx.job.projectKeys) {
      const roleMap = await src.get<any>(`/rest/api/3/project/${key}/role`).catch(() => null);
      for (const [roleName, url] of Object.entries(roleMap ?? {})) {
        const detail = await src.get<any>(String(url).replace(/^https?:\/\/[^/]+/, '')).catch(() => null);
        for (const a of detail?.actors ?? []) {
          yield { ...a, _projectKey: key, _roleName: roleName, _roleId: String(detail?.id ?? '') };
        }
      }
    }
  },
  async map(raw) {
    const userId = raw.actorUser?.accountId ?? raw.actorUser?.user?.accountId ?? null;
    const groupName = raw.actorGroup?.name ?? null;
    return {
      externalId: `${raw._projectKey}:${raw._roleName}:${userId ?? groupName ?? raw.id}`,
      projectKey: raw._projectKey,
      roleExternalId: String(raw._roleId),
      roleName: raw._roleName,
      userAccountId: userId,
      groupName,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'roleActor', m.externalId);
    if (hit) return skip('roleActor', m.externalId, 'already imported');
    return {
      kind: 'create',
      entity: 'roleActor',
      externalId: m.externalId,
      summary: `${m.roleName}@${m.projectKey}`,
      data: m,
    };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    const roleId =
      (await ctx.resolve('role', m.roleExternalId)) ??
      (await ctx.prisma.projectRole.findUnique({ where: { name: m.roleName } }))?.id;
    if (!project || !roleId) {
      throw new Error(`roleActor ${m.externalId}: project=${!!project} role=${!!roleId}`);
    }
    let userId: string | null = null;
    let groupId: string | null = null;
    if (m.userAccountId) {
      userId = await ctx.resolve('user', m.userAccountId);
      if (!userId) throw new Error(`roleActor ${m.externalId}: user not imported`);
    } else if (m.groupName) {
      groupId = (await ctx.prisma.group.findUnique({ where: { name: m.groupName } }))?.id ?? null;
      if (!groupId) throw new Error(`roleActor ${m.externalId}: group ${m.groupName} not found`);
    } else {
      ctx.warn('roleActor', m.externalId, 'actor is neither user nor group');
      return null;
    }
    const found = await ctx.prisma.projectRoleActor.findFirst({
      where: { projectId: project.id, roleId, userId, groupId },
    });
    if (found) return found.id;
    const a = await ctx.prisma.projectRoleActor.create({ data: { projectId: project.id, roleId, userId, groupId } });
    return a.id;
  },
};

/* -------------------------------- boards -------------------------------- */

export const boardImporter: EntityImporter<any, any> = {
  entity: 'board',
  dependsOn: ['project', 'status'],
  async *discover(src, ctx) {
    for (const key of ctx.job.projectKeys) {
      const boards = await src.get<any>('/rest/agile/1.0/board', { projectKeyOrId: key }).catch(() => null);
      for (const b of boards?.values ?? []) {
        const config = await src.get<any>(`/rest/agile/1.0/board/${b.id}/configuration`).catch(() => null);
        const quickFilters = await src.get<any>(`/rest/agile/1.0/board/${b.id}/quickfilter`).catch(() => null);
        yield {
          ...b,
          _projectKey: key,
          _columns: config?.columnConfig?.columns ?? [],
          _quickFilters: quickFilters?.values ?? [],
        };
      }
    }
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      name: raw.name ?? 'Board',
      type: raw.type === 'scrum' ? 'scrum' : 'kanban',
      projectKey: raw._projectKey,
      columns: (raw._columns as any[]).map((c: any, i: number) => ({
        name: c.name ?? `Column ${i}`,
        position: i,
        statusIds: (c.statuses ?? []).map((s: any) => String(s.id)),
        min: c.min,
        max: c.max,
      })),
      // 035 W7 — Jira quick filters become BoardQuickFilter rows
      quickFilters: (raw._quickFilters as any[]).map((q: any, i: number) => ({
        name: q.name ?? `Filter ${i}`,
        jql: q.query ?? q.jql ?? '',
        position: q.position ?? i,
      })),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'board', m.externalId);
    if (hit)
      return { kind: 'update', entity: 'board', externalId: m.externalId, internalId: hit, summary: m.name, data: m };
    return { kind: 'create', entity: 'board', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (!project) throw new Error(`board ${m.externalId}: project ${m.projectKey} not imported`);
    let boardId: string;
    if (op.kind === 'update') {
      boardId = op.internalId;
      await ctx.prisma.board.update({ where: { id: boardId }, data: { name: m.name, type: m.type } });
    } else {
      // Attach to the project's default board if one already exists (033 N:1)
      const existingBoard = await ctx.prisma.board.findFirst({
        where: { projectId: project.id },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
      if (existingBoard) {
        boardId = existingBoard.id;
        await ctx.prisma.board.update({ where: { id: boardId }, data: { name: m.name, type: m.type } });
      } else {
        boardId = (
          await ctx.prisma.board.create({
            data: { projectId: project.id, name: m.name, type: m.type, isDefault: true },
          })
        ).id;
      }
    }
    // rebuild columns with status mapping
    await ctx.prisma.boardColumn.deleteMany({ where: { boardId } });
    for (const c of m.columns) {
      const col = await ctx.prisma.boardColumn.create({
        data: { boardId, name: c.name, position: c.position, minIssues: c.min ?? null, maxIssues: c.max ?? null },
      });
      for (const statusExternalId of c.statusIds as string[]) {
        const statusId = await ctx.resolve('status', statusExternalId);
        if (statusId) {
          await ctx.prisma.boardColumnStatus.create({ data: { columnId: col.id, statusId } }).catch(() => {});
        } else {
          ctx.warn('board', m.externalId, `column ${c.name}: status ${statusExternalId} unmapped`);
        }
      }
    }
    // quick filters — rebuild from source (035)
    await ctx.prisma.boardQuickFilter.deleteMany({ where: { boardId } });
    for (const q of (m.quickFilters ?? []) as { name: string; jql: string; position: number }[]) {
      if (!q.jql) continue;
      await ctx.prisma.boardQuickFilter
        .create({
          data: { boardId, name: q.name, jql: q.jql, position: q.position },
        })
        .catch(() => ctx.warn('board', m.externalId, `quick filter '${q.name}' failed`));
    }
    return boardId;
  },
};

/* -------------------------------- filters -------------------------------- */

export const filterImporter: EntityImporter<any, any> = {
  entity: 'filter',
  dependsOn: ['user'],
  async *discover(src) {
    yield* src.paged('/rest/api/3/filter/search', 'values');
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      name: raw.name ?? 'Imported filter',
      description: raw.description ?? null,
      jql: raw.jql ?? '',
      ownerAccountId: raw.owner?.accountId ?? null,
      favourite: raw.favourite === true,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'filter', m.externalId);
    if (hit)
      return { kind: 'update', entity: 'filter', externalId: m.externalId, internalId: hit, summary: m.name, data: m };
    return { kind: 'create', entity: 'filter', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const ownerId = (m.ownerAccountId ? await ctx.resolve('user', m.ownerAccountId) : null) ?? ctx.job.actorId;
    // preserve JQL verbatim; flag unparsable queries rather than dropping them
    try {
      const { parseJql } = await import('../jql/parser.js');
      parseJql(m.jql);
    } catch (e) {
      ctx.warn(
        'filter',
        m.externalId,
        `jql kept verbatim but does not parse in TrackForge: ${(e as Error).message.slice(0, 120)}`
      );
    }
    if (op.kind === 'update') {
      await ctx.prisma.filter.update({
        where: { id: op.internalId },
        data: { name: m.name, description: m.description, jql: m.jql },
      });
      return op.internalId;
    }
    const f = await ctx.prisma.filter.create({
      data: { ownerId, name: m.name, description: m.description, jql: m.jql, visibility: 'all' },
    });
    return f.id;
  },
};

/* ------------------------------- workflows ------------------------------ */

/** v1 workflow import: statuses name-matched into a per-workflow shell with
 *  transitions. Workflow-scheme → project assignment is 031 scope (warned). */
export const workflowImporter: EntityImporter<any, any> = {
  entity: 'workflow',
  dependsOn: ['status'],
  async *discover(src) {
    for await (const w of src.paged<any>('/rest/api/3/workflow/search', 'values')) {
      const name = w.id?.name ?? w.name;
      // detail fetch carries statuses+transitions; search rows may embed them
      const detail = name ? await src.get<any>('/rest/api/3/workflow', { workflowName: name }).catch(() => null) : null;
      yield { ...(detail ?? {}), ...(w.statuses ? w : (detail ?? w)), name, _embedded: w };
    }
  },
  async map(raw) {
    const statuses = (raw.statuses ?? []) as any[];
    const transitions = (raw.transitions ?? []) as any[];
    return {
      externalId: String(raw.name ?? raw.id?.name ?? ''),
      name: raw.name ?? 'Imported workflow',
      projectKey: raw._projectKey ?? null,
      statuses: statuses.map((s, i) => ({
        externalId: String(s.id ?? s.name),
        name: s.name ?? String(s.id),
        initial: s.initial === true || (s.properties?.['jira.issue.editable'] === 'true' && i === 0),
        position: i,
      })),
      transitions: transitions.map((t) => ({
        name: t.name ?? 'Transition',
        toStatusName: t.to?.status?.name ?? t.to?.name ?? null,
        synthesized: t._synthesized === true,
        fromStatusNames:
          t.from == null
            ? []
            : (Array.isArray(t.from) ? t.from : [t.from]).map((f: any) => f?.status?.name ?? f?.name ?? String(f)),
        global: t.type === 'global' || t.from == null,
      })),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'workflow', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'workflow',
        externalId: m.externalId,
        internalId: hit,
        summary: m.name,
        data: m,
      };
    const byName = await ctx.prisma.workflow.findUnique({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'workflow',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'workflow', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const statusIdFor = async (name: string) =>
      (await ctx.prisma.status.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } }))?.id ?? null;
    let workflowId: string;
    if (op.kind === 'update') {
      workflowId = op.internalId;
      await ctx.prisma.workflowTransition.deleteMany({ where: { workflowId } });
      await ctx.prisma.workflowStatus.deleteMany({ where: { workflowId } });
    } else {
      workflowId = (await ctx.prisma.workflow.create({ data: { name: m.name } })).id;
    }
    const nameToInternal = new Map<string, string>();
    let initialSet = false;
    for (const s of m.statuses as any[]) {
      const statusId = (await ctx.resolve('status', s.externalId)) ?? (await statusIdFor(s.name));
      if (!statusId) {
        ctx.warn('workflow', m.externalId, `status '${s.name}' not imported`);
        continue;
      }
      nameToInternal.set(s.name, statusId);
      const isInitial = s.initial || (!initialSet && s.position === 0);
      if (isInitial) initialSet = true;
      await ctx.prisma.workflowStatus.create({
        data: { workflowId, statusId, isInitial, position: s.position },
      });
    }
    for (const t of m.transitions as any[]) {
      const toStatusId = t.toStatusName
        ? (nameToInternal.get(t.toStatusName) ?? (await statusIdFor(t.toStatusName)))
        : null;
      if (!toStatusId) {
        ctx.warn('workflow', m.externalId, `transition '${t.name}': target status unmapped`);
        continue;
      }
      // Synthesized (Server-reconstructed) transitions get the simplified-
      // workflow post-function pair: set a resolution when the target is a
      // done-category status, clear it otherwise.
      const ruleCreate: { kind: string; type: string }[] = [];
      if (t.synthesized) {
        const cat = (
          await ctx.prisma.status.findUnique({ where: { id: toStatusId }, select: { category: true } })
        )?.category;
        ruleCreate.push({ kind: 'postFunction', type: cat === 'done' ? 'setResolution' : 'clearResolution' });
      }
      const froms: (string | null)[] =
        t.global || !(t.fromStatusNames as string[]).length
          ? [null]
          : await Promise.all((t.fromStatusNames as string[]).map((n) => nameToInternal.get(n) ?? statusIdFor(n)));
      for (const fromStatusId of froms) {
        if (fromStatusId === undefined) continue;
        await ctx.prisma.workflowTransition.create({
          data: { workflowId, name: t.name, fromStatusId, toStatusId, rules: { create: ruleCreate } },
        });
      }
    }
    // Server-reconstructed workflows are per-project — attach when the project
    // has no other assignment, else getProjectWorkflow falls back to 'Simple'
    // and transitions serve generic statuses instead of the imported ones.
    if (m.projectKey) {
      const proj = await ctx.prisma.project.findUnique({
        where: { key: m.projectKey },
        select: { id: true, workflowId: true, workflowSchemeId: true },
      });
      if (proj && !proj.workflowId && !proj.workflowSchemeId) {
        await ctx.prisma.project.update({ where: { id: proj.id }, data: { workflowId } });
      }
    }
    ctx.warn(
      'workflow',
      m.externalId,
      m.projectKey
        ? `reconstructed workflow attached to project ${m.projectKey} — simplified global transitions; real topology needs the workflow XML backup`
        : 'imported as status-mapped shell — project assignment via workflow scheme is sprint 031'
    );
    return workflowId;
  },
};

/* ---------------------------- custom fields ----------------------------- */

const JIRA_CF_TYPES: Record<string, string> = {
  textfield: 'text',
  textarea: 'textarea',
  url: 'url',
  float: 'number',
  number: 'number',
  datepicker: 'date',
  datetime: 'datetime',
  select: 'select',
  radiobuttons: 'radio',
  multiselect: 'multiselect',
  multicheckboxes: 'checkbox',
  cascadingselect: 'cascading',
  userpicker: 'user',
  multiuserpicker: 'user',
  grouppicker: 'group',
  multigrouppicker: 'group',
  // Jira Software / Portfolio plugin CFs — import as real custom fields
  // instead of unsupported. Structural gh fields (epic link/name, sprint,
  // rank, story points, flagged, jpo-parent) never reach this path — they
  // map to Issue columns/relations in issueImporter.
  'gh-epic-status': 'select', // tri-state option set; auto-created on write
  'gh-epic-color': 'text', // ghx-label-* token
  'jpo-original-story-points': 'number',
  'jpo-baseline-start': 'date',
  'jpo-baseline-end': 'date',
};

export const customFieldImporter: EntityImporter<any, any> = {
  entity: 'customField',
  async *discover(src) {
    for await (const f of src.paged<any>('/rest/api/3/field')) {
      if (!f.custom) continue;
      // select-ish types carry option sets under their (default) context
      const options: any[] = [];
      const t =
        String(f.schema?.custom ?? '')
          .split(':')
          .pop() ?? '';
      if (['select', 'radiobuttons', 'multiselect', 'multicheckboxes', 'cascadingselect'].includes(t)) {
        const ctxs = await src.get<any>(`/rest/api/3/field/${f.id}/context`).catch(() => null);
        for (const c of ctxs?.values ?? []) {
          for await (const o of src.paged<any>(`/rest/api/3/field/${f.id}/context/${c.id}/option`, 'values')) {
            options.push(o);
          }
        }
      }
      yield { ...f, _options: options };
    }
  },
  async map(raw) {
    const jiraType =
      String(raw.schema?.custom ?? '')
        .split(':')
        .pop() ?? '';
    return {
      externalId: String(raw.id), // 'customfield_NNNNN'
      name: raw.name ?? raw.id,
      description: raw.description ?? null,
      jiraType,
      tfType: JIRA_CF_TYPES[jiraType] ?? null,
      // Jira: optionId set ⇒ this option is a child of that parent option
      options: (raw._options as any[]).map((o) => ({
        id: String(o.id),
        value: String(o.value ?? o.id),
        parentExternalId: o.optionId ? String(o.optionId) : null,
        disabled: o.disabled === true,
      })),
    };
  },
  async plan(m, ctx) {
    // No TrackForge type ⇒ the field is unrepresentable — report it as
    // unsupported rather than applying a fake success. Checked before the
    // idempotency map so poisoned rows from older runs can't revive it.
    if (!m.tfType)
      return unsupported('customField', m.externalId, `type '${m.jiraType || 'unknown'}' not supported`);
    const hit = await existing(ctx, 'customField', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'customField',
        externalId: m.externalId,
        internalId: hit,
        summary: m.name,
        data: m,
      };
    const byName = await ctx.prisma.customField.findFirst({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'customField',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'customField', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    if (!m.tfType) throw new Error(`unsupported custom field reached apply: ${m.externalId}`);
    const seq = Number(m.externalId.replace(/\D/g, '')) || 0;
    const searcher =
      (
        {
          text: 'text',
          textarea: 'text',
          url: 'text',
          number: 'number',
          date: 'date',
          datetime: 'date',
          user: 'user',
          group: 'text',
        } as Record<string, string>
      )[m.tfType as string] ?? 'exact';
    let fieldId: string;
    if (op.kind === 'update') {
      fieldId = op.internalId;
      await ctx.prisma.customField.update({ where: { id: fieldId }, data: { description: m.description } });
    } else {
      // Server instances legitimately carry same-named fields (dup names are
      // allowed) — a second 'create' converges onto the existing row.
      const dup = await ctx.prisma.customField.findFirst({ where: { name: m.name } });
      if (dup) {
        ctx.warn('customField', m.externalId, `name '${m.name}' taken by ${dup.id} — values map onto it`);
        return dup.id;
      }
      const f = await ctx.prisma.customField.create({
        data: {
          id: m.externalId,
          seq,
          name: m.name,
          type: m.tfType,
          searcherType: searcher,
          description: m.description,
        },
      });
      fieldId = f.id;
      await ctx.prisma.customFieldContext.create({ data: { fieldId, isGlobal: true } });
    }
    // ensure options exist (global context) — match by value, create missing.
    // Pass 1 parents (optionId unset), pass 2 children resolved via jira id map.
    const context = await ctx.prisma.customFieldContext.findFirst({ where: { fieldId } });
    if (context) {
      const existingOpts = await ctx.prisma.customFieldOption.findMany({ where: { contextId: context.id } });
      const byValueParent = new Map(existingOpts.map((o) => [`${o.parentId ?? ''}:${o.value}`, o.id]));
      const jiraOptToInternal = new Map<string, string>(); // jira optionId → internal id
      let pos = existingOpts.length;
      for (const o of m.options as any[]) {
        if (o.parentExternalId) continue;
        let id = byValueParent.get(`:${o.value}`);
        if (!id) {
          id = (
            await ctx.prisma.customFieldOption.create({
              data: { contextId: context.id, value: o.value, position: pos++, disabled: o.disabled },
            })
          ).id;
          byValueParent.set(`:${o.value}`, id);
        }
        jiraOptToInternal.set(o.id, id);
      }
      for (const o of m.options as any[]) {
        if (!o.parentExternalId) continue;
        const parentInternal = jiraOptToInternal.get(o.parentExternalId);
        if (!parentInternal) {
          ctx.warn('customField', m.externalId, `option '${o.value}': parent option not found`);
          continue;
        }
        if (!byValueParent.has(`${parentInternal}:${o.value}`)) {
          const id = (
            await ctx.prisma.customFieldOption.create({
              data: {
                contextId: context.id,
                value: o.value,
                parentId: parentInternal,
                position: pos++,
                disabled: o.disabled,
              },
            })
          ).id;
          byValueParent.set(`${parentInternal}:${o.value}`, id);
        }
      }
    }
    return fieldId;
  },
};

/* ----------------------------- group members ----------------------------- */

export const groupMemberImporter: EntityImporter<any, any> = {
  entity: 'groupMember',
  dependsOn: ['group', 'user'],
  async *discover(src, ctx) {
    const res = await src.get<any>('/rest/api/3/groups/picker', { query: '' }).catch(() => null);
    for (const g of res?.groups ?? []) {
      const name = g.name ?? g.groupId;
      try {
        for await (const u of src.paged<any>('/rest/api/3/group/member', 'values', {
          groupname: name,
          includeInactiveUsers: true,
        })) {
          yield { accountId: u.accountId, _groupName: name };
        }
      } catch (e) {
        ctx.warn('groupMember', String(name), `group '${name}' not enumerable: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  },
  async map(raw) {
    return {
      externalId: `${raw._groupName}:${raw.accountId}`,
      groupName: raw._groupName,
      userAccountId: String(raw.accountId),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'groupMember', m.externalId);
    if (hit) return skip('groupMember', m.externalId, 'already imported');
    return { kind: 'create', entity: 'groupMember', externalId: m.externalId, summary: m.externalId, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const groupId = (await ctx.prisma.group.findUnique({ where: { name: m.groupName } }))?.id;
    const userId = await ctx.resolve('user', m.userAccountId);
    if (!groupId || !userId) {
      throw new Error(`groupMember ${m.externalId}: ${!groupId ? 'group' : 'user'} not imported`);
    }
    const gm = await ctx.prisma.groupMember.upsert({
      where: { groupId_userId: { groupId, userId } },
      create: { groupId, userId },
      update: {},
    });
    return gm.groupId + ':' + gm.userId;
  },
};

/** Writes one imported CF value onto an issue — resolves the field via the
 *  import map or direct id (ids are literal 'customfield_NNNNN'), serializes
 *  per field type, and creates missing options on the fly (Jira options can be
 *  project-scoped and missed by the field importer). */
async function writeImportedCfValue(
  ctx: ImportCtx,
  issueId: string,
  extFieldId: string,
  rawValue: unknown
): Promise<void> {
  const fieldId =
    (await ctx.resolve('customField', extFieldId)) ??
    (await ctx.prisma.customField.findUnique({ where: { id: extFieldId } }))?.id;
  const cf = fieldId ? await ctx.prisma.customField.findUnique({ where: { id: fieldId } }) : null;
  if (!cf) {
    ctx.warn('issue', issueId, `cf value for ${extFieldId}: field not imported`);
    return;
  }
  const context = await ctx.prisma.customFieldContext.findFirst({ where: { fieldId: cf.id } });
  const optFor = async (v: string, parentId: string | null = null) => {
    if (!context) return null;
    return (
      (await ctx.prisma.customFieldOption.findFirst({ where: { contextId: context.id, value: v, parentId } })) ??
      ctx.prisma.customFieldOption.create({ data: { contextId: context.id, value: v, parentId, position: 999 } })
    );
  };
  const optRef = async (v: string) => {
    const o = await optFor(v);
    return o ? { id: o.id, value: o.value } : null;
  };
  const o = rawValue as any;
  let value: unknown = null;
  switch (cf.type) {
    case 'text':
    case 'textarea':
    case 'url':
      value = String(o);
      break;
    case 'number':
      value = Number(o);
      break;
    case 'date':
    case 'datetime':
      value = String(o);
      break;
    case 'select':
    case 'radio':
      value = await optRef(String(o?.value ?? o));
      break;
    case 'multiselect':
    case 'checkbox': {
      const arr = Array.isArray(o) ? o : [o];
      value = (await Promise.all(arr.map((x) => optRef(String(x?.value ?? x))))).filter(Boolean);
      break;
    }
    case 'cascading': {
      const parent = o?.value != null ? await optFor(String(o.value)) : null;
      const child = o?.child?.value != null && parent ? await optFor(String(o.child.value), parent.id) : null;
      value = parent
        ? { id: parent.id, value: parent.value, ...(child ? { child: { id: child.id, value: child.value } } : {}) }
        : null;
      break;
    }
    case 'user': {
      const acc = o?.accountId ?? null;
      const uid = acc ? await ctx.resolve('user', String(acc)) : null;
      if (acc && !uid) ctx.warn('issue', issueId, `cf ${extFieldId}: user ${acc} not imported`);
      value = uid ? { accountId: uid, displayName: o?.displayName ?? null } : null;
      break;
    }
    case 'group':
      value = o?.name ? { name: String(o.name) } : null;
      break;
    default:
      ctx.warn('issue', issueId, `cf ${extFieldId} type '${cf.type}' value not imported`);
      return;
  }
  if (value === null || value === undefined) return;
  await ctx.prisma.customFieldValue.upsert({
    where: { issueId_fieldId: { issueId, fieldId: cf.id } },
    create: { issueId, fieldId: cf.id, value: value as object },
    update: { value: value as object },
  });
}

/* -------------------- components & versions (019) ---------------------- */

export const componentImporter: EntityImporter<any, any> = {
  entity: 'component',
  dependsOn: ['project', 'user'],
  async *discover(src, ctx) {
    for (const key of ctx.job.projectKeys) {
      const list = await src.get<any[]>(`/rest/api/3/project/${key}/components`).catch(() => null);
      for (const c of list ?? []) yield { ...c, _projectKey: key };
    }
  },
  async map(raw) {
    const at = raw.assigneeType ?? raw.realAssigneeType ?? 'PROJECT_DEFAULT';
    return {
      externalId: String(raw.id),
      projectKey: raw._projectKey,
      name: raw.name ?? 'Component',
      description: raw.description ?? null,
      leadAccountId: raw.lead?.accountId ?? null,
      assigneeType: ['PROJECT_DEFAULT', 'COMPONENT_LEAD', 'PROJECT_LEAD', 'UNASSIGNED'].includes(at)
        ? at
        : 'PROJECT_DEFAULT',
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'component', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'component',
        externalId: m.externalId,
        internalId: hit,
        summary: m.name,
        data: m,
      };
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (project) {
      const byName = await ctx.prisma.component.findUnique({
        where: { projectId_name: { projectId: project.id, name: m.name } },
      });
      if (byName)
        return {
          kind: 'update',
          entity: 'component',
          externalId: m.externalId,
          internalId: byName.id,
          summary: m.name,
          data: m,
        };
    }
    return { kind: 'create', entity: 'component', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (!project) throw new Error(`component ${m.externalId}: project ${m.projectKey} not imported`);
    const leadId = m.leadAccountId ? await ctx.resolve('user', m.leadAccountId) : null;
    const data = { name: m.name, description: m.description, leadId, assigneeType: m.assigneeType };
    const c =
      op.kind === 'update' && op.internalId
        ? await ctx.prisma.component.update({ where: { id: op.internalId }, data })
        : await ctx.prisma.component.create({ data: { ...data, projectId: project.id } });
    await ctx.record('component', m.externalId, c.id);
    return c.id;
  },
};

export const versionImporter: EntityImporter<any, any> = {
  entity: 'version',
  dependsOn: ['project'],
  async *discover(src, ctx) {
    for (const key of ctx.job.projectKeys) {
      const list = await src.get<any[]>(`/rest/api/3/project/${key}/versions`).catch(() => null);
      for (const [i, v] of (list ?? []).entries()) yield { ...v, _projectKey: key, _seq: i };
    }
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      projectKey: raw._projectKey,
      name: raw.name ?? 'Version',
      description: raw.description ?? null,
      released: !!raw.released,
      archived: !!raw.archived,
      startDate: raw.startDate ?? null,
      releaseDate: raw.releaseDate ?? null,
      sequence: Number(raw._seq ?? 0),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'version', m.externalId);
    if (hit)
      return { kind: 'update', entity: 'version', externalId: m.externalId, internalId: hit, summary: m.name, data: m };
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (project) {
      const byName = await ctx.prisma.version.findUnique({
        where: { projectId_name: { projectId: project.id, name: m.name } },
      });
      if (byName)
        return {
          kind: 'update',
          entity: 'version',
          externalId: m.externalId,
          internalId: byName.id,
          summary: m.name,
          data: m,
        };
    }
    return { kind: 'create', entity: 'version', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const project = await ctx.prisma.project.findUnique({ where: { key: m.projectKey } });
    if (!project) throw new Error(`version ${m.externalId}: project ${m.projectKey} not imported`);
    const data = {
      name: m.name,
      description: m.description,
      released: m.released,
      archived: m.archived,
      startDate: m.startDate ? new Date(m.startDate) : null,
      releaseDate: m.releaseDate ? new Date(m.releaseDate) : null,
      sequence: m.sequence,
    };
    const v =
      op.kind === 'update' && op.internalId
        ? await ctx.prisma.version.update({ where: { id: op.internalId }, data })
        : await ctx.prisma.version.create({ data: { ...data, projectId: project.id } });
    await ctx.record('version', m.externalId, v.id);
    return v.id;
  },
};

/* -------------------- 031: scheme layer importers -------------------- */

/** Issue security schemes — levels + member kinds mapped to TrackForge's
 *  {user|group|projectrole|reporter|assignee|projectlead} vocabulary.
 *  Jira-only member types (singleUser→user ok; groupCustomField, etc.) warn+skip. */
export const issueSecuritySchemeImporter: EntityImporter<any, any> = {
  entity: 'issueSecurityScheme',
  dependsOn: ['user', 'group', 'projectRole'],
  async *discover(src) {
    try {
      for await (const s of src.paged<any>('/rest/api/3/issuesecurityschemes', 'issueSecuritySchemes')) {
        const full = await src.get<any>(`/rest/api/3/issuesecurityschemes/${s.id}`).catch(() => s);
        yield { ...s, ...(full ?? {}) };
      }
    } catch {
      /* schemes not present on this source — nothing to import */
    }
  },
  async map(raw) {
    const levels = (raw.levels ?? raw.securityLevels ?? []).map((l: any) => ({
      externalId: String(l.id ?? l.levelId ?? l.name),
      name: l.name ?? 'Level',
      description: l.description ?? null,
      isDefault: l.isDefault === true,
      members: (l.members ?? l.securityLevelMembers ?? []).map((mm: any) => ({
        type: String(mm.type ?? mm.parameter?.type ?? 'user').toLowerCase(),
        parameter: mm.parameter?.value ?? mm.parameter ?? null,
      })),
    }));
    return {
      externalId: String(raw.id),
      name: raw.name ?? 'Imported security scheme',
      description: raw.description ?? null,
      levels,
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'issueSecurityScheme', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'issueSecurityScheme',
        externalId: m.externalId,
        internalId: hit,
        summary: m.name,
        data: m,
      };
    const byName = await ctx.prisma.issueSecurityScheme.findFirst({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'issueSecurityScheme',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'issueSecurityScheme', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const kindMap: Record<string, string> = {
      user: 'user',
      singleuser: 'user',
      group: 'group',
      projectrole: 'projectrole',
      reporter: 'reporter',
      assignee: 'assignee',
      projectlead: 'projectlead',
    };
    const levels = [] as {
      name: string;
      description: string | null;
      isDefault: boolean;
      members: { kind: string; ref: string }[];
    }[];
    for (const l of m.levels) {
      const members: { kind: string; ref: string }[] = [];
      for (const mm of l.members) {
        const kind = kindMap[mm.type];
        if (!kind) {
          ctx.warn('issueSecurityScheme', m.externalId, `member type '${mm.type}' not importable`);
          continue;
        }
        if (kind === 'user') {
          const uid = mm.parameter ? await ctx.resolve('user', String(mm.parameter)) : null;
          if (!uid) {
            ctx.warn('issueSecurityScheme', m.externalId, `user member '${mm.parameter}' unresolved`);
            continue;
          }
          members.push({ kind, ref: uid });
        } else if (kind === 'group' || kind === 'projectrole') {
          const ref = mm.parameter
            ? await ctx.resolve(kind === 'group' ? 'group' : 'projectRole', String(mm.parameter))
            : null;
          members.push({ kind, ref: ref ?? String(mm.parameter ?? '') });
        } else {
          members.push({ kind, ref: '' });
        }
      }
      levels.push({ name: l.name, description: l.description, isDefault: l.isDefault, members });
    }
    const data = {
      name: m.name,
      description: m.description,
      levels: {
        create: levels.map((l) => ({
          name: l.name,
          description: l.description,
          isDefault: l.isDefault,
          members: { create: l.members },
        })),
      },
    };
    if (op.kind === 'update') {
      await ctx.prisma.securityLevel.deleteMany({ where: { schemeId: op.internalId } });
      await ctx.prisma.issueSecurityScheme.update({ where: { id: op.internalId }, data });
      return op.internalId;
    }
    const s = await ctx.prisma.issueSecurityScheme.create({ data });
    return s.id;
  },
};

/** Issue type schemes — scheme + ordered type set. */
export const issueTypeSchemeImporter: EntityImporter<any, any> = {
  entity: 'issueTypeScheme',
  dependsOn: ['issueType'],
  async *discover(src) {
    try {
      for await (const s of src.paged<any>('/rest/api/3/issuetypescheme', 'issueTypeSchemes')) {
        const mapRes = await src
          .get<any>('/rest/api/3/issuetypescheme/mapping', { issueTypeSchemeId: String(s.id) })
          .catch(() => null);
        const issueTypeIds = (mapRes?.issueTypeIds ?? mapRes?.values?.[0]?.issueTypeIds ?? []) as string[];
        yield { ...s, _issueTypeIds: issueTypeIds.map(String) };
      }
    } catch {
      /* schemes not present on this source */
    }
  },
  async map(raw) {
    return {
      externalId: String(raw.id),
      name: raw.name ?? 'Imported issue type scheme',
      description: raw.description ?? null,
      issueTypeIds: (raw._issueTypeIds ?? []) as string[],
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'issueTypeScheme', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'issueTypeScheme',
        externalId: m.externalId,
        internalId: hit,
        summary: m.name,
        data: m,
      };
    const byName = await ctx.prisma.issueTypeScheme.findUnique({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'issueTypeScheme',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'issueTypeScheme', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const typeIds: string[] = [];
    for (const ext of m.issueTypeIds) {
      const id = await ctx.resolve('issueType', ext);
      if (id) typeIds.push(id);
      else ctx.warn('issueTypeScheme', m.externalId, `issue type '${ext}' unresolved`);
    }
    if (op.kind === 'update') {
      await ctx.prisma.issueTypeSchemeItem.deleteMany({ where: { schemeId: op.internalId } });
      await ctx.prisma.issueTypeScheme.update({
        where: { id: op.internalId },
        data: { name: m.name, description: m.description },
      });
      await ctx.prisma.issueTypeSchemeItem.createMany({
        data: typeIds.map((issueTypeId, i) => ({ schemeId: op.internalId, issueTypeId, position: i })),
      });
      return op.internalId;
    }
    const s = await ctx.prisma.issueTypeScheme.create({
      data: {
        name: m.name,
        description: m.description,
        items: { create: typeIds.map((issueTypeId, i) => ({ issueTypeId, position: i })) },
      },
    });
    return s.id;
  },
};

/** Field configurations — required/hidden/description/defaultValue items.
 *  Field ids resolve through the custom-field map first, then the system
 *  registry verbatim (Jira 'summary'|'description'|... ids match ours). */
export const fieldConfigurationImporter: EntityImporter<any, any> = {
  entity: 'fieldConfiguration',
  dependsOn: ['customField'],
  async *discover(src) {
    try {
      for await (const c of src.paged<any>('/rest/api/3/fieldconfigurations', 'values')) {
        const fields: any[] = [];
        try {
          for await (const f of src.paged<any>(`/rest/api/3/fieldconfigurations/${c.id}/fields`, 'values')) {
            fields.push(f);
          }
        } catch {
          /* fields endpoint absent — keep empty */
        }
        yield { ...c, _fields: fields };
      }
    } catch {
      /* field configurations not present on this source */
    }
  },
  async map(raw) {
    const fields = (raw._fields ?? []) as any[];
    return {
      externalId: String(raw.id),
      name: raw.name ?? 'Imported field configuration',
      description: raw.description ?? null,
      items: fields.map((f: any) => ({
        fieldRef: String(f.id ?? f.fieldId ?? ''),
        required: f.isRequired === true,
        hidden: f.isHidden === true,
        description: f.description ?? null,
      })),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'fieldConfiguration', m.externalId);
    if (hit)
      return {
        kind: 'update',
        entity: 'fieldConfiguration',
        externalId: m.externalId,
        internalId: hit,
        summary: m.name,
        data: m,
      };
    const byName = await ctx.prisma.fieldConfiguration.findUnique({ where: { name: m.name } });
    if (byName)
      return {
        kind: 'update',
        entity: 'fieldConfiguration',
        externalId: m.externalId,
        internalId: byName.id,
        summary: m.name,
        data: m,
      };
    return { kind: 'create', entity: 'fieldConfiguration', externalId: m.externalId, summary: m.name, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const items: { fieldId: string; required: boolean; hidden: boolean; description: string | null }[] = [];
    for (const i of m.items) {
      const cfId = await ctx.resolve('customField', i.fieldRef);
      items.push({ fieldId: cfId ?? i.fieldRef, required: i.required, hidden: i.hidden, description: i.description });
    }
    if (op.kind === 'update') {
      await ctx.prisma.fieldConfigurationItem.deleteMany({ where: { configId: op.internalId } });
      await ctx.prisma.fieldConfiguration.update({
        where: { id: op.internalId },
        data: { name: m.name, description: m.description },
      });
      await ctx.prisma.fieldConfigurationItem.createMany({
        data: items.map((i) => ({ ...i, configId: op.internalId })),
      });
      return op.internalId;
    }
    const c = await ctx.prisma.fieldConfiguration.create({
      data: { name: m.name, description: m.description, items: { create: items } },
    });
    return c.id;
  },
};

/* -------------------- 039: changelog history importer -------------------- */

/**
 * Full-history import (039): reads fields.changelog.histories off discovered
 * issues (XML backups emit them; Cloud search doesn't) and writes native
 * ChangeHistory/ChangeItem rows with imported author + timestamp preserved.
 */
export const historyImporter: EntityImporter<any, any> = {
  entity: 'history',
  dependsOn: ['issue', 'user'],
  async *discover(src, ctx) {
    for await (const issue of src.paged<any>('/rest/api/3/search', 'issues', {
      jql: issueJql(ctx),
      fields: 'changelog',
    })) {
      const histories = issue.fields?.changelog?.histories ?? [];
      if (histories.length) yield { key: issue.key, histories };
    }
  },
  async map(raw) {
    return {
      externalId: `hist:${raw.key}`,
      key: raw.key,
      histories: raw.histories.map((h: any) => ({
        id: String(h.id ?? ''),
        created: h.created ?? null,
        authorAccountId: h.author?.accountId ?? null,
        items: (h.items ?? []).map((i: any) => ({
          field: i.field ?? 'unknown',
          fieldtype: i.fieldtype ?? 'jira',
          fromString: i.fromString ?? null,
          toString: i.toString ?? null,
        })),
      })),
    };
  },
  async plan(m, ctx) {
    const hit = await existing(ctx, 'history', m.externalId);
    if (hit) return skip('history', m.externalId, 'already imported');
    return { kind: 'create', entity: 'history', externalId: m.externalId, summary: m.key, data: m };
  },
  async apply(op, ctx) {
    const m = op.data as any;
    const [pk, num] = String(m.key).split('-');
    const project = await ctx.prisma.project.findUnique({ where: { key: pk } });
    const issue = project
      ? await ctx.prisma.issue.findUnique({
          where: { projectId_issueNumber: { projectId: project.id, issueNumber: Number(num) } },
        })
      : null;
    if (!issue) throw new Error(`history ${m.key}: issue not imported`);
    const fallbackAuthor =
      issue.reporterId ?? issue.assigneeId ?? (await ctx.prisma.user.findFirstOrThrow({ where: { active: true } })).id;
    for (const h of m.histories) {
      const authorId = h.authorAccountId ? await ctx.resolve('user', h.authorAccountId) : null;
      const hist = await ctx.prisma.changeHistory.create({
        data: {
          issueId: issue.id,
          authorId: authorId ?? fallbackAuthor,
          channel: 'import',
          createdAt: h.created ? new Date(h.created) : new Date(),
        },
      });
      if (h.items.length) {
        await ctx.prisma.changeItem.createMany({
          data: h.items.map((i: any) => ({
            historyId: hist.id,
            field: i.field,
            fieldtype: i.fieldtype,
            fromString: i.fromString,
            toString: i.toString,
          })),
        });
      }
    }
    return issue.id;
  },
};

/* --------------------- unsupported entities (reported) --------------------- */

export function unsupportedImporter(entity: string, sprint: string): EntityImporter {
  return {
    entity,
    async *discover() {
      /* deferred — nothing fetched */
    },
    async map(raw) {
      return raw;
    },
    async plan() {
      return unsupported(entity, entity, sprint);
    },
    async apply() {
      throw new Error(`${entity} not yet supported (sprint ${sprint})`);
    },
  };
}

export const importerRegistry: EntityImporter[] = [
  userImporter,
  groupImporter,
  projectRoleImporter,
  projectImporter,
  roleActorImporter,
  groupMemberImporter,
  issueTypeImporter,
  statusImporter,
  priorityImporter,
  resolutionImporter,
  workflowImporter,
  customFieldImporter,
  componentImporter,
  versionImporter,
  boardImporter, // before sprint so sprints attach to the imported board
  sprintImporter, // before issue so CSV sprint columns link at apply
  issueImporter,
  commentImporter,
  issueLinkTypeImporter,
  issueLinkImporter,
  watcherImporter,
  issueVoteImporter,
  remoteLinkImporter,
  worklogImporter,
  attachmentImporter,
  historyImporter,
  filterImporter,
  // 031 scheme layer
  issueSecuritySchemeImporter,
  issueTypeSchemeImporter,
  fieldConfigurationImporter,
  // deferred by the sprint doc itself:
  unsupportedImporter('remoteLink', '022'),
  unsupportedImporter('dashboard', '026'),
  // 031 nested scheme objects — reported, not silently dropped
  unsupportedImporter('screen', '031'),
  unsupportedImporter('screenScheme', '031'),
  unsupportedImporter('issueTypeScreenScheme', '031'),
  unsupportedImporter('fieldConfigurationScheme', '031'),
  unsupportedImporter('workflowScheme', '031'),
];
