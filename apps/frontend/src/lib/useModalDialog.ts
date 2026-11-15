import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Lifecycle for a native <dialog> opened as a modal: showModal(), focus,
 * and dismissal.
 *
 * - `guarded: false` (default) — sets `closedby="any"`: Esc, back gesture,
 *   and backdrop clicks close natively; the `close` event drives onClose.
 * - `guarded: true` — Esc (`cancel`) and outside pointer presses route
 *   through `onClose` instead of closing natively, so the caller can run a
 *   guard (e.g. unsaved-changes confirm) before actually closing.
 *
 * Outside-click fallback: where `closedby` is unsupported (Safari) or the
 * dialog is guarded, press AND release must land outside the content box,
 * so a text-selection drag ending on the backdrop does not dismiss.
 * jsdom lacks showModal — there we mark the element open and emulate
 * Escape-dismiss on document keydown.
 */
export function useModalDialog({
  ref,
  open,
  onClose,
  guarded = false,
}: {
  ref: RefObject<HTMLDialogElement | null>;
  open: boolean;
  /** Unguarded: called on 'close'. Guarded: called on cancel/outside press. */
  onClose: () => void;
  guarded?: boolean;
}) {
  const cbRef = useRef(onClose);
  cbRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg || !open) return;
    const fire = () => cbRef.current();
    const cleanups: (() => void)[] = [];

    if (guarded) {
      const onCancel = (e: Event) => {
        e.preventDefault();
        fire();
      };
      dlg.addEventListener('cancel', onCancel);
      cleanups.push(() => dlg.removeEventListener('cancel', onCancel));
    } else {
      // Enumerated attr; setAttribute sidesteps JSX typing.
      dlg.setAttribute('closedby', 'any');
      dlg.addEventListener('close', fire);
      cleanups.push(() => dlg.removeEventListener('close', fire));
    }

    if (guarded || !('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const outside = (e: PointerEvent) => {
        const r = dlg.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      const onDown = (e: PointerEvent) => {
        pressedOutside = outside(e);
      };
      const onUp = (e: PointerEvent) => {
        if (pressedOutside && outside(e)) fire();
      };
      dlg.addEventListener('pointerdown', onDown);
      dlg.addEventListener('pointerup', onUp);
      cleanups.push(() => {
        dlg.removeEventListener('pointerdown', onDown);
        dlg.removeEventListener('pointerup', onUp);
      });
    }

    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
      // [autofocus] is handled natively; [data-autofocus] (and dialogs
      // without either) get the old first-focusable behavior.
      const auto = dlg.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      const first = dlg.querySelector<HTMLElement>(FOCUSABLE);
      (auto ?? first ?? dlg).focus();
    } else {
      // jsdom — mark open so children aren't treated as inaccessible.
      dlg.setAttribute('open', '');
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') fire();
      };
      document.addEventListener('keydown', onKey);
      cleanups.push(() => document.removeEventListener('keydown', onKey));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [ref, open, guarded]);
}
