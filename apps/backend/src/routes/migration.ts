import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import { startImport, getImport, listImports, resumeImport } from '../import/service.js';
import { requireAdmin } from '../middleware/auth.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { ah } from '../lib/http.js';

export const migrationRouter: RouterType = Router();
migrationRouter.use(requireAdmin);

const xmlSchema = z.object({
  zipBase64: z.string().min(100),
  projectKeys: z.array(z.string().min(1)).optional(),
  dryRun: z.boolean().optional(),
});

const csvSchema = z.object({
  csv: z.string().min(10),
  projectKey: z.string().optional(),
  projectKeys: z.array(z.string().min(1)).optional(),
  dryRun: z.boolean().optional(),
});

const startSchema = z.object({
  baseUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  apiToken: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  projectKeys: z.array(z.string().min(1)).min(1),
  dryRun: z.boolean().optional(),
  deltaFrom: z.string().datetime().optional(),
  fixture: z.record(z.unknown()).optional(),
});

// 048 — Jira Server/DC over live REST (basic username:password or PAT Bearer).
const serverStartSchema = z.object({
  baseUrl: z.string().url(),
  authMode: z.enum(['basic', 'pat']),
  username: z.string().min(1).optional(),
  apiToken: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  projectKeys: z.array(z.string().min(1)).min(1),
  dryRun: z.boolean().optional(),
  deltaFrom: z.string().datetime().optional(),
  fieldAliases: z.record(z.string()).optional(),
  groups: z.array(z.string().min(1)).optional(),
  allowPrivate: z.boolean().optional(),
  insecureSkipVerify: z.boolean().optional(),
});

migrationRouter.get(
  '/migration',
  ah(async (_req, res) => {
    res.json(await listImports());
  })
);

migrationRouter.post(
  '/migration/jira-cloud',
  ah(async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const job = await startImport(req.actor!.user.id, parsed.data);
    res.status(202).json(await getImport(job.id));
  })
);

// 048 — live Jira Server/DC import: preflight serverInfo, api/3→api/2
// adapter, user-bean normalization, PAT/basic, credential confinement.
migrationRouter.post(
  '/migration/jira-server',
  ah(async (req, res) => {
    const parsed = serverStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (parsed.data.authMode === 'basic' && !parsed.data.username) {
      res.status(400).json(jiraError(['username is required for authMode basic']));
      return;
    }
    const job = await startImport(req.actor!.user.id, { ...parsed.data, source: 'jira-server' });
    res.status(202).json(await getImport(job.id));
  })
);

// 039 — CSV import: translate to the fixture map, run the 017 pipeline.
migrationRouter.post(
  '/migration/csv',
  ah(async (req, res) => {
    const parsed = csvSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { csvToFixture } = await import('../import/csvSource.js');
    const fixture = csvToFixture(parsed.data.csv, { projectKey: parsed.data.projectKey });
    const projectKeys = parsed.data.projectKeys?.length
      ? parsed.data.projectKeys
      : [
          ...new Set(
            (fixture['/rest/api/3/search'] as { issues: { key: string }[] }).issues.map((i) => i.key.split('-')[0])
          ),
        ];
    if (!projectKeys.length) {
      res.status(400).json(jiraError(['CSV contains no issue keys']));
      return;
    }
    const job = await startImport(req.actor!.user.id, {
      fixture,
      projectKeys,
      dryRun: parsed.data.dryRun,
      source: 'csv',
    });
    res.status(202).json(await getImport(job.id));
  })
);

// 039 — CSV preview: header→field mapping + first N rows, no import.
migrationRouter.post(
  '/migration/csv/preview',
  ah(async (req, res) => {
    const schema = z.object({ csv: z.string().min(1), maxRows: z.number().int().min(1).max(50).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { previewCsv } = await import('../import/csvSource.js');
    res.json(previewCsv(parsed.data.csv, parsed.data.maxRows ?? 10));
  })
);

// 039 — Jira Server/DC XML backup (zip with entities.xml) → fixture → pipeline.
migrationRouter.post(
  '/migration/jira-server-xml',
  ah(async (req, res) => {
    const parsed = xmlSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { xmlBackupToFixture } = await import('../import/xmlSource.js');
    const { fixture } = await xmlBackupToFixture(Buffer.from(parsed.data.zipBase64, 'base64'));
    const projectKeys = parsed.data.projectKeys?.length
      ? parsed.data.projectKeys
      : [
          ...new Set(
            (fixture['/rest/api/3/search'] as { issues: { key: string }[] }).issues.map((i) => i.key.split('-')[0])
          ),
        ];
    if (!projectKeys.length) {
      res.status(400).json(jiraError(['Backup contains no issues']));
      return;
    }
    const job = await startImport(req.actor!.user.id, {
      fixture,
      projectKeys,
      dryRun: parsed.data.dryRun,
      source: 'jira-server-xml',
    });
    res.status(202).json(await getImport(job.id));
  })
);

// 039 — round-trip export: project → Jira-Cloud-shaped fixture JSON.
// Feeds straight back into POST /migration/jira-cloud {fixture}.
migrationRouter.get(
  '/migration/export/:projectKey',
  ah(async (req, res) => {
    const { projectToFixture } = await import('../import/export.js');
    const fixture = await projectToFixture(ps(req.params.projectKey));
    res.json({ projectKey: ps(req.params.projectKey), fixture });
  })
);

migrationRouter.get(
  '/migration/:id',
  ah(async (req, res) => {
    res.json(await getImport(ps(req.params.id)));
  })
);

migrationRouter.post(
  '/migration/:id/resume',
  ah(async (req, res) => {
    await resumeImport(ps(req.params.id));
    res.status(202).json(await getImport(ps(req.params.id)));
  })
);
