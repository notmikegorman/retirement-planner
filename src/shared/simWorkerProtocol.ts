/**
 * The message protocol both simulation workers speak — the Node worker
 * (src/server/simWorker.ts, worker_threads) and the browser worker
 * (src/ui/workers/simWorker.ts, Web Worker).
 *
 * ONE definition, imported by both, so the run manager that will eventually
 * drive either kind interchangeably (browser-port Phase 4) can never find the
 * two workers disagreeing on shape. Before this module existed the type lived
 * in the Node worker file; the browser worker could not import it from there
 * without dragging `node:worker_threads` into the browser bundle, and a copied
 * type is exactly the kind of duplicate that drifts one optional field at a
 * time until "same protocol" is a comment rather than a fact.
 *
 * The protocol, per run:
 *   { type: 'progress', frac, message? }  — throttled by the SENDER to posts
 *     that advance frac by >= 0.02 (or reach 1), so a 10,000-path run streams
 *     ~50 frames, not 10,000. The throttle lives worker-side on purpose:
 *     progress crosses a serialization boundary in both environments, and the
 *     consumer should never need to defend against a firehose.
 *   { type: 'done', result }              — the engine's RunResult, exactly
 *     as execute() returned it. The worker adds nothing (no timestamps, no
 *     env fingerprints): the browser-parity gate byte-compares this object
 *     across environments, and any worker-added field would fork it.
 *   { type: 'error', error }              — message + stack as one string.
 *     A string, not an Error: structured clone of Error objects differs
 *     between worker_threads and Web Workers, and the consumers only ever
 *     display it.
 *
 * How the input ARRIVES differs by environment and is deliberately outside
 * this type: worker_threads delivers it as `workerData` at spawn; Web Workers
 * have no workerData, so it arrives as a posted message (see each worker's
 * header). Everything the parent RECEIVES is this union in both worlds.
 */
import type { RunResult } from './types';

export type SimWorkerMessage =
  | { type: 'progress'; frac: number; message?: string }
  | { type: 'done'; result: RunResult }
  | { type: 'error'; error: string };
