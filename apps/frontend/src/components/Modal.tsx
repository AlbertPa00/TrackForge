import { useRef, type ReactNode } from 'react';
import { useModalDialog } from '../lib/useModalDialog.js';

const DEFAULT_BOX =
  'mx-auto mt-16 w-full max-w-[560px] max-h-[calc(100vh-8rem)] overflow-y-auto rounded-md border-0 bg-atl-paper p-0 shadow-2xl';

export default function Modal({
  open,
  onClose,
  children,
  labelledBy,
  label,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 037 a11y — id of the element labelling this dialog. */
  labelledBy?: string;
  /** Accessible name when the dialog has no visible heading. */
  label?: string;
  /** Full replacement for the default box classes (position, size, colors). */
  className?: string;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  useModalDialog({ ref: dlgRef, open, onClose });

  if (!open) return null;

  // No role="dialog"/aria-modal — the native modal provides them. Top-layer
  // rendering gives inert page, focus containment, Esc and focus return;
  // stacked modals (a confirm over a form) are ordered by the top layer, so
  // only the topmost closes on Escape.
  return (
    <dialog
      ref={dlgRef}
      data-tf-modal
      aria-labelledby={labelledBy}
      aria-label={label}
      className={`tf-modal ${className ?? DEFAULT_BOX}`}
    >
      {children}
    </dialog>
  );
}
