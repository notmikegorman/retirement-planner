/**
 * The SEARCH COORDINATOR worker: the environment-neutral executor
 * (src/store/search/execute.ts — the chunked evaluate loop, the cancellation
 * checks, the report assembly), running in a dedicated Web Worker.
 *
 * WHY A WORKER AT ALL. Browsers throttle main-thread timers in hidden tabs to
 * once a minute or worse; a twenty-minute search coordinated from the page
 * would crawl the moment the user switched tabs. Worker timers are not
 * throttled, so the coordinator lives here — and because browsers let workers
 * spawn workers, it OWNS its score-worker pool (searchPool.ts): every part of
 * the search that computes or schedules runs off the main thread.
 *
 * THE WRITE BOUNDARY, which is the one deliberate asymmetry: this worker
 * performs NO folder IO. All reads and writes — the slim score cache, the
 * run-cache lookups, the finished report — cross back to the guarded main
 * context as messages (the 'io' request/reply pairs below) and go through the
 * SAME composed stores as every other write in local mode. That is what keeps
 * the single-writer discipline and the serialized write chains whole: one
 * context owns the folder, and a coordinator that opened its own OPFS handles
 * would be a second writer with a green typecheck. The cost is a message
 * round-trip per cache probe, which is noise against the ~seconds of
 * simulation an evaluation costs; the alternative costs the invariant that
 * protects irreplaceable records.
 *
 * CANCELLATION crosses as a message too: the page's cancel reaches the
 * manager, the manager's handle posts {type:'cancel'}, and this worker's
 * event loop — idle between chunks while the pool computes — flips the flag
 * the executor polls, exactly as the server's closure boolean does. In-flight
 * jobs finish and are discarded; the truncated partial report comes back like
 * any other (the executor writes the same CANCELLED caveat in both worlds).
 *
 * THE KILLED-TAB RULE (browser-port decision D5, the default): there is no
 * checkpointing. A killed tab takes this worker and its pool with it, and the
 * search's progress since its start is gone — honestly gone: nothing is
 * persisted until the report is, so a reopened tab finds no half-report to
 * mistake for a finished one, the page's bookmark 404s and is forgotten, and
 * the beforeunload warning (searchClient.ts) is the one line of defence the
 * browser allows. What a cancelled search keeps (the partial report) a killed
 * tab deliberately does not.
 */
import type {
  Assumptions,
  Profile,
  RunResult,
  SearchProgress,
  SearchReport,
  SearchRequest,
} from '../../shared/types';
import { runSearch } from '../../store/search/execute';
import { CachedEvaluator, type SearchIo } from '../../store/search/pool';
import type { SearchScore } from '../../store/search/scoreStore';
import { createBrowserSimPool, defaultBrowserPoolSize } from './searchPool';

/** Main context → coordinator. */
export type SearchCoordinatorRequest =
  | {
      type: 'start';
      searchId: string;
      request: SearchRequest;
      profile: Profile;
      assumptions: Assumptions;
    }
  | { type: 'cancel' }
  | { type: 'io-result'; ioId: number; ok: boolean; value?: unknown; error?: string };

/** Coordinator → main context. */
export type SearchCoordinatorReply =
  | { type: 'progress'; patch: Partial<SearchProgress> }
  | { type: 'io'; ioId: number; op: 'readScore'; runKey: string }
  | { type: 'io'; ioId: number; op: 'writeScore'; score: SearchScore }
  | { type: 'io'; ioId: number; op: 'readCachedResult'; runKey: string }
  | { type: 'done'; report: SearchReport }
  | { type: 'error'; error: string };

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<SearchCoordinatorRequest>) => void) | null;
  postMessage(msg: SearchCoordinatorReply): void;
};

function post(msg: SearchCoordinatorReply): void {
  workerScope.postMessage(msg);
}

// ---------------------------------------------------------------------------
// The IO proxy — every folder touch becomes a request/reply pair
// ---------------------------------------------------------------------------

let nextIoId = 1;
const pendingIo = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ioCall<T>(
  build: (ioId: number) => SearchCoordinatorReply & { type: 'io' },
): Promise<T> {
  const ioId = nextIoId++;
  return new Promise<T>((resolve, reject) => {
    pendingIo.set(ioId, { resolve: resolve as (v: unknown) => void, reject });
    post(build(ioId));
  });
}

const io: SearchIo = {
  readScore: (runKey) =>
    ioCall<SearchScore | null>((ioId) => ({ type: 'io', ioId, op: 'readScore', runKey })),
  writeScore: (score) => ioCall<void>((ioId) => ({ type: 'io', ioId, op: 'writeScore', score })),
  readCachedResult: (runKey) =>
    ioCall<RunResult | null>((ioId) => ({ type: 'io', ioId, op: 'readCachedResult', runKey })),
};

// ---------------------------------------------------------------------------
// One search per worker
// ---------------------------------------------------------------------------

let cancelled = false;
let started = false;

async function start(msg: SearchCoordinatorRequest & { type: 'start' }): Promise<void> {
  try {
    const report = await runSearch(
      msg.searchId,
      msg.request,
      { profile: msg.profile, assumptions: msg.assumptions },
      {
        update: (patch) => post({ type: 'progress', patch }),
        cancelled: () => cancelled,
      },
      {
        defaultPoolSize: defaultBrowserPoolSize,
        createPool: (size, init) => createBrowserSimPool(size, init),
        createEvaluator: (pool, profile, assumptions) =>
          new CachedEvaluator(pool, profile, assumptions, io),
      },
    );
    post({ type: 'done', report });
  } catch (err) {
    post({
      type: 'error',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
}

workerScope.onmessage = (ev: MessageEvent<SearchCoordinatorRequest>) => {
  const msg = ev.data;
  if (msg.type === 'start') {
    // One worker, one search: the runner spawns a fresh coordinator per
    // startSearch and terminates it when the report settles.
    if (started) return;
    started = true;
    void start(msg);
    return;
  }
  if (msg.type === 'cancel') {
    // A cancel can even beat the start message (browsers queue messages until
    // the script is ready): the flag is simply already set when the executor
    // makes its first between-chunks check, which is the server's semantics
    // for a cancel that lands before the first chunk.
    cancelled = true;
    return;
  }
  const pending = pendingIo.get(msg.ioId);
  if (!pending) return;
  pendingIo.delete(msg.ioId);
  if (msg.ok) pending.resolve(msg.value);
  else pending.reject(new Error(msg.error ?? 'search io failed'));
};
