// 060 US5 — public /invite/:token page: the invitee sets a password and the
// account activates (POST /api/internal/auth/invite-accept).
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { acceptInvite, ApiError } from '../api/client.js';

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setPending(true);
    try {
      await acceptInvite(token ?? '', password);
      navigate('/login?invited=1');
    } catch (err) {
      setError(err instanceof ApiError ? err.errorMessages[0] ?? err.message : 'Invite link is invalid or expired.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-atl-n-10">
      <form onSubmit={submit} className="w-96 bg-atl-paper border border-atl-n-30 rounded p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-atl-n-800">Welcome to TrackForge</h1>
        <p className="mt-1 mb-4 text-sm text-atl-n-300">Set a password to activate your account.</p>
        <label className="block text-sm mb-3">
          <span className="text-atl-n-400">Password</span>
          <input
            autoFocus
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            minLength={8}
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="block text-sm mb-3">
          <span className="text-atl-n-400">Confirm password</span>
          <input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            required
            minLength={8}
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && <p className="mb-3 text-sm text-atl-r-400">{error}</p>}
        <button
          type="submit"
          disabled={pending || password.length < 8}
          className="w-full rounded bg-atl-b-400 px-3 py-2 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
        >
          {pending ? 'Activating…' : 'Activate account'}
        </button>
        <p className="mt-3 text-center text-xs text-atl-n-200">
          Already have an account? <Link to="/login" className="text-atl-b-400 hover:underline">Log in</Link>
        </p>
      </form>
    </div>
  );
}
