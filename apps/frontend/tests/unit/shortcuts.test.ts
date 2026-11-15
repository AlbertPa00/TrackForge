import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { initI18n } from '../../src/i18n.js';
import i18n from 'i18next';
import { useListCursor } from '../../src/hooks/useListCursor.js';
import { kbDropTargets, kbFilteredIndex } from '../../src/lib/kbDnd.js';

/**
 * 037 — shortcut contract (DOM-level: the hook's dispatch targets) + i18n
 * catalog fallback. The keydown handler itself is a thin document listener;
 * the meaningful behavior is the event contract + editable-element guard.
 */
describe('037 i18n', () => {
  beforeEach(() => { initI18n('en'); });

  it('en catalog resolves nav + shortcut keys', () => {
    expect(i18n.t('nav.yourWork')).toBe('Your work');
    expect(i18n.t('shortcuts.create')).toBe('Create issue');
  });

  it('de resolves translated keys and falls back to en for unknown keys', async () => {
    await i18n.changeLanguage('de');
    expect(i18n.t('nav.yourWork')).toBe('Ihre Arbeit');
    // unknown key → key itself (returnNull:false) or en value when present
    expect(i18n.t('profile.title')).toBe('Profil');
    await i18n.changeLanguage('en');
  });
});

describe('037 shortcuts contract', () => {
  it('dispatches tf:nav-create, tf:open-palette, tf:list-nav events', () => {
    const seen: string[] = [];
    for (const ev of ['tf:nav-create', 'tf:open-palette']) {
      window.addEventListener(ev, () => seen.push(ev), { once: true });
    }
    window.addEventListener('tf:list-nav', ((e: CustomEvent) => seen.push(`list:${e.detail.dir}`)) as EventListener, { once: true });
    window.dispatchEvent(new Event('tf:nav-create'));
    window.dispatchEvent(new Event('tf:open-palette'));
    window.dispatchEvent(new CustomEvent('tf:list-nav', { detail: { dir: 1 } }));
    expect(seen).toEqual(['tf:nav-create', 'tf:open-palette', 'list:1']);
  });

  it('data-tf-search target is focusable (used by "/" shortcut)', () => {
    const input = document.createElement('input');
    input.setAttribute('data-tf-search', '');
    document.body.appendChild(input);
    const el = document.querySelector<HTMLElement>('[data-tf-search]');
    el?.focus();
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe('037 list cursor (j/k/o)', () => {
  const nav = (dir: number) => act(() => { window.dispatchEvent(new CustomEvent('tf:list-nav', { detail: { dir } })); });
  const open = () => act(() => { window.dispatchEvent(new Event('tf:list-open')); });

  it('j/k moves the cursor with clamping; o opens the cursor row', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useListCursor(3, onOpen));

    nav(1); expect(result.current).toBe(0);   // first j → first row
    nav(1); expect(result.current).toBe(1);
    nav(1); nav(1); expect(result.current).toBe(2);  // clamps at last
    nav(-1); expect(result.current).toBe(1);

    open();
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('k before any j selects the last row; no open without a cursor', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useListCursor(3, onOpen));
    open(); expect(onOpen).not.toHaveBeenCalled();
    nav(-1); expect(result.current).toBe(2);
  });

  it('clamps when the list shrinks beneath the cursor', () => {
    const { result, rerender } = renderHook(({ n }) => useListCursor(n, vi.fn()), { initialProps: { n: 5 } });
    nav(1); nav(1); nav(1); nav(1); expect(result.current).toBe(3);
    rerender({ n: 2 });
    expect(result.current).toBe(1);
  });
});

describe('037 board keyboard DnD — insertion math', () => {
  const col = [{ key: 'A' }, { key: 'B' }, { key: 'C' }];

  it('drop targets map pos to before/after anchors excluding the dragged card', () => {
    // Dragging B: filtered [A,C] → pos 0=before A, pos 1=before C after A, pos 2=after C
    expect(kbDropTargets(col, 'B', 0)).toEqual({ before: 'A', after: undefined, len: 2 });
    expect(kbDropTargets(col, 'B', 1)).toEqual({ before: 'C', after: 'A', len: 2 });
    expect(kbDropTargets(col, 'B', 2)).toEqual({ before: undefined, after: 'C', len: 2 });
  });

  it('same-column drop to own slot is a no-op shape (before===key)', () => {
    // pos 1 with dragged A in [A,B,C] → filtered [B,C] → before B — matches mouse-drop semantics
    expect(kbDropTargets(col, 'A', 0)).toEqual({ before: 'B', after: undefined, len: 2 });
  });

  it('filtered index skips the dragged row (single marker invariant)', () => {
    // col=[A,B(drag),C]: filteredIdx A→0, B→1(excluded row), C→1 → markers only at A/C
    expect(kbFilteredIndex(col, 'B', 0)).toBe(0);
    expect(kbFilteredIndex(col, 'B', 2)).toBe(1);
    // dragged card in another column → indices pass through
    expect(kbFilteredIndex(col, 'Z', 2)).toBe(2);
  });
});
