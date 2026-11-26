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
import { MAX_SPEND_HI } from '../../engine/solvers';
import { purchaseDate } from '../../engine/housingPlan';
import type { Scenario } from '../../shared/types';
import { formatUSD } from '../../shared/util';

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

/** What the spend card shows: a figure, or the honest reason there is none. */
export type SpendAnswer = { kind: 'value'; yearly: number } | { kind: 'reason'; text: string };

/**
 * The max-spend solve's answer, read with the snapshot scorer's own two rules
 * (store/scoreRunner.solveSustainableSpend): no answer means nothing in the
 * bracket reaches the target; an answer at the bracket's top means "more than
 * this", which is not a figure anything measured.
 */
export function spendFromSolve(answer: number | undefined): SpendAnswer {
  if (answer === undefined) {
    return { kind: 'reason', text: 'No spending level reaches the plan’s success target' };
  }
  if (answer >= MAX_SPEND_HI) {
    return { kind: 'reason', text: `More than ${formatUSD(MAX_SPEND_HI / 12)} a month` };
  }
  return { kind: 'value', yearly: answer };
}

/** "$5,563" a month from a yearly figure — whole dollars, rounded down. */
export function monthlyFromYearly(yearly: number): number {
  return Math.floor(yearly / 12);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "June 2027" from '2027-06'. */
export function formatYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1] ?? ''} ${y}`.trim();
}

/**
 * When the plan stops work: one date when everyone retires together, each
 * person's when they differ (first name and date), null when no one does.
 */
export function retirementDates(
  plan: Pick<Scenario, 'events'>,
): { headline: string; detail: string | null } | null {
  const retires = plan.events.flatMap((e) => (e.type === 'retire' ? [e] : []));
  if (retires.length === 0) return null;
  const dates = [...new Set(retires.map((e) => e.date))].sort();
  const year = Number(dates[0].slice(0, 4));
  if (dates.length === 1) return { headline: String(year), detail: formatYearMonth(dates[0]) };
  return {
    headline: `${year}–${dates[dates.length - 1].slice(0, 4)}`,
    detail: dates.map(formatYearMonth).join(' · '),
  };
}

/**
 * The next house: its price and the month it is bought (sale month plus the
 * rental months — engine/housingPlan.purchaseDate). Null when the plan holds
 * no move, or moves to rent with no purchase.
 */
export function nextHouse(
  plan: Pick<Scenario, 'housing'>,
): { headline: string; detail: string | null } | null {
  const h = plan.housing;
  if (h === undefined || h.purchasePrice === 'none') return null;
  const bought = `Bought ${formatYearMonth(purchaseDate(h))}`;
  // 'sale_proceeds': the next house costs whatever the old one nets.
  if (h.purchasePrice === 'sale_proceeds') return { headline: 'The sale’s proceeds', detail: bought };
  return { headline: formatUSD(h.purchasePrice), detail: bought };
}
