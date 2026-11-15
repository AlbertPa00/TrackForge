import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchMyself } from '../api/client.js';

/**
 * 021 — admin-only route group. Non-admin users see a 404-style page rather
 * than a 403/redirect, so the admin surface's existence isn't disclosed.
 */
export default function RequireAdmin() {
  const { data, isLoading } = useQuery({
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

  if (!data?.isAdmin) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-2 p-8">
        <div className="text-[24px] font-semibold text-atl-n-800">404</div>
        <div className="text-sm text-atl-n-200">The page you requested could not be found.</div>
      </div>
    );
  }

  return <Outlet />;
}
