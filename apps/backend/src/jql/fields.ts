// Field registry for the supported JQL subset (sprint 010 contract).

export type FieldValueKind =
  | 'project'
  | 'issueKey'
  | 'status'
  | 'statusCategory'
  | 'issueType'
  | 'priority'
  | 'resolution'
  | 'user'
  | 'label'
  | 'date'
  | 'number'
  | 'sprint'
  | 'component'
  | 'version'
  | 'duration'
  | 'boolean'
  | 'security'
  | 'projectCategory'
  | 'filter'
  | 'text';

export interface FieldDef {
  /** canonical name used in errors/autocomplete */
  name: string;
  aliases: string[];
  displayName: string;
  operators: string[];
  valueKind: FieldValueKind;
  /** whether IS [NOT] EMPTY is allowed */
  nullable: boolean;
  /** whether the field may appear in ORDER BY */
  orderable: boolean;
  /** value suggestions come from this suggestion source (see suggestions route) */
  suggestAs?: string;
}

const EQ_OPS = ['=', '!=', 'IN', 'NOT IN'];
const CMP_OPS = ['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN'];
// 032 US2 — Jira's history-safe field set gets WAS/WAS NOT/CHANGED
const HIST_OPS = [...EQ_OPS, 'WAS', 'WAS NOT', 'CHANGED'];
const TXT_OPS = ['~', '!~'];

export const FIELDS: FieldDef[] = [
  {
    name: 'project',
    aliases: [],
    displayName: 'Project',
    operators: EQ_OPS,
    valueKind: 'project',
    nullable: false,
    orderable: true,
    suggestAs: 'project',
  },
  {
    name: 'key',
    aliases: ['issuekey', 'issue'],
    displayName: 'Key',
    operators: CMP_OPS,
    valueKind: 'issueKey',
    nullable: false,
    orderable: true,
    suggestAs: 'issueKey',
  },
  {
    name: 'summary',
    aliases: [],
    displayName: 'Summary',
    operators: TXT_OPS,
    valueKind: 'text',
    nullable: false,
    orderable: true,
  },
  {
    name: 'description',
    aliases: [],
    displayName: 'Description',
    operators: TXT_OPS,
    valueKind: 'text',
    nullable: true,
    orderable: false,
  },
  {
    name: 'text',
    aliases: [],
    displayName: 'Text',
    operators: TXT_OPS,
    valueKind: 'text',
    nullable: false,
    orderable: false,
  },
  {
    name: 'comment',
    aliases: [],
    displayName: 'Comment',
    operators: TXT_OPS,
    valueKind: 'text',
    nullable: false,
    orderable: false,
  },
  {
    name: 'status',
    aliases: [],
    displayName: 'Status',
    operators: HIST_OPS,
    valueKind: 'status',
    nullable: false,
    orderable: true,
    suggestAs: 'status',
  },
  {
    name: 'statusCategory',
    aliases: [],
    displayName: 'Status Category',
    operators: EQ_OPS,
    valueKind: 'statusCategory',
    nullable: false,
    orderable: false,
    suggestAs: 'statusCategory',
  },
  {
    name: 'issuetype',
    aliases: ['type'],
    displayName: 'Issue Type',
    operators: EQ_OPS,
    valueKind: 'issueType',
    nullable: false,
    orderable: true,
    suggestAs: 'issueType',
  },
  {
    name: 'priority',
    aliases: [],
    displayName: 'Priority',
    operators: [...CMP_OPS, 'WAS', 'WAS NOT', 'CHANGED'],
    valueKind: 'priority',
    nullable: false,
    orderable: true,
    suggestAs: 'priority',
  },
  {
    name: 'resolution',
    aliases: [],
    displayName: 'Resolution',
    operators: HIST_OPS,
    valueKind: 'resolution',
    nullable: true,
    orderable: true,
    suggestAs: 'resolution',
  },
  {
    name: 'assignee',
    aliases: [],
    displayName: 'Assignee',
    operators: HIST_OPS,
    valueKind: 'user',
    nullable: true,
    orderable: true,
    suggestAs: 'user',
  },
  {
    name: 'delegate',
    aliases: ['delegatedto'],
    displayName: 'Delegate',
    operators: EQ_OPS,
    valueKind: 'user',
    nullable: true,
    orderable: false,
    suggestAs: 'user',
  },
  {
    name: 'reporter',
    aliases: [],
    displayName: 'Reporter',
    operators: HIST_OPS,
    valueKind: 'user',
    nullable: true,
    orderable: true,
    suggestAs: 'user',
  },
  {
    name: 'labels',
    aliases: ['label'],
    displayName: 'Labels',
    operators: EQ_OPS,
    valueKind: 'label',
    nullable: true,
    orderable: false,
    suggestAs: 'label',
  },
  {
    name: 'parent',
    aliases: [],
    displayName: 'Parent',
    operators: EQ_OPS,
    valueKind: 'issueKey',
    nullable: true,
    orderable: false,
    suggestAs: 'issueKey',
  },
  {
    name: 'created',
    aliases: ['createddate'],
    displayName: 'Created',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: false,
    orderable: true,
  },
  {
    name: 'updated',
    aliases: ['updateddate'],
    displayName: 'Updated',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: false,
    orderable: true,
  },
  {
    name: 'resolved',
    aliases: ['resolutiondate'],
    displayName: 'Resolved',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: true,
    orderable: true,
  },
  {
    name: 'duedate',
    aliases: ['due'],
    displayName: 'Due Date',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: true,
    orderable: true,
  },
  {
    name: 'lastviewed',
    aliases: ['viewed'],
    displayName: 'Last Viewed',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: true,
    // Prisma can't ORDER BY a filtered relation (my recentViews row) — Jira
    // sorts "Viewed recently" by it, we filter only.
    orderable: false,
  },
  {
    name: 'storypoints',
    aliases: ['story_points', 'storypointestimate', 'points'],
    displayName: 'Story Points',
    operators: CMP_OPS,
    valueKind: 'number',
    nullable: true,
    orderable: true,
  },
  {
    name: 'sprint',
    aliases: [],
    displayName: 'Sprint',
    operators: HIST_OPS,
    valueKind: 'sprint',
    nullable: true,
    orderable: false,
    suggestAs: 'sprint',
  },
  // --- sprint 019: release management ---
  {
    name: 'component',
    aliases: ['components'],
    displayName: 'Component',
    operators: EQ_OPS,
    valueKind: 'component',
    nullable: true,
    orderable: false,
    suggestAs: 'component',
  },
  {
    name: 'fixversion',
    aliases: ['fixversions'],
    displayName: 'Fix Version',
    operators: HIST_OPS,
    valueKind: 'version',
    nullable: true,
    orderable: false,
    suggestAs: 'version',
  },
  {
    name: 'affectedversion',
    aliases: ['affectsversion', 'versions', 'affectedversions'],
    displayName: 'Affects Version',
    operators: EQ_OPS,
    valueKind: 'version',
    nullable: true,
    orderable: false,
    suggestAs: 'version',
  },
  // --- sprint 024: time tracking ---
  {
    name: 'timespent',
    aliases: ['timeSpent'.toLowerCase()],
    displayName: 'Time Spent',
    operators: CMP_OPS,
    valueKind: 'duration',
    nullable: true,
    orderable: false,
  },
  {
    name: 'timeoriginalestimate',
    aliases: ['originalestimate', 'timeoriginalest'],
    displayName: 'Original Estimate',
    operators: CMP_OPS,
    valueKind: 'duration',
    nullable: true,
    orderable: true,
  },
  {
    name: 'timeestimate',
    aliases: ['remainingestimate'],
    displayName: 'Remaining Estimate',
    operators: CMP_OPS,
    valueKind: 'duration',
    nullable: true,
    orderable: true,
  },
  {
    name: 'workratio',
    aliases: [],
    displayName: 'Work Ratio',
    operators: CMP_OPS,
    valueKind: 'number',
    nullable: true,
    orderable: false,
  },
  {
    name: 'worklogdate',
    aliases: [],
    displayName: 'Worklog Date',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: true,
    orderable: false,
  },
  {
    // 068 — "issues commented today": comment createdAt as a first-class date
    // field (TF ext; Jira has no comment-date field — apps add it).
    name: 'commentdate',
    aliases: ['commented'],
    displayName: 'Comment Date',
    operators: CMP_OPS,
    valueKind: 'date',
    nullable: true,
    orderable: false,
  },
  {
    name: 'billable',
    aliases: [],
    displayName: 'Billable',
    operators: EQ_OPS,
    valueKind: 'boolean',
    nullable: true,
    orderable: false,
  },
  // --- sprint 032 US3: coverage fields ---
  {
    name: 'votes',
    aliases: ['votecount'],
    displayName: 'Votes',
    operators: CMP_OPS,
    valueKind: 'number',
    nullable: false,
    orderable: true,
  },
  {
    name: 'watches',
    aliases: ['watchers', 'watchcount'],
    displayName: 'Watchers',
    operators: CMP_OPS,
    valueKind: 'number',
    nullable: false,
    orderable: true,
  },
  {
    name: 'security',
    aliases: ['level', 'securitylevel'],
    displayName: 'Security Level',
    operators: EQ_OPS,
    valueKind: 'security',
    nullable: true,
    orderable: false,
  },
  {
    name: 'projectcategory',
    aliases: ['category'],
    displayName: 'Project Category',
    operators: EQ_OPS,
    valueKind: 'projectCategory',
    nullable: true,
    orderable: false,
  },
  {
    name: 'filter',
    aliases: ['savedfilter', 'request'],
    displayName: 'Filter',
    operators: EQ_OPS,
    valueKind: 'filter',
    nullable: false,
    orderable: false,
  },
  // --- sprint 032 US5: remaining §10.2 coverage ---
  {
    name: 'environment',
    aliases: ['env'],
    displayName: 'Environment',
    operators: [...EQ_OPS, '~', '!~'],
    valueKind: 'text',
    nullable: true,
    orderable: false,
  },
  {
    name: 'epiclink',
    aliases: ['epic', 'epiclink', 'epic link'],
    displayName: 'Epic Link',
    operators: EQ_OPS,
    valueKind: 'issueKey',
    nullable: true,
    orderable: false,
    suggestAs: 'issueKey',
  },
];

const byName = new Map<string, FieldDef>();
for (const f of FIELDS) {
  byName.set(f.name.toLowerCase(), f);
  for (const a of f.aliases) byName.set(a.toLowerCase(), f);
}

export function lookupField(raw: string): FieldDef | undefined {
  return byName.get(raw.toLowerCase());
}

export const ORDERABLE_FIELDS = new Map<string, string>([
  ['key', 'key'],
  ['issuekey', 'key'],
  ['created', 'created'],
  ['updated', 'updated'],
  ['priority', 'priority'],
  ['status', 'status'],
  ['assignee', 'assignee'],
  ['duedate', 'duedate'],
  ['due', 'duedate'],
  ['rank', 'rank'],
  ['summary', 'summary'],
  ['resolution', 'resolution'],
  ['resolved', 'resolved'],
  ['project', 'project'],
  ['issuetype', 'issuetype'],
  ['type', 'issuetype'],
  ['storypoints', 'storypoints'],
  ['story_points', 'storypoints'],
  ['sprint', 'sprint'],
  ['timeestimate', 'timeestimate'],
  ['remainingestimate', 'timeestimate'],
  ['timeoriginalestimate', 'timeoriginalestimate'],
  ['originalestimate', 'timeoriginalestimate'],
]);

/** Sprint-list functions valid as `sprint IN/=` operands. */
export const SPRINT_FUNCTIONS = new Set(['opensprints', 'closedsprints', 'futuresprints']);

/** 019: version-list functions for fixVersion/affectedVersion operands. */
export const VERSION_FUNCTIONS = new Set(['releasedversions', 'unreleasedversions', 'earliestunreleasedversion']);

export const DATE_FUNCTIONS = new Set([
  'now',
  'startofday',
  'endofday',
  'startofweek',
  'endofweek',
  'startofmonth',
  'endofmonth',
]);

export const JQL_RESERVED_WORDS = [
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'EMPTY',
  'NULL',
  'ORDER',
  'BY',
  'ASC',
  'DESC',
  'WAS',
  'CHANGED',
  'FROM',
  'TO',
  'BEFORE',
  'AFTER',
  'ON',
  'DURING',
];
