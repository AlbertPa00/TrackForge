import { ps } from '../lib/validation.js';
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
import { qs } from '../lib/validation.js';

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
    sendReport(res, await getVelocity(req.actor!, ps(req.params.boardId)), String(qs(req.query.format) ?? ''), 'velocity');
  })
);

reportsRouter.get(
  '/board/:boardId/burndown',
  ah(async (req, res) => {
    sendReport(
      res,
      await getBurndown(req.actor!, ps(req.params.boardId), qs(req.query.sprintId) as string | undefined),
      String(qs(req.query.format) ?? ''),
      'burndown'
    );
  })
);

reportsRouter.get(
  '/board/:boardId/sprint/:sprintId/report',
  ah(async (req, res) => {
    sendReport(
      res,
      await getSprintReport(req.actor!, ps(req.params.boardId), ps(req.params.sprintId)),
      String(qs(req.query.format) ?? ''),
      'sprint-report'
    );
  })
);

// --- Sprint 027 additions ---

reportsRouter.get(
  '/epic/:epicKey',
  ah(async (req, res) => {
    sendReport(res, await getEpicReport(req.actor!, ps(req.params.epicKey)), String(qs(req.query.format) ?? ''), 'epic-report');
  })
);

reportsRouter.get(
  '/cfd/:boardId',
  ah(async (req, res) => {
    sendReport(
      res,
      await getCfd(req.actor!, ps(req.params.boardId), Number(qs(req.query.days)) || 30),
      String(qs(req.query.format) ?? ''),
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
        ps(req.params.boardId),
        Number(qs(req.query.days)) || 30,
        Number(qs(req.query.window)) || 7
      ),
      String(qs(req.query.format) ?? ''),
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
      await getPie(req.actor!, String(qs(req.query.jql) ?? ''), String(qs(req.query.statType) ?? 'status')),
      String(qs(req.query.format) ?? ''),
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
        String(qs(req.query.jql) ?? ''),
        String(qs(req.query.xstatType) ?? 'status'),
        String(qs(req.query.ystatType) ?? 'assignee')
      ),
      String(qs(req.query.format) ?? ''),
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
        String(qs(req.query.jql) ?? ''),
        Number(qs(req.query.days)) || 30,
        qs(req.query.cumulative) === 'true'
      ),
      String(qs(req.query.format) ?? ''),
      'created-vs-resolved'
    );
  })
);

reportsRouter.get(
  '/workload',
  ah(async (req, res) => {
    sendReport(
      res,
      await getWorkload(req.actor!, qs(req.query.projectKey) ? String(qs(req.query.projectKey)) : undefined),
      String(qs(req.query.format) ?? ''),
      'workload'
    );
  })
);

reportsRouter.get(
  '/average-age',
  ah(async (req, res) => {
    sendReport(
      res,
      await getAverageAge(req.actor!, qs(req.query.jql) ? String(qs(req.query.jql)) : undefined, Number(qs(req.query.weeks)) || 8),
      String(qs(req.query.format) ?? ''),
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
        qs(req.query.jql) ? String(qs(req.query.jql)) : undefined,
        String(qs(req.query.groupBy) ?? 'priority')
      ),
      String(qs(req.query.format) ?? ''),
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
        versionId: qs(req.query.versionId) ? String(qs(req.query.versionId)) : undefined,
        sprintId: qs(req.query.sprintId) ? String(qs(req.query.sprintId)) : undefined,
        projectKey: qs(req.query.projectKey) ? String(qs(req.query.projectKey)) : undefined,
      }),
      String(qs(req.query.format) ?? ''),
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
        userId: qs(req.query.userId) ? String(qs(req.query.userId)) : null,
        projectKey: qs(req.query.projectKey) ? String(qs(req.query.projectKey)) : undefined,
        from: qs(req.query.from) ? String(qs(req.query.from)) : undefined,
        to: qs(req.query.to) ? String(qs(req.query.to)) : undefined,
      }),
      String(qs(req.query.format) ?? ''),
      'timesheet'
    );
  })
);

reportsRouter.get(
  '/version/:id',
  ah(async (req, res) => {
    sendReport(
      res,
      await getVersionReport(req.actor!, ps(req.params.id)),
      String(qs(req.query.format) ?? ''),
      'version-report'
    );
  })
);

reportsRouter.get(
  '/project/:key',
  ah(async (req, res) => {
    sendReport(
      res,
      await getProjectSummary(ps(req.params.key), req.actor!),
      String(qs(req.query.format) ?? ''),
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
    sendReport(res, await getOrgMetrics(req.actor!), String(qs(req.query.format) ?? ''), 'org-metrics');
  })
);
