// Sprint 037 US3 — Jira keyboard shortcuts.
// Never fires inside inputs/textareas/selects/contenteditable; disabled via the
// `shortcuts.enabled` user preference. `?` opens the help overlay.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export const SHORTCUTS_PREF = 'shortcuts.enabled';

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable);
}

export function useGlobalShortcuts(enabled: boolean, onHelp: () => void) {
  const navigate = useNavigate();
  const chord = useRef<string | null>(null);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // browser chords untouched (Cmd+K lives elsewhere)
      if (isEditable(e.target)) return;
      const key = e.key;

      if (chord.current === 'g') {
        chord.current = null;
        if (chordTimer.current) clearTimeout(chordTimer.current);
        if (key === 'd') { e.preventDefault(); navigate('/'); return; }
        if (key === 'i') { e.preventDefault(); navigate('/issues'); return; }
        if (key === 'p') { e.preventDefault(); navigate('/projects'); return; }
      }
      if (key === 'g') {
        chord.current = 'g';
        chordTimer.current = setTimeout(() => { chord.current = null; }, 1000);
        return;
      }

      switch (key) {
        case 'c': e.preventDefault(); window.dispatchEvent(new Event('tf:nav-create')); return;
        case '/': {
          const el = document.querySelector<HTMLElement>('[data-tf-search]');
          if (el) { e.preventDefault(); el.focus(); }
          return;
        }
        case '.': e.preventDefault(); window.dispatchEvent(new Event('tf:open-palette')); return;
        case '?': e.preventDefault(); onHelp(); return;
        case 'j': case 'k':
          window.dispatchEvent(new CustomEvent('tf:list-nav', { detail: { dir: key === 'j' ? 1 : -1 } }));
          return;
        case 'o':
          window.dispatchEvent(new CustomEvent('tf:list-open'));
          return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (chordTimer.current) clearTimeout(chordTimer.current);
    };
  }, [enabled, navigate, onHelp]);
}
