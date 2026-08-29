/**
 * THE HEARTBEAT LEASE (.writer.lease): the browser-era half of "one writer
 * per data folder" that a Web Lock cannot provide.
 *
 * WHAT REPLACED WHAT. Under node, .writer.lock (src/server/singleWriter.ts)
 * guards the folder with an O_EXCL create plus pid-liveness: a lock whose pid
 * is dead is stale, a lock from another host is refused because a pid means
 * nothing across machines. In the browser there is no O_EXCL (the File System
 * Access API's exclusive create is check-then-create — see the contract note
 * on FileStore.createExclusive, which is why NOTHING here calls it) and there
 * is no pid to probe. So the invariant splits into two layers:
 *
 *   1. Web Locks (navigator.locks) — same browser profile, same machine:
 *      AIRTIGHT. The lock is granted to one tab and auto-released the instant
 *      that tab dies, however it dies. That layer lives in
 *      src/ui/io/browserWriterGuard.ts because it is a browser API; this
 *      module never touches it.
 *   2. THIS FILE — everything Web Locks cannot see: another browser, another
 *      machine on a synced folder. A lease is {holder, acquiredAt, renewedAt,
 *      heartbeatMs}, rewritten on a timer while the writer lives; a reader
 *      arriving later judges it by AGE, because heartbeat age is the only
 *      liveness signal that exists without a shared kernel.
 *
 * WHAT THE LEASE CAN AND CANNOT PROMISE — read this before trusting it:
 *
 *   - Within one machine and one browser profile it is redundant belt to Web
 *     Locks' braces. Fine.
 *   - Across browsers on one machine it is honest detection: a live Chrome
 *     heartbeating every 15s will be seen by an Edge opening the folder, and
 *     refused, within one read.
 *   - ACROSS MACHINES ON A SYNCED FOLDER IT IS ADVISORY, and says so to the
 *     user. iCloud/Dropbox deliver the lease file with seconds-to-hours of
 *     latency, so machine B can read a "stale" lease while machine A is alive
 *     and typing — and taking over on that evidence is a documented, accepted
 *     risk, the SAME honesty posture as today's foreign-host refusal ("give
 *     each machine its own folder"). The lease detects and refuses in the
 *     common case; it cannot prevent a determined or unlucky race. The stated
 *     operating condition is one machine writing at a time; the recovery
 *     story for a violated condition is git on the folder, not this file.
 *
 * STALENESS: a lease is stale when now - renewedAt > heartbeatMs ×
 * STALE_AFTER_BEATS (3 — two missed beats is a hiccup or a paused laptop lid;
 * three is a dead holder, the same generosity singleWriter's restart-overlap
 * wait gives). The multiple is applied to the HOLDER'S OWN recorded
 * heartbeatMs, not ours: a holder that promised a 60s beat is not stale at
 * 46s just because our default beat is faster. A renewedAt in the FUTURE
 * (the other machine's clock is ahead) reads as fresh — refusing is the safe
 * side of clock skew.
 *
 * WHY THE CONCRETE FAILURE JUSTIFIES ALL THIS CEREMONY: two writers on one
 * folder is the lost-update shape singleWriter.ts spells out — both read
 * twelve history entries, both write thirteen, one version of the plan is
 * gone silently. The file that would lose a row (networth.json) "records
 * prices from a moment that has passed and cannot be recreated from
 * anything". That failure already cost this project one real record; the
 * lease exists so the browser port cannot reintroduce it quietly.
 */
import { FileNotFoundError, type FileStore } from '../shared/fileStore';

export const LEASE_FILENAME = '.writer.lease';
export const DEFAULT_HEARTBEAT_MS = 15_000;
/** Stale after this many missed beats — ~45s at the default heartbeat. */
export const STALE_AFTER_BEATS = 3;

export interface LeaseHolder {
  /** Random per-installation id — the browser's stand-in for pid+hostname. */
  clientId: string;
  /** Human words for the refusal message ("Chrome on mikes-mbp"). */
  label: string;
}

export interface WriterLease {
  holder: LeaseHolder;
  /** ISO — when this holder first took the folder. */
  acquiredAt: string;
  /** ISO — the last heartbeat. Age of THIS is what staleness judges. */
  renewedAt: string;
  /** The renewal interval this holder promised, ms. */
  heartbeatMs: number;
}

/**
 * Read a lease file's contents into a record. Anything that does not parse
 * into a usable lease returns null and is treated as TAKEOVER material: a
 * half-synced or hand-mangled lease must not brick the folder forever, and —
 * unlike a real holder — garbage cannot renew itself, so taking over is safe
 * in exactly the way pid-gone was under node.
 */
export function parseLease(raw: string): WriterLease | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const holder = o.holder as Record<string, unknown> | undefined;
  if (
    typeof holder !== 'object' ||
    holder === null ||
    typeof holder.clientId !== 'string' ||
    holder.clientId.length === 0
  ) {
    return null;
  }
  if (typeof o.renewedAt !== 'string' || Number.isNaN(Date.parse(o.renewedAt))) return null;
  if (typeof o.heartbeatMs !== 'number' || !(o.heartbeatMs > 0)) return null;
  return {
    holder: {
      clientId: holder.clientId,
      label: typeof holder.label === 'string' ? holder.label : '',
    },
    acquiredAt: typeof o.acquiredAt === 'string' ? o.acquiredAt : '',
    renewedAt: o.renewedAt,
    heartbeatMs: o.heartbeatMs,
  };
}

export type LeaseDecision =
  /** No lease, or our own — write ours and go. */
  | { action: 'acquire' }
  /** A dead or unreadable lease is being replaced; the note goes to the log. */
  | { action: 'takeover'; note: string }
  /** A fresh foreign lease. The message answers what/where/what-now. */
  | { action: 'refuse'; message: string };

/**
 * The refusal message. Same three questions singleWriter.describeConflict
 * answers — what has the folder, where is it, what do I do now — plus the
 * honesty clause the lease uniquely owes: across machines it is advisory.
 */
export function describeLeaseConflict(lease: WriterLease, leaseName: string): string {
  const staleAfterS = Math.round((lease.heartbeatMs * STALE_AFTER_BEATS) / 1000);
  return [
    'Another Finance Planner is already writing this data folder.',
    '',
    'Two writers on one folder lose each other\'s work silently: both read the',
    'whole file, both write the whole file, and the second one wins. A plan',
    'version or a net-worth row can disappear with nothing logged anywhere.',
    '',
    `  held by : ${lease.holder.label || 'an unnamed app'} (${lease.holder.clientId})`,
    ...(lease.acquiredAt ? [`  since   : ${lease.acquiredAt}`] : []),
    `  last heartbeat : ${lease.renewedAt}`,
    `  lease   : ${leaseName}`,
    '',
    `Close the planner that holds it, or wait: an abandoned lease goes stale`,
    `${staleAfterS}s after its last heartbeat and will be taken over on the next open.`,
    'If this folder syncs between machines (iCloud, Dropbox), note that the',
    'lease is ADVISORY across machines — sync delay can misreport the other',
    'side — so use one machine at a time, or give each machine its own folder.',
  ].join('\n');
}

/**
 * Judge an existing lease (raw file text, or null when the file is absent)
 * against the would-be writer. Pure — every clock is a parameter — so the
 * staleness math is testable to the millisecond.
 */
export function decideLease(
  raw: string | null,
  self: LeaseHolder,
  now: Date,
  leaseName: string,
): LeaseDecision {
  if (raw === null) return { action: 'acquire' };
  const lease = parseLease(raw);
  if (lease === null) {
    return {
      action: 'takeover',
      note: `replacing an unreadable ${LEASE_FILENAME} — not a live holder, since garbage cannot renew itself`,
    };
  }
  if (lease.holder.clientId === self.clientId) return { action: 'acquire' };
  const ageMs = now.getTime() - Date.parse(lease.renewedAt);
  const staleAfterMs = lease.heartbeatMs * STALE_AFTER_BEATS;
  // A FUTURE renewedAt (ageMs < 0) is clock skew, and skew reads as fresh:
  // refusing is the recoverable mistake, stealing is not.
  if (ageMs > staleAfterMs) {
    return {
      action: 'takeover',
      note:
        `taking over a stale lease from ${lease.holder.label || lease.holder.clientId}: ` +
        `last heartbeat ${lease.renewedAt}, ${Math.round(ageMs / 1000)}s ago ` +
        `(stale after ${Math.round(staleAfterMs / 1000)}s)`,
    };
  }
  return { action: 'refuse', message: describeLeaseConflict(lease, leaseName) };
}

// ---------------------------------------------------------------------------
// Sync-conflict artifacts
// ---------------------------------------------------------------------------

/**
 * Names that mean a sync engine has already made a mess of this folder —
 * i.e. the lease's stated operating condition ("one machine writing at a
 * time") has ALREADY been violated, or the folder is not even fully local:
 *
 *   - `.icloud` — iCloud's eviction stub (".plan.json.icloud"): the real
 *     bytes are in the cloud, not on this disk, so reading the folder now
 *     reads a hole.
 *   - "conflicted copy" — Dropbox's rename when two machines edited one file.
 *   - "sync-conflict" — Syncthing's equivalent.
 *
 * Opening for writing on top of any of these would pile new writes onto an
 * unresolved fork — the exact R4 failure where one machine's networth append
 * quietly stops being the canonical file. So the guard refuses to open until
 * the user resolves them by hand; the message lists the offending names.
 */
const SYNC_CONFLICT_PATTERNS: readonly RegExp[] = [
  /\.icloud$/i,
  /conflicted copy/i,
  /sync-conflict/i,
];

/** The offending names among `names`, in input order. Pure; tested directly. */
export function syncConflictArtifacts(names: readonly string[]): string[] {
  return names.filter((n) => SYNC_CONFLICT_PATTERNS.some((p) => p.test(n)));
}

/**
 * Scan the folder for conflict artifacts, recursively — except runs/ and
 * searches/, which are content-keyed caches: a conflict copy there is never
 * read (lookups are by exact key-derived filename) and costs at worst cache
 * warmth, so refusing the whole folder over it would be punishing the user
 * for a mess with no victim.
 */
const CONFLICT_SCAN_SKIP = new Set(['runs', 'searches']);

export async function findSyncConflicts(files: FileStore, relDir = ''): Promise<string[]> {
  let entries;
  try {
    entries = await files.list(relDir);
  } catch (err) {
    if (err instanceof FileNotFoundError) return [];
    throw err;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (syncConflictArtifacts([entry.name]).length > 0) found.push(rel);
    if (entry.kind === 'directory' && !(relDir === '' && CONFLICT_SCAN_SKIP.has(entry.name))) {
      found.push(...(await findSyncConflicts(files, rel)));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Acquisition + heartbeat
// ---------------------------------------------------------------------------

export interface AcquireLeaseOptions {
  files: FileStore;
  self: LeaseHolder;
  heartbeatMs?: number;
  now?: () => Date;
  /** Timer seams, so tests drive the heartbeat by hand. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  /** Where takeover notes and lost-lease warnings go (default console.log). */
  onLog?: (message: string) => void;
}

export interface WriterLeaseGuard {
  /** Non-null when acquisition displaced a stale/unreadable lease. */
  takeoverNote: string | null;
  /**
   * True once a renewal found somebody else's lease under our feet — the
   * advisory layer's honest signal that the folder should be treated as
   * contested. The heartbeat stops itself when this flips.
   */
  readonly lost: boolean;
  /** Stop heartbeating and delete the lease (only if it is still ours). */
  release(): Promise<void>;
}

export type AcquireLeaseResult =
  | { ok: true; guard: WriterLeaseGuard }
  | { ok: false; reason: 'held' | 'sync-conflict'; message: string };

/**
 * Take the folder's lease, or explain who has it / why the folder is not
 * safe to write. On success a heartbeat rewrites the lease every
 * `heartbeatMs` until release().
 *
 * Writes go through FileStore.writeText — on the browser driver that is an
 * atomic whole-file replace, so a reader never sees a torn lease from us.
 * (What it CAN see is a sync engine's torn delivery; parseLease treats that
 * as takeover material, see its note.)
 */
export async function acquireWriterLease(opts: AcquireLeaseOptions): Promise<AcquireLeaseResult> {
  const {
    files,
    self,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    now = () => new Date(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]),
    onLog = (m) => console.log(m),
  } = opts;

  const conflicts = await findSyncConflicts(files);
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: 'sync-conflict',
      message:
        'This folder carries unresolved sync-conflict artifacts, so writing to it ' +
        'would pile new changes onto a fork that has not been reconciled:\n' +
        conflicts.map((c) => `  - ${files.describe(c)}`).join('\n') +
        '\nResolve them (keep the right copy, delete the artifact), then open the folder again.',
    };
  }

  let raw: string | null;
  try {
    raw = await files.readText(LEASE_FILENAME);
  } catch (err) {
    if (err instanceof FileNotFoundError) raw = null;
    else throw err;
  }

  const decision = decideLease(raw, self, now(), files.describe(LEASE_FILENAME));
  if (decision.action === 'refuse') {
    return { ok: false, reason: 'held', message: decision.message };
  }
  const takeoverNote = decision.action === 'takeover' ? decision.note : null;
  if (takeoverNote !== null) onLog(takeoverNote);

  const acquiredAt = now().toISOString();
  const writeLease = async (): Promise<void> => {
    const lease: WriterLease = {
      holder: self,
      acquiredAt,
      renewedAt: now().toISOString(),
      heartbeatMs,
    };
    await files.writeText(LEASE_FILENAME, `${JSON.stringify(lease, null, 2)}\n`);
  };
  await writeLease();

  let lost = false;
  let stopped = false;
  let timer: unknown = null;

  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Read before renewing: blindly rewriting would stomp a takeover that
      // happened while this tab was frozen past its own staleness window (a
      // laptop lid, a background-tab deep freeze). Losing the lease is the
      // advisory layer working, and the honest response is to stop claiming.
      let current: WriterLease | null = null;
      try {
        current = parseLease(await files.readText(LEASE_FILENAME));
      } catch (err) {
        if (!(err instanceof FileNotFoundError)) throw err;
      }
      if (current !== null && current.holder.clientId !== self.clientId) {
        lost = true;
        stopped = true;
        onLog(
          `writer lease lost to ${current.holder.label || current.holder.clientId} — ` +
            'this session was presumably frozen past its own staleness window; stopping renewals',
        );
        return;
      }
      await writeLease();
    } catch (err) {
      // A transient IO failure (a sync engine holding the file, a quota
      // hiccup) must not end renewals SILENTLY: a heartbeat that dies
      // quietly lets the lease go stale under a live writer, which is an
      // invitation for another machine to take over mid-session. Say so and
      // keep beating — the next beat may well succeed, and if it never does,
      // the log says why the lease aged out.
      onLog(`writer lease heartbeat failed, will retry: ${(err as Error).message}`);
    }
    timer = schedule(() => void beat().catch(() => undefined), heartbeatMs);
  };
  timer = schedule(() => void beat().catch(() => undefined), heartbeatMs);

  return {
    ok: true,
    guard: {
      takeoverNote,
      get lost() {
        return lost;
      },
      async release(): Promise<void> {
        stopped = true;
        if (timer !== null) cancel(timer);
        // Delete only OUR lease: releasing after a takeover-by-someone-else
        // must not delete the new holder's claim. Best-effort — a tab killed
        // before this line leaves a lease that goes stale on schedule, which
        // is exactly the case staleness exists for.
        try {
          const current = parseLease(await files.readText(LEASE_FILENAME));
          if (current !== null && current.holder.clientId === self.clientId) {
            await files.deleteFile(LEASE_FILENAME);
          }
        } catch {
          // Absent or unreadable: nothing of ours to clean up.
        }
      },
    },
  };
}
