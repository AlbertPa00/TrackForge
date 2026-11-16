import { z } from 'zod/v3';

/**
 * Query-scalar coercion. Express 5 types `req.query` values as
 * `string | string[]` (repeated params); these routes take singular scalars
 * per the Jira API contract, so array input narrows to undefined — the same
 * semantics the codebase's existing `typeof v === 'string'` guards applied.
 */
export function qs(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Path-param coercion — same `string | string[]` union as `qs` but params
 * are required. Named `:param` segments always produce a string at runtime;
 * the array case only exists for wildcard routes, where first-match is the
 * correct scalar.
 */
export function ps(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

export const projectKeySchema = z
  .string()
  .min(1)
  .max(10)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Project key must be uppercase letters and digits starting with a letter');

export const createProjectSchema = z.object({
  key: projectKeySchema,
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  projectTypeKey: z.enum(['software', 'business']).optional(),
  // 021 — scrum|kanban seed the board type; anything else = basic kanban.
  projectTemplateKey: z.string().optional(),
  categoryId: z.string().optional().nullable(),
});

// Jira accepts {accountId} (Cloud) or {name} (Server); we resolve either to a user.
export const assigneeRefSchema = z
  .object({ accountId: z.string().optional(), name: z.string().optional() })
  .nullable()
  .optional();

export const createIssueSchema = z.object({
  // catchall: customfield_NNNNN / CF alias keys flow through to the CF engine.
  fields: z
    .object({
      project: z.object({ key: projectKeySchema }),
      summary: z.string().min(1).max(500),
      description: z.string().optional(),
      issuetype: z.object({ name: z.string() }).optional(),
      priority: z.object({ name: z.string() }).optional(),
      assignee: assigneeRefSchema,
      delegate: assigneeRefSchema, // 047 — delegate, not assign
      labels: z.array(z.string()).optional(),
      duedate: z.string().optional().nullable(),
      parent: z.object({ key: z.string() }).optional().nullable(),
      story_points: z.number().optional().nullable(),
    })
    .catchall(z.unknown()),
});

// Jira `update` form: { update: { field: [{set|add|remove|edit: value}] } }
const updateOpsSchema = z.record(
  z.array(
    z.object({
      set: z.unknown().optional(),
      add: z.unknown().optional(),
      remove: z.unknown().optional(),
      edit: z.unknown().optional(),
    })
  )
);

export const updateIssueSchema = z.object({
  fields: z
    .object({
      summary: z.string().min(1).max(500).optional(),
      description: z.string().optional().nullable(),
      status: z.object({ name: z.string() }).optional(),
      priority: z.object({ name: z.string() }).optional(),
      issuetype: z.object({ name: z.string() }).optional(),
      assignee: assigneeRefSchema,
      delegate: assigneeRefSchema, // 047 — delegate, not assign
      labels: z.array(z.string()).optional(),
      duedate: z.string().optional().nullable(),
      resolution: z.object({ name: z.string() }).optional().nullable(),
      parent: z.object({ key: z.string() }).optional().nullable(),
      story_points: z.number().optional().nullable(),
    })
    .catchall(z.unknown())
    .optional()
    .default({}),
  update: updateOpsSchema.optional(),
});

export const bulkCreateSchema = z.object({
  issueUpdates: z.array(createIssueSchema).min(1).max(50),
  // TF extension — retry-safe batch token. When present, each item's create
  // result is recorded under `bulk:{batchId}:{index}` so a retried request
  // replays already-created items instead of duplicating them.
  batchId: z.string().min(1).max(255).optional(),
});

export const assigneeBodySchema = z.object({
  accountId: z.string().nullable().optional(),
  name: z.string().optional(),
});

export const searchRequestSchema = z.object({
  jql: z.string().min(1),
  startAt: z.number().int().min(0).optional(),
  maxResults: z.number().int().min(1).optional(),
  fields: z.array(z.string()).optional(),
  expand: z.array(z.string()).optional(),
});

export const transitionIssueSchema = z.object({
  transition: z.object({ id: z.string().min(1) }),
  fields: z
    .object({
      resolution: z.object({ name: z.string().optional(), id: z.string().optional() }).optional().nullable(),
      assignee: z.object({ accountId: z.string().optional(), name: z.string().optional() }).optional().nullable(),
    })
    .optional(),
  update: z
    .object({
      comment: z.array(z.object({ add: z.object({ body: z.string().optional() }).optional() })).optional(),
    })
    .optional(),
});

/** 031: Jira comment/worklog visibility — {type:'role'|'group', value} or null. */
export const visibilitySchema = z
  .object({ type: z.enum(['role', 'group']), value: z.string().min(1) })
  .nullable()
  .optional();

export const commentSchema = z.object({
  body: z.string().min(1),
  visibility: visibilitySchema,
});

export const issueLinkSchema = z.object({
  type: z.object({ name: z.string().optional(), id: z.string().optional() }),
  outwardIssue: z.object({ key: z.string() }),
  inwardIssue: z.object({ key: z.string() }),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  lead: z.object({ accountId: z.string().optional(), name: z.string().optional() }).optional().nullable(),
  avatarColor: z.string().optional().nullable(),
  aiEnabled: z.boolean().optional(),
  agentGuidance: z.string().max(10_000).nullable().optional(), // 047 US4-3
  categoryId: z.string().nullable().optional(),
});

export const createSprintSchema = z.object({
  originBoardId: z.string().min(1),
  name: z.string().max(255).optional(),
  goal: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const updateSprintSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  goal: z.string().nullable().optional(),
  state: z.enum(['future', 'active', 'closed']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  moveOpenIssuesTo: z.union([z.enum(['backlog', 'new']), z.string()]).optional(),
  newSprintName: z.string().max(255).optional(),
});

export const issueKeysSchema = z.object({
  issues: z.array(z.string().min(1)).min(1),
});

export const boardTypeSchema = z.object({
  type: z.enum(['scrum', 'kanban']),
});

export const jqlParseSchema = z.object({
  queries: z.array(z.string()).min(1),
});

export const filterSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  jql: z.string().min(1).optional(),
  visibility: z.enum(['private', 'all']).optional(),
  // 032 US3 — Jira sharePermissions + TF-direct sharedScope/sharedTarget
  sharePermissions: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  sharedScope: z.string().optional(),
  sharedTarget: z.string().nullable().optional(),
  // UB-016 — Jira "Change owner": transfer ownership (owner/admin only).
  ownerAccountId: z.string().optional(),
});

export const createFilterSchema = filterSchema.extend({
  name: z.string().min(1),
  jql: z.string().min(1),
});

export function formatZodErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    errors[path] = issue.message;
  }
  return errors;
}

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createTokenSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
  projectKeys: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
  requireApproval: z.boolean().optional(),
  approvalPolicy: z.enum(['always', 'destructiveOnly', 'never']).optional(), // 047
});

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(8).optional(),
  isAdmin: z.boolean().optional(),
  type: z.enum(['human', 'agent']).optional(),
  ownerId: z.string().optional(),
  isAssignableAgent: z.boolean().optional(), // 047 — delegate picker eligibility
  approvalPolicy: z.enum(['always', 'destructiveOnly', 'never']).optional(), // 047
});

// --- Sprint 024: worklogs & timetracking ---

export const worklogSchema = z
  .object({
    timeSpent: z.string().optional(),
    timeSpentSeconds: z.number().int().positive().optional(),
    started: z.string().optional(),
    comment: z.string().nullable().optional(),
    billable: z.boolean().optional(),
    visibility: visibilitySchema,
  })
  .refine((v) => v.timeSpent !== undefined || v.timeSpentSeconds !== undefined, {
    message: 'timeSpent or timeSpentSeconds is required',
    path: ['timeSpent'],
  });

export const updateWorklogSchema = z.object({
  timeSpent: z.string().optional(),
  timeSpentSeconds: z.number().int().positive().optional(),
  started: z.string().optional(),
  comment: z.string().nullable().optional(),
  billable: z.boolean().optional(),
  visibility: visibilitySchema,
});

// 063 US5 — composite update (TF extension): fields/update + transition +
// comment + worklog in one PUT, applied in fixed order (fields → transition →
// comment → worklog). Jira requires separate calls; mcp-atlassian v0.24
// composes the same way. Every declared step is pre-validated before any
// write, so input errors never produce partial writes. `fields.status` stays
// rejected — `transition` is the legal composite status move.
export const compositeUpdateIssueSchema = updateIssueSchema.extend({
  transition: z
    .object({
      id: z.string().min(1),
      fields: z
        .object({
          resolution: z.object({ name: z.string().optional(), id: z.string().optional() }).optional().nullable(),
          assignee: z.object({ accountId: z.string().optional(), name: z.string().optional() }).optional().nullable(),
        })
        .optional(),
      update: z
        .object({
          comment: z.array(z.object({ add: z.object({ body: z.string().optional() }).optional() })).optional(),
        })
        .optional(),
    })
    .optional(),
  comment: z.object({ body: z.string().min(1).max(32767), visibility: visibilitySchema }).optional(),
  worklog: worklogSchema.optional(),
});

export const worklogListSchema = z.object({
  ids: z.array(z.string()).min(1).max(1000),
});

export const timeTrackingConfigSchema = z.object({
  hoursPerDay: z.number().min(1).max(24).optional(),
  daysPerWeek: z.number().min(1).max(7).optional(),
  format: z.enum(['pretty', 'hours']).optional(),
  defaultUnit: z.enum(['m', 'h', 'd', 'w']).optional(),
});

// ---- 021 — admin console ----

export const moduleTogglesSchema = z.object({
  ai: z.boolean().optional(),
  automation: z.boolean().optional(),
  devPanel: z.boolean().optional(),
  importers: z.boolean().optional(),
});

export const projectCategorySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional().nullable(),
});

// Generic metadata CRUD — each entity narrows via its own shape below.
export const statusSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.enum(['todo', 'inprogress', 'done']).optional(),
  sequence: z.number().int().optional(),
});
export const prioritySchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().max(32).optional().nullable(),
  sequence: z.number().int().optional(),
});
export const resolutionSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional().nullable(),
  sequence: z.number().int().optional(),
});
export const issueTypeSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional().nullable(),
  isSubtask: z.boolean().optional(),
  hierarchyLevel: z.number().int().optional(),
});
export const issueLinkTypeSchema = z.object({
  name: z.string().min(1).max(255),
  inward: z.string().min(1).max(255),
  outward: z.string().min(1).max(255),
});
