import { Router, type Router as RouterType } from 'express';
import type { Response } from 'express';
import {
  getBurndown,
  getSprintReport,
  getVelocity,
  getCfd,
  getControlChart,
  getEpicReport,
  REPORT_REGISTRY,
  getPie,
  getTwoDimensional,
  getCreatedVsResolved,
  getWorkload,
  getAverageAge,
  getResolutionTime,
  getTimeTracking,
  getTimesheet,
  getVersionReport,
  getProjectSummary,
  getOrgMetrics,
} from '../services/reportService.js';
import { jiraError } from '../lib/errors.js';
import { ah, sendCsv } from '../lib/http.js';

export const reportsRouter: RouterType = Router();

/** `?format=csv` — the JSON series flattened to rows (RFC-4180 + BOM, same as 023 exports). */
function sendReport(res: Response, data: unknown, format: string, filename: string) {
  if (format === 'csv') {
    sendCsv(res, filename, toRows(data));
    return;
  }
  res.json(data);
}

/** Flatten the JSON payload into rows for CSV export. */
function toRows(data: unknown): unknown[][] {
  const d = data as Record<string, unknown>;
  const rows: unknown[][] = [];
  if (Array.isArray(d.series)) {
    // burndown + cfd
    const cols = (d.columns as string[] | undefined) ?? ['remaining', 'scope', 'done'];
    rows.push(['date', ...cols]);
    for (const p of d.series as Record<string, unknown>[]) {
      const counts = p.counts as Record<string, number> | undefined;
      rows.push([p.date, ...cols.map((c) => (counts ? (counts[c] ?? 0) : (p[c] ?? '')))]);
    }
  } else if (Array.isArray(d.sprints)) {
    rows.push(['sprint', 'committedPoints', 'completedPoints', 'issueCount']);
    for (const s of d.sprints as Record<string, unknown>[]) {
      const sp = s.sprint as { name?: string };
      rows.push([sp?.name, s.committedPoints, s.completedPoints, s.issueCount]);
    }
  } else if (d.mean !== undefined && Array.isArray(d.issues)) {
    rows.push(['key', 'summary', 'cycleDays', 'completedAt']);
    for (const i of d.issues as Record<string, unknown>[]) rows.push([i.key, i.summary, i.cycleDays, i.completedAt]);
  } else if (Array.isArray(d.issues) && d.totals === undefined) {
    rows.push(['key', 'summary', 'type', 'status', 'points', 'done', 'addedAfterStart']);
    for (const i of d.issues as Record<string, unknown>[])
      rows.push([i.key, i.summary, i.type, i.status, i.points, i.done, i.addedAfterStart]);
  } else if (d.remainingIssues !== undefined) {
    rows.push(['key', 'summary', 'status', 'points']);
    for (const i of d.remainingIssues as Record<string, unknown>[]) rows.push([i.key, i.summary, i.status, i.points]);
  } else if (d.statType !== undefined && Array.isArray(d.groups)) {
    // pie
    rows.push([d.statType, 'count']);
    for (const g of d.groups as Record<string, unknown>[]) rows.push([g.name, g.count]);
  } else if (Array.isArray(d.xLabels) && Array.isArray(d.yLabels)) {
    // two-dimensional — one row per y label, one col per x label
    const xs = d.xLabels as string[];
    const cells = d.cells as Record<string, number>;
    rows.push([d.ystatType ?? 'y', ...xs, 'total']);
    for (const y of d.yLabels as string[]) {
      const counts = xs.map((x) => cells[JSON.stringify([x, y])] ?? 0);
      rows.push([y, ...counts, counts.reduce((a, b) => a + b, 0)]);
    }
  } else if (Array.isArray(d.users) && d.totalsByDay !== undefined) {
    // timesheet — one row per user per day
    rows.push(['user', 'date', 'sec']);
    for (const u of d.users as { user: string; days: Record<string, number> }[]) {
      for (const [date, sec] of Object.entries(u.days)) rows.push([u.user, date, sec]);
    }
    rows.push(['total', '', d.users ? (d.users as { totalSec: number }[]).reduce((a, u) => a + u.totalSec, 0) : '']);
  } else if (Array.isArray(d.users)) {
    // workload
    rows.push(['user', 'openIssues', 'points', 'remainingEstimateSec']);
    for (const u of d.users as Record<string, unknown>[])
      rows.push([u.user, u.openIssues, u.points, u.remainingEstimateSec]);
  } else if (Array.isArray(d.buckets)) {
    // average age
    rows.push(['bucket', 'issues', 'avgAgeDays']);
    for (const b of d.buckets as Record<string, unknown>[]) rows.push([b.bucket, b.issues, b.avgAgeDays]);
  } else if (Array.isArray(d.groups)) {
    // resolution time
    rows.push([d.groupBy ?? 'group', 'issues', 'avgDays']);
    for (const g of d.groups as Record<string, unknown>[]) rows.push([g.name, g.issues, g.avgDays]);
  } else if (d.totals !== undefined && Array.isArray(d.issues)) {
    // time tracking
    rows.push(['key', 'summary', 'done', 'originalEstimateSec', 'timeSpentSec', 'remainingEstimateSec']);
    for (const i of d.issues as Record<string, unknown>[])
      rows.push([i.key, i.summary, i.done, i.originalEstimateSec, i.timeSpentSec, i.remainingEstimateSec]);
  } else if (d.version !== undefined && d.percentDone !== undefined) {
    // version report
    const v = d.version as Record<string, unknown>;
    const f = d.forecast as Record<string, unknown> | undefined;
    rows.push([
      'version',
      v.name,
      'percentDone',
      d.percentDone,
      'issues',
      d.issues,
      'doneIssues',
      d.doneIssues,
      'remainingPoints',
      d.remainingPoints,
      'predictedDate',
      f?.predictedDate ?? '',
    ]);
  } else if (d.project !== undefined && Array.isArray(d.byStatus)) {
    // project summary — section dump
    rows.push(['section', 'name', 'value']);
    rows.push(['count', 'openIssues', d.openIssues]);
    for (const s of (d.byStatus as { name: string; count: number }[]) ?? []) rows.push(['status', s.name, s.count]);
    for (const t of (d.byType as { name: string; count: number }[]) ?? []) rows.push(['type', t.name, t.count]);
    for (const p of (d.byPriority as { name: string; count: number }[]) ?? []) rows.push(['priority', p.name, p.count]);
  } else if (d.issueGrowth30d !== undefined && d.totals !== undefined) {
    // org metrics
    const t = d.totals as Record<string, unknown>;
    rows.push(['metric', 'value'], ['issues', t.issues], ['projects', t.projects], ['users', t.users]);
    for (const [date, n] of Object.entries(d.issueGrowth30d as Record<string, number>))
      rows.push([`growth ${date}`, '', n]);
    for (const a of (d.activityByType as { type: string; count: number }[]) ?? [])
      rows.push(['activity', a.type, a.count]);
  }
  return rows;
}

// Registry — lists every report type with params/scope/formats (A3).
reportsRouter.get('/', (_req, res) => {
  res.json({ reports: REPORT_REGISTRY });
});

reportsRouter.get(
  '/board/:boardId/velocity',
  ah(async (req, res) => {
    sendReport(res, await getVelocity(req.actor!, req.params.boardId), String(req.query.format ?? ''), 'velocity');
  })
);

reportsRouter.get(
  '/board/:boardId/burndown',
  ah(async (req, res) => {
    sendReport(
      res,
      await getBurndown(req.actor!, req.params.boardId, req.query.sprintId as string | undefined),
      String(req.query.format ?? ''),
      'burndown'
    );
  })
);

reportsRouter.get(
  '/board/:boardId/sprint/:sprintId/report',
  ah(async (req, res) => {
    sendReport(
      res,
      await getSprintReport(req.actor!, req.params.boardId, req.params.sprintId),
      String(req.query.format ?? ''),
      'sprint-report'
    );
  })
);

// --- Sprint 027 additions ---

reportsRouter.get(
  '/epic/:epicKey',
  ah(async (req, res) => {
    sendReport(res, await getEpicReport(req.actor!, req.params.epicKey), String(req.query.format ?? ''), 'epic-report');
  })
);

reportsRouter.get(
  '/cfd/:boardId',
  ah(async (req, res) => {
    sendReport(
      res,
      await getCfd(req.actor!, req.params.boardId, Number(req.query.days) || 30),
      String(req.query.format ?? ''),
      'cfd'
    );
  })
);

reportsRouter.get(
  '/control/:boardId',
  ah(async (req, res) => {
    sendReport(
      res,
      await getControlChart(
        req.actor!,
        req.params.boardId,
        Number(req.query.days) || 30,
        Number(req.query.window) || 7
      ),
      String(req.query.format ?? ''),
      'control-chart'
    );
  })
);

// --- Sprint 028: general, time & release reports ---

reportsRouter.get(
  '/pie',
  ah(async (req, res) => {
    sendReport(
      res,
      await getPie(req.actor!, String(req.query.jql ?? ''), String(req.query.statType ?? 'status')),
      String(req.query.format ?? ''),
      'pie'
    );
  })
);

reportsRouter.get(
  '/two-dimensional',
  ah(async (req, res) => {
    sendReport(
      res,
      await getTwoDimensional(
        req.actor!,
        String(req.query.jql ?? ''),
        String(req.query.xstatType ?? 'status'),
        String(req.query.ystatType ?? 'assignee')
      ),
      String(req.query.format ?? ''),
      'two-dimensional'
    );
  })
);

reportsRouter.get(
  '/created-vs-resolved',
  ah(async (req, res) => {
    sendReport(
      res,
      await getCreatedVsResolved(
        req.actor!,
        String(req.query.jql ?? ''),
        Number(req.query.days) || 30,
        req.query.cumulative === 'true'
      ),
      String(req.query.format ?? ''),
      'created-vs-resolved'
    );
  })
);

reportsRouter.get(
  '/workload',
  ah(async (req, res) => {
    sendReport(
      res,
      await getWorkload(req.actor!, req.query.projectKey ? String(req.query.projectKey) : undefined),
      String(req.query.format ?? ''),
      'workload'
    );
  })
);

reportsRouter.get(
  '/average-age',
  ah(async (req, res) => {
    sendReport(
      res,
      await getAverageAge(req.actor!, req.query.jql ? String(req.query.jql) : undefined, Number(req.query.weeks) || 8),
      String(req.query.format ?? ''),
      'average-age'
    );
  })
);

reportsRouter.get(
  '/resolution-time',
  ah(async (req, res) => {
    sendReport(
      res,
      await getResolutionTime(
        req.actor!,
        req.query.jql ? String(req.query.jql) : undefined,
        String(req.query.groupBy ?? 'priority')
      ),
      String(req.query.format ?? ''),
      'resolution-time'
    );
  })
);

reportsRouter.get(
  '/time-tracking',
  ah(async (req, res) => {
    sendReport(
      res,
      await getTimeTracking(req.actor!, {
        versionId: req.query.versionId ? String(req.query.versionId) : undefined,
        sprintId: req.query.sprintId ? String(req.query.sprintId) : undefined,
        projectKey: req.query.projectKey ? String(req.query.projectKey) : undefined,
      }),
      String(req.query.format ?? ''),
      'time-tracking'
    );
  })
);

reportsRouter.get(
  '/timesheet',
  ah(async (req, res) => {
    sendReport(
      res,
      await getTimesheet(req.actor!, {
        userId: req.query.userId ? String(req.query.userId) : null,
        projectKey: req.query.projectKey ? String(req.query.projectKey) : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
      String(req.query.format ?? ''),
      'timesheet'
    );
  })
);

reportsRouter.get(
  '/version/:id',
  ah(async (req, res) => {
    sendReport(
      res,
      await getVersionReport(req.actor!, req.params.id),
      String(req.query.format ?? ''),
      'version-report'
    );
  })
);

reportsRouter.get(
  '/project/:key',
  ah(async (req, res) => {
    sendReport(
      res,
      await getProjectSummary(req.params.key, req.actor!),
      String(req.query.format ?? ''),
      'project-summary'
    );
  })
);

// Admin-gated instance aggregates (028 US4).
reportsRouter.get(
  '/org',
  ah(async (req, res) => {
    if (!req.actor?.user.isAdmin) {
      res.status(403).json(jiraError(['Administrator access required.']));
      return;
    }
    sendReport(res, await getOrgMetrics(req.actor!), String(req.query.format ?? ''), 'org-metrics');
  })
);
