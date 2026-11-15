import { ACCENT } from '../lib/palette.js';

export default function IssueTypeIcon({
  name,
  size = 16,
  hierarchyLevel,
}: {
  name: string;
  size?: number;
  // Semantic check first — imported projects localize type names ('Épica'),
  // so the name map below is only a fallback.
  hierarchyLevel?: number;
}) {
  const n = name.toLowerCase();
  const W = ACCENT.white;
  let body;

  if (hierarchyLevel === 1 || n === 'epic') {
    body = (
      <>
        <rect width="16" height="16" rx="3" fill={ACCENT.purple} />
        <path d="M9.6 3 4.8 9h2.3L6.4 13l4.8-6H8.9z" fill={W} />
      </>
    );
  } else if (hierarchyLevel === -1 || n === 'subtask' || n === 'sub-task') {
    body = (
      <>
        <rect width="16" height="16" rx="3" fill={ACCENT.slate} />
        <rect x="3.5" y="3.5" width="5" height="5" rx="1" fill={W} />
        <path d="M9.5 12.5h3v-3" stroke={W} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </>
    );
  } else if (n === 'bug') {
    body = (
      <>
        <circle cx="8" cy="8" r="7" fill={ACCENT.red} />
        <circle cx="8" cy="8" r="2.5" fill={W} />
      </>
    );
  } else if (n === 'story') {
    body = (
      <>
        <rect width="16" height="16" rx="3" fill={ACCENT.teal} />
        <path d="M4.5 3.5h7V13l-3.5-2.3L4.5 13z" fill={W} />
      </>
    );
  } else {
    body = (
      <>
        <rect width="16" height="16" rx="3" fill={ACCENT.blue} />
        <path d="m6.8 11.4-3.1-3.1 1.2-1.2 1.9 1.9 4.3-4.3 1.2 1.2z" fill={W} />
      </>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-label={name}
      role="img"
      className="inline-block shrink-0"
    >
      {body}
    </svg>
  );
}
