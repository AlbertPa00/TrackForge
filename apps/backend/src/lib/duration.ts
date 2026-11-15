// Sprint 024 — Jira duration grammar (`w d h m`), both directions.
// Workday assumptions come from the instance time-tracking config (§13.3).

export interface TimeTrackingConfig {
  /** Working hours per day (Jira default 8). */
  hoursPerDay: number;
  /** Working days per week (Jira default 5). */
  daysPerWeek: number;
  /** 'pretty' = "1w 2d 3h"; 'hours' = decimal hours ("25.5h"). */
  format: 'pretty' | 'hours';
  /** Unit used when nothing is set (informational, Jira parity). */
  defaultUnit: 'm' | 'h' | 'd' | 'w';
}

export const DEFAULT_TIME_CONFIG: TimeTrackingConfig = {
  hoursPerDay: 8,
  daysPerWeek: 5,
  format: 'pretty',
  defaultUnit: 'h',
};

const UNIT_SECONDS_BASE = { w: 0, d: 0, h: 3600, m: 60 } as const;

function unitSeconds(unit: 'w' | 'd' | 'h' | 'm', cfg: TimeTrackingConfig): number {
  switch (unit) {
    case 'w':
      return cfg.daysPerWeek * cfg.hoursPerDay * 3600;
    case 'd':
      return cfg.hoursPerDay * 3600;
    case 'h':
      return 3600;
    case 'm':
      return 60;
  }
  void UNIT_SECONDS_BASE;
}

const TOKEN_RE = /(\d+(?:\.\d+)?)\s*([wdhm])/g;

/**
 * Parse a Jira duration string ("2w 1d 3h 30m", also glued "2h30m") into
 * seconds. Returns null for invalid input. Zero is a valid parse result —
 * callers decide whether 0 is acceptable (worklogs reject it).
 */
export function parseDuration(input: string, cfg: TimeTrackingConfig = DEFAULT_TIME_CONFIG): number | null {
  const s = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  let total = 0;
  let consumed = 0;
  let matched = false;
  for (const m of s.matchAll(TOKEN_RE)) {
    // Tokens must be contiguous (single spaces allowed) — otherwise "1h foo"
    // would silently parse only part of the string.
    const gap = s.slice(consumed, m.index);
    if (gap.trim() !== '') return null;
    total += Number(m[1]) * unitSeconds(m[2] as 'w' | 'd' | 'h' | 'm', cfg);
    consumed = m.index! + m[0].length;
    matched = true;
  }
  if (!matched || s.slice(consumed).trim() !== '') return null;
  return Math.round(total);
}

/** Format seconds as Jira duration: pretty "1w 2d 3h 30m" or hours "25.5h". */
export function formatDuration(
  seconds: number | null | undefined,
  cfg: TimeTrackingConfig = DEFAULT_TIME_CONFIG
): string | undefined {
  if (seconds === null || seconds === undefined) return undefined;
  const s = Math.max(0, Math.round(seconds));
  if (cfg.format === 'hours') {
    const h = s / 3600;
    return `${Number.isInteger(h) ? h : Math.round(h * 100) / 100}h`;
  }
  if (s === 0) return '0m';
  const w = Math.floor(s / (cfg.daysPerWeek * cfg.hoursPerDay * 3600));
  const d = Math.floor((s % (cfg.daysPerWeek * cfg.hoursPerDay * 3600)) / (cfg.hoursPerDay * 3600));
  const h = Math.floor((s % (cfg.hoursPerDay * 3600)) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [w ? `${w}w` : '', d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}
