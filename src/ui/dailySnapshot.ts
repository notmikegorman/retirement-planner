/**
 * THE ONCE-A-DAY SNAPSHOT — one rule, two doors.
 *
 * The owner's rule (2026-08-30, Net worth): arriving takes today's snapshot if
 * none exists yet, so the record never depends on remembering a button. The
 * Dashboard (2026-11-21) opens the app, so it takes the same snapshot — fresh
 * prices, a fresh net worth, and the plan re-scored against them — behind the
 * scenes. Two pages, one snapshot a day: whichever arrives first takes it,
 * and the other must neither take a second nor miss the first.
 *
 * Hence module state, not component state. A page that mounts while the
 * other's POST is still in flight joins THAT promise (its list was read
 * before the row existed, so its own "taken today?" check would say no). A
 * page that mounts after the POST landed but whose list was read before it
 * did is caught by `takenDay`. Both are per tab; across two tabs the backend
 * write lock serialises the posts and the worst case is the one a manual
 * second snapshot already produces — two rows, both true.
 */
import type { NetWorthSnapshot, Profile } from '../shared/types';
import { api } from './api';
import { simulationReadiness } from './firstRun';

let inFlight: Promise<NetWorthSnapshot> | null = null;
let takenDay: string | null = null;

/** The local calendar day — "today" is the owner's day, not UTC's. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Does the ledger already hold a row from the same local day as `now`? */
export function snapshotTakenToday(
  snapshots: readonly Pick<NetWorthSnapshot, 'takenAt'>[],
  now: Date,
): boolean {
  const today = localDayKey(now);
  return snapshots.some((s) => localDayKey(new Date(s.takenAt)) === today);
}

/**
 * The home value the automatic snapshot records: the last snapshot's figure,
 * the profile's only when the ledger is empty (the profile is a starting
 * guess, not a record). The same default the manual dialog offers.
 */
export function defaultHomeValue(
  snapshots: readonly Pick<NetWorthSnapshot, 'homeValue'>[],
  profile: Pick<Profile, 'home'>,
): number {
  return snapshots[snapshots.length - 1]?.homeValue ?? profile.home.value;
}

/** A snapshot this tab started and has not finished, if any. */
export function dailySnapshotInFlight(): Promise<NetWorthSnapshot> | null {
  return inFlight;
}

/**
 * Take today's snapshot unless one exists or is on its way. Resolves to the
 * NEW row when this call (or a concurrent one it joined) took it; to null
 * when nothing was taken — already taken today, or the zero-start gate is up
 * (no accounts: a snapshot would record a total of nothing and score a
 * household that does not exist). Rejects with the backend's error.
 */
export function ensureTodaysSnapshot(opts: {
  snapshots: readonly NetWorthSnapshot[];
  profile: Profile;
  now?: Date;
}): Promise<NetWorthSnapshot | null> {
  if (inFlight !== null) return inFlight;
  const now = opts.now ?? new Date();
  if (simulationReadiness(opts.profile).state === 'no-accounts') return Promise.resolve(null);
  if (takenDay === localDayKey(now) || snapshotTakenToday(opts.snapshots, now)) {
    return Promise.resolve(null);
  }
  const day = localDayKey(now);
  const attempt = api.takeNetWorthSnapshot({
    homeValue: defaultHomeValue(opts.snapshots, opts.profile),
  });
  inFlight = attempt;
  attempt.then(
    () => {
      takenDay = day;
      inFlight = null;
    },
    () => {
      inFlight = null;
    },
  );
  return attempt;
}

/** Tests only: forget this tab's memory of today. */
export function resetDailySnapshotForTests(): void {
  inFlight = null;
  takenDay = null;
}
