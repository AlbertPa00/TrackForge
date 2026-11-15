// Sprint 064 US2 — scheme allow-list for user-stored URLs rendered as href.
// React does not block `javascript:` in href attributes, so anything stored by
// another user must pass this before it becomes clickable.
const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isSafeHref(raw: string): boolean {
  try {
    return SAFE_HREF_SCHEMES.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}
