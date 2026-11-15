// Sprint 037 US3-1 — `?` help overlay listing the Jira shortcut set.
import { useTranslation } from 'react-i18next';
import Modal from './Modal.js';

const ROWS: { keys: string[]; labelKey: string }[] = [
  { keys: ['c'], labelKey: 'shortcuts.create' },
  { keys: ['/'], labelKey: 'shortcuts.search' },
  { keys: ['.'], labelKey: 'shortcuts.palette' },
  { keys: ['g', 'd'], labelKey: 'shortcuts.navDashboard' },
  { keys: ['g', 'i'], labelKey: 'shortcuts.navIssues' },
  { keys: ['g', 'p'], labelKey: 'shortcuts.navProjects' },
  { keys: ['j'], labelKey: 'shortcuts.nextIssue' },
  { keys: ['k'], labelKey: 'shortcuts.prevIssue' },
  { keys: ['o'], labelKey: 'shortcuts.openIssue' },
  { keys: ['e'], labelKey: 'shortcuts.edit' },
  { keys: ['a'], labelKey: 'shortcuts.assign' },
  { keys: ['i'], labelKey: 'shortcuts.assignMe' },
  { keys: ['m'], labelKey: 'shortcuts.comment' },
  { keys: ['?'], labelKey: 'shortcuts.help' },
];

export default function ShortcutsHelp({ open, onClose, enabled }: { open: boolean; onClose: () => void; enabled: boolean }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} labelledBy="shortcuts-title">
      <div className="p-4">
        <h2 id="shortcuts-title" className="text-base font-semibold text-atl-n-800 mb-3">
          {t('shortcuts.title')}
        </h2>
        {!enabled && <p className="text-sm text-atl-n-200 mb-3">{t('shortcuts.disabled')}</p>}
        <table className="w-full text-sm">
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.labelKey} className="border-b border-atl-n-20 last:border-0">
                <td className="py-1.5 w-32">
                  {r.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="text-atl-n-200 mx-1">then</span>}
                      <kbd className="px-1.5 py-0.5 rounded bg-atl-n-10 border border-atl-n-40 font-mono text-xs">{k}</kbd>
                    </span>
                  ))}
                </td>
                <td className="py-1.5 text-atl-n-800">{t(r.labelKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={onClose}
          className="mt-3 h-8 px-3 rounded bg-atl-n-20 hover:bg-atl-n-30 text-sm text-atl-n-800"
        >
          {t('shortcuts.close')}
        </button>
      </div>
    </Modal>
  );
}
