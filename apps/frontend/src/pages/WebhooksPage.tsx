// Admin webhook settings — Jira Server's webhook management UI:
// register/edit/delete endpoints, event subscriptions, JQL filter, secret,
// and the delivery log with inspect + redeliver.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchWebhooks, createWebhook, updateWebhook, deleteWebhook,
  fetchWebhookDeliveries, redeliverWebhook,
  type Webhook, type WebhookDelivery,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import JqlEditor from '../components/JqlEditor.js';

const ALL_EVENTS = [
  'jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted',
  'comment_created', 'comment_updated', 'comment_deleted',
  'issuelink_created', 'issuelink_deleted',
  'board_configuration_changed', 'sprint_created', 'sprint_updated', 'sprint_started', 'sprint_closed',
];

interface WebhookForm {
  name: string; url: string; jql: string; secret: string;
  events: Set<string>; enabled: boolean;
}

const EMPTY_FORM: WebhookForm = { name: '', url: '', jql: '', secret: '', events: new Set(['jira:issue_created', 'jira:issue_updated']), enabled: true };

function Editor({ initial, onSave, onClose }: {
  initial: WebhookForm;
  onSave: (f: WebhookForm) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<WebhookForm>(initial);
  const toggle = (e: string) =>
    setF((p) => {
      const next = new Set(p.events);
      if (next.has(e)) next.delete(e); else next.add(e);
      return { ...p, events: next };
    });
  return (
    <Modal open onClose={onClose}>
      <div className="p-6 w-[560px]">
        <h2 className="text-[18px] font-medium text-atl-n-800 mb-4">Webhook</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium text-atl-n-200">Name</span>
            <input className="mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px]"
              value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-atl-n-200">URL</span>
            <input className="mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px]"
              placeholder="https://example.com/hook" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          </label>
          <div>
            <span className="text-[12px] font-medium text-atl-n-200">JQL filter (optional)</span>
            <div className="mt-1">
              <JqlEditor value={f.jql} onChange={(jql) => setF({ ...f, jql })} />
            </div>
          </div>
          <label className="block">
            <span className="text-[12px] font-medium text-atl-n-200">Secret (optional — HMAC-SHA256 signature)</span>
            <input className="mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px] font-mono"
              placeholder="auto-generated if empty" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />
          </label>
          <div>
            <span className="text-[12px] font-medium text-atl-n-200">Events</span>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {ALL_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-2 text-[13px] text-atl-n-800 cursor-pointer">
                  <input type="checkbox" checked={f.events.has(e)} onChange={() => toggle(e)} /> {e}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-atl-n-800">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enabled
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-3 py-1.5 text-[14px] text-atl-n-500 hover:bg-atl-n-20 rounded-[3px]" onClick={onClose}>Cancel</button>
          <button
            className="px-3 py-1.5 text-[14px] bg-atl-b-400 text-white rounded-[3px] hover:bg-atl-b-300 disabled:opacity-50"
            disabled={!f.name || !f.url || f.events.size === 0}
            onClick={() => onSave(f)}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Deliveries({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['webhook-deliveries', webhook.id],
    queryFn: () => fetchWebhookDeliveries(webhook.id),
    refetchInterval: 5_000,
  });
  const redeliver = useMutation({
    mutationFn: (dId: string) => redeliverWebhook(webhook.id, dId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-deliveries', webhook.id] }),
  });
  return (
    <Modal open onClose={onClose}>
      <div className="p-6 w-[720px] max-h-[70vh] overflow-auto">
        <h2 className="text-[18px] font-medium text-atl-n-800 mb-1">Deliveries — {webhook.name}</h2>
        <p className="text-[12px] text-atl-n-300 mb-4 font-mono truncate" title={webhook.url}>{webhook.url}</p>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-atl-n-300 border-b border-atl-n-40">
              <th className="py-2 pr-3 font-medium">EVENT</th><th className="py-2 pr-3 font-medium">STATUS</th>
              <th className="py-2 pr-3 font-medium">CODE</th><th className="py-2 pr-3 font-medium">ATTEMPT</th>
              <th className="py-2 pr-3 font-medium">LATENCY</th><th className="py-2 pr-3 font-medium">NEXT</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.deliveries ?? []).map((d: WebhookDelivery) => (
              <tr key={d.id} className="border-b border-atl-n-40 last:border-0" title={d.error ?? d.responseSnippet ?? ''}>
                <td className="py-2 pr-3 font-mono">#{d.eventId}</td>
                <td className="py-2 pr-3">
                  <span className={`px-1.5 py-0.5 rounded-[3px] text-[11px] font-medium ${
                    d.status === 'success' ? 'bg-atl-g-50 text-atl-g-500'
                    : d.status === 'dead' ? 'bg-atl-r-50 text-atl-r-500'
                    : 'bg-atl-b-75 text-atl-b-500'}`}>{d.status}</span>
                </td>
                <td className="py-2 pr-3">{d.responseCode ?? '—'}</td>
                <td className="py-2 pr-3">{d.attempt}</td>
                <td className="py-2 pr-3">{d.latencyMs != null ? `${d.latencyMs}ms` : '—'}</td>
                <td className="py-2 pr-3 text-[11px] text-atl-n-300">
                  {d.status === 'pending' && d.nextAttemptAt ? new Date(d.nextAttemptAt).toLocaleTimeString() : '—'}
                </td>
                <td className="py-2 text-right">
                  {d.status !== 'success' && (
                    <button className="text-[12px] text-atl-b-400 hover:underline" onClick={() => redeliver.mutate(d.id)}>
                      Redeliver
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.deliveries.length === 0 && <p className="text-center text-[13px] text-atl-n-300 py-6">No deliveries yet.</p>}
      </div>
    </Modal>
  );
}

export default function WebhooksPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: fetchWebhooks,
  });
  const [editor, setEditor] = useState<WebhookForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (f: WebhookForm) =>
      editingId
        ? updateWebhook(editingId, {
            name: f.name, url: f.url, events: [...f.events],
            filters: f.jql ? { 'issue-related-events-section': f.jql } : {},
            enabled: f.enabled, ...(f.secret ? { secret: f.secret } : {}),
          })
        : createWebhook({
            name: f.name, url: f.url, events: [...f.events],
            filters: f.jql ? { 'issue-related-events-section': f.jql } : undefined,
            enabled: f.enabled, ...(f.secret ? { secret: f.secret } : {}),
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setEditor(null); setEditingId(null); setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
      setDeleting(null);
    },
  });

  const hooks = data?.webhookCallbackResponse ?? [];

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 max-w-[1000px]">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-atl-n-800">Webhooks</h1>
            <p className="text-[13px] text-atl-n-300 mt-1">
              POST Jira-shaped payloads to external systems when events occur. Signed with HMAC-SHA256 when a secret is set.
            </p>
          </div>
          <button
            className="px-3 py-1.5 text-[14px] bg-atl-b-400 text-white rounded-[3px] hover:bg-atl-b-300"
            onClick={() => { setEditingId(null); setEditor(EMPTY_FORM); }}
          >
            Create webhook
          </button>
        </div>
        {error && <p className="mb-4 text-[13px] text-atl-r-500">{error}</p>}
        {isLoading ? (
          <p className="text-atl-n-300">Loading…</p>
        ) : (
          <div className="bg-atl-paper border border-atl-n-40 rounded-[3px] shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] text-atl-n-300 border-b border-atl-n-40">
                  <th className="px-4 py-3 font-medium">NAME</th><th className="px-4 py-3 font-medium">URL</th>
                  <th className="px-4 py-3 font-medium">EVENTS</th><th className="px-4 py-3 font-medium">FILTER</th>
                  <th className="px-4 py-3 font-medium">STATUS</th><th className="px-4 py-3 font-medium">FAILURES</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {hooks.map((w) => (
                  <tr key={w.id} className="border-b border-atl-n-40 last:border-0 hover:bg-atl-n-20">
                    <td className="px-4 py-3 font-medium text-atl-n-800">{w.name}</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-atl-n-300 max-w-[220px] truncate" title={w.url}>{w.url}</td>
                    <td className="px-4 py-3 text-[12px]">{w.events.length} event{w.events.length === 1 ? '' : 's'}</td>
                    <td
                      className="px-4 py-3 font-mono text-[11px] text-atl-n-300 max-w-[160px] truncate"
                      title={(w.filters['issue-related-events-section'] as string) || undefined}
                    >
                      {(w.filters['issue-related-events-section'] as string) || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-1.5 py-0.5 rounded-[3px] text-[11px] font-medium ${w.enabled ? 'bg-atl-g-50 text-atl-g-500' : 'bg-atl-n-40 text-atl-n-500'}`}>
                        {w.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[12px]" title="Consecutive failed deliveries — the hook is auto-disabled after repeated failures">
                      {w.failureCount > 0
                        ? <span className="text-atl-r-500 font-medium">{w.failureCount} in a row</span>
                        : <span className="text-atl-n-200">0</span>}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button className="text-[12px] text-atl-b-400 hover:underline mr-3" onClick={() => setDeliveriesFor(w)}>Deliveries</button>
                      <button
                        className="text-[12px] text-atl-b-400 hover:underline mr-3"
                        onClick={() => {
                          setEditingId(w.id);
                          setEditor({
                            name: w.name, url: w.url, secret: '',
                            jql: (w.filters['issue-related-events-section'] as string) ?? '',
                            events: new Set(w.events), enabled: w.enabled,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button className="text-[12px] text-atl-r-500 hover:underline" onClick={() => setDeleting(w)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hooks.length === 0 && <p className="text-center text-[13px] text-atl-n-300 py-8">No webhooks registered yet.</p>}
          </div>
        )}
      </div>
      {editor && <Editor initial={editor} onSave={(f) => save.mutate(f)} onClose={() => setEditor(null)} />}
      {deliveriesFor && <Deliveries webhook={deliveriesFor} onClose={() => setDeliveriesFor(null)} />}
      {deleting && (
        <Modal open onClose={() => setDeleting(null)}>
          <div className="p-6 w-[420px]">
            <h2 className="text-[18px] font-medium text-atl-n-800 mb-2">Delete webhook?</h2>
            <p className="text-[13px] text-atl-n-500 mb-1">
              <span className="font-medium">{deleting.name}</span> will stop receiving events immediately.
            </p>
            <p className="text-[12px] text-atl-n-300 font-mono truncate mb-5" title={deleting.url}>{deleting.url}</p>
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 text-[14px] text-atl-n-500 hover:bg-atl-n-20 rounded-[3px]" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="px-3 py-1.5 text-[14px] bg-atl-r-300 text-white rounded-[3px] hover:bg-atl-r-400 disabled:opacity-50"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting.id)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
