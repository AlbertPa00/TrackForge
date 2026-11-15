/**
 * Sprint 039 US-EXPORT: project → Jira-Cloud-shaped fixture map.
 * The output feeds straight back into `startImport({fixture})`, giving a
 * real round-trip through the same discover/map/plan/apply pipeline the
 * Cloud/CSV/XML sources use. External ids are `tf:{stable-id}` so a
 * re-export is deterministic.
 */
import { prisma } from '../prisma.js';

const tf = (s: string) => `tf:${s}`;
const acct = (email?: string | null) => (email ? { accountId: tf(email.toLowerCase()) } : null);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export async function projectToFixture(projectKey: string): Promise<Record<string, unknown>> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key: projectKey },
    include: { lead: true, components: true, versions: true },
  });
  const issues = await prisma.issue.findMany({
    where: { projectId: project.id },
    orderBy: { issueNumber: 'asc' },
    include: {
      issueType: true,
      status: true,
      priority: true,
      resolution: true,
      assignee: true,
      reporter: true,
      parent: true,
      comments: { include: { author: true } },
      worklogs: { include: { author: true } },
      components: { include: { component: true } },
      versionRefs: { include: { version: true } },
      outLinks: { include: { type: true } },
      inLinks: { include: { type: true } },
      histories: { include: { author: true, items: true }, orderBy: { createdAt: 'asc' } },
    },
  });

  // user set: lead + all referenced authors
  const userIds = new Set<string>();
  if (project.leadId) userIds.add(project.leadId);
  for (const i of issues) {
    for (const u of [i.assigneeId, i.reporterId]) if (u) userIds.add(u);
    for (const c of i.comments) if (c.authorId) userIds.add(c.authorId);
    for (const w of i.worklogs) userIds.add(w.authorId);
    for (const h of i.histories) userIds.add(h.authorId);
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } } });
  const acctOf = (u?: { email: string } | null) => acct(u?.email);

  const keyOf = (i: { issueNumber: number }) => `${projectKey}-${i.issueNumber}`;
  const idOf = (i: { issueNumber: number }) => tf(keyOf(i));

  const [types, statuses, priorities, resolutions, linkTypes] = await Promise.all([
    prisma.issueType.findMany(),
    prisma.status.findMany(),
    prisma.priority.findMany(),
    prisma.resolution.findMany(),
    prisma.issueLinkType.findMany(),
  ]);

  const searchIssues = issues.map((i) => ({
    id: idOf(i),
    key: keyOf(i),
    fields: {
      summary: i.summary,
      description: i.description ?? null,
      issuetype: { name: i.issueType.name },
      status: { name: i.status.name },
      priority: i.priority ? { name: i.priority.name } : null,
      resolution: i.resolution ? { name: i.resolution.name } : null,
      assignee: acctOf(i.assignee),
      reporter: acctOf(i.reporter),
      labels: i.labels,
      duedate: i.dueDate ? iso(i.dueDate)?.slice(0, 10) : null,
      parent: i.parent ? { key: keyOf(i.parent) } : undefined,
      created: iso(i.createdAt),
      updated: iso(i.updatedAt),
      timeoriginalestimate: i.originalEstimateSec ?? undefined,
      timeestimate: i.remainingEstimateSec ?? undefined,
      comment: {
        total: i.comments.length,
        comments: i.comments.map((c) => ({
          id: tf(c.id),
          body: c.body,
          author: acctOf(c.author),
          created: iso(c.createdAt),
        })),
      },
      components: i.components.map((c) => ({ id: tf(c.componentId), name: c.component.name })),
      fixVersions: i.versionRefs
        .filter((v) => v.kind === 'fix')
        .map((v) => ({ id: tf(v.versionId), name: v.version.name })),
      versions: i.versionRefs
        .filter((v) => v.kind === 'affects')
        .map((v) => ({ id: tf(v.versionId), name: v.version.name })),
      issuelinks: [] as unknown[], // filled below once all issue ids are known
      changelog: {
        histories: i.histories.map((h) => ({
          id: tf(h.id),
          created: iso(h.createdAt),
          author: acctOf(h.author),
          items: h.items.map((it) => ({
            field: it.field,
            fieldtype: it.fieldtype,
            fromString: it.fromString,
            toString: it.toString,
          })),
        })),
      },
      attachment: [],
      votes: { votes: i.voteCount },
      watches: { watchCount: i.watcherCount },
    },
  }));

  // link endpoints need the *other* issue's external id — resolve by number
  const numById = new Map(issues.map((i) => [i.id, i.issueNumber]));
  const extId = (dbId: string) => tf(`${projectKey}-${numById.get(dbId)}`);
  const keyFromDb = (dbId: string) => `${projectKey}-${numById.get(dbId)}`;
  for (const si of searchIssues) {
    const dbIssue = issues.find((i) => keyOf(i) === si.key)!;
    si.fields.issuelinks = [
      ...dbIssue.outLinks.map((l) => ({
        id: tf(l.id),
        type: { id: tf(l.typeId), name: l.type.name, inward: l.type.inward, outward: l.type.outward },
        outwardIssue: { id: extId(l.inwardId), key: keyFromDb(l.inwardId) },
      })),
      ...dbIssue.inLinks.map((l) => ({
        id: tf(l.id),
        type: { id: tf(l.typeId), name: l.type.name, inward: l.type.inward, outward: l.type.outward },
        inwardIssue: { id: extId(l.outwardId), key: keyFromDb(l.outwardId) },
      })),
    ];
  }

  const fixture: Record<string, unknown> = {
    '/rest/api/3/users/search': users.map((u) => ({
      accountId: tf(u.email.toLowerCase()),
      emailAddress: u.email,
      displayName: u.displayName,
      active: u.active,
    })),
    '/rest/api/3/issuetype': types.map((t) => ({ id: tf(t.id), name: t.name, subtask: t.isSubtask })),
    '/rest/api/3/status': statuses.map((s) => ({
      id: tf(s.id),
      name: s.name,
      statusCategory: { key: s.category ?? 'new' },
    })),
    '/rest/api/3/priority': priorities.map((p) => ({ id: tf(p.id), name: p.name })),
    '/rest/api/3/resolution': resolutions.map((r) => ({ id: tf(r.id), name: r.name })),
    '/rest/api/3/search': {
      issues: searchIssues,
      total: searchIssues.length,
      maxResults: searchIssues.length,
      startAt: 0,
    },
    '/rest/api/3/issueLinkType': {
      issueLinkTypes: linkTypes.map((t) => ({ id: tf(t.id), name: t.name, inward: t.inward, outward: t.outward })),
    },
    '/rest/api/3/role': [],
    '/rest/api/3/field': [],
    '/rest/api/3/issuesecurityschemes': { issueSecuritySchemes: [] },
    '/rest/api/3/issuetypescheme': { issueTypeSchemes: [] },
    '/rest/api/3/fieldconfigurations': { values: [] },
    '/rest/api/3/workflow/search': { values: [] },
    '/rest/api/3/filter/search': { values: [] },
  };
  fixture[`/rest/api/3/project/${projectKey}`] = {
    id: tf(project.id),
    key: project.key,
    name: project.name,
    lead: acctOf(project.lead),
    projectTypeKey: 'software',
  };
  fixture[`/rest/api/3/project/${projectKey}/components`] = project.components.map((c) => ({
    id: tf(c.id),
    name: c.name,
    project: projectKey,
  }));
  fixture[`/rest/api/3/project/${projectKey}/versions`] = project.versions.map((v, idx) => ({
    id: tf(v.id),
    name: v.name,
    project: projectKey,
    sequence: idx,
  }));
  for (const i of issues) {
    fixture[`/rest/api/3/issue/${keyOf(i)}/worklog`] = {
      worklogs: i.worklogs.map((w) => ({
        id: tf(w.id),
        timeSpentSeconds: w.timeSpentSec,
        author: acctOf(w.author),
        started: iso(w.started),
        comment: w.comment ?? undefined,
      })),
    };
  }
  return fixture;
}
