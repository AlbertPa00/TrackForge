// Sprint 044 US5 — opt-in update check. Disabled by default (privacy —
// self-hosted should not phone home unless asked). When UPDATE_CHECK_ENABLED
// is on, a daily durable job fetches UPDATE_CHECK_URL (default: GitHub
// releases/latest for this repo) and stores the result in SystemSetting;
// /admin/system/status surfaces it.
import { getSetting, putSetting } from './settingsService.js';
import { buildMeta } from '../lib/buildInfo.js';

const KEY = 'updatecheck:last';

export interface UpdateCheckResult {
  at: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
  url?: string;
  error?: string;
}

export const updateCheckEnabled = (): boolean => process.env.UPDATE_CHECK_ENABLED === 'true';

const checkUrl = (): string =>
  process.env.UPDATE_CHECK_URL ?? 'https://api.github.com/repos/AlbertPa00/TrackForge/releases/latest';

const parseTag = (body: unknown): { latest: string; url?: string } | null => {
  const b = body as { tag_name?: string; html_url?: string };
  if (!b || typeof b.tag_name !== 'string') return null;
  return { latest: b.tag_name.replace(/^v/, ''), url: b.html_url };
};

/** Numeric semver compare — returns true when `latest` is newer than `current`. */
export const isNewer = (current: string, latest: string): boolean => {
  const c = current.replace(/^v/, '').split(/[.-]/);
  const l = latest.replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < Math.max(c.length, l.length); i += 1) {
    const cn = parseInt(c[i] ?? '0', 10);
    const ln = parseInt(l[i] ?? '0', 10);
    if (Number.isNaN(cn) || Number.isNaN(ln)) return latest !== current;
    if (ln > cn) return true;
    if (ln < cn) return false;
  }
  return false;
};

export async function lastCheck(): Promise<UpdateCheckResult | null> {
  return getSetting<UpdateCheckResult>(KEY);
}

export async function checkForUpdates(fetchFn: typeof fetch = fetch): Promise<UpdateCheckResult> {
  const current = buildMeta().version;
  let result: UpdateCheckResult;
  try {
    const res = await fetchFn(checkUrl(), {
      headers: { Accept: 'application/json', 'User-Agent': `trackforge/${current}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`update endpoint returned ${res.status}`);
    const tag = parseTag(await res.json());
    if (!tag) throw new Error('update endpoint returned unparseable body');
    result = {
      at: new Date().toISOString(),
      current,
      latest: tag.latest,
      updateAvailable: isNewer(current, tag.latest),
      url: tag.url,
    };
  } catch (e) {
    result = {
      at: new Date().toISOString(),
      current,
      latest: current,
      updateAvailable: false,
      error: (e as Error).message,
    };
  }
  await putSetting(KEY, result);
  return result;
}
