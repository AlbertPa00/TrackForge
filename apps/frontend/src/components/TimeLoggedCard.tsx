import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchMyTimesheet, type MyTimesheet } from '../api/client.js';
import { IssueKeyLink } from './IssueKey.js';
import { formatSeconds } from '../lib/format.js';

// "Time logged" — the caller's own timesheet, one calendar month at a time.
// Month chevrons are the whole "period selector": simplest possible control
// for the monthly question the card answers. Data: GET /me/timesheet.

const pad = (n: number) => String(n).padStart(2, '0');

function monthRange(y: number, m: number) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}`, last };
}

function monthLabel(y: number, m: number) {
  return new Date(Date.UTC(y, m, 15)).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function useMyTimesheet(from: string, to: string) {
  return useQuery({
    queryKey: ['my-timesheet', from, to],
    queryFn: () => fetchMyTimesheet(from, to),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** Per-day bars for the selected month. Empty days sit on a shared baseline
 *  tick so the row reads as a calendar strip, not scattered marks. Green =
 *  met the workday, amber = partial, tick = nothing/future. Detail on hover. */
function DayBars({ data, y, m, last }: { data: MyTimesheet; y: number; m: number; last: number }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex h-12 items-end gap-[3px] border-b border-atl-n-30" role="img" aria-label="Logged time per day">
      {Array.from({ length: last }, (_, i) => {
        const iso = `${y}-${pad(m + 1)}-${pad(i + 1)}`;
        const sec = data.days[iso] ?? 0;
        const future = iso > todayIso;
        const label = new Date(`${iso}T00:00:00Z`).toLocaleString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        });
        const tip = `${label} — ${sec ? formatSeconds(sec) : 'nothing logged'}`;
        if (!sec) {
          return (
            <div
              key={iso}
              title={tip}
              className={`h-1.5 flex-1 rounded-full ${future ? 'bg-atl-n-20/50' : 'bg-atl-n-30'}`}
            />
          );
        }
        const pct = Math.min(100, (sec / data.workdaySec) * 100);
        return (
          <div
            key={iso}
            title={tip}
            className={`flex-1 rounded-t-[2px] ${sec >= data.workdaySec ? 'bg-atl-g-400' : 'bg-atl-y-300'}`}
            style={{ height: `${Math.max(14, pct)}%` }}
          />
        );
      })}
    </div>
  );
}

export default function TimeLoggedCard() {
  const now = new Date();
  const [ym, setYm] = useState(() => ({ y: now.getUTCFullYear(), m: now.getUTCMonth() }));
  const { from, to, last } = useMemo(() => monthRange(ym.y, ym.m), [ym]);
  const { data, isPlaceholderData } = useMyTimesheet(from, to);
  const isCurrent = ym.y === now.getUTCFullYear() && ym.m === now.getUTCMonth();
  const move = (d: number) =>
    setYm(({ y, m }) => {
      const next = new Date(Date.UTC(y, m + d, 1));
      return { y: next.getUTCFullYear(), m: next.getUTCMonth() };
    });

  const expected = isCurrent ? (data?.expectedToDateSec ?? 0) : (data?.expectedSec ?? 0);
  const top = (data?.issues ?? []).slice(0, 5);
  const rest = (data?.issues ?? []).slice(5);
  const restSec = rest.reduce((n, i) => n + i.totalSec, 0);
  const maxIssue = top[0]?.totalSec ?? 1;

  return (
    <section
      className={`mb-6 rounded-[3px] border border-atl-n-40 bg-atl-paper px-4 py-3 shadow-sm ${isPlaceholderData ? 'opacity-60' : ''}`}
      aria-label="Time logged"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-atl-n-800">Time logged</h2>
        <div className="ml-auto flex items-center gap-1 text-sm text-atl-n-500">
          <button
            type="button"
            onClick={() => move(-1)}
            className="rounded px-1.5 py-0.5 hover:bg-atl-n-20"
            title="Previous month"
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="min-w-[130px] text-center font-medium text-atl-n-700">{monthLabel(ym.y, ym.m)}</span>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={isCurrent}
            className="rounded px-1.5 py-0.5 hover:bg-atl-n-20 disabled:opacity-30"
            title="Next month"
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      {!data || data.totalSec === 0 ? (
        <p className="py-4 text-sm text-atl-n-300">
          {data ? `No work logged in ${monthLabel(ym.y, ym.m)}.` : 'Loading…'}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-[220px] flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-atl-n-800">{formatSeconds(data.totalSec)}</span>
              {expected > 0 && (
                <span
                  className="text-xs text-atl-n-300"
                  title={`Expected = workdays elapsed × your instance workday (${formatSeconds(data.workdaySec)}); full month ~${formatSeconds(data.expectedSec)}`}
                >
                  of ~{formatSeconds(expected)} {isCurrent ? 'so far' : 'expected'}
                  {data.totalSec > expected && ` · ${Math.round((data.totalSec / expected) * 100)}%`}
                </span>
              )}
            </div>
            {expected > 0 && (
              <div
                className="mt-1.5 h-1.5 w-full max-w-[280px] rounded-full bg-atl-n-20"
                title={`${Math.round((data.totalSec / expected) * 100)}% of expected time`}
              >
                <div
                  className={`h-1.5 rounded-full ${data.totalSec >= expected ? 'bg-atl-g-400' : 'bg-atl-b-300'}`}
                  style={{ width: `${Math.min(100, (data.totalSec / expected) * 100)}%` }}
                />
              </div>
            )}
            <div className="mt-3">
              <DayBars data={data} y={ym.y} m={ym.m} last={last} />
            </div>
          </div>

          <ul className="min-w-[240px] flex-1 space-y-1">
            {top.map((i) => (
              <li key={i.key} className="flex items-center gap-2 text-xs">
                <IssueKeyLink
                  issueKey={i.key}
                  categoryKey={i.statusCategoryKey}
                  className="w-20 shrink-0 truncate font-medium text-atl-b-400 hover:underline"
                />
                <span className="min-w-0 flex-1 truncate text-atl-n-500" title={i.summary}>
                  {i.summary}
                </span>
                <span className="shrink-0 font-medium text-atl-n-700">{formatSeconds(i.totalSec)}</span>
                <span className="hidden h-1 w-12 shrink-0 rounded-full bg-atl-n-20 sm:block">
                  <span
                    className="block h-1 rounded-full bg-atl-b-200"
                    style={{ width: `${(i.totalSec / maxIssue) * 100}%` }}
                  />
                </span>
              </li>
            ))}
            {rest.length > 0 && (
              <li className="pt-0.5 text-xs text-atl-n-300">
                +{rest.length} more issue{rest.length === 1 ? '' : 's'} · {formatSeconds(restSec)}
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Slim one-line version for the Worklogs tab — same query, shared cache. */
export function MyMonthLogStrip() {
  const now = new Date();
  const { from, to } = monthRange(now.getUTCFullYear(), now.getUTCMonth());
  const { data } = useMyTimesheet(from, to);
  if (!data || data.totalSec === 0) return null;
  return (
    <p className="mb-3 text-xs text-atl-n-300">
      You logged <span className="font-semibold text-atl-n-700">{formatSeconds(data.totalSec)}</span> in{' '}
      {monthLabel(now.getUTCFullYear(), now.getUTCMonth())} across {data.issues.length}{' '}
      issue{data.issues.length === 1 ? '' : 's'} —{' '}
      <a href="/your-work" className="text-atl-b-300 hover:underline">
        see your timesheet →
      </a>
    </p>
  );
}
