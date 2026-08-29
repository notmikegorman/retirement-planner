/**
 * THE NODE POOL — the one genuinely node-specific piece of the search, and
 * the node face of the pool contract (src/store/search/pool.ts, where the
 * CachedEvaluator and the SimPool interface moved in Phase 5 of the browser
 * port). The worker_threads pool below is behaviourally byte-for-byte what it
 * always was; the evaluator is re-exported here bound to the node folder so
 * every historical importer (tests above all) keeps one import path.
 *
 * WHY A POOL. runManager spawns `new Worker(...)` unconditionally on every
 * startRun — there is no queue and no limit. That is fine for the interactive
 * app, where runs arrive one at a time from a human, and catastrophic for a
 * search: firing hundreds of startRuns concurrently would spawn hundreds of
 * threads each booting a tsx runtime. (The comment in WidowCard.tsx claiming
 * "the server runs one simulation at a time anyway" is a UI convention, not a
 * server guarantee.)
 *
 * SIZE. Measured on this machine (10 cores, 4 performance + 6 efficiency), at
 * 4,000 paths: 1 worker 0.65 runs/s, 4 -> 1.66, 6 -> 2.06, 8 -> 2.18, 10 ->
 * 2.17. Saturation at eight, and ten is measurably WORSE than eight. The
 * default leaves two cores for the server and the machine's owner.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Assumptions, Profile } from '../../shared/types';
import { readCachedResult } from '../runManager';
import {
  CachedEvaluator as CoreCachedEvaluator,
  type SearchIo,
  type SimPool as SimPoolContract,
  type SimPoolJob,
} from '../../store/search/pool';
import { readScore, writeScore, type SearchScore } from './scoreStore';
import type { ScoreJob, ScoreWorkerMessage } from './scoreWorker';

export type { EvalOutcome, EvalRequest } from '../../store/search/pool';

export function defaultPoolSize(): number {
  return Math.min(8, Math.max(2, os.cpus().length - 2));
}

interface Pending {
  job: ScoreJob;
  resolve: (score: SearchScore) => void;
  reject: (err: Error) => void;
}

/** Round-robin-free pool: any idle worker takes the next job off the queue. */
export class SimPool implements SimPoolContract {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, Pending>();
  private readonly queue: Pending[] = [];
  private nextJobId = 1;
  private stopped = false;

  constructor(
    private readonly size: number,
    private readonly init: { profile: Profile; assumptions: Assumptions },
  ) {}

  private spawn(): Worker {
    // Same tsx-loader trick as runManager: the app runs its TypeScript directly.
    const worker = new Worker(new URL('./scoreWorker.ts', import.meta.url), {
      workerData: this.init,
      execArgv: ['--import', 'tsx'],
    });
    worker.on('message', (msg: ScoreWorkerMessage) => {
      if (msg.type === 'ready') return;
      const pending = this.busy.get(worker);
      if (!pending || pending.job.jobId !== msg.jobId) return;
      this.busy.delete(worker);
      if (msg.type === 'done') pending.resolve(msg.score);
      else pending.reject(new Error(msg.error));
      this.release(worker);
    });
    worker.on('error', (err) => {
      const pending = this.busy.get(worker);
      this.busy.delete(worker);
      pending?.reject(err);
      this.retire(worker);
      // A worker that died takes its thread with it; replace it so a single
      // bad job cannot shrink the pool for the rest of a 20-minute search.
      if (!this.stopped && this.workers.length < this.size) this.release(this.spawn());
    });
    worker.on('exit', () => {
      const pending = this.busy.get(worker);
      if (pending) {
        this.busy.delete(worker);
        pending.reject(new Error('Simulation worker exited before finishing its job'));
      }
      this.retire(worker);
    });
    // NOT unref'd. An unref'd worker does not hold the event loop open, so a
    // process whose only pending work is a queued simulation would exit
    // silently mid-search — invisible under the HTTP server (its listening
    // socket keeps the loop alive) and fatal anywhere else. destroy() in the
    // executor's `finally` is what guarantees these threads go away.
    this.workers.push(worker);
    return worker;
  }

  private retire(worker: Worker): void {
    const wi = this.workers.indexOf(worker);
    if (wi >= 0) this.workers.splice(wi, 1);
    const ii = this.idle.indexOf(worker);
    if (ii >= 0) this.idle.splice(ii, 1);
  }

  private release(worker: Worker): void {
    if (this.stopped) return;
    const next = this.queue.shift();
    if (next) {
      this.busy.set(worker, next);
      worker.postMessage(next.job);
      return;
    }
    this.idle.push(worker);
  }

  /** Queue one simulation. Resolves with the slim score. */
  run(input: SimPoolJob): Promise<SearchScore> {
    if (this.stopped) return Promise.reject(new Error('Search worker pool has been shut down'));
    return new Promise<SearchScore>((resolve, reject) => {
      const job: ScoreJob = { jobId: this.nextJobId++, ...input };
      const pending: Pending = { job, resolve, reject };
      const worker = this.idle.pop();
      if (worker) {
        this.busy.set(worker, pending);
        worker.postMessage(job);
        return;
      }
      if (this.workers.length < this.size) {
        const fresh = this.spawn();
        this.busy.set(fresh, pending);
        fresh.postMessage(job);
        return;
      }
      this.queue.push(pending);
    });
  }

  async destroy(): Promise<void> {
    this.stopped = true;
    for (const pending of this.queue.splice(0)) {
      pending.reject(new Error('Search cancelled'));
    }
    await Promise.all(this.workers.slice().map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
    this.busy.clear();
  }
}

// ---------------------------------------------------------------------------
// The cached evaluator, bound to the node folder
// ---------------------------------------------------------------------------

/** The node folder's persistence: direct file IO, no proxying to cross. */
const nodeSearchIo: SearchIo = { readScore, writeScore, readCachedResult };

/**
 * The four-layer evaluator (src/store/search/pool.ts — moved, not rewritten;
 * every WHY lives on it there), wearing its historical three-argument
 * constructor so the search tests and the executor face need no new wiring.
 */
export class CachedEvaluator extends CoreCachedEvaluator {
  constructor(pool: SimPoolContract, profile: Profile, assumptions: Assumptions) {
    super(pool, profile, assumptions, nodeSearchIo);
  }
}
