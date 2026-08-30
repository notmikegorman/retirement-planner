/**
 * The dirty-form blocker — the smplkit standard's unsaved-changes guard,
 * ported to this app's navigation.
 *
 * The smplkit original intercepts anchor clicks in the capture phase because
 * that app navigates through <Link>s. This app's nav is buttons calling
 * navigate(), so the interception point is nav.ts's navigation guard instead:
 * the hook registers a guard while mounted, the guard stalls any page-leaving
 * move while the form is dirty, and <DiscardChangesPrompt> asks the one
 * question. `beforeunload` covers full page leaves (close, reload) with the
 * browser's own dialog, exactly as the original does. The browser's Back
 * button is the one deliberate gap, in both apps: popstate reports a URL the
 * browser has already changed, and arguing with it loses.
 *
 * One page may hold the guard at a time — which is the invariant nav.ts's
 * single guard slot enforces for free, since only the mounted page registers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { setNavigationGuard, type Route } from './nav';

export interface DirtyFormBlocker {
  /** True while a navigation is stalled behind the prompt. */
  blocked: boolean;
  /** Discard the edits and finish exactly the navigation that was asked for. */
  proceed: () => void;
  /** Keep editing: drop the stalled navigation, close the prompt. */
  reset: () => void;
}

export function useDirtyFormBlocker(
  dirty: boolean,
  opts?: {
    /** Runs on Discard, before the navigation, to let the page reset state. */
    onDiscard?: () => void;
    /** Moves the guard should wave through — e.g. tab switches within the page. */
    safeNavigation?: (next: Route) => boolean;
  },
): DirtyFormBlocker {
  const [blocked, setBlocked] = useState(false);
  /** The stalled navigation's continuation; a ref so proceed() runs it once. */
  const pendingRef = useRef<(() => void) | null>(null);
  // Mirrored into refs so the long-lived guard callback never closes over a
  // stale render (the smplkit original does exactly this, for the same reason).
  const dirtyRef = useRef(dirty);
  const onDiscardRef = useRef(opts?.onDiscard);
  const safeRef = useRef(opts?.safeNavigation);
  dirtyRef.current = dirty;
  onDiscardRef.current = opts?.onDiscard;
  safeRef.current = opts?.safeNavigation;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome still wants a returnValue to show its dialog.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    setNavigationGuard((next, proceed) => {
      if (!dirtyRef.current) return false;
      if (safeRef.current?.(next) === true) return false;
      pendingRef.current = proceed;
      setBlocked(true);
      return true;
    });
    return () => setNavigationGuard(null);
  }, []);

  const proceed = useCallback(() => {
    const go = pendingRef.current;
    pendingRef.current = null;
    setBlocked(false);
    if (go !== null) {
      onDiscardRef.current?.();
      // Preempt re-interception: the guard must not stall the very move the
      // user just approved while React is still applying the state updates.
      dirtyRef.current = false;
      go();
    }
  }, []);

  const reset = useCallback(() => {
    pendingRef.current = null;
    setBlocked(false);
  }, []);

  return { blocked, proceed, reset };
}

/**
 * The shared prompt — never roll a page-local variant (the standard's rule).
 * Same strictness as the smplkit original: no backdrop dismiss; the ways out
 * are the two buttons and Escape (which keeps editing). Focus lands on Keep
 * editing when the prompt opens, so a keyboard user's next keys drive the
 * dialog — and a reflexive Enter preserves work rather than discarding it.
 */
export function DiscardChangesPrompt({ blocker }: { blocker: DirtyFormBlocker }) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (blocker.blocked) keepRef.current?.focus();
  }, [blocker.blocked]);

  if (!blocker.blocked) return null;
  return (
    <div
      className="deleteConfirmOverlay"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') blocker.reset();
      }}
    >
      <div className="deleteConfirmPanel" role="dialog" aria-modal="true">
        <h3>Discard unsaved changes?</h3>
        <p>You have unsaved edits. Leaving now will lose them.</p>
        <div className="deleteConfirmActions">
          <button ref={keepRef} type="button" onClick={blocker.reset}>
            Keep editing
          </button>
          <button type="button" className="danger" onClick={blocker.proceed}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
