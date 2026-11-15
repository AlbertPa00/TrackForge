import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { login, loginTotp, fetchIdps, requestPasswordReset, confirmPasswordReset, ApiError } from '../api/client.js';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [idps, setIdps] = useState<{ id: string; name: string }[]>([]);
  const [reset, setReset] = useState<'request' | 'confirm' | null>(null);
  const [resetToken, setResetToken] = useState('');
  // True when the server returned the token inline (no mailer configured — dev mode).
  const [devToken, setDevToken] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  useEffect(() => { fetchIdps().then(setIdps).catch(() => {}); }, []);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  // Reset emails link to /login?resetToken=<token> — land straight on the
  // confirm form with the token pre-filled.
  useEffect(() => {
    const t = params.get('resetToken');
    if (t) { setReset('confirm'); setResetToken(t); }
  }, [params]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email.trim(), password, remember);
      if ('totpRequired' in user) { setPending(user.pending); setBusy(false); return; }
      queryClient.setQueryData(['myself'], user);
      const next = params.get('next') ?? '/';
      navigate(next.startsWith('/') ? next : '/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not sign in. Check your connection and try again.'
      );
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-atl-n-10 px-4">
      <div className="w-full max-w-[400px] bg-atl-paper rounded shadow-md px-10 py-8">
        <div className="flex items-center justify-center gap-2 mb-6">
          <svg width="26" height="26" viewBox="0 0 24 24" className="text-atl-b-300">
            <path
              fill="currentColor"
              d="M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.3 6.5 3.2L12 10.7 5.5 7.5 12 4.3zM5 9.2l6 3v7.1l-6-3V9.2zm14 0v7.1l-6 3v-7.1l6-3z"
            />
          </svg>
          <span className="text-xl font-semibold tracking-tight text-atl-n-800">TrackForge</span>
        </div>

        <h1 className="text-base font-semibold text-atl-n-800 text-center mb-6">
          Log in to continue
        </h1>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            id="email"
            name="email"
            required
            autoFocus
            autoComplete="username"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-10 px-3 rounded border-2 border-atl-n-40 text-sm text-atl-n-800 outline-none focus:border-atl-b-300"
          />
          <input
            type="password"
            id="password"
            name="password"
            required
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-10 px-3 rounded border-2 border-atl-n-40 text-sm text-atl-n-800 outline-none focus:border-atl-b-300"
          />

          {error && (
            <div className="rounded bg-atl-r-50 text-atl-r-500 px-3 py-2 text-sm">
              {error}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-atl-n-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-atl-b-400"
            />
            Keep me logged in
          </label>

          <button
            type="submit"
            disabled={busy}
            className="w-full h-10 rounded bg-atl-b-300 hover:bg-atl-b-400 disabled:opacity-60 text-white text-sm font-medium"
          >
            {busy ? 'Logging in…' : 'Log in'}
          </button>
          {resetDone && (
            <div className="rounded bg-atl-g-50 text-atl-g-500 px-3 py-2 text-sm">
              Password updated — log in with your new password.
            </div>
          )}
          {!reset && (
            <p className="text-xs text-atl-n-200 text-center pt-1">
              <button
                type="button"
                className="text-atl-b-300 hover:underline"
                onClick={() => { setReset('request'); setError(null); setResetDone(false); }}
              >
                Can't log in?
              </button>{' '}
              Reset your password.
            </p>
          )}
        </form>

        {reset === 'request' && !resetSent && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true); setError(null);
              try {
                const token = await requestPasswordReset(email.trim());
                if (token) { setResetToken(token); setDevToken(true); }
                setResetSent(true);
                setReset('confirm');
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Could not send reset email.');
              }
              setBusy(false);
            }}
            className="space-y-3 mt-4 border-t pt-4"
          >
            <p className="text-sm text-atl-n-800">Reset your password</p>
            <p className="text-xs text-atl-n-200">
              Enter your account email and we'll send you a reset link.
            </p>
            <input
              type="email" name="email" required autoFocus autoComplete="username" placeholder="Email"
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded border-2 border-atl-n-40 text-sm text-atl-n-800 outline-none focus:border-atl-b-300"
            />
            <button type="submit" disabled={busy}
              className="w-full h-10 rounded bg-atl-b-300 hover:bg-atl-b-400 disabled:opacity-60 text-white text-sm font-medium">
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        {reset === 'confirm' && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true); setError(null);
              try {
                await confirmPasswordReset(resetToken.trim(), newPassword);
                setReset(null); setResetSent(false); setResetToken(''); setDevToken(false); setNewPassword('');
                setResetDone(true); setPassword('');
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Could not reset password. Check the token and try again.');
              }
              setBusy(false);
            }}
            className="space-y-3 mt-4 border-t pt-4"
          >
            <p className="text-sm text-atl-n-800">Choose a new password</p>
            {resetSent && (
              devToken ? (
                <p className="text-xs rounded bg-atl-y-50 border border-atl-y-300 px-2.5 py-1.5 text-atl-y-600">
                  Email delivery isn't configured on this server — the reset token was returned
                  directly and is pre-filled below.
                </p>
              ) : (
                <p className="text-xs text-atl-n-200">
                  If an account exists for that email, a reset token was sent. Paste it below.
                </p>
              )
            )}
            <input
              required autoFocus name="reset-token" autoComplete="off" placeholder="Reset token"
              value={resetToken} onChange={(e) => setResetToken(e.target.value)}
              className="w-full h-10 px-3 rounded border-2 border-atl-n-40 text-sm text-atl-n-800 outline-none focus:border-atl-b-300"
            />
            <input
              type="password" name="new-password" autoComplete="new-password" required minLength={8} placeholder="New password (min 8 characters)"
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              className="w-full h-10 px-3 rounded border-2 border-atl-n-40 text-sm text-atl-n-800 outline-none focus:border-atl-b-300"
            />
            <button type="submit" disabled={busy}
              className="w-full h-10 rounded bg-atl-b-300 hover:bg-atl-b-400 disabled:opacity-60 text-white text-sm font-medium">
              {busy ? 'Updating…' : 'Update password'}
            </button>
            <button type="button" onClick={() => { setReset(null); setResetSent(false); setDevToken(false); }}
              className="w-full text-xs text-atl-n-200 hover:text-atl-n-500">
              Back to log in
            </button>
          </form>
        )}

        {pending && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true); setError(null);
              try {
                const user = await loginTotp(pending, totp.trim());
                queryClient.setQueryData(['myself'], user);
                const next = params.get('next') ?? '/';
                navigate(next.startsWith('/') ? next : '/', { replace: true });
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Invalid authentication code.');
                setBusy(false);
              }
            }}
            className="space-y-3 mt-4 border-t pt-4"
          >
            <p className="text-sm text-atl-n-800">Enter your 6-digit authentication or backup code.</p>
            <input
              required autoFocus name="otp" inputMode="numeric" autoComplete="one-time-code" placeholder="Authentication code"
              value={totp} onChange={(e) => setTotp(e.target.value)}
              className="w-full h-10 px-3 rounded border-2 border-atl-n-40 text-sm text-atl-n-800 outline-none focus:border-atl-b-300"
            />
            <button type="submit" disabled={busy}
              className="w-full h-10 rounded bg-atl-b-300 hover:bg-atl-b-400 disabled:opacity-60 text-white text-sm font-medium">
              Verify
            </button>
          </form>
        )}

        {idps.length > 0 && !pending && !reset && (
          <div className="mt-6 space-y-2">
            <div className="text-xs text-atl-n-200 text-center">or continue with</div>
            {idps.map((i) => {
              const next = params.get('next');
              const suffix = next?.startsWith('/') ? `?next=${encodeURIComponent(next)}` : '';
              return (
              <a key={i.id} href={`/api/internal/auth/oidc/${i.name}${suffix}`}
                className="block w-full h-10 leading-10 rounded border border-atl-n-40 text-center text-sm text-atl-n-800 hover:bg-atl-n-10">
                Sign in with {i.name}
              </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
