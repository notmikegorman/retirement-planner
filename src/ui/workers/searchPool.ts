/**
 * The BROWSER pool: persistent Web Workers behind the same SimPool contract
 * as the node worker_threads pool (src/server/search/pool.ts) — lazy spawn up
 * to size, idle-takes-next scheduling, dead-worker replacement mid-search,
 * hard terminate on destroy, and the same rejection strings, so the shared
 * executor cannot tell which world it is running in.
 *
 * It runs INSIDE the search coordinator worker (searchWorker.ts): browsers
 * allow workers to spawn workers, and the coordinator owning its own pool is
 * what keeps every part of a 20-minute search off the throttled main thread.
 *
 * SIZE. min(8, max(2, navigator.hardwareConcurrency - 2)) — the same shape as
 * the node default, for the same measured reasons: throughput saturated at
 * eight workers on the 10-core dev machine (0.65 runs/s at 1 → 2.18 at 8, and
 * ten was measurably WORSE than eight), and the minus-two leaves room for the
 * main thread and the machine's owner. hardwareConcurrency is the browser's
 * honest count of what os.cpus().length measured under node; where a browser
 * withholds it, 4 is assumed (→ a pool of 2, the floor).
 *
 * DIFFERENCES FROM THE NODE POOL, stated rather than papered over:
 *   - init travels as the worker's first MESSAGE (Web Workers have no
 *     workerData) — see store/search/workerProtocol.ts;
 *   - there is no 'exit' event: a Web Worker cannot die silently the way a
 *     thread can (an uncaught failure surfaces as the 'error' event, handled
 *     below; only terminate() ends one otherwise), so the node pool's
 *     exited-before-finishing rejection has no browser counterpart;
 *   - `spawnWorker` is injectable so the scheduling/replacement/shutdown
 *     contract is testable in the node lane without a browser. The default
 *     spawns the real module worker and is what production uses.
 */
import type { Assumptions, Profile } from '../../shared/types';
import type { SimPool, SimPoolJob } from '../../store/search/pool';
import type { SearchScore } from '../../store/search/scoreStore';
import type {
  ScoreJob,
  ScoreWorkerInit,
  ScoreWorkerMessage,
} from '../../store/search/workerProtocol';

/** The slice of the Worker surface the pool drives (and tests fake). */
export interface ScoreWorkerLike {
  postMessage(msg: ScoreJob | ScoreWorkerInit): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<ScoreWorkerMessage>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

/** The node default's shape, on the browser's honest core count. */
export function browserPoolSize(hardwareConcurrency: number | undefined): number {
  return Math.min(8, Math.max(2, (hardwareConcurrency ?? 4) - 2));
}

export function defaultBrowserPoolSize(): number {
  return browserPoolSize(navigator.hardwareConcurrency);
}

function spawnScoreWorker(): ScoreWorkerLike {
  return new Worker(new URL('./searchScoreWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as ScoreWorkerLike;
}

interface Pending {
  job: ScoreJob;
  resolve: (score: SearchScore) => void;
  reject: (err: Error) => void;
}

/** Round-robin-free pool: any idle worker takes the next job off the queue. */
export function createBrowserSimPool(
  size: number,
  init: { profile: Profile; assumptions: Assumptions },
  spawnWorker: () => ScoreWorkerLike = spawnScoreWorker,
): SimPool {
  const workers: ScoreWorkerLike[] = [];
  const idle: ScoreWorkerLike[] = [];
  const busy = new Map<ScoreWorkerLike, Pending>();
  const queue: Pending[] = [];
  let nextJobId = 1;
  let stopped = false;

  function spawn(): ScoreWorkerLike {
    const worker = spawnWorker();
    worker.postMessage({ type: 'init', profile: init.profile, assumptions: init.assumptions });
    worker.onmessage = (ev: MessageEvent<ScoreWorkerMessage>) => {
      const msg = ev.data;
      if (msg.type === 'ready') return;
      const pending = busy.get(worker);
      if (!pending || pending.job.jobId !== msg.jobId) return;
      busy.delete(worker);
      if (msg.type === 'done') pending.resolve(msg.score);
      else pending.reject(new Error(msg.error));
      release(worker);
    };
    worker.onerror = (ev: ErrorEvent) => {
      // The worker itself is broken (an engine throw arrives as an 'error'
      // MESSAGE and is handled above). Terminate and replace it so a single
      // bad worker cannot shrink the pool for the rest of a 20-minute search
      // — the browser twin of the node pool's dead-thread replacement.
      const pending = busy.get(worker);
      busy.delete(worker);
      pending?.reject(new Error(`Score worker crashed: ${ev.message || 'unknown error'}`));
      retire(worker);
      worker.terminate();
      if (!stopped && workers.length < size) release(spawn());
    };
    workers.push(worker);
    return worker;
  }

  function retire(worker: ScoreWorkerLike): void {
    const wi = workers.indexOf(worker);
    if (wi >= 0) workers.splice(wi, 1);
    const ii = idle.indexOf(worker);
    if (ii >= 0) idle.splice(ii, 1);
  }

  function release(worker: ScoreWorkerLike): void {
    if (stopped) return;
    const next = queue.shift();
    if (next) {
      busy.set(worker, next);
      worker.postMessage(next.job);
      return;
    }
    idle.push(worker);
  }

  return {
    /** Queue one simulation. Resolves with the slim score. */
    run(input: SimPoolJob): Promise<SearchScore> {
      if (stopped) return Promise.reject(new Error('Search worker pool has been shut down'));
      return new Promise<SearchScore>((resolve, reject) => {
        const job: ScoreJob = { jobId: nextJobId++, ...input };
        const pending: Pending = { job, resolve, reject };
        const worker = idle.pop();
        if (worker) {
          busy.set(worker, pending);
          worker.postMessage(job);
          return;
        }
        if (workers.length < size) {
          const fresh = spawn();
          busy.set(fresh, pending);
          fresh.postMessage(job);
          return;
        }
        queue.push(pending);
      });
    },

    async destroy(): Promise<void> {
      stopped = true;
      for (const pending of queue.splice(0)) {
        pending.reject(new Error('Search cancelled'));
      }
      // Hard terminate, in-flight jobs discarded — the executor's `finally`
      // calls this, and a cancelled search must not wait out a slow eval.
      for (const worker of workers.splice(0)) worker.terminate();
      idle.length = 0;
      busy.clear();
    },
  };
}
