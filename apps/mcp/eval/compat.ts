/**
 * Compatibility harness: fetches the live OpenAPI doc and emits
 * docs/compatibility.md — a matrix of Jira REST endpoints vs TrackForge status.
 *
 *   TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_... tsx eval/compat.ts
 */
import { writeFileSync } from 'node:fs';
import { TrackForgeClient } from '../src/client.js';

const tf = new TrackForgeClient(
  process.env.TRACKFORGE_URL ?? 'http://localhost:3000',
  process.env.TRACKFORGE_TOKEN ?? ''
);

interface Row { jira: string; ours: string | null; status: 'full' | 'partial' | 'missing' | 'native'; note?: string }

/** Jira REST reference surface (subset that matters for agents). */
const MATRIX: Row[] = [
  { jira: 'GET /rest/api/2/project', ours: '/rest/api/2/project', status: 'full' },
  { jira: 'POST /rest/api/2/project', ours: '/rest/api/2/project', status: 'full', note: 'Jira-admin only, as Jira' },
  { jira: 'GET /rest/api/2/project/{key}', ours: '/rest/api/2/project/{key}', status: 'full' },
  { jira: 'PUT /rest/api/2/project/{key}', ours: '/rest/api/2/project/{key}', status: 'full', note: 'name/description/lead/avatarColor' },
  { jira: 'DELETE /rest/api/2/project/{key}', ours: '/rest/api/2/project/{key}', status: 'full', note: 'admin-only cascade' },
  { jira: 'GET /rest/api/2/issue/{key}', ours: '/rest/api/2/issue/{key}', status: 'full', note: 'fields= & expand= supported' },
  { jira: 'POST /rest/api/2/issue', ours: '/rest/api/2/issue', status: 'full', note: '+dryRun & Idempotency-Key (TF ext)' },
  { jira: 'PUT /rest/api/2/issue/{key}', ours: '/rest/api/2/issue/{key}', status: 'full', note: 'fields + update ops (add/remove/set); +composite transition/comment/worklog in one call (063 TF ext)' },
  { jira: 'DELETE /rest/api/2/issue/{key}?deleteSubtasks=', ours: '/rest/api/2/issue/{key}', status: 'full', note: '+confirmToken two-step (TF ext)' },
  { jira: 'GET/POST /rest/api/2/issue/{key}/comment', ours: '/rest/api/2/issue/{key}/comment', status: 'full', note: 'markdown body; [~accountId:] mentions' },
  { jira: 'GET/PUT/DELETE /rest/api/2/issue/{key}/comment/{id}', ours: '/rest/api/2/issue/{key}/comment/{id}', status: 'full' },
  { jira: 'GET/POST /rest/api/2/issue/{key}/worklog', ours: '/rest/api/2/issue/{key}/worklog', status: 'full', note: 'adjustEstimate auto|leave|new|manual; +dryRun (TF ext); billable flag' },
  { jira: 'GET/PUT/DELETE /rest/api/2/issue/{key}/worklog/{id}', ours: '/rest/api/2/issue/{key}/worklog/{id}', status: 'full' },
  { jira: 'GET /rest/api/2/worklog/updated|/deleted · POST /worklog/list', ours: '/rest/api/2/worklog/updated|/rest/api/2/worklog/deleted|/rest/api/2/worklog/list', status: 'full', note: 'incremental sync; issue-scoped' },
  { jira: 'fields.timetracking on create/update + timetracking/timeSpent/workratio in payloads', ours: '/rest/api/2/issue/{key}', status: 'full', note: 'estimate via fields.timetracking; workratio = logged/original·100; JQL: timeSpent/originalEstimate/remainingEstimate/workratio/worklogDate/billable' },
  { jira: 'GET /rest/api/2/resolution', ours: '/rest/api/2/resolution', status: 'full' },
  { jira: 'GET /rest/api/2/label', ours: '/rest/api/2/label', status: 'full' },
  { jira: 'POST/GET/PUT/DELETE /rest/api/2/component[/{id}]', ours: '/rest/api/2/component', status: 'full', note: 'lead, assigneeType; ?moveIssuesTo swap on delete' },
  { jira: 'GET /rest/api/2/project/{key}/components', ours: '/rest/api/2/project/{key}/components', status: 'full', note: '+ issue counts' },
  { jira: 'POST/GET/PUT/DELETE /rest/api/2/version[/{id}]', ours: '/rest/api/2/version', status: 'full', note: 'released/archived/dates; moveFix/AffectedIssuesTo swaps on delete' },
  { jira: 'POST /rest/api/2/version/{id}/move', ours: '/rest/api/2/version/{id}/move', status: 'full', note: 'position or after=; explicit sequence' },
  { jira: 'GET /rest/api/2/project/{key}/versions', ours: '/rest/api/2/project/{key}/versions', status: 'full' },
  { jira: 'GET /rest/api/2/version/{id}/relatedIssueCounts · /unresolvedIssueCount', ours: '/rest/api/2/version/{id}/relatedIssueCounts|/rest/api/2/version/{id}/unresolvedIssueCount', status: 'full' },
  { jira: 'fields.components[]/fixVersions[]/versions[] + JQL component/fixVersion/affectedVersion', ours: '/rest/api/2/issue', status: 'full', note: 'set/add/remove ops; release + releasenotes endpoints; JQL releasedVersions/unreleasedVersions/earliestUnreleasedVersion' },
  { jira: 'GET /rest/api/2/issueLinkType · POST/DELETE /issueLink', ours: '/rest/api/2/issueLinkType|/rest/api/2/issueLink', status: 'full', note: 'Blocks/Relates/Duplicate/Cloners' },
  { jira: 'POST /rest/api/2/issue/bulk', ours: '/rest/api/2/issue/bulk', status: 'partial', note: 'create only, ≤50, per-item errors' },
  { jira: 'GET/POST /rest/api/2/issue/{key}/transitions', ours: '/rest/api/2/issue/{key}/transitions', status: 'full', note: 'workflow transitions; fields+update.comment' },
  { jira: 'GET /rest/api/2/project/{key}/statuses', ours: '/rest/api/2/project/{key}/statuses', status: 'full' },
  { jira: 'GET /rest/api/2/workflow', ours: '/rest/api/2/workflow', status: 'partial', note: 'names+default only (Jira returns description/lastModified too); full defs via /api/internal/workflows' },
  { jira: 'PUT /rest/agile/1.0/issue/rank', ours: '/rest/agile/1.0/issue/rank', status: 'full', note: 'LexoRank rankBefore/After' },
  { jira: 'PUT /rest/api/2/issue/{key}/assignee', ours: '/rest/api/2/issue/{key}/assignee', status: 'full' },
  { jira: 'GET /rest/api/2/issue/{key}/changelog', ours: '/rest/api/2/issue/{key}/changelog', status: 'full' },
  { jira: 'GET/POST /rest/api/2/search', ours: '/rest/api/2/search', status: 'full', note: 'real JQL: fields/ops/functions/ORDER BY; fields=expand=' },
  { jira: 'POST /rest/api/2/jql/parse', ours: '/rest/api/2/jql/parse', status: 'full', note: 'structure or positioned errors' },
  { jira: 'GET /rest/api/2/jql/autocompletedata', ours: '/rest/api/2/jql/autocompletedata|/rest/api/2/jql/autocompletedata/suggestions', status: 'full', note: 'field metadata + value suggestions' },
  { jira: 'GET/POST /rest/api/2/filter', ours: '/rest/api/2/filter|/rest/api/2/filter/{id}', status: 'full', note: 'CRUD + sharePermissions→visibility' },
  { jira: 'GET /rest/api/2/filter/my · /favourite', ours: '/rest/api/2/filter/my|/rest/api/2/filter/favourite', status: 'full', note: '+favorite spelling, PUT/DELETE /:id/favourite, /:id/run' },
  { jira: 'GET /rest/api/2/issue/createmeta/{p}/issuetypes', ours: '/rest/api/2/issue/createmeta/{projectKey}/issuetypes', status: 'full' },
  { jira: 'GET /rest/api/2/issue/{key}/editmeta', ours: '/rest/api/2/issue/{key}/editmeta', status: 'full' },
  { jira: 'GET /rest/api/2/field', ours: '/rest/api/2/field', status: 'full' },
  { jira: 'GET /rest/api/2/status|priority|issuetype', ours: '/rest/api/2/status|/rest/api/2/priority|/rest/api/2/issuetype', status: 'full' },
  { jira: 'GET /rest/api/2/serverInfo', ours: '/rest/api/2/serverInfo', status: 'full' },
  { jira: 'GET /rest/api/2/myself', ours: '/rest/api/2/myself', status: 'full' },
  { jira: 'GET /rest/api/2/user/search', ours: '/rest/api/2/user/search', status: 'partial', note: 'query= (Jira: username=)' },
  { jira: 'GET /rest/api/2/user/assignable/search', ours: '/rest/api/2/user/assignable/search', status: 'full', note: 'filtered to users holding ASSIGNABLE_USER on the project (Jira)' },
  { jira: 'GET /rest/agile/1.0/board…', ours: '/rest/agile/1.0/board*', status: 'partial', note: 'persisted board, config GET/PUT, issue page (+quickFilterIds), /backlog, /type (TF ext)' },
  { jira: 'POST/DELETE /rest/agile/1.0/board[/{id}]', ours: 'same', status: 'partial', note: '033 — Jira create shape (name/type/filterId/location); delete default needs ?promoteTo; rename via /api/internal/boards/{id} (no Jira PUT)' },
  { jira: 'GET /rest/agile/1.0/board/{id}/quickfilter[/{qfId}]', ours: 'same', status: 'full', note: '033 — Jira read-only surface; writes via /api/internal/boards/{id}/quickfilters (JQL validated on save)' },
  { jira: 'GET /rest/api/2/issue/picker?query=', ours: 'same', status: 'full', note: '033 — key exact/prefix + summary contains; visibility-scoped' },
  { jira: '—', ours: 'GET/PUT /api/internal/boards/{id}/cardconfig · /quickfilters · /default · PUT /{id}', status: 'native', note: '033 TF ext — card colors/indicators/daysInColumn/statistics/swimlaneBy; quick-filter CRUD; set default; rename+filter' },
  { jira: '—', ours: '/api/internal/automation/*', status: 'native', note: '034 TF ext — Jira Automation has no public REST parity target: rules CRUD+validate+run+dry-run, runs audit, schema registry; actor∩author permission model' },
  { jira: '—', ours: '/api/internal/me*', status: 'native', note: '036 TF ext — profile (locale/timezone/dateFormat), sessions enumerate+revoke, password change, TOTP enroll/verify/disable/backup-codes' },
  { jira: '—', ours: '/api/internal/auth/reset-request|reset-confirm|oidc/{idp}*', status: 'native', note: '036 TF ext — password reset tokens (1h, single-use); OIDC authorization-code+PKCE flow with verified-email linking' },
  { jira: '—', ours: '/api/internal/admin/idps', status: 'native', note: '036 TF ext — IdentityProvider CRUD (admin); claimMap/autoProvision; OidcIdentity link rows' },
  { jira: '—', ours: '/rest/api/3/*', status: 'native', note: '040 — full v3 mirror of the documented v2 surface via adfWire (ADF<->markdown at the boundary); fields.description|environment + comment bodies emit ADF; expand=renderedFields adds sanitized HTML; x-trackforge-adf-losses surfaces lossy nodes; see docs/adf.md' },
  { jira: '—', ours: '/api/internal/dev/*', status: 'native', note: '038 TF ext — signed receivers (HMAC/gitlab-token), DevRepository CRUD, deliveries/unlinked debug views, issue development panel' },
  { jira: 'Sprint lifecycle', ours: '/rest/agile/1.0/sprint*', status: 'full', note: 'CRUD + start/complete with carry-over, membership history' },
  { jira: 'Epic endpoints', ours: '/rest/agile/1.0/epic/{key}', status: 'full', note: 'GET epic, GET/POST epic/{key}/issue, epic/none/issue' },
  { jira: 'GET /rest/agile/1.0/issue/{key}', ours: '/rest/agile/1.0/issue/{issueKey}', status: 'full', note: 'same shape as /rest/api/2/issue' },
  { jira: 'GET/PUT /rest/agile/1.0/board/{id}/configuration', ours: '/rest/agile/1.0/board/{boardId}/configuration', status: 'full', note: 'columns + WIP limits' },
  { jira: 'GET/POST/DELETE /rest/api/2/issue/{key}/watchers', ours: '/rest/api/2/issue/{key}/watchers', status: 'full', note: 'watchCount + isWatching; watchers[]/voters[] gated by VIEW_VOTERS_AND_WATCHERS; watch-on-behalf by MANAGE_WATCHERS; auto-watch on create/comment' },
  { jira: 'GET/POST/DELETE /rest/api/2/issue/{key}/votes', ours: '/rest/api/2/issue/{key}/votes', status: 'full', note: 'idempotent add; per-caller hasVoted in fields.votes; voters[] gated by VIEW_VOTERS_AND_WATCHERS' },
  { jira: 'GET/POST /rest/api/2/issue/{key}/remotelink · DELETE /{linkId}', ours: '/rest/api/2/issue/{key}/remotelink', status: 'full', note: 'Jira object shape; changelog Link item; no icon/status fetching (deferred)' },
  { jira: '—', ours: 'POST /api/internal/issues/{key}/clone', status: 'native', note: 'TF ext — Jira has no REST clone; dryRun + carry-over options + Cloners link' },
  { jira: '—', ours: 'POST /api/internal/issues/{key}/move', status: 'native', note: 'TF ext — dryRun field-drop preview; IssueKeyAlias resolves old keys' },
  { jira: '—', ours: 'POST /api/internal/bulk/{edit|transition|move|delete|comment|watch|link} · GET /job/{id} · POST /job/{id}/retry', status: 'native', note: 'TF ext — Jira has no bulk REST API; dryRun plan → durable job → per-item results' },
  { jira: '—', ours: 'GET /api/internal/export/issues?format=csv|print · /export/issue/{key}?format=print', status: 'native', note: 'TF ext — JQL+permission identical to /search; RFC-4180 + UTF-8 BOM' },
  { jira: 'GET /rest/api/2/dashboard', ours: '/rest/api/2/dashboard', status: 'partial', note: 'visible-list + create; Jira share-permission types global|loggedin|group|project|project-role|user; gadget data resolves as viewer (Jira: owner quirk)' },
  { jira: 'GET /rest/api/2/dashboard/search · /{id} · /{id}/copy · /{id}/gadget[/{gid}] · /gadgets', ours: '/rest/api/2/dashboard/*', status: 'partial', note: 'search paginates dashboardName/owner; copy is private-to-copier; gadgets CRUD + type registry' },
  { jira: '—', ours: 'GET /api/internal/dashboards/{id}/data · /gadgets/{gid}/data', status: 'native', note: 'TF ext — single aggregate call, viewer-context, per-gadget error cards (8 gadget types)' },
  { jira: 'POST/GET/PUT/DELETE /rest/webhooks/1.0/webhook', ours: '/rest/webhooks/1.0/webhook', status: 'full', note: 'HMAC, retry/backoff, SSRF block, jqlFilter, excludeActorIds' },
  { jira: 'POST /rest/api/2/issue/{key}/attachments', ours: '/rest/api/2/issue/{key}/attachments', status: 'full', note: 'multipart "file", X-Atlassian-Token: no-check, sniffed-mime wins' },
  { jira: 'GET /rest/api/2/attachment/{id}|/content/{id}|/thumbnail/{id} · /meta', ours: '/rest/api/2/attachment/{id}|/rest/api/2/attachment/content/{id}|/rest/api/2/attachment/thumbnail/{id}|/rest/api/2/attachment/meta', status: 'full', note: 'safe-inline serve headers; SVG forced download; async thumbnails; meta→{enabled,uploadLimit}' },
  { jira: 'DELETE /rest/api/2/attachment/{id}', ours: '/rest/api/2/attachment/{id}', status: 'full', note: 'author needs DELETE_OWN_ATTACHMENTS, others DELETE_ALL_ATTACHMENTS; fields.attachment[] on issue; votes not planned' },
  { jira: '— TrackForge native —', ours: '/api/internal/auth/*', status: 'native', note: 'login, whoami' },
  { jira: '— TrackForge native —', ours: '/api/internal/users|tokens|audit', status: 'native', note: 'admin surface' },
  { jira: '— TrackForge native —', ours: '/api/internal/workflows|/api/internal/projects/{key}/workflow', status: 'native', note: 'workflow editor + assignment' },
  { jira: '— TrackForge native —', ours: '/rest/api/2/issue/{key}/children', status: 'native', note: 'subtasks + epic children' },
  { jira: '— TrackForge native —', ours: '/api/internal/events|/api/internal/me/*', status: 'native', note: 'event feed + SSE stream, notifications, recents, your-work' },
  { jira: '— TrackForge native —', ours: '/api/internal/ai/*', status: 'native', note: 'provider config, copilot plan/execute, NL→JQL, issue intelligence, similarity' },
  { jira: '— TrackForge native —', ours: '/api/internal/proposals|/api/internal/proposals/{id}/approve', status: 'native', note: 'human-in-the-loop approvals for gated agent writes' },
  { jira: '— TrackForge native —', ours: '/api/internal/reports/board/{id}/velocity|/api/internal/reports/board/{id}/burndown', status: 'native', note: 'scrum reports from IssueSprint history + changelog' },
  { jira: '— TrackForge native —', ours: '/api/internal/customfields', status: 'native', note: 'CF CRUD, contexts/options, dry-run soft-delete (Jira CF admin is app-scoped)' },
  { jira: '— TrackForge native —', ours: 'dryRun, Idempotency-Key, X-TrackForge-Channel', status: 'native', note: 'agent-first extensions' },
  { jira: '— TrackForge native —', ours: 'POST /api/internal/agent/claim', status: 'native', note: '063 — atomic ready-work claim: delegate + agent session in one tx; FOR UPDATE SKIP LOCKED' },
  { jira: '— TrackForge native —', ours: 'JQL ready() / blocked() functions', status: 'native', note: '063 — key in ready() = unresolved, undelegated-adjacent work with no unresolved "blocks" link' },
  { jira: '— TrackForge native —', ours: 'GET /llms.txt', status: 'native', note: '063 — agent self-onboarding index (Linear-style)' },
  { jira: '— TrackForge native —', ours: 'MCP --readonly / ?toolset=readonly', status: 'native', note: '063 — read-only toolset: write tools absent at list and refused at call' },
  { jira: '— TrackForge native —', ours: '/api/internal/reports/{pie,two-dimensional,created-vs-resolved,workload,average-age,resolution-time,time-tracking,timesheet,version/{id},project/{key},org}', status: 'native', note: 'Sprint 028 reports on the 027 framework; CSV parity' },
  { jira: 'GET/PUT/POST/DELETE /rest/api/2/notificationscheme', ours: '/api/internal/notificationschemes', status: 'partial', note: '029 — Jira-shaped scheme matrix under TF admin path (Jira scheme API is app-scoped)' },
  { jira: 'GET /rest/api/2/filter/{id}?expand=subscriptions', ours: '/api/internal/filters/{id}/subscriptions', status: 'partial', note: 'Jira has no subscription write API — native manage + POST/DELETE; token unsubscribe at /unsubscribe' },
  { jira: '— TrackForge native —', ours: '/api/internal/admin/mail|/api/internal/admin/outbox|/api/internal/me/preferences', status: 'native', note: 'SMTP config/test, EmailOutbox log, per-user prefs (events/autowatch/digest)' },
];

async function main() {
  const spec = await tf.call<{ paths: Record<string, unknown> }>('GET', '/rest/api/2/openapi.json');
  const ours = new Set(Object.keys(spec.paths));

  let full = 0, partial = 0, missing = 0, native = 0;
  const rows = MATRIX.map((r) => {
    if (r.status === 'native') { native++; return { ...r, verified: true }; }
    if (!r.ours) { missing++; return { ...r, verified: false }; }
    // Verify each listed path (or its first listed member) exists in the spec.
    const present = r.ours.split('|').map((s) => s.trim()).every((p) =>
      [...ours].some((o) => o === p || o.startsWith(p.replace('*', ''))));
    if (!present) missing++;
    else if (r.status === 'partial') partial++;
    else full++;
    return { ...r, verified: present };
  });

  const md = [
    '# Jira REST compatibility',
    '',
    `Generated by \`apps/mcp/eval/compat.ts\` against live \`/rest/api/2/openapi.json\`.`,
    '',
    `**${full} full · ${partial} partial · ${missing} missing · ${native} TrackForge-native**`,
    '',
    '| Jira endpoint | TrackForge | Status | Notes |',
    '|---|---|---|---|',
    ...rows.map((r) =>
      `| \`${r.jira}\` | ${r.ours ? `\`${r.ours}\`` : '—'} | ${r.verified ? r.status : 'missing'} | ${r.note ?? ''} |`),
    '',
    'Legend: **full** = same request/response shape · **partial** = supported with documented limits · **missing** = planned (see roadmap) · **native** = TrackForge extension with no Jira equivalent.',
    '',
    'Jira, JQL, and Atlassian are trademarks of Atlassian Corporation Pty Ltd. TrackForge is an independent project; compatibility refers to the documented public REST API surface only.',
    '',
  ].join('\n');

  writeFileSync(new URL('../../../docs/compatibility.md', import.meta.url), md);
  console.log(`docs/compatibility.md written — ${full} full, ${partial} partial, ${missing} missing, ${native} native`);
}

main().catch((e) => { console.error(e); process.exit(1); });
