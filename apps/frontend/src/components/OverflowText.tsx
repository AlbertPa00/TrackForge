import { useEffect, useState } from 'react';

/**
 * Text that truncates (single line) or clamps (multi-line) and reveals its
 * full content via a `title` tooltip — but only when actually clipped, so
 * fitting text never fires a redundant tooltip.
 *
 * The tooltip is a convenience, not the sole carrier: the full text must
 * always be reachable elsewhere (detail page, profile, …).
 */
export default function OverflowText({
  text,
  title,
  className = '',
  as: Tag = 'span',
}: {
  text: string;
  /** Tooltip text when clipped; defaults to `text`. */
  title?: string;
  className?: string;
  as?: 'span' | 'div' | 'p';
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Horizontal clip (truncate) and vertical clip (line-clamp) both count.
    const check = () =>
      setClipped(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, text]);

  return (
    <Tag ref={setEl} className={className} title={clipped ? (title ?? text) : undefined}>
      {text}
    </Tag>
  );
}
