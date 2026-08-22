/**
 * ONE SERVER PER DATA FOLDER (src/server/singleWriter.ts).
 *
 * What is being defended: every data file here is read whole, mutated in
 * memory, and written whole. The in-process promise chains in networthStore,
 * planStore and planHistoryStore make that atomic between writers in ONE
 * process, and are useless between two — so a second server appending to
 * plan-history.json discards the first one's entry with nothing logged. The
 * same shape deletes a net-worth row, which is the one record in this app that
 * cannot be recreated.
 *
 * The tests below pin the three behaviours that decide whether the guard helps
 * or gets in the way:
 *
 *   - a live holder is refused, with a message that says who and where;
 *   - a DEAD holder's lock is taken, not respected. There is no shutdown drain
 *     in this app and machines lose power, so a lock file that outlives its
 *     process must never need a human;
 *   - a lock written on another machine is refused rather than stolen, because
 *     a pid from a different host means nothing here.
 *
 * Every test uses a temp directory and injected clocks, hostnames and
 * liveness. None of them may look at the real data folder, and none may take
 * eight seconds waiting for a retry window it can fake.
 */
import { promises as fs, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DataDirLockedError,
  LOCK_FILENAME,
  acquireDataDirLock,
  describeConflict,
  lockPathFor,
  ownerStatus,
  parseOwner,
  pidIsAlive,
} from '../../src/server/singleWriter';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-lock-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NEVER_SLEEP = async (): Promise<void> => {};

describe('parseOwner', () => {
  it('reads a well-formed lock', () => {
    const owner = parseOwner(
      JSON.stringify({ pid: 42, host: 'box', port: 5599, appDir: '/app', startedAt: 'now' }),
    );
    expect(owner).toEqual({ pid: 42, host: 'box', port: 5599, appDir: '/app', startedAt: 'now' });
  });

  it('treats an unusable file as no lock at all', () => {
    // A process killed between creating the file and writing to it leaves a
    // zero-byte lock. Refusing to start forever because of an empty file
    // would be its own outage.
    expect(parseOwner('')).toBeNull();
    expect(parseOwner('{ not json')).toBeNull();
    expect(parseOwner('null')).toBeNull();
    expect(parseOwner('{}')).toBeNull();
    expect(parseOwner('{"pid":"nine"}')).toBeNull();
    expect(parseOwner('{"pid":0}')).toBeNull();
    expect(parseOwner('{"pid":1.5}')).toBeNull();
  });

  it('tolerates missing optional fields', () => {
    expect(parseOwner('{"pid":9}')).toEqual({
      pid: 9,
      host: '',
      port: 0,
      appDir: '',
      startedAt: '',
    });
  });
});

describe('ownerStatus', () => {
  const here = { hostname: 'box', isAlive: (pid: number) => pid === 100 };

  it('is stale when there is no usable record', () => {
    expect(ownerStatus(null, here)).toBe('stale');
  });

  it('is alive when the pid is running on this machine', () => {
    expect(ownerStatus(parseOwner('{"pid":100,"host":"box"}'), here)).toBe('alive');
  });

  it('is stale when the pid is gone — the lock is taken, not respected', () => {
    expect(ownerStatus(parseOwner('{"pid":101,"host":"box"}'), here)).toBe('stale');
  });

  it('is foreign when another host wrote it, whatever this machine thinks of the pid', () => {
    // 100 is alive HERE. On the machine that wrote this lock it means nothing.
    expect(ownerStatus(parseOwner('{"pid":100,"host":"other"}'), here)).toBe('foreign');
  });
});

describe('pidIsAlive', () => {
  it('knows about this process', () => {
    expect(pidIsAlive(process.pid)).toBe(true);
  });

  it('says no to a pid that cannot exist', () => {
    expect(pidIsAlive(2 ** 30)).toBe(false);
  });
});

describe('acquireDataDirLock', () => {
  it('creates the folder and writes a lock naming this process', async () => {
    const dataDir = path.join(tmpDir, 'not-yet-there');
    await acquireDataDirLock({ dataDir, port: 5599, appDir: '/app', sleep: NEVER_SLEEP });

    const raw = await fs.readFile(path.join(dataDir, LOCK_FILENAME), 'utf8');
    const owner = parseOwner(raw);
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.port).toBe(5599);
    expect(owner?.appDir).toBe('/app');
    expect(owner?.host).toBe(os.hostname());
  });

  it('releases, so the next start is unobstructed', async () => {
    const release = await acquireDataDirLock({
      dataDir: tmpDir,
      port: 5599,
      appDir: '/app',
      sleep: NEVER_SLEEP,
    });
    release();
    await expect(fs.access(lockPathFor(tmpDir))).rejects.toThrow();

    // And a second acquire now succeeds rather than finding a corpse.
    await acquireDataDirLock({ dataDir: tmpDir, port: 5599, appDir: '/app', sleep: NEVER_SLEEP });
    expect(parseOwner(await fs.readFile(lockPathFor(tmpDir), 'utf8'))?.pid).toBe(process.pid);
  });

  it('REFUSES when a live process holds the folder', async () => {
    await fs.writeFile(
      lockPathFor(tmpDir),
      JSON.stringify({
        pid: 4321,
        host: os.hostname(),
        port: 5600,
        appDir: '/opt/finance-planner',
        startedAt: '2026-08-22T00:00:00.000Z',
      }),
    );

    await expect(
      acquireDataDirLock({
        dataDir: tmpDir,
        port: 5599,
        appDir: '/home/dev/checkout',
        isAlive: () => true,
        waitMs: 0,
        sleep: NEVER_SLEEP,
      }),
    ).rejects.toThrow(DataDirLockedError);
  });

  it('takes a lock whose process is gone, and says it did', async () => {
    await fs.writeFile(
      lockPathFor(tmpDir),
      JSON.stringify({ pid: 4321, host: os.hostname(), port: 5599 }),
    );

    const cleared: Array<number | undefined> = [];
    await acquireDataDirLock({
      dataDir: tmpDir,
      port: 5599,
      appDir: '/app',
      isAlive: () => false,
      sleep: NEVER_SLEEP,
      onStaleLock: (owner) => cleared.push(owner?.pid),
    });

    expect(cleared).toEqual([4321]);
    expect(parseOwner(await fs.readFile(lockPathFor(tmpDir), 'utf8'))?.pid).toBe(process.pid);
  });

  it('clears a truncated lock file rather than deadlocking on it forever', async () => {
    await fs.writeFile(lockPathFor(tmpDir), '');
    await acquireDataDirLock({
      dataDir: tmpDir,
      port: 5599,
      appDir: '/app',
      isAlive: () => true,
      sleep: NEVER_SLEEP,
    });
    expect(parseOwner(await fs.readFile(lockPathFor(tmpDir), 'utf8'))?.pid).toBe(process.pid);
  });

  it('refuses a lock from another machine instead of stealing it', async () => {
    // A data folder on a network share. This host cannot see that host's
    // process table, so "is pid 4321 alive" is unanswerable and guessing would
    // defeat the entire point of the lock.
    await fs.writeFile(
      lockPathFor(tmpDir),
      JSON.stringify({ pid: 4321, host: 'some-other-box', port: 5599 }),
    );

    await expect(
      acquireDataDirLock({
        dataDir: tmpDir,
        port: 5599,
        appDir: '/app',
        // Even told the pid is dead here, a foreign lock is not ours to clear.
        isAlive: () => false,
        waitMs: 0,
        sleep: NEVER_SLEEP,
      }),
    ).rejects.toThrow(/different machine/);
  });

  it('WAITS before refusing, so a restart is not a coin flip', async () => {
    // tsx watch and systemd's Restart= both start the replacement while the
    // outgoing process may still be exiting. Failing on the first EEXIST would
    // turn every routine restart into a race.
    await fs.writeFile(
      lockPathFor(tmpDir),
      JSON.stringify({ pid: 4321, host: os.hostname(), port: 5599 }),
    );

    let attempts = 0;
    let clock = 0;
    const release = await acquireDataDirLock({
      dataDir: tmpDir,
      port: 5599,
      appDir: '/app',
      waitMs: 5000,
      pollMs: 250,
      now: () => clock,
      sleep: async () => {
        clock += 250;
      },
      isAlive: () => {
        attempts += 1;
        // The outgoing process finally exits on the fourth look, and its lock
        // is removed by its own exit handler.
        if (attempts >= 4) {
          try {
            unlinkSync(lockPathFor(tmpDir));
          } catch {
            /* already gone */
          }
          return false;
        }
        return true;
      },
    });

    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(parseOwner(await fs.readFile(lockPathFor(tmpDir), 'utf8'))?.pid).toBe(process.pid);
    release();
  });
});

describe('describeConflict', () => {
  const owner = parseOwner(
    JSON.stringify({
      pid: 4321,
      host: 'planner-box',
      port: 5600,
      appDir: '/opt/finance-planner',
      startedAt: '2026-08-22T09:00:00.000Z',
    }),
  );

  it('answers what has it, where it is, and what to do now', () => {
    const message = describeConflict(owner, 'alive', '/home/alex/finance-planner-data');
    expect(message).toContain('/home/alex/finance-planner-data');
    expect(message).toContain('pid 4321');
    expect(message).toContain('planner-box');
    expect(message).toContain('http://127.0.0.1:5600/');
    expect(message).toContain('/opt/finance-planner');
    // The "what do I do now" half matters as much as the diagnosis: the whole
    // reason someone hits this is that they wanted two checkouts at once.
    expect(message).toContain('FPLAN_DATA_DIR=~/finance-planner-dev-data');
    expect(message).toContain('service.sh stop');
  });

  it('explains a foreign lock rather than just refusing', () => {
    expect(describeConflict(owner, 'foreign', '/mnt/share/data')).toContain('different machine');
  });

  it('still reads sensibly when the lock said nothing useful', () => {
    const message = describeConflict(null, 'alive', '/data');
    expect(message).toContain('/data');
    expect(message).not.toContain('pid ');
  });
});
