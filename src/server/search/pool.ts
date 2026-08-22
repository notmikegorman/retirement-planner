/**
 * A persistent worker pool, and the cached evaluator built on top of it.
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
import type { Assumptions, Profile, RunMode, Scenario, SimulationInput } from '../../shared/types';
import { readCachedResult, runKeyFor } from '../runManager';
import { readScore, scoreFromResult, writeScore, type SearchScore } from './scoreStore';
import type { ScoreJob, ScoreWorkerMessage } from './scoreWorker';

export function defaultPoolSize(): number {
  return Math.min(8, Math.max(2, os.cpus().length - 2));
}

interface Pending {
  job: ScoreJob;
  resolve: (score: SearchScore) => void;
  reject: (err: Error) => void;
}

/** Round-robin-free pool: any idle worker takes the next job off the queue. */
export class SimPool {
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
  run(input: { runKey: string; scenario: Scenario; mode: RunMode; paths: number; seed: number }) {
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
// The cached evaluator
// ---------------------------------------------------------------------------

export interface EvalRequest {
  scenario: Scenario;
  mode: RunMode;
  paths: number;
  seed: number;
}

export interface EvalOutcome {
  score: SearchScore;
  /** True when nothing was simulated: memory, slim cache, or the run cache. */
  cached: boolean;
}

/**
 * Evaluate a plan, hitting every cache on the way down.
 *
 * FOUR LAYERS, cheapest first:
 *   1. this search's in-memory map (the same plan appears in many candidates);
 *   2. in-flight promises (two rounds asking for the same thing concurrently
 *      must not both compute it);
 *   3. searches/scores/<runKey>.json, the slim store;
 *   4. runs/<runKey>.json, the app's OWN full run cache — so anything the user
 *      has already looked at in the workbench, and anything a previous search
 *      computed at the same paths and seed, costs nothing.
 * Only then does it simulate, and it writes the slim record afterwards.
 *
 * `fresh` is never set anywhere in the search. The entire economy of re-running
 * a search over an overlapping space depends on a re-tested configuration being
 * free.
 */
export class CachedEvaluator {
  private readonly memo = new Map<string, SearchScore>();
  private readonly inFlight = new Map<string, Promise<SearchScore>>();
  evaluations = 0;
  cacheHits = 0;

  constructor(
    private readonly pool: SimPool,
    private readonly profile: Profile,
    private readonly assumptions: Assumptions,
  ) {}

  runKeyFor(req: EvalRequest): string {
    const input: SimulationInput = {
      profile: this.profile,
      assumptions: this.assumptions,
      scenario: req.scenario,
      mode: req.mode,
      paths: req.paths,
      seed: req.seed,
    };
    return runKeyFor(input);
  }

  async evaluate(req: EvalRequest): Promise<EvalOutcome> {
    const runKey = this.runKeyFor(req);

    const memo = this.memo.get(runKey);
    if (memo) {
      this.cacheHits++;
      return { score: memo, cached: true };
    }

    const flight = this.inFlight.get(runKey);
    if (flight) {
      const score = await flight;
      this.cacheHits++;
      return { score, cached: true };
    }

    const promise = this.load(runKey, req);
    /*
     * The DERIVED promise needs its own rejection handler, or a failed
     * evaluation takes the whole process with it.
     *
     * `await promise` below handles the original. `promise.then(...)` creates a
     * SECOND promise, and unless some concurrent caller happens to await it via
     * the inFlight branch above, nothing ever does — Node 24 defaults to
     * --unhandled-rejections=throw, so one worker failure exited the Fastify
     * server with code 1 and took the partial-report path down with it. The
     * catch is a no-op precisely because the real handling belongs to the
     * awaiting caller; this only stops an unobserved copy killing the process.
     */
    const shared = promise.then((r) => r.score);
    shared.catch(() => {});
    this.inFlight.set(runKey, shared);
    try {
      const outcome = await promise;
      this.memo.set(runKey, outcome.score);
      if (outcome.cached) this.cacheHits++;
      else this.evaluations++;
      return outcome;
    } finally {
      this.inFlight.delete(runKey);
    }
  }

  private async load(runKey: string, req: EvalRequest): Promise<EvalOutcome> {
    const slim = await readScore(runKey);
    if (slim) return { score: slim, cached: true };

    const full = await readCachedResult(runKey);
    if (full) {
      const score = scoreFromResult(runKey, full);
      await writeScore(score);
      return { score, cached: true };
    }

    const score = await this.pool.run({ runKey, ...req });
    await writeScore(score);
    return { score, cached: false };
  }
}
