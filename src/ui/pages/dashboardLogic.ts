/**
 * THE DASHBOARD'S PURE HALF — what its two cards say, with no React in it.
 * (Unit tests: tests/ui/dashboard.test.ts.)
 */
import {
  WINDOW_YEARS,
  trailingReturn,
  type DailyClose,
  type IndexHistory,
  type TrailingReturn,
} from '../../shared/marketIndex';
import type { NetWorthSnapshot, SnapshotScore } from '../../shared/types';

/** localStorage key for the cached S&P 500 history — market data, per browser. */
export const HISTORY_CACHE_KEY = 'fplan-sp500-history';

/**
 * Read the cached history back, or null for anything that is not one. Shape
 * only: a cache is a convenience, and a malformed one is simply refetched.
 */
export function readHistoryCache(raw: string | null): IndexHistory | null {
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as Partial<IndexHistory>;
    if (typeof o.fetchedAt !== 'string' || Number.isNaN(Date.parse(o.fetchedAt))) return null;
    if (!Array.isArray(o.closes) || o.closes.length === 0) return null;
    const ok = o.closes.every(
      (c: unknown) =>
        Array.isArray(c) &&
        typeof c[0] === 'string' &&
        typeof c[1] === 'number' &&
        Number.isFinite(c[1]) &&
        c[1] > 0,
    );
    return ok ? { fetchedAt: o.fetchedAt, closes: o.closes as DailyClose[] } : null;
  } catch {
    return null;
  }
}

/** The headline window and the zoom-outs, each null where history runs short. */
export function marketWindows(closes: readonly DailyClose[]): {
  headline: TrailingReturn | null;
  zoomOut: Array<{ years: number; result: TrailingReturn | null }>;
} {
  const [first, ...rest] = WINDOW_YEARS;
  return {
    headline: trailingReturn(closes, first),
    zoomOut: rest.map((years) => ({ years, result: trailingReturn(closes, years) })),
  };
}

/**
 * The row whose score the card shows: the NEWEST scored one. Today's row,
 * while it is still scoring, has no score yet — the card keeps showing the
 * last known answer and says a fresh one is coming, rather than blanking.
 */
export function latestScored(
  snapshots: readonly NetWorthSnapshot[],
): (NetWorthSnapshot & { score: SnapshotScore }) | null {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (s.score !== undefined) return s as NetWorthSnapshot & { score: SnapshotScore };
  }
  return null;
}

/**
 * The status line under the score — which day's prices it was scored with,
 * or that today's are being scored now.
 */
export function scoreStatus(opts: {
  snapshots: readonly NetWorthSnapshot[];
  scoring: readonly string[];
  refreshing: boolean;
  formatDate: (iso: string) => string;
}): string | null {
  if (opts.refreshing) return 'Refreshing prices…';
  const newest = opts.snapshots[opts.snapshots.length - 1];
  if (newest !== undefined && opts.scoring.includes(newest.id)) {
    return newest.score === undefined
      ? 'Re-scoring with today’s prices…'
      : 'Solving what the plan supports…';
  }
  const scored = latestScored(opts.snapshots);
  if (scored === null) return null;
  return `Scored ${opts.formatDate(scored.takenAt)}, with that day’s prices`;
}
