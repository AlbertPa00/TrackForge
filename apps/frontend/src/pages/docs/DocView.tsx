// 050 docs portal — the reading view: breadcrumb, title + description,
// rendered markdown, scroll-spy TOC, copyable code blocks, prev/next pager.
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchDocPage } from '../../api/client.js';
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon } from '../../components/icons.js';
import { Toc } from './Toc.js';
import { flatNav } from './nav.js';
import { useManifest } from './Sidebar.js';
import DOMPurify from 'dompurify';

const COPY_SVG =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg>';
const CHECK_SVG =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8.5 3.5 3.5L13 5"/></svg>';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs a secure context — self-hosted intranets are often
    // plain http, so fall back to the textarea trick.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function DocView() {
  const { slug } = useParams();
  const manifest = useManifest();
  const page = useQuery({
    queryKey: ['doc-page', slug],
    queryFn: () => fetchDocPage(slug!),
    enabled: !!slug,
    retry: false,
  });
  const scrollRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [slug]);

  // Inject copy buttons into server-rendered code blocks.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const added: HTMLElement[] = [];
    root.querySelectorAll('.tf-code').forEach((el) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tf-copy';
      btn.innerHTML = `${COPY_SVG}<span>Copy</span>`;
      btn.addEventListener('click', async () => {
        const code = el.querySelector('pre')?.innerText ?? '';
        const ok = await copyText(code);
        if (!ok) return;
        btn.classList.add('copied');
        btn.innerHTML = `${CHECK_SVG}<span>Copied</span>`;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = `${COPY_SVG}<span>Copy</span>`;
        }, 1600);
      });
      el.appendChild(btn);
      added.push(btn);
    });
    return () => added.forEach((b) => b.remove());
  }, [page.data?.html]);

  if (page.isLoading) {
    return <div className="min-w-0 flex-1 p-10 text-sm text-[var(--d-faint)]">Loading…</div>;
  }
  if (page.isError || !page.data) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-10">
        <div className="text-lg font-semibold text-[var(--d-text)]">Page not found</div>
        <div className="mt-1 text-sm text-[var(--d-muted)]">
          This doc isn't available for your audience level.
        </div>
        <Link to="/docs" className="mt-3 inline-block text-sm text-[var(--d-accent)] hover:underline">
          Back to docs home
        </Link>
      </div>
    );
  }

  const d = page.data;
  const m = manifest.data;
  const nav = m ? flatNav(m) : [];
  const idx = nav.findIndex((n) => n.slug === slug);
  const prev = idx > 0 ? nav[idx - 1] : null;
  const next = idx >= 0 && idx < nav.length - 1 ? nav[idx + 1] : null;
  const sectionLabel = m?.sections[d.section] ?? d.section;

  return (
    <div className="flex min-w-0 flex-1">
      <article ref={scrollRef} className="d-scrollbar min-w-0 flex-1 overflow-y-auto scroll-smooth">
        <div className="mx-auto max-w-[46rem] px-6 pb-16 pt-7 lg:px-10">
          <nav className="flex items-center gap-1.5 text-[13px] text-[var(--d-faint)]" aria-label="Breadcrumb">
            <Link to="/docs" className="hover:text-[var(--d-text)]">Docs</Link>
            <ChevronRightIcon size={11} />
            <span>{sectionLabel}</span>
            {d.audience === 'admin' && <span className="d-chip ml-2">Admin</span>}
          </nav>
          <h1 className="mt-3 text-[30px] font-bold leading-tight tracking-tight text-[var(--d-text)]">
            {d.title}
          </h1>
          {d.description && (
            <p className="mt-2 text-[15px] leading-relaxed text-[var(--d-muted)]">{d.description}</p>
          )}
          <div ref={contentRef} className="tf-docs mt-6" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(d.html) }} />

          {(prev || next) && (
            <div className="mt-14 grid grid-cols-1 gap-3 border-t border-[var(--d-border-soft)] pt-6 sm:grid-cols-2">
              {prev ? (
                <Link to={prev.href} className="d-card d-card-link group p-4 text-left">
                  <div className="flex items-center gap-1.5 text-xs text-[var(--d-faint)]">
                    <ArrowLeftIcon size={12} /> Previous
                  </div>
                  <div className="mt-1 text-sm font-medium text-[var(--d-text)] group-hover:text-[var(--d-accent)]">
                    {prev.title}
                  </div>
                </Link>
              ) : <span />}
              {next && (
                <Link to={next.href} className="d-card d-card-link group p-4 text-left sm:text-right">
                  <div className="flex items-center gap-1.5 text-xs text-[var(--d-faint)] sm:justify-end">
                    Next <ArrowRightIcon size={12} />
                  </div>
                  <div className="mt-1 text-sm font-medium text-[var(--d-text)] group-hover:text-[var(--d-accent)]">
                    {next.title}
                  </div>
                </Link>
              )}
            </div>
          )}
        </div>
      </article>
      <aside className="d-scrollbar hidden w-60 shrink-0 overflow-y-auto border-l border-[var(--d-border-soft)] xl:block">
        <div className="sticky top-0">
          <Toc markdown={d.markdown} scrollRef={scrollRef} />
        </div>
      </aside>
    </div>
  );
}
