/**
 * The browser's RunExecutor: ONE reusable sim worker for the tab's lifetime.
 *
 * The Node executor spawns a worker per run because worker_threads deliver
 * the input as `workerData` at spawn; the browser worker was built for reuse
 * from day one — every posted message is one complete SimulationInput and
 * produces one run's replies (see src/ui/workers/simWorker.ts), so paying
 * Vite's worker-boot cost once per TAB instead of once per RUN is the whole
 * point of that design. The parity gate already proves a reused worker
 * computes byte-equal results after both a success and an error.
 *
 * RUNS ARE SERIALIZED, deliberately. The worker's execute() is synchronous,
 * so two posted inputs would run back-to-back inside it anyway — but their
 * progress frames would arrive on one channel with nothing saying whose they
 * are. Posting the next input only after the current run's done/error keeps
 * the attribution structural instead of inferred. Nothing above notices: the
 * run manager reports 'queued' until the first progress frame, exactly as a
 * node run queues behind a busy machine, and the UI's requestId guard already
 * drops superseded answers.
 *
 * A worker that DIES (an 'error' event — a crash, not an engine throw, which
 * the worker catches and reports as a message) fails the current run with the
 * event's message and is replaced with a fresh worker for the next one: the
 * executor must never turn one crash into a permanently wedged tab.
 */
import type { RunResult, SimulationInput } from '../../shared/types';
import type { SimWorkerMessage } from '../../shared/simWorkerProtocol';
import type { RunExecutor } from '../../store/runManager';

export function createBrowserRunExecutor(): RunExecutor {
  let worker: Worker | null = null;

  /** The tail of the run queue: each run awaits the previous one's settle. */
  let queue: Promise<unknown> = Promise.resolve();

  function ensureWorker(): Worker {
    worker ??= new Worker(new URL('../workers/simWorker.ts', import.meta.url), {
      type: 'module',
    });
    return worker;
  }

  function runOne(
    input: SimulationInput,
    onProgress: (frac: number, message?: string) => void,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const w = ensureWorker();
      const settle = (fn: () => void): void => {
        w.onmessage = null;
        w.onerror = null;
        fn();
      };
      w.onmessage = (ev: MessageEvent<SimWorkerMessage>) => {
        const msg = ev.data;
        if (msg.type === 'progress') onProgress(msg.frac, msg.message);
        else if (msg.type === 'done') settle(() => resolve(msg.result));
        else settle(() => reject(new Error(msg.error)));
      };
      w.onerror = (ev) => {
        // The worker itself is broken (not an engine error, which arrives as
        // a message): replace it so the NEXT run gets a healthy one.
        settle(() => {
          worker?.terminate();
          worker = null;
          reject(new Error(`Simulation worker crashed: ${ev.message || 'unknown error'}`));
        });
      };
      w.postMessage(input);
    });
  }

  return {
    run(input, onProgress) {
      const next = queue.then(
        () => runOne(input, onProgress),
        () => runOne(input, onProgress),
      );
      // A failed run must not break the chain: the next run executes either way.
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
