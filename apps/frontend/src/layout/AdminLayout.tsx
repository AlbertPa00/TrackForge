import { Suspense, useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';

const SECTIONS: {
  title: string;
  items: { to: string; label: string; end?: boolean }[];
}[] = [
  {
    title: 'User management',
    items: [
      { to: '/admin/users', label: 'Users' },
      { to: '/admin/groups', label: 'Groups' },
      // Read-only people directory — distinct from "Users" (account CRUD).
      { to: '/admin/people', label: 'People (view only)' },
    ],
  },
  {
    title: 'Security',
    items: [
      { to: '/admin/tokens', label: 'API tokens' },
      { to: '/admin/audit', label: 'Audit log' },
      { to: '/admin/identity', label: 'Identity' },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { to: '/admin/metadata', label: 'Issue metadata' },
      { to: '/admin/schemes', label: 'Schemes' },
      { to: '/admin/notifications', label: 'Notifications' },
      { to: '/admin/screens', label: 'Screens' },
      { to: '/admin/field-config', label: 'Field configurations' },
      { to: '/admin/projects', label: 'Projects' },
      { to: '/admin/integrations', label: 'Integrations' },
      // Outside /admin paths but inside this shell (042 F-027).
      { to: '/settings/workflows', label: 'Workflows' },
      { to: '/settings/customfields', label: 'Custom fields' },
      { to: '/settings/webhooks', label: 'Webhooks' },
      { to: '/settings/ai', label: 'AI settings' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/admin/system', label: 'System info' },
      { to: '/admin/mail', label: 'Mail' },
      { to: '/admin/organization', label: 'Organization' },
      { to: '/admin/migration', label: 'Migration' },
    ],
  },
];

export default function AdminLayout() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="flex flex-1 min-h-0 relative">
      {/* Mobile nav toggle — sidebar is hidden below md. */}
      <button
        type="button"
        onClick={() => setNavOpen((v) => !v)}
        aria-label="Toggle administration navigation"
        aria-expanded={navOpen}
        className="md:hidden absolute top-2 left-2 z-50 rounded border border-atl-n-40 bg-atl-paper px-2.5 py-1 text-sm font-medium text-atl-n-500 shadow-sm"
      >
        ☰ Admin
      </button>
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="md:hidden fixed inset-0 z-30 bg-black/30"
        />
      )}
      <aside
        className={`w-[240px] shrink-0 border-r border-atl-n-30 bg-atl-paper flex-col overflow-y-auto ${
          navOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-xl' : 'hidden'
        } md:static md:flex md:shadow-none`}
      >
        <div className="px-3 pt-4 pb-3">
          <Link to="/admin/users" className="flex items-center gap-2.5 px-1" onClick={() => setNavOpen(false)}>
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-atl-inverse text-white text-[13px] font-bold shrink-0">
              A
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-atl-n-800">Administration</div>
              <div className="text-xs text-atl-n-100">Site settings</div>
            </div>
          </Link>
        </div>
        {SECTIONS.map((s) => (
          <div key={s.title} className="px-3 pb-2">
            <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
              {s.title}
            </div>
            <nav className="space-y-0.5">
              {s.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setNavOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-1.5 rounded text-sm ${
                      isActive
                        ? 'bg-atl-b-50 text-atl-b-400 font-medium'
                        : 'text-atl-n-500 hover:bg-atl-n-20'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}
        <div className="flex-1" />
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto bg-atl-n-10 pt-10 md:pt-0">
        {/* Inner boundary: lazy admin pages suspend here, not at the app
            shell — the admin sidebar stays mounted during nav. */}
        <Suspense fallback={<div className="p-8 text-sm text-atl-n-300">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
