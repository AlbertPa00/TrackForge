import OverflowText from './OverflowText.js';

const CATEGORY_STYLES: Record<string, string> = {
  new: 'bg-atl-lozenge-new text-white',
  indeterminate: 'bg-atl-lozenge-progress text-white',
  done: 'bg-atl-lozenge-done text-white',
};

export default function StatusLozenge({
  name,
  categoryKey,
  className = '',
  title,
}: {
  name: string;
  categoryKey?: string;
  className?: string;
  /** Explicit tooltip (e.g. a wrapping control's action text). Omitted → the
   *  name shows as a title only when actually clipped; null → no tooltip. */
  title?: string | null;
}) {
  const style = CATEGORY_STYLES[categoryKey ?? ''] ?? CATEGORY_STYLES.new;
  return (
    <span
      title={title ?? undefined}
      className={`inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide leading-4 max-w-full min-w-0 ${style} ${className}`}
    >
      {title === undefined ? (
        <OverflowText text={name} className="truncate" />
      ) : (
        <span className="truncate">{name}</span>
      )}
    </span>
  );
}
