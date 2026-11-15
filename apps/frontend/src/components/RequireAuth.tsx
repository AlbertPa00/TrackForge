import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, fetchMyself } from '../api/client.js';

function RateLimited({ retryAfter, refetch }: { retryAfter: number; refetch: () => void }) {
  const [remaining, setRemaining] = useState(retryAfter);
  useEffect(() => {
    const timer = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (remaining === 0) refetch();
  }, [remaining, refetch]);
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-3 text-sm text-atl-n-300">
      <p>Too many requests — retrying{remaining > 0 ? ` in ${remaining}s` : '…'}</p>
      <button
        onClick={refetch}
        className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white"
      >
        Retry now
      </button>
    </div>
  );
}

export default function RequireAuth() {
  const location = useLocation();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['myself'],
    queryFn: fetchMyself,
    staleTime: Infinity,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-full flex items-center justify-center text-sm text-atl-n-200">
        Loading…
      </div>
    );
  }

  if (isError) {
    // Only genuine auth failures bounce to login — transient errors
    // (429 rate limit, 5xx, network) get a retry screen instead of
    // logging the user out.
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        const next = `${location.pathname}${location.search}`;
        return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
      }
      if (error.status === 429) {
        const wait = Math.min(Math.max(error.retryAfter ?? 30, 5), 120);
        return <RateLimited retryAfter={wait} refetch={() => void refetch()} />;
      }
    }
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-3 text-sm text-atl-n-300">
        <p>Could not reach the server. Check your connection and try again.</p>
        <button
          onClick={() => void refetch()}
          className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return <Outlet />;
}
