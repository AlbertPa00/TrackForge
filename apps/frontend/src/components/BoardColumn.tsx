import { useState, type ReactNode } from 'react';

export default function BoardColumn({
  name,
  count,
  max,
  violated,
  onDropCard,
  children,
}: {
  name: string;
  count: number;
  max?: number;
  violated?: boolean;
  onDropCard: () => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);

  return (
    // flex-1 basis-0: columns stretch to share the row width (Jira), min-w keeps
    // horizontal scroll usable when many columns overflow.
    <section className="flex-1 basis-0 min-w-[240px] flex flex-col">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onDropCard();
        }}
        className={`flex-1 rounded-lg p-1.5 min-h-[160px] transition-colors ${
          over ? 'bg-atl-b-50 ring-2 ring-atl-b-200' : 'bg-atl-card'
        }`}
      >
        <header className="flex items-center gap-2 px-1.5 pt-1 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-atl-n-100">{name}</h2>
          <span
            className={`text-xs font-medium ${
              violated ? 'text-atl-r-500 font-semibold' : 'text-atl-n-100'
            }`}
          >
            {count}
            {max !== undefined ? ` / ${max}` : ''}
            {violated ? ' MAX' : ''}
          </span>
        </header>
        <div className="space-y-2">{children}</div>
      </div>
    </section>
  );
}
