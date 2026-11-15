// 050 — Documentation portal. Public per DOCS_PUBLIC + page audience; the
// backend filters what it serves, the UI renders the manifest. The portal is a
// self-contained surface with its own light/dark theme (.docs-scope tokens).
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { CloseIcon, MenuIcon, MoonIcon, SearchIcon, SunIcon } from '../../components/icons.js';
import { ApiExplorer } from './ApiExplorer.js';
import { DocView } from './DocView.js';
import { Landing } from './Landing.js';
import { SearchPalette } from './SearchPalette.js';
import { Sidebar, SidebarNav } from './Sidebar.js';

type Theme = 'light' | 'dark';
const THEME_KEY = 'tf-docs-theme';

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    // Fall back to the app-wide pref (lib/theme.ts) when no docs override exists.
    const app = localStorage.getItem('tf-theme');
    if (app === 'light' || app === 'dark') return app;
  } catch { /* private mode */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
      className="d-btn-ghost h-8 w-8 justify-center px-0"
    >
      {theme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </button>
  );
}

export default function DocsPortalPage() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const isMac = window.navigator.platform.toUpperCase().includes('MAC');

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`docs-scope ${theme === 'dark' ? 'docs-dark' : ''} flex h-full min-h-screen flex-col bg-[var(--d-bg)] text-[var(--d-text)]`}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--d-border)] bg-[var(--d-raised)] px-4">
        <button
          type="button"
          className="d-btn-ghost h-8 w-8 justify-center px-0 lg:hidden"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(true)}
        >
          <MenuIcon size={16} />
        </button>
        <Link to="/docs" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--d-accent)] text-[13px] font-bold text-white">
            T
          </span>
          <span className="text-[15px] font-bold tracking-tight">TrackForge</span>
          <span className="d-chip hidden sm:inline-flex">Docs</span>
        </Link>

        <div className="mx-auto flex-1 px-2 sm:max-w-xs md:max-w-sm">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="d-input flex items-center gap-2 py-1.5 text-left text-[var(--d-faint)] hover:border-[var(--d-accent)]"
          >
            <SearchIcon size={14} />
            <span className="flex-1 truncate text-[13px]">Search docs…</span>
            <kbd className="d-kbd hidden sm:inline-block">{isMac ? '⌘' : 'Ctrl'}</kbd>
            <kbd className="d-kbd hidden sm:inline-block">K</kbd>
          </button>
        </div>

        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <Link to="/" className="d-btn-ghost hidden sm:inline-flex">Back to app</Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <Routes>
          <Route index element={<Landing onSearch={() => setSearchOpen(true)} />} />
          <Route path="page/:slug" element={<DocView />} />
          <Route path="api" element={<ApiExplorer />} />
          <Route path="*" element={<Landing onSearch={() => setSearchOpen(true)} />} />
        </Routes>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <div className="absolute inset-0 bg-black/45" onClick={() => setDrawerOpen(false)} />
          <aside className="d-scrollbar absolute bottom-0 left-0 top-0 w-72 overflow-y-auto border-r border-[var(--d-border)] bg-[var(--d-raised)]">
            <div className="flex h-14 items-center justify-between border-b border-[var(--d-border-soft)] px-4">
              <span className="text-sm font-semibold">Documentation</span>
              <button
                type="button"
                className="d-btn-ghost h-8 w-8 justify-center px-0"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                <CloseIcon size={15} />
              </button>
            </div>
            <SidebarNav onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
