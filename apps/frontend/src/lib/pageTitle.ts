/** Maps a pathname to a page title (without the " - TrackForge" suffix). */
export function pageTitleFor(pathname: string): string {
  const seg = pathname.split('/').filter(Boolean);

  // Project-scoped routes: /projects/:key/<page>
  if (seg[0] === 'projects' && seg[2]) {
    const page = seg[2];
    const map: Record<string, string> = {
      board: seg[3] === 'settings' ? 'Board settings' : 'Board',
      backlog: 'Backlog',
      issues: 'Issues',
      roadmap: 'Timeline',
      reports: 'Reports',
      releases: 'Releases',
      components: 'Components',
      settings: 'Project settings',
      automation: 'Automation',
    };
    return map[page] ?? 'Project';
  }
  if (seg[0] === 'projects') return 'Projects';

  const map: Record<string, string> = {
    '': 'Your work',
    yourwork: 'Your work',
    'your-work': 'Your work',
    issues: 'Issues',
    teams: 'People',
    filters: 'Filters',
    dashboards: seg[1] ? 'Dashboard' : 'Dashboards',
    browse: seg[1] ?? 'Issue',
    approvals: 'Approvals',
    profile: 'Profile',
    connect: 'Connect',
    login: 'Log in',
    docs: 'Documentation',
  };
  if (seg[0] === 'admin') {
    const admin: Record<string, string> = {
      '': 'Administration',
      users: 'User management',
      groups: 'Groups',
      people: 'People directory',
      tokens: 'Access tokens',
      audit: 'Audit log',
      metadata: 'Issue metadata',
      schemes: 'Permission schemes',
      notifications: 'Notification schemes',
      screens: 'Screens',
      'field-config': 'Field configurations',
      projects: 'Projects',
      mail: 'Mail',
      organization: 'Organization',
      identity: 'Identity',
      integrations: 'Integrations',
      migration: 'Migration',
      system: 'System',
    };
    return admin[seg[1] ?? ''] ?? 'Administration';
  }
  if (seg[0] === 'settings') {
    const settings: Record<string, string> = {
      ai: 'AI settings',
      webhooks: 'Webhooks',
      customfields: 'Custom fields',
      workflows: seg[2] ? 'Workflow editor' : 'Workflows',
    };
    return settings[seg[1] ?? ''] ?? 'Settings';
  }
  return map[seg[0] ?? ''] ?? 'TrackForge';
}
