/**
 * THE SINGLE-WRITER GUARD: one Web Lock, and nothing else.
 *
 * WHAT IT STOPS. Two tabs of this origin, in this browser profile, both
 * opening the same folder — the lost-update shape singleWriter.ts documents:
 * both read twelve history entries, both write thirteen, one plan version is
 * silently gone. Web Locks (navigator.locks) covers that AIRTIGHT: one tab
 * holds 'fplan-writer:<folderId>' exclusively, and the browser releases it
 * the instant that tab dies, however it dies. No heartbeat, no staleness
 * math, no file on disk, no stuck lock after a crash, and — the property
 * that matters most here — NO FALSE POSITIVES. It is free, so it stays.
 *
 * WHAT IT DELIBERATELY DOES NOT STOP, AND WHY (2026-09-05). A second machine
 * writing the same folder over iCloud/Dropbox. There used to be a second
 * layer for that: a heartbeat lease file (.writer.lease) plus a scan that
 * refused any folder carrying sync artifacts. Both are gone. The reasoning:
 *
 *   1. IT NEVER CLOSED THE HOLE IT APPEARED TO. The lease only sees writers
 *      overlapping in TIME. The way a synced folder actually loses data needs
 *      no overlap at all: machine A writes and its owner closes the lid
 *      before the upload finishes; machine B opens twenty minutes later,
 *      reads a STALE networth.json, appends, writes it back. Strictly one
 *      writer at a time, rows gone anyway. A lock cannot see that, so the
 *      lease was buying much less than its ceremony implied.
 *
 *   2. ITS FALSE REFUSALS WERE ROUTINE. The sync scan refused the folder on
 *      any name matching `.icloud` — which is not a conflict marker at all,
 *      it is iCloud's ordinary eviction stub for a file offloaded to save
 *      space. On a folder shared between two people who open it on alternate
 *      days, that is the normal resting state, and it read as "resolve this
 *      fork by hand" for a fork that did not exist.
 *
 *   3. THE STAKES ARE ONE HOUSEHOLD'S SPREADSHEET. This is a personal
 *      planner. The owner's judgement, recorded here so it is not
 *      re-litigated: losing some net-worth history is an acceptable cost,
 *      and a guard that misfires on the normal case is worse than no guard.
 *
 * THE RECOVERY STORY IS GIT, and it is now the only one. `git init` in the
 * data folder gives a dated history of every change, which is strictly more
 * protection than the lease ever offered because it survives the stale-read
 * failure too. README says so; nothing in the app enforces it.
 */
import type { FileStore } from '../../shared/fileStore';

export const WEB_LOCK_PREFIX = 'fplan-writer:';

export interface BrowserWriterGuard {
  /** Free the Web Lock. The tab dying does this too. */
  release(): Promise<void>;
}

export type BrowserWriterGuardResult =
  | { ok: true; guard: BrowserWriterGuard }
  /** Another tab of this profile holds the lock; the message says what to do. */
  | { ok: false; reason: 'tab'; message: string };

export interface BrowserWriterGuardOptions {
  /**
   * Stable identity for THIS folder in THIS browser profile — scopes the Web
   * Lock, so two different folders opened in two tabs never contend.
   */
  folderId: string;
  /** Unused by the lock itself; kept so callers need not special-case it. */
  files?: FileStore;
}

/**
 * The guard held by this tab, once acquisition succeeds. One per tab;
 * releaseHeldGuard consumes it.
 */
let held: BrowserWriterGuard | null = null;

export async function acquireBrowserWriterGuard(
  opts: BrowserWriterGuardOptions,
): Promise<BrowserWriterGuardResult> {
  const lockName = `${WEB_LOCK_PREFIX}${opts.folderId}`;

  // Hold the lock for the guard's lifetime: the grant callback's returned
  // promise IS the hold, resolved only by release(). {ifAvailable: true}
  // makes contention an immediate honest "no" instead of a silent queue — a
  // queued writer waking minutes later, after the user walked away, would
  // start writing into a folder nobody is watching.
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

  const guard: BrowserWriterGuard = {
    async release(): Promise<void> {
      releaseWebLock();
    },
  };
  held = guard;
  return { ok: true, guard };
}

/**
 * Folder switching's half of the guard story: free the lock just before
 * location.reload() into another folder, so the folder being left is
 * immediately openable in this browser instead of only once this tab is gone.
 *
 * No-op when no guard is held (HTTP mode, or boot never completed). There is
 * deliberately no release on the ordinary path — the tab dying IS the
 * release, and releasing on pagehide would drop the lock while a bfcache'd
 * page could still come back.
 */
export async function releaseHeldGuard(): Promise<void> {
  const guard = held;
  if (guard === null) return;
  held = null;
  await guard.release();
}
