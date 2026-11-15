// Date-only fields (duedate, releaseDate, sprint dates…) arrive as YYYY-MM-DD.
// `new Date('YYYY-MM-DD')` parses as UTC midnight — in western timezones the
// value displays one day early. Parse those as local dates instead.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(iso: string): Date {
  if (DATE_ONLY.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(iso);
}

export function formatDate(iso: string) {
  return parseDate(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string) {
  return parseDate(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Compact relative time for list rows — falls back to the date past a week. */
let rtf: Intl.RelativeTimeFormat | null = null;
export function formatRelative(iso: string) {
  // Intl.RelativeTimeFormat localizes the output (this module otherwise
  // emitted English-only strings despite the app shipping i18next locales).
  rtf ??= new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
  const diff = Date.now() - parseDate(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return rtf.format(0, 'second');
  if (m < 60) return rtf.format(-m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 7) return rtf.format(-d, 'day');
  return formatDate(iso);
}

/** Compact duration for logged seconds — "8h 30m", "45m" (worklog totals). */
export function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m ? `${m}m` : ''}`.trim() : `${m}m`;
}

/** Jira-style date patterns ("d/MMM/yy"). Longer tokens match first. */
export function formatDatePattern(iso: string, pattern: string) {
  const d = parseDate(iso);
  const tokens: Record<string, string> = {
    dd: String(d.getDate()).padStart(2, '0'),
    d: String(d.getDate()),
    MMM: d.toLocaleString(undefined, { month: 'short' }),
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    yyyy: String(d.getFullYear()),
    yy: String(d.getFullYear()).slice(2),
  };
  return pattern.replace(/yyyy|yy|MMM|MM|dd|d/g, (t) => tokens[t] ?? t);
}

/** Presets offered on the Profile page (Jira offers similar choices). */
export const DATE_FORMAT_PRESETS = [
  'd/MMM/yy',
  'dd/MMM/yyyy',
  'MMM d, yyyy',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd',
];

export function suggestProjectKey(name: string) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (letters.length >= 2) return letters.slice(0, 10);
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}
