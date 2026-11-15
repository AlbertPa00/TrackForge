// Sprint 064 US2 — scheme allow-list for user-stored URLs that are rendered as
// hrefs (remote links, url-type custom fields, dev-panel items). `javascript:`,
// `data:`, `vbscript:` etc. must never become clickable — React does not block
// them and same-origin script URLs bypass httpOnly cookies entirely.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isAllowedExternalUrl(raw: string): boolean {
  try {
    return SAFE_URL_SCHEMES.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

export const ALLOWED_URL_SCHEMES_LABEL = 'http, https, mailto';
