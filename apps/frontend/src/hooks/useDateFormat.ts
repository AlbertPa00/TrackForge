import { useQuery } from '@tanstack/react-query';
import { fetchProfile } from '../api/client.js';
import { formatDatePattern } from '../lib/format.js';

/** The user's date-format preference (profile). Defaults to Jira's d/MMM/yy. */
export function useDateFormat() {
  const { data } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    staleTime: 60_000,
  });
  const pattern = data?.user.dateFormat || 'd/MMM/yy';
  return { pattern, format: (iso: string) => formatDatePattern(iso, pattern) };
}
