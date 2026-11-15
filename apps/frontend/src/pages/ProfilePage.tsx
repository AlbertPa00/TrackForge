import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchProfile,
  updateProfile,
  changePassword,
  fetchSessions,
  revokeSession,
  totpEnroll,
  totpVerify,
  totpDisable,
  fetchPreferences,
  putPreference,
  fetchMyGrants,
  revokeMyGrant,
  fetchNotifyPrefs,
  updateNotifyPrefs,
  type NotifyPrefs,
} from '../api/client.js';
import { SHORTCUTS_PREF } from '../hooks/useGlobalShortcuts.js';
import { DATE_FORMAT_PRESETS, formatDatePattern, formatDateTime } from '../lib/format.js';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.js';
import UserAvatar, { EMOJIS } from '../components/UserAvatar.js';
import { Link } from 'react-router-dom';

/** "Chrome on Windows" from a user-agent string; raw UA stays in the tooltip. */
function describeAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|Python|node|Java\//i.test(ua)
              ? 'API client'
              : 'Unknown browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

const LOCALES = [
  'en-US', 'en-GB', 'en-AU', 'en-CA', 'de-DE', 'es-ES', 'es-MX', 'fr-FR',
  'it-IT', 'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR', 'pt-PT', 'sv-SE',
  'tr-TR', 'zh-CN', 'zh-TW', 'ru-RU',
];
const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Tokyo',
      'Australia/Sydney',
    ];
  }
})();

export default function ProfilePage() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions });
  const grants = useQuery({ queryKey: ['grants'], queryFn: fetchMyGrants });
  const userPrefs = useQuery({ queryKey: ['preferences'], queryFn: fetchPreferences });
  const shortcutsOn = (userPrefs.data as Record<string, unknown> | undefined)?.[SHORTCUTS_PREF] !== false;
  const [prefs, setPrefs] = useState<{
    locale: string;
    timezone: string;
    dateFormat: string;
    avatarEmoji: string | null;
  } | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [backups, setBackups] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['profile'] });
    qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const savePrefs = useMutation({
    mutationFn: updateProfile,
    onSuccess: () => {
      setMsg('Preferences saved.');
      invalidate();
    },
    onError: (e) => setMsg(String(e)),
  });
  const notifyPrefs = useQuery({ queryKey: ['notify-prefs'], queryFn: fetchNotifyPrefs });
  const saveNotify = useMutation({
    mutationFn: (body: NotifyPrefs) => updateNotifyPrefs(body),
    onSuccess: () => {
      setMsg('Notification preferences saved.');
      qc.invalidateQueries({ queryKey: ['notify-prefs'] });
    },
    onError: (e) => setMsg(String(e)),
  });
  const savePw = useMutation({
    mutationFn: () => changePassword(pw.current, pw.next),
    onSuccess: () => {
      setMsg('Password changed. Other sessions were signed out.');
      setPw({ current: '', next: '' });
    },
    onError: (e) => setMsg(String(e)),
  });

  if (profile.isLoading || !profile.data) return <div className="p-8 text-atl-n-200">Loading…</div>;
  const u = profile.data.user;
  const p = prefs ?? {
    locale: u.locale,
    timezone: u.timezone,
    dateFormat: u.dateFormat,
    avatarEmoji: u.avatarEmoji ?? null,
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Profile</h1>
      {msg && <div className="text-sm text-atl-b-300">{msg}</div>}

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800 mb-2 flex items-center gap-2">
          <UserAvatar displayName={u.displayName} emoji={p.avatarEmoji} size={28} />
          {u.displayName} <span className="text-atl-n-200 font-normal">({u.email})</span>
        </h2>
        <div className="mb-3">
          <div className="text-sm text-atl-n-500 mb-1">Avatar</div>
          <div className="flex flex-wrap gap-1">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setPrefs({ ...p, avatarEmoji: e })}
                className={`w-8 h-8 rounded-full text-base leading-none flex items-center justify-center border transition ${
                  p.avatarEmoji === e
                    ? 'border-atl-b-300 bg-atl-b-50 ring-1 ring-atl-b-300'
                    : 'border-transparent hover:bg-atl-n-10'
                }`}
                title={`Choose ${e}`}
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPrefs({ ...p, avatarEmoji: null })}
              className={`h-8 px-2 rounded text-xs border transition ${
                p.avatarEmoji === null
                  ? 'border-atl-b-300 bg-atl-b-50 text-atl-b-300'
                  : 'border-atl-n-30 text-atl-n-200 hover:bg-atl-n-10'
              }`}
            >
              Auto
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-sm">
          <label className="flex flex-col gap-1">
            Locale
            <select
              className="border border-atl-n-40 rounded px-2 py-1.5 bg-atl-paper text-sm shadow-sm focus:outline-none focus:border-atl-b-300"
              value={p.locale}
              onChange={(e) => setPrefs({ ...p, locale: e.target.value })}
            >
              {[...new Set([p.locale, ...LOCALES])].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Timezone
            <select
              className="border border-atl-n-40 rounded px-2 py-1.5 bg-atl-paper text-sm shadow-sm focus:outline-none focus:border-atl-b-300"
              value={p.timezone}
              onChange={(e) => setPrefs({ ...p, timezone: e.target.value })}
            >
              {[...new Set([p.timezone, ...TIMEZONES])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Date format
            <select
              className="border border-atl-n-40 rounded px-2 py-1.5 bg-atl-paper text-sm shadow-sm focus:outline-none focus:border-atl-b-300"
              value={p.dateFormat}
              onChange={(e) => setPrefs({ ...p, dateFormat: e.target.value })}
            >
              {[...new Set([p.dateFormat, ...DATE_FORMAT_PRESETS])].map((f) => (
                <option key={f} value={f}>
                  {formatDatePattern(new Date().toISOString(), f)} ({f})
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-atl-n-800">
          <input
            type="checkbox"
            checked={shortcutsOn}
            onChange={async (e) => {
              await putPreference(SHORTCUTS_PREF, e.target.checked);
              qc.invalidateQueries({ queryKey: ['preferences'] });
            }}
          />
          Enable keyboard shortcuts
        </label>
        <button
          className="mt-3 bg-atl-b-300 text-white rounded px-3 py-1.5 text-sm"
          onClick={() => savePrefs.mutate(p)}
        >
          Save preferences
        </button>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800 mb-2">Notifications</h2>
        {notifyPrefs.data && (
          <NotifySection
            prefs={notifyPrefs.data}
            saving={saveNotify.isPending}
            onSave={(next) => saveNotify.mutate(next)}
          />
        )}
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800 mb-2">Appearance</h2>
        <label className="block text-sm text-atl-n-500 mb-1" htmlFor="theme-pref">
          Theme
        </label>
        <select
          id="theme-pref"
          name="theme-pref"
          className="text-sm border border-atl-n-40 rounded px-2 py-1.5 bg-atl-paper text-atl-n-800"
          value={theme}
          onChange={(e) => {
            const v = e.target.value as ThemePref;
            setTheme(v);
            setThemePref(v);
          }}
        >
          <option value="system">System (follows your OS setting)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-atl-n-800">Your work</h2>
          <Link className="text-sm text-atl-b-300 hover:underline" to="/">
            View {profile.data.openIssues.length} open {profile.data.openIssues.length === 1 ? 'issue' : 'issues'} →
          </Link>
        </div>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4 space-y-3">
        <h2 className="font-medium text-atl-n-800">Security</h2>
        <div className="flex gap-2 text-sm">
          <input
            type="password"
            placeholder="Current password"
            className="border rounded px-2 py-1"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
          <input
            type="password"
            placeholder="New password (8+ chars)"
            className="border rounded px-2 py-1"
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
          />
          <button className="bg-atl-n-20 rounded px-3 py-1" onClick={() => savePw.mutate()}>
            Change
          </button>
        </div>

        <div className="text-sm">
          <span className="font-medium">Two-factor authentication:</span> {u.totpEnabled ? 'enabled' : 'disabled'}
          {!u.totpEnabled && !totp && (
            <button className="ml-2 text-atl-b-300" onClick={async () => setTotp(await totpEnroll())}>
              Set up
            </button>
          )}
          {u.totpEnabled && (
            <button
              className="ml-2 text-atl-r-400"
              onClick={async () => {
                const c = prompt('Enter your current 2FA code');
                if (!c) return;
                await totpDisable(c);
                setMsg('2FA disabled.');
                invalidate();
              }}
            >
              Disable
            </button>
          )}
        </div>
        {totp && (
          <div className="text-sm space-y-1 border rounded p-2">
            <div>
              Scan with your authenticator: <code className="text-xs break-all">{totp.otpauthUrl}</code>
            </div>
            <div className="flex gap-2">
              <input
                className="border rounded px-2 py-1 w-32"
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                className="bg-atl-b-300 text-white rounded px-3 py-1"
                onClick={async () => {
                  const r = await totpVerify(code);
                  setBackups(r.backupCodes);
                  setTotp(null);
                  invalidate();
                }}
              >
                Verify &amp; enable
              </button>
            </div>
          </div>
        )}
        {backups && (
          <div className="text-sm border rounded p-2 bg-atl-n-10">
            <div className="font-medium">Backup codes — saved once, each one-use:</div>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs mt-1">
              {backups.map((b) => (
                <div key={b}>{b}</div>
              ))}
            </div>
            <button className="text-atl-b-300 mt-1" onClick={() => setBackups(null)}>
              Done
            </button>
          </div>
        )}
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800 mb-2">Sessions</h2>
        <ul className="text-sm space-y-1">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <span className="flex-1" title={s.userAgent ?? undefined}>
                {describeAgent(s.userAgent)} · {s.ip ?? '—'} · last seen {formatDateTime(s.lastSeenAt)}
              </span>
              {s.current ? (
                <span className="text-atl-n-200">this session</span>
              ) : (
                <button
                  className="text-atl-r-400"
                  onClick={async () => {
                    await revokeSession(s.id);
                    invalidate();
                  }}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4">
        <h2 className="font-medium text-atl-n-800 mb-2">Connected apps</h2>
        <p className="text-xs text-atl-n-200 mb-2">OAuth2 apps you have authorized to act on your behalf.</p>
        <ul className="text-sm space-y-1">
          {(grants.data?.grants ?? []).map((g) => (
            <li key={g.id} className="flex items-center gap-2">
              <span className="flex-1">
                {g.clientName} <span className="text-atl-n-200 font-mono text-xs">({g.clientId})</span>
                <span className="text-atl-n-200">
                  {' '}
                  · {g.scopes.join(' ')}
                  {g.projectKeys.length ? ` · ${g.projectKeys.join(',')}` : ''}
                </span>
              </span>
              <button
                className="text-atl-r-400"
                onClick={async () => {
                  await revokeMyGrant(g.id);
                  qc.invalidateQueries({ queryKey: ['grants'] });
                }}
              >
                Revoke
              </button>
            </li>
          ))}
          {grants.data && grants.data.grants.length === 0 && <li className="text-atl-n-200">No connected apps.</li>}
        </ul>
      </section>
    </div>
  );
}

// 066 — Jira-parity notification preferences: autowatch toggles (gated
// server-side by issueService/commentService) + digest cadence.
function NotifySection({
  prefs,
  saving,
  onSave,
}: {
  prefs: NotifyPrefs;
  saving: boolean;
  onSave: (next: NotifyPrefs) => void;
}) {
  const [aw, setAw] = useState<Required<NonNullable<NotifyPrefs['autowatch']>>>({
    create: prefs.autowatch?.create !== false,
    comment: prefs.autowatch?.comment !== false,
    assign: prefs.autowatch?.assign !== false,
  });
  const [digest, setDigest] = useState<NotifyPrefs['digest']>(prefs.digest ?? 'immediate');
  // Per-event email matrix — keys mirror mailService.schemeEvent names.
  const EVENT_ROWS = [
    { key: 'issue_created', label: 'Issue created' },
    { key: 'issue_updated', label: 'Issue updated' },
    { key: 'issue_assigned', label: 'Issue assigned' },
    { key: 'issue_deleted', label: 'Issue deleted' },
    { key: 'comment_created', label: 'Comment added' },
    { key: 'work_logged', label: 'Work logged' },
    { key: 'sprint_event', label: 'Sprint events' },
    { key: 'version_event', label: 'Version releases' },
  ];
  const [events, setEvents] = useState<Record<string, boolean>>(
    Object.fromEntries(EVENT_ROWS.map((r) => [r.key, prefs.events?.[r.key]?.email !== false])),
  );
  const rows: { key: keyof typeof aw; label: string }[] = [
    { key: 'create', label: 'Issues I create' },
    { key: 'comment', label: 'Issues I comment on' },
    { key: 'assign', label: 'Issues assigned to me' },
  ];
  return (
    <div className="text-sm space-y-3">
      <div>
        <div className="text-atl-n-500 mb-1">Autowatch — become a watcher on:</div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {rows.map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-atl-n-800 cursor-pointer">
              <input
                type="checkbox"
                checked={aw[r.key]}
                onChange={(e) => setAw({ ...aw, [r.key]: e.target.checked })}
              />
              {r.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="text-atl-n-500 mb-1">Email me about:</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5">
          {EVENT_ROWS.map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-atl-n-800 cursor-pointer">
              <input
                type="checkbox"
                checked={events[r.key]}
                onChange={(e) => setEvents({ ...events, [r.key]: e.target.checked })}
              />
              {r.label}
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-atl-n-800">
        Email cadence
        <select
          className="border border-atl-n-40 rounded px-2 py-1 bg-atl-paper text-sm"
          value={digest}
          onChange={(e) => setDigest(e.target.value as NotifyPrefs['digest'])}
        >
          <option value="immediate">Send immediately</option>
          <option value="daily">Daily digest</option>
        </select>
      </label>
      <button
        className="bg-atl-b-300 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50"
        disabled={saving}
        onClick={() =>
          onSave({
            ...prefs,
            autowatch: aw,
            digest,
            events: Object.fromEntries(
              Object.entries(events).map(([k, v]) => [k, { ...prefs.events?.[k], email: v }]),
            ),
          })
        }
      >
        Save notifications
      </button>
    </div>
  );
}
