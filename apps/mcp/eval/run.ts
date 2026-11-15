/**
 * Scripted evaluation of the TrackForge agent API surface, run through the same
 * TrackForgeClient the MCP tools use. Deterministic — no LLM required.
 *
 *   TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_... pnpm --filter trackforge-mcp eval
 *
 * Exits non-zero if any task fails. Cleans up issues it creates (transitions to
 * Done) where the token allows.
 */
import { TrackForgeClient } from '../src/client.js';
import { MUTATION_REGISTRY } from '../src/toolContract.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const URL_ = process.env.TRACKFORGE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.TRACKFORGE_TOKEN;
const tf = new TrackForgeClient(URL_, TOKEN ?? 'no-token');

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

/**
 * 056 — server-free contract checks: tool registration hygiene (SC-002) and the
 * mutation-registry drift test (US6). Runs without TRACKFORGE_TOKEN.
 */
function sourceDriftChecks() {
  console.log('\ncontract drift (source scan)');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../src/tools.ts'), 'utf8');

  // SC-002: one name, one place.
  const toolNames = [...src.matchAll(/(?:server\.tool|wtool)\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const dupes = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
  check('zero duplicate tool names', dupes.length === 0, dupes.join(','));
  const resourcesBody = src.slice(src.indexOf('export function registerResources'), src.indexOf('export function registerSubscriptions'));
  check('registerResources holds resources only', !/server\.tool\(|wtool\(/.test(resourcesBody));

  // US6: every mutating tool is registered through wtool and declared in the registry.
  const wtoolBlocks = new Map<string, string>();
  for (const m of src.matchAll(/(?:if \(write\) )?wtool\(\s*'([a-z_]+)'([\s\S]*?)(?=\n {2}(?:if \(write\) )?(?:server\.tool|wtool|server\.resource)\(|\n})/g)) {
    wtoolBlocks.set(m[1], m[2]);
  }
  const gated = [...src.matchAll(/if \(write\) server\.tool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  check('zero write tools bypassing wtool', gated.length === 0, gated.join(','));
  const unregistered = [...wtoolBlocks.keys()].filter((n) => !(n in MUTATION_REGISTRY));
  check('every mutating tool is in MUTATION_REGISTRY', unregistered.length === 0, unregistered.join(','));
  const orphans = Object.keys(MUTATION_REGISTRY).filter((n) => !wtoolBlocks.has(n));
  check('zero orphan registry entries', orphans.length === 0, orphans.join(','));

  // Route conformance + dryRun parity per tool block.
  const normActual = (p: string) =>
    p
      .replace(/\$\{[^}]*\}/g, '{}')
      .replace(/\$\{.*$/, '')
      .split('?')[0]
      .replace(/([^/])\{\}$/, '$1')
      .replace(/'/g, '');
  const normDecl = (p: string) => p.replace(/\{[^}]*\}/g, '{}');
  const routeDrift: string[] = [];
  const dryFlags: string[] = [];
  for (const [name, body] of wtoolBlocks) {
    const decl = MUTATION_REGISTRY[name];
    if (!decl) continue;
    const locals: Record<string, string> = {};
    for (const lm of body.matchAll(/const (base\w*) = [`']([^`']+)[`']/g)) {
      locals[lm[1]] = lm[2].replace(/\$\{[^}]*\}/g, '{}');
    }
    for (const c of body.matchAll(/tf\.call(?:<[^>]*>)?\(\s*'(POST|PUT|DELETE|PATCH)',\s*[`']((?:\$\{[^}]*\}|[^`'])+)[`']/g)) {
      let p = c[2];
      for (const [v, val] of Object.entries(locals)) p = p.split('${' + v + '}').join(val);
      const path = normActual(p);
      const ok = decl.routes.some((r) => r.method === c[1] && normDecl(r.path) === path);
      if (!ok) routeDrift.push(`${name}: ${c[1]} ${path}`);
    }
    const schemaPart = body.split('async (')[0];
    const declaresDry = /dry_run|dryRun\s*:/.test(schemaPart);
    if (declaresDry && decl.dryRun === false) dryFlags.push(`${name} advertises dry_run but route can't honor it`);
    if (!declaresDry && decl.dryRun === 'query') dryFlags.push(`${name} lacks dry_run but route supports ?dryRun`);
  }
  check('zero route drift on mutation surface', routeDrift.length === 0, routeDrift.join(' | '));
  check('dry_run flags match route capabilities', dryFlags.length === 0, dryFlags.join(' | '));
}

/** Session login → cookie header (humans resolve proposals; tokens can't). */
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${URL_}/api/internal/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function sessionCall<T = Record<string, unknown>>(
  method: string, path: string, cookie: string, body?: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
interface Issue { key: string; fields?: Record<string, unknown> }
interface SearchRes { total: number; issues: Issue[] }

async function main() {
  sourceDriftChecks();
  if (!TOKEN) {
    console.error('\nTRACKFORGE_TOKEN (tfp_* PAT) is required for the REST suite — source checks above still counted.');
    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail ? 1 : 0);
  }
  const created: string[] = [];
  const run = `eval-${Date.now().toString(36)}`; // unique marker per run (search is paged)

  // 1. whoami → principal + scopes
  const me = await tf.call<{ user: { accountId: string; displayName?: string; emailAddress?: string }; scopes: string[] }>('GET', '/api/internal/auth/whoami');
  check('whoami returns principal', !!me.user?.accountId && Array.isArray(me.scopes));

  // 2. list projects — self-provision a sandbox on a fresh instance
  let projects = await tf.call<{ key: string }[]>('GET', '/rest/api/2/project');
  if (projects.length === 0) {
    await tf.call('POST', '/rest/api/2/project', { body: { key: 'EVAL', name: 'Eval Sandbox' } });
    projects = await tf.call<{ key: string }[]>('GET', '/rest/api/2/project');
  }
  check('list_projects non-empty', projects.length > 0);
  const pk = projects[0]!.key;

  // 3. get_project
  const proj = await tf.call<{ key: string }>('GET', `/rest/api/2/project/${pk}`);
  check('get_project returns key', proj.key === pk);

  // 4. createmeta → issue types
  const meta = await tf.call<{ issuetypes: { name: string }[] }>(
    'GET', `/rest/api/2/issue/createmeta/${pk}/issuetypes`);
  check('createmeta lists issue types', meta.issuetypes.length > 0);

  // 5. dry-run create → preview, no write
  const preview = await tf.call<{ preview?: { key?: string }; dryRun?: boolean }>(
    'POST', '/rest/api/2/issue',
    { dryRun: true, body: { fields: { project: { key: pk }, summary: 'eval dry-run' } } });
  check('dry_run create returns preview without writing', !preview?.preview?.key || !!preview.dryRun);

  // 6. real create
  const issue = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} issue`, priority: { name: 'High' } } } });
  check('create_issue returns key', /^[A-Z]+-\d+$/.test(issue.key));
  created.push(issue.key);

  // 7. get_issue with fields selection
  const got = await tf.call<Issue>('GET', `/rest/api/2/issue/${issue.key}`,
    { query: { fields: 'summary,priority' } });
  check('get_issue fields selection', got.fields?.priority !== undefined);

  // 8. search finds it (JQL-lite + paging)
  const res = await tf.call<SearchRes>('GET', '/rest/api/2/search',
    { query: { jql: `project = ${pk} AND summary ~ "${run}"`, maxResults: 10 } });
  check('search finds created issue', res.issues.some((i) => i.key === issue.key));

  // 8b. 068 — aggregate counts + groups the same JQL (copilot/MCP surface)
  const agg = await tf.call<{ total: number; buckets: { value: string; count: number }[] }>(
    'POST', '/api/internal/search/aggregate',
    { body: { jql: `project = ${pk} AND summary ~ "${run}"`, groupBy: 'status' } });
  check('search_aggregate counts + buckets', agg.total >= 1 && agg.buckets.length >= 1);

  // 9. dry-run update → diff preview
  const upd = await tf.call<unknown>('PUT', `/rest/api/2/issue/${issue.key}`,
    { dryRun: true, body: { fields: { summary: 'eval issue updated' } } });
  check('dry_run update returns preview', upd !== undefined);

  // 10. transition via status name resolution (transitions list)
  const trans = await tf.call<{ transitions: { name: string }[] }>(
    'GET', `/rest/api/2/issue/${issue.key}/transitions`);
  check('get_transitions lists options', trans.transitions.length > 0);

  // 11. assign to self
  await tf.call('PUT', `/rest/api/2/issue/${issue.key}/assignee`, { body: { accountId: me.user.accountId } });
  const assigned = await tf.call<Issue & { fields: { assignee?: { accountId: string } } }>(
    'GET', `/rest/api/2/issue/${issue.key}`, { query: { fields: 'assignee' } });
  check('assign_issue to self', assigned.fields.assignee?.accountId === me.user.accountId);

  // 12. find_users resolves the user — user search requires a ≥2-char query
  // (064 US6 anti-enumeration), so look up the token's own principal.
  const uname =
    [me.user.displayName, me.user.emailAddress]
      .flatMap((v) => (v ?? '').split(/[\s@.]+/))
      .find((w) => w.length >= 2) ?? 'trackforge';
  const users = await tf.call<{ accountId: string }[]>('GET', '/rest/api/2/user/search',
    { query: { query: uname, project: pk } });
  check('find_users returns users', users.length > 0);

  // 13. bulk create + per-item errors — dryRun first previews, writes nothing (052)
  const bulkDry = await tf.call<{ dryRun?: boolean; issues?: unknown[]; errors?: unknown[] }>(
    'POST', '/rest/api/2/issue/bulk', {
      dryRun: true,
      body: {
        issueUpdates: [
          { fields: { project: { key: pk }, summary: 'eval dry bulk 1' } },
          { fields: { project: { key: pk }, summary: 'eval dry bulk 2' } },
          { fields: { project: { key: 'NOPE' }, summary: 'eval dry bulk bad' } },
        ],
      },
    });
  check('bulk dry_run previews per-item without writing',
    bulkDry.dryRun === true && bulkDry.issues?.length === 2 && bulkDry.errors?.length === 1);

  const bulk = await tf.call<{ issues: Issue[]; errors: unknown[] }>('POST', '/rest/api/2/issue/bulk', {
    body: {
      issueUpdates: [
        { fields: { project: { key: pk }, summary: 'eval bulk 1' } },
        { fields: { project: { key: pk }, summary: 'eval bulk 2' } },
        { fields: { project: { key: 'NOPE' }, summary: 'eval bulk bad' } },
      ],
    },
  });
  check('bulk_create partial success', bulk.issues.length === 2 && bulk.errors.length === 1);
  bulk.issues.forEach((i) => created.push(i.key));

  // 14. idempotency replay → same key
  const idem = { fields: { project: { key: pk }, summary: 'eval idem' } };
  const k1 = await tf.call<Issue>('POST', '/rest/api/2/issue', { body: idem, idempotencyKey: 'eval-idem-1' });
  const k2 = await tf.call<Issue>('POST', '/rest/api/2/issue', { body: idem, idempotencyKey: 'eval-idem-1' });
  check('idempotent replay returns same issue', k1.key === k2.key);
  created.push(k1.key);

  // --- Sprint 008: collaboration surface ---

  // 15. labels via update ops (add + remove)
  await tf.call('PUT', `/rest/api/2/issue/${issue.key}`, {
    body: { update: { labels: [{ add: 'eval-a' }, { add: 'eval-b' }, { remove: 'eval-a' }] } },
  });
  const labelled = await tf.call<Issue & { fields: { labels?: string[] } }>(
    'GET', `/rest/api/2/issue/${issue.key}`, { query: { fields: 'labels' } });
  check('update ops add/remove labels', labelled.fields.labels?.includes('eval-b') && !labelled.fields.labels.includes('eval-a'));

  // 16. due date + resolution fields set
  await tf.call('PUT', `/rest/api/2/issue/${issue.key}`, {
    body: { fields: { duedate: '2030-01-15', resolution: { name: 'Done' } } },
  });
  const dated = await tf.call<Issue & { fields: { duedate?: string; resolution?: { name: string }; resolutiondate?: string } }>(
    'GET', `/rest/api/2/issue/${issue.key}`, { query: { fields: 'duedate,resolution,resolutiondate' } });
  check('due date + resolution set', dated.fields.duedate === '2030-01-15' && dated.fields.resolution?.name === 'Done' && !!dated.fields.resolutiondate);

  // 17. comments: add → list → edit — dryRun previews the would-be comment first (052)
  const commentDry = await tf.call<{ dryRun?: boolean; comment?: { body?: string } }>(
    'POST', `/rest/api/2/issue/${issue.key}/comment`,
    { dryRun: true, body: { body: 'eval dry comment' } });
  check('comment dry_run previews body, writes nothing',
    commentDry.dryRun === true && commentDry.comment?.body === 'eval dry comment');

  const comment = await tf.call<{ id: string }>('POST', `/rest/api/2/issue/${issue.key}/comment`,
    { body: { body: 'eval comment **md**' } });
  check('add_comment returns id', !!comment.id);
  const comments = await tf.call<{ comments: { id: string; body: string }[]; total: number }>(
    'GET', `/rest/api/2/issue/${issue.key}/comment`);
  check('list_comments contains new comment', comments.comments.some((c) => c.id === comment.id));
  await tf.call('PUT', `/rest/api/2/issue/${issue.key}/comment/${comment.id}`, { body: { body: 'eval edited' } });
  const afterEdit = await tf.call<{ comments: { id: string; body: string }[] }>(
    'GET', `/rest/api/2/issue/${issue.key}/comment`);
  check('edit_comment persists', afterEdit.comments.find((c) => c.id === comment.id)?.body === 'eval edited');

  // 17b. worklogs: set estimate → log → list → timetracking → JQL (sprint 024)
  await tf.call('PUT', `/rest/api/2/issue/${issue.key}`, {
    body: { fields: { timetracking: { originalEstimate: '2d', remainingEstimate: '2d' } } },
  });
  const wl = await tf.call<{ id: string; timeSpentSeconds: number }>(
    'POST', `/rest/api/2/issue/${issue.key}/worklog`,
    { body: { timeSpent: '2h', comment: 'eval work', billable: true } });
  check('log_work returns seconds', wl.timeSpentSeconds === 7200);
  const wls = await tf.call<{ worklogs: { id: string; billable?: boolean }[]; total: number }>(
    'GET', `/rest/api/2/issue/${issue.key}/worklog`);
  check('list_worklogs contains entry', wls.worklogs.some((w) => w.id === wl.id && w.billable === true));
  const ttIssue = await tf.call<Issue & { fields: { timetracking?: { remainingEstimateSeconds?: number }; workratio?: number } }>(
    'GET', `/rest/api/2/issue/${issue.key}`, { query: { fields: 'timetracking,workratio' } });
  check(
    'timetracking auto-adjusts remaining (2d−2h)',
    ttIssue.fields.timetracking?.remainingEstimateSeconds === 50400 &&
      ttIssue.fields.workratio === 13
  );
  const wlJql = await tf.call<{ issues: { key: string }[] }>(
    'GET', '/rest/api/2/search', { query: { jql: `key = ${issue.key} AND timeSpent >= "1h" AND billable = true` } });
  check('JQL timeSpent+billable finds issue', wlJql.issues.length === 1);

  // 18. subtask + children
  const sub = await tf.call<Issue>('POST', '/rest/api/2/issue', {
    body: { fields: { project: { key: pk }, summary: 'eval subtask', issuetype: { name: 'Subtask' }, parent: { key: issue.key } } },
  });
  check('create_subtask returns key', /^[A-Z]+-\d+$/.test(sub.key));
  const children = await tf.call<{ issues: Issue[] }>('GET', `/rest/api/2/issue/${issue.key}/children`);
  check('get_children lists subtask', children.issues.some((i) => i.key === sub.key));

  // 19. link types + link
  const linkTypes = await tf.call<{ issueLinkTypes: { name: string }[] }>('GET', '/rest/api/2/issueLinkType');
  check('list_link_types seeded', linkTypes.issueLinkTypes.length >= 4);
  const [other] = bulk.issues;
  const linkDry = await tf.call<{ dryRun?: boolean; link?: { type?: { name?: string } } }>(
    'POST', '/rest/api/2/issueLink', {
      dryRun: true,
      body: { type: { name: 'Relates' }, outwardIssue: { key: issue.key }, inwardIssue: { key: other!.key } },
    });
  check('link dry_run previews the link, writes nothing',
    linkDry.dryRun === true && linkDry.link?.type?.name === 'Relates');
  await tf.call('POST', '/rest/api/2/issueLink', {
    body: { type: { name: 'Relates' }, outwardIssue: { key: issue.key }, inwardIssue: { key: other!.key } },
  });
  const linked = await tf.call<Issue & { fields: { issuelinks?: unknown[] } }>(
    'GET', `/rest/api/2/issue/${issue.key}`, { query: { fields: 'issuelinks' } });
  check('link_issues shows in issuelinks', (linked.fields.issuelinks?.length ?? 0) > 0);

  // --- Sprint 009: workflow engine & boards ---

  // 20. workflow transitions expose required screen fields (SC-003 path)
  const wfTrans = await tf.call<{
    transitions: { id: string; name: string; hasScreen?: boolean; fields?: Record<string, unknown>; to: { name: string } }[];
  }>('GET', `/rest/api/2/issue/${bulk.issues[0]!.key}/transitions`);
  check(
    'transitions have stable ids + names',
    wfTrans.transitions.every((t) => !!t.id && !!t.name && !!t.to?.name)
  );
  const start = wfTrans.transitions.find((t) => t.to.name === 'In Progress');
  check('Start Progress offered from To Do', !!start);
  await tf.call('POST', `/rest/api/2/issue/${bulk.issues[0]!.key}/transitions`,
    { body: { transition: { id: start!.id } } });
  const after = await tf.call<{ transitions: { name: string; hasScreen?: boolean; fields?: Record<string, unknown> }[] }>(
    'GET', `/rest/api/2/issue/${bulk.issues[0]!.key}/transitions`);
  const doneT = after.transitions.find((t) => t.name === 'Done');
  check('Done transition declares resolution screen field',
    !!doneT?.hasScreen && !!doneT.fields && 'resolution' in (doneT.fields as object));

  // 21. validator rejects screen-less Done; fields+comment succeed
  const rejected = await tf.call<{ errors?: Record<string, string> }>(
    'POST', `/rest/api/2/issue/${bulk.issues[0]!.key}/transitions`,
    { body: { transition: { id: doneT!.id } } }).then(() => null).catch((e) => e);
  check('resolutionRequired validator rejects', rejected === null ? false : true);
  await tf.call('POST', `/rest/api/2/issue/${bulk.issues[0]!.key}/transitions`, {
    body: {
      transition: { id: doneT!.id },
      fields: { resolution: { name: 'Done' } },
      update: { comment: [{ add: { body: 'eval close' } }] },
    },
  });
  const closed = await tf.call<Issue & { fields: { status: { name: string }; resolution?: { name: string } } }>(
    'GET', `/rest/api/2/issue/${bulk.issues[0]!.key}`);
  check('transition with screen fields lands', closed.fields.status.name === 'Done' && closed.fields.resolution?.name === 'Done');

  // 22. PUT fields.status is rejected (Jira semantics)
  const putStatus = await tf.call('PUT', `/rest/api/2/issue/${bulk.issues[1]!.key}`,
    { body: { fields: { status: { name: 'To Do' } } } }).then(() => 'ok').catch(() => 'err');
  check('PUT fields.status rejected', putStatus === 'err');

  // 23. workflow + board surfaces
  const wf = await tf.call<{ name: string; transitions: unknown[] }>('GET', '/api/internal/workflows/Simple');
  check('get_workflow returns Simple', wf.name === 'Simple' && wf.transitions.length > 0);
  const boardCfg = await tf.call<{ columnConfig: { columns: { name: string }[] } }>(
    'GET', `/rest/agile/1.0/board/${pk}/configuration`);
  check('get_board config columns', boardCfg.columnConfig.columns.length >= 3);

  // 24. rank issue before another (board-type independent — scrum boards
  // scope /board/{id}/issue to the active sprint, so verify via JQL rank).
  const rankDry = await tf.call<{ dryRun?: boolean; rank?: { issues?: string[] } }>(
    'PUT', '/rest/agile/1.0/issue/rank', {
      dryRun: true,
      body: { issues: [bulk.issues[1]!.key], rankBeforeIssue: bulk.issues[0]!.key },
    });
  check('rank dry_run previews the reorder, writes nothing',
    rankDry.dryRun === true && rankDry.rank?.issues?.includes(bulk.issues[1]!.key) === true);
  await tf.call('PUT', '/rest/agile/1.0/issue/rank', {
    body: { issues: [bulk.issues[1]!.key], rankBeforeIssue: bulk.issues[0]!.key },
  });
  const ranked = await tf.call<{ issues: { key: string }[] }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`key in (${bulk.issues[0]!.key}, ${bulk.issues[1]!.key}) ORDER BY Rank ASC`)}&maxResults=5`);
  check('rank_issue persists order', ranked.issues[0]?.key === bulk.issues[1]!.key);

  // 25. delete: two-step confirmToken flow (cleanup for the eval-created parent)
  const delPreview = await tf.call<{ confirmToken?: string; deletesSubtasks?: string[] }>(
    'DELETE', `/rest/api/2/issue/${issue.key}`, { query: { deleteSubtasks: 'true', dryRun: 'true' } });
  check('delete dry-run returns confirmToken', !!delPreview.confirmToken && (delPreview.deletesSubtasks?.length ?? 0) >= 1);
  await tf.call('DELETE', `/rest/api/2/issue/${issue.key}`, {
    query: { deleteSubtasks: 'true', confirmToken: delPreview.confirmToken! },
  });
  const gone = await tf.call<Issue>('GET', `/rest/api/2/issue/${issue.key}`).then(() => false).catch(() => true);
  check('delete with token removes issue', gone);

  // 26. Sprint 010: real JQL — parse endpoint + cross-project search
  // (a fresh probe issue carries the run marker — earlier ones were deleted above)
  const probe = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} jqlprobe` } } });
  created.push(probe.key);
  const parse = await tf.call<{ queries: { structure?: { where?: { type?: string } }; errors: string[] }[] }>(
    'POST', '/rest/api/2/jql/parse', { body: { queries: [`summary ~ "${run}"`] } });
  check('validate_jql parses', parse.queries[0]?.errors?.length === 0 && !!parse.queries[0]?.structure);
  const badParse = await tf.call<{ queries: { errors: string[] }[] }>(
    'POST', '/rest/api/2/jql/parse', { body: { queries: ['not a field = x && broken'] } });
  check('validate_jql reports errors', (badParse.queries[0]?.errors?.length ?? 0) > 0);

  const jqlRes = await tf.call<{ total: number; issues: { key: string }[] }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`summary ~ "${run}" AND issuetype = Task`)}&maxResults=50`);
  check('cross-project JQL (no project clause)', jqlRes.total >= 1 && jqlRes.issues.length >= 1);
  const fnRes = await tf.call<{ total: number }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent('assignee = currentUser() AND created >= -1d')}&maxResults=5`);
  check('JQL functions (currentUser, -1d)', fnRes.total >= 0);
  const orderRes = await tf.call<{ issues: { key: string }[] }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`summary ~ "${run}" ORDER BY created DESC, key ASC`)}&maxResults=50`);
  const ordered = [...orderRes.issues].map((i) => i.key);
  check('multi-field ORDER BY', orderRes.issues.every((v, i) => v.key === ordered[i]));

  // 27. autocomplete endpoint
  const ac = await tf.call<{ results: { value: string }[] }>(
    'GET', '/rest/api/2/jql/autocompletedata/suggestions?fieldName=status&fieldValue=Done');
  check('autocomplete suggestions', ac.results.some((r) => r.value === 'Done'));

  // 28. saved filter lifecycle: create → run → favourite → delete
  const filter = await tf.call<{ id: string; jql: string }>(
    'POST', '/rest/api/2/filter', {
      body: { name: `eval-${run}`, jql: `summary ~ "${run}" ORDER BY created DESC`, sharePermissions: [{ type: 'global' }] },
    });
  check('save_filter creates', /^[0-9a-f-]{36}$/.test(filter.id));
  const filterRun = await tf.call<{ total: number }>(
    'GET', `/rest/api/2/filter/${filter.id}/run?maxResults=50`);
  check('run_filter executes', filterRun.total >= 1);
  await tf.call('PUT', `/rest/api/2/filter/${filter.id}/favourite`);
  const favs = await tf.call<{ id: string }[]>('GET', '/rest/api/2/filter/favourite');
  check('favourite marks filter', favs.some((f) => f.id === filter.id));
  await tf.call('DELETE', `/rest/api/2/filter/${filter.id}`);
  const gone2 = await tf.call('GET', `/rest/api/2/filter/${filter.id}`).then(() => false).catch(() => true);
  check('delete_filter removes', gone2);

  // --- Sprint 011: events, watchers, webhooks, your work ---

  // 29. event feed — cursor paging over the outbox
  const feed = await tf.call<{ events: { id: number; type: string; issueKey?: string }[]; nextCursor: number; hasMore: boolean }>(
    'GET', '/api/internal/events?types=jira:issue_created&limit=50');
  check('get_events returns feed', Array.isArray(feed.events) && typeof feed.nextCursor === 'number');
  const created1 = await tf.call<{ events: { id: number; type: string; issueKey?: string }[]; nextCursor: number }>(
    'GET', `/api/internal/events?after=${feed.nextCursor}&limit=50`);
  await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} feed` } } });
  const created2 = await tf.call<{ events: { id: number; type: string; issueKey?: string }[] }>(
    'GET', `/api/internal/events?after=${created1.nextCursor}&limit=50`);
  check('get_events resumes after cursor', created2.events.some((e) => e.type === 'jira:issue_created'));

  // 30. watchers — watch/unwatch/self — dryRun must not change watchCount (052;
  // probe's creator auto-watches, so compare counts not isWatching).
  const beforeWatch = await tf.call<{ isWatching: boolean; watchCount: number }>(
    'GET', `/rest/api/2/issue/${probe.key}/watchers`);
  await tf.call('POST', `/rest/api/2/issue/${probe.key}/watchers`, { dryRun: true });
  const stillDry = await tf.call<{ watchCount: number }>(
    'GET', `/rest/api/2/issue/${probe.key}/watchers`);
  check('watch dry_run writes nothing', stillDry.watchCount === beforeWatch.watchCount);
  await tf.call('POST', `/rest/api/2/issue/${probe.key}/watchers`);
  const watchers = await tf.call<{ isWatching: boolean; watchCount: number }>(
    'GET', `/rest/api/2/issue/${probe.key}/watchers`);
  check('watch_issue marks watching', watchers.isWatching === true);
  await tf.call('DELETE', `/rest/api/2/issue/${probe.key}/watchers`);
  const unwatch = await tf.call<{ isWatching: boolean }>(
    'GET', `/rest/api/2/issue/${probe.key}/watchers`);
  check('unwatch_issue clears watching', unwatch.isWatching === false);

  // 31. webhooks — register, list, delete (admin scope)
  const wh = await tf.call<{ id: string; events: string[] }>(
    'POST', '/rest/webhooks/1.0/webhook', {
      body: { name: `eval-${run}`, url: 'https://example.com/tf-hook', events: ['jira:issue_updated'], secret: 'evsec' },
    }).catch(() => null);
  check('register_webhook creates', !!wh?.id);
  if (wh?.id) {
    const hooks = await tf.call<{ webhookCallbackResponse: { id: string }[] }>(
      'GET', '/rest/webhooks/1.0/webhook');
    check('list_webhooks contains new', hooks.webhookCallbackResponse.some((w) => w.id === wh.id));
    await tf.call('DELETE', `/rest/webhooks/1.0/webhook/${wh.id}`);
  }
  const ssrf = await tf.call('POST', '/rest/webhooks/1.0/webhook', {
    body: { name: 'ssrf', url: 'http://169.254.169.254/latest/meta-data', events: ['jira:issue_updated'] },
  }).then(() => 'allowed').catch(() => 'blocked');
  check('webhook SSRF blocks link-local', ssrf === 'blocked');

  // 32. get_my_work — assigned/watching/reported/recent
  const work = await tf.call<{ assigned: unknown[]; watching: unknown[]; reported: unknown[]; recent: unknown[] }>(
    'GET', '/api/internal/me/work');
  check('get_my_work returns sections',
    Array.isArray(work.assigned) && Array.isArray(work.watching) && Array.isArray(work.reported));

  // 33. Proposals / human-in-the-loop (012) — gated token → proposal → session approve.
  // Create an eval user, mint a requireApproval token as that user, then walk
  // the full lifecycle: park → read own → denied self-approve → session approve.
  const gateIssue = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} gate target` } } });
  created.push(gateIssue.key);
  const evalEmail = `${run}@eval.local`;
  const newUser = await tf.call<{ accountId: string }>('POST', '/api/internal/users', {
    body: { email: evalEmail, displayName: `Eval Agent ${run}`, password: 'eval-pass-012', type: 'human' },
  }).catch(() => null);
  check('create eval user', !!newUser?.accountId);
  if (newUser?.accountId) {
    const cookie = await login(evalEmail, 'eval-pass-012');
    const tok = await sessionCall<{ secret: string }>('POST', '/api/internal/tokens', cookie, {
      name: `gated-${run}`, scopes: ['read', 'write'], requireApproval: true,
    });
    check('mint gated token', tok.status === 201 && tok.body.secret?.startsWith('tfp_') === true);
    if (tok.body.secret) {
      const gated = new TrackForgeClient(URL_, tok.body.secret);
      const parked = await gated.call<{ pendingApproval?: boolean; proposalId?: string }>(
        'PUT', `/rest/api/2/issue/${gateIssue.key}`,
        { rationale: 'eval: gated write for approval flow', body: { fields: { summary: `${run} gated rename` } } });
      check('gated write parks as proposal (202)', parked.pendingApproval === true && !!parked.proposalId);
      const issueAfter = await tf.call<Issue>('GET', `/rest/api/2/issue/${gateIssue.key}`);
      check('parked write did not apply', (issueAfter.fields as { summary?: string })?.summary !== `${run} gated rename`);
      if (parked.proposalId) {
        const own = await gated.call<{ id: string; status: string; rationale?: string }>(
          'GET', `/api/internal/proposals/${parked.proposalId}`);
        check('proposing token reads own proposal', own.id === parked.proposalId && own.status === 'pending');
        check('rationale stored on proposal', own.rationale === 'eval: gated write for approval flow');
        const mine = await gated.call<{ proposals: { id: string }[] }>(
          'GET', '/api/internal/proposals?status=pending');
        check('list_my_proposals contains it', mine.proposals.some((p) => p.id === parked.proposalId));
        const selfApprove = await gated.call('POST', `/api/internal/proposals/${parked.proposalId}/approve`)
          .then(() => 'allowed').catch((e) => (e as { status?: number }).status === 403 ? 'denied' : 'other');
        check('token cannot self-approve', selfApprove === 'denied');
        // 065 B2 — review requires a distinct human with ADMINISTER_PROJECTS
        // or site admin; the proposing user's own session is denied by design.
        const reviewerEmail = `${run}-reviewer@eval.local`;
        const reviewer = await tf.call<{ accountId: string }>('POST', '/api/internal/users', {
          body: { email: reviewerEmail, displayName: `Eval Reviewer ${run}`, password: 'eval-pass-012', isAdmin: true },
        }).catch(() => null);
        check('create reviewer admin', !!reviewer?.accountId);
        const reviewerCookie = reviewer?.accountId ? await login(reviewerEmail, 'eval-pass-012') : '';
        const approved = await sessionCall<{ status: string }>(
          'POST', `/api/internal/proposals/${parked.proposalId}/approve`, reviewerCookie);
        check('session approves proposal', approved.status === 200 && approved.body.status === 'approved');
        const applied = await tf.call<Issue>('GET', `/rest/api/2/issue/${gateIssue.key}`);
        check('approved write applied', (applied.fields as { summary?: string })?.summary === `${run} gated rename`);
        const resolved = await gated.call<{ status: string; resolvedBy?: { displayName?: string } }>(
          'GET', `/api/internal/proposals/${parked.proposalId}`);
        check('proposal resolved + attributed', resolved.status === 'approved' && !!resolved.resolvedBy);
      }
    }
  }

  // 35. Sprint 013: scrum lifecycle — sprint → estimate → start → complete → reports.
  // Uses pk's board (flipped scrum by the 013 migration or created kanban —
  // set explicitly to scrum for this section).
  const board = await tf.call<{ id: string; type: string }>('GET', `/rest/agile/1.0/board/${pk}`);
  if (board.type !== 'scrum') {
    await tf.call('PUT', `/rest/agile/1.0/board/${board.id}/type`, { body: { type: 'scrum' } });
  }
  const backlog = await tf.call<{ issues: Issue[] }>('GET', `/rest/agile/1.0/board/${board.id}/backlog`);
  check('get_backlog returns rank-ordered list', Array.isArray(backlog.issues));

  const sprint = await tf.call<{ id: string; name: string; state: string; sequence: number }>(
    'POST', '/rest/agile/1.0/sprint', { body: { originBoardId: board.id, goal: `${run} goal` } });
  check('create_sprint auto-names + sequences', /^[A-Z]+ Sprint \d+$/.test(sprint.name) && sprint.state === 'future' && sprint.sequence > 0);

  const spIssue = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} sprint item`, story_points: 5 } } });
  created.push(spIssue.key);
  await tf.call('POST', `/rest/agile/1.0/sprint/${sprint.id}/issue`, { body: { issues: [spIssue.key] } });
  const inSprint = await tf.call<{ issues: Issue[] }>('GET', `/rest/agile/1.0/sprint/${sprint.id}/issue`);
  check('move_to_sprint lands', inSprint.issues.some((i) => i.key === spIssue.key));

  const estimated = await tf.call<Issue & { fields: { story_points?: number } }>(
    'GET', `/rest/api/2/issue/${spIssue.key}`, { query: { fields: 'story_points' } });
  check('estimate_issue via story_points field', estimated.fields.story_points === 5);

  const spjql = await tf.call<{ total: number }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`storypoints >= 5 AND summary ~ "${run}"`)}&maxResults=10`);
  check('JQL story-points comparison', spjql.total >= 1);

  const started = await tf.call<{ state: string; startDate?: string }>(
    'PUT', `/rest/agile/1.0/sprint/${sprint.id}`, { body: { state: 'active', goal: `${run} goal` } });
  check('start_sprint sets active + startDate', started.state === 'active' && !!started.startDate);

  const openSprints = await tf.call<{ issues: Issue[] }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`sprint in openSprints() AND summary ~ "${run}"`)}&maxResults=10`);
  check('JQL openSprints() finds member', openSprints.issues.some((i) => i.key === spIssue.key));

  const secondActive = await tf.call<{ id: string }>('POST', '/rest/agile/1.0/sprint',
    { body: { originBoardId: board.id } });
  const dupActive = await tf.call('PUT', `/rest/agile/1.0/sprint/${secondActive.id}`,
    { body: { state: 'active' } }).then(() => 'allowed').catch(() => 'rejected');
  check('one active sprint per board', dupActive === 'rejected');
  await tf.call('DELETE', `/rest/agile/1.0/sprint/${secondActive.id}`);

  const done = await tf.call<{ state: string; completeDate?: string }>(
    'PUT', `/rest/agile/1.0/sprint/${sprint.id}`, { body: { state: 'closed', moveOpenIssuesTo: 'backlog' } });
  check('complete_sprint closes + stamps completeDate', done.state === 'closed' && !!done.completeDate);
  const afterClose = await tf.call<Issue & { fields: { sprint?: { id: string } } }>(
    'GET', `/rest/api/2/issue/${spIssue.key}`, { query: { fields: 'sprint' } });
  check('open issue carried to backlog', !afterClose.fields.sprint || afterClose.fields.sprint.id !== sprint.id);
  const closedSprintsJql = await tf.call<{ issues: Issue[] }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`sprint in closedSprints() AND key = ${spIssue.key}`)}&maxResults=5`);
  check('JQL closedSprints() keeps history', closedSprintsJql.issues.some((i) => i.key === spIssue.key));

  const report = await tf.call<{ issues: { key: string; points: number; addedAfterStart: boolean }[] }>(
    'GET', `/api/internal/reports/board/${board.id}/sprint/${sprint.id}/report`);
  check('get_sprint_report includes member', report.issues.some((i) => i.key === spIssue.key && i.points === 5));
  const velocity = await tf.call<{ sprints: { sprint: { id: string }; committedPoints: number }[] }>(
    'GET', `/api/internal/reports/board/${board.id}/velocity`);
  check('get_velocity includes closed sprint', velocity.sprints.some((s) => s.sprint.id === sprint.id));

  const future = await tf.call<{ id: string }>('POST', '/rest/agile/1.0/sprint', { body: { originBoardId: board.id } });
  await tf.call('DELETE', `/rest/agile/1.0/sprint/${future.id}`);
  const delGone = await tf.call('GET', `/rest/agile/1.0/sprint/${future.id}`).then(() => false).catch(() => true);
  check('delete future sprint', delGone);

  // 36. Epic endpoints — create epic, move issue in, list, remove.
  const epic = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} epic`, issuetype: { name: 'Epic' } } } });
  created.push(epic.key);
  const epicGet = await tf.call<{ key: string; name: string; done: boolean }>(
    'GET', `/rest/agile/1.0/epic/${epic.key}`);
  check('epic GET returns epic', epicGet.key === epic.key && epicGet.done === false);
  await tf.call('POST', `/rest/agile/1.0/epic/${epic.key}/issue`, { body: { issues: [probe.key] } });
  const epicIssues = await tf.call<{ issues: Issue[] }>('GET', `/rest/agile/1.0/epic/${epic.key}/issue`);
  check('epic issue list contains child', epicIssues.issues.some((i) => i.key === probe.key));
  await tf.call('POST', '/rest/agile/1.0/epic/none/issue', { body: { issues: [probe.key] } });
  const epicAfter = await tf.call<{ issues: Issue[] }>('GET', `/rest/agile/1.0/epic/${epic.key}/issue`);
  check('epic/none removes child', !epicAfter.issues.some((i) => i.key === probe.key));

  // 37. Custom fields — define → scope → set → JQL round-trip (Sprint 014).
  const cfList = await tf.call<{ fields: { id: string; name: string; systemManaged: boolean }[] }>(
    'GET', '/api/internal/customfields');
  check('list_custom_fields returns system fields',
    cfList.fields.some((f) => f.alias === 'story_points' && f.systemManaged));

  const cfField = await tf.call<{ id: string; contexts: { id: string }[] }>(
    'POST', '/api/internal/customfields', {
      body: {
        name: `${run} Risk Level`, type: 'select',
        context: { projectKeys: [pk], options: ['Low', 'High', 'Critical'] },
      },
    });
  check('manage_custom_field create → sequential id', /^customfield_\d{5}$/.test(cfField.id));

  const cfIssue = await tf.call<Issue>('POST', '/rest/api/2/issue', {
    body: { fields: { project: { key: pk }, summary: `${run} risk item`, [cfField.id]: { value: 'High' } } } });
  created.push(cfIssue.key);
  const cfRead = await tf.call<Issue & { fields: Record<string, unknown> }>(
    'GET', `/rest/api/2/issue/${cfIssue.key}`, { query: { fields: cfField.id } });
  check('CF value round-trips Jira-shaped',
    (cfRead.fields[cfField.id] as { value?: string })?.value === 'High');

  const badOpt = await tf.call('PUT', `/rest/api/2/issue/${cfIssue.key}`, {
    body: { fields: { [cfField.id]: { value: 'Bogus' } } },
  }).then(() => 'allowed').catch((e) => ((e as { errorMessages?: string[] }).errorMessages?.join(' ').includes('High') ? 'allowed-list' : 'other'));
  check('invalid option rejected with allowed values', badOpt === 'allowed-list', badOpt);

  const cfJql = await tf.call<{ issues: Issue[] }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`cf[${cfField.id.split('_')[1]}] = "High" AND summary ~ "${run}"`)}&maxResults=10`);
  check('JQL cf[N] option match', cfJql.issues.some((i) => i.key === cfIssue.key));
  const cfName = await tf.call<{ total: number }>(
    'GET', `/rest/api/2/search?jql=${encodeURIComponent(`"${run} Risk Level" is not EMPTY`)}&maxResults=10`);
  check('JQL quoted CF name IS NOT EMPTY', cfName.total >= 1);

  const editmeta = await tf.call<{ fields: Record<string, { allowedValues?: { value: string }[] }> }>(
    'GET', `/rest/api/2/issue/${cfIssue.key}/editmeta`);
  check('editmeta carries context allowedValues',
    (editmeta.fields[cfField.id]?.allowedValues?.length ?? 0) === 3);

  const fieldApi = await tf.call<{ id: string; custom?: boolean; clauseNames?: string[] }[]>(
    'GET', '/rest/api/2/field');
  const cfEntry = fieldApi.find((f) => f.id === cfField.id);
  check('/field lists CF with clauseNames', Boolean(cfEntry?.custom && cfEntry.clauseNames?.length));

  const dryPreview = await tf.call<{ affectedIssues?: number }>(
    'DELETE', `/api/internal/customfields/${cfField.id}`, { dryRun: true });
  check('delete dryRun previews affected issues', (dryPreview?.affectedIssues ?? 0) >= 1);
  await tf.call('DELETE', `/api/internal/customfields/${cfField.id}`);
  const afterDelete = await tf.call<{ fields: { id: string }[] }>(
    'GET', '/api/internal/customfields');
  check('soft-delete hides field', !afterDelete.fields.some((f) => f.id === cfField.id));

  // 34. AI endpoints — off-by-default 404, or a real reply when configured.
  const aiProbe = await tf.call<{ jql?: string }>('POST', '/api/internal/ai/jql',
    { body: { text: 'open issues' } })
    .then((r) => (typeof r.jql === 'string' ? 'configured' : 'odd'))
    .catch((e) => ((e as { status?: number }).status === 404 ? 'off' : 'error'));
  check('AI endpoint behaves (404 off-by-default or configured)', aiProbe === 'off' || aiProbe === 'configured', aiProbe);

  // 34b. suggest_resolution (067) — shaped reply when configured; 404 off /
  // 400 gated (AI on but no embedding model) are the honest contracts.
  const srProbe = await tf.call<Record<string, unknown>>(
    'POST', `/api/internal/ai/issues/${issue.key}/suggest-resolution`)
    .then((r) => (r !== null && 'resolution' in r && 'basedOn' in r && 'reason' in r ? 'shaped' : 'odd'))
    .catch((e) => { const s = (e as { status?: number }).status; return s === 404 || s === 400 ? `gated-${s}` : `err-${s}`; });
  check('suggest_resolution returns shaped reply or honest gate',
    srProbe === 'shaped' || srProbe === 'gated-404' || srProbe === 'gated-400', String(srProbe));

  // 35. jira-server import (048) — deterministic negatives: validation runs
  // before any network; a real Server e2e is out of scope for the harness.
  const expect400 = async (name: string, p: Promise<unknown>) =>
    p.then(() => check(name, false, 'expected 400, got success'))
      .catch((e) => check(name, (e as { status?: number }).status === 400, String((e as { status?: number }).status)));
  await expect400('jira-server basic without username → 400',
    tf.call('POST', '/api/internal/migration/jira-server', { body: { baseUrl: 'https://jira.example.com', authMode: 'basic', apiToken: 't', projectKeys: [pk] } }));
  await expect400('jira-server private baseUrl without allowPrivate → 400',
    tf.call('POST', '/api/internal/migration/jira-server', { body: { baseUrl: 'http://192.168.0.1', authMode: 'pat', apiToken: 't', projectKeys: [pk] } }));
  await expect400('jira-server without token|secretRef → 400',
    tf.call('POST', '/api/internal/migration/jira-server', { body: { baseUrl: 'https://jira.example.com', authMode: 'pat', projectKeys: [pk] } }));

  // 36. Sprint 050 SC-004 — docs-as-product: doc-answerable questions resolve
  // to shipped docs via the same endpoints search_docs/get_doc call.
  const docSearch = (q: string) =>
    tf.call<{ results: { slug: string; excerpt: string }[] }>(
      'GET', `/api/internal/docs/search?q=${encodeURIComponent(q)}`);
  const patQ = await docSearch('API token scopes');
  check('search_docs: "API token scopes" → security-model',
    patQ.results.some((r) => r.slug === 'security-model' || r.slug === 'user-guide'),
    patQ.results[0]?.slug ?? 'no hits');
  const migQ = await docSearch('migrating from Jira');
  check('search_docs: "migrating from Jira" → migration doc',
    migQ.results.some((r) => r.slug === 'migration'),
    migQ.results[0]?.slug ?? 'no hits');
  const ldapQ = await docSearch('LDAP bind');
  check('search_docs: "LDAP bind" → identity doc',
    ldapQ.results.some((r) => r.slug === 'identity'),
    ldapQ.results[0]?.slug ?? 'no hits');
  const docPage = await tf.call<{ slug: string; markdown?: string }>(
    'GET', '/api/internal/docs/page/identity');
  check('get_doc returns identity page markdown',
    (docPage.markdown?.length ?? 0) > 500, `${docPage.markdown?.length ?? 0} bytes`);
  const adminDoc = await tf.call<{ slug: string }>('GET', '/api/internal/docs/page/threat-model')
    .then(() => 'visible').catch(() => 'hidden');
  check('admin-audience doc reachable by admin token', adminDoc === 'visible', adminDoc);

  // --- Sprint 063: launch wedge ------------------------------------------
  // 37. llms.txt — unauthenticated agent-onboarding index (US3-1).
  const llms = await fetch(`${URL_}/llms.txt`);
  const llmsText = await llms.text();
  check('llms.txt served unauthenticated', llms.status === 200 && llmsText.includes('# TrackForge') && llmsText.includes('/rest/api/2'));

  // 38. JQL ready()/blocked() — inward "blocks" links gate readiness (US4-1).
  const blocker = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} blocker` } } });
  const blockedIss = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} blocked` } } });
  const freebie = await tf.call<Issue>('POST', '/rest/api/2/issue',
    { body: { fields: { project: { key: pk }, summary: `${run} freebie` } } });
  created.push(blocker.key, blockedIss.key, freebie.key);
  await tf.call('POST', '/rest/api/2/issueLink', {
    body: { type: { name: 'Blocks' }, outwardIssue: { key: blocker.key }, inwardIssue: { key: blockedIss.key } },
  });
  const readyRes = await tf.call<SearchRes>('GET', '/rest/api/2/search', {
    query: { jql: `project = ${pk} AND summary ~ "${run}" AND key in ready()`, maxResults: 50, fields: 'summary' },
  });
  const readyKeys = readyRes.issues.map((i) => i.key);
  check('ready() excludes blocked, includes blocker+free',
    readyKeys.includes(blocker.key) && readyKeys.includes(freebie.key) && !readyKeys.includes(blockedIss.key),
    readyKeys.join(','));
  const blockedRes = await tf.call<SearchRes>('GET', '/rest/api/2/search', {
    query: { jql: `project = ${pk} AND summary ~ "${run}" AND key in blocked()`, maxResults: 50, fields: 'summary' },
  });
  check('blocked() is the inverse', blockedRes.issues.some((i) => i.key === blockedIss.key));
  const fnCatalog = await tf.call<{ functions: { name: string }[] }>('GET', '/api/internal/jql/functions');
  check('JQL function catalog lists ready/blocked',
    fnCatalog.functions.some((f) => f.name === 'ready') && fnCatalog.functions.some((f) => f.name === 'blocked'));

  // 39. Zero-to-delegation (SC-002): agent account → token → claim → activity.
  const agentEmail = `${run}-agent@eval.local`;
  const agentUser = await tf.call<{ accountId: string }>('POST', '/api/internal/users', {
    body: {
      email: agentEmail, displayName: `Eval Claimer ${run}`, password: 'eval-agent-012',
      type: 'agent', isAssignableAgent: true, ownerId: me.user.accountId,
    },
  }).catch(() => null);
  check('create assignable agent', !!agentUser?.accountId);
  if (agentUser?.accountId) {
    // Agents can't session-login — admins mint their PAT via the admin route.
    const agentTok = await tf.call<{ secret: string }>(
      'POST', `/api/internal/users/${agentUser.accountId}/tokens`,
      { body: { name: `agent-${run}`, scopes: ['read', 'write'] } });
    check('admin mints agent token', agentTok.secret?.startsWith('tfp_') === true);
    const agentTf = new TrackForgeClient(URL_, agentTok.secret ?? 'none');
    const claim = await agentTf.call<{
      issue: { key: string; fields: { delegate?: { accountId: string } } }; sessionId: string;
    }>('POST', '/api/internal/agent/claim', { body: { projectKey: pk } })
      .catch((e) => ({ status: (e as { status?: number }).status }) as never);
    const claimed = claim as { issue?: { key: string; fields?: { delegate?: { accountId: string } } }; sessionId?: string; status?: number };
    check('claim returns issue + sessionId',
      typeof claimed.sessionId === 'string' && /^[A-Z]+-\d+$/.test(claimed.issue?.key ?? ''),
      JSON.stringify(claimed).slice(0, 120));
    if (claimed.sessionId && claimed.issue?.key) {
      created.push(claimed.issue.key);
      check('claim delegates to the claiming agent',
        claimed.issue.fields?.delegate?.accountId === agentUser.accountId);
      const act = await agentTf.call<{ activities: { type: string }[] }>(
        'POST', `/api/internal/agent-sessions/${claimed.sessionId}/activities`,
        { body: { type: 'action', text: 'eval: picked up claimed work' } });
      check('emit_activity lands on claimed session', act.activities.length === 1);
      const sess = await agentTf.call<{ status: string; trigger: string }>(
        'GET', `/api/internal/agent-sessions/${claimed.sessionId}`);
      check('claimed session is running with claim trigger', sess.status === 'running' && sess.trigger === 'claim');

      // 40. Composite PUT (US5) — fields+transition+comment+worklog, one call.
      const trList = await agentTf.call<{ transitions: { id: string; name: string }[] }>(
        'GET', `/rest/api/2/issue/${claimed.issue.key}/transitions`);
      const composite = await agentTf.call<{
        steps: { fields?: string; transition?: { id: string }; comment?: { id: string }; worklog?: { id: string; timeSpentSeconds: number } };
      }>('PUT', `/rest/api/2/issue/${claimed.issue.key}`, {
        body: {
          fields: { summary: `${run} composite claim` },
          ...(trList.transitions[0] ? { transition: { id: trList.transitions[0].id } } : {}),
          comment: { body: 'eval composite comment' },
          worklog: { timeSpent: '25m', comment: 'eval composite work' },
        },
      });
      check('composite PUT reports every step',
        composite.steps?.fields === 'updated' && !!composite.steps?.comment?.id &&
        composite.steps?.worklog?.timeSpentSeconds === 1500 &&
        (!trList.transitions[0] || !!composite.steps?.transition?.id),
        JSON.stringify(composite.steps ?? {}));
      const compPreview = await agentTf.call<{ dryRun?: boolean; steps?: { comment?: { body?: string } } }>(
        'PUT', `/rest/api/2/issue/${claimed.issue.key}`, {
          dryRun: true,
          body: { fields: { summary: 'never persisted' }, comment: { body: 'never persisted' } },
        });
      check('composite dryRun previews steps without persisting',
        compPreview.dryRun === true && compPreview.steps?.comment?.body === 'never persisted');
      const compIssue = await agentTf.call<Issue>('GET', `/rest/api/2/issue/${claimed.issue.key}`);
      check('dryRun composite left the issue untouched',
        (compIssue.fields as { summary?: string })?.summary === `${run} composite claim`);
    }
    // 41. Read-scope token: writes refused at call time (GHSA-3r68 shape, REST leg).
    const roTok = await tf.call<{ secret: string }>(
      'POST', `/api/internal/users/${agentUser.accountId}/tokens`,
      { body: { name: `ro-${run}`, scopes: ['read'] } });
    if (roTok.secret) {
      const roTf = new TrackForgeClient(URL_, roTok.secret);
      const denied = await roTf.call('POST', '/api/internal/agent/claim', { body: { projectKey: pk } })
        .then(() => 'allowed').catch((e) => `status ${(e as { status?: number }).status}`);
      check('read-scope token cannot claim (403)', denied === 'status 403', denied);
    }
    // 42. approvalPolicy=always: the claim parks as a proposal (US4-3).
    const gatedTok = await tf.call<{ secret: string }>(
      'POST', `/api/internal/users/${agentUser.accountId}/tokens`,
      { body: { name: `always-${run}`, scopes: ['read', 'write'], approvalPolicy: 'always' } });
    if (gatedTok.secret) {
      const gatedTf = new TrackForgeClient(URL_, gatedTok.secret);
      const parked = await gatedTf.call<{ pendingApproval?: boolean; proposalId?: string }>(
        'POST', '/api/internal/agent/claim', { body: { projectKey: pk } });
      check('always-policy claim parks as proposal', parked.pendingApproval === true && !!parked.proposalId);
    }
  }

  // 43. Readonly toolset (US3-3 / SC-003): spawn the MCP HTTP server, assert
  // write tools are absent from tools/list AND refused at tools/call.
  {
    const { spawn } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const port = 13747;
    const mcpDir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    // Spawn node on tsx's CLI directly (not `npx tsx`): a cmd.exe wrapper would
    // survive proc.kill() and leave a stale server holding the port between runs.
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const proc = spawn(process.execPath, [tsxCli, 'src/index.ts', '--http', '--port', String(port)], {
      cwd: mcpDir, env: { ...process.env, TRACKFORGE_URL: URL_ }, stdio: 'ignore',
    });
    const mcpCall = async (payload: Record<string, unknown>, readonly = true) => {
      const res = await fetch(
        `http://localhost:${port}/mcp${readonly ? '?toolset=readonly' : ''}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(payload),
        });
      const text = await res.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      return dataLine ? JSON.parse(dataLine.slice(6)) : null;
    };
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await new Promise((r) => setTimeout(r, 500));
        up = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eval', version: '1' } } })
          .then((r) => !!r?.result).catch(() => false);
      }
      check('readonly MCP server starts', up);
      if (up) {
        const roList = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const roNames = new Set((roList?.result?.tools ?? []).map((t: { name: string }) => t.name));
        check('readonly toolset hides every mutation tool',
          !roNames.has('create_issue') && !roNames.has('claim_issue') && !roNames.has('update_issue')
          && Object.keys(MUTATION_REGISTRY).every((m) => !roNames.has(m)));
        check('readonly keeps read tools', roNames.has('search_issues') && roNames.has('find_ready_issues'));
        const deniedCall = await mcpCall({
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'create_issue', arguments: { project_key: pk, summary: 'readonly escape' } },
        });
        const deniedText = deniedCall?.result?.content?.[0]?.text ?? '';
        check('filtered tool refused at call time',
          deniedCall?.result?.isError === true && /not found/i.test(deniedText),
          deniedText.slice(0, 80));
        const fullList = await mcpCall({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, false);
        const fullNames = new Set((fullList?.result?.tools ?? []).map((t: { name: string }) => t.name));
        check('full toolset still exposes writes', fullNames.has('create_issue') && fullNames.has('claim_issue'));
      }
    } finally {
      proc.kill('SIGTERM');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed. Created issues: ${created.join(', ')}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
