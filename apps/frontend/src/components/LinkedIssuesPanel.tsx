import { useEffect, useState } from 'react';
import { useIssueWrite } from '../lib/useIssueWrite.js';
import { isSafeHref } from '../lib/url.js';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fetchLinkTypes,
  linkIssues,
  unlinkIssue,
  fetchRemoteLinks,
  createRemoteLink,
  deleteRemoteLink,
  type Issue,
} from '../api/client.js';
import IssuePicker from './IssuePicker.js';
import { IssueKeyLink } from './IssueKey.js';
import { useIssuePermissions } from '../hooks/usePermissions.js';
import { imeComposing } from '../lib/ime.js';

/** "Linked issues" panel grouped by relationship; add link by key + type. */
export default function LinkedIssuesPanel({ issue }: { issue: Issue }) {
  const markWrite = useIssueWrite(issue.key);
  const { can } = useIssuePermissions(issue.key);
  const canLink = can('LINK_ISSUES');
  const [adding, setAdding] = useState(false);
  const [addingWeb, setAddingWeb] = useState(false);
  const [webUrl, setWebUrl] = useState('');
  const [webTitle, setWebTitle] = useState('');
  const [typeName, setTypeName] = useState('Blocks');
  const [otherKey, setOtherKey] = useState('');
  const [open, setOpen] = useState(true);
  const { data: types } = useQuery({ queryKey: ['linkTypes'], queryFn: fetchLinkTypes });
  const { data: remoteLinks } = useQuery({
    queryKey: ['remotelinks', issue.key],
    queryFn: () => fetchRemoteLinks(issue.key),
  });

  // 042 F-039 — the ⋯ menu's "Link issue" action opens the add form here.
  useEffect(() => {
    const ev = `tf:link-issue:${issue.key}`;
    const open = () => setAdding(true);
    window.addEventListener(ev, open);
    return () => window.removeEventListener(ev, open);
  }, [issue.key]);

  const add = useMutation({
    mutationFn: () => linkIssues(typeName, issue.key, otherKey.trim().toUpperCase()),
    onSuccess: () => {
      setOtherKey('');
      setAdding(false);
      markWrite();
    },
  });
  const remove = useMutation({
    mutationFn: (linkId: string) => unlinkIssue(linkId),
    onSuccess: () => {
      markWrite();
    },
  });
  const addWeb = useMutation({
    mutationFn: () => createRemoteLink(issue.key, { url: webUrl.trim(), title: webTitle.trim() }),
    onSuccess: () => {
      setWebUrl('');
      setWebTitle('');
      setAddingWeb(false);
      markWrite([['remotelinks', issue.key]]);
    },
  });
  const removeWeb = useMutation({
    mutationFn: (id: string) => deleteRemoteLink(issue.key, id),
    onSuccess: () => {
      markWrite([['remotelinks', issue.key]]);
    },
  });

  const links = issue.fields.issuelinks ?? [];
  // Group by the phrase this issue experiences (outward vs inward).
  const groups = new Map<string, { linkId: string; key: string; categoryKey?: string }[]>();
  for (const l of links) {
    const outward = l.inwardIssue; // this issue is the source
    const phrase = outward ? l.type.outward : l.type.inward;
    const other = outward ?? l.outwardIssue;
    if (!other) continue;
    const arr = groups.get(phrase) ?? [];
    arr.push({ linkId: l.id, key: other.key, categoryKey: other.fields?.status?.statusCategory?.key });
    groups.set(phrase, arr);
  }

  return (
    <section className="mt-6" data-tf-linked-issues>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-atl-n-300">Linked issues</h2>
        <div className="flex items-center gap-3">
          {canLink && (
            <>
              <button
                type="button"
                onClick={() => setAddingWeb((v) => !v)}
                className="text-xs text-atl-b-300 hover:underline"
              >
                Add web link
              </button>
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                className="text-xs text-atl-b-300 hover:underline"
              >
                Link issue
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? 'Collapse linked issues' : 'Expand linked issues'}
            className="text-atl-n-200 hover:text-atl-n-500"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              className={`transition-transform ${open ? '' : 'rotate-180'}`}
              aria-hidden="true"
            >
              <path
                d="M2 7.5 6 3.5l4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <>
          {adding && (
            <div className="mb-3 flex items-center gap-2 rounded border border-atl-n-30 p-2">
              <select
                value={typeName}
                onChange={(e) => setTypeName(e.target.value)}
                className="rounded border border-atl-n-40 px-2 py-1 text-sm"
              >
                {(types ?? []).map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.outward}
                  </option>
                ))}
              </select>
              <IssuePicker
                autoFocus
                value={otherKey}
                onChange={setOtherKey}
                excludeKey={issue.key}
                placeholder="Issue key or summary, e.g. TF-2"
                className="w-56 rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
              />
              <button
                type="button"
                disabled={!otherKey.trim() || add.isPending}
                onClick={() => add.mutate()}
                className="rounded bg-atl-b-300 px-3 py-1 text-sm font-medium text-white hover:bg-atl-b-400 disabled:opacity-50"
              >
                Link
              </button>
            </div>
          )}
          {addingWeb && (
            <div className="mb-3 flex items-center gap-2 rounded border border-atl-n-30 p-2">
              <input
                autoFocus
                value={webUrl}
                onChange={(e) => setWebUrl(e.target.value)}
                placeholder="https://…"
                className="w-64 rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
              />
              <input
                value={webTitle}
                onChange={(e) => setWebTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !imeComposing(e) && webUrl.trim() && webTitle.trim()) addWeb.mutate();
                  if (e.key === 'Escape') setAddingWeb(false);
                }}
                placeholder="Link title"
                className="w-40 rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
              />
              <button
                type="button"
                disabled={!webUrl.trim() || !webTitle.trim() || addWeb.isPending}
                onClick={() => addWeb.mutate()}
                className="rounded bg-atl-b-300 px-3 py-1 text-sm font-medium text-white hover:bg-atl-b-400 disabled:opacity-50"
              >
                Link
              </button>
            </div>
          )}
          {add.isError && <p className="mb-2 text-xs text-atl-r-400">{(add.error as Error).message}</p>}
          {addWeb.isError && <p className="mb-2 text-xs text-atl-r-400">{(addWeb.error as Error).message}</p>}
          {groups.size === 0 ? (
            <p className="text-sm text-atl-n-100 italic">None</p>
          ) : (
            [...groups.entries()].map(([phrase, items]) => (
              <div key={phrase} className="mb-2">
                <p className="text-xs text-atl-n-200 mb-1">{phrase}</p>
                <ul className="divide-y divide-atl-n-20 rounded border border-atl-n-30">
                  {items.map((it) => (
                    <li key={it.linkId} className="flex items-center gap-2 px-3 py-1.5 hover:bg-atl-n-10">
                      <IssueKeyLink
                        issueKey={it.key}
                        categoryKey={it.categoryKey}
                        className="text-xs text-atl-b-300 hover:underline"
                      />
                      {canLink && (
                        <button
                          type="button"
                          onClick={() => remove.mutate(it.linkId)}
                          className="ml-auto text-xs text-atl-n-200 hover:text-atl-r-400"
                          aria-label={`Remove link to ${it.key}`}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {(remoteLinks?.length ?? 0) > 0 && (
            <div className="mb-2">
              <p className="text-xs text-atl-n-200 mb-1">Web links</p>
              <ul className="divide-y divide-atl-n-20 rounded border border-atl-n-30">
                {remoteLinks!.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-atl-n-10">
                    {isSafeHref(l.object.url) ? (
                      <a
                        href={l.object.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-atl-b-300 hover:underline"
                      >
                        {l.object.title}
                      </a>
                    ) : (
                      <span className="text-xs text-atl-n-800">{l.object.title}</span>
                    )}
                    {canLink && (
                      <button
                        type="button"
                        onClick={() => removeWeb.mutate(l.id)}
                        className="ml-auto text-xs text-atl-n-200 hover:text-atl-r-400"
                        aria-label={`Remove web link ${l.object.title}`}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
