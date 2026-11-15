import { diffLines } from '../lib/diff.js';

/** 058 US4 — compact unified diff used for AI draft previews. */
export default function DiffView({ before, after }: { before: string; after: string }) {
  const rows = diffLines(before, after);
  return (
    <pre className="rounded border border-atl-n-30 bg-atl-n-10 p-2.5 text-[12px] leading-5 overflow-auto max-h-64 whitespace-pre-wrap break-words">
      {rows.map((r, i) => (
        <div
          key={i}
          className={
            r.type === 'add'
              ? 'bg-atl-g-50 text-atl-g-600'
              : r.type === 'del'
                ? 'bg-atl-r-50 text-atl-r-500 line-through decoration-atl-r-300'
                : 'text-atl-n-600'
          }
        >
          <span className="select-none mr-1.5 text-atl-n-300">
            {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}
          </span>
          {r.text}
        </div>
      ))}
    </pre>
  );
}
