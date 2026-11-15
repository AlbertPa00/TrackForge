import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Hover intent: don't fire on pointer pass-through; give a grace period to
// move into the card (WCAG 1.4.13 — content on hover must be hoverable).
const OPEN_DELAY = 350;
const CLOSE_DELAY = 250;
const CARD_W = 340;

/**
 * Shared interaction shell for hover/focus preview cards (issue, user, …).
 * Opens after a hover-intent delay on pointer enter or keyboard focus, stays
 * open while the pointer is inside the card, and closes on leave / Escape /
 * scroll / resize. The card is a portal at document.body positioned below the
 * trigger (flipped above when it would run off-viewport) and marked
 * `aria-hidden` — it must only ever repeat information reachable elsewhere.
 */
export default function HoverCard({
  children,
  renderCard,
  onOpenChange,
  anchorClassName = '',
}: {
  children: React.ReactNode;
  /** Card body — rendered only while open (lazy content goes here). */
  renderCard: () => React.ReactNode;
  /** Notified when the card opens/closes — lets callers gate lazy fetches. */
  onOpenChange?: (open: boolean) => void;
  /** Extra classes on the anchor span — e.g. `shrink-0` when the trigger is
   *  atomic (issue key): a squeezed wrapper would let the child paint over
   *  neighboring flex items instead of shrinking it. */
  anchorClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openT = useRef<number>(0);
  const closeT = useRef<number>(0);

  useEffect(
    () => () => {
      window.clearTimeout(openT.current);
      window.clearTimeout(closeT.current);
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  const cancel = () => {
    window.clearTimeout(openT.current);
    window.clearTimeout(closeT.current);
  };
  const scheduleOpen = () => {
    cancel();
    openT.current = window.setTimeout(() => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      // Below the trigger; flip above when the card would run off-viewport.
      const below = r.bottom + 8 + 220 <= window.innerHeight;
      setPos({
        top: below ? r.bottom + 6 : undefined,
        bottom: below ? undefined : window.innerHeight - r.top + 6,
        left: Math.min(Math.max(8, r.left), window.innerWidth - CARD_W - 8),
      });
      setOpen(true);
    }, OPEN_DELAY);
  };
  const scheduleClose = () => {
    cancel();
    closeT.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
  };

  return (
    <span
      ref={anchorRef}
      className={`inline-flex min-w-0 ${anchorClassName}`}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
    >
      {children}
      {open &&
        pos &&
        createPortal(
          <div
            className="fixed z-[70] w-[340px] rounded-md border border-atl-n-30 bg-atl-paper p-3 shadow-2xl"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
            onMouseEnter={cancel}
            onMouseLeave={scheduleClose}
            // Supplemental duplicate of the destination page — kept out of the
            // a11y tree rather than double-announced; nothing inside is the
            // sole carrier of information.
            aria-hidden="true"
          >
            {renderCard()}
          </div>,
          document.body
        )}
    </span>
  );
}

export { OPEN_DELAY, CLOSE_DELAY };
