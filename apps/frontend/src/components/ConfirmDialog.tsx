import Modal from './Modal.js';

/** Jira-style destructive-confirm dialog — replaces window.confirm. */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Delete',
  danger = true,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  /** False for non-destructive confirms (e.g. "Make admin") — blue button. */
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="tf-confirm-title">
      <div>
        <header className="px-5 py-4 border-b border-atl-n-30">
          <h2 id="tf-confirm-title" className="text-base font-semibold text-atl-n-800">{title}</h2>
        </header>
        <div className="px-5 py-4">
          <div className="text-sm text-atl-n-700">{body}</div>
          {error && <p className="text-xs text-atl-r-500 mt-2">{error}</p>}
        </div>
        <footer className="px-5 py-3 border-t border-atl-n-30 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-atl-n-400 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className={`rounded-[3px] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
              danger ? 'bg-atl-r-400 hover:bg-atl-r-300' : 'bg-atl-b-400 hover:bg-atl-b-500'
            }`}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
