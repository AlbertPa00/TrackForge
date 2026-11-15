# 067 — Resolution insight (spec)

Sprint doc: `docs/sprints/067-resolution-insight.md`

## Problem

Similar issues are shown on the issue page, but the user still has to open
each one to learn how it was resolved and why. The data to answer "what
resolution fits, and what was the likely cause?" is already retrievable; it
needs one grounded, verifiable synthesis step and a safe way to act on it.

## Contract (FRs)

- **FR-001** No provider chat call unless ≥ 2 resolved, visible, AI-enabled
  evidence hits (score > 0.55) exist; otherwise
  `{resolution:null, reason:'insufficient_evidence'}`.
- **FR-002** Returned `resolution` ∈ resolutions carried by the evidence;
  `basedOn` ⊆ evidence keys (≤ 4). Out-of-set model output → 502.
- **FR-003** `confidence` (`high|medium|low`) is computed server-side from the
  score-weighted share of evidence carrying the chosen resolution.
- **FR-004** Restricted comments and AI-disabled projects never reach the
  model — anchor via `issueForAi`, evidence via `visibleIssueWhere` +
  `filterByVisibility`.
- **FR-005** Apply performs only `POST /issue/{key}/transitions`.
- **FR-006** Outcome feature `resolution`: `accepted` only after a successful
  transition with the suggested resolution; `edited` when the resolution was
  changed on the screen; `discarded` on Dismiss.
- **FR-007** All contract surfaces updated: OpenAPI, copilot tool, MCP tool +
  eval, frontend client.
- **FR-008** `similarIssues` rejects an anchor in an AI-disabled project (400).

## Response shape

```
{ resolution: {id,name} | null,
  confidence: 'high'|'medium'|'low' | null,
  diagnosis: string | null,
  basedOn: [{key, summary, resolution, score}],
  reason: 'insufficient_evidence' | 'already_resolved' | null }
```

## Success criteria

SC-001..SC-007 in the sprint doc.
