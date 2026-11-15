// 050 — Docs-as-product: the manifest is the single registry of portal pages.
// Pages are markdown files shipped with the repo; bodies are rendered + sanitized
// server-side so the portal (and MCP tools) never have to trust raw markdown.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';
import type { Actor } from '../lib/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';

export type DocsAudience = 'public' | 'authed' | 'admin';

export interface DocsPageEntry {
  slug: string;
  title: string;
  section: string;
  audience: DocsAudience;
  source: string;
  /** One-line summary shown under the page title, on landing cards and in search. */
  description?: string;
  ownerSprint?: string;
}

export interface DocsSectionMeta {
  description?: string;
  /** Icon key resolved by the portal's icon map — unknown keys fall back to a book glyph. */
  icon?: string;
}

export interface DocsManifest {
  version: number;
  sections: Record<string, string>;
  /** Optional presentation metadata per section (landing cards, sidebar). */
  sectionMeta?: Record<string, DocsSectionMeta>;
  pages: DocsPageEntry[];
}

export function docsRoot(): string {
  // src/services -> repo docs/. DOCS_DIR lets packaged deployments point at a
  // docs bundle shipped next to the artifact (043 release hook).
  return process.env.DOCS_DIR ?? fileURLToPath(new URL('../../../../docs/', import.meta.url));
}

function sourcePath(source: string): string {
  const root = resolve(docsRoot());
  const p = resolve(root, source);
  if (!p.startsWith(root + sep)) throw new JiraApiError(404, jiraError(['Doc page not found.']));
  return p;
}

let manifestCache: DocsManifest | null = null;
export function loadManifest(): DocsManifest {
  if (manifestCache) return manifestCache;
  manifestCache = JSON.parse(readFileSync(join(docsRoot(), 'manifest.json'), 'utf8')) as DocsManifest;
  return manifestCache;
}
export function resetManifestCache() {
  manifestCache = null;
}

function docsPublic(): boolean {
  return String(process.env.DOCS_PUBLIC ?? '').toLowerCase() === 'on';
}

export function audienceAllowed(audience: DocsAudience, actor: Actor | null): boolean {
  if (audience === 'public') return true;
  if (audience === 'admin') return actor?.user.isAdmin === true; // never public, FR-002
  return actor != null || docsPublic(); // authed
}

export function listPages(actor: Actor | null) {
  const m = loadManifest();
  return {
    sections: m.sections,
    sectionMeta: m.sectionMeta ?? {},
    public: docsPublic(),
    pages: m.pages.filter((p) => audienceAllowed(p.audience, actor)),
  };
}

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'em',
    'strong',
    'hr',
    'br',
    'img',
    'details',
    'summary',
    'span',
    'div',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'id', 'class'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    span: ['class'],
    div: ['class', 'data-lang'],
    pre: ['class'],
    '*': ['id'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// GitHub-style admonitions (`> [!NOTE]`) → styled callouts, matching the
// Mintlify/docs.devin.ai convention. Unknown markers stay plain blockquotes.
const CALLOUT_KINDS = new Set(['note', 'tip', 'warning', 'important', 'caution']);
const CALLOUT_RE = /^\s*<p>\[!(\w+)\]\s*/i;

marked.use({
  renderer: {
    // Heading ids use GitHub-style slugification so rendered anchors match the
    // manifest link checker's expectations (US2-1 deep-linkable anchors).
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = text
        .replace(/<[^>]+>/g, '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
      return `<h${depth} id="${id}"><a class="tf-anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>`;
    },
    code({ text, lang }) {
      const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
      let inner = escapeHtml(text);
      if (language && hljs.getLanguage(language)) {
        try {
          inner = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch {
          /* fall back to escaped */
        }
      }
      const label = escapeHtml(language || 'text');
      return `<div class="tf-code" data-lang="${label}"><pre class="tf-pre"><code class="hljs language-${label}">${inner}</code></pre></div>`;
    },
    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      const m = CALLOUT_RE.exec(body);
      if (!m || !CALLOUT_KINDS.has(m[1].toLowerCase())) return `<blockquote>${body}</blockquote>`;
      const kind = m[1].toLowerCase();
      const stripped = body.slice(m[0].length);
      return `<div class="tf-callout tf-callout-${kind}"><div class="tf-callout-title">${m[1].toUpperCase()}</div><p>${stripped}</div>`;
    },
  },
});

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(html, SANITIZE_OPTS);
}

export function getPage(slug: string, actor: Actor | null) {
  const m = loadManifest();
  const entry = m.pages.find((p) => p.slug === slug);
  if (!entry || !audienceAllowed(entry.audience, actor)) {
    // 404 not 403 — don't reveal that an admin page exists (SC-001).
    throw new JiraApiError(404, jiraError(['Doc page not found.']));
  }
  const file = sourcePath(entry.source);
  if (!existsSync(file)) throw new JiraApiError(404, jiraError(['Doc source missing.']));
  const markdown = readFileSync(file, 'utf8');
  return { ...entry, markdown, html: renderMarkdown(markdown) };
}

// Heading anchors for the client-side search index (US2-2: the index is
// served data built from the manifest — works offline on an intranet).
export function searchIndex(actor: Actor | null) {
  const m = loadManifest();
  return m.pages
    .filter((p) => audienceAllowed(p.audience, actor))
    .map((p) => {
      let headings: string[] = [];
      try {
        const md = readFileSync(sourcePath(p.source), 'utf8');
        headings = md
          .split('\n')
          .filter((l) => /^#{1,3}\s/.test(l))
          .map((l) => l.replace(/^#{1,3}\s+/, '').trim())
          .slice(0, 12);
      } catch {
        /* source listed but unreadable — index by title only */
      }
      return { slug: p.slug, title: p.title, section: p.section, headings };
    });
}

// Substring search over source bodies + titles — powers MCP search_docs so
// agents get excerpts, not whole files. Case-insensitive, max 10 hits.
export function searchDocs(query: string, actor: Actor | null) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  const m = loadManifest();
  const hits: { slug: string; title: string; section: string; excerpt: string }[] = [];
  for (const p of m.pages) {
    if (!audienceAllowed(p.audience, actor)) continue;
    let md = '';
    try {
      md = readFileSync(sourcePath(p.source), 'utf8');
    } catch {
      continue;
    }
    const hay = `${p.title}\n${md}`.toLowerCase();
    // Whole-phrase hit wins; otherwise every query term must appear somewhere
    // (words like "api token scopes" rarely appear verbatim in prose).
    let idx = hay.indexOf(q);
    if (idx < 0) {
      if (!terms.every((t) => hay.includes(t))) continue;
      idx = Math.min(...terms.map((t) => hay.indexOf(t)).filter((i) => i >= 0));
    }
    const start = Math.max(0, idx - 80);
    const excerpt =
      (start > 0 ? '…' : '') +
      `${p.title}\n${md}`
        .slice(start, idx + q.length + 160)
        .replace(/\s+/g, ' ')
        .trim() +
      '…';
    hits.push({ slug: p.slug, title: p.title, section: p.section, excerpt });
    if (hits.length >= 10) break;
  }
  return hits;
}
