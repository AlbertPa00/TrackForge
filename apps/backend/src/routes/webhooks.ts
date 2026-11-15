// Jira Server webhooks — /rest/webhooks/1.0/webhook + internal delivery log.
// Admin-only (matches Jira's "webhooks need admin" + our token admin scope).

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { ah } from '../lib/http.js';
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
  redeliver,
} from '../services/webhookService.js';

export const webhookRouter: RouterType = Router();
export const webhookInternalRouter: RouterType = Router();

const webhookSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().max(2000),
  events: z.array(z.string()).min(1),
  filters: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  secret: z.string().max(256).optional(),
  excludeActorIds: z.array(z.string()).optional(),
});

webhookRouter.use(requireAdmin);

webhookRouter.get(
  '/webhook',
  ah(async (_req, res) => {
    res.json(await listWebhooks());
  })
);

webhookRouter.post(
  '/webhook',
  ah(async (req, res) => {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.status(201).json(await createWebhook(req.actor!, parsed.data));
  })
);

webhookRouter.get(
  '/webhook/:id',
  ah(async (req, res) => {
    res.json(await getWebhook(req.params.id));
  })
);

webhookRouter.put(
  '/webhook/:id',
  ah(async (req, res) => {
    const parsed = webhookSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await updateWebhook(req.actor!, req.params.id, parsed.data));
  })
);

webhookRouter.delete(
  '/webhook/:id',
  ah(async (req, res) => {
    await deleteWebhook(req.actor!, req.params.id);
    res.status(204).send();
  })
);

// --- internal delivery log ---
// NOTE: requireAdmin must be per-route — a bare router.use() here would gate
// every later-mounted /api/internal router (tokens, ai, proposals…).

webhookInternalRouter.get(
  '/webhooks/:id/deliveries',
  requireAdmin,
  ah(async (req, res) => {
    res.json({ deliveries: await listDeliveries(req.params.id) });
  })
);

webhookInternalRouter.post(
  '/webhooks/:id/deliveries/:deliveryId/redeliver',
  requireAdmin,
  ah(async (req, res) => {
    await redeliver(req.params.deliveryId);
    res.status(202).json({ redelivering: true });
  })
);
