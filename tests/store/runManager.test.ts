/**
 * The environment-neutral run manager (src/store/runManager.ts) against a
 * FAKE executor — the seam Phase 4 cut so one manager can drive both a
 * worker_threads spawn and the browser's reusable Web Worker.
 *
 * What is tested HERE is exactly the part the node-face suites
 * (cachedFinalRun, missingQuoteGate) cannot see, because they run the real
 * worker: the manager's half of the executor contract. Progress frames map to
 * the registry, an executor rejection becomes the run's error string, an
 * in-flight key is joined rather than re-executed, `fresh` bypasses the disk
 * cache but still lands in it, and the cache write happens BEFORE the
 * in-memory map flips to done — the ordering lookupCachedRun's "the file is
 * the whole truth" comment leans on.
 *
 * Everything runs on memory FileStores (the real defaults read once from
 * data-defaults/), so the suite is milliseconds and touches no temp dirs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRequest, RunResult, SimulationInput } from '../../src/shared/types';
import {
  createMemoryFileStore,
  seedMemoryFileStore,
  type MemoryFileStore,
} from '../../src/shared/memoryFileStore';
import { createStores, type Stores } from '../../src/store';
import {
  createRunManager,
  runKeyFor,
  type RunExecutor,
  type RunManager,
} from '../../src/store/runManager';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

/** data-defaults/ as a manifest, read once — the browser's bundled shape. */
function defaultsManifest(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out[rel] = new Uint8Array(readFileSync(full));
    }
  };
  walk(defaultsDir, '');
  return out;
}

const manifest = defaultsManifest();

async function memoryDefaults(): Promise<MemoryFileStore> {
  const store = createMemoryFileStore('(defaults)');
  await seedMemoryFileStore(store, manifest);
  return store;
}

/** One resolved fake result; the manager treats RunResult as opaque + meta. */
function fakeResult(success: number): RunResult {
  return {
    success,
    meta: {
      engineVersion: 'test',
      mode: 'montecarlo',
      paths: 40,
      seed: 1,
      createdAt: '',
      runKey: '',
      hashes: {},
    },
  } as unknown as RunResult;
}

interface Deferred {
  input: SimulationInput;
  onProgress: (frac: number, message?: string) => void;
  resolve: (r: RunResult) => void;
  reject: (err: unknown) => void;
}

/** An executor whose every run the test settles by hand. */
function manualExecutor(): { executor: RunExecutor; calls: Deferred[] } {
  const calls: Deferred[] = [];
  return {
    calls,
    executor: {
      run(input, onProgress) {
        return new Promise<RunResult>((resolve, reject) => {
          calls.push({ input, onProgress, resolve, reject });
        });
      },
    },
  };
}

const req = (name: string, extra?: Partial<RunRequest>): RunRequest =>
  ({
    scenario: { name, events: [] },
    mode: 'montecarlo',
    paths: 40,
    seed: 7,
    ...extra,
  }) as RunRequest;

let stores: Stores;
let files: MemoryFileStore;
let manager: RunManager;
let calls: Deferred[];

beforeEach(async () => {
  files = createMemoryFileStore('(data)');
  stores = createStores({ files, defaults: await memoryDefaults() });
  await stores.data.initDataDir();
  const manual = manualExecutor();
  calls = manual.calls;
  manager = createRunManager({ data: stores.data, executor: manual.executor, onLog: () => {} });
});

/** Let the microtask queue drain so .then chains after a settle have run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the neutral run manager over a fake executor', () => {
  it('walks a run through queued → running → done, cache file written first', async () => {
    const { runId } = await manager.startRun(req('walkthrough'));
    expect(calls).toHaveLength(1);
    expect((await manager.getRun(runId))?.status).toBe('queued');

    calls[0].onProgress(0.5, 'halfway');
    const running = await manager.getRun(runId);
    expect(running).toMatchObject({ status: 'running', progress: 0.5, message: 'halfway' });

    calls[0].resolve(fakeResult(0.9));
    await settle();
    const done = await manager.getRun(runId);
    expect(done?.status).toBe('done');
    // meta normalized to the cache key and stamped with a real clock.
    expect(done?.result?.meta.runKey).toBe(runId);
    expect(done?.result?.meta.createdAt).not.toBe('');
    // The file IS on disk — and holds the same runKey-normalized result.
    const cached = JSON.parse(await files.readText(`runs/${runId}.json`)) as RunResult;
    expect(cached.meta.runKey).toBe(runId);
  });

  it('keys the run by content: runId equals runKeyFor of the resolved input', async () => {
    const { runId } = await manager.startRun(req('keyed'));
    expect(runId).toBe(runKeyFor(calls[0].input));
  });

  it('joins an in-flight run instead of executing the same key twice', async () => {
    const first = await manager.startRun(req('joined'));
    const second = await manager.startRun(req('joined'));
    expect(second.runId).toBe(first.runId);
    expect(calls).toHaveLength(1);
  });

  it('answers from the disk cache without calling the executor', async () => {
    const { runId } = await manager.startRun(req('cached'));
    calls[0].resolve(fakeResult(0.8));
    await settle();

    // A second manager instance (fresh registry, same folder) — the browser
    // reload shape. The cache answers; the executor is never consulted.
    const manual2 = manualExecutor();
    const manager2 = createRunManager({
      data: stores.data,
      executor: manual2.executor,
      onLog: () => {},
    });
    const again = await manager2.startRun(req('cached'));
    expect(again.runId).toBe(runId);
    expect(manual2.calls).toHaveLength(0);
    expect((await manager2.getRun(runId))?.status).toBe('done');

    // lookupCachedRun sees it too — and starts nothing.
    const looked = await manager2.lookupCachedRun(req('cached'));
    expect(looked?.meta.runKey).toBe(runId);
    expect(manual2.calls).toHaveLength(0);
  });

  it('fresh: true re-executes over a disk hit, and the rerun lands in the cache', async () => {
    const { runId } = await manager.startRun(req('fresh'));
    calls[0].resolve(fakeResult(0.5));
    await settle();

    const manual2 = manualExecutor();
    const manager2 = createRunManager({
      data: stores.data,
      executor: manual2.executor,
      onLog: () => {},
    });
    await manager2.startRun(req('fresh', { fresh: true }));
    expect(manual2.calls).toHaveLength(1);
    manual2.calls[0].resolve(fakeResult(0.6));
    await settle();
    const cached = JSON.parse(await files.readText(`runs/${runId}.json`)) as RunResult;
    expect(cached.success).toBe(0.6);
  });

  it("an executor rejection becomes the run's error, message preserved", async () => {
    const { runId } = await manager.startRun(req('failing'));
    calls[0].reject(new Error('Simulation worker exited unexpectedly with code 1'));
    await settle();
    const progress = await manager.getRun(runId);
    expect(progress?.status).toBe('error');
    expect(progress?.error).toBe('Simulation worker exited unexpectedly with code 1');
    // Nothing was cached: a failed run must not poison the content key.
    expect(await files.exists(`runs/${runId}.json`)).toBe(false);
  });

  it('getRun refuses to touch storage for a malformed id', async () => {
    expect(await manager.getRun('../plan.json')).toBeNull();
  });
});
