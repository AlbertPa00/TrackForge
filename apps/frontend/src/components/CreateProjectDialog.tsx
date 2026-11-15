import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, createProject } from '../api/client.js';
import Modal from './Modal.js';
import { suggestProjectKey } from '../lib/format.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';

export default function CreateProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      navigate(`/projects/${project.key}`);
    },
  });

  const error = mutation.error as ApiError | undefined;
  const keyValid = /^[A-Z][A-Z0-9]{0,9}$/.test(key);

  return (
    <Modal open={open} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !keyValid) return;
          mutation.mutate({ key, name: name.trim(), description: description.trim() || undefined });
        }}
      >
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
          <h2 className="text-lg font-semibold text-atl-n-800">Create project</h2>
          <p className="text-xs text-atl-n-200 mt-1">
            Required fields are marked with an asterisk <span className="text-atl-r-400">*</span>
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
              {error.message}
            </div>
          )}

          <div>
            <label className={LABEL}>
              Name <span className="text-atl-r-400">*</span>
            </label>
            <input
              className={INPUT}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(suggestProjectKey(e.target.value));
              }}
              autoFocus
            />
          </div>

          <div>
            <label className={LABEL}>
              Key <span className="text-atl-r-400">*</span>
            </label>
            <input
              className={`${INPUT} uppercase ${key && !keyValid ? 'border-atl-r-300' : ''}`}
              value={key}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toUpperCase());
              }}
              maxLength={10}
            />
            {key && !keyValid && (
              <p className="text-xs text-atl-r-400 mt-1">
                Key must start with a letter and use only uppercase letters and digits.
              </p>
            )}
          </div>

          <div>
            <label className={LABEL}>Description</label>
            <textarea
              className={`${INPUT} h-20 py-2 resize-y`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-atl-n-30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-[3px] text-sm font-medium text-atl-n-500 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !name.trim() || !keyValid}
            className="h-9 px-4 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white disabled:opacity-60"
          >
            {mutation.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
