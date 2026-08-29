/**
 * The page's client for the guard worker (src/ui/workers/guardWorker.ts):
 * spawn, hand over the folder handle, translate the reply. All policy — the
 * two-layer guard, the messages, the heartbeat — lives behind the worker;
 * this module only carries the conversation.
 *
 * The guard is acquired BEFORE any store touches the folder (localBackend's
 * boot order) and held for the tab's lifetime. There is deliberately no
 * release call on the happy path: the tab dying IS the release (Web Lock
 * auto-freed, lease going stale on schedule), and an explicit release on
 * pagehide would drop the lock while a bfcache'd page could still come back.
 *
 * THE ONE DELIBERATE EXCEPTION is releaseHeldGuard below — the folder-switch
 * path (the topbar's File control), where the user is walking away from this
 * folder ON PURPOSE and a reload into another folder follows immediately.
 */
import type { LeaseHolder } from '../../store/writerLease';
import type { GuardWorkerReply, GuardWorkerRequest } from '../workers/guardWorker';

export type GuardAcquisition =
  | { ok: true; takeoverNote: string | null }
  | { ok: false; reason: 'tab' | 'held' | 'sync-conflict'; message: string };

export interface GuardClientOptions {
  handle: FileSystemDirectoryHandle;
  folderId: string;
  self: LeaseHolder;
  heartbeatMs?: number;
  /** Worker-side log lines (takeover notes, heartbeat retries). */
  onLog?: (message: string) => void;
  /** Fired once if the lease is lost to a foreign writer (folder contested). */
  onLeaseLost?: () => void;
}

/**
 * The worker holding this tab's guard, once acquisition succeeds. One per
 * tab, like the guard itself; releaseHeldGuard consumes it.
 */
let heldWorker: Worker | null = null;

export async function acquireGuardInWorker(opts: GuardClientOptions): Promise<GuardAcquisition> {
  const { handle, folderId, self, heartbeatMs, onLog, onLeaseLost } = opts;
  const worker = new Worker(new URL('../workers/guardWorker.ts', import.meta.url), {
    type: 'module',
  });

  return new Promise<GuardAcquisition>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<GuardWorkerReply>) => {
      const msg = ev.data;
      if (msg.type === 'log') onLog?.(msg.message);
      else if (msg.type === 'lease-lost') onLeaseLost?.();
      else if (msg.type === 'result') {
        if (msg.ok) {
          heldWorker = worker;
          resolve({ ok: true, takeoverNote: msg.takeoverNote });
        } else {
          // A refusal holds nothing, so the worker has no further job. The
          // acquired worker, by contrast, IS the guard and lives on.
          worker.terminate();
          resolve({ ok: false, reason: msg.reason, message: msg.message });
        }
      }
    };
    worker.onerror = (ev) => {
      worker.terminate();
      reject(new Error(`guard worker failed: ${ev.message}`));
    };
    const request: GuardWorkerRequest = {
      type: 'acquire',
      handle,
      folderId,
      self,
      ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    };
    worker.postMessage(request);
  });
}

/** How long a graceful release may take before the reload proceeds anyway. */
const RELEASE_TIMEOUT_MS = 5_000;

/**
 * THE GRACEFUL RELEASE — folder switching's half of the guard story. Stops
 * the heartbeat, deletes our lease file, frees the Web Lock (the worker's
 * own release path), then retires the worker. Called by the topbar folder
 * control just before location.reload() into another folder, so the folder
 * being left is immediately openable by another browser or machine instead
 * of only after the ~45s staleness window.
 *
 * BEST-EFFORT, BY DESIGN, on two counts:
 *
 *   - The timeout: a wedged worker must not strand the switch. Proceeding
 *     without the delete leaves exactly what a killed tab leaves — a lease
 *     that goes stale on schedule, the case staleness exists for.
 *   - The release-vs-heartbeat race (writerLease.release's own note): a beat
 *     already in flight when release stops the timer can rewrite the lease
 *     AFTER the delete. Same outcome, same staleness recovery — and a switch
 *     BACK to this folder from this browser re-adopts the leftover lease
 *     silently, because the clientId matches (decideLease's own-lease rule).
 *
 * No-op when no guard is held (HTTP mode, or boot never completed).
 */
export async function releaseHeldGuard(): Promise<void> {
  const worker = heldWorker;
  if (worker === null) return;
  heldWorker = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
    worker.addEventListener('message', (ev: MessageEvent<GuardWorkerReply>) => {
      if (ev.data.type === 'released') {
        clearTimeout(timer);
        resolve();
      }
    });
    const request: GuardWorkerRequest = { type: 'release' };
    worker.postMessage(request);
  });
  worker.terminate();
}
