/**
 * The pool CONTRACT and the cached evaluator built on top of it —
 * ENVIRONMENT-NEUTRAL since Phase 5 of the browser port.
 *
 * The evaluator is the same code that lived at src/server/search/pool.ts; the
 * pool itself became an interface, because the two environments genuinely
 * differ in how a simulation thread is made:
 *
 *   - node: the worker_threads pool (src/server/search/pool.ts), byte-for-byte
 *     the behaviour it always had — lazy spawn to min(8, max(2, cpus - 2)),
 *     idle-takes-next scheduling, dead-worker replacement mid-search, hard
 *     terminate on destroy;
 *   - browser: a persistent Web Worker pool (src/ui/workers/searchPool.ts)
 *     with the SAME contract, sized from navigator.hardwareConcurrency.
 *
 * Everything the executor observes — the job shape, the slim score reply, the
 * rejection strings, destroy() draining the queue — is this contract, so the
 * successive-halving orchestration cannot tell which world it is running in.
 *
 * The evaluator's four cache layers are the search's whole economy, and a fork
 * here would silently diverge it between environments: the runKey/score-cache
 * agreement (the same sha256(engineVersion + input) runManager uses) is what
 * the dual-stack gate pins byte-for-byte. So the logic lives HERE, once, and
 * both backends compose it over their own pool and folder.
 */
import type { Assumptions, Profile, RunMode, RunResult, Scenario, SimulationInput } from '../../shared/types';
import { runKeyFor } from '../runManager';
import { scoreFromResult, type SearchScore } from './scoreStore';

/** One simulation ask, content-keyed: the pool computes, it never caches. */
export interface SimPoolJob {
  runKey: string;
  scenario: Scenario;
  mode: RunMode;
  paths: number;
  seed: number;
}

/**
 * A persistent worker pool: boots workers holding {profile, assumptions} in
 * memory and answers jobs with slim scores until destroyed.
 *
 * Contract, shared by both implementations:
 *   - run() queues one simulation and resolves with the slim score; after
 *     destroy() it REJECTS ("shut down") rather than quietly spawning;
 *   - a worker that dies mid-search is replaced, so one bad job cannot shrink
 *     the pool for the rest of a 20-minute search;
 *   - destroy() rejects everything still queued ("Search cancelled") and hard
 *     terminates every worker — in-flight jobs are discarded, not awaited.
 */
export interface SimPool {
  run(input: SimPoolJob): Promise<SearchScore>;
  destroy(): Promise<void>;
}

/**
 * Where the evaluator's persistence lives — the one seam between the search's
 * cache economy and the folder. Under node these are direct file calls; in the
 * browser the coordinator worker proxies them to the guarded main context, so
 * every folder WRITE stays behind the single-writer discipline (see
 * src/ui/workers/searchWorker.ts for that boundary).
 */
export interface SearchIo {
  readScore(runKey: string): Promise<SearchScore | null>;
  writeScore(score: SearchScore): Promise<void>;
  readCachedResult(runKey: string): Promise<RunResult | null>;
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
    private readonly io: SearchIo,
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
    const slim = await this.io.readScore(runKey);
    if (slim) return { score: slim, cached: true };

    const full = await this.io.readCachedResult(runKey);
    if (full) {
      const score = scoreFromResult(runKey, full);
      await this.io.writeScore(score);
      return { score, cached: true };
    }

    const score = await this.pool.run({ runKey, ...req });
    await this.io.writeScore(score);
    return { score, cached: false };
  }
}
