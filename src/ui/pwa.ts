/**
 * SERVICE-WORKER REGISTRATION + THE UPDATE AFFORDANCE (Phase 7).
 *
 * The worker itself is generated at deploy time (scripts/pagesExtras.ts —
 * precache of the built files, versioned by their bytes). This module is
 * the page half of its boring, correct update story:
 *
 *   - REGISTRATION IS OPT-IN PER BUILD: only a build with VITE_FPLAN_SW=1
 *     (the pages workflow) registers anything. `npm run dev`, the parked
 *     legacy server's build, and every browser-lane bundle never do — the
 *     lane asserts zero registrations, so a SW can never quietly start
 *     intercepting test traffic.
 *   - A NEW VERSION NEVER SWAPS IN MID-SESSION. The generated worker does
 *     not skipWaiting on install; it sits waiting until every tab closes —
 *     or until the user clicks the small "Reload to update" bar this
 *     module surfaces (useSwUpdate → App.tsx). The click posts
 *     SKIP_WAITING and reloads on controllerchange. A simulation in flight
 *     therefore cannot have its worker bundle yanked: the swap happens
 *     only through a reload the user asked for — and the beforeunload
 *     scoring/search guards still stand in front of that reload.
 *   - The failure this prevents is the browser edition of the "engine
 *     1.10.0 under a 1.11.0 UI" incident the old server guarded against
 *     (risk R9): a stale cached engine under fresh UI, or half-old
 *     half-new chunks mid-deploy.
 */
import { useEffect, useReducer } from 'react';

/** Set when a NEW worker is installed and waiting behind a live one. */
let activateWaiting: (() => void) | null = null;
const listeners = new Set<() => void>();

function offerUpdate(worker: ServiceWorker): void {
  activateWaiting = () => {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => location.reload(),
      { once: true },
    );
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  for (const notify of listeners) notify();
}

function watchWorker(worker: ServiceWorker | null): void {
  if (worker === null) return;
  const check = (): void => {
    // 'installed' with a live controller = an UPDATE waiting. (First-ever
    // install has no controller: it takes over silently on the next load,
    // and prompting for it would be noise.)
    if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
  };
  check();
  worker.addEventListener('statechange', check);
}

/** Called once from main.tsx. A no-op everywhere but the opted-in build. */
export function maybeRegisterServiceWorker(): void {
  if ((import.meta.env?.VITE_FPLAN_SW as string | undefined) !== '1') return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then((registration) => {
        watchWorker(registration.waiting);
        watchWorker(registration.installing);
        registration.addEventListener('updatefound', () =>
          watchWorker(registration.installing),
        );
      })
      .catch((err: unknown) => {
        // The app is fully functional without the SW; say so and move on.
        console.warn('[sw] registration failed (the app works without it):', err);
      });
  });
}

/**
 * The App's hook: null until an update is waiting, then the function that
 * reloads into it. Re-renders subscribers exactly once, when the offer
 * appears.
 */
export function useSwUpdate(): (() => void) | null {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return activateWaiting;
}
