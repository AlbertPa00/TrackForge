import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Kind = 'success' | 'error' | 'info';
interface Flag {
  id: number;
  kind: Kind;
  message: string;
}

const FlagCtx = createContext<(kind: Kind, message: string) => void>(() => {});

/** `flag.success('User created')` / `flag.error(msg)` — the app's single
 *  feedback channel. Replaces silent failures and ad-hoc red banners. */
export function useFlag() {
  const push = useContext(FlagCtx);
  return {
    success: (m: string) => push('success', m),
    error: (m: string) => push('error', m),
    info: (m: string) => push('info', m),
  };
}

const ICON: Record<Kind, { path: string; cls: string }> = {
  success: {
    cls: 'text-atl-g-500',
    path: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7 11.6 4.4 9l1-1L7 9.6l3.6-3.6 1 1z',
  },
  error: {
    cls: 'text-atl-r-400',
    path: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm-.75 3h1.5v5h-1.5zm0 6h1.5v1.5h-1.5z',
  },
  info: {
    cls: 'text-atl-b-300',
    path: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm-.75 2.5h1.5v1.5h-1.5zm0 3h1.5v5h-1.5z',
  },
};

const BORDER: Record<Kind, string> = {
  success: 'border-atl-g-300',
  error: 'border-atl-r-300',
  info: 'border-atl-b-200',
};

export function FlagProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<Flag[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setFlags((f) => f.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: Kind, message: string) => {
      const id = ++idRef.current;
      setFlags((f) => [...f.slice(-4), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 5000);
    },
    [dismiss]
  );

  return (
    <FlagCtx.Provider value={push}>
      {children}
      <div
        className="fixed bottom-4 left-4 z-[90] flex w-80 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {flags.map((f) => (
          <div
            key={f.id}
            className={`flex items-start gap-2.5 rounded border bg-atl-paper px-3 py-2.5 shadow-lg ${BORDER[f.kind]}`}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" className={`mt-0.5 shrink-0 ${ICON[f.kind].cls}`} fill="currentColor">
              <path d={ICON[f.kind].path} />
            </svg>
            <span className="min-w-0 flex-1 text-sm text-atl-n-800">{f.message}</span>
            <button
              type="button"
              onClick={() => dismiss(f.id)}
              aria-label="Dismiss"
              className="shrink-0 text-atl-n-200 hover:text-atl-n-500"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="m2.5 2.5 7 7m0-7-7 7" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </FlagCtx.Provider>
  );
}
