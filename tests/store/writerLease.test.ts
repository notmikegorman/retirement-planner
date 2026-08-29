/**
 * The heartbeat lease (src/store/writerLease.ts): parse, the staleness math,
 * the refusal message, the sync-conflict detector, and the acquire/heartbeat/
 * release lifecycle over the in-memory driver with hand-driven timers.
 *
 * Everything time-shaped is injected — the whole point of the lease design
 * being pure over (raw, self, now) is that the staleness boundary can be
 * tested to the millisecond instead of with sleeps. The browser lane re-tests
 * the integrated guard (Web Locks + lease) in real Chromium
 * (tests/browser/stores.test.ts); THIS file owns the math.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../src/shared/memoryFileStore';
import {
  DEFAULT_HEARTBEAT_MS,
  LEASE_FILENAME,
  STALE_AFTER_BEATS,
  acquireWriterLease,
  decideLease,
  describeLeaseConflict,
  findSyncConflicts,
  parseLease,
  syncConflictArtifacts,
  type WriterLease,
} from '../../src/store/writerLease';

const SELF = { clientId: 'client-self', label: 'Chrome on this-mac' };
const OTHER = { clientId: 'client-other', label: 'Edge on other-mac' };

const T0 = new Date('2026-08-29T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

function leaseJson(over: Partial<WriterLease> = {}): string {
  const lease: WriterLease = {
    holder: OTHER,
    acquiredAt: '2026-08-29T11:00:00.000Z',
    renewedAt: T0.toISOString(),
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    ...over,
  };
  return `${JSON.stringify(lease, null, 2)}\n`;
}

describe('parseLease', () => {
  it('reads a well-formed lease back whole', () => {
    const lease = parseLease(leaseJson());
    expect(lease?.holder).toEqual(OTHER);
    expect(lease?.renewedAt).toBe(T0.toISOString());
    expect(lease?.heartbeatMs).toBe(DEFAULT_HEARTBEAT_MS);
  });

  it('treats garbage as null — a mangled lease must not brick the folder', () => {
    // A zero-byte file, half-synced JSON, or a hand edit: none of these is a
    // live holder (garbage cannot renew itself), so all become takeover
    // material rather than a permanent refusal.
    expect(parseLease('')).toBeNull();
    expect(parseLease('{ not json')).toBeNull();
    expect(parseLease('null')).toBeNull();
    expect(parseLease('{"holder":{}}')).toBeNull();
    expect(parseLease(leaseJson().replace(T0.toISOString(), 'not-a-date'))).toBeNull();
    expect(parseLease(JSON.stringify({ holder: OTHER, renewedAt: T0.toISOString(), heartbeatMs: 0 }))).toBeNull();
  });
});

describe('decideLease — the staleness math', () => {
  const decide = (raw: string | null, now: Date) => decideLease(raw, SELF, now, '/x/.writer.lease');

  it('acquires when no lease exists', () => {
    expect(decide(null, T0)).toEqual({ action: 'acquire' });
  });

  it('acquires over its OWN lease — reopening is not a conflict', () => {
    expect(decide(leaseJson({ holder: SELF }), at(999_999))).toEqual({ action: 'acquire' });
  });

  it('takes over an unreadable lease, with a note that says why that is safe', () => {
    const d = decide('{ not json', T0);
    expect(d.action).toBe('takeover');
    expect((d as { note: string }).note).toContain('unreadable');
  });

  it('refuses a FRESH foreign lease, naming the holder — exactly like .writer.lock', () => {
    const d = decide(leaseJson(), at(10_000));
    expect(d.action).toBe('refuse');
    const message = (d as { message: string }).message;
    expect(message).toContain('Edge on other-mac');
    expect(message).toContain('/x/.writer.lease');
    expect(message).toContain('already writing');
    // The honesty clause: across machines the lease is advisory, and the
    // message must say so rather than promise a guarantee it cannot keep.
    expect(message).toContain('ADVISORY across machines');
  });

  it('the boundary is heartbeat × STALE_AFTER_BEATS, exclusive', () => {
    const staleAfter = DEFAULT_HEARTBEAT_MS * STALE_AFTER_BEATS;
    // Exactly at the boundary: still fresh — two missed beats and change is a
    // paused laptop, not a corpse.
    expect(decide(leaseJson(), at(staleAfter)).action).toBe('refuse');
    // One millisecond past: stale, taken over, with the arithmetic in the note.
    const d = decide(leaseJson(), at(staleAfter + 1));
    expect(d.action).toBe('takeover');
    expect((d as { note: string }).note).toContain('Edge on other-mac');
  });

  it("judges by the HOLDER'S OWN heartbeat promise, not ours", () => {
    // A holder that promised a 60s beat is not stale at 46s just because our
    // default beat is 15s.
    const slow = leaseJson({ heartbeatMs: 60_000 });
    expect(decide(slow, at(46_000)).action).toBe('refuse');
    expect(decide(slow, at(180_000 + 1)).action).toBe('takeover');
  });

  it('a renewedAt in the FUTURE reads as fresh — clock skew refuses, never steals', () => {
    expect(decide(leaseJson({ renewedAt: at(120_000).toISOString() }), T0).action).toBe('refuse');
  });

  it('describeLeaseConflict states the stale-after window in seconds', () => {
    const lease = parseLease(leaseJson())!;
    expect(describeLeaseConflict(lease, '/x/.writer.lease')).toContain('45s');
  });
});

describe('syncConflictArtifacts', () => {
  it('matches the three artifact families and nothing else', () => {
    const names = [
      'plan.json',
      '.plan.json.icloud', // iCloud eviction stub
      "networth (Mike's conflicted copy 2026-08-29).json", // Dropbox
      'plan.sync-conflict-20260829-123456-ABCDEF.json', // Syncthing
      'icloud-notes.txt', // mentions icloud but is not a stub
      'copy of plan.json',
    ];
    expect(syncConflictArtifacts(names)).toEqual([
      '.plan.json.icloud',
      "networth (Mike's conflicted copy 2026-08-29).json",
      'plan.sync-conflict-20260829-123456-ABCDEF.json',
    ]);
  });
});

describe('findSyncConflicts', () => {
  it('scans nested directories but skips the content-keyed cache dirs', async () => {
    const files = createMemoryFileStore();
    await files.mkdir('assumptions/tax');
    await files.mkdir('runs');
    await files.mkdir('searches');
    await files.writeText('plan.json', '{}');
    await files.writeText('assumptions/tax/.federal-2026.json.icloud', '');
    // A conflict copy in runs/ is never read (lookups are by exact runKey
    // filename) and costs only cache warmth — not worth refusing the folder.
    await files.writeText("runs/abc (Mike's conflicted copy).json", '{}');
    await files.writeText('searches/x.sync-conflict-1.json', '{}');
    expect(await findSyncConflicts(files)).toEqual(['assumptions/tax/.federal-2026.json.icloud']);
  });

  it('an empty or absent folder has no conflicts', async () => {
    expect(await findSyncConflicts(createMemoryFileStore())).toEqual([]);
  });
});

describe('acquireWriterLease — the lifecycle', () => {
  /** Timer seam capturing scheduled beats so the test drives time by hand. */
  function manualTimers(): {
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (t: unknown) => void;
    fire: () => Promise<void>;
    pending: () => number;
    cancelled: () => number;
  } {
    const queue: Array<() => void> = [];
    let cancelledCount = 0;
    return {
      schedule: (fn) => {
        queue.push(fn);
        return fn;
      },
      cancel: (t) => {
        const i = queue.indexOf(t as () => void);
        if (i >= 0) queue.splice(i, 1);
        cancelledCount += 1;
      },
      fire: async () => {
        const fn = queue.shift();
        if (fn) fn();
        // The beat body is async; let its microtasks drain.
        await new Promise((r) => setTimeout(r, 0));
      },
      pending: () => queue.length,
      cancelled: () => cancelledCount,
    };
  }

  it('acquires a free folder: lease written with holder, timestamps, heartbeat promise', async () => {
    const files = createMemoryFileStore();
    const timers = manualTimers();
    const result = await acquireWriterLease({
      files,
      self: SELF,
      now: () => T0,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onLog: () => undefined,
    });
    expect(result.ok).toBe(true);
    const lease = parseLease(await files.readText(LEASE_FILENAME))!;
    expect(lease.holder).toEqual(SELF);
    expect(lease.acquiredAt).toBe(T0.toISOString());
    expect(lease.renewedAt).toBe(T0.toISOString());
    expect(lease.heartbeatMs).toBe(DEFAULT_HEARTBEAT_MS);
    expect(timers.pending()).toBe(1); // the first beat is scheduled
  });

  it('refuses a fresh foreign lease and writes NOTHING', async () => {
    const files = createMemoryFileStore();
    await files.writeText(LEASE_FILENAME, leaseJson());
    const before = await files.readText(LEASE_FILENAME);
    const result = await acquireWriterLease({ files, self: SELF, now: () => at(5_000), onLog: () => undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('held');
      expect(result.message).toContain('Edge on other-mac');
    }
    expect(await files.readText(LEASE_FILENAME)).toBe(before);
  });

  it('takes over a stale lease with a logged note', async () => {
    const files = createMemoryFileStore();
    await files.writeText(LEASE_FILENAME, leaseJson());
    const logs: string[] = [];
    const now = at(DEFAULT_HEARTBEAT_MS * STALE_AFTER_BEATS + 60_000);
    const result = await acquireWriterLease({
      files,
      self: SELF,
      now: () => now,
      schedule: () => 0,
      cancel: () => undefined,
      onLog: (m) => logs.push(m),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.guard.takeoverNote).toContain('Edge on other-mac');
    expect(logs.join('\n')).toContain('stale');
    expect(parseLease(await files.readText(LEASE_FILENAME))?.holder).toEqual(SELF);
  });

  it('refuses a folder carrying sync-conflict artifacts, listing them', async () => {
    const files = createMemoryFileStore();
    await files.writeText('.plan.json.icloud', '');
    const result = await acquireWriterLease({ files, self: SELF, onLog: () => undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sync-conflict');
      expect(result.message).toContain('.plan.json.icloud');
      expect(result.message).toContain('Resolve them');
    }
    expect(await files.exists(LEASE_FILENAME)).toBe(false);
  });

  it('the heartbeat renews renewedAt but never acquiredAt', async () => {
    const files = createMemoryFileStore();
    const timers = manualTimers();
    let nowMs = T0.getTime();
    const result = await acquireWriterLease({
      files,
      self: SELF,
      now: () => new Date(nowMs),
      schedule: timers.schedule,
      cancel: timers.cancel,
      onLog: () => undefined,
    });
    expect(result.ok).toBe(true);

    nowMs += DEFAULT_HEARTBEAT_MS;
    await timers.fire();
    const lease = parseLease(await files.readText(LEASE_FILENAME))!;
    expect(lease.renewedAt).toBe(new Date(nowMs).toISOString());
    expect(lease.acquiredAt).toBe(T0.toISOString());
    expect(timers.pending()).toBe(1); // the next beat is queued
  });

  it('a beat that finds a FOREIGN lease stops renewing and reports the loss', async () => {
    // The frozen-tab case: this session slept past its own staleness window,
    // somebody else took over honestly, and stomping their lease now would
    // recreate the two-writer race the whole file exists to prevent.
    const files = createMemoryFileStore();
    const timers = manualTimers();
    const logs: string[] = [];
    const result = await acquireWriterLease({
      files,
      self: SELF,
      now: () => T0,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onLog: (m) => logs.push(m),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await files.writeText(LEASE_FILENAME, leaseJson()); // OTHER took over
    await timers.fire();

    expect(result.guard.lost).toBe(true);
    expect(logs.join('\n')).toContain('lease lost');
    expect(parseLease(await files.readText(LEASE_FILENAME))?.holder).toEqual(OTHER);
    expect(timers.pending()).toBe(0); // no further beats scheduled
  });

  it('release cancels the heartbeat and deletes OUR lease', async () => {
    const files = createMemoryFileStore();
    const timers = manualTimers();
    const result = await acquireWriterLease({
      files,
      self: SELF,
      now: () => T0,
      schedule: timers.schedule,
      cancel: timers.cancel,
      onLog: () => undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.guard.release();
    expect(timers.cancelled()).toBe(1);
    expect(await files.exists(LEASE_FILENAME)).toBe(false);
  });

  it("release after somebody else took over does NOT delete the new holder's lease", async () => {
    const files = createMemoryFileStore();
    const result = await acquireWriterLease({
      files,
      self: SELF,
      now: () => T0,
      schedule: () => 0,
      cancel: () => undefined,
      onLog: () => undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await files.writeText(LEASE_FILENAME, leaseJson()); // OTHER took over meanwhile
    await result.guard.release();
    expect(parseLease(await files.readText(LEASE_FILENAME))?.holder).toEqual(OTHER);
  });

  it('a beat that hits a transient IO failure logs, keeps beating, and recovers', async () => {
    // The failure this pins: a heartbeat that died SILENTLY on one bad read
    // or write would let the lease age out under a live writer — an open
    // invitation for another machine to take the folder mid-session, with
    // nothing logged on either side. A transient failure must say so and try
    // again on the next beat.
    const files = createMemoryFileStore();
    const timers = manualTimers();
    const logged: string[] = [];
    let failNextRead = false;
    let failNextWrite = false;
    const flaky = {
      ...files,
      async readText(relPath: string): Promise<string> {
        if (failNextRead && relPath === LEASE_FILENAME) {
          failNextRead = false;
          throw new Error('transient read failure (a sync engine holds the file)');
        }
        return files.readText(relPath);
      },
      async writeText(relPath: string, text: string): Promise<void> {
        if (failNextWrite && relPath === LEASE_FILENAME) {
          failNextWrite = false;
          throw new Error('transient write failure (quota hiccup)');
        }
        return files.writeText(relPath, text);
      },
    };
    let tick = 0;
    const result = await acquireWriterLease({
      files: flaky,
      self: SELF,
      now: () => at(++tick * 1000),
      schedule: timers.schedule,
      cancel: timers.cancel,
      onLog: (m) => logged.push(m),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Beat 1: the read fails — logged, lease NOT lost, next beat scheduled.
    failNextRead = true;
    await timers.fire();
    expect(logged.some((m) => m.includes('heartbeat failed, will retry'))).toBe(true);
    expect(result.guard.lost).toBe(false);
    expect(timers.pending()).toBe(1);

    // Beat 2: the write fails — same story.
    const renewedBefore = parseLease(await files.readText(LEASE_FILENAME))!.renewedAt;
    failNextWrite = true;
    await timers.fire();
    expect(result.guard.lost).toBe(false);
    expect(timers.pending()).toBe(1);
    expect(parseLease(await files.readText(LEASE_FILENAME))!.renewedAt).toBe(renewedBefore);

    // Beat 3: healthy again — the renewal lands.
    await timers.fire();
    expect(parseLease(await files.readText(LEASE_FILENAME))!.renewedAt).not.toBe(renewedBefore);
    expect(parseLease(await files.readText(LEASE_FILENAME))!.holder).toEqual(SELF);
  });
});
