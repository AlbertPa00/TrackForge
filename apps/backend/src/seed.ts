import { prisma } from './prisma.js';
import { PERMISSIONS } from './services/permissionService.js';

/**
 * Promise.all rejects on the first failure while sibling writes keep running
 * detached — their writes then race whatever runs next (a request handler,
 * a test's wipe/reseed) and cascade P2002s. allSettled waits for every write
 * before rethrowing, so a failed seed never leaves stragglers.
 */
async function settled(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}

const issueTypes = [
  { name: 'Epic', hierarchyLevel: 1 },
  { name: 'Story', hierarchyLevel: 0 },
  { name: 'Task', hierarchyLevel: 0 },
  { name: 'Bug', hierarchyLevel: 0 },
  { name: 'Subtask', hierarchyLevel: -1, isSubtask: true },
];

const statuses = [
  { name: 'Backlog', category: 'todo', sequence: 0 },
  { name: 'To Do', category: 'todo', sequence: 1 },
  { name: 'Selected for Development', category: 'todo', sequence: 2 },
  { name: 'In Progress', category: 'inprogress', sequence: 3 },
  { name: 'In Review', category: 'inprogress', sequence: 4 },
  { name: 'Done', category: 'done', sequence: 5 },
];

const priorities = [
  { name: 'Highest', color: '#d04437', sequence: 1 },
  { name: 'High', color: '#f15c75', sequence: 2 },
  { name: 'Medium', color: '#f6c342', sequence: 3 },
  { name: 'Low', color: '#707070', sequence: 4 },
  { name: 'Lowest', color: '#999999', sequence: 5 },
];

const resolutions = [
  { name: 'Done', description: 'Work has been completed.', sequence: 1 },
  { name: "Won't Do", description: 'Will not be worked on.', sequence: 2 },
  { name: 'Duplicate', description: 'Duplicates another issue.', sequence: 3 },
  { name: 'Cannot Reproduce', description: 'Could not be reproduced.', sequence: 4 },
];

const linkTypes = [
  { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
  { name: 'Cloners', outward: 'clones', inward: 'is cloned by' },
  { name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by' },
  { name: 'Relates', outward: 'relates to', inward: 'relates to' },
];

export async function seedMetadata() {
  await settled([
    ...issueTypes.map((type) => prisma.issueType.upsert({ where: { name: type.name }, update: {}, create: type })),
    ...statuses.map((status) => prisma.status.upsert({ where: { name: status.name }, update: {}, create: status })),
    ...priorities.map((priority) =>
      prisma.priority.upsert({ where: { name: priority.name }, update: {}, create: priority })
    ),
    ...resolutions.map((r) => prisma.resolution.upsert({ where: { name: r.name }, update: {}, create: r })),
    ...linkTypes.map((t) => prisma.issueLinkType.upsert({ where: { name: t.name }, update: {}, create: t })),
  ]);
}

// --- Workflows -------------------------------------------------------------

interface TransitionSeed {
  name: string;
  from: string | null; // null = global
  to: string;
  screenFields?: string[];
  rules?: { kind: 'condition' | 'validator' | 'postFunction'; type: string; config?: object }[];
}

interface WorkflowSeed {
  name: string;
  statuses: string[]; // first = initial
  transitions: TransitionSeed[];
}

const workflowSeeds: WorkflowSeed[] = [
  {
    name: 'Simple',
    statuses: ['To Do', 'In Progress', 'Done'],
    transitions: [
      { name: 'Start Progress', from: 'To Do', to: 'In Progress' },
      {
        name: 'Done',
        from: 'In Progress',
        to: 'Done',
        screenFields: ['resolution'],
        rules: [
          { kind: 'validator', type: 'resolutionRequired' },
          { kind: 'postFunction', type: 'setResolution' },
        ],
      },
      {
        name: 'Reopen',
        from: null,
        to: 'To Do',
        rules: [{ kind: 'postFunction', type: 'clearResolution' }],
      },
    ],
  },
  {
    name: 'Software Simplified',
    statuses: ['Backlog', 'Selected for Development', 'In Progress', 'In Review', 'Done'],
    transitions: [
      { name: 'Select for Development', from: 'Backlog', to: 'Selected for Development' },
      { name: 'Start Progress', from: 'Selected for Development', to: 'In Progress' },
      { name: 'Submit for Review', from: 'In Progress', to: 'In Review' },
      {
        name: 'Done',
        from: 'In Review',
        to: 'Done',
        screenFields: ['resolution', 'comment'],
        rules: [
          { kind: 'validator', type: 'resolutionRequired' },
          { kind: 'postFunction', type: 'setResolution' },
        ],
      },
      { name: 'Back to In Progress', from: 'In Review', to: 'In Progress' },
      { name: 'Back to Backlog', from: 'Selected for Development', to: 'Backlog' },
      {
        name: 'Reopen',
        from: null,
        to: 'Backlog',
        rules: [{ kind: 'postFunction', type: 'clearResolution' }],
      },
    ],
  },
];

export async function seedWorkflows() {
  const statusByName = new Map((await prisma.status.findMany()).map((s) => [s.name, s]));
  for (const w of workflowSeeds) {
    const workflow = await prisma.workflow.upsert({
      where: { name: w.name },
      update: {},
      create: { name: w.name },
    });
    await settled(
      w.statuses.map((sName, i) =>
        prisma.workflowStatus.upsert({
          where: { workflowId_statusId: { workflowId: workflow.id, statusId: statusByName.get(sName)!.id } },
          update: { isInitial: i === 0, position: i },
          create: { workflowId: workflow.id, statusId: statusByName.get(sName)!.id, isInitial: i === 0, position: i },
        })
      )
    );
    await settled(
      w.transitions.map(async (t, i) => {
        const existing = await prisma.workflowTransition.findFirst({
          where: {
            workflowId: workflow.id,
            name: t.name,
            fromStatusId: t.from ? statusByName.get(t.from)!.id : null,
          },
        });
        if (existing) return;
        await prisma.workflowTransition.create({
          data: {
            workflowId: workflow.id,
            name: t.name,
            fromStatusId: t.from ? statusByName.get(t.from)!.id : null,
            toStatusId: statusByName.get(t.to)!.id,
            screenFields: t.screenFields ?? [],
            position: i,
            rules: {
              create: (t.rules ?? []).map((r) => ({ kind: r.kind, type: r.type, config: r.config ?? undefined })),
            },
          },
        });
      })
    );
  }
}

/** Creates a default 1-column-per-status board for a project (idempotent). */
export async function ensureProjectBoard(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { workflow: true } });
  if (!project) return;
  const existing = await prisma.board.findFirst({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  const wfStatuses = project.workflowId
    ? await prisma.workflowStatus.findMany({
        where: { workflowId: project.workflowId },
        include: { status: true },
        orderBy: { position: 'asc' },
      })
    : [];
  const board = await prisma.board.create({
    data: {
      name: `${project.name} board`,
      type: 'kanban',
      projectId,
      isDefault: true,
      columns: {
        create: wfStatuses.map((ws, i) => ({
          name: ws.status.name,
          position: i,
          statuses: { create: [{ statusId: ws.statusId }] },
        })),
      },
    },
  });
  return board;
}

/** Backfills workflowId, boards and issue ranks for pre-009 databases. */
export async function migrateToWorkflows() {
  const simple = await prisma.workflow.findUnique({ where: { name: 'Simple' } });
  if (!simple) return;
  await prisma.project.updateMany({ where: { workflowId: null }, data: { workflowId: simple.id } });
  const projects = await prisma.project.findMany({ select: { id: true } });
  for (const p of projects) await ensureProjectBoard(p.id);
  // Backfill empty ranks per project, ordered by issue number.
  const { spreadRanks } = await import('./lib/lexorank.js');
  for (const p of projects) {
    const unranked = await prisma.issue.findMany({
      where: { projectId: p.id, rank: '' },
      orderBy: { issueNumber: 'asc' },
      select: { id: true },
    });
    if (!unranked.length) continue;
    const max = await prisma.issue.findFirst({
      where: { projectId: p.id, rank: { not: '' } },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    if (max) {
      // Append after existing max.
      const { rankBetween } = await import('./lib/lexorank.js');
      let prev: string | null = max.rank;
      for (const i of unranked) {
        const r: string = rankBetween(prev, null) ?? '';
        await prisma.issue.update({ where: { id: i.id }, data: { rank: r } });
        prev = r;
      }
    } else {
      const ranks = spreadRanks(unranked.length);
      for (const [i, issue] of unranked.entries()) {
        await prisma.issue.update({ where: { id: issue.id }, data: { rank: ranks[i]! } });
      }
    }
  }
}

/** Demo users for local development (not run inside tests). */
export async function seedUsers() {
  const { hashPassword } = await import('./lib/auth.js');
  const users = [
    { email: 'admin@trackforge.local', displayName: 'TrackForge Admin', isAdmin: true },
    { email: 'ada@trackforge.local', displayName: 'Ada Lovelace' },
    { email: 'grace@trackforge.local', displayName: 'Grace Hopper' },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        ...u,
        passwordHash: await hashPassword('trackforge'),
      },
    });
  }
  const admin = await prisma.user.findUnique({ where: { email: 'admin@trackforge.local' } });
  await prisma.user.upsert({
    where: { email: 'triage-bot@trackforge.local' },
    update: {},
    create: {
      email: 'triage-bot@trackforge.local',
      displayName: 'Triage Bot',
      type: 'agent',
      ownerId: admin!.id,
    },
  });
}

/**
 * Scrum demo project (SCRUM): 3 closed sprints + 1 active, with story-pointed
 * issues and IssueSprint history so Reports render immediately. Idempotent —
 * skips when the project already exists.
 */
export async function seedScrumDemo() {
  if (await prisma.project.findUnique({ where: { key: 'SCRUM' } })) return;
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  if (!admin) return;
  const simple = await prisma.workflow.findUnique({ where: { name: 'Simple' } });
  const story = await prisma.issueType.findUnique({ where: { name: 'Story' } });
  const done = await prisma.status.findUnique({ where: { name: 'Done' } });
  const inProgress = await prisma.status.findUnique({ where: { name: 'In Progress' } });
  const todo = await prisma.status.findUnique({ where: { name: 'To Do' } });
  const medium = await prisma.priority.findUnique({ where: { name: 'Medium' } });
  if (!simple || !story || !done || !inProgress || !todo || !medium) return;

  const project = await prisma.project.create({
    data: { key: 'SCRUM', name: 'Scrum Demo', leadId: admin.id, workflowId: simple.id },
  });
  const board = await ensureProjectBoard(project.id);
  await prisma.board.update({ where: { id: board!.id }, data: { type: 'scrum' } });

  let n = 0;
  const mkIssue = async (summary: string, statusId: string, points: number | null, rank: string) =>
    prisma.issue.create({
      data: {
        projectId: project.id,
        issueNumber: ++n,
        summary,
        issueTypeId: story.id,
        statusId,
        priorityId: medium.id,
        reporterId: admin.id,
        storyPoints: points,
        rank,
      },
    });

  const { spreadRanks } = await import('./lib/lexorank.js');
  const ranks = spreadRanks(12);
  const week = 7 * 86400_000;
  const now = Date.now();

  const sprintPlan = [
    { name: 'SCRUM Sprint 1', pts: [5, 3, 8], doneCount: 3 },
    { name: 'SCRUM Sprint 2', pts: [3, 5, 2], doneCount: 2 },
    { name: 'SCRUM Sprint 3', pts: [8, 5], doneCount: 2 },
  ];
  for (const [i, plan] of sprintPlan.entries()) {
    const start = new Date(now - (4 - i) * 2 * week);
    const sprint = await prisma.sprint.create({
      data: {
        projectId: project.id,
        boardId: board!.id,
        name: plan.name,
        state: 'closed',
        sequence: i + 1,
        startDate: start,
        endDate: new Date(start.getTime() + 2 * week),
        completeDate: new Date(start.getTime() + 2 * week),
      },
    });
    for (const [j, pts] of plan.pts.entries()) {
      const isDone = j < plan.doneCount;
      const issue = await mkIssue(`${plan.name} item ${j + 1}`, isDone ? done.id : todo.id, pts, ranks[n]!);
      if (isDone) {
        await prisma.issue.update({ where: { id: issue.id }, data: { sprintId: sprint.id } });
        await prisma.issueSprint.create({
          data: { issueId: issue.id, sprintId: sprint.id, addedAt: start },
        });
      } else {
        // Spilled into the next sprint (or backlog for the last one).
        await prisma.issueSprint.create({
          data: {
            issueId: issue.id,
            sprintId: sprint.id,
            addedAt: start,
            removedAt: sprint.completeDate,
          },
        });
      }
    }
  }

  const active = await prisma.sprint.create({
    data: {
      projectId: project.id,
      boardId: board!.id,
      name: 'SCRUM Sprint 4',
      state: 'active',
      sequence: 4,
      startDate: new Date(now - 3 * 86400_000),
      endDate: new Date(now + 11 * 86400_000),
      goal: 'Ship the reporting dashboard',
    },
  });
  const demoLogged: Record<string, { estimate: number; spent: [number, string, boolean][] }> = {
    'Velocity chart UI': { estimate: 2 * 8 * 3600, spent: [[6 * 3600, 'chart scaffold', true]] },
    'Burndown data service': {
      estimate: 3 * 8 * 3600,
      spent: [
        [8 * 3600, 'data model', true],
        [2 * 3600, 'endpoint wiring', false],
      ],
    },
    'Sprint report page': { estimate: 1 * 8 * 3600, spent: [] },
  };
  for (const [summary, pts, statusId] of [
    ['Velocity chart UI', 5, done.id],
    ['Burndown data service', 8, inProgress.id],
    ['Sprint report page', 3, todo.id],
  ] as const) {
    const issue = await mkIssue(summary, statusId, pts, ranks[n]!);
    const tt = demoLogged[summary];
    const spentSec = (tt?.spent ?? []).reduce((a, s) => a + s[0], 0);
    await prisma.issue.update({
      where: { id: issue.id },
      data: {
        sprintId: active.id,
        ...(tt
          ? {
              originalEstimateSec: tt.estimate,
              remainingEstimateSec: Math.max(0, tt.estimate - spentSec),
            }
          : {}),
      },
    });
    for (const [sec, comment, billable] of tt?.spent ?? []) {
      await prisma.worklog.create({
        data: {
          issueId: issue.id,
          authorId: admin.id,
          timeSpentSec: sec,
          started: new Date(),
          comment,
          billable,
          channel: 'seed',
        },
      });
    }
    await prisma.issueSprint.create({
      data: { issueId: issue.id, sprintId: active.id, addedAt: active.startDate! },
    });
  }
  // Backlog candidates for planning.
  for (const [summary, pts] of [
    ['Reports performance pass', 3],
    ['Epic burndown variant', 5],
    ['Mobile board layout', null],
  ] as const) {
    await mkIssue(summary, todo.id, pts, ranks[n]!);
  }
}

/**
 * System-managed custom fields (Sprint 014): seeded once with fixed ids so
 * fixtures/tests can rely on them. story_points adapts Issue.storyPoints;
 * flagged + startdate store regular CFValues. Ids are reserved low seqs so
 * admin-created fields never collide (createField starts seq at max+1).
 */
export async function seedSystemCustomFields() {
  const defs = [
    {
      id: 'customfield_10001',
      seq: 10001,
      name: 'Story Points',
      type: 'number',
      alias: 'story_points',
      options: [] as string[],
    },
    {
      id: 'customfield_10002',
      seq: 10002,
      name: 'Flagged',
      type: 'checkbox',
      alias: 'flagged',
      options: ['Impediment'],
    },
    {
      id: 'customfield_10003',
      seq: 10003,
      name: 'Start date',
      type: 'date',
      alias: 'startdate',
      options: [] as string[],
    },
  ];
  await settled(
    defs.map(async (d) => {
      const existing = await prisma.customField.findUnique({ where: { alias: d.alias } });
      if (existing) return;
      const field = await prisma.customField.create({
        data: {
          id: d.id,
          seq: d.seq,
          name: d.name,
          type: d.type,
          searcherType: d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'exact',
          systemManaged: true,
          alias: d.alias,
          description: `System-managed ${d.name} field.`,
        },
      });
      const ctx = await prisma.customFieldContext.create({
        data: { fieldId: field.id, isGlobal: true },
      });
      await settled(
        d.options.map((value, i) =>
          prisma.customFieldOption.create({ data: { contextId: ctx.id, value, position: i } })
        )
      );
    })
  );
}

/**
 * Sprint 015 — idempotent defaults reproducing pre-sprint effective access
 * (FR-002): default roles + groups, a Default Permission Scheme that grants
 * every project permission to `applicationRole` (any logged-in user), group
 * actors on every project's roles, and scheme assignment.
 */
/**
 * Serialized: createProject calls this per request, and its find-then-create
 * grant writes are not idempotent under concurrency (two simultaneous
 * `POST /project`s could duplicate grants or 500). Queue invocations so all
 * callers — request handlers and test reseeds — run one at a time.
 */
let seedQueue: Promise<unknown> = Promise.resolve();
export function seedPermissionDefaults(): Promise<void> {
  const run = seedQueue.then(() => seedPermissionDefaultsImpl());
  seedQueue = run.catch(() => {});
  return run;
}

/**
 * Test-only: run `fn` on the same queue `seedPermissionDefaults` uses. The
 * per-test wipe+reseed joins it so a request-scoped seed call (e.g.
 * `POST /project` → `createProject`) can never interleave a wipe mid-flight.
 */
export function enqueueSeedTask<T>(fn: () => Promise<T>): Promise<T> {
  const run = seedQueue.then(fn);
  seedQueue = run.catch(() => {});
  return run;
}

export async function seedPermissionDefaultsImpl() {
  await settled([
    ...['Administrators', 'Developers', 'Users'].map((name) =>
      prisma.projectRole.upsert({ where: { name }, create: { name }, update: {} })
    ),
    ...['jira-administrators', 'jira-software-users'].map((name) =>
      prisma.group.upsert({ where: { name }, create: { name }, update: {} })
    ),
  ]);
  const [adminGroup, usersGroup] = await Promise.all([
    prisma.group.findUniqueOrThrow({ where: { name: 'jira-administrators' } }),
    prisma.group.findUniqueOrThrow({ where: { name: 'jira-software-users' } }),
  ]);

  // Group membership mirrors account flags.
  const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, isAdmin: true } });
  for (const u of users) {
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: usersGroup.id, userId: u.id } },
      create: { groupId: usersGroup.id, userId: u.id },
      update: {},
    });
    if (u.isAdmin) {
      await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId: adminGroup.id, userId: u.id } },
        create: { groupId: adminGroup.id, userId: u.id },
        update: {},
      });
    }
  }

  // Default scheme reproduces pre-015 access (FR-002): ordinary work
  // permissions → applicationRole; the admin tier (project admin, all-comments
  // moderation, watcher management) stays Administrators-only.
  let scheme = await prisma.permissionScheme.findFirst({ where: { name: 'Default Permission Scheme' } });
  if (!scheme) {
    scheme = await prisma.permissionScheme.create({
      data: { name: 'Default Permission Scheme', description: 'Grants project permissions by Jira defaults.' },
    });
  }
  const ADMIN_TIER = [
    'ADMINISTER_PROJECTS',
    'EDIT_ALL_COMMENTS',
    'DELETE_ALL_COMMENTS',
    'MANAGE_WATCHERS',
    'EDIT_ALL_WORKLOGS',
    'DELETE_ALL_WORKLOGS',
    'DELETE_ALL_ATTACHMENTS',
    'ARCHIVE_ISSUES',
    'RESTORE_ISSUES',
  ];
  const adminRole = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Administrators' } });
  const grantCount = await prisma.permissionGrant.count({ where: { schemeId: scheme.id } });
  if (grantCount === 0) {
    await prisma.permissionGrant.createMany({
      data: [
        ...PERMISSIONS.filter((p) => !ADMIN_TIER.includes(p)).map((permission) => ({
          schemeId: scheme!.id,
          permission,
          holderType: 'applicationRole',
        })),
        ...ADMIN_TIER.flatMap((permission) => [
          { schemeId: scheme!.id, permission, holderType: 'projectRole', holderParam: adminRole.id },
          { schemeId: scheme!.id, permission, holderType: 'group', holderParam: 'jira-administrators' },
        ]),
      ],
    });
  } else {
    // Repair older seeds: admin-tier must not sit on applicationRole, every
    // admin-tier grant must exist, and every non-admin-tier permission needs
    // an applicationRole grant (new permissions added by later sprints).
    await prisma.permissionGrant.deleteMany({
      where: { schemeId: scheme.id, holderType: 'applicationRole', permission: { in: ADMIN_TIER } },
    });
    for (const permission of PERMISSIONS) {
      if (ADMIN_TIER.includes(permission)) {
        for (const holder of [
          { holderType: 'projectRole', holderParam: adminRole.id },
          { holderType: 'group', holderParam: 'jira-administrators' },
        ]) {
          const exists = await prisma.permissionGrant.findFirst({
            where: { schemeId: scheme.id, permission, ...holder },
          });
          if (!exists) await prisma.permissionGrant.create({ data: { schemeId: scheme.id, permission, ...holder } });
        }
      } else {
        const exists = await prisma.permissionGrant.findFirst({
          where: { schemeId: scheme.id, permission, holderType: 'applicationRole' },
        });
        if (!exists) {
          await prisma.permissionGrant.create({
            data: { schemeId: scheme.id, permission, holderType: 'applicationRole' },
          });
        }
      }
    }
  }

  // Projects: assign the default scheme; wire group actors + lead into roles.
  const roles = await prisma.projectRole.findMany();
  const roleByName = new Map(roles.map((r) => [r.name, r.id]));
  const projects = await prisma.project.findMany({ select: { id: true, leadId: true, permissionSchemeId: true } });
  for (const p of projects) {
    if (!p.permissionSchemeId) {
      await prisma.project.update({ where: { id: p.id }, data: { permissionSchemeId: scheme.id } });
    }
    const ensureActor = async (roleId: string, actor: { userId?: string; groupId?: string }) => {
      const found = await prisma.projectRoleActor.findFirst({ where: { projectId: p.id, roleId, ...actor } });
      if (!found) await prisma.projectRoleActor.create({ data: { projectId: p.id, roleId, ...actor } });
    };
    await ensureActor(roleByName.get('Administrators')!, { groupId: adminGroup.id });
    if (p.leadId) await ensureActor(roleByName.get('Administrators')!, { userId: p.leadId });
    await ensureActor(roleByName.get('Users')!, { groupId: usersGroup.id });
    await ensureActor(roleByName.get('Developers')!, { groupId: usersGroup.id });
  }
}

/** 034 — two demo automation rules: a triage flagger (new SCRUM bugs get a
 *  triage label + comment) and a daily stale-issue nagger (scheduled JQL). */
export async function seedAutomationDemo() {
  const admin = await prisma.user.findFirst({ where: { isAdmin: true }, select: { id: true } });
  const scrum = await prisma.project.findUnique({ where: { key: 'SCRUM' }, select: { id: true } });
  if (!admin || !scrum) return;
  const mk = (name: string, data: { trigger: unknown; actions: unknown; conditions?: unknown }) =>
    prisma.automationRule.upsert({
      where: { id: `demo-${name}` },
      update: {},
      create: {
        id: `demo-${name}`,
        name,
        scope: 'project',
        projectId: scrum.id,
        actorId: admin.id,
        createdById: admin.id,
        enabled: true,
        trigger: data.trigger as never,
        conditions: (data.conditions ?? []) as never,
        actions: data.actions as never,
      },
    });
  await mk('triage-flagger', {
    trigger: { type: 'issue_created' },
    conditions: [{ type: 'field_equals', field: 'issuetype.name', value: 'Bug' }],
    actions: [
      { type: 'add_labels', labels: ['needs-triage'] },
      { type: 'comment', body: 'New bug {{issue.key}} filed by {{issue.reporter.displayName}} — flagged for triage.' },
    ],
  });
  await mk('stale-nagger', {
    trigger: {
      type: 'scheduled',
      cron: '0 9 * * *',
      jql: 'project = SCRUM AND statusCategory != Done AND updated <= -14d',
    },
    actions: [{ type: 'comment', body: '{{issue.key}} has been quiet for two weeks — still needed?' }],
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  seedMetadata()
    .then(seedWorkflows)
    .then(migrateToWorkflows)
    .then(seedUsers)
    .then(seedScrumDemo)
    .then(seedSystemCustomFields)
    .then(seedPermissionDefaults)
    .then(seedAutomationDemo)
    .then(() => console.log('Seed complete.'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
