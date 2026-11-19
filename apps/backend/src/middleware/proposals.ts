// Approval-mode gate (US2): writes from principals flagged requireApproval
// (token-level or user-level) never execute — they're validated and parked as
// Proposals, answered 202. Humans (channel ui) bypass the gate, as do internal
// dispatch calls flagged bypassApproval (approved proposal replay). Copilot
// writes do NOT bypass (065 audit B3): a plan preview is not a substitute for
// the principal's approval policy.

import type { NextFunction, Request, Response } from 'express';
import type { Actor } from '../lib/auth.js';
import { createProposal } from '../services/proposalService.js';
import { isDryRun } from '../lib/http.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 047 US4 — always | destructiveOnly | never. Effective policy is the strictest
// of user + token (generalizes the old requireApproval OR semantics: neither
// side can loosen the other's gate). Legacy boolean still honored for rows
// written before the backfill.
type Policy = 'always' | 'destructiveOnly' | 'never';
const RANK: Record<Policy, number> = { never: 0, destructiveOnly: 1, always: 2 };

function policyOf(raw: string | null | undefined, legacyRequire: boolean | undefined): Policy {
  const p: Policy = raw === 'always' || raw === 'destructiveOnly' || raw === 'never' ? raw : 'never';
  // Legacy flag floors the policy — rows/tokens created before the backfill
  // (or fixtures that only set requireApproval) keep their gate until the
  // contract release drops the boolean.
  const legacy: Policy = legacyRequire ? 'always' : 'never';
  return RANK[p] >= RANK[legacy] ? p : legacy;
}

export function effectivePolicy(actor: Actor): Policy {
  const u = policyOf(actor.user.approvalPolicy, actor.user.requireApproval);
  const t = policyOf(actor.token?.approvalPolicy, actor.token?.requireApproval);
  return RANK[u] >= RANK[t] ? u : t;
}

// 053 US4 — destructive is a per-route declaration, not method-sniffing:
// DELETEs anywhere, plus internal ops equivalent to deletes — bulk delete and
// issue move (renumber + field-drop data loss). Ordinary creates/updates
// execute directly under destructiveOnly.
const INTERNAL_DESTRUCTIVE = /^\/api\/internal\/(bulk\/delete|issues\/[^/?]+\/move)(\/|$)/;

// /api/internal writes that are /rest/-class issue mutations — they can't
// route around `always` either (bulk ops + clone/move; 053 US4). The agent's
// own loop (sessions, questions, prefs, AI) stays free.
const INTERNAL_REST_CLASS =
  /^\/api\/internal\/(bulk\/(edit|transition|move|delete|comment|watch|link)|issues\/[^/?]+\/(move|clone|lease)|agent\/claim|town-hall\/[^/?]+\/resolve|fleet\/pause|projects\/[^/?]+\/pause)(\/|$)/;

function isDestructive(req: Request, path: string): boolean {
  return req.method === 'DELETE' || INTERNAL_DESTRUCTIVE.test(path);
}

export async function proposalGate(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = req.actor;
    if (!actor || !WRITE_METHODS.has(req.method)) return next();
    if (actor.internal?.bypassApproval) return next();
    // 065 audit B3 — copilot no longer bypasses: its plan preview is not a
    // substitute for the principal's own approvalPolicy. 'never' policies
    // still pass through below; `ui` remains ungated (humans self-approve).
    if (actor.channel === 'ui') return next();
    const policy = effectivePolicy(actor);
    if (policy === 'never') return next();
    // Dry-run previews validate only — they must reach the route (two-step
    // deletes obtain their confirmToken this way), never park as proposals.
    if (isDryRun(req)) return next();
    const path = req.originalUrl.split('?')[0];
    const destructive = isDestructive(req, path);
    if (policy === 'destructiveOnly' && !destructive) return next();
    // `always` gates the public Jira-compatible surface + /rest/-class
    // internal writes + anything destructive; ordinary /api/internal writes
    // (agent sessions, questions, preferences) keep flowing.
    if (policy === 'always' && !req.originalUrl.startsWith('/rest/') && !destructive && !INTERNAL_REST_CLASS.test(path))
      return next();

    const proposal = await createProposal(actor, req);
    res.status(202).json({ proposalId: proposal.id, status: 'pending' });
  } catch (err) {
    next(err);
  }
}
