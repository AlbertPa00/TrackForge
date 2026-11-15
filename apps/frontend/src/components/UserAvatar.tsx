import { AVATAR_COLORS } from '../lib/palette.js';

const PALETTE = AVATAR_COLORS;

// Distinct, easy-to-spot emoji glyphs assigned deterministically per user
// (name hash) so the same person reads the same across every surface — unless
// the user picked one on their profile (avatarEmoji overrides, 066).
export const EMOJIS = [
  '🦊', '🐼', '🦉', '🐝', '🐙', '🦄', '🐳', '🦋', '🌵', '🍄',
  '🍉', '🥑', '🚀', '⚡', '🎯', '🎧', '🐯', '🐨', '🦖', '🐬',
  '🌻', '🍀', '🧭', '🏔️', '🦩', '🐢', '🦜', '🐿️', '🍩', '🎨',
  '🧊', '🌋', '🦎', '🐾', '🎸', '🛰️', '💎', '🧲', '🔥', '🌊',
];

export default function UserAvatar({
  displayName,
  size = 24,
  emoji,
}: {
  displayName?: string | null;
  size?: number;
  /** User-chosen glyph; null/undefined falls back to the name-hash pick. */
  emoji?: string | null;
}) {
  if (!displayName) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full bg-atl-n-40 text-atl-n-100 shrink-0"
        style={{ width: size, height: size }}
        title="Unassigned"
      >
        <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="5.5" r="2.75" />
          <path d="M2.5 13.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5z" />
        </svg>
      </span>
    );
  }

  const sum = [...displayName].reduce((a, c) => a + c.charCodeAt(0), 0);
  const bg = PALETTE[sum % PALETTE.length];
  const glyph = emoji ?? EMOJIS[sum % EMOJIS.length];

  return (
    <span
      className="inline-flex items-center justify-center rounded-full shrink-0 select-none"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: size * 0.6 }}
      title={displayName}
      role="img"
      aria-label={displayName}
    >
      <span style={{ lineHeight: 1 }}>{glyph}</span>
    </span>
  );
}
