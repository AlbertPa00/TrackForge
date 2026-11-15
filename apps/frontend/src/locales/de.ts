import { en } from './en.js';

// Proof locale — partial coverage is fine; missing keys fall back to en.
export const de: typeof en = {
  nav: {
    yourWork: 'Ihre Arbeit',
    projects: 'Projekte',
    filters: 'Filter',
    dashboards: 'Dashboards',
    teams: 'Personen',
    create: 'Erstellen',
    search: 'Suchen',
    profile: 'Profil',
    logout: 'Abmelden',
  },
  shortcuts: {
    title: 'Tastaturkürzel',
    close: 'Schließen',
    create: 'Vorgang erstellen',
    search: 'Zur Suche',
    palette: 'Befehlspalette öffnen',
    help: 'Diese Hilfe anzeigen',
    navDashboard: 'Zu „Ihre Arbeit“',
    navIssues: 'Zum Vorgangsnavigator',
    navProjects: 'Zu Projekten',
    nextIssue: 'Nächster Vorgang',
    prevIssue: 'Voriger Vorgang',
    openIssue: 'Vorgang am Cursor öffnen',
    edit: 'Zusammenfassung bearbeiten',
    assign: 'Zuweisen',
    assignMe: 'Mir zuweisen',
    comment: 'Kommentieren',
    disabled: 'Tastaturkürzel sind in Ihren Einstellungen deaktiviert.',
  },
  profile: {
    title: 'Profil',
    preferences: 'Einstellungen',
    security: 'Sicherheit',
    sessions: 'Sitzungen',
    shortcutsEnabled: 'Tastaturkürzel',
    save: 'Einstellungen speichern',
  },
};
