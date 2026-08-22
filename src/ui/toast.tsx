/**
 * Toast notifications (test-drive note 1).
 *
 * ============================== FOR PAGES ==================================
 * Any component under <ToastProvider> (mounted at the root in App.tsx) can:
 *
 *     const { showToast } = useToast();
 *     showToast('Profile saved');                    // success (default)
 *     showToast('Save failed', { kind: 'error' });
 *
 * Toasts stack bottom-right, auto-dismiss after 2.5s, can be clicked away,
 * and are announced politely to screen readers. Styling lives in styles.css
 * (.toast-stack / .toast) and follows the active theme.
 * ===========================================================================
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error';

export interface ToastOptions {
  /** Visual treatment; default 'success'. */
  kind?: ToastKind;
}

export interface ToastApi {
  showToast: (message: string, opts?: ToastOptions) => void;
}

export const TOAST_DURATION_MS = 2500;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() requires <ToastProvider> (mounted in App)');
  }
  return ctx;
}

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** Monotonic id counter (no Math.random — ids only need uniqueness). */
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer != null) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, opts?: ToastOptions) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts, { id, message, kind: opts?.kind ?? 'success' }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_DURATION_MS),
      );
    },
    [dismiss],
  );

  // Clear any pending timers if the provider unmounts.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={t.kind === 'error' ? 'toast error' : 'toast success'}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
