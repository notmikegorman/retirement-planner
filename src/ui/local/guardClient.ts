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
        if (msg.ok) resolve({ ok: true, takeoverNote: msg.takeoverNote });
        else {
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
