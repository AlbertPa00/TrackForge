import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { updateSprint, type Issue, type Sprint } from '../api/client.js';
import Modal from './Modal.js';

const ACTION_BTN =
  'h-8 px-3 rounded-[3px] bg-atl-n-30 hover:bg-atl-n-40 text-sm font-medium text-atl-n-600';
const PRIMARY_BTN =
  'h-8 px-3 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white';

export default function CompleteSprintDialog({
  sprint,
  issues,
  futureSprints,
  onClose,
  onError,
  onDone,
}: {
  sprint: Sprint;
  issues: Issue[];
  futureSprints: Sprint[];
  onClose: () => void;
  onError: (e: unknown) => void;
  onDone: () => void;
}) {
  const open = issues.filter((i) => i.fields.status.statusCategory.key !== 'done');
  const done = issues.length - open.length;
  const [target, setTarget] = useState<string>('backlog');
  const complete = useMutation({
    mutationFn: () =>
      updateSprint(sprint.id, {
        state: 'closed',
        moveOpenIssuesTo: target === 'backlog' ? 'backlog' : target === 'new' ? 'new' : target,
      }),
    onError,
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose}>
      <h2 className="px-5 pt-4 pb-2 text-base font-semibold text-atl-n-800">Complete {sprint.name}</h2>
      <div className="px-5 pb-5">
      <p className="text-sm text-atl-n-100 mb-1">
        This sprint contains <strong>{done}</strong> completed issue{done === 1 ? '' : 's'} and{' '}
        <strong>{open.length}</strong> open issue{open.length === 1 ? '' : 's'}.
      </p>
      {open.length > 0 && (
        <>
          <p className="text-xs text-atl-n-200 mb-2">Move open issues to:</p>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full h-8 px-2 mb-4 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper"
          >
            <option value="backlog">Backlog</option>
            <option value="new">New sprint</option>
            {futureSprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="flex justify-end gap-2">
        <button className={ACTION_BTN} onClick={onClose}>
          Cancel
        </button>
        <button className={PRIMARY_BTN} onClick={() => complete.mutate()} disabled={complete.isPending}>
          Complete sprint
        </button>
      </div>
      </div>
    </Modal>
  );
}
