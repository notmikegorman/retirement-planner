/**
 * THE BROWSER'S SINGLE-WRITER GUARD: Web Locks + the heartbeat lease,
 * layered, replacing .writer.lock's job for a folder opened in a browser.
 *
 * TWO LAYERS BECAUSE TWO BLIND SPOTS. What must never happen is two writers
 * interleaving read-modify-writes of one record file (the lost-update shape
 * singleWriter.ts documents: both read twelve entries, both write thirteen,
 * a plan version is silently gone). The writers a browser can collide with
 * come in two kinds, and no single mechanism sees both:
 *
 *   1. ANOTHER TAB of this origin in this browser profile. Web Locks
 *      (navigator.locks) covers this AIRTIGHT: one tab holds
 *      'fplan-writer:<folderId>' exclusively, and the OS/browser releases it
 *      the instant the tab dies — no heartbeat, no staleness math, no stuck
 *      lock after a crash. This is strictly better than the pid-checked
 *      .writer.lock it replaces, within its zone.
 *   2. EVERYTHING WEB LOCKS CANNOT SEE — another browser, another machine on
 *      a synced folder. Only something IN the folder can speak there, so the
 *      heartbeat lease file (src/store/writerLease.ts) carries it: honest
 *      detection, refusal of a fresh foreign lease naming its holder, and a
 *      documented ADVISORY-across-machines posture (sync lag can misreport;
 *      one machine at a time is the stated condition; git on the folder is
 *      the recovery story).
 *
 * ORDER: Web Lock first, lease second. The Web Lock is cheap, instant and
 * cannot be stolen, so losing it means "another tab is the writer" and the
 * lease file need not even be read; the lease's slower, file-based answer is
 * only consulted once this tab is the profile's sole candidate. Release
 * unwinds in reverse.
 *
 * The sync-conflict refusal (findSyncConflicts) rides in front of both via
 * acquireWriterLease: a folder already carrying iCloud stubs or "conflicted
 * copy" files is a fork in progress, and writing onto a fork is how one
 * machine's net-worth append stops being canonical (risk R4).
 */
import type { FileStore } from '../../shared/fileStore';
import {
  acquireWriterLease,
  DEFAULT_HEARTBEAT_MS,
  type LeaseHolder,
  type WriterLeaseGuard,
} from '../../store/writerLease';

export const WEB_LOCK_PREFIX = 'fplan-writer:';

export interface BrowserWriterGuard {
  /** Non-null when acquisition displaced a stale/unreadable lease. */
  takeoverNote: string | null;
  /** True once the lease heartbeat found a foreign lease (folder contested). */
  readonly leaseLost: boolean;
  /** Release the lease (heartbeat stops, file removed) then the Web Lock. */
  release(): Promise<void>;
}

export type BrowserWriterGuardResult =
  | { ok: true; guard: BrowserWriterGuard }
  /**
   * 'tab': another tab of this profile holds the Web Lock (open read-only or
   * offer take-over there). 'held': a fresh foreign lease — another browser
   * or machine. 'sync-conflict': the folder needs manual reconciliation
   * first. The messages are user-facing and answer what/where/what-now.
   */
  | { ok: false; reason: 'tab' | 'held' | 'sync-conflict'; message: string };

export interface BrowserWriterGuardOptions {
  files: FileStore;
  /**
   * Stable identity for THIS folder in THIS browser profile — scopes the Web
   * Lock, so two different folders opened in two tabs never contend.
   */
  folderId: string;
  self: LeaseHolder;
  heartbeatMs?: number;
  onLog?: (message: string) => void;
}

export async function acquireBrowserWriterGuard(
  opts: BrowserWriterGuardOptions,
): Promise<BrowserWriterGuardResult> {
  const { files, folderId, self, heartbeatMs = DEFAULT_HEARTBEAT_MS, onLog } = opts;
  const lockName = `${WEB_LOCK_PREFIX}${folderId}`;

  // Hold the Web Lock for the guard's lifetime: the grant callback's returned
  // promise is the hold, resolved only by release(). {ifAvailable: true}
  // makes contention an immediate honest "no" instead of a silent queue —
  // a queued writer waking up minutes later, after the user walked away,
  // would start writing into a folder nobody is watching.
  let releaseWebLock: () => void = () => undefined;
  const granted = await new Promise<boolean>((resolve, reject) => {
    navigator.locks
      .request(lockName, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise<void>((releaseDone) => {
          releaseWebLock = releaseDone;
        });
      })
      .catch(reject);
  });

  if (!granted) {
    return {
      ok: false,
      reason: 'tab',
      message:
        'Another tab in this browser is already writing this data folder. ' +
        'Use that tab, or close it and reopen here — the lock releases the ' +
        'moment the writing tab is gone.',
    };
  }

  const leaseResult = await acquireWriterLease({ files, self, heartbeatMs, onLog });
  if (!leaseResult.ok) {
    releaseWebLock();
    return { ok: false, reason: leaseResult.reason, message: leaseResult.message };
  }
  const lease: WriterLeaseGuard = leaseResult.guard;

  return {
    ok: true,
    guard: {
      takeoverNote: lease.takeoverNote,
      get leaseLost() {
        return lease.lost;
      },
      async release(): Promise<void> {
        await lease.release();
        releaseWebLock();
      },
    },
  };
}
