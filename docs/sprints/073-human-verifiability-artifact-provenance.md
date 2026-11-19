# Sprint 073 — Human Verifiability, Artifact Storage & Deliverable Sign-Off

| | |
|---|---|
| **Status** | Implemented (integration suite + MCP eval 169/169 + live fleet verify on `SWARM-12`) |
| **Milestone** | Post-GA — Multi-Agent Fleet Wave (Human Trust, Auditability & Acceptance Loop) |
| **Theme** | Close the "invisible work" gap between autonomous agent fleets and human maintainers: replace digest-only claims with server-verified inspectable artifacts, auto-published Work Product Dossier comments, bidirectional RFC↔Issue↔Receipt provenance, and SHA-pinned human acceptance sign-off |
| **Depends on** | 008 (`Comment` markdown + `@` mentions), 009/031 (`Workflow` + `TransitionRule`), 011/029 (`DomainEvent` + `Notification`), 018 (`Attachment` blob store), 038 (`DevelopmentItem` git/PR panel), 071 (Town Hall, `TownHallTopicIssue`, `AgentInboxItem`), 072 (`WorkReceipt`, `IssueLedgerEntry`, `driftStatus`) |
| **Unblocks** | Real human code/deliverable review inside TrackForge without hunting across temp scripts, terminals, or external worktrees; enterprise compliance gates where no agent-authored task reaches `Done` without inspectable diffs, test transcripts, and human sign-off |
| **Spec-kit folder** | not generated — implemented directly from this doc |

> **Origin**: Post-072 live 10-agent build (`SWARM-10` / `SWARM-11` shipping `tools/fleet-report.mjs`).
> While the fleet coordinated cleanly (RFC → quorum → DAG → fenced leases → receipts → Done), auditing the result **as a human inside TrackForge** exposed six severe verifiability gaps:
> 1. **Zero footprint in Jira's primary human surfaces** — `ActivitySection` (Comments / History) showed nothing except a bare status flip to `Done`. No comment summarized what `coder-a` built, which files changed, how `reviewer-bot` tested it, or why drift fired.
> 2. **Cryptographic theater in `hash_verified`** — `receiptService.ts` unconditionally stamps `verification = 'hash_verified'` on any 64-char hex string without ever receiving or hashing the artifact bytes. And because `WorkReceipt` stores no payload or `Attachment` link (and exposes no `GET /work-receipts/:id`), a human sees a green `"diff — hash verified"` badge with **zero way to read the diff or test output**.
> 3. **Broken lineage from Issue back to RFC** — `TownHallTopicIssue` links `SWARM-10` to the authorizing RFC and threat-model evidence post in Postgres, but neither the Issue REST view nor `IssueDetailView` renders that provenance.
> 4. **Self-certification straight to `Done`** — `ApprovalPolicy` (`Proposal`) gates *pre-execution TrackForge REST mutations*, not *external worktree deliverables*. `coder-a` claimed `SWARM-10` and moved it to `Done` in the same second with no human checkpoint.
> 5. **Passive drift & unwired SSE** — `SWARM-10` and `SWARM-11` both recorded `drift_flagged` in `IssueLedgerEntry`, yet no human (`assignee` / `ownerId`) was notified, no issue-level warning banner rendered, and `work_receipt.submitted` was ignored by `frontend/src/api/events.ts`.

---

## 1. Critical Design Discussion & Refinements

Before locking requirements, four naive solutions from the initial audit must be rejected or sharpened so they survive 500-agent scale:

### 1.1 Fix `hash_verified` Epistemics + Tiered Artifact Storage (Inline + `Attachment`)
- **Critique**: Storing arbitrary diffs/logs directly on `WorkReceipt` bloats table scans if unbounded, while storing *nothing* makes receipts unreviewable. Worse, calling client-declared hex digests `hash_verified` is false advertising.
- **Refined design**:
  - **Honest verification tiers**:
    - `digest_only` (replaces unverified self-claims when no bytes are uploaded) — client declared a SHA-256 and external `artifactUri`, server did **not** see bytes. Does **not** satisfy `verifiedReceiptRequired` by default.
    - `hash_verified` — client supplied inline `content` (`<= 64 KiB` UTF-8 text: unified diff, test stdout, JUnit summary, benchmark table) **or** linked an uploaded `Attachment` (`attachmentId`), and **the server computed `SHA-256(bytes) === sha256`**.
    - `scm_corroborated` — `gitCommitSha` matches an ingested `DevelopmentItem` commit/passing build (`038`/`051`), plus server-verified content if attached.
    - `human_attested` / `signed_ci` — corroborated by a human Deliverable Review (`FR-004`) or dedicated CI `attest` token scope.
  - **Two-tier storage**: Inline `contentText` (`<= 64 KiB`) + `contentType` (`text/x-diff`, `text/plain`, `application/json`) lives in a **separate lazy-loaded relation or deferred column** fetched only via `GET /api/internal/work-receipts/:id` (never serialized into list payloads). Artifacts `> 64 KiB` upload through TrackForge's existing `Attachment` service (`018`) and bind via `WorkReceipt.attachmentId`, inheriting quotas, streaming downloads, and permissions.

### 1.2 Consolidated "Work Product Dossier" Comments — Not Per-Receipt Comment Spam
- **Critique**: Auto-posting a Jira comment on every `POST /work-receipts` + `claim` + `trace` would flood `ActivitySection` with 15+ noisy comments when an agent iterates on failing tests.
- **Refined design**:
  - **One structured system-marked comment per session milestone**: `releaseSession` (`completed`, `ready_for_review`, `handed_off`, `failed`) and `submitDeliverableReview` (`approved`, `changes_requested`) write **one** rich Markdown **Work Product Dossier** comment via `commentService` (attributed to the session agent, tagged with structured `metadataJson` so the UI can enhance it with interactive receipt drawers while raw REST/Markdown readers still get clean tables, file paths, branch/SHA, test pass/fail counts, Town Hall RFC link, and drift callouts).
  - **Idempotent update on re-release / receipt amend**: If a session attaches receipts prior to release, they accumulate quietly in the Ledger + Receipts drawer and publish as a single cohesive dossier when the session hands off or requests review.

### 1.3 Post-Execution Deliverable Sign-Off ≠ Pre-Execution `Proposal`
- **Critique**: TrackForge's `Proposal` inbox (`012`/`052`) parks an HTTP `PUT`/`DELETE` before it mutates Postgres. Code written in a git worktree has *already happened* outside Postgres; parking `POST /transitions` as a raw JSON proposal forces a human to approve `"transitionId: 31"` without seeing the code diff, test transcript, or drift status.
- **Refined design**:
  - Introduce first-class **Deliverable Review (`DeliverableReview`)** + session outcome `ready_for_review`:
    - When an agent finishes implementation, it releases with `outcome: 'ready_for_review'` (or transitions to `In Review`), binding `headSha`, `changedFiles[]`, and `receiptIds[]`.
    - A human (or authorized non-driver reviewer, governed by workflow rule) inspects the **Deliverable Review Drawer** on the issue — unified diff viewer, test transcript, file manifest, drift check, and originating Town Hall RFC — and submits `verdict: 'approved' | 'changes_requested'` with optional inline notes.
    - **Cryptographic pinning**: Approval pins `{ headSha, receiptShas[] }`. If any new driver session, receipt, or `phantom_handoff` occurs after approval, the approval automatically invalidates (`stale`) before `Done`.
    - **Closed-loop rejection**: `changes_requested` posts the review comment, transitions the issue back to `In Progress` / ready pool (if configured), and pushes a high-priority `changes_requested` item into the author agent's `AgentInboxItem` queue so the fleet reacts without human copy-pasting.

### 1.4 Active Drift & Review Routing
- **Critique**: An audit log that nobody reads until an incident occurs is post-mortem forensics, not operational control.
- **Refined design**:
  - `drift_flagged` (`phantom_handoff` / `undeclared_edits`) and `deliverable.ready_for_review` route through `notificationService` to the human `Issue.assigneeId` (fallback: agent's human `User.ownerId`, fallback: `Project.leadId`).
  - `IssueDetailView` renders a top-of-page **Deliverable & Provenance Strip** whenever an issue was compiled from Town Hall, holds work receipts, awaits human review, or carries unresolved drift.

---

## 2. Goals & Non-Goals

### Goals
1. **Readable proof inside TrackForge**: Any human opening an agent-worked issue can read the exact unified diff, test/command transcript, changed file list, git branch/SHA, and verification tier in **<= 2 clicks** — without touching a terminal.
2. **Server-verified hashes**: `hash_verified` mathematically guarantees TrackForge hashed the stored inline text or `Attachment` bytes and matched `sha256`.
3. **Native Jira comment visibility**: Every completed, handed-off, review-ready, or failed agent session leaves a clean, human-readable **Work Product Dossier** comment in `ActivitySection` with deep links to receipts, attachments, and the authorizing RFC.
4. **End-to-end lineage**: Bidirectional navigation between **Town Hall Topic / Decision** ↔ **Compiled Epic & Tasks** ↔ **Agent Session** ↔ **Work Receipts & Files**.
5. **SHA-pinned human acceptance gate**: Workflow rule `deliverableApproved` blocks `Done` until a human (or distinct reviewer, per rule config) approves the exact current receipt/SHA bundle; rejections wake the responsible agent via durable inbox.

### Non-Goals
- Full GitHub/GitLab multi-file PR line-by-line code hosting replacement (TrackForge renders clean unified diffs, file manifests, and test logs up to attachment limits, and deep-links to external PRs via `DevelopmentItem` when available).
- Running arbitrary untrusted build containers inside TrackForge's backend process.

---

## 3. Data Model & Migration (`073_human_verifiability`)

1. **Extend `WorkReceipt`**:
   - `changedFiles String[] @default([])` — normalized repo-relative paths touched/covered by this receipt.
   - `attachmentId String?` — optional FK to `Attachment` (`onDelete: SetNull`) for large diffs, logs, coverage bundles, or screenshots.
   - `contentType String?` — e.g. `text/x-diff`, `text/plain`, `application/json`.
   - New 1:1 table `WorkReceiptPayload` (`receiptId String @id`, `contentText String` capped at `65_536` chars) — keeps `WorkReceipt` list scans compact while storing inline diffs/logs in Postgres.
   - Normalize `verification` enum semantics: `digest_only | hash_verified | scm_corroborated | human_attested | signed_ci` (existing `unverified` rows alias/migrate cleanly to `digest_only`).
2. **Extend `Comment`**:
   - `metadataJson Json?` — optional structured envelope (`{ kind: 'agent_dossier' | 'deliverable_review', sessionId?, receiptIds?, headSha?, driftStatus?, topicId?, verdict? }`) so `ActivitySection` renders rich interactive badges/drawers while standard `/rest/api/2/issue/:key/comment` consumers still see pure Markdown `body`.
3. **New model `DeliverableReview`**:
   - `id String @id @default(uuid())`
   - `projectId String`, `issueId String`, `sessionId String?`
   - `reviewerId String` (FK `User`)
   - `verdict String` (`approved | changes_requested`)
   - `body String?`
   - `pinnedHeadSha String?`
   - `pinnedReceiptIds String[]`
   - `supersededAt DateTime?` (set automatically if new work/drift lands after approval)
   - `createdAt DateTime @default(now())`
   - Indexes: `(issueId, createdAt DESC)`, `(projectId, verdict)`.
4. **Extend `AgentSession`**:
   - Allow release `outcome`: `'completed' | 'ready_for_review' | 'handed_off' | 'failed'`.
   - `dossierCommentId String?` — FK/reference to the generated `Comment` on the issue for traceability.

---

## 4. Functional Requirements

### FR-001 — Server-Verified Receipt Payloads & `GET /work-receipts/:id`
- `POST /api/internal/work-receipts` accepts optional `content` (`<= 65,536` UTF-8 bytes), `contentType`, `attachmentId`, and `changedFiles` (`string[]`, max 200 normalized repo-relative paths).
- **Verification law**:
  - If `content` is supplied: server computes `sha256(Buffer.from(content, 'utf8'))`. If `sha256` was omitted, server fills it; if supplied and mismatched → `422 Unprocessable Entity` (`{ errors: { sha256: "Computed digest <x> does not match declared <y>." } }`). Stored in `WorkReceiptPayload`, tier = `'hash_verified'`.
  - Else if `attachmentId` is supplied: server verifies the `Attachment` belongs to the target issue/project, hashes/reads its stored digest, matches `sha256` → tier = `'hash_verified'`.
  - Else (neither `content` nor `attachmentId`): tier = `'digest_only'` (`verifiedAt = null`).
  - `corroborate()` upgrades `'digest_only'` or `'hash_verified'` to `'scm_corroborated'` when `gitCommitSha` matches an ingested `DevelopmentItem`.
- `GET /api/internal/work-receipts/:id` returns the full receipt view **including** `content`, `contentType`, `changedFiles`, and `attachment` download metadata (`filename`, `size`, `contentUrl`), gated by `BROWSE_PROJECTS` + `enforceIssueScope` / `projectAllowed`.

### FR-002 — Automatic Work Product Dossier Comments
- When `releaseSession` executes on an issue (`completed`, `ready_for_review`, `handed_off`, `failed`), unless `suppressComment === true` (admin/test override), it transactionally creates a `Comment` on the issue authored by the session agent:
  - **Markdown body** (cleanly readable in REST, email, webhooks, and standard Markdown):
    - Header line: outcome badge (`Ready for Review` / `Completed` / `Handed Off` / `Failed`), session role, branch + `baseSha → headSha`, drift verdict.
    - Summary + `remainingSteps` / `doNotRepeat` bullets.
    - **Artifacts & Receipts table**: receipt kind, short SHA, verification tier, summary, key metrics (`passed/failed/durationMs`), and changed files.
    - **Provenance footer**: originating Town Hall RFC link (if any) and session ID.
  - **`metadataJson`**: `{ kind: 'agent_dossier', sessionId, outcome, headSha, driftStatus, receiptIds, changedFiles, topicId }` so `ActivitySection` renders inline **"View Diff / Log"** buttons directly on the comment card.
- Records `dossierCommentId` on `AgentSession` and emits normal `issue_commented` + `agent_session.released` events so watchers and human assignees get standard TrackForge notifications.

### FR-003 — Bidirectional Provenance (Town Hall ↔ Issue ↔ Session ↔ Files)
- `GET /api/internal/issues/:key/provenance` (and embedded summary in `getContextPack`) returns:
  - `topics`: all `TownHallTopicIssue` links (`compiled | blocks | discusses`) with topic `id`, `title`, `status`, `decisionSummary`, `resolvedBy`, `resolvedAt`, and evidence receipts attached to the topic.
  - `receipts`: all `WorkReceipt` summaries on the issue (with `hasInlineContent: boolean`, `attachmentId`, `changedFiles`).
  - `deliverableReview`: current active review state (`none | awaiting_review | approved | changes_requested | stale`), latest `DeliverableReview` entry, and aggregated `changedFiles` across the latest session/receipts.
- Town Hall Topic detail UI (`TownHallPage`) renders compiled task badges (`SWARM-10`, `SWARM-11`) with live status, assignee/delegate, receipt count, and review state; evidence posts with bound receipts gain an inline **"Inspect Evidence Artifact"** drawer.

### FR-004 — Deliverable Sign-Off & Workflow Gate (`deliverableApproved`)
- Endpoints:
  - `POST /api/internal/issues/:key/deliverable-review` (`{ verdict: 'approved' | 'changes_requested', body?: string, receiptIds?: string[], headSha?: string }`):
    - Caller must hold `EDIT_ISSUES` / `RESOLVE_ISSUES` on the project and **must not** be the session's driver agent (`actor.user.id !== lastDriverSession.agentUserId`).
    - When `verdict === 'approved'`: records `DeliverableReview` pinning `headSha` + `receiptIds`, upgrades pinned `hash_verified` receipts to `human_attested` (or records co-attestation in `IssueLedgerEntry` `deliverable_approved`), and writes a structured review comment.
    - When `verdict === 'changes_requested'`: requires non-empty `body` (`>= 10` chars), records `DeliverableReview` + `IssueLedgerEntry` (`deliverable_changes_requested`), writes the review comment, marks prior approvals `supersededAt = now()`, and enqueues an `AgentInboxItem` (`reason: 'changes_requested'`) to the last driver agent with the review notes and issue key.
  - `GET /api/internal/issues/:key/deliverable-reviews` — lists the review history for the issue.
- **Staleness protection**: Starting a new `driver` lease, submitting a new `diff` receipt with a different digest, or recording non-clean `driftStatus` automatically sets `supersededAt = now()` on prior `approved` reviews for that issue.
- **Workflow `TransitionRule` validator `deliverableApproved`**:
  - Config: `{ requireHuman?: boolean (default true), minReceiptTier?: 'hash_verified' | 'scm_corroborated' }`.
  - Rejects transitions to gated statuses (`422 Unprocessable Entity` with self-correcting `{ errors: { deliverableReview: ... } }`) unless an un-superseded `approved` `DeliverableReview` exists (by a `user.type === 'human'` when `requireHuman !== false`) and at least one receipt meets `minReceiptTier`.

### FR-005 — Active Exception Notifications & Live SSE Wiring
- **Notifications**:
  - `agent_session.released` with `outcome === 'ready_for_review'` notifies `Issue.assigneeId` (or agent `ownerId` / project lead) with `"SWARM-10 is ready for deliverable review"`.
  - `drift_flagged` (`phantom_handoff` or `undeclared_edits`) notifies `Issue.assigneeId` + agent `ownerId` with `"Drift detected on SWARM-10 (phantom_handoff)"`.
- **Frontend SSE (`apps/frontend/src/api/events.ts`)**:
  - Handle `work_receipt.submitted`, `deliverable_review.submitted`, and `agent_session.released` by invalidating `['issue-receipts', issueKey]`, `['issue-ledger', issueKey]`, `['issue-provenance', issueKey]`, `['comments', issueKey]`, and `['town-hall-topic', topicId]`.

### FR-006 — Human Inspection UI (`IssueDetailView`, `ActivitySection`, `TownHallPage`)
- **Provenance & Review Banner (`IssueDetailView` top of center column)**:
  - Shows originating Town Hall RFC chip (`Compiled from RFC: fleet-report CLI`), artifact count (`2 verified receipts · 1 file`), drift alert badge (if `phantom_handoff` / `undeclared_edits`), and **Review Deliverable** CTA (`Approve` / `Request Changes`) when awaiting sign-off.
- **Artifact & Diff Drawer (`ReceiptInspectorDrawer`)**:
  - Opens from `AgentSessionsPanel` ledger rows, `ActivitySection` dossier comment chips, the Provenance banner, or Town Hall evidence posts.
  - Renders syntax-colored unified diff (`+`/`-` hunks), monospace test/command output, structured metrics pills (`3 passed · 0 failed · 900ms`), `changedFiles` list, SHA-256 copy pill, verification tier explanation, and `Attachment` download link.
- **Enhanced Dossier Comment (`ActivitySection`)**:
  - Recognizes `comment.metadata?.kind === 'agent_dossier' | 'deliverable_review'` and renders clean summary chips + one-click **"Inspect Diff / Logs"** triggers above/beside the Markdown body.

### FR-007 — Four-Surface Contract Parity & MCP Tools
- Update all four contract surfaces (`validation.ts`, `openapi.ts`, `apps/mcp/src/tools.ts` + `MUTATION_REGISTRY`, `apps/frontend/src/api/client.ts`):
  - Extend MCP `work_receipts` (`action: 'submit' | 'get' | 'list' | 'ledger'`) with `content`, `content_type`, `attachment_id`, `changed_files`, and `receipt_id`.
  - Extend MCP `lease_work` `release` with `outcome: 'ready_for_review'`.
  - Add MCP `deliverable_review` (`action: 'status' | 'submit'`, gated via `wtool` + `MUTATION_REGISTRY` so peer reviewer agents can participate when `requireHuman: false`, while human-only gates reject agent tokens cleanly with `403`).
- Extend `apps/mcp/eval/run.ts` with deterministic contract checks for content-hashed receipts, `422` hash mismatch rejection, dossier comment creation, provenance readback, and deliverable sign-off gating.

---

## 5. Step-by-Step Implementation Plan

1. **Step 1 — Schema & Migration (`073_human_verifiability`)**: Add `WorkReceiptPayload`, `WorkReceipt` fields (`changedFiles`, `attachmentId`, `contentType`), `Comment.metadataJson`, `AgentSession.dossierCommentId`, and `DeliverableReview`; run `prisma migrate deploy` + `prisma generate`.
2. **Step 2 — Honest `WorkReceipt` Verification & Detail API**: Server-side SHA-256 verification over inline `content` and `Attachment` streams (`digest_only` vs `hash_verified`), `422` on mismatch, and `GET /api/internal/work-receipts/:id`.
3. **Step 3 — Dossier Comment Generator & Provenance Service**: Wire `releaseSession` (`ready_for_review` + existing outcomes) to emit the consolidated Markdown + `metadataJson` dossier comment; implement `GET /api/internal/issues/:key/provenance`.
4. **Step 4 — Deliverable Review & `deliverableApproved` Workflow Gate**: Implement `deliverableReviewService.ts` (SHA/receipt pinning, staleness invalidation, `changes_requested` inbox wakeup) + `workflowService.ts` rule evaluation + notification routing for review/drift.
5. **Step 5 — OpenAPI, MCP Parity & Deterministic Eval**: Update `validation.ts`, `openapi.ts`, `tools.ts`, `toolContract.ts`, and `apps/mcp/eval/run.ts`.
6. **Step 6 — Frontend Provenance Banner, Diff/Log Inspector Drawer & SSE**: Update `client.ts`, `events.ts`, `ReceiptInspectorDrawer.tsx`, `ActivitySection.tsx`, `AgentSessionsPanel.tsx`, `IssueDetailView.tsx`, and `TownHallPage.tsx`.
7. **Step 7 — Integration Suite & Live Fleet Acceptance Scenario**: `humanVerifiability.test.ts` + end-to-end fleet run where agents ship an artifact with inline diff + test transcript, leave a Dossier comment, hit the `deliverableApproved` gate, receive `changes_requested` feedback in their inbox, revise, and pass human approval to `Done`.

---

## 6. Success Criteria (Measurable Gates)

- **SC-001 (No blind badges)**: Submitting a `WorkReceipt` without `content` or `attachmentId` yields `verification: 'digest_only'` and fails `verifiedReceiptRequired(minTier: 'hash_verified')`; submitting `content` with a wrong `sha256` fails `422`; valid `content` computes `hash_verified` and `GET /work-receipts/:id` returns the exact diff/log text.
- **SC-002 (Jira-native human trail)**: Releasing a session on `SWARM-X` creates exactly **1** consolidated Dossier comment visible in `GET /rest/api/2/issue/SWARM-X/comment` and `ActivitySection` containing outcome, branch/SHA, changed files, receipt summaries, and Town Hall topic link.
- **SC-003 (Lineage completeness)**: `GET /api/internal/issues/SWARM-X/provenance` returns the compiling Town Hall RFC, decision summary, evidence receipts, changed files, and current deliverable review state in a single call (`< 15ms` p95).
- **SC-004 (Enforced human checkpoint)**: On a workflow with `deliverableApproved`, an agent cannot transition its own issue to `Done` (`422`); after human `changes_requested`, the driver agent receives a `changes_requested` `AgentInboxItem`; after human `approved` (pinned to `headSha`), a rogue subsequent edit invalidates the approval back to `stale` (`422`), while an unmodified bundle transitions cleanly to `Done`.
- **SC-005 (Zero contract drift)**: `pnpm typecheck`, `pnpm lint`, backend integration suites, OpenAPI drift test, and `pnpm --filter trackforge-mcp eval` pass with `0` warnings and `0` failures.
