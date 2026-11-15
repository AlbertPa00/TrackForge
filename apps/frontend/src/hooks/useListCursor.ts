// Sprint 037 deferred — j/k list cursor. The global shortcuts hook dispatches
// `tf:list-nav` (dir ±1) and `tf:list-open` window events; this hook turns them
// into a row cursor for issue lists. Cursor starts on first j/k press.
// `onMove` fires on every j/k step — Jira loads the issue in the detail pane as
// the cursor moves; surfaces that would navigate away leave it undefined.
import { useEffect, useRef, useState } from 'react';

export function useListCursor(count: number, onOpen: (index: number) => void, onMove?: (index: number) => void) {
  const [cursor, setCursor] = useState<number | null>(null);
  const cursorRef = useRef<number | null>(null);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    const onNav = (e: Event) => {
      const dir = (e as CustomEvent<{ dir: number }>).detail.dir;
      if (count === 0) return;
      const c = cursorRef.current;
      const next = c === null ? (dir > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, c + dir));
      cursorRef.current = next;
      setCursor(next);
      onMove?.(next);
    };
    const onOpenEvt = () => {
      const c = cursorRef.current;
      if (c !== null && c < count) onOpen(c);
    };
    window.addEventListener('tf:list-nav', onNav);
    window.addEventListener('tf:list-open', onOpenEvt);
    return () => {
      window.removeEventListener('tf:list-nav', onNav);
      window.removeEventListener('tf:list-open', onOpenEvt);
    };
  }, [count, onOpen, onMove]);

  // Clamp when the list shrinks beneath the cursor.
  useEffect(() => {
    setCursor((c) => (c !== null && c >= count ? (count ? count - 1 : null) : c));
  }, [count]);

  return cursor;
}
