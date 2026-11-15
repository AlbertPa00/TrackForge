/** App-wide color-scheme preference. The resolved theme is applied to
 *  <html data-theme> + style.colorScheme so both the --atl-* token palette and
 *  built-in browser UI (scrollbars, form controls, canvas) follow either the OS
 *  setting or the user's override. The same logic runs inline in index.html
 *  before first paint to avoid a flash of the wrong theme. */
export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'tf-theme';
const mq = () => (typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null);

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(pref: ThemePref = getThemePref()): ResolvedTheme {
  return pref === 'system' ? (mq()?.matches ? 'dark' : 'light') : pref;
}

let installed = false;

export function applyTheme(pref: ThemePref = getThemePref()): void {
  installSystemListener();
  const t = resolvedTheme(pref);
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — pref applies for the session only */
  }
  applyTheme(pref);
}

/** matchMedia readers must handle the change event — re-resolve whenever the
 *  OS scheme flips while the pref is 'system'. */
function installSystemListener(): void {
  if (installed) return;
  installed = true;
  mq()?.addEventListener?.('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}
