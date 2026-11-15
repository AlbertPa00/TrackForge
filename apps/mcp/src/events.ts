// Minimal SSE reader for /api/internal/events/stream — Node has no stable
// global EventSource, so we parse the wire format from a fetch body.

export interface StreamEvent {
  id?: string;
  event?: string;
  data?: string;
}

export function subscribeStream(
  url: string,
  headers: Record<string, string>,
  onEvent: (ev: StreamEvent) => void,
  onError?: (err: unknown) => void
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev: StreamEvent = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue; // comment/heartbeat
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let val = colon < 0 ? '' : line.slice(colon + 1);
            if (val.startsWith(' ')) val = val.slice(1);
            if (field === 'id') ev.id = val;
            else if (field === 'event') ev.event = val;
            else if (field === 'data') ev.data = (ev.data ?? '') + val;
          }
          if (ev.event || ev.data) onEvent(ev);
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) onError?.(e);
    }
  })();
  return () => ctrl.abort();
}
