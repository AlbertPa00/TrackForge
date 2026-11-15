// 050 docs portal — "On this page" rail with scroll-spy highlighting.
import { useEffect, useMemo, useState, type RefObject } from 'react';

interface TocEntry { text: string; id: string; depth: number }

function parseHeadings(markdown: string): TocEntry[] {
  return markdown.split('\n').filter((l) => /^#{2,3}\s/.test(l)).map((l) => {
    const text = l.replace(/^#{2,3}\s+/, '').trim();
    const id = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    return { text, id, depth: l.startsWith('###') ? 3 : 2 };
  });
}

export function Toc({ markdown, scrollRef }: { markdown: string; scrollRef: RefObject<HTMLElement | null> }) {
  const headings = useMemo(() => parseHeadings(markdown), [markdown]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !headings.length) return;
    const onScroll = () => {
      const rootTop = root.getBoundingClientRect().top;
      let current: string | null = null;
      for (const h of headings) {
        const el = root.querySelector<HTMLElement>(`#${CSS.escape(h.id)}`);
        if (el && el.getBoundingClientRect().top - rootTop <= 96) current = h.id;
      }
      setActive(current ?? headings[0]?.id ?? null);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [headings, scrollRef]);

  if (headings.length < 2) return null;
  return (
    <div className="px-5 py-8">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--d-faint)]">
        On this page
      </div>
      <div className="mt-2 border-l border-[var(--d-border-soft)]">
        {headings.map((h) => (
          <a
            key={h.id}
            href={`#${h.id}`}
            className={`-ml-px block border-l-2 py-1 text-[13px] leading-snug transition-colors ${
              h.depth === 3 ? 'pl-6' : 'pl-3'
            } ${
              active === h.id
                ? 'border-[var(--d-accent)] font-medium text-[var(--d-accent)]'
                : 'border-transparent text-[var(--d-muted)] hover:text-[var(--d-text)]'
            }`}
          >
            {h.text}
          </a>
        ))}
      </div>
    </div>
  );
}
