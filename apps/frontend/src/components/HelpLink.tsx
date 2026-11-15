// 050 US5-1 — "?" affordance: maps the current route to a doc page/anchor.
// Anchors are GitHub-slugified headings, matching the docs renderer + manifest.
import { Link, useLocation } from 'react-router-dom';

const HELP_MAP: [RegExp, string][] = [
  [/^\/projects\/[^/]+\/board\/settings/, '/docs/page/admin-guide#configuration'],
  [/^\/projects\/[^/]+\/board/, '/docs/page/user-guide#board--backlog'],
  [/^\/projects\/[^/]+\/backlog/, '/docs/page/user-guide#board--backlog'],
  [/^\/projects\/[^/]+\/releases/, '/docs/page/user-guide#releases--components'],
  [/^\/projects\/[^/]+\/components/, '/docs/page/user-guide#releases--components'],
  [/^\/projects\/[^/]+\/automation/, '/docs/page/automation'],
  [/^\/issues|^\/projects\/[^/]+\/issues|^\/projects\/[^/]+\/?$/, '/docs/page/user-guide#searching-jql'],
  [/^\/admin\/migration/, '/docs/page/migration'],
  [/^\/admin\/system/, '/docs/page/admin-guide#troubleshooting'],
  [/^\/settings\/ai/, '/docs/page/ai'],
  [/^\/settings\/workflows/, '/docs/page/admin-guide#configuration'],
  [/^\/settings\/customfields/, '/docs/page/fields'],
  [/^\/settings\/webhooks/, '/docs/page/webhooks'],
  [/^\/profile/, '/docs/page/identity#profile--preferences'],
];

export default function HelpLink({ dark = false }: { dark?: boolean }) {
  const { pathname } = useLocation();
  if (pathname.startsWith('/docs') || pathname.startsWith('/login')) return null;
  const hit = HELP_MAP.find(([re]) => re.test(pathname));
  return (
    <Link
      to={hit?.[1] ?? '/docs'}
      title={`Help — ${hit ? 'related doc' : 'documentation home'}`}
      className={`mx-1.5 flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold ${
        dark
          ? 'border-white/40 text-white/70 hover:border-white hover:text-white'
          : 'border-atl-n-60 text-atl-n-300 hover:border-atl-b-400 hover:text-atl-b-600'
      }`}
    >
      ?
    </Link>
  );
}
