export type DiffRow = { type: 'same' | 'add' | 'del'; text: string };

/**
 * 058 US4 — line-level LCS diff for AI draft previews. Descriptions are small
 * (a few hundred lines); over the guard we degrade to del-all/add-all rather
 * than allocating a giant DP table.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) rows.push({ type: 'del', text: a[i++]! });
  while (j < n) rows.push({ type: 'add', text: b[j++]! });
  return rows;
}
