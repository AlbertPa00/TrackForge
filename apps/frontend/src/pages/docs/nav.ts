// 050 docs portal — shared nav model: section order, icon map, page ordering.
import type { ComponentType } from 'react';
import {
  BookIcon, CodeIcon, FlaskIcon, RocketIcon, ServerIcon, ShieldIcon, SwapIcon, TagIcon,
} from '../../components/icons.js';
import type { DocsManifest, DocsPageEntry } from '../../api/client.js';

export const SECTION_ORDER = ['overview', 'user-guide', 'admin', 'ops', 'migration', 'api', 'releases', 'dev'];

const ICON_MAP: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  rocket: RocketIcon,
  book: BookIcon,
  shield: ShieldIcon,
  server: ServerIcon,
  swap: SwapIcon,
  code: CodeIcon,
  tag: TagIcon,
  flask: FlaskIcon,
};

export function sectionIcon(iconKey?: string) {
  return (iconKey && ICON_MAP[iconKey]) || BookIcon;
}

/** Sections in display order: known order first, then any extras the manifest adds. */
export function orderedSections(m: DocsManifest): string[] {
  return [...SECTION_ORDER, ...Object.keys(m.sections).filter((s) => !SECTION_ORDER.includes(s))]
    .filter((s) => s in m.sections);
}

export function pagesInSection(m: DocsManifest, section: string): DocsPageEntry[] {
  return m.pages.filter((p) => p.section === section);
}

/** Flattened page order for prev/next paging. The endpoint explorer rides
 * along as a synthetic entry inside the API section. */
export interface NavItem { slug: string; title: string; href: string }

export function flatNav(m: DocsManifest): NavItem[] {
  const items: NavItem[] = [];
  for (const sec of orderedSections(m)) {
    for (const p of pagesInSection(m, sec)) {
      items.push({ slug: p.slug, title: p.title, href: `/docs/page/${p.slug}` });
    }
    if (sec === 'api') items.push({ slug: '__api', title: 'Endpoint explorer', href: '/docs/api' });
  }
  return items;
}
