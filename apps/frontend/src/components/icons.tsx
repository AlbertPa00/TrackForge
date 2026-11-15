/** Shared inline SVG icons — Atlassian-style outlined glyphs. */

type P = { size?: number; className?: string; title?: string };

function Svg({ size = 16, className, title, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export function FlagIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M3.5 2.5v11" />
      <path d="M3.5 3h7l-1.5 2.5L10.5 8h-7" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CommentIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </Svg>
  );
}

export function AttachmentIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M10.5 4.5 5.8 9.2a2.1 2.1 0 0 0 3 3l5-5a3.5 3.5 0 0 0-5-5l-5 5a4.9 4.9 0 0 0 7 7l4.2-4.2" />
    </Svg>
  );
}

export function LinkIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M7 4.5 8.5 3a2.8 2.8 0 0 1 4 4L11 8.5" />
      <path d="M9 11.5 7.5 13a2.8 2.8 0 0 1-4-4L5 7.5" />
    </Svg>
  );
}

export function StarIcon({ filled, ...p }: P & { filled?: boolean }) {
  return (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      className={p.className}
      role={p.title ? 'img' : undefined}
      aria-label={p.title}
      aria-hidden={p.title ? undefined : true}
    >
      {p.title && <title>{p.title}</title>}
      <path d="m8 2.2 1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.5l4-.6z" />
    </svg>
  );
}

export function CloseIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function PencilIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m9.5 3.5 3 3L6 13H3v-3z" />
      <path d="m8 5 3 3" />
    </Svg>
  );
}

export function CheckIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m3 8.5 3.5 3.5L13 5" />
    </Svg>
  );
}

export function CrossIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function PeopleIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5c.5-2.5 2.4-4 4.5-4s4 1.5 4.5 4" />
      <path d="M10.5 3.4a2.5 2.5 0 0 1 0 4.2M11.5 9.7c1.7.6 2.7 1.9 3 3.8" />
    </Svg>
  );
}

export function PersonIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.5 13.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5z" />
    </Svg>
  );
}

export function GearIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
    </Svg>
  );
}

export function MoreIcon(p: P) {
  return (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={p.className}
      role={p.title ? 'img' : undefined}
      aria-label={p.title}
      aria-hidden={p.title ? undefined : true}
    >
      {p.title && <title>{p.title}</title>}
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

export function SparkleIcon(p: P) {
  return (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={p.className}
      role={p.title ? 'img' : undefined}
      aria-label={p.title}
      aria-hidden={p.title ? undefined : true}
    >
      {p.title && <title>{p.title}</title>}
      <path d="M8 1.2 9.7 5.3l4.1.6-3 2.9.8 4.1L8 10.9l-3.6 1.9.8-4.1-3-2.9 4.1-.6z" />
    </svg>
  );
}

export function SearchIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </Svg>
  );
}

export function ChevronRightIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  );
}

export function ChevronDownIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m4 6 4 4 4-4" />
    </Svg>
  );
}

export function CopyIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5" />
    </Svg>
  );
}

export function ArrowLeftIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M13.5 8h-11M6 4.5 2.5 8l3.5 3.5" />
    </Svg>
  );
}

export function ArrowRightIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.5 8h11M10 4.5 13.5 8 10 11.5" />
    </Svg>
  );
}

export function SunIcon(p: P) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </Svg>
  );
}

export function MoonIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M13.5 9.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7z" />
    </Svg>
  );
}

export function MenuIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Svg>
  );
}

/* Docs-section glyphs (050 portal refresh). */
export function RocketIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M8 14.5c3-1.5 5-4.5 5-8a12 12 0 0 0-1-4.5A12 12 0 0 0 7.5 1c-3.5 0-6.5 2-8 5l2.5-.5c-.5 2-.5 4 .5 5.5l-1 2.5z" />
      <circle cx="10" cy="6" r="1.2" />
      <path d="M5.5 10.5c-1 0-2.5 1.5-3 3 1.5-.5 3-2 3-3z" />
    </Svg>
  );
}

export function BookIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.5 3A1.5 1.5 0 0 1 4 1.5h9.5v11H4A1.5 1.5 0 0 0 2.5 14z" />
      <path d="M2.5 14V3M13.5 12.5H4" />
    </Svg>
  );
}

export function ShieldIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M8 1.5 13 3.5v4c0 3.5-2.5 6-5 7-2.5-1-5-3.5-5-7v-4z" />
      <path d="m5.5 8 1.8 1.8L10.5 6.5" />
    </Svg>
  );
}

export function ServerIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <path d="M4.5 4.75h.01M4.5 11.25h.01" />
    </Svg>
  );
}

export function SwapIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.5 5h9l-2.5-2.5M13.5 11h-9L7 13.5" />
    </Svg>
  );
}

export function CodeIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
    </Svg>
  );
}

export function TagIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M8.5 1.5h5v5l-7 7-5-5z" />
      <circle cx="11" cy="4" r="1" />
    </Svg>
  );
}

export function FlaskIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M6.5 1.5h3M7 1.5v5l-4 7a1 1 0 0 0 .9 1.5h8.2a1 1 0 0 0 .9-1.5l-4-7v-5" />
      <path d="M5 10h6" />
    </Svg>
  );
}
