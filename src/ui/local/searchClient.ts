/**
 * The page's client for the search coordinator worker
 * (src/ui/workers/searchWorker.ts): spawn one coordinator per search, carry
 * the conversation, and keep the folder's side of the bargain. All search
 * POLICY lives behind the worker (the executor) and in the neutral manager;
 * this module owns exactly two things —
 *
 * 1. THE IO SERVICE. The coordinator performs no folder IO (its header
 *    documents why); every 'io' request it posts is answered HERE, on the
 *    guarded main context, through the same composed stores as every other
 *    read and write in local mode. The single-writer guard and the
 *    serialized chains hold because this is the only context that touches
 *    the folder.
 *
 * 2. THE KILLED-TAB GUARD (browser-port decision D5, the default: no
 *    checkpointing). While any search is running, closing the tab costs that
 *    search's entire progress — the coordinator and its pool die with the
 *    tab, and nothing has been persisted yet. The browser cannot refuse a
 *    close, only warn, so this module registers a beforeunload confirmation
 *    for exactly the window a search is in flight and removes it the moment
 *    the report settles (a cancelled search's partial report counts: once it
 *    is back on the main context, the work that survives is safe). On reopen
 *    nothing pretends the search survived: no report file exists, the
 *    manager has never heard of the id, and the Search page's bookmark is
 *    forgotten on its first 404 — the same honest sequence a restarted
 *    server produces for a search that died with it.
 */
import type { SearchReport } from '../../shared/types';
import type { SearchIo } from '../../store/search/pool';
import type { SearchRunner } from '../../store/searchManager';
import type {
  SearchCoordinatorReply,
  SearchCoordinatorRequest,
} from '../workers/searchWorker';

// ---------------------------------------------------------------------------
// The beforeunload guard — active exactly while searches are in flight
// ---------------------------------------------------------------------------

let runningSearches = 0;

function warnOnUnload(ev: BeforeUnloadEvent): void {
  // The standard incantation: preventDefault flags the dialog, returnValue
  // keeps older Chromium honouring it. The browser shows its own generic
  // wording; the point is the pause, not the prose.
  ev.preventDefault();
  ev.returnValue = '';
}

function searchStarted(): void {
  runningSearches += 1;
  if (runningSearches === 1) addEventListener('beforeunload', warnOnUnload);
}

function searchSettled(): void {
  runningSearches -= 1;
  if (runningSearches === 0) removeEventListener('beforeunload', warnOnUnload);
}

/**
 * Whether any search is in flight RIGHT NOW — the folder switcher's
 * pre-check, the sibling of scoringGuard.scoringInFlight and for the same
 * reason: a switch releases the writer guard before it reloads, and a reload
 * this module's own beforeunload dialog talks the user out of must not leave
 * a live searching tab writing into an unguarded folder.
 */
export function searchesInFlight(): boolean {
  return runningSearches > 0;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * A SearchRunner (see store/searchManager.ts) over the coordinator worker.
 * `io` is the folder-touching trio, built by the local backend from ITS
 * composed stores — the runner never reaches for a store itself.
 */
export function createBrowserSearchRunner(io: SearchIo): SearchRunner {
  return (searchId, request, deps, onProgress) => {
    const worker = new Worker(new URL('../workers/searchWorker.ts', import.meta.url), {
      type: 'module',
    });

    const send = (msg: SearchCoordinatorRequest): void => worker.postMessage(msg);

    const serviceIo = async (msg: SearchCoordinatorReply & { type: 'io' }): Promise<void> => {
      try {
        let value: unknown;
        if (msg.op === 'readScore') value = await io.readScore(msg.runKey);
        else if (msg.op === 'writeScore') value = await io.writeScore(msg.score);
        else value = await io.readCachedResult(msg.runKey);
        send({ type: 'io-result', ioId: msg.ioId, ok: true, value });
      } catch (err) {
        send({
          type: 'io-result',
          ioId: msg.ioId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    searchStarted();
    let settled = false;
    const report = new Promise<SearchReport>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        searchSettled();
        // Terminating the coordinator takes its score-worker pool with it —
        // nested workers die with their parent.
        worker.terminate();
        fn();
      };
      worker.onmessage = (ev: MessageEvent<SearchCoordinatorReply>) => {
        const msg = ev.data;
        if (msg.type === 'progress') onProgress(msg.patch);
        else if (msg.type === 'io') void serviceIo(msg);
        else if (msg.type === 'done') settle(() => resolve(msg.report));
        else if (msg.type === 'error') {
          settle(() => {
            // The posted string is the worker-side stack; keep it as the
            // error's stack so the manager records the same text the node
            // manager would.
            const err = new Error(msg.error.split('\n')[0]);
            err.stack = msg.error;
            reject(err);
          });
        }
      };
      worker.onerror = (ev) => {
        settle(() =>
          reject(new Error(`Search coordinator worker crashed: ${ev.message || 'unknown error'}`)),
        );
      };
      send({
        type: 'start',
        searchId,
        request,
        profile: deps.profile,
        assumptions: deps.assumptions,
      });
    });

    return {
      report,
      // postMessage to a terminated worker is a silent no-op, so a cancel
      // racing the report's settlement needs no guard.
      cancel: () => send({ type: 'cancel' }),
    };
  };
}
