import { ps } from '../lib/validation.js';
// /api/internal/ai — settings (admin), copilot plan/execute, NL→JQL, issue
// intelligence, similarity. Everything 404s via requireAi() when unconfigured.

import { Router, type Router as RouterType } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  getAiSettings,
  invalidateAiSettingsCache,
  encryptSecret,
  testConnection,
  requireAi,
  aiConfigured,
  embeddingsConfigured,
  speechConfigured,
  transcribe,
} from '../lib/ai.js';
import { requireAdmin } from '../middleware/auth.js';
import { formatZodErrors } from '../lib/validation.js';
import { jiraError, JiraApiError } from '../lib/errors.js';
import {
  planCopilot,
  executePlan,
  listCopilotThreads,
  getCopilotThread,
  deleteCopilotThread,
} from '../services/copilotService.js';
import { recordOutcome } from '../lib/ai.js';
import { sseEmitToUser } from '../services/sseHub.js';
import {
  naturalLanguageToJql,
  summarizeIssue,
  draftDescription,
  breakdownEpic,
  similarIssues,
  similarByText,
  suggestResolution,
  suggestSprintScope,
} from '../services/aiService.js';
import { prisma } from '../prisma.js';
import { ah } from '../lib/http.js';

export const aiRouter: RouterType = Router();

// ---------- settings (admin) ----------

aiRouter.get(
  '/settings',
  requireAdmin,
  ah(async (_req: Request, res: Response) => {
    const s = await getAiSettings();
    res.json({
      configured: aiConfigured(s),
      provider: s?.provider ?? 'openai',
      baseUrl: s?.baseUrl ?? '',
      chatModel: s?.chatModel ?? '',
      embedModel: s?.embedModel ?? '',
      speechModel: s?.speechModel ?? '',
      hasApiKey: !!s?.apiKeyEnc,
      dailyLimit: s?.dailyLimit ?? 0,
      monthlyBudget: Number(s?.monthlyBudget ?? 0n),
      promptLogging: s?.promptLogging ?? false,
      globalGuidance: s?.globalGuidance ?? null,
    });
  })
);

const settingsSchema = z.object({
  provider: z.enum(['openai', 'anthropic']).optional(),
  baseUrl: z.string().max(500).optional(),
  chatModel: z.string().max(200).optional(),
  embedModel: z.string().max(200).optional(),
  speechModel: z.string().max(200).optional(),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  dailyLimit: z.number().int().min(0).optional(),
  monthlyBudget: z.number().min(0).optional(),
  promptLogging: z.boolean().optional(),
  globalGuidance: z.string().max(10_000).nullable().optional(), // 047 US4-3
});

aiRouter.put(
  '/settings',
  requireAdmin,
  ah(async (req: Request, res: Response) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const d = parsed.data;
    await prisma.aiSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
    await prisma.aiSettings.update({
      where: { id: 'singleton' },
      data: {
        ...(d.provider !== undefined ? { provider: d.provider } : {}),
        ...(d.baseUrl !== undefined ? { baseUrl: d.baseUrl } : {}),
        ...(d.chatModel !== undefined ? { chatModel: d.chatModel } : {}),
        ...(d.embedModel !== undefined ? { embedModel: d.embedModel } : {}),
        ...(d.speechModel !== undefined ? { speechModel: d.speechModel } : {}),
        ...(d.apiKey ? { apiKeyEnc: encryptSecret(d.apiKey) } : {}),
        ...(d.clearApiKey ? { apiKeyEnc: null } : {}),
        ...(d.dailyLimit !== undefined ? { dailyLimit: d.dailyLimit } : {}),
        ...(d.monthlyBudget !== undefined ? { monthlyBudget: BigInt(Math.round(d.monthlyBudget)) } : {}),
        ...(d.promptLogging !== undefined ? { promptLogging: d.promptLogging } : {}),
        ...(d.globalGuidance !== undefined ? { globalGuidance: d.globalGuidance } : {}),
      },
    });
    invalidateAiSettingsCache();
    const s = await getAiSettings();
    res.json({ configured: aiConfigured(s), hasApiKey: !!s?.apiKeyEnc });
  })
);

aiRouter.post(
  '/settings/test',
  requireAdmin,
  ah(async (req: Request, res: Response) => {
    const s = await getAiSettings();
    const body = req.body as { baseUrl?: string; chatModel?: string; provider?: string; apiKey?: string };
    // Plaintext key from the unsaved form takes precedence over the stored one.
    // 064 US5 — the *stored* key is only sent to the *stored* baseUrl: testing a
    // different endpoint must come with a freshly typed key, otherwise an admin
    // (or an XSS riding admin) could exfiltrate the configured secret.
    let apiKey = body.apiKey;
    const targetBase = body.baseUrl ?? s?.baseUrl ?? '';
    if (!apiKey && s?.apiKeyEnc && (!body.baseUrl || body.baseUrl === s?.baseUrl)) {
      const { decryptSecret } = await import('../lib/ai.js');
      apiKey = decryptSecret(s.apiKeyEnc) ?? undefined;
    }
    res.json(
      await testConnection({
        provider: body.provider ?? s?.provider ?? 'openai',
        baseUrl: targetBase,
        chatModel: body.chatModel ?? s?.chatModel ?? '',
        apiKey,
      })
    );
  })
);

aiRouter.get(
  '/usage',
  requireAdmin,
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const [month, monthRows, todayRows] = await Promise.all([
      prisma.aiUsage.aggregate({
        where: { day: { gte: monthStart } },
        _sum: { inputTokens: true, outputTokens: true, requests: true, costUsd: true },
      }),
      prisma.aiUsage.findMany({ where: { day: { gte: monthStart } }, select: { outcome: true } }),
      prisma.aiUsage.findMany({
        where: { day: today },
        include: { user: { select: { displayName: true } } },
        orderBy: { requests: 'desc' },
      }),
    ]);
    // 047 US5-4 — accept/edit/discard totals per feature for the month;
    // 052 adds clarified/failed so copilot friction is measurable.
    const outcomes: Record<string, Record<string, number>> = {};
    for (const r of monthRows) {
      const o = r.outcome as Record<string, Record<string, number>> | null;
      for (const [feature, counts] of Object.entries(o ?? {})) {
        const acc = (outcomes[feature] ??= { accepted: 0, edited: 0, discarded: 0, clarified: 0, failed: 0 });
        for (const k of Object.keys(acc)) acc[k]! += counts[k] ?? 0;
      }
    }
    res.json({
      month: {
        requests: month._sum.requests ?? 0,
        inputTokens: month._sum.inputTokens ?? 0,
        outputTokens: month._sum.outputTokens ?? 0,
        costUsd: month._sum.costUsd ?? 0,
      },
      outcomes,
      today: todayRows.map((r) => ({
        user: r.user.displayName,
        requests: r.requests,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
      })),
    });
  })
);

// 047 US5-4 — UI-recorded outcomes: draft copied, breakdown applied, plan
// applied. Proposal resolutions record 'review' outcomes server-side.
aiRouter.post(
  '/outcome',
  ah(async (req: Request, res: Response) => {
    const parsed = z
      .object({
        feature: z.enum(['plan', 'draft', 'breakdown', 'summary', 'jql', 'similar', 'resolution', 'answer']),
        outcome: z.enum(['accepted', 'edited', 'discarded', 'clarified', 'failed']),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    await recordOutcome(req.actor!.user.id, parsed.data.feature, parsed.data.outcome);
    res.status(204).end();
  })
);

aiRouter.get(
  '/prompts',
  requireAdmin,
  ah(async (req: Request, res: Response) => {
    const s = await requireAi();
    if (!s.promptLogging) {
      res.json({ logs: [], note: 'Prompt logging is disabled.' });
      return;
    }
    const logs = await prisma.aiPromptLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { displayName: true } } },
    });
    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        feature: l.feature,
        user: l.user.displayName,
        prompt: l.prompt,
        response: l.response,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  })
);

// ---------- capabilities + speech ----------

/** Any authenticated user — feature discovery for UI affordances (the copilot
 *  mic shows only when `speech` is true). Never 404s: it *is* the discovery
 *  endpoint for whether AI is on at all. */
aiRouter.get(
  '/capabilities',
  ah(async (_req: Request, res: Response) => {
    const s = await getAiSettings();
    const configured = aiConfigured(s);
    res.json({
      configured,
      embeddings: configured && embeddingsConfigured(s!),
      speech: configured && speechConfigured(s!),
    });
  })
);

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1048576, files: 1, parts: 5, fields: 5 },
});

function multipartAudio(req: Request, res: Response, next: NextFunction) {
  audioUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(new JiraApiError(413, jiraError(['Audio exceeds the 25MB transcription limit.'])));
      return;
    }
    if (err) {
      next(new JiraApiError(400, jiraError([`Malformed multipart upload: ${(err as Error).message}`])));
      return;
    }
    next();
  });
}

/** POST /ai/transcribe — multipart field "file" → {text}. Proxied to the
 *  configured provider's /audio/transcriptions; nothing is persisted. */
aiRouter.post(
  '/transcribe',
  multipartAudio,
  ah(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file?.buffer?.length) {
      res.status(400).json(jiraError([], { file: 'Send a multipart field named "file" with the audio.' }));
      return;
    }
    res.json(
      await transcribe(req.actor!.user.id, {
        buffer: file.buffer,
        mime: file.mimetype || 'application/octet-stream',
        name: file.originalname || 'speech.webm',
      })
    );
  })
);

// ---------- copilot (US3) ----------

const planSchema = z.object({
  instruction: z.string().min(1).max(2000),
  threadId: z.string().max(64).optional(),
  context: z
    .object({
      issueKey: z.string().optional(),
      projectKey: z.string().optional(),
      route: z.string().optional(),
    })
    .optional(),
});

/** 047 US5-3 — emit ai.progress over SSE for long-running LLM endpoints.
 *  Phases: context → llm → done|error (the HTTP response is the fallback). */
async function withProgress<T>(
  req: Request,
  feature: string,
  run: (step: (s: string) => void) => Promise<T>
): Promise<T> {
  const userId = req.actor!.user.id;
  const emit = (step: string) => sseEmitToUser(userId, { type: 'ai.progress', feature, step });
  emit('context');
  try {
    const out = await run((s) => emit(s));
    emit('done');
    return out;
  } catch (e) {
    emit('error');
    throw e;
  }
}

aiRouter.post(
  '/plan',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const out = await withProgress(req, 'plan', (step) =>
      planCopilot(req.actor!, parsed.data.instruction, parsed.data.context ?? {}, step, parsed.data.threadId)
    );
    if ('clarify' in out) {
      // 052 — clarify rate is telemetry now, not anecdote (US4.1).
      await recordOutcome(req.actor!.user.id, 'plan', 'clarified').catch(() => undefined);
    }
    res.json(out);
  })
);

// 052 — planId binds execution to the stored, human-confirmed preview (FR-002).
const executeSchema = z.object({
  planId: z.string().min(1),
  turnId: z.string().max(64).optional(),
  steps: z
    .array(
      z.object({
        tool: z.string(),
        args: z.record(z.unknown()).default({}),
        title: z.string().default(''),
      })
    )
    .min(1)
    .max(8),
});

aiRouter.post(
  '/execute',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const parsed = executeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const results = await executePlan(req.actor!, parsed.data.steps, parsed.data.planId, parsed.data.turnId);
    // 052 — honest outcome: applied writes decide accepted/edited/failed;
    // skipped steps don't count as applied (US4.1).
    const writes = results.filter((r) => !r.skipped);
    const ok = writes.filter((r) => r.ok);
    const outcome = !writes.length
      ? 'discarded'
      : ok.length === writes.length
        ? 'accepted'
        : ok.length
          ? 'edited'
          : 'failed';
    await recordOutcome(req.actor!.user.id, 'plan', outcome).catch(() => undefined);
    res.json({ results });
  })
);

// ---------- copilot threads (068) — workbench memory, owner-only ----------

aiRouter.get(
  '/threads',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    res.json({ threads: await listCopilotThreads(req.actor!) });
  })
);

aiRouter.get(
  '/threads/:id',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    res.json({ thread: await getCopilotThread(req.actor!, String(ps(req.params.id))) });
  })
);

aiRouter.delete(
  '/threads/:id',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    await deleteCopilotThread(req.actor!, String(ps(req.params.id)));
    res.status(204).end();
  })
);

// ---------- NL → JQL (US4) ----------

aiRouter.post(
  '/jql',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const text = String((req.body as { text?: string }).text ?? '').trim();
    if (!text) {
      res.status(400).json(jiraError([], { text: 'Provide a natural-language search.' }));
      return;
    }
    res.json(
      await withProgress(req, 'jql', (step) => {
        step('llm');
        return naturalLanguageToJql(req.actor!, text);
      })
    );
  })
);

// ---------- issue intelligence (US5) ----------

aiRouter.post(
  '/issues/:key/summary',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    res.json(
      await withProgress(req, 'summary', (step) => {
        step('llm');
        return summarizeIssue(String(ps(req.params.key)), req.actor!);
      })
    );
  })
);

aiRouter.post(
  '/issues/draft',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const b = req.body as { summary?: string; existing?: string; projectKey?: string };
    res.json(
      await withProgress(req, 'draft', (step) => {
        step('llm');
        return draftDescription(undefined, req.actor!, b);
      })
    );
  })
);

aiRouter.post(
  '/issues/:key/draft',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const b = req.body as { summary?: string; existing?: string };
    res.json(
      await withProgress(req, 'draft', (step) => {
        step('llm');
        return draftDescription(String(ps(req.params.key)), req.actor!, b);
      })
    );
  })
);

aiRouter.post(
  '/issues/:key/breakdown',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    res.json(
      await withProgress(req, 'breakdown', (step) => {
        step('llm');
        return breakdownEpic(String(ps(req.params.key)), req.actor!);
      })
    );
  })
);

// ---------- similarity (US6) ----------

aiRouter.get(
  '/issues/:key/similar',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    res.json(await similarIssues(String(ps(req.params.key)), req.actor!));
  })
);

// 067 — grounded resolution suggestion (read-only; applying is a transition).
aiRouter.post(
  '/issues/:key/suggest-resolution',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    res.json(
      await withProgress(req, 'resolution', (step) => {
        step('llm');
        return suggestResolution(String(ps(req.params.key)), req.actor!);
      })
    );
  })
);

aiRouter.get(
  '/similar',
  ah(async (req: Request, res: Response) => {
    const s = await getAiSettings();
    if (!s || !embeddingsConfigured(s)) {
      res.json({ issues: [] });
      return;
    }
    const text = String(req.query.text ?? '').trim();
    if (text.length < 3) {
      res.json({ issues: [] });
      return;
    }
    res.json(await similarByText(req.actor!, text, req.query.project as string | undefined));
  })
);

// ---------- sprint scope suggestion (Sprint 013 P3) ----------

aiRouter.post(
  '/sprints/:boardId/scope',
  ah(async (req: Request, res: Response) => {
    await requireAi();
    const { goal, capacity } = req.body as { goal?: string; capacity?: number };
    res.json(await suggestSprintScope(String(ps(req.params.boardId)), req.actor!, { goal, capacity }));
  })
);
