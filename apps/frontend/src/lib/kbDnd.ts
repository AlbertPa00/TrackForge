// 037 US2-2 — keyboard-DnD insertion math. `pos` is an insertion index into
// the column list *excluding* the dragged card; these helpers convert it to
// the before/after anchor keys handleDrop expects, and compute a row's index
// in the filtered list (for marker placement).
export function kbDropTargets<T extends { key: string }>(list: T[], dragKey: string, pos: number) {
  const l = list.filter((i) => i.key !== dragKey);
  return { before: l[pos]?.key as string | undefined, after: l[pos - 1]?.key as string | undefined, len: l.length };
}

export function kbFilteredIndex<T extends { key: string }>(list: T[], dragKey: string, idx: number) {
  return list.slice(0, idx).filter((i) => i.key !== dragKey).length;
}
