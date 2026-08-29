/**
 * The BROWSER pool's contract, proven without a browser: the pool's
 * scheduling, replacement and shutdown behaviour is pure logic over the
 * ScoreWorkerLike surface, so the node lane drives it with scripted fake
 * workers — the same reasoning as the node pool's own no-threads tests
 * (searchCache.test.ts: "booting a worker costs ~99ms and tells us nothing
 * about the logic under test").
 *
 * The contract under test is the SHARED one (src/store/search/pool.ts): the
 * node worker_threads pool already honours it byte-for-byte; these tests pin
 * the browser implementation to the same behaviour — lazy spawn to size,
 * init-as-first-message, idle-takes-next scheduling, results routed by jobId,
 * dead-worker replacement mid-search, and destroy() rejecting the queue with
 * the identical strings. The real spawn (a module Web Worker) is exercised
 * end-to-end by the dual-stack search gate in the browser lane.
 */
import { describe, expect, it } from 'vitest';
import type { Assumptions, Profile, Scenario } from '../../src/shared/types';
import type { SearchScore } from '../../src/store/search/scoreStore';
import type {
  ScoreJob,
  ScoreWorkerInit,
  ScoreWorkerMessage,
} from '../../src/store/search/workerProtocol';
import {
  browserPoolSize,
  createBrowserSimPool,
  type ScoreWorkerLike,
} from '../../src/ui/workers/searchPool';

class FakeScoreWorker implements ScoreWorkerLike {
  onmessage: ((ev: MessageEvent<ScoreWorkerMessage>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  sent: Array<ScoreJob | ScoreWorkerInit> = [];
  terminated = false;

  postMessage(msg: ScoreJob | ScoreWorkerInit): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }

  /** Jobs only (the init message filtered out). */
  jobs(): ScoreJob[] {
    return this.sent.filter((m): m is ScoreJob => !('type' in m));
  }
  reply(msg: ScoreWorkerMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<ScoreWorkerMessage>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function harness(size: number) {
  const spawned: FakeScoreWorker[] = [];
  const init = {
    profile: { name: 'p' } as unknown as Profile,
    assumptions: { name: 'a' } as unknown as Assumptions,
  };
  const pool = createBrowserSimPool(size, init, () => {
    const w = new FakeScoreWorker();
    spawned.push(w);
    return w;
  });
  return { pool, spawned, init };
}

function job(seed: number) {
  return {
    runKey: 'a'.repeat(64),
    scenario: { name: 'plan', events: [] } as unknown as Scenario,
    mode: 'montecarlo' as const,
    paths: 100,
    seed,
  };
}

function score(runKey: string): SearchScore {
  return {
    runKey,
    success: 0.9,
    medianTerminalReal: 1_000_000,
    breakGlassReal: null,
    charitableTotalReal: 0,
    horizonYears: 36,
    worstDecileFirstShortfallYear: null,
    elapsedMs: 1,
  };
}

/** Settle microtasks so promise handlers run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('sizing', () => {
  it('mirrors the node default: min(8, max(2, cores - 2))', () => {
    expect(browserPoolSize(10)).toBe(8);
    expect(browserPoolSize(16)).toBe(8);
    expect(browserPoolSize(8)).toBe(6);
    expect(browserPoolSize(6)).toBe(4);
    expect(browserPoolSize(4)).toBe(2);
    expect(browserPoolSize(2)).toBe(2);
    expect(browserPoolSize(1)).toBe(2);
  });

  it('assumes a small machine when the browser withholds the count', () => {
    expect(browserPoolSize(undefined)).toBe(2);
  });
});

describe('spawn and scheduling', () => {
  it('spawns lazily, sends init as the FIRST message, then the job', async () => {
    const { pool, spawned, init } = harness(4);
    expect(spawned).toHaveLength(0);

    const p = pool.run(job(1));
    expect(spawned).toHaveLength(1);
    const w = spawned[0];
    expect(w.sent[0]).toEqual({ type: 'init', ...init });
    expect(w.jobs()).toHaveLength(1);
    expect(w.jobs()[0]).toMatchObject({ jobId: 1, seed: 1 });

    w.reply({ type: 'done', jobId: 1, score: score('a'.repeat(64)) });
    await expect(p).resolves.toMatchObject({ success: 0.9 });
  });

  it('queues beyond size, and a freed worker takes the next job — no third spawn', async () => {
    const { pool, spawned } = harness(2);
    const p1 = pool.run(job(1));
    const p2 = pool.run(job(2));
    const p3 = pool.run(job(3));
    expect(spawned).toHaveLength(2);
    expect(spawned[0].jobs()).toHaveLength(1);
    expect(spawned[1].jobs()).toHaveLength(1);

    spawned[0].reply({ type: 'done', jobId: 1, score: score('a'.repeat(64)) });
    await expect(p1).resolves.toBeDefined();
    // The idle worker took the queued job; the pool did not grow.
    expect(spawned).toHaveLength(2);
    expect(spawned[0].jobs()).toHaveLength(2);
    expect(spawned[0].jobs()[1]).toMatchObject({ jobId: 3, seed: 3 });

    spawned[1].reply({ type: 'done', jobId: 2, score: score('a'.repeat(64)) });
    spawned[0].reply({ type: 'done', jobId: 3, score: score('a'.repeat(64)) });
    await expect(p2).resolves.toBeDefined();
    await expect(p3).resolves.toBeDefined();
  });

  it('an idle worker is reused before any new spawn', async () => {
    const { pool, spawned } = harness(4);
    const p1 = pool.run(job(1));
    spawned[0].reply({ type: 'done', jobId: 1, score: score('a'.repeat(64)) });
    await p1;

    void pool.run(job(2));
    expect(spawned).toHaveLength(1);
    expect(spawned[0].jobs()).toHaveLength(2);
  });

  it('routes replies by jobId and ignores a stale one', async () => {
    const { pool, spawned } = harness(1);
    const p1 = pool.run(job(1));
    // A reply for a job this worker does not hold: dropped, nothing settles.
    spawned[0].reply({ type: 'done', jobId: 99, score: score('b'.repeat(64)) });
    let settled = false;
    void p1.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);

    spawned[0].reply({ type: 'done', jobId: 1, score: score('a'.repeat(64)) });
    await expect(p1).resolves.toBeDefined();
  });

  it("an 'error' MESSAGE rejects that job and frees the worker (no replacement)", async () => {
    const { pool, spawned } = harness(2);
    const p1 = pool.run(job(1));
    spawned[0].reply({ type: 'error', jobId: 1, error: 'engine said no' });
    await expect(p1).rejects.toThrow('engine said no');

    // The worker survives an engine error and takes the next job.
    void pool.run(job(2));
    expect(spawned).toHaveLength(1);
    expect(spawned[0].jobs()).toHaveLength(2);
  });
});

describe('dead-worker replacement mid-search', () => {
  it('a crashed worker is terminated and replaced, so the pool never shrinks', async () => {
    const { pool, spawned } = harness(2);
    const p1 = pool.run(job(1));
    const p2 = pool.run(job(2));

    spawned[0].crash('detached ArrayBuffer');
    await expect(p1).rejects.toThrow(/Score worker crashed: detached ArrayBuffer/);
    expect(spawned[0].terminated).toBe(true);

    // The replacement exists, got its init, and idles ready for work.
    expect(spawned).toHaveLength(3);
    expect(spawned[2].sent[0]).toMatchObject({ type: 'init' });
    void pool.run(job(3));
    expect(spawned).toHaveLength(3);
    expect(spawned[2].jobs()).toHaveLength(1);

    spawned[1].reply({ type: 'done', jobId: 2, score: score('a'.repeat(64)) });
    await expect(p2).resolves.toBeDefined();
  });

  it('the replacement drains the queue a crash would otherwise strand', async () => {
    const { pool, spawned } = harness(1);
    const p1 = pool.run(job(1));
    const p2 = pool.run(job(2)); // queued behind the only worker

    spawned[0].crash('boom');
    await expect(p1).rejects.toThrow(/crashed/);
    // release(spawn()) handed the queued job straight to the replacement.
    expect(spawned).toHaveLength(2);
    expect(spawned[1].jobs()).toHaveLength(1);
    expect(spawned[1].jobs()[0]).toMatchObject({ jobId: 2 });

    spawned[1].reply({ type: 'done', jobId: 2, score: score('a'.repeat(64)) });
    await expect(p2).resolves.toBeDefined();
  });
});

describe('destroy', () => {
  it('rejects queued work rather than hanging the search, and hard-terminates', async () => {
    const { pool, spawned } = harness(1);
    void pool.run(job(1)).catch(() => undefined); // in-flight: discarded on terminate
    const queued = pool.run(job(2));
    const settled = queued.then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await pool.destroy();
    expect(await settled).toMatch(/cancelled/i);
    expect(spawned.every((w) => w.terminated)).toBe(true);
  });

  it('refuses new work after shutdown instead of quietly spawning workers', async () => {
    const { pool, spawned } = harness(2);
    await pool.destroy();
    await expect(pool.run(job(1))).rejects.toThrow(/shut down/i);
    expect(spawned).toHaveLength(0);
    // Destroying twice is not an error: the executor's `finally` may race a
    // cancellation that already tore it down.
    await expect(pool.destroy()).resolves.toBeUndefined();
  });
});
