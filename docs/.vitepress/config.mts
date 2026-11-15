import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const here = dirname(fileURLToPath(import.meta.url));

interface ManifestPage {
  slug: string;
  title: string;
  section: string;
  audience: 'public' | 'authed' | 'admin';
  source: string;
  description?: string;
}
interface Manifest {
  sections: Record<string, string>;
  sectionMeta?: Record<string, { description?: string; icon?: string }>;
  pages: ManifestPage[];
}

const manifest = JSON.parse(readFileSync(join(here, '..', 'manifest.json'), 'utf8')) as Manifest;

/**
 * The public site publishes the full operator-facing surface — admin and ops
 * docs are a selling point for self-hosted evaluation. The denylist holds
 * internal working documents (audit findings, hardening debt) that must never
 * ship publicly regardless of their manifest audience. sprints/ and
 * research/ are excluded at the source level below.
 */
const DENYLIST = new Set([
  'pre-release-audit',
  'ui-release-readiness-audit',
  'hardening-backlog',
]);

const denySources = manifest.pages
  .filter((p) => DENYLIST.has(p.slug))
  .map((p) => p.source);

const SECTION_ORDER = [
  'overview',
  'user-guide',
  'admin',
  'ops',
  'migration',
  'api',
  'releases',
  'dev',
];

function sidebar() {
  const published = manifest.pages.filter((p) => !DENYLIST.has(p.slug));
  const groups = SECTION_ORDER.filter((s) => s in manifest.sections).map((section) => ({
    text: manifest.sections[section]!,
    collapsed: section !== 'overview' && section !== 'user-guide',
    items: published
      .filter((p) => p.section === section)
      .map((p) => ({ text: p.title, link: `/${p.source.replace(/\.md$/, '')}` })),
  }));
  for (const g of groups) {
    if (g.text === manifest.sections['api']) {
      g.items.unshift({ text: 'REST API explorer', link: '/api' });
    }
  }
  return groups.filter((g) => g.items.length > 0);
}

export default withMermaid(
  defineConfig({
    title: 'TrackForge',
    titleTemplate: ':title · TrackForge Docs',
    description:
      'Self-hosted Jira-compatible issue tracker where AI agents are first-class users — scoped tokens, governed work loops, and a first-party MCP server.',
    base: process.env.DOCS_BASE ?? '/',
    cleanUrls: true,
    lastUpdated: true,
    // Repo-relative links (./sprints/*, ../specs/*, ../DESIGN) are valid on
    // GitHub but aren't site pages — skip those, keep checking absolute
    // site links so nav/sidebar integrity is still enforced.
    ignoreDeadLinks: [/^(?!\/)/],
    srcExclude: [
      'sprints/**',
      'research/**',
      'public/**',
      'node_modules/**',
      ...denySources,
    ],

    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      ['meta', { name: 'theme-color', content: '#0C66E4' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:title', content: 'TrackForge — agent-native issue tracking' }],
      [
        'meta',
        {
          property: 'og:description',
          content:
            'Self-hosted Jira-compatible issue tracker where AI agents are first-class users. JQL, MCP-native, governed write loop.',
        },
      ],
      [
        'meta',
        {
          property: 'og:image',
          content:
            'https://raw.githubusercontent.com/AlbertPa00/TrackForge/main/docs/assets/screenshots/board.png',
        },
      ],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ],

    themeConfig: {
      logo: { src: '/logo.svg', width: 26, height: 26 },
      siteTitle: 'TrackForge',

      nav: [
        { text: 'Get started', link: '/install' },
        { text: 'User guide', link: '/user-guide' },
        { text: 'API', link: '/api' },
        { text: 'Ops', link: '/deployment' },
        {
          text: 'More',
          items: [
            { text: 'Roadmap', link: '/roadmap' },
            { text: 'vs the field', link: '/positioning' },
            { text: 'Jira compatibility', link: '/compatibility' },
            { text: 'GitHub', link: 'https://github.com/AlbertPa00/TrackForge' },
          ],
        },
      ],

      sidebar: sidebar(),

      socialLinks: [{ icon: 'github', link: 'https://github.com/AlbertPa00/TrackForge' }],

      editLink: {
        pattern: 'https://github.com/AlbertPa00/TrackForge/edit/main/docs/:path',
        text: 'Edit this page on GitHub',
      },

      search: { provider: 'local' },

      outline: { level: 'deep', label: 'On this page' },

      docFooter: { prev: 'Previous', next: 'Next' },

      footer: {
        message:
          'Jira, JQL, and Atlassian are trademarks of Atlassian Corporation Pty Ltd. TrackForge is an independent project.',
        copyright: 'TrackForge contributors',
      },
    },

    markdown: {
      theme: { light: 'github-light', dark: 'github-dark' },
      image: { lazyLoading: true },
    },

    mermaid: {
      theme: 'base',
      themeVariables: {
        primaryColor: '#E9F2FF',
        primaryBorderColor: '#0C66E4',
        primaryTextColor: '#172B4D',
        lineColor: '#5E6C84',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      },
      flowchart: { useMaxWidth: true, htmlLabels: true },
      sequence: { useMaxWidth: true },
    },
    mermaidPlugin: { class: 'mermaid' },
  }),
);
