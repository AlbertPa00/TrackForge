/**
 * IME composition guard for custom Enter-to-submit keydown handlers.
 *
 * CJK Input Method Editors confirm the pending candidate with an Enter
 * keydown; acting on that keystroke submits half-composed text. The
 * `keyCode === 229` arm covers Safari's out-of-order compositionend
 * (WebKit bug 165004) where `isComposing` has already reset to false by
 * the time the confirming Enter keydown reaches the handler.
 *
 * Accepts both native KeyboardEvents and React synthetic events (whose
 * type does not surface `isComposing`/`keyCode`; they live on
 * `nativeEvent`).
 */
export function imeComposing(e: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  const n = e.nativeEvent ?? e;
  return n.isComposing === true || n.keyCode === 229;
}
