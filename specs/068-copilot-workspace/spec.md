# 068 — Copilot workspace (spec)

Sprint doc: `docs/sprints/068-copilot-workspace.md`

## Problem

The copilot was a one-shot write-plan compiler inside a transient `Ctrl+K`
modal: read-only questions ended in `{"plan":[]}` + "Nothing to apply", pass-2
was fed the 8-row display strip (descriptions/comments/accountIds stripped),
context died at every interaction boundary, and local commands hijacked
natural-language input. The fix is a persistent workbench: a dock with
multi-turn threads, a real answer channel, and a bounded read loop.

## Contract (FRs)

- **FR-001** `/ai/plan` may return `answer` (markdown) alongside `plan`,
  `clarify`, `warnings`; `plan:[]` + `answer` is terminal and renders no apply
  affordance.
- **FR-002** Answers are grounded — claims restricted to executed read results
  + the grounding block; issue keys cited verbatim.
- **FR-003** Pass-N receives full structured `result` (projection-bounded),
  never the display clip; `PRESENT.find_users` keeps `accountId`.
- **FR-004** `/ai/plan` accepts `threadId`; turns persist instruction, answer,
  entity refs, writes, outcome; history injects verbatim refs, ≤8 turns, in the
  system role.
- **FR-005** Read chaining bounded at ≤3 rounds / ≤5 LLM calls; reads past the
  terminal round become warnings; identical tool+args reads deduplicated.
- **FR-006** Write invariants unchanged — dryRun previews, planId-bound
  execute, stop-on-failure, per-step idempotency, `channel=copilot`.
- **FR-007** Dock state survives input change, route change, `Esc`, link
  navigation, reload; only explicit New/Delete clears.
- **FR-008** Clarify renders as a turn with chips AND accepts free-text
  follow-ups.
- **FR-009** `Ctrl+K` commands fire only on unambiguous short-verb match;
  question-form input routes via an "Ask Copilot" row; `ai:` prefix hands off.
- **FR-010** New endpoints follow the contract checklist — zod, OpenAPI (drift
  green), scoping, Jira error shape; aggregate exposed as MCP
  `search_aggregate` + eval check.
- **FR-011** Threads are per-user private (foreign id → 404), lazy-swept after
  30d idle, list ≤50 by `updatedAt`.
- **FR-012** `truncate()` replaced by `projectPayload` — Details renders
  formatted JSON objects, never escaped strings.

## Response shape

```
plan → { planId?, steps[], answer?, threadId, turnId, warnings? }
      | { clarify:{question,options[]}, threadId, turnId }
turn → { id, index, instruction, answer?, entities?, writesApplied?, outcome? }
aggregate → { total, groupBy, truncated, buckets[{value,count}] }
```

## Success criteria

SC-001..SC-009 in the sprint doc.
