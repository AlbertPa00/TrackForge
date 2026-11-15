# Plan — Sprint 012: AI Copilot & Human-in-the-Loop

## Architecture

```
┌─────────────────────────── apps/backend ───────────────────────────┐
│  lib/ai.ts            provider layer (OpenAI-compat + Anthropic),   │
│                       encryption, budgets, usage, prompt logs       │
│  lib/internalRequest  signed loopback dispatch (x-trackforge-       │
│                       internal) — copilot + approval replay         │
│  middleware/proposalGate  parks gated /rest writes as Proposals     │
│  services/proposalService   create/preview/approve/reject/bulk/     │
│                       expire + events + notifications               │
│  services/copilotService    agent toolkit + plan validation/diffs   │
│  services/aiService         NL→JQL, summary, draft, breakdown,      │
│                       embeddings, similarity                        │
│  routes/ai.ts + routes/proposals.ts  /api/internal/* surface        │
└─────────────────────────────────────────────────────────────────────┘
        ▲ loopback dispatch traverses full middleware/route stack
┌─────────────┐   ┌──────────────┐   ┌────────────────┐
│ CommandPalette│ │ ApprovalsPage │ │ AiSettingsPage  │
│ (⌘K copilot) │  │ (inbox+diffs) │  │ Issue AI panel  │
└─────────────┘   └──────────────┘   └────────────────┘
```

## Key decisions (D9)

- **Off by default, always.** Every AI endpoint 404s until `baseUrl` +
  `chatModel` are configured. Secrets encrypted (AES-256-GCM, key from
  `SESSION_SECRET`), write-only over the API.
- **Float[] + JS cosine**, not pgvector — zero new infra for the lightweight
  version; swap point documented for sprint 016.
- **No direct-DB copilot writes.** Internal dispatch signs a synthetic actor
  (`channel=copilot`) and replays through the real routes — workflows,
  validation, events, audit all apply identically to human writes.
- **Approval = revalidate + replay**, not "apply stored diff" — state may have
  moved during the review window; the human approves the *intent*, the server
  re-checks the *preconditions*.
- **UI channels bypass the gate** — a human in the app is already the reviewer.

## Risks carried forward

| Risk | Mitigation shipped |
|---|---|
| Agent loops (copilot writes → events → agent reacts) | `channel=copilot` on events; webhook `excludeActorIds`; agent-channel skip in notification generator |
| Cost overruns | per-user daily cap + global monthly token budget, both 429 |
| Prompt leakage | logging opt-in + redaction; keys never returned |
| Stale approval replay | revalidation on approve; 7-day expiry |
| Token self-approval | session-only resolve; proposing token read-only |
