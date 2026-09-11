/**
 * THE S&P 500 TICKER — its rules, with no browser in them.
 *
 * The sidebar shows one number that is not about the household: the S&P 500's
 * level, the day's move, and when the app last fetched it. Everything here is
 * pure so the one part that is easy to get wrong — WHEN to fetch — is pinned by
 * tests against real Eastern-time instants, both sides of daylight saving.
 *
 * WHEN TO FETCH (the owner's rule, and the refinement it needed). Refresh when
 * the app is activated, unless the value is under an hour old or the market
 * has closed. Taken literally, "closed" would strand a value fetched at 2 PM
 * all evening: after the close the ONE fetch worth making is the one that
 * captures the closing value. So: after the close, fetch again only while the
 * value on hand predates the settled close; once it is in, nothing until the
 * next session opens. The hour rule applies throughout.
 *
 * THE CLOCK DOES THE WORK, NOT A HOLIDAY TABLE. "Open" is weekdays 9:30 AM to
 * 4:00 PM Eastern. A holiday or an early 1 PM close is not in that rule, and it
 * does not need to be: the only error either can cause is an extra fetch that
 * returns the same number (at most one an hour), never a missed one, because
 * no NYSE session ever runs later than 4:00 PM. A holiday list would be a file
 * that goes stale every January to save a handful of requests.
 *
 * "SETTLED" IS AN HOUR AFTER THE BELL. Yahoo stamped the captured closing
 * value at 4:46 PM; a fetch at 4:05 can still hold a provisional number. So a
 * value counts as the close only if it was fetched at or after 5:00 PM on the
 * close's day. Worst case that costs one extra evening fetch.
 */

/** Yahoo's symbol for the index itself — the level, not an ETF tracking it. */
export const SP500_SYMBOL = '^GSPC';

/** The owner's floor: never refetch a value younger than this. */
export const MIN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** How long after 4:00 PM a fetched value might still not be the settled close. */
export const CLOSE_SETTLE_MS = 60 * 60 * 1000;

/** A fetchedAt this far in the FUTURE means the device clock moved; refetch. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 16 * 60;
const SETTLED_MINUTE = CLOSE_MINUTE + CLOSE_SETTLE_MS / 60_000;

/** What the sidebar keeps between visits. */
export interface IndexQuote {
  price: number;
  /** The prior session's close — what the day's move is measured from. */
  previousClose: number;
  /** ISO — when the APP fetched it; the timestamp the sidebar shows. */
  fetchedAt: string;
}

function isPositive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/**
 * Yahoo's chart JSON down to the two numbers the ticker needs. Refuses rather
 * than guesses: a missing previous close would make the day's move — the green
 * or red on screen — a number with nothing under it.
 */
export function parseIndexChart(body: unknown): { price: number; previousClose: number } {
  const chart = (body as { chart?: unknown } | null)?.chart as
    | { result?: unknown; error?: { description?: string; code?: string } | null }
    | undefined;
  if (!chart) throw new Error('the quote response has no chart payload');
  if (chart.error) {
    throw new Error(
      `Yahoo rejected ${SP500_SYMBOL}: ${chart.error.description ?? chart.error.code ?? 'unknown error'}`,
    );
  }
  const meta = (Array.isArray(chart.result) ? chart.result[0] : undefined)?.meta as
    | { regularMarketPrice?: unknown; chartPreviousClose?: unknown; previousClose?: unknown }
    | undefined;
  if (!meta) throw new Error('the quote response has no result meta');
  const price = meta.regularMarketPrice;
  const previousClose = isPositive(meta.chartPreviousClose)
    ? meta.chartPreviousClose
    : meta.previousClose;
  if (!isPositive(price)) throw new Error('the quote response has no usable price');
  if (!isPositive(previousClose)) {
    throw new Error('the quote response has no previous close to measure the day against');
  }
  return { price, previousClose };
}

// ---------------------------------------------------------------------------
// Eastern wall-clock arithmetic
// ---------------------------------------------------------------------------

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
  weekday: 'short',
});

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface EtWall {
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** An instant as New York's wall clock reads it — Intl owns the DST rules. */
function etWall(ms: number): EtWall {
  const parts: Record<string, string> = {};
  for (const p of ET_PARTS.formatToParts(ms)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAY[parts.weekday ?? ''] ?? -1,
  };
}

function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

/**
 * A wall-clock moment as one comparable integer. Comparing Eastern WALL TIMES
 * rather than instants needs no offset arithmetic at all, and wall time only
 * runs backwards during the 1–2 AM hour of the November change — nowhere near
 * the 5:00 PM this is compared against.
 */
function wallKey(year: number, month: number, day: number, minuteOfDay: number): number {
  return ((year * 100 + month) * 100 + day) * 10_000 + minuteOfDay;
}

/** The calendar date of the most recent 4:00 PM weekday close at or before `now`. */
function lastCloseDate(now: EtWall): { year: number; month: number; day: number } {
  if (isWeekday(now.weekday) && now.minuteOfDay >= CLOSE_MINUTE) {
    return { year: now.year, month: now.month, day: now.day };
  }
  for (let back = 1; back <= 7; back++) {
    // Calendar arithmetic only: the weekday of a DATE is the same in any zone.
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day - back));
    if (isWeekday(d.getUTCDay())) {
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    }
  }
  /* c8 ignore next — any seven consecutive days hold five weekdays */
  return { year: now.year, month: now.month, day: now.day };
}

export type IndexRefreshReason =
  | 'no-value'
  | 'clock-skew'
  | 'recent'
  | 'market-open'
  | 'capture-close'
  | 'close-final';

/** Should an activation refetch? The reason is for tests and for the tooltip. */
export function indexRefreshDecision(
  nowMs: number,
  cached: { fetchedAt: string } | null,
): { refresh: boolean; reason: IndexRefreshReason } {
  if (cached === null) return { refresh: true, reason: 'no-value' };
  const fetchedMs = Date.parse(cached.fetchedAt);
  if (!Number.isFinite(fetchedMs)) return { refresh: true, reason: 'no-value' };
  if (fetchedMs - nowMs > FUTURE_SKEW_MS) return { refresh: true, reason: 'clock-skew' };
  if (nowMs - fetchedMs < MIN_REFRESH_INTERVAL_MS) return { refresh: false, reason: 'recent' };

  const now = etWall(nowMs);
  if (isWeekday(now.weekday) && now.minuteOfDay >= OPEN_MINUTE && now.minuteOfDay < CLOSE_MINUTE) {
    return { refresh: true, reason: 'market-open' };
  }
  const close = lastCloseDate(now);
  const fetched = etWall(fetchedMs);
  const settled = wallKey(close.year, close.month, close.day, SETTLED_MINUTE);
  return wallKey(fetched.year, fetched.month, fetched.day, fetched.minuteOfDay) >= settled
    ? { refresh: false, reason: 'close-final' }
    : { refresh: true, reason: 'capture-close' };
}

// ---------------------------------------------------------------------------
// What the sidebar prints
// ---------------------------------------------------------------------------

const ET_STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/**
 * "Sep 11, 4:46 PM EDT" — EST or EDT as the date requires, never a generic
 * "ET". ICU 72+ puts a narrow no-break space before AM/PM; it is swapped for a
 * plain one so the text reads, copies and tests predictably.
 */
export function formatEtTimestamp(ms: number): string {
  return ET_STAMP.format(ms).replace(/[  ]/g, ' ');
}

export type IndexDirection = 'up' | 'down' | 'flat';

export function indexChange(q: { price: number; previousClose: number }): {
  change: number;
  percent: number;
  direction: IndexDirection;
} {
  const change = q.price - q.previousClose;
  const percent = (change / q.previousClose) * 100;
  // Direction from the ROUNDED move: a change too small to print as a cent
  // must not paint the line green or red while it reads "0.00".
  const cents = Math.round(change * 100);
  return { change, percent, direction: cents > 0 ? 'up' : cents < 0 ? 'down' : 'flat' };
}

const TWO_DP = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "7,656.98" — an index level, so no currency sign. */
export function formatIndexLevel(price: number): string {
  return TWO_DP.format(price);
}

/** "+65.28 (+0.86%)", "−100.00 (−1.32%)", or "0.00 (0.00%)". */
export function formatIndexChange(q: { price: number; previousClose: number }): string {
  const { change, percent, direction } = indexChange(q);
  const sign = direction === 'up' ? '+' : direction === 'down' ? '−' : '';
  return `${sign}${TWO_DP.format(Math.abs(change))} (${sign}${TWO_DP.format(Math.abs(percent))}%)`;
}
