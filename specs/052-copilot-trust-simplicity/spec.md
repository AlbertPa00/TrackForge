# 052 — Copilot Trust & Simplicity (spec)

Sprint doc: `docs/sprints/052-copilot-trust-simplicity.md`

## Problem

Field report: "the agent shows JSONs, is buggy, always needs clarification."

Deep diagnosis found three structural causes, not model quality:

1. **Planning writes data.** `planCopilot` previews every write through
   `internalRequest(...?dryRun=true)` — but five endpoints ignored `dryRun`
   (`comment`, `bulk`, `issueLink`, `watchers`, `rank`). Planning performed the
   write; Apply performed it again (duplicates).
2. **No presentation layer.** LLM plan → REST payload → `JSON.stringify` in a
   `<pre>` — end users read wire JSON.
3. **Context-starved planner.** No whoami/projects/types/statuses/transitions
   grounding + a "clarify on ambiguity" prompt ⇒ clarify is the modal answer.
   Plus: decorative `planId`, silent tool drops, no stop-on-failure, dishonest
   `accepted` telemetry.

## Contract (FRs)

- **FR-001** `/ai/plan` never persists: every write tool resolves through a
  `dryRun`-honoring endpoint; non-previewable writes are never dispatched.
- **FR-002** `/ai/execute` requires a server-stored `planId` (10-min TTL);
  submitted steps must deep-match stored `{tool,args}` — mutated/foreign → 400.
- **FR-003** Every step carries `display {text, fields?, issues?, markdown?}`;
  raw payloads only under a Details toggle.
- **FR-004** Clarify is `{question, options[]}`; options re-plan in one click.
- **FR-005** Execute stops on first failure (rest → `skipped`);
  `Idempotency-Key: copilot-{planId}-{index}` on POST writes.
- **FR-006** Honest outcomes: `clarified` | `accepted` | `edited` | `failed` |
  `discarded` computed server-side.
- **FR-007** Grounding rides the system role: whoami, visible projects, issue
  types, statuses, live transitions for the context issue.
- **FR-008** New copilot tools (`whoami`, `summarize_issue`,
  `draft_description`, `find_similar`, `nl_search`) dispatch through
  `internalRequest` channel=copilot — no shortcuts.

## New dryRun surfaces

`POST /issue/{key}/comment`, `POST /issue/bulk`, `POST /issueLink`,
`POST /issue/{key}/watchers`, `PUT /agile/1.0/issue/rank` — full validation,
`X-TrackForge-DryRun: true`, zero persistence.

## Success criteria

SC-001..SC-006 in the sprint doc — plan-no-write regression tests, planId
binding rejection, two-pass summarize→comment, display coverage, outcome
counters.
