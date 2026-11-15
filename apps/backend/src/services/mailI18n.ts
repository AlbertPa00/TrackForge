// Sprint 037 US1-3 — localized email templates. Additive catalogs only:
// recipient locale is used where a catalog exists, en is the fallback.
// Body templates embed {who}/{key} so verb placement can differ per language.

type Vars = Record<string, string | number>;
type Catalog = Record<string, string | ((n: number) => string)>;

const CAT: Record<string, Catalog> = {
  en: {
    'ev.issue_created': '{who} created issue {key}',
    'ev.issue_updated': '{who} updated {key}',
    'ev.issue_assigned': '{who} assigned {key}',
    'ev.comment_created': '{who} commented on {key}',
    'ev.work_logged': '{who} logged work on {key}',
    'ev.issue_deleted': '{who} deleted {key}',
    'ev.agent_question': '{who} — agent asked a question on {key}',
    'ev.agent_stalled': '{who} — agent stalled on {key}',
    'ev.agent_failed': '{who} — agent failed on {key}',
    'ev.generic': '{who} updated {key}',
    'subj.issue_created': 'issue created',
    'subj.issue_updated': 'issue updated',
    'subj.issue_assigned': 'issue assigned',
    'subj.comment_created': 'comment created',
    'subj.work_logged': 'work logged',
    'subj.issue_deleted': 'issue deleted',
    'subj.agent_question': 'agent question',
    'subj.agent_stalled': 'agent stalled',
    'subj.agent_failed': 'agent failed',
    'subj.generic': 'updated',
    viewIssue: 'view issue',
    digestSubject: (n) => `[TrackForge] Daily digest — ${n} update${n === 1 ? '' : 's'}`,
    digestIntro: 'Your daily TrackForge digest:',
    subscriptionSubject: (n) => `[TrackForge] Filter "{name}" — ${n} issue${n === 1 ? '' : 's'}`,
    subscriptionIntro: 'Subscription results for',
    unsubscribe: 'Unsubscribe',
  },
  de: {
    'ev.issue_created': '{who} hat Vorgang {key} erstellt',
    'ev.issue_updated': '{who} hat {key} aktualisiert',
    'ev.issue_assigned': '{who} hat {key} zugewiesen',
    'ev.comment_created': '{who} hat {key} kommentiert',
    'ev.work_logged': '{who} hat Arbeit an {key} protokolliert',
    'ev.issue_deleted': '{who} hat {key} gelöscht',
    'ev.agent_question': '{who} — Agent stellte eine Frage zu {key}',
    'ev.agent_stalled': '{who} — Agent blieb an {key} hängen',
    'ev.agent_failed': '{who} — Agent scheiterte an {key}',
    'ev.generic': '{who} hat {key} aktualisiert',
    'subj.issue_created': 'Vorgang erstellt',
    'subj.issue_updated': 'Vorgang aktualisiert',
    'subj.issue_assigned': 'Vorgang zugewiesen',
    'subj.comment_created': 'Kommentar erstellt',
    'subj.work_logged': 'Arbeit protokolliert',
    'subj.issue_deleted': 'Vorgang gelöscht',
    'subj.agent_question': 'Agentenfrage',
    'subj.agent_stalled': 'Agent hängt',
    'subj.agent_failed': 'Agent fehlgeschlagen',
    'subj.generic': 'aktualisiert',
    viewIssue: 'Vorgang anzeigen',
    digestSubject: (n) => `[TrackForge] Tägliche Zusammenfassung — ${n} Aktualisierung${n === 1 ? '' : 'en'}`,
    digestIntro: 'Ihre tägliche TrackForge-Zusammenfassung:',
    subscriptionSubject: (n) => `[TrackForge] Filter „{name}" — ${n} Vorgang${n === 1 ? '' : 'änge'}`,
    subscriptionIntro: 'Abo-Ergebnisse für',
    unsubscribe: 'Abbestellen',
  },
};

function fill(tpl: string, vars: Vars): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

/** Mail translate — locale-scoped key with en fallback. `n` selects
 * function-valued templates (plurals); vars fill {placeholders}. */
export function mt(locale: string | null | undefined, key: string, vars: Vars = {}): string {
  const lang = locale && CAT[locale] ? locale : 'en';
  const entry = CAT[lang][key] ?? CAT.en[key];
  if (entry === undefined) return key;
  if (typeof entry === 'function') return fill(entry(Number(vars.n ?? 0)), vars);
  return fill(entry, vars);
}
