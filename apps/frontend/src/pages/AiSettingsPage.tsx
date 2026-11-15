import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAiSettings,
  fetchAiUsage,
  testAiConnection,
  updateAiSettings,
  type AiSettings,
} from '../api/client.js';

const input = 'h-9 w-full rounded border border-atl-n-40 px-2.5 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none';
const label = 'block text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1';

export default function AiSettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['aiSettings'], queryFn: fetchAiSettings });
  const { data: usage } = useQuery({
    queryKey: ['aiUsage'],
    queryFn: fetchAiUsage,
    retry: false,
    refetchInterval: 30_000,
  });

  const [form, setForm] = useState<Partial<AiSettings> & { apiKey?: string; clearApiKey?: boolean }>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm((f) => ({ ...data, ...f, apiKey: f.apiKey ?? '' }));
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      updateAiSettings({
        provider: form.provider,
        baseUrl: form.baseUrl,
        chatModel: form.chatModel,
        embedModel: form.embedModel,
        speechModel: form.speechModel,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(form.clearApiKey ? { clearApiKey: true } : {}),
        dailyLimit: form.dailyLimit,
        monthlyBudget: form.monthlyBudget,
        promptLogging: form.promptLogging,
        globalGuidance: form.globalGuidance || null,
      }),
    onSuccess: () => {
      setSaved(true);
      setForm((f) => ({ ...f, apiKey: '', clearApiKey: false }));
      void qc.invalidateQueries({ queryKey: ['aiSettings'] });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const test = useMutation({
    mutationFn: () =>
      testAiConnection({
        provider: form.provider,
        baseUrl: form.baseUrl,
        chatModel: form.chatModel,
        apiKey: form.apiKey || undefined,
      }),
    onSuccess: setTestResult,
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex-1 overflow-auto bg-atl-n-10">
      <div className="max-w-3xl mx-auto py-8 px-6">
        <h1 className="text-xl font-semibold text-atl-n-800">AI</h1>
        <p className="mt-1 text-sm text-atl-n-500">
          Connect a language model to enable the copilot, natural-language search and issue
          intelligence. Off by default — nothing leaves this server until you save a provider.
        </p>

        <div className="mt-6 rounded bg-atl-paper border border-atl-n-30 p-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Provider</label>
              <select
                className={input}
                value={form.provider ?? 'openai'}
                onChange={(e) => set('provider', e.target.value as 'openai' | 'anthropic')}
              >
                <option value="openai">OpenAI-compatible (OpenAI, Ollama, vLLM, LM Studio)</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </div>
            <div>
              <label className={label}>Base URL</label>
              <input
                className={input}
                placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
                value={form.baseUrl ?? ''}
                onChange={(e) => set('baseUrl', e.target.value)}
              />
            </div>
            <div>
              <label className={label}>Chat model</label>
              <input
                className={input}
                placeholder="gpt-4o-mini, claude-haiku-4-5, llama3.1…"
                value={form.chatModel ?? ''}
                onChange={(e) => set('chatModel', e.target.value)}
              />
            </div>
            <div>
              <label className={label}>Embedding model (OpenAI-compatible only)</label>
              <input
                className={input}
                placeholder="text-embedding-3-small, nomic-embed-text…"
                value={form.embedModel ?? ''}
                onChange={(e) => set('embedModel', e.target.value)}
              />
            </div>
            <div>
              <label className={label}>Speech recognition model (OpenAI-compatible only)</label>
              <input
                className={input}
                placeholder="whisper-1, faster-whisper… — empty disables the copilot mic"
                value={form.speechModel ?? ''}
                onChange={(e) => set('speechModel', e.target.value)}
              />
            </div>
            <div>
              <label className={label}>API key</label>
              <input
                className={input}
                type="password"
                autoComplete="new-password"
                placeholder={data?.hasApiKey ? '••••••••  (stored — enter to replace)' : 'sk-…'}
                value={form.apiKey ?? ''}
                onChange={(e) => set('apiKey', e.target.value)}
              />
              {data?.hasApiKey && (
                <label className="mt-1.5 flex items-center gap-1.5 text-xs text-atl-n-500">
                  <input
                    type="checkbox"
                    checked={form.clearApiKey ?? false}
                    onChange={(e) => set('clearApiKey', e.target.checked)}
                  />
                  Remove stored key on save
                </label>
              )}
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={() => test.mutate()}
                disabled={test.isPending}
                className="h-9 px-3 rounded border border-atl-n-40 text-sm text-atl-n-700 hover:bg-atl-n-10 disabled:opacity-50"
              >
                {test.isPending ? 'Testing…' : 'Test connection'}
              </button>
              {testResult && (
                <span className={`text-xs ${testResult.ok ? 'text-atl-g-500' : 'text-atl-r-500'}`}>
                  {testResult.ok ? 'Connected' : 'Failed'} — {testResult.detail}
                </span>
              )}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-atl-n-30 grid grid-cols-3 gap-4">
            <div>
              <label className={label}>Daily requests / user (0 = unlimited)</label>
              <input
                className={input}
                type="number"
                min={0}
                value={form.dailyLimit ?? 0}
                onChange={(e) => set('dailyLimit', Number(e.target.value))}
              />
            </div>
            <div>
              <label className={label}>Monthly token budget (0 = unlimited)</label>
              <input
                className={input}
                type="number"
                min={0}
                value={form.monthlyBudget ?? 0}
                onChange={(e) => set('monthlyBudget', Number(e.target.value))}
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-atl-n-700">
                <input
                  type="checkbox"
                  checked={form.promptLogging ?? false}
                  onChange={(e) => set('promptLogging', e.target.checked)}
                />
                Log prompts &amp; responses (redacted)
              </label>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-atl-n-30">
            <label className={label}>Global agent guidance</label>
            <textarea
              className={`${input} h-24 resize-y`}
              value={form.globalGuidance ?? ''}
              onChange={(e) => set('globalGuidance', e.target.value)}
              placeholder="Operator instructions every agent + AI feature follows — e.g. conventions, forbidden actions. Issue and user content can never override this."
            />
            <p className="mt-1 text-xs text-atl-n-200">
              Injected into the system prompt of every AI request. Per-project overrides live in project settings → Agent guidance.
            </p>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="h-9 px-4 rounded bg-atl-b-300 hover:bg-atl-b-400 text-white text-sm font-medium disabled:opacity-50"
            >
              Save
            </button>
            {saved && <span className="text-sm text-atl-g-500">Saved</span>}
            {save.isError && (
              <span className="text-sm text-atl-r-500">
                {save.error instanceof Error ? save.error.message : 'Save failed'}
              </span>
            )}
            <span className="ml-auto text-xs text-atl-n-200">
              {data?.configured ? 'AI is enabled' : 'AI is off — endpoints return 404 until configured'}
            </span>
          </div>
        </div>

        {usage && (
          <div className="mt-6 rounded bg-atl-paper border border-atl-n-30 p-5">
            <h2 className="text-sm font-semibold text-atl-n-800">Usage</h2>
            <div className="mt-3 grid grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-2xl font-semibold text-atl-n-800">{usage.month.requests}</div>
                <div className="text-xs text-atl-n-200">requests this month</div>
              </div>
              <div>
                <div className="text-2xl font-semibold text-atl-n-800">
                  {usage.month.inputTokens.toLocaleString()}
                </div>
                <div className="text-xs text-atl-n-200">input tokens</div>
              </div>
              <div>
                <div className="text-2xl font-semibold text-atl-n-800">
                  {usage.month.outputTokens.toLocaleString()}
                </div>
                <div className="text-xs text-atl-n-200">output tokens</div>
              </div>
              <div title="Provider-reported spend (e.g. OpenRouter usage.cost); $0 means the provider doesn't report it">
                <div className="text-2xl font-semibold text-atl-n-800">
                  ${usage.month.costUsd < 1 ? usage.month.costUsd.toFixed(4) : usage.month.costUsd.toFixed(2)}
                </div>
                <div className="text-xs text-atl-n-200">est. provider cost</div>
              </div>
            </div>
            {usage.outcomes && Object.keys(usage.outcomes).length > 0 && (
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                    <th className="py-1.5 font-semibold">Feature (month)</th>
                    <th className="py-1.5 font-semibold text-right">Accepted</th>
                    <th className="py-1.5 font-semibold text-right">Edited</th>
                    <th className="py-1.5 font-semibold text-right">Clarified</th>
                    <th className="py-1.5 font-semibold text-right">Failed</th>
                    <th className="py-1.5 font-semibold text-right">Discarded</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(usage.outcomes).map(([feature, c]) => (
                    <tr key={feature} className="border-b border-atl-n-10">
                      <td className="py-1.5 text-atl-n-700">{feature}</td>
                      <td className="py-1.5 text-right text-atl-n-700">{c.accepted ?? 0}</td>
                      <td className="py-1.5 text-right text-atl-y-500">{c.edited ?? 0}</td>
                      <td className="py-1.5 text-right text-atl-b-300">{c.clarified ?? 0}</td>
                      <td className="py-1.5 text-right text-atl-r-400">{c.failed ?? 0}</td>
                      <td className="py-1.5 text-right text-atl-n-300">{c.discarded ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {usage.today.length > 0 && (
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                    <th className="py-1.5 font-semibold">User (today)</th>
                    <th className="py-1.5 font-semibold text-right">Requests</th>
                    <th className="py-1.5 font-semibold text-right">Tokens in/out</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.today.map((u) => (
                    <tr key={u.user} className="border-b border-atl-n-10">
                      <td className="py-1.5 text-atl-n-700">{u.user}</td>
                      <td className="py-1.5 text-right text-atl-n-700">{u.requests}</td>
                      <td className="py-1.5 text-right text-atl-n-500">
                        {u.inputTokens} / {u.outputTokens}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="mt-6 rounded bg-atl-paper border border-atl-n-30 p-5">
          <h2 className="text-sm font-semibold text-atl-n-800">Approval mode</h2>
          <p className="mt-1.5 text-sm text-atl-n-500">
            Flag an API token or agent account with <code className="text-xs bg-atl-n-10 px-1 rounded">requireApproval</code> to
            park its writes as reviewable proposals instead of applying them. Review them in{' '}
            <Link to="/approvals" className="text-atl-b-300 hover:underline">Approvals</Link>.
            Agents see a <code className="text-xs bg-atl-n-10 px-1 rounded">202 pendingApproval</code> response and can
            track status via <code className="text-xs bg-atl-n-10 px-1 rounded">list_my_proposals</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
