/**
 * Minimal LexoRank: fixed-width base-36 strings ordering lexicographically.
 * New cards get evenly-spaced ranks; dropping between two neighbours takes the
 * midpoint; when neighbours are adjacent (gap <= 1) the column rebalances by
 * re-spacing every rank — invisible to users, order preserved.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = BigInt(ALPHABET.length);
const WIDTH = 12;
const MAX = BASE ** BigInt(WIDTH);
const STEP = MAX / 1_000_000n; // ~4.7e12 — supports ~1M cards before rebalance

function decode(rank: string): bigint {
  let n = 0n;
  for (const ch of rank) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) continue; // skip foreign chars (e.g. '|' in Jira-style "0|000abc" ranks)
    n = n * BASE + BigInt(d);
  }
  return n;
}

function encode(n: bigint): string {
  let out = '';
  let v = n;
  for (let i = 0; i < WIDTH; i++) {
    out = ALPHABET[Number(v % BASE)] + out;
    v = v / BASE;
  }
  return out;
}

/** Rank for the Nth item on an empty board (1-based). */
export function initialRank(position = 1): string {
  return encode(STEP * BigInt(position));
}

/** Ranks `count` items evenly (used for backfill/rebalance). */
export function spreadRanks(count: number): string[] {
  return Array.from({ length: count }, (_, i) => encode(STEP * BigInt(i + 1)));
}

/**
 * Returns a rank strictly between `before` and `after`, or null when the two
 * are adjacent — caller must rebalance and retry.
 */
export function rankBetween(before: string | null, after: string | null): string | null {
  const lo = before ? decode(before) : 0n;
  const hi = after ? decode(after) : MAX;
  if (hi <= lo) return null;
  if (hi - lo <= 1n) return null;
  return encode((lo + hi) / 2n);
}

/**
 * Rank to append after `last` — one fixed STEP up, not the midpoint to MAX
 * (midpoint append halves the remaining space each write and saturates the
 * top of the space after a few dozen creates). Always returns a string.
 */
export function rankAfter(last: string): string {
  const n = decode(last) + STEP;
  if (n < MAX) {
    const encoded = encode(n);
    if (encoded > last) return encoded;
  }
  // Foreign-format rank (e.g. Jira "0|000abc") or space full: extend the
  // string so it still sorts after `last` (longer string, same prefix).
  return `${last}i`;
}
