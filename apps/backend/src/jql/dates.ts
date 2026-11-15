// Date evaluation for JQL: relative dates, absolute dates and date functions,
// resolved in the caller's time zone (User.timeZone).

import type { JqlRelativeDate } from './ast.js';

/** ms offset of `timeZone` at `date` (positive = ahead of UTC). */
export function tzOffsetMs(timeZone: string, date: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') === 24 ? 0 : get('hour'),
      get('minute'),
      get('second')
    );
    return asUtc - date.getTime();
  } catch {
    return 0; // unknown zone → UTC
  }
}

/** Wall-clock fields of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string) {
  const shifted = new Date(date.getTime() + tzOffsetMs(timeZone, date));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** UTC instant for a local wall-clock time in `timeZone`. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, ss: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m, d, hh, mm, ss));
  // correct for the zone offset at that instant (one iteration suffices — offsets are stable)
  const off = tzOffsetMs(timeZone, guess);
  return new Date(guess.getTime() - off);
}

export type DateFunction =
  | 'now'
  | 'startofday'
  | 'endofday'
  | 'startofweek'
  | 'endofweek'
  | 'startofmonth'
  | 'endofmonth';

export function evalDateFunction(name: DateFunction, arg: number | undefined, now: Date, timeZone: string): Date {
  const { year, month, day } = zonedParts(now, timeZone);
  const off = arg ?? 0;
  switch (name) {
    case 'now':
      return now;
    case 'startofday':
      return zonedToUtc(year, month, day + off, 0, 0, 0, timeZone);
    case 'endofday':
      return zonedToUtc(year, month, day + off, 23, 59, 59, timeZone);
    case 'startofweek': {
      // week starts Monday (Jira default)
      const local = new Date(Date.UTC(year, month, day));
      const dow = (local.getUTCDay() + 6) % 7; // Mon=0
      return zonedToUtc(year, month, day - dow + off * 7, 0, 0, 0, timeZone);
    }
    case 'endofweek': {
      const local = new Date(Date.UTC(year, month, day));
      const dow = (local.getUTCDay() + 6) % 7;
      return zonedToUtc(year, month, day - dow + 6 + off * 7, 23, 59, 59, timeZone);
    }
    case 'startofmonth':
      return zonedToUtc(year, month + off, 1, 0, 0, 0, timeZone);
    case 'endofmonth':
      return zonedToUtc(year, month + off + 1, 0, 23, 59, 59, timeZone);
  }
}

const UNIT_MS: Record<JqlRelativeDate['unit'], number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

export function evalRelativeDate(rel: JqlRelativeDate, now: Date): Date {
  return new Date(now.getTime() + rel.amount * UNIT_MS[rel.unit]);
}

export interface ParsedAbsoluteDate {
  /** [start, end) — day-precision values span the whole day */
  start: Date;
  end: Date;
  precision: 'day' | 'minute';
}

/** Parse `"2026-11-01"` or `"2026-11-01 14:00"` in the caller's zone. */
export function parseAbsoluteDate(raw: string, timeZone: string): ParsedAbsoluteDate | null {
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (day) {
    const [, y, m, d] = day.map(Number);
    const start = zonedToUtc(y, m - 1, d, 0, 0, 0, timeZone);
    return { start, end: zonedToUtc(y, m - 1, d + 1, 0, 0, 0, timeZone), precision: 'day' };
  }
  const dt = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (dt) {
    const y = Number(dt[1]);
    const m = Number(dt[2]) - 1;
    const d = Number(dt[3]);
    const hh = Number(dt[4]);
    const mm = Number(dt[5]);
    const ss = Number(dt[6] ?? 0);
    const start = zonedToUtc(y, m, d, hh, mm, ss, timeZone);
    return {
      start,
      end: new Date(start.getTime() + (dt[6] ? 1_000 : 60_000)),
      precision: 'minute',
    };
  }
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) {
    const start = new Date(iso);
    return { start, end: new Date(iso + 60_000), precision: 'minute' };
  }
  return null;
}
