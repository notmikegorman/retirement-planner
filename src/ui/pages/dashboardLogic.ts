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
import { planIdentityKey } from '../../shared/planIdentity';
import { sha256Hex } from '../../shared/sha256';
import type { NetWorthSnapshot, Scenario } from '../../shared/types';

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
 * WHAT THE PLAN SUPPORTS — the sustainable spend, taken from the newest
 * snapshot whose score measured THIS plan on THIS engine. The success
 * probability no longer comes from the ledger (the card shows the Plan page's
 * own final run, so the two pages cannot disagree); the spend still does,
 * because only the snapshot scorer solves it. A row scored under a different
 * plan or engine answers a different question — the owner's 2026-11-21 report
 * was exactly that: a row scored by a stale cached bundle on the previous
 * engine, printed beside today's plan — so such a row is skipped, never shown.
 */
export function comparableSpend(
  snapshots: readonly NetWorthSnapshot[],
  plan: Scenario,
  engineVersion: string,
): { yearly: number; takenAt: string } | null {
  const hash = planFingerprint(plan);
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i].score;
    if (s === undefined || s.sustainableSpend === undefined) continue;
    if (s.planHash !== hash || s.engineVersion !== engineVersion) continue;
    return { yearly: s.sustainableSpend, takenAt: snapshots[i].takenAt };
  }
  return null;
}

/** The plan's fingerprint — the same sha256 the stores file scores under. */
export function planFingerprint(plan: Scenario): string {
  return sha256Hex(planIdentityKey(plan));
}

/** "$5,563" a month from a yearly figure — whole dollars, rounded down. */
export function monthlyFromYearly(yearly: number): number {
  return Math.floor(yearly / 12);
}
