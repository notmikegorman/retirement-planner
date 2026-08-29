/**
 * Browser entry of the parity gate: everything that must run IN Chromium.
 *
 * What runs here, deliberately: fixture construction (buildParityCases, so
 * the input-building code — CSV parse included — executes in the browser),
 * the sim worker round-trip, and the scrub+stableStringify serialization of
 * the result. The page returns Playwright a STRING: serializing browser-side
 * with the same shared code the Node side uses means the byte comparison
 * compares two environments' serializations of their own results, with no
 * lossy protocol hop (NaN, -0, key order) in between able to mask or
 * fabricate a difference.
 *
 * What must NOT run here: fetch. The raw defaults are bundled INTO this file
 * by Vite (`?raw` for the CSV, JSON imports for the rest), so the page makes
 * no request beyond loading its own bundle — the lane's static server can
 * serve nothing else, and the gate stays meaningful offline.
 */
/// <reference types="vite/client" />
import { buildParityCases, type ParityCase } from '../parityCases';
import { parityText } from '../parityScrub';
import { ENGINE_VERSION } from '../../../src/shared/types';
import type { RunMeta } from '../../../src/shared/types';
import type { SimWorkerMessage } from '../../../src/shared/simWorkerProtocol';

import historicalCsv from '../../../data-defaults/assumptions/historical-returns.csv?raw';
import marketJson from '../../../data-defaults/assumptions/market.json';
import federalJson from '../../../data-defaults/assumptions/tax/federal-2026.json';
import vaJson from '../../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../../data-defaults/assumptions/tax/nc-2026.json';
import ssJson from '../../../data-defaults/assumptions/social-security.json';
import medicareJson from '../../../data-defaults/assumptions/medicare-2026.json';
import acaJson from '../../../data-defaults/assumptions/aca-2026.json';
import rmdJson from '../../../data-defaults/assumptions/rmd-table.json';
import profileJson from '../../../data-defaults/profile.starter.json';
import baseCaseJson from '../../../data-defaults/scenarios/base-case.json';
import downsizeCashJson from '../../../data-defaults/scenarios/downsize-cash.json';
import retireSeppJson from '../../../data-defaults/scenarios/retire-2030-sepp.json';

/** What run() hands back to the Playwright side, per case. */
export interface ParityRunReply {
  /** parityText(result): the string the gate byte-compares. */
  text: string;
  /** The result's meta, alone, for pointed assertions and failure messages. */
  meta: RunMeta;
  /** Every progress frac the worker posted, in arrival order. */
  progressFracs: number[];
}

export interface ParityWindow {
  __parity: {
    ready: true;
    engineVersion: string;
    caseIds: string[];
    run(id: string): Promise<ParityRunReply>;
    /** Post an arbitrary (broken) input and report the terminal message type. */
    runRaw(input: unknown): Promise<{ type: 'done' | 'error'; error?: string }>;
  };
}

const cases: ParityCase[] = buildParityCases({
  historicalCsv,
  market: marketJson,
  federal: federalJson,
  va: vaJson,
  sc: scJson,
  nc: ncJson,
  socialSecurity: ssJson,
  medicare: medicareJson,
  aca: acaJson,
  rmd: rmdJson,
  starterProfile: profileJson,
  scenarios: {
    baseCase: baseCaseJson,
    downsizeCash: downsizeCashJson,
    retireSepp: retireSeppJson,
  },
});

// ONE worker for every case, on purpose: the reuse contract (each message is a
// complete run; throttle state resets per run) is part of what the gate
// proves, because Phase 4's run manager will hold one worker for the life of
// the tab. Vite's native worker syntax — bundled ahead of time, module type.
const worker = new Worker(new URL('../../../src/ui/workers/simWorker.ts', import.meta.url), {
  type: 'module',
});

interface WorkerReply {
  terminal: SimWorkerMessage;
  progressFracs: number[];
}

// Runs are serialized through this chain so two overlapping run() calls from
// the driver cannot interleave their message listeners and steal each other's
// progress frames. (The worker itself would already queue the inputs.)
let previous: Promise<unknown> = Promise.resolve();

function postRun(input: unknown): Promise<WorkerReply> {
  const reply = previous.then(
    () =>
      new Promise<WorkerReply>((resolve) => {
        const progressFracs: number[] = [];
        const onMessage = (ev: MessageEvent<SimWorkerMessage>) => {
          const msg = ev.data;
          if (msg.type === 'progress') {
            progressFracs.push(msg.frac);
            return;
          }
          worker.removeEventListener('message', onMessage);
          resolve({ terminal: msg, progressFracs });
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage(input);
      }),
  );
  previous = reply.catch(() => undefined);
  return reply;
}

(window as unknown as ParityWindow).__parity = {
  ready: true,
  engineVersion: ENGINE_VERSION,
  caseIds: cases.map((c) => c.id),

  async run(id: string): Promise<ParityRunReply> {
    const found = cases.find((c) => c.id === id);
    if (!found) throw new Error(`unknown parity case: ${id}`);
    const { terminal, progressFracs } = await postRun(found.input);
    if (terminal.type !== 'done') {
      throw new Error(
        `worker did not complete case ${id}: ` +
          (terminal.type === 'error' ? terminal.error : `unexpected message ${terminal.type}`),
      );
    }
    return {
      text: parityText(terminal.result),
      meta: terminal.result.meta,
      progressFracs,
    };
  },

  async runRaw(input: unknown): Promise<{ type: 'done' | 'error'; error?: string }> {
    const { terminal } = await postRun(input);
    if (terminal.type === 'error') return { type: 'error', error: terminal.error };
    return { type: 'done' };
  },
};
