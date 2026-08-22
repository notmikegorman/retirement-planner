/**
 * ONE SERVER PER DATA FOLDER. The guard, and the reasoning it enforces.
 *
 * WHAT ALREADY PROTECTS THE FILES, AND EXACTLY HOW FAR IT REACHES.
 * networthStore.ts, planStore.ts and planHistoryStore.ts each hold a
 * module-level promise chain (`let writes: Promise<unknown>` + `serialized()`)
 * that makes every read-modify-write of networth.json / plan.json /
 * plan-history.json atomic with respect to the other writers. Those chains are
 * load-bearing and they are correct — but they are JavaScript variables, and a
 * variable protects exactly one process. Two servers pointed at one folder have
 * two chains that have never heard of each other.
 *
 * WHAT THAT COSTS, CONCRETELY. Every one of those files is read whole, mutated
 * in memory, and written whole. So: process A reads plan-history.json and sees
 * twelve entries. Process B reads the same twelve. A appends its entry and
 * writes thirteen. B appends its own to ITS twelve and writes thirteen. A's
 * entry is gone. Nothing throws, nothing logs, and the file is still perfectly
 * well-formed — the loss is invisible until you go looking for a version that
 * is not there. The same shape deletes a net-worth row, and networthStore's own
 * comment says why that one is the worst case: the row "records prices from a
 * moment that has passed" and cannot be recreated from anything.
 *
 * It is also not only the stores. initDataDir() runs migrateGivingSplitFiles(),
 * which rewrites plan.json raw, BEFORE Fastify is even constructed and outside
 * every chain. So the dangerous moment is not "two servers running" — it is a
 * second server STARTING while a first one is live. That is precisely the
 * moment this guard covers, because it runs before initDataDir().
 *
 * There is no file locking anywhere else in the codebase — no lockfile, no
 * advisory lock, no PID file, no "already running" check. A second process on a
 * different FPLAN_PORT starts perfectly happily against the same folder; only a
 * port collision ever stopped anything, and only by accident. Once the app has
 * an installed copy on one port and a development checkout on another, that
 * accident stops happening, which is what makes this file necessary now.
 *
 * WHY A LOCKFILE AND NOT A PORT CHECK. The thing being protected is the data
 * folder, not the port. Asking "is something listening on 5599" answers the
 * wrong question: the dev checkout on :5174/:5599 and the service on :5600 are
 * the collision that matters, and they do not share a port. The lock lives IN
 * the folder it protects, so it is scoped to exactly the resource at risk.
 *
 * STALE LOCKS RESOLVE THEMSELVES. There is no shutdown drain in this app (see
 * the exit handling below), and a machine can lose power mid-run, so a lock
 * file left behind by a dead process must never require a human. The file
 * records the pid and the hostname that wrote it; a lock whose pid is gone is
 * removed and taken. A lock written on a DIFFERENT host — which happens only if
 * the data folder is on a network share — is refused rather than stolen,
 * because this process cannot see that machine's process table and guessing
 * would defeat the entire point.
 *
 * WHY IT WAITS BEFORE REFUSING. A restart is not an instant. `tsx watch`, and
 * systemd's `Restart=`, both start the replacement promptly enough that the
 * outgoing process may still be exiting. Failing on the first EEXIST would turn
 * every routine restart into a coin flip, so acquisition retries for a few
 * seconds first. A genuine second copy is still running at the end of that
 * window; a restart is not.
 */
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The data folder is already being written by a live process elsewhere. */
export class DataDirLockedError extends Error {}

export interface LockOwner {
  /** Process id of the server holding the folder. */
  pid: number;
  /** Hostname that wrote the lock — a pid only means something on its own machine. */
  host: string;
  /** Port that server bound, so the message can tell you where to look. */
  port: number;
  /** Checkout the holder was launched from; the two-checkout setup makes this the useful half. */
  appDir: string;
  /** ISO timestamp, for a human reading a stale-looking lock by hand. */
  startedAt: string;
}

export const LOCK_FILENAME = '.writer.lock';

/** Where the lock for a given data folder lives. */
export function lockPathFor(dataDir: string): string {
  return path.join(dataDir, LOCK_FILENAME);
}

/**
 * Read a lock file's contents into an owner record.
 *
 * A file that will not parse, or that carries no usable pid, returns null and
 * is treated as stale. It has to be: a lock written by a process that was
 * killed between creating the file and writing to it is a zero-byte file, and
 * refusing to start forever because of an empty file would be its own outage.
 */
export function parseOwner(raw: string): LockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return null;
  return {
    pid: o.pid,
    host: typeof o.host === 'string' ? o.host : '',
    port: typeof o.port === 'number' ? o.port : 0,
    appDir: typeof o.appDir === 'string' ? o.appDir : '',
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : '',
  };
}

export type OwnerStatus = 'stale' | 'alive' | 'foreign';

export interface StatusDeps {
  /** This machine's hostname. */
  hostname: string;
  /** Whether a pid exists on this machine. */
  isAlive: (pid: number) => boolean;
}

/**
 * Is the recorded holder still there?
 *
 *   'stale'   — no usable record, or the pid is gone. Take the lock.
 *   'alive'   — that process is running right here. Refuse.
 *   'foreign' — written on another machine, so its pid tells us nothing.
 *               Refuse, and say why, rather than stealing on a guess.
 */
export function ownerStatus(owner: LockOwner | null, deps: StatusDeps): OwnerStatus {
  if (owner === null) return 'stale';
  if (owner.host !== '' && owner.host !== deps.hostname) return 'foreign';
  return deps.isAlive(owner.pid) ? 'alive' : 'stale';
}

/** Does this pid exist on this machine? Signal 0 asks without sending anything. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to somebody else — which is
    // still "alive", and still a reason not to touch the folder.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The refusal message. Its whole job is to answer the three questions the
 * person reading it is about to ask: what has the folder, where is it, and
 * what do I do now.
 */
export function describeConflict(
  owner: LockOwner | null,
  status: OwnerStatus,
  dataDir: string,
): string {
  const lines = [
    `Another Finance Planner is already writing ${dataDir}.`,
    '',
    'Two servers on one data folder lose each other\'s writes silently: both read',
    'the whole file, both write the whole file, and the second one wins. A plan',
    'version or a net-worth row can disappear with nothing logged anywhere.',
    '',
  ];
  if (owner) {
    lines.push(`  held by : pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ''}`);
    if (owner.port) lines.push(`  serving : http://127.0.0.1:${owner.port}/`);
    if (owner.appDir) lines.push(`  from    : ${owner.appDir}`);
    if (owner.startedAt) lines.push(`  since   : ${owner.startedAt}`);
    lines.push(`  lock    : ${lockPathFor(dataDir)}`);
    lines.push('');
  }
  if (status === 'foreign') {
    lines.push(
      'That lock was written on a different machine, so this one cannot tell',
      'whether the process is still alive. A data folder on a network share',
      'cannot be guarded from here — give each machine its own folder.',
      '',
    );
  }
  lines.push(
    'To run both an installed copy and a development checkout, give the second',
    'one its own folder:',
    '',
    '    FPLAN_DATA_DIR=~/finance-planner-dev-data npm run dev',
    '',
    'Or stop the other one first (scripts/service.sh stop). If you are certain',
    'nothing is running, delete the lock file above.',
  );
  return lines.join('\n');
}

export interface AcquireOptions {
  dataDir: string;
  port: number;
  appDir: string;
  /** How long a restart is allowed to overlap before we call it a second copy. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hostname?: string;
  isAlive?: (pid: number) => boolean;
  pid?: number;
  /** Called when a dead process's lock is cleared, so the boot log says so. */
  onStaleLock?: (owner: LockOwner | null) => void;
}

const DEFAULT_WAIT_MS = 8000;
const DEFAULT_POLL_MS = 250;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take the data folder, or explain who has it.
 *
 * Returns a release function. It is also wired to process exit, because the
 * common ways this process dies — SIGTERM from systemd, SIGINT from a terminal,
 * `process.exit(1)` from the top-level catch — do not run `finally` blocks.
 */
export async function acquireDataDirLock(opts: AcquireOptions): Promise<() => void> {
  const {
    dataDir,
    port,
    appDir,
    waitMs = DEFAULT_WAIT_MS,
    pollMs = DEFAULT_POLL_MS,
    now = Date.now,
    sleep = sleepMs,
    hostname = os.hostname(),
    isAlive = pidIsAlive,
    pid = process.pid,
    onStaleLock,
  } = opts;

  const lockPath = lockPathFor(dataDir);
  mkdirSync(dataDir, { recursive: true });

  const record: LockOwner = {
    pid,
    host: hostname,
    port,
    appDir,
    startedAt: new Date(now()).toISOString(),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const deadline = now() + waitMs;

  for (;;) {
    let fd: number | undefined;
    try {
      // 'wx' is O_CREAT | O_EXCL: it creates the file or fails, never truncates
      // one somebody else is holding.
      fd = openSync(lockPath, 'wx');
      writeSync(fd, body);
      closeSync(fd);
      fd = undefined;

      // Read our own write back. Two processes can both find a stale lock, both
      // unlink it, and both create — the loser's create lands on the winner's
      // file. Verifying costs one read and turns that race into a retry.
      const readBack = parseOwner(safeRead(lockPath) ?? '');
      if (readBack?.pid === pid) {
        return registerRelease(lockPath, pid);
      }
      continue;
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const raw = safeRead(lockPath);
    // The file vanished between the failed create and this read — whoever held
    // it has just released it. Go straight back and take it.
    if (raw === null) continue;

    const owner = parseOwner(raw);
    const status = ownerStatus(owner, { hostname, isAlive });

    if (status === 'stale') {
      onStaleLock?.(owner);
      try {
        unlinkSync(lockPath);
      } catch {
        // Somebody else cleared it first; the next create attempt settles it.
      }
      continue;
    }

    if (now() >= deadline) {
      throw new DataDirLockedError(describeConflict(owner, status, dataDir));
    }
    await sleep(pollMs);
  }
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Release on the way out.
 *
 * THIS IS THE ONLY SIGNAL HANDLING IN THE APP, AND IT DELIBERATELY DRAINS
 * NOTHING. There is no graceful shutdown here and this is not the place to
 * invent one: a scoring run is minutes of work in a worker thread, and a
 * SIGTERM handler that waited for it would make `systemctl stop` hang for
 * minutes with no explanation. The protection against killing a run mid-flight
 * lives in scripts/update.sh, which waits for the app to go quiet BEFORE it
 * stops anything. All this does is put the key back on the hook so the next
 * start does not have to reason about a corpse.
 */
function registerRelease(lockPath: string, pid: number): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only remove a lock that is still ours. If a stale-lock sweep by another
      // process has already replaced it, deleting would evict a live server.
      const owner = parseOwner(safeRead(lockPath) ?? '');
      if (owner?.pid === pid && existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // A lock we cannot remove is cleaned up by the next start's staleness
      // check, so this must never be the thing that fails a shutdown.
    }
  };

  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
  return release;
}
