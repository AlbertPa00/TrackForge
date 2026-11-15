# Automation (Sprint 034)

Jira-style rules: **WHEN** a trigger fires, **IF** conditions hold, **THEN**
actions run — as the rule actor on channel `automation`, with every step
logged to `AutomationRun.steps`.

## Model

`AutomationRule { name, scope(global|project), projectId?, actorId, createdById,
enabled, trigger, conditions, actions, version, failureCount }` — `version`
increments on every edit; runs record `ruleVersion`.

`AutomationRun { ruleId, ruleVersion, triggerEventId?, issueId?, status, steps,
error, startedAt, finishedAt }` — `status ∈ success | some-errors | failed |
skipped-condition | skipped-loop`.

## Triggers

`issue_created`, `issue_updated` (optional `fields[]` changelog filter),
`issue_assigned`, `issue_transitioned` (optional `toStatus`), `comment_created`,
`issue_deleted`, `issue_linked` (optional `linkType`), `work_logged`,
`scheduled` (`cron` 5-field + `jql` selection — evaluated every minute on the
durable runner; exactly-once via the `periodic:automation.schedule` dedupe
key), `manual` (POST run / MCP `run_rule`).

## Conditions

`jql` (issue must match predicate), `field_equals` (issue response field path,
e.g. `fields.status.name` or `issuetype.name`), `user_in_group`,
`user_in_role`, `linked_issues_exist` (optional `linkType`).

## Actions

`edit_fields` (any `UpdateIssueInput` field incl. `customFields`),
`transition` (by id / name / destination status, optional comment), `assign`
(user | `unassigned` | `reporter` | `lead`), `comment` (optional visibility),
`add_labels` / `remove_labels`, `link_issues`, `move_to_sprint` (sprint
id/name | `backlog`), `webhook` (SSRF-guarded via `assertPublicUrl`,
HMAC-signed), `ask_agent` (see below).

All actions run through the **normal service layer** — permissions,
validators, changelog and events apply exactly as for a human writer.

## Smart values

<code v-pre>{{issue.key}}</code>, <code v-pre>{{issue.fields.assignee.displayName}}</code>, <code v-pre>{{actor.accountId}}</code>,
<code v-pre>{{trigger.comment.body}}</code> — <code v-pre>{{issue.X}}</code> falls back into `fields.X`.
Values are Markdown-escaped when used in comment bodies.

## Security

- **Authoring**: site admins any scope/actor; project admins only
  project-scoped rules; selecting a different actor requires site admin.
- **Managing** an existing rule (read/update/toggle/run): site admin, the
  rule's author, or a project admin of the rule's project — 404 on reads,
  403 on writes.
- **Effective permissions** = actor ∩ author, enforced at save and re-checked
  on **every run** (`BROWSE_PROJECTS` on the scope project).
- **Loop prevention** (structural): automation-emitted events are post-annotated
  with `payload.automation = { ruleId, chain, depth }`; a rule already in the
  chain is skipped (`skipped-loop`) and chains cap at depth 5.
- `webhook` reuses the 011 SSRF protection; `ask_agent` prompts are fenced so
  issue content is treated as data.

## ask_agent

Hands the issue to the Sprint 012 copilot planner with the rule's prompt
template. `autoApply: false` (default) resolves each write step into a
`Proposal` row for human approval; `autoApply: true` executes the plan —
every step still passes normal permission checks and validators. Prompt,
model, plan id, proposal ids and apply results land in the run's step log.
Requires a configured AI provider (Admin → AI); throws otherwise.

## REST (`/api/internal/automation`)

`GET /schema` — the type registry (triggers/conditions/actions + descriptions).
`GET/POST /rules`, `GET/PUT/DELETE /rules/:id`, `POST /rules/:id/toggle`,
`GET /rules/:id/runs`, `GET /runs/:runId`, `POST /rules/:id/run {issueKey}`,
`POST /rules/:id/dry-run {issueKey|jql}`, `POST /validate` → `{valid, errors[]}`.

## MCP

`list_rules`, `get_rule`, `create_rule` (`dry_run` validates only), `run_rule`
(`dry_run` previews steps), `get_rule_runs` (per-rule or `run_id`),
`toggle_rule`.

## Seed

`seedAutomationDemo` installs **triage-flagger** (SCRUM bugs → `needs-triage`
label + comment) and **stale-nagger** (09:00 daily comment on SCRUM issues
untouched ≥ 14d).

## Deferred

- `mentioned` trigger (no mention event source yet)
- `create_issue`/`clone`/`notify`/`delete_issue`/`add_to_sprint(-create)` actions
- Rule builder UI beyond the JSON form; smart-value picker
- Per-run `AutomationRun.issueKey` denorm; run-retention pruning
