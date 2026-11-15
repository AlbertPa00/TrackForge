const API_BASE = '/rest/api/2';
const INTERNAL_BASE = '/api/internal';

export interface Project {
  id: string;
  key: string;
  name: string;
  description?: string;
  projectTypeKey: string;
  avatarColor?: string;
  lead?: UserRef;
  workflow?: { id: string; name: string };
  agentGuidance?: string | null; // 047
  archived?: boolean;
  projectCategory?: { id: string; name: string; description?: string };
  /** 062 US4 — types usable in this project (scheme-scoped when bound). */
  issueTypes?: { id: string; name: string; description?: string; subtask: boolean; hierarchyLevel: number }[];
  // 031: which scheme is bound per kind (null = unbound)
  schemeIds?: {
    issueSecurity: string | null;
    issueTypeScreen: string | null;
    fieldConfiguration: string | null;
    issueType: string | null;
    workflow: string | null;
    notification: string | null;
    permission?: string | null;
  };
}

export interface StatusCategory {
  key: string;
  name: string;
}

export interface StatusRef {
  id: string;
  name: string;
  statusCategory: StatusCategory;
}

export interface PriorityMeta {
  id: string;
  name: string;
  statusColor?: string;
}

export interface IssueTypeMeta {
  id: string;
  name: string;
  description: string;
  subtask: boolean;
  hierarchyLevel: number;
}

export interface UserRef {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  agent?: boolean;
  avatarEmoji?: string | null;
}

export interface Myself {
  accountId: string;
  displayName: string;
  emailAddress: string;
  active: boolean;
  agent?: boolean;
  isAdmin?: boolean;
  avatarEmoji?: string | null;
}

export interface ChangeItem {
  field: string;
  fieldtype: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}

export interface ChangeHistoryEntry {
  id: string;
  author: UserRef;
  channel: string;
  created: string;
  items: ChangeItem[];
}

export interface LinkedIssueRef {
  id: string;
  type: { id: string; name: string; inward: string; outward: string };
  inwardIssue?: { id: string; key: string; fields?: { status?: StatusRef } };
  outwardIssue?: { id: string; key: string; fields?: { status?: StatusRef } };
}

export interface Issue {
  id: string;
  key: string;
  self: string;
  changelog?: {
    startAt: number;
    maxResults: number;
    total: number;
    histories: ChangeHistoryEntry[];
  };
  fields: {
    summary: string;
    description?: string;
    project: { id: string; key: string; name: string; projectTypeKey: string };
    issuetype: { id: string; name: string; subtask?: boolean; hierarchyLevel?: number };
    status: StatusRef;
    priority: { id: string; name: string };
    assignee: UserRef | null;
    delegate?: UserRef | null; // 047 — agent working the issue; assignee stays accountable
    reporter: UserRef | null;
    sprint: { id: string; name: string } | null;
    story_points?: number | null;
    labels: string[];
    duedate: string | null;
    resolution: { id: string; name: string } | null;
    resolutiondate: string | null;
    parent?: {
      id: string;
      key: string;
      fields: {
        summary: string;
        issuetype?: { id: string; name: string; subtask?: boolean; hierarchyLevel?: number };
        status?: StatusRef;
      };
    };
    subtasks: {
      id: string;
      key: string;
      fields: {
        summary: string;
        issuetype: { id: string; name: string; subtask?: boolean; hierarchyLevel?: number };
        status?: StatusRef;
      };
    }[];
    issuelinks: LinkedIssueRef[];
    created: string;
    updated: string;
    // Sprint 019 — component/version refs.
    components?: { id: string; name: string }[];
    fixVersions?: { id: string; name: string }[];
    versions?: { id: string; name: string }[];
    // Sprint 018 — attachments.
    attachment?: Attachment[];
    // Sprint 024 — present when the issue has estimates or logged work.
    timetracking?: {
      originalEstimate?: string;
      remainingEstimate?: string;
      timeSpent?: string;
      originalEstimateSeconds?: number;
      remainingEstimateSeconds?: number;
      timeSpentSeconds?: number;
    };
    workratio?: number;
    aggregatetimespent?: { seconds: number; formatted?: string };
    worklog?: { total: number };
    // Sprint 022 — votes/watches/environment + remote links.
    votes?: { self: string; votes: number; hasVoted: boolean };
    watches?: { self: string; watchCount: number; isWatching: boolean };
    environment?: string;
    // customfield_NNNNN values land here (unknown shape — typed via editmeta).
    [customField: string]: unknown;
  };
}

export interface Comment {
  id: string;
  author: UserRef;
  body: string;
  created: string;
  updated: string;
  channel?: string;
}

/** Sprint 018 — Jira attachment metadata. */
export interface Attachment {
  self: string;
  id: string;
  filename: string;
  author: UserRef;
  created: string;
  size: number;
  mimeType: string;
  content: string;
  thumbnail?: string;
}

/** Server-side URLs are absolute — strip to the API path for the dev proxy. */
export function attachmentPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export interface CommentPage {
  startAt: number;
  maxResults: number;
  total: number;
  comments: Comment[];
}

export interface Resolution {
  id: string;
  name: string;
  description: string;
}

export interface IssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface SearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: Issue[];
}

export interface TransitionField {
  required: boolean;
  name: string;
  schema: { type: string };
  operations: string[];
}

export interface Transition {
  id: string;
  name: string;
  hasScreen?: boolean;
  isGlobal?: boolean;
  isConditional?: boolean;
  /** Jira-style field map — present when the transition has a screen. */
  fields?: Record<string, TransitionField>;
  to: {
    id: string;
    name: string;
    statusCategory: StatusCategory;
  };
}

export interface Board {
  id: string;
  name: string;
  type: string;
  isDefault?: boolean;
  location: { projectKey: string; projectName: string };
}

export interface QuickFilter {
  id: string;
  boardId: string;
  name: string;
  jql: string;
  position: number;
}

export interface CardConfig {
  daysInColumn?: boolean;
  hideDone?: boolean;
  swimlaneBy?: 'none' | 'assignee' | 'epic' | 'priority' | 'subtasks';
  colors?: Record<string, string>;
  statistics?: string[];
  indicators?: { comments?: boolean; attachments?: boolean; links?: boolean; flag?: boolean };
}

export interface BoardColumnConfig {
  name: string;
  min?: number;
  max?: number;
  statuses: StatusRef[];
}

export interface BoardConfiguration {
  id: string;
  name: string;
  type: string;
  columnConfig: { columns: BoardColumnConfig[]; unmapped?: StatusRef[] };
}

export interface Sprint {
  id: string;
  state: 'future' | 'active' | 'closed';
  name: string;
  goal?: string;
  originBoardId?: string;
  sequence?: number;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorMessages: string[],
    public errors: Record<string, string>,
    /** Server-supplied Retry-After, seconds (429 responses only). */
    public retryAfter?: number
  ) {
    super(errorMessages[0] ?? Object.values(errors)[0] ?? `Request failed (${status})`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T>;
async function request<T>(path: string, base: string, init?: RequestInit): Promise<T>;
async function request<T>(path: string, baseOrInit?: string | RequestInit, init?: RequestInit): Promise<T> {
  const base = typeof baseOrInit === 'string' ? baseOrInit : API_BASE;
  const options = typeof baseOrInit === 'object' ? baseOrInit : init;
  const res = await fetch(`${base}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  // /docs is a public surface — 401s there must not bounce to login.
  if (
    res.status === 401 &&
    !window.location.pathname.startsWith('/login') &&
    !window.location.pathname.startsWith('/docs')
  ) {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    throw new ApiError(
      res.status,
      body.errorMessages ?? [],
      body.errors ?? {},
      Number.isFinite(retryAfter) ? retryAfter : undefined
    );
  }
  return body as T;
}

export function fetchProjects(): Promise<Project[]> {
  return request('/project');
}

export function fetchProject(key: string): Promise<Project> {
  return request(`/project/${key}`);
}

export function createProject(data: { key: string; name: string; description?: string }): Promise<Project> {
  return request('/project', { method: 'POST', body: JSON.stringify(data) });
}

export function fetchIssue(key: string): Promise<Issue> {
  return request(`/issue/${key}?expand=changelog`);
}

export function createIssue(data: {
  projectKey: string;
  summary: string;
  description?: string;
  issueTypeName?: string;
  priorityName?: string;
  labels?: string[];
  parentKey?: string;
  /** accountId — stable across display-name changes/duplicates. */
  assigneeId?: string;
  dueDate?: string;
  storyPoints?: number | null;
  components?: { id: string }[];
  fixVersions?: { id: string }[];
  affectsVersions?: { id: string }[];
  customFields?: Record<string, unknown>;
}): Promise<Issue> {
  return request('/issue', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        project: { key: data.projectKey },
        summary: data.summary,
        description: data.description || undefined,
        issuetype: data.issueTypeName ? { name: data.issueTypeName } : undefined,
        priority: data.priorityName ? { name: data.priorityName } : undefined,
        labels: data.labels,
        parent: data.parentKey ? { key: data.parentKey } : undefined,
        assignee: data.assigneeId ? { accountId: data.assigneeId } : undefined,
        duedate: data.dueDate || undefined,
        story_points: data.storyPoints ?? undefined,
        components: data.components?.length ? data.components : undefined,
        fixVersions: data.fixVersions?.length ? data.fixVersions : undefined,
        versions: data.affectsVersions?.length ? data.affectsVersions : undefined,
        ...data.customFields,
      },
    }),
  });
}

export interface BulkIssueItem {
  fields: {
    project: { key: string };
    summary: string;
    issuetype?: { name: string };
    description?: string;
    parent?: { key: string };
    assignee?: { accountId: string } | null;
    labels?: string[];
    [customField: string]: unknown;
  };
}
export interface BulkIssueResult {
  issues: Issue[];
  errors: {
    status: number;
    failedElementNumber?: number;
    elementErrors?: { errorMessages?: string[]; errors?: Record<string, string> };
  }[];
}

/** 058 US4 — Jira bulk-create; `batchId` (057) makes retried batches replay-safe. */
export function createIssuesBulk(issueUpdates: BulkIssueItem[], batchId?: string): Promise<BulkIssueResult> {
  return request('/issue/bulk', {
    method: 'POST',
    body: JSON.stringify({ issueUpdates, ...(batchId ? { batchId } : {}) }),
  });
}

export function fetchTransitions(key: string): Promise<Transition[]> {
  return request<{ transitions: Transition[] }>(`/issue/${key}/transitions`).then((r) => r.transitions);
}

export function executeTransition(
  key: string,
  transitionId: string,
  body?: { fields?: Record<string, unknown>; comment?: string }
): Promise<void> {
  return request(`/issue/${key}/transitions`, {
    method: 'POST',
    body: JSON.stringify({
      transition: { id: transitionId },
      ...(body?.fields ? { fields: body.fields } : {}),
      ...(body?.comment ? { update: { comment: [{ add: { body: body.comment } }] } } : {}),
    }),
  });
}

export function searchIssues(
  jql: string,
  opts: { startAt?: number; maxResults?: number; fields?: string[] } = {}
): Promise<SearchResult> {
  const params = new URLSearchParams({ jql });
  params.set('startAt', String(opts.startAt ?? 0));
  params.set('maxResults', String(opts.maxResults ?? 50));
  if (opts.fields?.length) params.set('fields', opts.fields.join(','));
  return request(`/search?${params}`);
}

const AGILE_BASE = '/rest/agile/1.0';

export function fetchBoard(projectKey: string): Promise<Board | null> {
  return request<{ values: Board[] }>(`/board?projectKeyOrId=${projectKey}`, AGILE_BASE).then(
    (r) => r.values[0] ?? null
  );
}

/** 033 — every board of a project (N:1); first entry is the default. */
export function fetchBoards(projectKey: string): Promise<Board[]> {
  return request<{ values: Board[] }>(`/board?projectKeyOrId=${projectKey}`, AGILE_BASE).then((r) => r.values);
}

/** 058 US6 — all boards for config pickers (no project scoping). */
export function fetchAllBoards(): Promise<Board[]> {
  return request<{ values: Board[] }>(`/board`, AGILE_BASE).then((r) => r.values);
}

export function createBoard(data: {
  name: string;
  type?: 'scrum' | 'kanban';
  filterId?: string;
  projectKeyOrId: string;
}): Promise<Board> {
  return request('/board', AGILE_BASE, {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      type: data.type,
      filterId: data.filterId,
      location: { type: 'project', projectKeyOrId: data.projectKeyOrId },
    }),
  });
}

export function updateBoard(
  boardId: string,
  data: { name?: string; filterId?: string | null; filter?: string | null }
): Promise<Board> {
  return request(`/boards/${encodeURIComponent(boardId)}`, INTERNAL_BASE, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteBoard(boardId: string, promoteTo?: string): Promise<void> {
  const qs = promoteTo ? `?promoteTo=${encodeURIComponent(promoteTo)}` : '';
  return request(`/board/${encodeURIComponent(boardId)}${qs}`, AGILE_BASE, { method: 'DELETE' });
}

export function setDefaultBoard(boardId: string): Promise<Board> {
  return request(`/boards/${encodeURIComponent(boardId)}/default`, INTERNAL_BASE, { method: 'POST' });
}

export function fetchQuickFilters(boardId: string): Promise<QuickFilter[]> {
  return request(`/board/${encodeURIComponent(boardId)}/quickfilter`, AGILE_BASE);
}

export function createQuickFilter(
  boardId: string,
  data: { name: string; jql: string; position?: number }
): Promise<QuickFilter> {
  return request(`/boards/${encodeURIComponent(boardId)}/quickfilters`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateQuickFilter(
  boardId: string,
  qfId: string,
  data: { name?: string; jql?: string; position?: number }
): Promise<QuickFilter> {
  return request(`/boards/${encodeURIComponent(boardId)}/quickfilters/${encodeURIComponent(qfId)}`, INTERNAL_BASE, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteQuickFilter(boardId: string, qfId: string): Promise<void> {
  return request(`/boards/${encodeURIComponent(boardId)}/quickfilters/${encodeURIComponent(qfId)}`, INTERNAL_BASE, {
    method: 'DELETE',
  });
}

export function fetchCardConfig(boardId: string): Promise<CardConfig> {
  return request(`/board/${encodeURIComponent(boardId)}/cardconfig`, AGILE_BASE);
}

export function updateCardConfig(boardId: string, config: CardConfig): Promise<CardConfig> {
  return request(`/boards/${encodeURIComponent(boardId)}/cardconfig`, INTERNAL_BASE, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export interface PickedIssue {
  id: string;
  key: string;
  keyHtml: string;
  summary: string;
  issueType: string;
  status: string;
  statusCategory?: string;
}

export function pickIssues(
  query: string,
  maxResults = 10
): Promise<{ sections: { label: string; issues: PickedIssue[] }[] }> {
  return request(`/issue/picker?query=${encodeURIComponent(query)}&maxResults=${maxResults}`);
}

export function fetchBoardConfiguration(boardId: string): Promise<BoardConfiguration> {
  return request(`/board/${boardId}/configuration`, AGILE_BASE);
}

export function updateBoardConfiguration(
  boardId: string,
  columns: { name: string; statusIds: string[]; min?: number | null; max?: number | null }[]
): Promise<BoardConfiguration> {
  return request(`/board/${boardId}/configuration`, AGILE_BASE, {
    method: 'PUT',
    body: JSON.stringify({ columns }),
  });
}

export function rankIssues(
  issues: string[],
  pos: { rankBeforeIssue?: string; rankAfterIssue?: string }
): Promise<void> {
  return request('/issue/rank', AGILE_BASE, {
    method: 'PUT',
    body: JSON.stringify({ issues, ...pos }),
  });
}

// 042 F-004: board/sprint fetches auto-page instead of silently truncating at
// the server page cap — callers rendering full-column views always get the
// complete set. Explicit startAt opts still fetch a single page.
const PAGE = 200;
async function pagedIssues<T extends { startAt: number; total: number; issues: Issue[] }>(
  fetchPage: (startAt: number) => Promise<T>
): Promise<T> {
  const first = await fetchPage(0);
  if (first.issues.length >= first.total) return first;
  const all = [...first.issues];
  for (let startAt = first.issues.length; startAt < first.total && all.length < 2000; startAt += PAGE) {
    const next = await fetchPage(startAt);
    all.push(...next.issues);
    if (next.issues.length === 0) break;
  }
  return { ...first, issues: all };
}

export function fetchBoardIssues(
  boardId: string,
  opts: { startAt?: number; maxResults?: number; quickFilterIds?: string[] } = {}
): Promise<SearchResult> {
  const page = (startAt: number) => {
    const params = new URLSearchParams({
      startAt: String(opts.startAt ?? startAt),
      maxResults: String(opts.maxResults ?? PAGE),
    });
    if (opts.quickFilterIds?.length) params.set('quickFilterIds', opts.quickFilterIds.join(','));
    return request<SearchResult>(`/board/${boardId}/issue?${params}`, AGILE_BASE);
  };
  // explicit window → single page; default → auto-page to full result set
  return opts.startAt !== undefined ? page(opts.startAt) : pagedIssues(page);
}

export function fetchSprints(boardId: string, states?: string[]): Promise<Sprint[]> {
  const params = states?.length ? `?state=${states.join(',')}` : '';
  return request<{ values: Sprint[] }>(`/board/${boardId}/sprint${params}`, AGILE_BASE).then((r) => r.values);
}

export function createSprint(data: {
  originBoardId: string;
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
}): Promise<Sprint> {
  return request('/sprint', AGILE_BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function fetchSprint(id: string): Promise<Sprint> {
  return request(`/sprint/${id}`, AGILE_BASE);
}

export function updateSprint(
  id: string,
  data: {
    name?: string;
    goal?: string | null;
    state?: 'future' | 'active' | 'closed';
    startDate?: string;
    endDate?: string;
    moveOpenIssuesTo?: 'backlog' | 'new' | string;
    newSprintName?: string;
  }
): Promise<Sprint> {
  return request(`/sprint/${id}`, AGILE_BASE, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteSprint(id: string): Promise<void> {
  return request(`/sprint/${id}`, AGILE_BASE, { method: 'DELETE' });
}

export function setBoardType(boardId: string, type: 'scrum' | 'kanban'): Promise<Board> {
  return request(`/board/${boardId}/type`, AGILE_BASE, {
    method: 'PUT',
    body: JSON.stringify({ type }),
  });
}

export interface BacklogPage {
  startAt: number;
  maxResults: number;
  total: number;
  issues: Issue[];
}

export function fetchBacklog(
  boardId: string,
  startAt = 0,
  maxResults = 100,
  quickFilterIds?: string[]
): Promise<BacklogPage> {
  const qf = quickFilterIds?.length ? `&quickFilterIds=${quickFilterIds.join(',')}` : '';
  return request(`/board/${boardId}/backlog?startAt=${startAt}&maxResults=${maxResults}${qf}`, AGILE_BASE);
}

export function fetchSprintIssues(
  sprintId: string,
  maxResults?: number,
  quickFilterIds?: string[]
): Promise<BacklogPage> {
  const qf = quickFilterIds?.length ? `&quickFilterIds=${quickFilterIds.join(',')}` : '';
  if (maxResults !== undefined) {
    return request(`/sprint/${sprintId}/issue?maxResults=${maxResults}${qf}`, AGILE_BASE);
  }
  return pagedIssues((startAt) =>
    request<BacklogPage>(`/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=${PAGE}${qf}`, AGILE_BASE)
  );
}

export interface VelocitySprint {
  sprint: Sprint;
  committedPoints: number;
  completedPoints: number;
  issueCount: number;
  unestimatedCount: number;
}

export function fetchVelocity(boardId: string): Promise<{ boardId: string; sprints: VelocitySprint[] }> {
  return request(`/api/internal/reports/board/${boardId}/velocity`, '');
}

export interface BurndownPoint {
  date: string;
  remaining: number;
  scope: number;
  done: number;
}

export function fetchBurndown(
  boardId: string,
  sprintId?: string
): Promise<{ sprint: Sprint; startDate: string; endDate: string; issueCount: number; series: BurndownPoint[] }> {
  const q = sprintId ? `?sprintId=${sprintId}` : '';
  return request(`/api/internal/reports/board/${boardId}/burndown${q}`, '');
}

export function fetchCfd(
  boardId: string,
  days = 30
): Promise<{ columns: string[]; series: { date: string; counts: Record<string, number> }[] }> {
  return request(`/api/internal/reports/cfd/${boardId}?days=${days}`, '');
}
export function fetchControlChart(
  boardId: string,
  days = 30
): Promise<{
  issues: { key: string; summary: string; cycleDays: number; completedAt: string }[];
  mean: number;
  stddev: number;
  rolling: { completedAt: string; avg: number }[];
}> {
  return request(`/api/internal/reports/control/${boardId}?days=${days}`, '');
}
export function fetchEpicReport(epicKey: string): Promise<{
  total: number;
  completed: number;
  totalPoints: number;
  completedPoints: number;
  percentComplete: number;
  remainingIssues: { key: string; summary: string; status: string }[];
  forecast: { velocityPerSprint: number | null; sprintsRemaining: number | null };
}> {
  return request(`/api/internal/reports/epic/${encodeURIComponent(epicKey)}`, '');
}

export function moveIssuesToSprint(sprintId: string, issueKeys: string[]): Promise<void> {
  return request(`/sprint/${sprintId}/issue`, AGILE_BASE, {
    method: 'POST',
    body: JSON.stringify({ issues: issueKeys }),
  });
}

export function moveIssuesToBacklog(issueKeys: string[]): Promise<void> {
  return request('/backlog/issue', AGILE_BASE, {
    method: 'POST',
    body: JSON.stringify({ issues: issueKeys }),
  });
}

export function moveIssuesToEpic(epicKey: string, issueKeys: string[]): Promise<void> {
  return request(`/epic/${epicKey}/issue`, AGILE_BASE, {
    method: 'POST',
    body: JSON.stringify({ issues: issueKeys }),
  });
}

export interface SprintScopeSuggestion {
  picks: { key: string; reason: string }[];
  deferred: { key: string; reason: string }[];
}

export function suggestSprintScope(
  boardId: string,
  opts: { goal?: string; capacity?: number } = {}
): Promise<SprintScopeSuggestion> {
  return request(`/api/internal/ai/sprints/${boardId}/scope`, '', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

export function fetchStatuses(): Promise<StatusRef[]> {
  return request('/status');
}

export function fetchPriorities(): Promise<PriorityMeta[]> {
  return request('/priority');
}

export function fetchIssueTypes(): Promise<IssueTypeMeta[]> {
  return request('/issuetype');
}

export function fetchMyself(): Promise<Myself> {
  return request('/myself');
}

export function login(
  email: string,
  password: string,
  remember = false
): Promise<Myself | { totpRequired: true; pending: string }> {
  return request('/auth/login', INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ email, password, remember }),
  });
}

export function logout(): Promise<void> {
  return request('/auth/logout', INTERNAL_BASE, { method: 'POST' });
}

/** GET /user/search — people picker search (≥2 chars, Jira-shaped). */
export function searchUsers(query: string): Promise<UserRef[]> {
  return request(`/user/search?query=${encodeURIComponent(query)}`);
}

export function searchAssignableUsers(projectKey: string, query: string): Promise<UserRef[]> {
  const params = new URLSearchParams({ project: projectKey, query });
  return request(`/user/assignable/search?${params}`);
}

// --- People directory ---

export interface PersonEntry extends UserRef {
  openIssueCount: number;
}
export interface PeoplePage {
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
  values: PersonEntry[];
}
/** GET /api/internal/people — paginated people directory for the People page
 *  (open-issue counts computed server-side; browseable without a query). */
export function fetchPeople(query = '', startAt = 0, maxResults = 50): Promise<PeoplePage> {
  const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) });
  if (query) params.set('query', query);
  return request(`/people?${params}`, INTERNAL_BASE);
}

export function assignIssue(issueKey: string, accountId: string | null): Promise<void> {
  return request(`/issue/${issueKey}/assignee`, {
    method: 'PUT',
    body: JSON.stringify({ accountId }),
  });
}

// --- Sprint 047: agents (delegate, sessions, questions) ---

export function searchDelegateAgents(query: string): Promise<UserRef[]> {
  const params = new URLSearchParams({ agents: 'true', query });
  return request(`/user/assignable/search?${params}`);
}

export interface AgentSessionView {
  id: string;
  issueKey: string;
  agent: string;
  delegator: string | null;
  trigger: string;
  status: string;
  activities: { at: string; type: string; text: string; by: string }[];
  guidance: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastActivityAt: string;
}

export function fetchIssueSessions(issueKey: string): Promise<{ sessions: AgentSessionView[] }> {
  return request(`/issues/${issueKey}/sessions`, INTERNAL_BASE);
}

/** 058 US7 — project landing-page aggregate. */
export interface ProjectSummary {
  totals: { issues: number; open: number };
  statusRollup: { status: string; category: string; count: number }[];
  openByPriority: { priority: string; sequence: number; count: number }[];
  activity: {
    type: 'comment' | 'change';
    at: string;
    issueKey: string;
    issueSummary: string;
    actor: string;
    actorAccountId: string;
    agent: boolean;
    channel: string;
    text: string;
  }[];
  upcomingVersions: { id: string; name: string; releaseDate: string | null; issueCount: number }[];
  workload: { user: string; accountId: string; agent: boolean; open: number }[];
  agents: { running: number; blocked: number; needsAnswer: number; openQuestions: number; agents: string[] };
}
export function fetchProjectSummary(projectKey: string): Promise<ProjectSummary> {
  return request(`/projects/${projectKey}/summary`, INTERNAL_BASE);
}

/** 058 US5 — one-shot agent-activity map for every issue in a project. */
export interface AgentActivity {
  running: number;
  blocked: number;
  needsAnswer: number;
  agents: string[];
}
export function fetchAgentActivity(projectKey: string): Promise<{ issues: Record<string, AgentActivity> }> {
  return request(`/projects/${projectKey}/agent-activity`, INTERNAL_BASE);
}

export interface AgentQuestion {
  id: string;
  sessionId: string;
  question: string;
  options: string[] | null;
  status: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  expiresAt: string | null;
}

export function fetchOpenQuestions(issueKey: string): Promise<{ questions: AgentQuestion[] }> {
  return request(`/issues/${issueKey}/agent-questions?status=open`, INTERNAL_BASE);
}

export function answerAgentQuestion(questionId: string, answer: string): Promise<AgentQuestion> {
  return request(`/agent-questions/${questionId}/answer`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  });
}

export function delegateIssue(issueKey: string, agent: { name?: string; accountId?: string } | null): Promise<void> {
  return request(`/issue/${issueKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { delegate: agent } }),
  });
}

/** 063 US4 — atomic ready-work claim: delegate + agent session in one tx. */
export interface ClaimResult {
  issue: {
    id: string;
    key: string;
    fields: {
      summary: string;
      status?: string;
      delegate: { accountId: string; displayName: string };
    };
  };
  sessionId: string;
}
export function claimReadyWork(
  projectKey: string,
  opts?: { jql?: string; agent?: { accountId?: string; name?: string } }
): Promise<ClaimResult> {
  return request('/agent/claim', INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ projectKey, ...opts }),
  });
}

// --- Sprint 008: editable fields, comments, links, deletes ---

export interface IssueFieldUpdate {
  summary?: string;
  description?: string | null;
  status?: { name: string };
  priority?: { name: string };
  issuetype?: { name: string };
  labels?: string[];
  components?: { id?: string; name?: string }[];
  fixVersions?: { id?: string; name?: string }[];
  versions?: { id?: string; name?: string }[];
  duedate?: string | null;
  resolution?: { name: string } | null;
  parent?: { key: string } | null;
  story_points?: number | null;
  // customfield_NNNNN writes pass through verbatim.
  [customField: string]: unknown;
}

export function updateIssueFields(key: string, fields: IssueFieldUpdate): Promise<void> {
  return request(`/issue/${key}`, { method: 'PUT', body: JSON.stringify({ fields }) });
}

// --- Sprint 014: custom fields ---

export interface CfAllowedValue {
  id: string;
  value: string;
  children?: { id: string; value: string }[];
}

export interface FieldMeta {
  required: boolean;
  name: string;
  fieldId: string;
  key?: string;
  schema: { type: string; items?: string; custom?: string; customId?: number };
  operations: string[];
  allowedValues?: CfAllowedValue[];
  autoCompleteUrl?: string;
}

export function fetchEditMeta(key: string): Promise<{ fields: Record<string, FieldMeta> }> {
  return request(`/issue/${key}/editmeta`);
}

export function fetchCreateMetaValues(projectKey: string, issueTypeId: string): Promise<{ values: FieldMeta[] }> {
  return request(`/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}`);
}

export interface CustomFieldAdmin {
  id: string;
  name: string;
  description: string | null;
  type: string;
  searcherType: string;
  schema: { type: string; items?: string; custom?: string; customId?: number };
  active: boolean;
  systemManaged: boolean;
  alias: string | null;
  contexts: {
    id: string;
    isGlobal: boolean;
    projects: { projectId: string }[];
    options: {
      id: string;
      value: string;
      disabled: boolean;
      position: number;
      children: { id: string; value: string; disabled: boolean }[];
    }[];
  }[];
}

export function listCustomFields(includeInactive = true): Promise<{ fields: CustomFieldAdmin[]; types: string[] }> {
  return request(`/customfields?includeInactive=${includeInactive}`, INTERNAL_BASE);
}

export function createCustomField(data: {
  name: string;
  type: string;
  description?: string;
  context?: { projectKeys?: string[]; options?: (string | { value: string; children?: string[] })[] };
}): Promise<CustomFieldAdmin> {
  return request('/customfields', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function updateCustomField(
  id: string,
  data: { name?: string; description?: string | null; active?: boolean }
): Promise<CustomFieldAdmin> {
  return request(`/customfields/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteCustomField(id: string, dryRun = false): Promise<{ affectedIssues?: number } | void> {
  return request(`/customfields/${id}${dryRun ? '?dryRun=true' : ''}`, INTERNAL_BASE, { method: 'DELETE' });
}

export function updateCfContext(
  fieldId: string,
  ctxId: string,
  data: { options: { id?: string; value: string; disabled?: boolean; children?: string[] }[] }
): Promise<CustomFieldAdmin> {
  return request(`/customfields/${fieldId}/contexts/${ctxId}`, INTERNAL_BASE, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function addCfContext(
  fieldId: string,
  data: { isGlobal?: boolean; projectKeys?: string[]; options?: (string | { value: string; children?: string[] })[] }
): Promise<CustomFieldAdmin> {
  return request(`/customfields/${fieldId}/contexts`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteCfContext(fieldId: string, ctxId: string): Promise<CustomFieldAdmin> {
  return request(`/customfields/${fieldId}/contexts/${ctxId}`, INTERNAL_BASE, { method: 'DELETE' });
}

export function fetchComments(
  key: string,
  opts: { startAt?: number; maxResults?: number; orderBy?: 'created' | '-created' } = {}
): Promise<CommentPage> {
  const q = new URLSearchParams();
  if (opts.startAt) q.set('startAt', String(opts.startAt));
  if (opts.maxResults) q.set('maxResults', String(opts.maxResults));
  if (opts.orderBy) q.set('orderBy', opts.orderBy);
  return request(`/issue/${key}/comment${q.size ? `?${q}` : ''}`);
}

export function addComment(key: string, body: string): Promise<Comment> {
  return request(`/issue/${key}/comment`, { method: 'POST', body: JSON.stringify({ body }) });
}

export function editComment(key: string, commentId: string, body: string): Promise<Comment> {
  return request(`/issue/${key}/comment/${commentId}`, { method: 'PUT', body: JSON.stringify({ body }) });
}

export function deleteComment(key: string, commentId: string): Promise<void> {
  return request(`/issue/${key}/comment/${commentId}`, { method: 'DELETE' });
}

// --- Sprint 024: worklogs & time tracking ---

export interface Worklog {
  id: string;
  self?: string;
  issueId?: string;
  author: UserRef;
  updateAuthor?: UserRef;
  comment?: string | null;
  started: string;
  timeSpent: string;
  timeSpentSeconds: number;
  billable?: boolean;
  created: string;
  updated: string;
}

export interface WorklogPage {
  startAt: number;
  maxResults: number;
  total: number;
  worklogs: Worklog[];
}

export interface TimeTrackingConfig {
  hoursPerDay: number;
  daysPerWeek: number;
  format: 'pretty' | 'hours';
  defaultUnit: 'm' | 'h' | 'd' | 'w';
}

export function fetchWorklogs(key: string): Promise<WorklogPage> {
  return request(`/issue/${key}/worklog?maxResults=5000`);
}

export interface LogWorkInput {
  timeSpent: string;
  comment?: string;
  started?: string;
  billable?: boolean;
  adjustEstimate?: 'auto' | 'leave' | 'new' | 'manual';
  newEstimate?: string;
  reduceBy?: string;
}

export function logWork(key: string, input: LogWorkInput): Promise<Worklog> {
  const q = new URLSearchParams();
  if (input.adjustEstimate) q.set('adjustEstimate', input.adjustEstimate);
  if (input.newEstimate) q.set('newEstimate', input.newEstimate);
  if (input.reduceBy) q.set('reduceBy', input.reduceBy);
  const { adjustEstimate: _a, newEstimate: _n, reduceBy: _r, ...body } = input;
  return request(`/issue/${key}/worklog${q.size ? `?${q}` : ''}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function editWorklog(
  key: string,
  worklogId: string,
  input: { timeSpent?: string; comment?: string; started?: string; billable?: boolean; adjustEstimate?: string }
): Promise<Worklog> {
  const { adjustEstimate, ...body } = input;
  return request(`/issue/${key}/worklog/${worklogId}${adjustEstimate ? `?adjustEstimate=${adjustEstimate}` : ''}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function deleteWorklog(key: string, worklogId: string, adjustEstimate?: string): Promise<void> {
  return request(`/issue/${key}/worklog/${worklogId}${adjustEstimate ? `?adjustEstimate=${adjustEstimate}` : ''}`, {
    method: 'DELETE',
  });
}

export function fetchTimeTrackingConfig(): Promise<TimeTrackingConfig> {
  return request('/system/timetracking', INTERNAL_BASE);
}

export function fetchResolutions(): Promise<Resolution[]> {
  return request('/resolution');
}

export function fetchLabels(): Promise<string[]> {
  return request<{ values: string[] }>('/label?maxResults=1000').then((r) => r.values);
}

export function fetchChildren(key: string): Promise<Issue[]> {
  return request<{ issues: Issue[] }>(`/issue/${key}/children`).then((r) => r.issues);
}

export function fetchLinkTypes(): Promise<IssueLinkType[]> {
  return request<{ issueLinkTypes: IssueLinkType[] }>('/issueLinkType').then((r) => r.issueLinkTypes);
}

export function linkIssues(typeName: string, outwardKey: string, inwardKey: string): Promise<{ id: string }> {
  return request('/issueLink', {
    method: 'POST',
    body: JSON.stringify({
      type: { name: typeName },
      outwardIssue: { key: outwardKey },
      inwardIssue: { key: inwardKey },
    }),
  });
}

export function linkIssuesById(typeId: string, outwardKey: string, inwardKey: string): Promise<{ id: string }> {
  return request('/issueLink', {
    method: 'POST',
    body: JSON.stringify({
      type: { id: typeId },
      outwardIssue: { key: outwardKey },
      inwardIssue: { key: inwardKey },
    }),
  });
}

export function unlinkIssue(linkId: string): Promise<void> {
  return request(`/issueLink/${linkId}`, { method: 'DELETE' });
}

// ---- Sprint 018: attachments ----

export function fetchAttachmentMeta(): Promise<{ enabled: boolean; uploadLimit: number }> {
  return request('/attachment/meta');
}

/** Multipart upload — bypasses request() (which forces a JSON content-type). */
export async function uploadAttachments(issueKey: string, files: File[]): Promise<Attachment[]> {
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  const res = await fetch(`${API_BASE}/issue/${issueKey}/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Atlassian-Token': 'no-check' },
    body: fd,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.errorMessages ?? [], body.errors ?? {});
  }
  return body as Attachment[];
}

export function deleteAttachment(id: string): Promise<void> {
  return request(`/attachment/${id}`, { method: 'DELETE' });
}

export interface DeletePreview {
  key: string;
  deletesSubtasks: string[];
  clearsParentOn: string[];
  confirmToken: string;
}

export function previewDeleteIssue(key: string, deleteSubtasks: boolean): Promise<DeletePreview> {
  return request(`/issue/${key}?deleteSubtasks=${deleteSubtasks}&dryRun=true`, { method: 'DELETE' });
}

export function deleteIssue(key: string, deleteSubtasks: boolean, confirmToken: string): Promise<void> {
  return request(`/issue/${key}?deleteSubtasks=${deleteSubtasks}&confirmToken=${encodeURIComponent(confirmToken)}`, {
    method: 'DELETE',
  });
}

export function updateProject(
  key: string,
  data: {
    name?: string;
    description?: string | null;
    avatarColor?: string | null;
    agentGuidance?: string | null;
    lead?: { accountId: string } | null;
    categoryId?: string | null;
  }
): Promise<Project> {
  return request(`/project/${key}`, { method: 'PUT', body: JSON.stringify(data) });
}

export interface ProjectDeletePreview {
  key: string;
  deletesIssues: number;
  warning: string;
  confirmToken: string;
}

// 065 audit G8 — project delete is two-step like issue delete.
export function previewDeleteProject(key: string): Promise<ProjectDeletePreview> {
  return request(`/project/${key}?dryRun=true`, { method: 'DELETE' });
}

export function deleteProject(key: string, confirmToken: string): Promise<void> {
  return request(`/project/${key}?confirmToken=${encodeURIComponent(confirmToken)}`, { method: 'DELETE' });
}

// --- Sprint 009: workflows ---

export interface WorkflowRule {
  id?: string;
  kind: 'condition' | 'validator' | 'postFunction';
  type: string;
  config?: Record<string, unknown>;
}

export interface WorkflowTransitionDef {
  id: string;
  name: string;
  from: { id: string; name: string } | null;
  to: { id: string; name: string };
  screenFields: string[];
  rules: WorkflowRule[];
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  statuses: { id: string; name: string; isInitial: boolean; statusCategory: StatusCategory }[];
  transitions: WorkflowTransitionDef[];
}

export function fetchWorkflows(): Promise<Workflow[]> {
  return request<Workflow[]>('/workflows', INTERNAL_BASE);
}

export function fetchWorkflow(idOrName: string): Promise<Workflow> {
  return request<Workflow>(`/workflows/${encodeURIComponent(idOrName)}`, INTERNAL_BASE);
}

export function updateWorkflow(
  id: string,
  data: {
    statuses: { statusId: string; isInitial?: boolean; position?: number }[];
    transitions: {
      name: string;
      fromStatusId?: string | null;
      toStatusId: string;
      screenFields?: string[];
      rules?: { kind: WorkflowRule['kind']; type: string; config?: Record<string, unknown> }[];
    }[];
  }
): Promise<Workflow> {
  return request(`/workflows/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}

export function createWorkflow(data: {
  name: string;
  statuses: { statusId: string; isInitial?: boolean }[];
  transitions: { name: string; fromStatusId?: string | null; toStatusId: string }[];
}): Promise<Workflow> {
  return request('/workflows', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}

export function assignProjectWorkflow(
  projectKey: string,
  workflowId: string,
  mapping?: Record<string, string>
): Promise<{ workflow: { id: string; name: string }; remappedIssues: number }> {
  return request(`/projects/${projectKey}/workflow`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ workflowId, mapping: mapping ?? {} }),
  });
}

/** Replaces Jira `[~accountId:<id>]` mention markers with readable names. */
export function renderMentions(body: string, users: Map<string, string>): string {
  return body.replace(/\[~accountId:([^\]]+)\]/g, (_m, id) => `@${users.get(id) ?? 'inactive user'}`);
}

// ---------- Sprint 010: JQL + saved filters + preferences ----------

export interface JqlParseResult {
  query: string;
  structure?: { where: unknown; orderBy: { field: string; direction: string }[] };
  errors: string[];
}

export async function parseJqlQueries(queries: string[]): Promise<JqlParseResult[]> {
  const res = await request<{ queries: JqlParseResult[] }>('/jql/parse', {
    method: 'POST',
    body: JSON.stringify({ queries }),
  });
  return res.queries;
}

export interface JqlSuggestion {
  value: string;
  displayName: string;
}

export interface JqlAutocompleteData {
  visibleFieldNames: {
    value: string;
    displayName: string;
    orderable: boolean;
    searchable: boolean;
    operators: string[];
    types: string[];
  }[];
  visibleFunctionNames: { value: string; displayName: string; types: string[]; isList: string }[];
  jqlReservedWords: string[];
}

export function fetchJqlAutocompleteData(): Promise<JqlAutocompleteData> {
  return request('/jql/autocompletedata');
}

export function fetchJqlSuggestions(fieldName: string, fieldValue: string): Promise<{ results: JqlSuggestion[] }> {
  const params = new URLSearchParams({ fieldName, fieldValue });
  return request(`/jql/autocompletedata/suggestions?${params}`);
}

export interface FilterSharePermission {
  id: string;
  type: 'global' | 'authenticated' | 'group' | 'project' | 'projectRole' | 'user' | string;
  groupname?: string;
  projectId?: string;
  projectKey?: string;
  projectName?: string;
  roleId?: string;
  roleName?: string;
  userKey?: string;
  userDisplayName?: string;
}

export interface SavedFilter {
  id: string;
  name: string;
  description?: string;
  jql: string;
  owner: { accountId: string; displayName: string; emailAddress?: string };
  favourite: boolean;
  visibility: 'private' | 'all';
  sharePermissions?: FilterSharePermission[];
  viewUrl: string;
}

export function fetchMyFilters(): Promise<SavedFilter[]> {
  return request('/filter/my');
}

export function fetchFavouriteFilters(): Promise<SavedFilter[]> {
  return request('/filter/favourite');
}

export function fetchVisibleFilters(filterName = ''): Promise<SavedFilter[]> {
  const params = new URLSearchParams();
  if (filterName) params.set('filterName', filterName);
  return request(`/filter/search${params.size ? `?${params}` : ''}`);
}

export function fetchFilter(id: string): Promise<SavedFilter> {
  return request(`/filter/${id}`);
}

export function createFilter(input: {
  name: string;
  jql: string;
  description?: string;
  visibility?: 'private' | 'all';
}): Promise<SavedFilter> {
  return request('/filter', { method: 'POST', body: JSON.stringify(input) });
}

export function updateFilter(
  id: string,
  input: Partial<{
    name: string;
    jql: string;
    description: string;
    visibility: 'private' | 'all';
    ownerAccountId: string;
  }>
): Promise<SavedFilter> {
  return request(`/filter/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}

export function deleteFilter(id: string): Promise<void> {
  return request(`/filter/${id}`, { method: 'DELETE' });
}

export function setFilterFavourite(id: string, favourite: boolean): Promise<SavedFilter> {
  return request(`/filter/${id}/favourite`, { method: favourite ? 'PUT' : 'DELETE' });
}

// Sprint 032 — Jira /filter/{id}/permission share-permission rows
export interface SharePermissionInput {
  type: 'global' | 'authenticated' | 'group' | 'project' | 'projectRole' | 'user';
  groupname?: string;
  projectKey?: string;
  projectId?: string;
  roleName?: string;
  roleId?: string;
  userKey?: string;
  accountId?: string;
}

export function listFilterPermissions(id: string): Promise<FilterSharePermission[]> {
  return request(`/filter/${id}/permission`);
}

export function addFilterPermission(id: string, perm: SharePermissionInput): Promise<FilterSharePermission> {
  return request(`/filter/${id}/permission`, { method: 'POST', body: JSON.stringify(perm) });
}

export function deleteFilterPermission(id: string, permId: string): Promise<void> {
  return request(`/filter/${id}/permission/${permId}`, { method: 'DELETE' });
}

export type Preferences = Record<string, unknown>;

export function fetchPreferences(): Promise<Preferences> {
  return request('/preferences', INTERNAL_BASE);
}

export function putPreference(key: string, value: unknown): Promise<void> {
  return request(`/preferences/${encodeURIComponent(key)}`, INTERNAL_BASE, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

// 066 — notification prefs (autowatch toggles, digest cadence) via
// /api/internal/me/preferences. autowatch gates creator/commenter/assignee
// auto-follow server-side; 'digest' is honored by the mail digest job.
export interface NotifyPrefs {
  events?: Record<string, Record<string, boolean>>;
  autowatch?: { create?: boolean; comment?: boolean; assign?: boolean };
  digest?: 'immediate' | 'daily';
}

export function fetchNotifyPrefs(): Promise<NotifyPrefs> {
  return request('/me/preferences', INTERNAL_BASE);
}

export function updateNotifyPrefs(prefs: NotifyPrefs): Promise<NotifyPrefs> {
  return request('/me/preferences', INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(prefs) });
}

// ---------- events / SSE / watchers / notifications / your-work (011) ----------

export interface TfEvent {
  id: number;
  type: string;
  occurredAt: string;
  actor: { accountId: string; displayName: string; agent?: boolean } | null;
  channel: string;
  issueKey: string | null;
  projectKey: string | null;
  changelog: { items: ChangeItem[] } | null;
  comment: { body?: string } | null;
  self: string;
}

export interface WatcherState {
  isWatching: boolean;
  watchCount: number;
  watchers: UserRef[];
}

export function fetchWatchers(key: string): Promise<WatcherState> {
  return request(`/issue/${key}/watchers`, API_BASE);
}

export function addWatcher(key: string): Promise<void> {
  return request(`/issue/${key}/watchers`, API_BASE, { method: 'POST' });
}

export function removeWatcher(key: string): Promise<void> {
  return request(`/issue/${key}/watchers`, API_BASE, { method: 'DELETE' });
}

export interface TfNotification {
  id: string;
  reason: 'assigned' | 'mentioned' | 'watching' | string;
  read: boolean;
  created: string;
  issueKey: string | null;
  proposalId: string | null;
  summary: string | null;
  event: { id: number; type: string; occurredAt: string; channel: string; actor: { displayName: string } | null };
  comment: string | null;
}

export interface NotificationPage {
  total: number;
  unreadCount: number;
  notifications: TfNotification[];
}

export function fetchNotifications(unreadOnly = false): Promise<NotificationPage> {
  return request(`/me/notifications${unreadOnly ? '?unreadOnly=true' : ''}`, INTERNAL_BASE);
}

export function markNotificationsRead(ids?: string[], all = false): Promise<{ marked: number }> {
  return request(`/me/notifications/read`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify(all ? { all: true } : { ids }),
  });
}

export interface MyWork {
  worked: Issue[];
  assigned: Issue[];
  watching: Issue[];
  reported: Issue[];
  recent: { viewedAt: string; key: string; issue?: Issue }[];
}

export function fetchMyWork(): Promise<MyWork> {
  return request(`/me/work`, INTERNAL_BASE);
}

/** The caller's own timesheet for a period ("Time logged" card). */
export interface MyTimesheet {
  from: string;
  to: string;
  /** Seconds the instance counts as one workday (hoursPerDay × 3600). */
  workdaySec: number;
  totalSec: number;
  /** Expected seconds for the whole period and for elapsed weekdays so far —
   *  derived from the instance daysPerWeek config. */
  expectedSec: number;
  expectedToDateSec: number;
  /** 'YYYY-MM-DD' → logged seconds; only days with entries are present. */
  days: Record<string, number>;
  issues: { key: string; summary: string; statusCategoryKey: string | null; totalSec: number }[];
}

export function fetchMyTimesheet(from?: string, to?: string): Promise<MyTimesheet> {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return request(`/me/timesheet${q.size ? `?${q}` : ''}`, INTERNAL_BASE);
}

export function recordRecentView(issueKey: string): Promise<void> {
  return request(`/me/recent-views`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ issueKey }),
  });
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  filters: Record<string, unknown>;
  enabled: boolean;
  failureCount: number;
  excludeActorIds: string[];
  created: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: number;
  attempt: number;
  status: string;
  responseCode: number | null;
  latencyMs: number | null;
  responseSnippet: string | null;
  error: string | null;
  nextAttemptAt: string | null;
  created: string;
}

export function fetchWebhooks(): Promise<{ webhookCallbackResponse: Webhook[] }> {
  return request(`/webhook`, '/rest/webhooks/1.0');
}

export function createWebhook(data: {
  name: string;
  url: string;
  events: string[];
  filters?: Record<string, unknown>;
  enabled?: boolean;
  secret?: string;
  excludeActorIds?: string[];
}): Promise<Webhook> {
  return request(`/webhook`, '/rest/webhooks/1.0', { method: 'POST', body: JSON.stringify(data) });
}

export function updateWebhook(id: string, data: Partial<Parameters<typeof createWebhook>[0]>): Promise<Webhook> {
  return request(`/webhook/${id}`, '/rest/webhooks/1.0', { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteWebhook(id: string): Promise<void> {
  return request(`/webhook/${id}`, '/rest/webhooks/1.0', { method: 'DELETE' });
}

export function fetchWebhookDeliveries(id: string): Promise<{ deliveries: WebhookDelivery[] }> {
  return request(`/webhooks/${id}/deliveries`, INTERNAL_BASE);
}

export function redeliverWebhook(id: string, deliveryId: string): Promise<void> {
  return request(`/webhooks/${id}/deliveries/${deliveryId}/redeliver`, INTERNAL_BASE, { method: 'POST' });
}

// ---------- Sprint 012: AI copilot & approvals ----------

export interface AiSettings {
  configured: boolean;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  speechModel: string;
  hasApiKey: boolean;
  dailyLimit: number;
  monthlyBudget: number;
  promptLogging: boolean;
  globalGuidance?: string | null; // 047
}

export function fetchAiSettings(): Promise<AiSettings> {
  return request(`/ai/settings`, INTERNAL_BASE);
}

export function updateAiSettings(data: {
  provider?: 'openai' | 'anthropic';
  baseUrl?: string;
  chatModel?: string;
  embedModel?: string;
  speechModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  dailyLimit?: number;
  monthlyBudget?: number;
  promptLogging?: boolean;
  globalGuidance?: string | null;
}): Promise<{ configured: boolean; hasApiKey: boolean }> {
  return request(`/ai/settings`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}

export function testAiConnection(data: {
  provider?: string;
  baseUrl?: string;
  chatModel?: string;
  apiKey?: string;
}): Promise<{ ok: boolean; detail: string }> {
  return request(`/ai/settings/test`, INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}

export interface AiUsage {
  /** costUsd: provider-reported USD spend (OpenRouter usage.cost); 0 when unreported. */
  month: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
  /** 047 US5-4 — outcome totals per feature this month (accepted/edited/discarded/clarified/failed). */
  outcomes?: Record<string, Record<string, number>>;
  today: { user: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number }[];
}

export function fetchAiUsage(): Promise<AiUsage> {
  return request(`/ai/usage`, INTERNAL_BASE);
}

/** Feature discovery for UI affordances — works for any user, admin or not. */
export interface AiCapabilities {
  configured: boolean;
  embeddings: boolean;
  speech: boolean;
}

export function fetchAiCapabilities(): Promise<AiCapabilities> {
  return request(`/ai/capabilities`, INTERNAL_BASE);
}

export interface TranscriptionResult {
  text: string;
  /** Seconds of audio the provider reports (verbose_json duration); 0 if unreported. */
  audioSeconds?: number;
  /** Provider-reported USD cost (OpenRouter usage.cost); 0 if unreported. */
  costUsd?: number;
}

/** Speech → text. Multipart (not JSON) so it bypasses request(), like uploads. */
export async function transcribeAudio(audio: Blob): Promise<TranscriptionResult> {
  const fd = new FormData();
  fd.append('file', audio, audio.type.includes('ogg') ? 'speech.ogg' : 'speech.webm');
  const res = await fetch(`${INTERNAL_BASE}/ai/transcribe`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.errorMessages ?? [], body.errors ?? {});
  }
  return body as TranscriptionResult;
}

/** 052 — human rendering of a step; the only thing shown by default. */
export interface StepDisplay {
  text: string;
  fields?: { label: string; from?: string | null; to?: string | null }[];
  issues?: {
    key: string;
    summary?: string;
    status?: string;
    meta?: string;
    /** 068 — non-issue rows render as text, never a /browse link. */ noLink?: boolean;
  }[];
  markdown?: string;
}

export interface CopilotStep {
  tool: string;
  args: Record<string, unknown>;
  title: string;
  kind: 'read' | 'write';
  destructive?: boolean;
  preview?: unknown;
  result?: unknown;
  error?: string;
  previewable: boolean;
  display?: StepDisplay;
}

export interface CopilotPlan {
  planId?: string;
  steps?: CopilotStep[];
  /** 068 — grounded markdown reply for data questions. */
  answer?: string;
  /** 068 — thread + turn the response belongs to. */
  threadId?: string;
  turnId?: string;
  clarify?: { question: string; options?: string[] };
  warnings?: string[];
  /** 068 — short follow-up prompts rendered as clickable chips. */
  suggestions?: string[];
}

export function planCopilot(
  instruction: string,
  context?: {
    issueKey?: string;
    projectKey?: string;
    route?: string;
  },
  threadId?: string
): Promise<CopilotPlan> {
  return request(`/ai/plan`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ instruction, context, threadId }),
  });
}

export interface CopilotResult {
  index: number;
  tool: string;
  ok: boolean;
  status: number;
  result?: unknown;
  error?: string;
  /** 052 — read steps and post-failure writes are reported as skipped, not failed. */
  skipped?: boolean;
  display?: StepDisplay;
}

export function executeCopilot(
  planId: string,
  steps: CopilotStep[],
  turnId?: string
): Promise<{ results: CopilotResult[] }> {
  return request(`/ai/execute`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ planId, steps, turnId }),
  });
}

// ---------- 068: copilot workbench threads ----------

export interface CopilotThreadSummary {
  id: string;
  title: string | null;
  turns: number;
  createdAt: string;
  updatedAt: string;
}

export interface CopilotTurn {
  id: string;
  index: number;
  instruction: string;
  answer?: string;
  entities?: {
    issueKeys?: string[];
    users?: { accountId: string; displayName?: string }[];
    createdKeys?: string[];
    plannedWrites?: { tool: string; title: string }[];
  };
  writesApplied?: { tool: string; target: string; status: string }[];
  outcome?: string;
  createdAt: string;
}

export function fetchCopilotThreads(): Promise<{ threads: CopilotThreadSummary[] }> {
  return request(`/ai/threads`, INTERNAL_BASE);
}

export function fetchCopilotThread(id: string): Promise<{
  thread: { id: string; title: string | null; createdAt: string; updatedAt: string; turns: CopilotTurn[] };
}> {
  return request(`/ai/threads/${id}`, INTERNAL_BASE);
}

export function deleteCopilotThread(id: string): Promise<void> {
  return request(`/ai/threads/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}

export function nlToJql(text: string): Promise<{ jql: string }> {
  return request(`/ai/jql`, INTERNAL_BASE, { method: 'POST', body: JSON.stringify({ text }) });
}

export function aiSummarize(issueKey: string): Promise<{ summary: string }> {
  return request(`/ai/issues/${issueKey}/summary`, INTERNAL_BASE, { method: 'POST' });
}

export function aiDraft(
  issueKey: string | undefined,
  data: {
    summary?: string;
    existing?: string;
    projectKey?: string;
  }
): Promise<{ draft: string }> {
  return request(`/ai/issues/${issueKey ? `${issueKey}/` : ''}draft`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function aiBreakdown(issueKey: string): Promise<{
  children: { summary: string; acceptanceCriteria: string; description?: string }[];
}> {
  return request(`/ai/issues/${issueKey}/breakdown`, INTERNAL_BASE, { method: 'POST' });
}

/** 047 US5-4 — fire-and-forget outcome recording; 052 adds clarified/failed; 067 adds resolution. */
export function postAiOutcome(
  feature: 'plan' | 'draft' | 'breakdown' | 'summary' | 'jql' | 'similar' | 'resolution',
  outcome: 'accepted' | 'edited' | 'discarded' | 'clarified' | 'failed'
): void {
  void request(`/ai/outcome`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ feature, outcome }),
  }).catch(() => undefined);
}

export interface SimilarIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  score: number;
}

export function fetchSimilarIssues(issueKey: string): Promise<{ issues: SimilarIssue[] }> {
  return request(`/ai/issues/${issueKey}/similar`, INTERNAL_BASE);
}

export function searchSimilarByText(text: string, projectKey?: string): Promise<{ issues: SimilarIssue[] }> {
  const q = new URLSearchParams({ text });
  if (projectKey) q.set('project', projectKey);
  return request(`/ai/similar?${q}`, INTERNAL_BASE);
}

/** 067 — grounded resolution suggestion; `resolution:null` when evidence is thin. */
export interface ResolutionInsight {
  resolution: { id: string; name: string } | null;
  confidence: 'high' | 'medium' | 'low' | null;
  diagnosis: string | null;
  basedOn: { key: string; summary: string; resolution: string | null; statusCategory?: string; score: number }[];
  reason: 'insufficient_evidence' | 'already_resolved' | null;
}

export function aiSuggestResolution(issueKey: string): Promise<ResolutionInsight> {
  return request(`/ai/issues/${issueKey}/suggest-resolution`, INTERNAL_BASE, { method: 'POST' });
}

export interface Proposal {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
  method: string;
  path: string;
  rationale: string | null;
  diff: unknown;
  body: unknown;
  editedBody: unknown;
  appliedWithEdits: boolean;
  timeToApproveSec: number | null;
  result: unknown;
  reason: string | null;
  channel: string;
  principal: { accountId: string; displayName: string; agent: boolean };
  token: { name: string; revoked: boolean } | null;
  project: { key: string; name: string } | null;
  issue: { key: string; summary: string; statusCategory?: string } | null;
  resolvedBy: { accountId: string; displayName: string } | null;
  resolvedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export function fetchProposals(opts?: {
  status?: string;
  project?: string;
  issue?: string;
}): Promise<{ proposals: Proposal[]; total: number }> {
  const q = new URLSearchParams();
  if (opts?.status) q.set('status', opts.status);
  if (opts?.project) q.set('project', opts.project);
  if (opts?.issue) q.set('issue', opts.issue);
  const qs = q.toString();
  return request(`/proposals${qs ? `?${qs}` : ''}`, INTERNAL_BASE);
}

export function fetchProposal(id: string): Promise<Proposal> {
  return request(`/proposals/${id}`, INTERNAL_BASE);
}

// 047 US4 — optional `edits` replaces the proposed request body; the backend
// re-validates it on replay (approve-with-edits, recorded appliedWithEdits).
export function approveProposal(
  id: string,
  edits?: Record<string, unknown>
): Promise<{ status: string; result?: unknown }> {
  return request(`/proposals/${id}/approve`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify(edits ? { body: edits } : {}),
  });
}

export function rejectProposal(id: string, reason?: string): Promise<{ status: string }> {
  return request(`/proposals/${id}/reject`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function bulkResolveProposals(
  ids: string[],
  action: 'approve' | 'reject',
  reason?: string
): Promise<{
  results: { id: string; status: string; error?: string }[];
}> {
  return request(`/proposals/bulk`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ ids, action, reason }),
  });
}

// --- Sprint 015: project roles (People tab) ---
export interface RoleActor {
  id: string;
  displayName: string;
  type: string; // atlassian-user-role-actor | atlassian-group-role-actor
  name: string;
  actorUser?: { accountId: string };
}
export interface ProjectRoleActors {
  id: string;
  name: string;
  description: string;
  actors: RoleActor[];
}
export interface RoleDef {
  id: string;
  name: string;
  description: string;
}

export function fetchRoleDefs(): Promise<RoleDef[]> {
  return request('/role');
}
export function fetchProjectRoles(projectKey: string): Promise<Record<string, string>> {
  return request(`/project/${projectKey}/role`);
}
export function fetchProjectRoleActors(projectKey: string, roleId: string): Promise<ProjectRoleActors> {
  return request(`/project/${projectKey}/role/${roleId}`);
}
export function addProjectRoleActors(
  projectKey: string,
  roleId: string,
  body: { user?: string[]; group?: string[] }
): Promise<ProjectRoleActors> {
  return request(`/project/${projectKey}/role/${roleId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
export function removeProjectRoleActor(
  projectKey: string,
  roleId: string,
  ref: { user?: string; group?: string }
): Promise<void> {
  const q = ref.user ? `user=${encodeURIComponent(ref.user)}` : `group=${encodeURIComponent(ref.group!)}`;
  return request(`/project/${projectKey}/role/${roleId}?${q}`, { method: 'DELETE' });
}
export function fetchMyPermissions(params: {
  projectKey?: string;
  issueKey?: string;
  permissions: string[];
}): Promise<{ permissions: Record<string, { havePermission: boolean }> }> {
  const q = new URLSearchParams();
  if (params.projectKey) q.set('projectKey', params.projectKey);
  if (params.issueKey) q.set('issueKey', params.issueKey);
  q.set('permissions', params.permissions.join(','));
  return request(`/mypermissions?${q}`);
}

// --- Sprint 017: Jira Cloud migration ---

export interface ImportJobView {
  id: string;
  source: string;
  baseUrl: string;
  projectKeys: string[];
  stage: string;
  dryRun: boolean;
  error: string | null;
  stageData: { progress?: Record<string, { total: number; done: number }>; deltaFrom?: string } | null;
  report: {
    plan?: Record<string, { creates: number; updates: number; skips: number; errors: number }>;
    unsupported?: string[];
    warnings?: { entityType: string; externalId: string; message: string }[];
    applyErrors?: { entity: string; externalId: string; message: string }[];
    verify?: { entity: string; expected: number; imported: number; diffs: string[] }[];
    reports?: {
      entity: string;
      creates: number;
      updates: number;
      skips: number;
      warnings: { externalId: string; message: string }[];
      errors: { externalId: string; message: string }[];
    }[];
  } | null;
  lastRunAt: string;
  createdAt: string;
}

export interface StartImportInput {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  secretRef?: string;
  projectKeys: string[];
  dryRun?: boolean;
  deltaFrom?: string;
}

export function listImports(): Promise<ImportJobView[]> {
  return request('/migration', INTERNAL_BASE);
}
export function getImport(id: string): Promise<ImportJobView> {
  return request(`/migration/${id}`, INTERNAL_BASE);
}
export function startJiraImport(input: StartImportInput): Promise<ImportJobView> {
  return request('/migration/jira-cloud', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function resumeImport(id: string): Promise<ImportJobView> {
  return request(`/migration/${id}/resume`, INTERNAL_BASE, { method: 'POST', body: '{}' });
}

// 061 US6 — the 048/039 import sources that never got a UI.
export interface ServerImportInput {
  baseUrl: string;
  authMode: 'basic' | 'pat';
  username?: string;
  apiToken?: string;
  secretRef?: string;
  projectKeys: string[];
  dryRun?: boolean;
  deltaFrom?: string;
  insecureSkipVerify?: boolean;
  allowPrivate?: boolean;
}
export function startJiraServerImport(input: ServerImportInput): Promise<ImportJobView> {
  return request('/migration/jira-server', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function startCsvImport(input: {
  csv: string;
  projectKey?: string;
  projectKeys?: string[];
  dryRun?: boolean;
}): Promise<ImportJobView> {
  return request('/migration/csv', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export interface CsvPreview {
  headers: string[];
  mapping: Record<string, string>;
  rows: Record<string, string>[];
}
export function previewCsv(input: { csv: string; maxRows?: number }): Promise<CsvPreview> {
  return request('/migration/csv/preview', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function startXmlImport(input: {
  zipBase64: string;
  projectKeys?: string[];
  dryRun?: boolean;
}): Promise<ImportJobView> {
  return request('/migration/jira-server-xml', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function exportProjectFixture(projectKey: string): Promise<{ projectKey: string; fixture: unknown }> {
  return request(`/migration/export/${encodeURIComponent(projectKey)}`, INTERNAL_BASE);
}

// --- Sprint 019: components, versions & release hub ---

export interface Component {
  id: string;
  name: string;
  description?: string;
  project: string;
  lead?: UserRef;
  assigneeType?: 'PROJECT_DEFAULT' | 'COMPONENT_LEAD' | 'PROJECT_LEAD' | 'UNASSIGNED';
  issueCount?: number;
}

export interface Version {
  id: string;
  name: string;
  description?: string;
  project: string;
  released: boolean;
  archived: boolean;
  startDate?: string;
  releaseDate?: string;
  issuesFixedCount?: number;
}

export interface VersionIssueCounts {
  issuesFixedCount: number;
  issuesDoneCount: number;
  issuesUnresolvedCount: number;
  issuesAffectedCount: number;
}

export interface ReleaseNotes {
  version: { id: string; name: string; released: boolean; releaseDate?: string };
  project: string;
  groups: { issueType: { name: string }; issues: { key: string; summary: string }[] }[];
}

export function fetchComponents(projectKey: string): Promise<Component[]> {
  return request(`/project/${projectKey}/components`);
}
export function createComponent(input: {
  project: string;
  name: string;
  description?: string;
  leadAccountId?: string;
  assigneeType?: string;
}): Promise<Component> {
  return request('/component', API_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function updateComponent(
  id: string,
  input: Partial<{ name: string; description: string; leadAccountId: string; assigneeType: string }>
): Promise<Component> {
  return request(`/component/${id}`, API_BASE, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteComponent(id: string, moveIssuesTo?: string): Promise<void> {
  return request(`/component/${id}${moveIssuesTo ? `?moveIssuesTo=${moveIssuesTo}` : ''}`, API_BASE, {
    method: 'DELETE',
  });
}

export function fetchVersions(projectKey: string): Promise<Version[]> {
  return request(`/project/${projectKey}/versions`);
}
export function createVersion(input: {
  project: string;
  name: string;
  description?: string;
  released?: boolean;
  archived?: boolean;
  startDate?: string;
  releaseDate?: string;
}): Promise<Version> {
  return request('/version', API_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function updateVersion(
  id: string,
  input: Partial<{
    name: string;
    description: string;
    released: boolean;
    archived: boolean;
    startDate: string;
    releaseDate: string;
  }>
): Promise<Version> {
  return request(`/version/${id}`, API_BASE, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteVersion(
  id: string,
  swaps?: { moveFixIssuesTo?: string; moveAffectedIssuesTo?: string }
): Promise<void> {
  const q =
    swaps && (swaps.moveFixIssuesTo || swaps.moveAffectedIssuesTo)
      ? `?${new URLSearchParams(Object.entries(swaps).filter((e): e is [string, string] => Boolean(e[1]))).toString()}`
      : '';
  return request(`/version/${id}${q}`, API_BASE, { method: 'DELETE' });
}
export function moveVersion(id: string, input: { position?: string; after?: string }): Promise<Version> {
  return request(`/version/${id}/move`, API_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function releaseVersion(id: string, releaseDate?: string): Promise<Version> {
  return request(`/version/${id}/release`, API_BASE, {
    method: 'POST',
    body: JSON.stringify(releaseDate ? { releaseDate } : {}),
  });
}
export function fetchVersionIssueCounts(id: string): Promise<VersionIssueCounts> {
  return request(`/version/${id}/relatedIssueCounts`);
}
export function fetchReleaseNotes(id: string): Promise<ReleaseNotes> {
  return request(`/version/${id}/releasenotes`);
}

// ---------- Sprint 022: votes, remote links, clone, move ----------

export function voteIssue(key: string): Promise<void> {
  return request(`/issue/${key}/votes`, API_BASE, { method: 'POST' });
}
export function unvoteIssue(key: string): Promise<void> {
  return request(`/issue/${key}/votes`, API_BASE, { method: 'DELETE' });
}
export interface RemoteLink {
  id: string;
  self: string;
  globalId?: string;
  object: { url: string; title: string; summary?: string };
}
export function fetchRemoteLinks(key: string): Promise<RemoteLink[]> {
  return request(`/issue/${key}/remotelink`, API_BASE);
}
export function createRemoteLink(
  key: string,
  input: { url: string; title: string; summary?: string }
): Promise<RemoteLink> {
  return request(`/issue/${key}/remotelink`, API_BASE, {
    method: 'POST',
    body: JSON.stringify({ object: input }),
  });
}
export function deleteRemoteLink(key: string, linkId: string): Promise<void> {
  return request(`/issue/${key}/remotelink/${linkId}`, API_BASE, { method: 'DELETE' });
}
export function cloneIssue(
  key: string,
  opts: {
    summary?: string;
    includeLinks?: boolean;
    includeSubtasks?: boolean;
    includeAttachments?: boolean;
    includeWatchers?: boolean;
    includeVotes?: boolean;
    dryRun?: boolean;
  }
): Promise<{ dryRun: boolean; key: string; issue?: Issue }> {
  return request(`/issues/${key}/clone`, '/api/internal', {
    method: 'POST',
    body: JSON.stringify({ summary: opts.summary, dryRun: opts.dryRun, options: opts }),
  });
}
export function moveIssue(
  key: string,
  input: {
    projectKey: string;
    issueTypeName?: string;
    statusName?: string;
    dryRun?: boolean;
  }
): Promise<{
  dryRun: boolean;
  oldKey: string;
  key: string;
  newKey?: string;
  dropped?: { components: string[]; versions: string[] };
}> {
  return request(`/issues/${key}/move`, '/api/internal', {
    method: 'POST',
    body: JSON.stringify({
      target: { projectKey: input.projectKey, issueTypeName: input.issueTypeName, statusName: input.statusName },
      dryRun: input.dryRun,
    }),
  });
}

// ---------- Sprint 023: bulk ops + export ----------

export interface BulkPlanItem {
  key: string;
  ok: boolean;
  changes?: string[];
  error?: string;
}
export interface BulkJob {
  id: string;
  op: string;
  status: 'planned' | 'queued' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  results: BulkPlanItem[];
  finishedAt?: string | null;
}
export type BulkOpName = 'edit' | 'transition' | 'move' | 'delete' | 'comment' | 'watch' | 'link';

export function runBulkOp(
  op: BulkOpName,
  input: { issueKeys?: string[]; jql?: string; payload?: Record<string, unknown>; dryRun?: boolean }
): Promise<{ jobId: string; dryRun: boolean; total: number; plan: BulkPlanItem[] }> {
  return request(`/bulk/${op}`, '/api/internal', { method: 'POST', body: JSON.stringify(input) });
}
export function fetchBulkJob(jobId: string): Promise<BulkJob> {
  return request(`/bulk/job/${jobId}`, '/api/internal');
}
export function retryBulkJob(jobId: string): Promise<{ jobId: string }> {
  return request(`/bulk/job/${jobId}/retry`, '/api/internal', { method: 'POST', body: '{}' });
}

/** Export is a plain link — cookie auth means no fetch needed. */
export function exportIssuesUrl(opts: { jql?: string; format: 'csv' | 'print'; columns?: string[] }): string {
  const q = new URLSearchParams();
  if (opts.jql) q.set('jql', opts.jql);
  q.set('format', opts.format);
  if (opts.columns?.length) q.set('columns', opts.columns.join(','));
  return `/api/internal/export/issues?${q}`;
}
export function exportIssuePrintUrl(key: string): string {
  return `/api/internal/export/issue/${encodeURIComponent(key)}?format=print`;
}

// --- Sprint 026: dashboards & gadgets ---
export interface Dashboard {
  id: string;
  name: string;
  description?: string;
  owner: { name: string };
  layout: { columns: number };
  isSystemDefault?: boolean;
  gadgets?: DashboardGadget[];
  sharePermissions?: { type: string; target?: string | null; target2?: string | null }[];
  editPermissions?: { type: string; target?: string | null; target2?: string | null }[];
}
export interface DashboardGadget {
  id: string;
  type: string;
  title: string;
  position: { row: number; column: number };
  config: Record<string, unknown>;
}
export interface GadgetTypeDef {
  type: string;
  title: string;
  description: string;
  configFields: { key: string; label: string; type: string; required?: boolean; default?: unknown }[];
}
export interface DashboardData {
  dashboard: Dashboard;
  gadgets: { gadget: DashboardGadget; data?: any; error?: string }[];
}
export function fetchDashboards(): Promise<{ dashboards: Dashboard[] }> {
  return request('/dashboard', '/rest/api/2');
}
export function searchDashboards(q: { dashboardName?: string }): Promise<{ values: Dashboard[]; total: number }> {
  const p = new URLSearchParams();
  if (q.dashboardName) p.set('dashboardName', q.dashboardName);
  return request(`/dashboard/search?${p}`, '/rest/api/2');
}
export function fetchDashboard(id: string): Promise<Dashboard> {
  return request(`/dashboard/${encodeURIComponent(id)}`, '/rest/api/2');
}
export function createDashboard(input: {
  name: string;
  description?: string;
  sharePermissions?: object[];
}): Promise<Dashboard> {
  return request('/dashboard', '/rest/api/2', { method: 'POST', body: JSON.stringify(input) });
}
export function updateDashboard(
  id: string,
  input: Partial<{
    name: string;
    description: string | null;
    layout: { columns: number };
    sharePermissions: object[];
    editPermissions: object[];
  }>
): Promise<Dashboard> {
  return request(`/dashboard/${encodeURIComponent(id)}`, '/rest/api/2', { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteDashboard(id: string): Promise<void> {
  return request(`/dashboard/${encodeURIComponent(id)}`, '/rest/api/2', { method: 'DELETE' });
}
export function copyDashboard(id: string, name?: string): Promise<Dashboard> {
  return request(`/dashboard/${encodeURIComponent(id)}/copy`, '/rest/api/2', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}
export function fetchGadgetTypes(): Promise<{ gadgets: GadgetTypeDef[] }> {
  return request('/dashboard/gadgets', '/rest/api/2');
}
export function addGadget(
  dashId: string,
  input: { type: string; config?: Record<string, unknown>; column?: number; position?: number }
): Promise<DashboardGadget> {
  return request(`/dashboard/${encodeURIComponent(dashId)}/gadget`, '/rest/api/2', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
export function updateGadget(
  dashId: string,
  gadgetId: string,
  input: { config?: Record<string, unknown>; position?: number; column?: number }
): Promise<DashboardGadget> {
  return request(`/dashboard/${encodeURIComponent(dashId)}/gadget/${encodeURIComponent(gadgetId)}`, '/rest/api/2', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
export function deleteGadget(dashId: string, gadgetId: string): Promise<void> {
  return request(`/dashboard/${encodeURIComponent(dashId)}/gadget/${encodeURIComponent(gadgetId)}`, '/rest/api/2', {
    method: 'DELETE',
  });
}
export function fetchDashboardData(id: string): Promise<DashboardData> {
  return request(`/dashboards/${encodeURIComponent(id)}/data`, '/api/internal');
}

// --- Sprint 028: general/time/release reports ---
export function fetchReport<T>(path: string): Promise<T> {
  return request(`/reports${path}`, INTERNAL_BASE);
}

// --- Sprint 031: scheme layer bindings ---
export interface NamedScheme {
  id: string;
  name: string;
  description?: string | null;
}
export interface IssueSecurityScheme {
  id: string;
  name: string;
  levels?: { id: string; name: string }[];
}

export function fetchIssueSecuritySchemes(): Promise<{ issueSecuritySchemes: IssueSecurityScheme[] }> {
  return request('/issuesecurityschemes', '/rest/api/2');
}
// 060 US1 — full scheme payloads for the admin scheme hub (superset of NamedScheme).
export interface IssueTypeSchemeDetail extends NamedScheme {
  issueTypeIds: string[];
  issueTypes: { id: string; name: string; isSubtask: boolean }[];
  projectsUsed: number;
}
export interface WorkflowSchemeDetail extends NamedScheme {
  defaultWorkflow: { id: string; name: string };
  mappings: { issueType: { id: string; name: string }; workflowId: string }[];
  projectsUsed: number;
}

export function fetchIssueTypeSchemes(): Promise<IssueTypeSchemeDetail[]> {
  return request('/issuetypeschemes', INTERNAL_BASE);
}
export function createIssueTypeScheme(data: {
  name: string;
  description?: string;
  issueTypeIds?: string[];
}): Promise<{ id: string }> {
  return request('/issuetypeschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateIssueTypeScheme(
  id: string,
  data: { name?: string; description?: string; issueTypeIds?: string[] }
): Promise<{ id: string }> {
  return request(`/issuetypeschemes/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteIssueTypeScheme(id: string): Promise<void> {
  return request(`/issuetypeschemes/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
// 060 US2 — issue-type screen schemes (raw 031 payloads).
export interface AdminItss extends NamedScheme {
  defaultScheme?: { id: string; name: string } | null;
  mappings: {
    id: string;
    issueTypeId: string;
    screenSchemeId: string;
    screenScheme: { id: string; name: string };
    issueType: { id: string; name: string };
  }[];
  _count?: { projects: number };
}
export function fetchIssueTypeScreenSchemes(): Promise<AdminItss[]> {
  return request('/issuetypescreenschemes', INTERNAL_BASE);
}
export function createIssueTypeScreenScheme(data: {
  name: string;
  description?: string;
  defaultSchemeId?: string | null;
  mappings?: { issueTypeId: string; screenSchemeId: string }[];
}): Promise<{ id: string }> {
  return request('/issuetypescreenschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateIssueTypeScreenScheme(
  id: string,
  data: {
    name?: string;
    description?: string;
    defaultSchemeId?: string | null;
    mappings?: { issueTypeId: string; screenSchemeId: string }[];
  }
): Promise<unknown> {
  return request(`/issuetypescreenschemes/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteIssueTypeScreenScheme(id: string): Promise<void> {
  return request(`/issuetypescreenschemes/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
// 060 US3 — field configuration schemes (raw 031 payloads).
export interface AdminFcScheme extends NamedScheme {
  defaultConfig?: { id: string; name: string } | null;
  mappings: {
    id: string;
    issueTypeId: string;
    configId: string;
    config: { id: string; name: string };
    issueType: { id: string; name: string };
  }[];
  _count?: { projects: number };
}
export function fetchFieldConfigurationSchemes(): Promise<AdminFcScheme[]> {
  return request('/fieldconfigurationschemes', INTERNAL_BASE);
}
export function createFieldConfigurationScheme(data: {
  name: string;
  description?: string;
  defaultConfigId?: string | null;
  mappings?: { issueTypeId: string; configId: string }[];
}): Promise<{ id: string }> {
  return request('/fieldconfigurationschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateFieldConfigurationScheme(
  id: string,
  data: {
    name?: string;
    description?: string;
    defaultConfigId?: string | null;
    mappings?: { issueTypeId: string; configId: string }[];
  }
): Promise<unknown> {
  return request(`/fieldconfigurationschemes/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteFieldConfigurationScheme(id: string): Promise<void> {
  return request(`/fieldconfigurationschemes/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
export function fetchWorkflowSchemes(): Promise<WorkflowSchemeDetail[]> {
  return request('/workflowschemes', INTERNAL_BASE);
}
export function fetchWorkflowScheme(id: string): Promise<WorkflowSchemeDetail> {
  return request(`/workflowschemes/${id}`, INTERNAL_BASE);
}
export function createWorkflowScheme(data: {
  name: string;
  description?: string;
  defaultWorkflowId: string;
  mappings?: Record<string, string>;
}): Promise<{ id: string }> {
  return request('/workflowschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateWorkflowScheme(
  id: string,
  data: {
    name?: string;
    description?: string;
    defaultWorkflowId?: string;
    mappings?: Record<string, string>;
  }
): Promise<{ id: string }> {
  return request(`/workflowschemes/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteWorkflowScheme(id: string): Promise<void> {
  return request(`/workflowschemes/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
// 060 US1 — workflow definitions are deletable only while unbound.
export function deleteWorkflow(id: string): Promise<void> {
  return request(`/workflows/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}

// 060 US2 — screens stack admin (raw 031 service payloads).
export interface AdminScreenTabField {
  id: string;
  fieldId: string;
  position: number;
}
export interface AdminScreenTab {
  id: string;
  name: string;
  position: number;
  fields: AdminScreenTabField[];
}
export interface AdminScreen {
  id: string;
  name: string;
  description: string | null;
  tabs: AdminScreenTab[];
}
export type ScreenOp = 'default' | 'create' | 'edit' | 'view';
export interface AdminScreenScheme extends NamedScheme {
  items: { id: string; operation: ScreenOp; screenId: string; screen?: { id: string; name: string } }[];
}
export interface FieldDef {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string };
}

export function fetchAdminScreens(): Promise<AdminScreen[]> {
  return request('/screens', INTERNAL_BASE);
}
export function createScreen(data: {
  name: string;
  description?: string;
  tabs?: { name: string; fields?: string[] }[];
}): Promise<AdminScreen> {
  return request('/screens', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateScreen(id: string, data: { name?: string; description?: string }): Promise<AdminScreen> {
  return request(`/screens/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteScreen(id: string): Promise<void> {
  return request(`/screens/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
export function setScreenTabs(id: string, tabs: { name: string; fields?: string[] }[]): Promise<AdminScreen> {
  return request(`/screens/${id}/tabs`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify({ tabs }) });
}
export function fetchAdminScreenSchemes(): Promise<AdminScreenScheme[]> {
  return request('/screenschemes', INTERNAL_BASE);
}
export function createScreenScheme(data: {
  name: string;
  description?: string;
  items?: { operation: ScreenOp; screenId: string }[];
}): Promise<AdminScreenScheme> {
  return request('/screenschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateScreenScheme(
  id: string,
  data: { name?: string; description?: string; items?: { operation: ScreenOp; screenId: string }[] }
): Promise<AdminScreenScheme> {
  return request(`/screenschemes/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteScreenScheme(id: string): Promise<void> {
  return request(`/screenschemes/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
export function fetchFields(): Promise<FieldDef[]> {
  return request('/field');
}

// 060 US3 — field configurations (raw 031 service payloads).
export interface FcRule {
  when?: { field?: string; is?: unknown; in?: unknown[]; isNot?: unknown; empty?: boolean };
  required?: boolean;
  hidden?: boolean;
  defaultValue?: unknown;
}
export interface FieldConfigItem {
  id: string;
  fieldId: string;
  required: boolean;
  hidden: boolean;
  description: string | null;
  defaultValue: unknown;
  rules: FcRule[] | null;
}
export interface FieldConfiguration extends NamedScheme {
  items: FieldConfigItem[];
}
export interface FieldConfigItemInput {
  fieldId: string;
  required?: boolean;
  hidden?: boolean;
  description?: string;
  defaultValue?: unknown;
  rules?: FcRule[];
}
export function fetchFieldConfigurations(): Promise<FieldConfiguration[]> {
  return request('/fieldconfigurations', INTERNAL_BASE);
}
export function createFieldConfiguration(data: {
  name: string;
  description?: string;
  items?: FieldConfigItemInput[];
}): Promise<FieldConfiguration> {
  return request('/fieldconfigurations', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(data) });
}
export function updateFieldConfiguration(
  id: string,
  data: { name?: string; description?: string; items?: FieldConfigItemInput[] }
): Promise<FieldConfiguration> {
  return request(`/fieldconfigurations/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteFieldConfiguration(id: string): Promise<void> {
  return request(`/fieldconfigurations/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
// 021 US4 — permission scheme assignment goes through the Jira route (PUT body { id })
export function putProjectPermissionScheme(projectKey: string, schemeId: string | null): Promise<{ id: string }> {
  return request(`/project/${encodeURIComponent(projectKey)}/permissionscheme`, {
    method: 'PUT',
    body: JSON.stringify({ id: schemeId }),
  });
}
// 021 US4 — project categories
export interface ProjectCategory {
  id: string;
  name: string;
  description?: string;
}
export function fetchProjectCategories(): Promise<ProjectCategory[]> {
  return request('/projectcategories', INTERNAL_BASE);
}
export function updateProjectCategory(
  id: string,
  data: { name?: string; description?: string }
): Promise<ProjectCategory> {
  return request(`/projectcategories/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(data) });
}
export function deleteProjectCategory(id: string): Promise<void> {
  return request(`/projectcategories/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
// 060 US4 — admin project overview (all projects incl. archived + aggregates).
export interface AdminProjectOverview extends Project {
  issues: number;
  lastIssueUpdate: string | null;
}
export function fetchAdminProjects(): Promise<AdminProjectOverview[]> {
  return request('/admin/projects', INTERNAL_BASE);
}
export function archiveProject(key: string): Promise<Project> {
  return request(`/project/${encodeURIComponent(key)}/archive`, { method: 'POST' });
}
export function restoreProject(key: string): Promise<Project> {
  return request(`/project/${encodeURIComponent(key)}/restore`, { method: 'POST' });
}
// 060 US7 — Jira DC issue archiving.
export function archiveIssue(key: string): Promise<void> {
  return request(`/issue/${encodeURIComponent(key)}/archive`, { method: 'PUT' });
}
export function restoreIssue(key: string): Promise<void> {
  return request(`/issue/${encodeURIComponent(key)}/restore`, { method: 'PUT' });
}
export interface ArchivedIssueRow {
  id: string;
  issueNumber: number;
  summary: string;
  archivedAt: string | null;
  issueType: { name: string };
  status: { name: string };
  archivedBy: { displayName: string } | null;
  project: { key: string };
}
export function fetchArchivedIssues(projectKey: string): Promise<ArchivedIssueRow[]> {
  return request(`/projects/${encodeURIComponent(projectKey)}/issues/archived`, INTERNAL_BASE);
}
// 060 stretch — announcement banner.
export function fetchBanner(): Promise<{ message: string }> {
  return request('/system/banner', INTERNAL_BASE);
}
export function setBanner(message: string): Promise<{ message: string }> {
  return request('/system/banner', INTERNAL_BASE, { method: 'PUT', body: JSON.stringify({ message }) });
}
// 028 org metrics (admin-gated) — surfaced under /admin/organization
export interface OrgMetrics {
  totals: { issues: number; users: number; projects: number };
  issueGrowth30d: Record<string, number>;
  activityByType: { type: string; count: number }[];
}
export function fetchOrgMetrics(): Promise<OrgMetrics> {
  return request('/reports/org', INTERNAL_BASE);
}

// ---------- 049 admin UI: identity integrations (OAuth clients + directory) ----------
const ADMIN_BASE = '/api/internal/admin';

export interface OAuthClientAdmin {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  allowedScopes: string[];
  allowedProjectKeys: string[];
  serviceUserId?: string | null;
  metadataDocumentUrl?: string | null;
  confidential: boolean;
  registrationType: string;
  enabled: boolean;
  createdAt: string;
}
export interface OAuthClientInput {
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  allowedScopes: string[];
  allowedProjectKeys?: string[];
  confidential?: boolean;
  serviceUserId?: string | null;
  metadataDocumentUrl?: string | null;
  enabled?: boolean;
}
export const fetchOAuthClients = (): Promise<{ clients: OAuthClientAdmin[] }> =>
  request(`${ADMIN_BASE}/oauth/clients`, '');
export const createOAuthClient = (body: OAuthClientInput): Promise<OAuthClientAdmin & { clientSecret?: string }> =>
  request(`${ADMIN_BASE}/oauth/clients`, '', { method: 'POST', body: JSON.stringify(body) });
export const updateOAuthClient = (id: string, body: Partial<OAuthClientInput>): Promise<OAuthClientAdmin> =>
  request(`${ADMIN_BASE}/oauth/clients/${id}`, '', { method: 'PUT', body: JSON.stringify(body) });
export const deleteOAuthClient = (id: string): Promise<void> =>
  request(`${ADMIN_BASE}/oauth/clients/${id}`, '', { method: 'DELETE' });

export interface DirectoryConnection {
  id: string;
  type: 'scim' | 'ldap';
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastSyncAt?: string | null;
  syncStatus?: string | null;
  createdAt: string;
}
export interface DirectoryInput {
  type: 'scim' | 'ldap';
  name: string;
  config: Record<string, unknown>;
  secretRef?: string | null;
  enabled?: boolean;
}
export const fetchDirectoryConnections = (): Promise<{ connections: DirectoryConnection[] }> =>
  request(`${ADMIN_BASE}/directory`, '');
export const createDirectoryConnection = (body: DirectoryInput): Promise<DirectoryConnection> =>
  request(`${ADMIN_BASE}/directory`, '', { method: 'POST', body: JSON.stringify(body) });
export const updateDirectoryConnection = (id: string, body: Partial<DirectoryInput>): Promise<DirectoryConnection> =>
  request(`${ADMIN_BASE}/directory/${id}`, '', { method: 'PUT', body: JSON.stringify(body) });
export const deleteDirectoryConnection = (id: string): Promise<void> =>
  request(`${ADMIN_BASE}/directory/${id}`, '', { method: 'DELETE' });
export const mintScimToken = (id: string, name: string): Promise<{ id: string; prefix: string; scimToken: string }> =>
  request(`${ADMIN_BASE}/directory/${id}/scim-tokens`, '', { method: 'POST', body: JSON.stringify({ name }) });
export const testLdapConnection = (
  id: string,
  sampleLogin?: string
): Promise<{ ok: boolean; error?: string; detail?: string }> =>
  request(`${ADMIN_BASE}/directory/${id}/test`, '', { method: 'POST', body: JSON.stringify({ sampleLogin }) });
export const syncLdapConnection = (id: string): Promise<{ ok: boolean; summary?: string; error?: string }> =>
  request(`${ADMIN_BASE}/directory/${id}/sync`, '', { method: 'POST' });

// 051 — GitLab dev connections (038 leftover admin UI)
export interface GitlabConnection {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  mode: 'webhook' | 'poll' | 'both';
  groupPath?: string;
  projectIds?: number[];
  apiTokenRef?: string;
  verifySsl: boolean;
  hasWebhookSecret: boolean;
  hasSigningToken: boolean;
  syncCursor?: string;
  backfill?: unknown;
  lastTestAt?: string;
  lastError?: string;
  webhookUrl: string;
  createdAt: string;
}
export interface GitlabConnInput {
  name: string;
  baseUrl: string;
  apiTokenRef: string;
  groupPath?: string;
  projectIds?: number[];
  mode?: 'webhook' | 'poll' | 'both';
  verifySsl?: boolean;
  webhookSecret?: string;
  signingToken?: string;
  enabled?: boolean;
}
const GITLAB_BASE = `${INTERNAL_BASE}/dev/gitlab/connections`;
export const fetchGitlabConnections = (): Promise<{ connections: GitlabConnection[] }> => request(GITLAB_BASE, '');
export const createGitlabConnection = (body: GitlabConnInput): Promise<GitlabConnection & { webhookSecret?: string }> =>
  request(GITLAB_BASE, '', { method: 'POST', body: JSON.stringify(body) });
export const updateGitlabConnection = (id: string, body: Partial<GitlabConnInput>): Promise<GitlabConnection> =>
  request(`${GITLAB_BASE}/${id}`, '', { method: 'PUT', body: JSON.stringify(body) });
export const deleteGitlabConnection = (id: string): Promise<void> =>
  request(`${GITLAB_BASE}/${id}`, '', { method: 'DELETE' });
export const testGitlabConnection = (id: string): Promise<{ ok: boolean; error?: string }> =>
  request(`${GITLAB_BASE}/${id}/test`, '', { method: 'POST' });
export const backfillGitlabConnection = (id: string): Promise<{ queued: boolean; jobId?: string }> =>
  request(`${GITLAB_BASE}/${id}/backfill`, '', { method: 'POST' });
export const syncGitlabConnection = (id: string): Promise<{ ok: boolean; ingested?: number; error?: string }> =>
  request(`${GITLAB_BASE}/${id}/sync`, '', { method: 'POST' });
export function createProjectCategory(input: { name: string; description?: string }): Promise<ProjectCategory> {
  return request('/projectcategories', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(input) });
}
export function assignProjectScheme(
  projectKey: string,
  kind:
    | 'issuesecurityscheme'
    | 'issuetypescheme'
    | 'issuetypescreenscheme'
    | 'fieldconfigurationscheme'
    | 'workflowscheme',
  schemeId: string | null
): Promise<{ id: string }> {
  return request(`/projects/${encodeURIComponent(projectKey)}/${kind}`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ schemeId }),
  });
}

// ---------- Sprint 034: automation ----------
export interface AutomationRule {
  id: string;
  name: string;
  description?: string;
  scope: string;
  projectId?: string;
  enabled: boolean;
  version: number;
  failureCount: number;
  trigger: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  actor?: { accountId: string; displayName: string };
  author?: { accountId: string; displayName: string };
  project?: { id: string; key: string; name: string };
}
export interface AutomationRun {
  id: string;
  ruleId: string;
  ruleVersion: number;
  issueId?: string;
  status: string;
  error?: string;
  steps: { step: string; index: number; detail?: string; result?: unknown; error?: string; at: string }[];
  startedAt: string;
  finishedAt?: string;
}
export interface AutomationFieldSpec {
  key: string;
  kind: 'text' | 'csv' | 'bool' | 'json';
  required?: boolean;
  hint?: string;
}
export interface AutomationSchema {
  triggers: { name: string; description: string; fields: AutomationFieldSpec[] }[];
  conditions: { name: string; description: string; fields: AutomationFieldSpec[] }[];
  actions: { name: string; description: string; fields: AutomationFieldSpec[] }[];
}
export function fetchAutomationRules(): Promise<{ rules: AutomationRule[] }> {
  return request('/automation/rules', INTERNAL_BASE);
}
export function fetchAutomationSchema(): Promise<AutomationSchema> {
  return request('/automation/schema', INTERNAL_BASE);
}
export function createAutomationRule(body: Record<string, unknown>): Promise<AutomationRule> {
  return request('/automation/rules', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
}
export function updateAutomationRule(id: string, body: Record<string, unknown>): Promise<AutomationRule> {
  return request(`/automation/rules/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(body) });
}
export function deleteAutomationRule(id: string): Promise<void> {
  return request(`/automation/rules/${id}`, INTERNAL_BASE, { method: 'DELETE' });
}
export function toggleAutomationRule(id: string, enabled: boolean): Promise<AutomationRule> {
  return request(`/automation/rules/${id}/toggle`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}
export function fetchAutomationRuns(ruleId: string): Promise<{ runs: AutomationRun[] }> {
  return request(`/automation/rules/${ruleId}/runs`, INTERNAL_BASE);
}
export function validateAutomationRule(body: Record<string, unknown>): Promise<{ valid: boolean; errors: string[] }> {
  return request('/automation/validate', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
}
export function dryRunAutomationRule(
  id: string,
  scope: { issueKey?: string; jql?: string }
): Promise<AutomationRun | { runs: AutomationRun[] }> {
  return request(`/automation/rules/${id}/dry-run`, INTERNAL_BASE, { method: 'POST', body: JSON.stringify(scope) });
}

// ---------- Sprint 036: identity ----------

export interface Profile {
  user: {
    id: string;
    email: string;
    displayName: string;
    locale: string;
    timezone: string;
    dateFormat: string;
    totpEnabled: boolean;
    mustChangePassword: boolean;
    avatarEmoji?: string | null;
  };
  openIssues: { id: string; key: string; summary: string; status: string; type: string }[];
  recentComments: { id: string; issueKey: string; body: string; createdAt: string }[];
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export function fetchProfile(): Promise<Profile> {
  return request('/me', '/api/internal');
}

/** Read-only profile of any user (Jira ViewProfile parity). */
export interface UserProfile {
  user: UserRef & {
    locale?: string;
    timezone?: string;
    dateFormat?: string;
    avatarEmoji?: string | null;
    /** Group names — present only for self or admin callers (Jira Groups box). */
    groups?: string[];
  };
  openIssuesByProject: {
    project: { key: string; name: string };
    issues: {
      key: string;
      summary: string;
      status: string;
      statusCategory: string;
      type: string;
      priority: string | null;
    }[];
  }[];
  recentComments: { id: string; issueKey: string; body: string; createdAt: string }[];
}
export function fetchUserProfile(accountId: string): Promise<UserProfile> {
  return request(`/users/${encodeURIComponent(accountId)}/profile`, '/api/internal');
}
export function updateProfile(body: {
  displayName?: string;
  locale?: string;
  timezone?: string;
  dateFormat?: string;
  avatarEmoji?: string | null;
}) {
  return request('/me', '/api/internal', { method: 'PUT', body: JSON.stringify(body) });
}
export function changePassword(current: string, next: string) {
  return request('/me/password', '/api/internal', { method: 'PUT', body: JSON.stringify({ current, new: next }) });
}
export function fetchSessions(): Promise<SessionInfo[]> {
  return request('/me/sessions', '/api/internal');
}
export function revokeSession(id: string) {
  return request(`/me/sessions/${id}`, '/api/internal', { method: 'DELETE' });
}
export interface OAuthGrantInfo {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  projectKeys: string[];
  createdAt: string;
}
export function fetchMyGrants(): Promise<{ grants: OAuthGrantInfo[] }> {
  return request('/me/grants', '/api/internal');
}
export function revokeMyGrant(id: string) {
  return request(`/me/grants/${id}`, '/api/internal', { method: 'DELETE' });
}
export function totpEnroll(): Promise<{ secret: string; otpauthUrl: string }> {
  return request('/me/totp', '/api/internal', { method: 'POST' });
}
export function totpVerify(code: string): Promise<{ backupCodes: string[] }> {
  return request('/me/totp/verify', '/api/internal', { method: 'POST', body: JSON.stringify({ code }) });
}
export function totpDisable(code: string) {
  return request('/me/totp', '/api/internal', { method: 'DELETE', body: JSON.stringify({ code }) });
}
export function loginTotp(pending: string, code: string): Promise<Myself> {
  return request('/auth/login/totp', '/api/internal', { method: 'POST', body: JSON.stringify({ pending, code }) });
}
export function fetchIdps(): Promise<{ id: string; name: string }[]> {
  return request('/auth/idps', '/api/internal');
}
export async function requestPasswordReset(email: string): Promise<string | null> {
  const res = await fetch('/api/internal/auth/reset-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new ApiError(res.status, [], {});
  // Non-production exposes the token for dev/test; production delivers it by email.
  return res.headers.get('x-reset-token');
}
export function confirmPasswordReset(token: string, newPassword: string) {
  return request('/auth/reset-confirm', '/api/internal', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

// ---------- Sprint 038: development panel ----------
export interface DevItem {
  id: string;
  title: string;
  url: string | null;
  state: string;
  author: string | null;
  repo: string;
  createdAt: string;
}
export interface DevPanel {
  branches: DevItem[];
  commits: DevItem[];
  pullRequests: DevItem[];
  builds: DevItem[];
  deployments: DevItem[];
}
export function fetchDevPanel(issueKey: string): Promise<DevPanel> {
  return request(`/issues/${issueKey}/development`, '/api/internal');
}

// ---- Sprint 041: roadmap / gantt feed ----
export interface RoadmapLink {
  id: string;
  typeId: string;
  type: string;
  direction: 'outward' | 'inward';
  key: string;
}
export interface RoadmapRow {
  key: string;
  summary: string;
  type: string;
  isSubtask: boolean;
  status: { name: string; category: string };
  assignee: string | null;
  parent: string | null;
  start: string | null;
  due: string | null;
  progress: { done: number; total: number; pct: number };
  links: RoadmapLink[];
}
export interface RoadmapData {
  board: { id: string; name: string; type: string; projectKey: string };
  range: { start: string; end: string };
  epics?: RoadmapRow[];
  issues?: RoadmapRow[];
  versions: { name: string; releaseDate: string | null; released: boolean }[];
}
export function fetchRoadmap(boardRef: string, opts: { level?: string; status?: string } = {}): Promise<RoadmapData> {
  const qs = new URLSearchParams();
  if (opts.level) qs.set('level', opts.level);
  if (opts.status) qs.set('status', opts.status);
  const suffix = qs.size ? `?${qs}` : '';
  return request(`/roadmap/${encodeURIComponent(boardRef)}${suffix}`, INTERNAL_BASE);
}

// ---------- 044 US3 — admin system status + backups + support zip ----------
export interface SystemStatus {
  version: string;
  scm: string;
  uptimeSec: number;
  checks: Record<string, string>;
  queue: { waiting: number; failed: number };
  backup: { at: string; ok: boolean; id?: string; error?: string } | null;
  backups: number;
  update: {
    at: string;
    current: string;
    latest: string;
    updateAvailable: boolean;
    url?: string;
    error?: string;
  } | null;
  updateCheckEnabled: boolean;
}
export interface BackupSet {
  id: string;
  createdAt: string;
  version: string;
  counts: Record<string, number>;
}
export const fetchSystemStatus = (): Promise<SystemStatus> => request('/admin/system/status', INTERNAL_BASE);
export const fetchBackups = (): Promise<{ backups: BackupSet[] }> => request('/admin/system/backups', INTERNAL_BASE);
export const runBackupNow = (): Promise<BackupSet> =>
  request('/admin/system/backup', INTERNAL_BASE, { method: 'POST' });
export const verifyBackupSet = (id: string): Promise<{ id: string; ok: boolean; mismatched: string[] }> =>
  request(`/admin/system/backups/${encodeURIComponent(id)}/verify`, INTERNAL_BASE, { method: 'POST' });
export const supportZipUrl = `${INTERNAL_BASE}/admin/system/support.zip`;
// 044 US5 — opt-in update check
export interface UpdateCheckResult {
  at: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
  url?: string;
  error?: string;
}
export const runUpdateCheck = (): Promise<UpdateCheckResult> =>
  request('/admin/system/updatecheck', INTERNAL_BASE, { method: 'POST' });

// --- Sprint 050: docs portal ---
export interface DocsPageEntry {
  slug: string;
  title: string;
  section: string;
  audience: 'public' | 'authed' | 'admin';
  description?: string;
}
export interface DocsSectionMeta {
  description?: string;
  icon?: string;
}
export interface DocsManifest {
  sections: Record<string, string>;
  sectionMeta?: Record<string, DocsSectionMeta>;
  public: boolean;
  pages: DocsPageEntry[];
}
export const fetchDocsManifest = (): Promise<DocsManifest> => request('/docs/manifest', INTERNAL_BASE);
export const fetchDocPage = (slug: string): Promise<DocsPageEntry & { markdown: string; html: string }> =>
  request(`/docs/page/${encodeURIComponent(slug)}`, INTERNAL_BASE);
export const fetchDocsIndex = (): Promise<{
  index: { slug: string; title: string; section: string; headings: string[] }[];
}> => request('/docs/index', INTERNAL_BASE);
export const fetchDocsSearch = (
  q: string
): Promise<{ results: { slug: string; title: string; section: string; excerpt: string }[] }> =>
  request(`/docs/search?q=${encodeURIComponent(q)}`, INTERNAL_BASE);
export interface OpenApiSpec {
  openapi: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  tags?: { name: string }[];
}
export const fetchDocsOpenApi = (): Promise<OpenApiSpec> => request('/docs/openapi.json', INTERNAL_BASE);

// ---------- 021 — admin console ----------
export interface AdminUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
  active: boolean;
  isAdmin?: boolean;
  accountType?: string;
  agent?: boolean;
  isAssignableAgent?: boolean;
  approvalPolicy?: string; // 061 US6
  lastLoginAt?: string | null;
  groups?: string[];
  directory?: string; // 060 US5
  invitedAt?: string | null; // 061 US2 — set while an invite is pending
}
export const fetchAdminUsers = (): Promise<AdminUser[]> => request('/users', INTERNAL_BASE);
export const fetchAdminUsersFiltered = (filters: {
  status?: string;
  type?: string;
  group?: string;
  query?: string;
}): Promise<AdminUser[]> => {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
  const s = q.toString();
  return request(`/users${s ? `?${s}` : ''}`, INTERNAL_BASE);
};
/** GET /api/internal/admin/users — paginated admin directory (same filters as
 *  the flat /users list, which stays the picker/MCP contract). */
export interface AdminUsersPage {
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
  values: AdminUser[];
}
export const fetchAdminUsersPage = (filters: {
  status?: string;
  type?: string;
  group?: string;
  query?: string;
  startAt?: number;
  maxResults?: number;
}): Promise<AdminUsersPage> => {
  const { startAt = 0, maxResults = 50, ...rest } = filters;
  const q = new URLSearchParams([
    ...(Object.entries(rest).filter(([, v]) => v) as [string, string][]),
    ['startAt', String(startAt)],
    ['maxResults', String(maxResults)],
  ]);
  return request(`/admin/users?${q}`, INTERNAL_BASE);
};
// 060 US5 — invite flow (Jira "Invitar usuarios").
export const inviteUser = (body: {
  email: string;
  displayName?: string;
  groups?: string[];
}): Promise<AdminUser & { invited: boolean; mailSent: boolean; inviteUrl?: string }> =>
  request('/users/invite', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
export const reinviteUser = (accountId: string): Promise<{ invited: boolean; mailSent: boolean; inviteUrl?: string }> =>
  request(`/users/${encodeURIComponent(accountId)}/invite`, INTERNAL_BASE, { method: 'POST' });
// 060 US6 — anonymization, two-step: preview → confirmToken → execute.
export interface AnonymizePreview {
  accountId: string;
  displayName: string;
  emailAddress: string;
  willScrub: Record<string, unknown>;
  confirmToken: string;
}
export const previewAnonymizeUser = (accountId: string): Promise<AnonymizePreview> =>
  request(`/users/${encodeURIComponent(accountId)}/anonymize?dryRun=true`, INTERNAL_BASE, { method: 'POST' });
export const anonymizeUser = (accountId: string, confirmToken: string): Promise<void> =>
  request(
    `/users/${encodeURIComponent(accountId)}/anonymize?confirmToken=${encodeURIComponent(confirmToken)}`,
    INTERNAL_BASE,
    { method: 'POST' }
  );
export const acceptInvite = (token: string, newPassword: string): Promise<void> =>
  request('/auth/invite-accept', INTERNAL_BASE, { method: 'POST', body: JSON.stringify({ token, newPassword }) });
export const createAdminUser = (body: {
  email: string;
  displayName: string;
  password?: string;
  isAdmin?: boolean;
  type?: 'human' | 'agent';
  ownerId?: string;
  isAssignableAgent?: boolean;
  approvalPolicy?: 'always' | 'destructiveOnly' | 'never';
}): Promise<AdminUser> => request('/users', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
export const patchAdminUser = (
  accountId: string,
  body: {
    active?: boolean;
    displayName?: string;
    password?: string;
    isAdmin?: boolean;
    isAssignableAgent?: boolean;
    approvalPolicy?: 'always' | 'destructiveOnly' | 'never';
  }
): Promise<AdminUser> =>
  request(`/users/${encodeURIComponent(accountId)}`, INTERNAL_BASE, { method: 'PATCH', body: JSON.stringify(body) });

export interface AdminGroup {
  name: string;
  memberCount: number;
}
export const fetchGroups = (
  query?: string,
  startAt = 0,
  maxResults = 100
): Promise<{ groups: AdminGroup[]; total: number }> => {
  const q = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) });
  if (query) q.set('query', query);
  return request(`/groups/picker?${q}`);
};
export const createGroup = (name: string): Promise<{ name: string }> =>
  request('/group', { method: 'POST', body: JSON.stringify({ name }) });
export const deleteGroup = (name: string): Promise<void> =>
  request(`/group?groupname=${encodeURIComponent(name)}`, { method: 'DELETE' });
export interface GroupMembersPage {
  startAt: number;
  maxResults: number;
  total: number;
  isLast: boolean;
  values: UserRef[];
}
export const fetchGroupMembers = (name: string, startAt = 0, query = ''): Promise<GroupMembersPage> =>
  request(
    `/group/member?groupname=${encodeURIComponent(name)}&startAt=${startAt}&maxResults=50` +
      (query ? `&query=${encodeURIComponent(query)}` : '')
  );
export const addGroupMember = (group: string, accountId: string): Promise<unknown> =>
  request(`/group/user?groupname=${encodeURIComponent(group)}`, {
    method: 'POST',
    body: JSON.stringify({ accountId }),
  });
export const removeGroupMember = (group: string, accountId: string): Promise<void> =>
  request(`/group/user?groupname=${encodeURIComponent(group)}&accountId=${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
  });

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectKeys: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}
export const fetchUserTokens = (accountId: string): Promise<ApiTokenInfo[]> =>
  request(`/users/${encodeURIComponent(accountId)}/tokens`, INTERNAL_BASE);
// Self-service PATs — session-only server-side (a token can't mint tokens).
export const fetchMyTokens = (): Promise<ApiTokenInfo[]> => request('/tokens', INTERNAL_BASE);
export const createToken = (body: {
  name: string;
  scopes: string[];
  projectKeys?: string[];
  expiresAt?: string;
  approvalPolicy?: 'always' | 'destructiveOnly' | 'never';
}): Promise<ApiTokenInfo & { secret: string }> =>
  request('/tokens', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
// 061 US5 — aggregate: one request instead of users + per-user fan-out.
export const fetchAllAdminTokens = (): Promise<(ApiTokenInfo & { owner: AdminUser })[]> =>
  request('/admin/tokens', INTERNAL_BASE);
export const revokeToken = (id: string): Promise<void> =>
  request(`/tokens/${encodeURIComponent(id)}`, INTERNAL_BASE, { method: 'DELETE' });

// 061 US7 — distinct action names for the filter datalist.
export const fetchAuditActions = (): Promise<string[]> =>
  request<{ actions: string[] }>('/audit/actions', INTERNAL_BASE).then((r) => r.actions);

export interface AuditEventRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ip: string | null;
  createdAt: string;
  actor: { accountId: string; displayName: string; agent: boolean } | null;
}
export interface AuditFilter {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
}
const auditQs = (f: AuditFilter & { startAt?: number; maxResults?: number; format?: string }) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
export const fetchAuditEvents = (
  f: AuditFilter & { startAt?: number; maxResults?: number }
): Promise<{ total: number; events: AuditEventRow[] }> => request(`/audit${auditQs(f)}`, INTERNAL_BASE);
export const auditCsvUrl = (f: AuditFilter & { maxResults?: number }): string =>
  `${INTERNAL_BASE}/audit${auditQs({ ...f, format: 'csv' })}`;

// ---------- 021 US3 — metadata editors + schemes ----------
export interface MetadataItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
  color?: string;
  sequence?: number;
  subtask?: boolean;
  hierarchyLevel?: number;
  inward?: string;
  outward?: string;
}
export type MetadataEntity = 'statuses' | 'priorities' | 'resolutions' | 'issuetypes' | 'issuelinktypes';
export const fetchMetadata = (entity: MetadataEntity): Promise<MetadataItem[]> =>
  request(`/metadata/${entity}`, INTERNAL_BASE);
export const createMetadata = (entity: MetadataEntity, body: Record<string, unknown>): Promise<MetadataItem> =>
  request(`/metadata/${entity}`, INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
export const updateMetadata = (
  entity: MetadataEntity,
  id: string,
  body: Record<string, unknown>
): Promise<MetadataItem> =>
  request(`/metadata/${entity}/${id}`, INTERNAL_BASE, { method: 'PUT', body: JSON.stringify(body) });
export const deleteMetadata = (entity: MetadataEntity, id: string): Promise<void> =>
  request(`/metadata/${entity}/${id}`, INTERNAL_BASE, { method: 'DELETE' });

export interface PermissionGrant {
  id: string;
  permission: string;
  holder: { type: string; parameter?: string };
}
export interface PermissionScheme {
  id: string;
  name: string;
  description?: string;
  grants?: PermissionGrant[];
}
export const fetchPermissionSchemes = (): Promise<{ permissionSchemes: PermissionScheme[] }> =>
  request('/permissionscheme');
export const fetchPermissionScheme = (id: string): Promise<PermissionScheme> => request(`/permissionscheme/${id}`);
export const createPermissionScheme = (body: { name: string; description?: string }): Promise<PermissionScheme> =>
  request('/permissionscheme', { method: 'POST', body: JSON.stringify(body) });
export const deletePermissionScheme = (id: string, dryRun = false): Promise<unknown> =>
  request(`/permissionscheme/${id}${dryRun ? '?dryRun=true' : ''}`, { method: 'DELETE' });
export const addSchemeGrant = (
  schemeId: string,
  body: { permission: string; holder: { type: string; parameter?: string } }
): Promise<PermissionGrant> =>
  request(`/permissionscheme/${schemeId}/permission`, { method: 'POST', body: JSON.stringify(body) });
export const removeSchemeGrant = (schemeId: string, grantId: string): Promise<void> =>
  request(`/permissionscheme/${schemeId}/permission/${grantId}`, { method: 'DELETE' });
export interface GrantPreview {
  holder: { type: string; parameter?: string };
  projects: string[];
  directUserCount: number | null;
  dynamic: boolean;
  detail: string;
}
export const previewSchemeGrant = (
  schemeId: string,
  holder: { type: string; parameter?: string }
): Promise<GrantPreview> =>
  request(`/permissionscheme/${schemeId}/permission/preview`, { method: 'POST', body: JSON.stringify({ holder }) });

export interface SecurityLevel {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  members: { type: string; parameter?: string }[];
}
export interface AdminSecurityScheme {
  id: string;
  name: string;
  description?: string;
  defaultSecurityLevelId: string | null;
  levels: SecurityLevel[];
}
export const fetchAdminSecuritySchemes = (): Promise<AdminSecurityScheme[]> =>
  request('/issuesecurityschemes', INTERNAL_BASE);
export const createSecurityScheme = (body: { name: string; description?: string }): Promise<AdminSecurityScheme> =>
  request('/issuesecurityschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
export const deleteSecurityScheme = (id: string): Promise<void> =>
  request(`/issuesecurityschemes/${id}`, INTERNAL_BASE, { method: 'DELETE' });
export const addSecurityLevel = (
  schemeId: string,
  body: { name: string; description?: string; isDefault?: boolean; members?: { kind: string; ref?: string }[] }
): Promise<SecurityLevel> =>
  request(`/issuesecurityschemes/${schemeId}/levels`, INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
export const deleteSecurityLevel = (levelId: string): Promise<void> =>
  request(`/issuesecurityschemes/levels/${levelId}`, INTERNAL_BASE, { method: 'DELETE' });

// ---------- 061 US3 — mail admin + notification schemes ----------
export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string; // GET masks pass as '•••'
  from: string;
  baseUrl: string;
  envOverrides?: string[];
}
export const fetchMailConfig = (): Promise<MailConfig> => request('/mail', ADMIN_BASE);
export const saveMailConfig = (body: Partial<MailConfig>): Promise<MailConfig> =>
  request('/mail', ADMIN_BASE, { method: 'PUT', body: JSON.stringify(body) });
export const testMailConfig = (to?: string): Promise<{ ok: boolean; to: string }> =>
  request('/mail/test', ADMIN_BASE, { method: 'POST', body: JSON.stringify(to ? { to } : {}) });
export interface MailOutboxRow {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  eventType: string | null;
  issueKey: string | null;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}
export const fetchMailOutbox = (status?: string): Promise<{ total: number; outbox: MailOutboxRow[] }> =>
  request(`/admin/outbox${status ? `?status=${encodeURIComponent(status)}` : ''}`, INTERNAL_BASE);

export interface NotificationSchemeEntry {
  id?: string;
  event: string;
  channel?: string;
  recipientKind: string;
  recipientRef?: string | null;
}
export interface NotificationScheme {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  entries: NotificationSchemeEntry[];
  projects?: { key: string }[];
  _count?: { projects: number };
}
export const fetchNotificationSchemes = (): Promise<{ schemes: NotificationScheme[] }> =>
  request('/notificationschemes', INTERNAL_BASE);
export const createNotificationScheme = (body: {
  name: string;
  description?: string;
  entries?: NotificationSchemeEntry[];
}): Promise<NotificationScheme> =>
  request('/notificationschemes', INTERNAL_BASE, { method: 'POST', body: JSON.stringify(body) });
export const updateNotificationScheme = (
  id: string,
  body: { name?: string; description?: string; entries?: NotificationSchemeEntry[] }
): Promise<NotificationScheme> =>
  request(`/notificationschemes/${encodeURIComponent(id)}`, INTERNAL_BASE, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
export const deleteNotificationScheme = (id: string): Promise<void> =>
  request(`/notificationschemes/${encodeURIComponent(id)}`, INTERNAL_BASE, { method: 'DELETE' });
export const assignNotificationScheme = (projectKey: string, schemeId: string | null): Promise<unknown> =>
  request(`/projects/${encodeURIComponent(projectKey)}/notificationscheme`, INTERNAL_BASE, {
    method: 'POST',
    body: JSON.stringify({ schemeId }),
  });

// ---------- 061 US4 — backup restore console ----------
export interface RestorePreview {
  preview: { id: string; createdAt: string; version: string; files: number; counts: Record<string, number> };
  warning: string;
  confirmToken: string;
}
export const previewBackupRestore = (id: string): Promise<RestorePreview> =>
  request(`/admin/system/backups/${encodeURIComponent(id)}/restore?dryRun=true`, INTERNAL_BASE, { method: 'POST' });
export const restoreBackup = (id: string, confirmToken: string): Promise<{ started: boolean; backupId: string }> =>
  request(
    `/admin/system/backups/${encodeURIComponent(id)}/restore?confirmToken=${encodeURIComponent(confirmToken)}`,
    INTERNAL_BASE,
    { method: 'POST' }
  );
export interface RestoreStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  backupId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}
export const fetchRestoreStatus = (): Promise<RestoreStatus> => request('/admin/system/restore-status', INTERNAL_BASE);
