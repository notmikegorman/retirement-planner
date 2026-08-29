/**
 * THE GUARD WORKER: the single-writer guard — Web Lock, lease file, and above
 * all the lease HEARTBEAT — held in a dedicated worker instead of the page.
 *
 * WHY A WORKER AT ALL. The lease's whole liveness story is its heartbeat age:
 * a reader refuses a lease renewed within ~45s and takes over one that was
 * not (src/store/writerLease.ts). Browsers throttle PAGE timers in hidden
 * tabs — to once a minute, and in deep-freeze to nothing — so a heartbeat
 * scheduled on the main thread would go stale in any tab the user simply
 * switched away from, and another machine reading the folder would "take
 * over" a session that is alive behind a background tab. Dedicated workers
 * are exempt from that throttling, so the beat runs here. (This is the same
 * reason the plan keeps search coordination in a worker — risk R8 — and the
 * plan's end-state has this worker owning ALL file IO; Phase 4 moves the
 * guard, which is the part timers can silently starve.)
 *
 * The Web Lock is held from THIS worker too, not the page — Web Locks are
 * origin-wide and worker-held locks still block every other tab of the
 * profile — and the worker dies with its tab, so the auto-release-on-death
 * property is exactly what it was. Everything of substance (order of layers,
 * refusal messages, takeover rules, the beat's read-before-renew that
 * RE-ADOPTS a self-lease quietly after a freeze and stops claiming a foreign
 * one) lives in browserWriterGuard/writerLease; this file is a message shim
 * around acquireBrowserWriterGuard and deliberately adds no policy.
 *
 * Protocol, one guard per worker:
 *   → { type: 'acquire', handle, folderId, self, heartbeatMs? }
 *   ← { type: 'result', ok: true, takeoverNote } | { type: 'result', ok: false, reason, message }
 *   ← { type: 'log', message }            (takeover notes, heartbeat retries)
 *   ← { type: 'lease-lost' }              (once, if a renewal finds a foreign lease)
 *   → { type: 'release' } … ← { type: 'released' }
 */
import type { LeaseHolder } from '../../store/writerLease';
import { createFsaFileStore } from '../io/fsaFileStore';
import {
  acquireBrowserWriterGuard,
  type BrowserWriterGuard,
} from '../io/browserWriterGuard';

export type GuardWorkerRequest =
  | {
      type: 'acquire';
      handle: FileSystemDirectoryHandle;
      folderId: string;
      self: LeaseHolder;
      heartbeatMs?: number;
    }
  | { type: 'release' };

export type GuardWorkerReply =
  | { type: 'result'; ok: true; takeoverNote: string | null }
  | { type: 'result'; ok: false; reason: 'tab' | 'held' | 'sync-conflict'; message: string }
  | { type: 'log'; message: string }
  | { type: 'lease-lost' }
  | { type: 'released' };

/** How often the worker looks at guard.leaseLost. Coarse on purpose: the flag
 *  flips at most once, minutes into a pathological scenario. */
const LOST_POLL_MS = 15_000;

// The narrow slice of DedicatedWorkerGlobalScope this file uses, typed
// locally for the same reason as simWorker.ts: the repo compiles one program
// against lib "DOM", and lib "WebWorker" cannot be mixed into it.
const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<GuardWorkerRequest>) => void) | null;
  postMessage(msg: GuardWorkerReply): void;
};

function post(msg: GuardWorkerReply): void {
  workerScope.postMessage(msg);
}

let guard: BrowserWriterGuard | null = null;
let lostPoll: ReturnType<typeof setInterval> | null = null;

async function acquire(msg: Extract<GuardWorkerRequest, { type: 'acquire' }>): Promise<void> {
  if (guard !== null) throw new Error('guard worker already holds a guard');
  const result = await acquireBrowserWriterGuard({
    files: createFsaFileStore(msg.handle, '(data folder)'),
    folderId: msg.folderId,
    self: msg.self,
    ...(msg.heartbeatMs !== undefined ? { heartbeatMs: msg.heartbeatMs } : {}),
    onLog: (message) => post({ type: 'log', message }),
  });
  if (!result.ok) {
    post({ type: 'result', ok: false, reason: result.reason, message: result.message });
    return;
  }
  guard = result.guard;
  lostPoll = setInterval(() => {
    if (guard?.leaseLost) {
      post({ type: 'lease-lost' });
      if (lostPoll !== null) clearInterval(lostPoll);
      lostPoll = null;
    }
  }, LOST_POLL_MS);
  post({ type: 'result', ok: true, takeoverNote: result.guard.takeoverNote });
}

/**
 * Stop the beat, delete our lease, free the Web Lock. The ordinary end of a
 * tab never sends this — the tab (and this worker) just dies, the Web Lock
 * auto-releases, and the lease goes stale on schedule, which is exactly the
 * case staleness exists for.
 */
async function release(): Promise<void> {
  if (lostPoll !== null) clearInterval(lostPoll);
  lostPoll = null;
  try {
    await guard?.release();
  } catch {
    // Best-effort: an IO failure here leaves a lease that goes stale on
    // schedule, the same outcome as a killed tab.
  } finally {
    guard = null;
    post({ type: 'released' });
  }
}

workerScope.onmessage = (ev: MessageEvent<GuardWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'acquire') {
    acquire(msg).catch((err: unknown) => {
      // An acquisition throw (IO failure, not a refusal) surfaces as a refusal
      // shape with the error's own message: the page renders what happened and
      // the worker holds nothing (browserWriterGuard released the Web Lock on
      // its way out — its exception-hygiene contract).
      post({
        type: 'result',
        ok: false,
        reason: 'held',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    void release();
  }
};
