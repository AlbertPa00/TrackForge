import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  attachmentPath,
  deleteAttachment,
  fetchAttachmentMeta,
  uploadAttachments,
  type Attachment,
  type Issue,
} from '../api/client.js';
import { useQuery } from '@tanstack/react-query';
import Modal from './Modal.js';
import { useIssueWrite } from '../lib/useIssueWrite.js';
import { useIssuePermissions } from '../hooks/usePermissions.js';
import { formatDate } from '../lib/format.js';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ mime }: { mime: string }) {
  const letter =
    mime === 'application/pdf' ? 'PDF' : mime.startsWith('text/') ? 'TXT' : mime.includes('zip') ? 'ZIP' : 'FILE';
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded bg-atl-n-30 text-[9px] font-bold text-atl-n-200">
      {letter.slice(0, 4)}
    </span>
  );
}

/** "Attachments" panel — drag-drop upload, image thumbs + lightbox, file list, delete (Sprint 018). */
export default function AttachmentsPanel({ issue }: { issue: Issue }) {
  const markWrite = useIssueWrite(issue.key);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data: meta } = useQuery({ queryKey: ['attachmentMeta'], queryFn: fetchAttachmentMeta });
  const { can, me } = useIssuePermissions(issue.key);
  const canAdd = can('CREATE_ATTACHMENTS');
  const canDeleteAttachment = (a: Attachment) =>
    can('DELETE_ALL_ATTACHMENTS') || (a.author.accountId === me?.accountId && can('DELETE_OWN_ATTACHMENTS'));

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadAttachments(issue.key, files),
    onSuccess: () => {
      setErr(null);
      markWrite();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachment(id),
    onSuccess: () => {
      markWrite();
    },
  });

  const doUpload = (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list];
    if (meta?.uploadLimit) {
      const big = files.find((f) => f.size > meta.uploadLimit);
      if (big) {
        setErr(`'${big.name}' exceeds the ${fmtSize(meta.uploadLimit)} attachment limit.`);
        return;
      }
    }
    upload.mutate(files);
  };

  // Issue-view action bar dispatches tf:attach:<key> to open the picker.
  useEffect(() => {
    const ev = `tf:attach:${issue.key}`;
    const open = () => {
      if (canAdd) inputRef.current?.click();
    };
    window.addEventListener(ev, open);
    return () => window.removeEventListener(ev, open);
  }, [issue.key, canAdd]);

  const attachments = issue.fields.attachment ?? [];
  const images = attachments.filter((a) => IMAGE_MIMES.has(a.mimeType));
  const files = attachments.filter((a) => !IMAGE_MIMES.has(a.mimeType));

  return (
    <section className="mt-6" data-tf-attachments>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-atl-n-300">Attachments</h2>
        {canAdd && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-xs text-atl-b-300 hover:underline"
          >
            Add attachment
          </button>
        )}
      </div>

      {canAdd && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            doUpload(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`mb-3 cursor-pointer rounded border-2 border-dashed px-4 py-5 text-center text-sm transition-colors ${
            dragging
              ? 'border-atl-b-300 bg-atl-b-50 text-atl-b-300'
              : 'border-atl-n-40 text-atl-n-200 hover:border-atl-n-50'
          }`}
        >
          {upload.isPending ? 'Uploading…' : 'Drop files to attach, or click to browse'}
          {meta?.uploadLimit ? <span className="ml-1 text-xs">(max {fmtSize(meta.uploadLimit)})</span> : null}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          doUpload(e.target.files);
          e.target.value = '';
        }}
      />
      {err && <p className="mb-2 text-xs text-atl-r-400">{err}</p>}

      {images.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              title={a.filename}
              onClick={() => setLightbox(a)}
              className="group relative h-20 w-24 overflow-hidden rounded border border-atl-n-30 bg-atl-n-10"
            >
              {a.thumbnail ? (
                <img
                  src={attachmentPath(a.thumbnail)}
                  alt={a.filename}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center">
                  <FileIcon mime={a.mimeType} />
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-left text-[10px] text-white opacity-0 group-hover:opacity-100">
                {a.filename}
              </span>
            </button>
          ))}
        </div>
      )}

      {attachments.length === 0 ? (
        <p className="text-sm text-atl-n-100 italic">None</p>
      ) : (
        <ul className="divide-y divide-atl-n-20 rounded border border-atl-n-30">
          {files.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-atl-n-10">
              <FileIcon mime={a.mimeType} />
              <div className="min-w-0 flex-1">
                <a
                  href={attachmentPath(a.content)}
                  download={a.filename}
                  title={a.filename}
                  className="block truncate text-sm text-atl-b-300 hover:underline"
                >
                  {a.filename}
                </a>
                <p className="text-[11px] text-atl-n-100">
                  {fmtSize(a.size)} · {a.author.displayName} · {formatDate(a.created)}
                </p>
              </div>
              {canDeleteAttachment(a) && (
                <button
                  type="button"
                  onClick={() => remove.mutate(a.id)}
                  className="text-xs text-atl-n-200 hover:text-atl-r-400"
                  aria-label={`Delete ${a.filename}`}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {images.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-atl-n-10">
              <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded bg-atl-n-20">
                {a.thumbnail ? (
                  <img src={attachmentPath(a.thumbnail)} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <FileIcon mime={a.mimeType} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setLightbox(a)}
                  title={a.filename}
                  className="block truncate text-sm text-atl-b-300 hover:underline"
                >
                  {a.filename}
                </button>
                <p className="text-[11px] text-atl-n-100">
                  {fmtSize(a.size)} · {a.author.displayName} · {formatDate(a.created)}
                </p>
              </div>
              <a
                href={attachmentPath(a.content)}
                download={a.filename}
                className="text-xs text-atl-n-200 hover:text-atl-b-300"
                aria-label={`Download ${a.filename}`}
              >
                ↓
              </a>
              {canDeleteAttachment(a) && (
                <button
                  type="button"
                  onClick={() => remove.mutate(a.id)}
                  className="text-xs text-atl-n-200 hover:text-atl-r-400"
                  aria-label={`Delete ${a.filename}`}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <Modal open onClose={() => setLightbox(null)}>
          <div className="flex max-h-[80vh] flex-col p-4">
            <img
              src={attachmentPath(lightbox.content)}
              alt={lightbox.filename}
              className="max-h-[70vh] object-contain"
            />
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="truncate text-atl-n-200" title={`${lightbox.filename} · ${fmtSize(lightbox.size)}`}>
                {lightbox.filename} · {fmtSize(lightbox.size)}
              </span>
              <a
                href={attachmentPath(lightbox.content)}
                download={lightbox.filename}
                className="text-atl-b-300 hover:underline"
              >
                Download
              </a>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
