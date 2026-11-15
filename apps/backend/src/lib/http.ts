// Sprint 065 US3 — single source for per-route HTTP boilerplate. Every helper
// exists because hand-rolled copies had already diverged across routes:
// 11 wrap/ah copies, 5 dryRun spellings, ~18 divergent page caps, 4 CSV
// emitters (one without escaping), ~15 inline `self:` URL templates, ~19
// `toISOString().slice(0,10)` date truncations. Route files reach for these;
// they do not re-implement them locally.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { publicBaseUrl } from '../config.js';
import { JiraApiError, jiraError } from './errors.js';
import { formatZodErrors } from './validation.js';

/** Express 4 drops async throws — wrap every async handler so JiraApiError
 *  reaches the error middleware instead of hanging the request. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res, next).catch(next);
  };

/** `?dryRun=true` (also `'1'` / `body.dryRun` for bulk ops) — the only
 *  accepted spellings on mutating endpoints. */
export function isDryRun(req: Request): boolean {
  const q = String((req.query as Record<string, unknown>).dryRun ?? '');
  if (q === 'true' || q === '1') return true;
  const b = req.body as { dryRun?: unknown } | undefined;
  return typeof b === 'object' && b !== null && b.dryRun === true;
}

/** Marks the response as a dry-run preview. Routes still return their
 *  `{dryRun: true, ...}` body — this is the machine-readable header twin. */
export function markDryRun(res: Response): void {
  res.setHeader('X-TrackForge-DryRun', 'true');
}

/** Jira paging: `?startAt` (>=0, default 0) + `?maxResults` (1..cap). */
export function pageParams(
  req: Request,
  opts: { cap: number; default?: number }
): { startAt: number; maxResults: number } {
  return {
    startAt: Math.max(0, Number(req.query.startAt) || 0),
    maxResults: Math.min(opts.cap, Math.max(1, Number(req.query.maxResults) || (opts.default ?? 50))),
  };
}

function badRequest(parsed: z.SafeParseError<unknown>): never {
  throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
}

/** Body parse → 400 with Jira field-error shape (never an unhandled 500). */
export function parseBody<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) badRequest(parsed);
  return parsed.data;
}

/** Query parse — same 400 shape as parseBody, for GET-style endpoints. */
export function parseQuery<S extends z.ZodType>(schema: S, req: Request): z.infer<S> {
  const parsed = schema.safeParse(req.query ?? {});
  if (!parsed.success) badRequest(parsed);
  return parsed.data;
}

// ---------- `self` links ----------

/** Resource `self` link — every Jira object embeds one; build it in one place. */
export function resourceSelf(path: string): string {
  return `${publicBaseUrl()}${path}`;
}

export const issueSelf = (key: string): string => resourceSelf(`/rest/api/2/issue/${key}`);

export const userSelf = (accountId: string): string => resourceSelf(`/rest/api/2/user?accountId=${accountId}`);

// ---------- CSV (RFC-4180 + UTF-8 BOM, same as 023 exports) ----------

/** Escape one cell: unwrap Jira-shaped objects/arrays to a scalar, neutralize
 *  spreadsheet formula injection, quote when it contains `"`, `,`, or a
 *  newline; double inner quotes. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(v)) s = v.map(csvCell).join(',');
    else s = String(o.name ?? o.displayName ?? o.value ?? o.key ?? '');
  } else s = String(v);
  // 064 US6 — a `=cmd|'/c calc'!A1` cell executes when opened in Excel/Sheets.
  // Prefixing with a quote renders it inert.
  if (/^[\t\r ]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text with BOM so Excel reads UTF-8. */
export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** Send rows as a CSV attachment (`name` may omit the `.csv` extension). */
export function sendCsv(res: Response, name: string, rows: unknown[][]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name.endsWith('.csv') ? name : `${name}.csv`}"`);
  res.send(toCsv(rows));
}

// ---------- Jira date shape ----------

/** Jira date-only fields (duedate, releaseDate, startDate) are `YYYY-MM-DD`. */
export const jiraDate = (d: Date): string => d.toISOString().slice(0, 10);
