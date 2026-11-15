/** 068 — one-line handoff into the Copilot dock: the palette, TopNav button and
 *  future surfaces all funnel through this event instead of owning open state. */
export const COPILOT_OPEN_EVENT = 'tf:open-copilot';

export function openCopilot(prompt?: string) {
  window.dispatchEvent(new CustomEvent(COPILOT_OPEN_EVENT, { detail: { prompt } }));
}
