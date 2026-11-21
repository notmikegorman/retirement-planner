/**
 * THE DASHBOARD'S MARKET WINDOW — its rules, with no browser in them.
 *
 * The Dashboard shows the S&P 500 the way the owner asked to see it: ZOOMED
 * OUT. Not the day's move, not the week's — what the index has done over the
 * last 12 months, with 3 and 5 years beside it. A 3% Friday is real, and it is
 * also a rounding error on a year; the page exists to show the year. So this
 * module computes trailing windows from daily closes and deliberately has no
 * function that reports a daily change (the sidebar ticker that showed one
 * was removed with the Dashboard's arrival, 2026-11-21).
 *
 * The index stands in for the portfolio. The household keeps investing every
 * month, so its own balance change mixes market moves with contributions; the
 * index's change is the market's half alone, which is the half that moves
 * with the news.
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

/**
 * The range the Dashboard asks the proxy for. Ten years, though the longest
 * window is five: a five-year window needs the close from five years BEFORE
 * the latest one, and a "5y" response starts a day or two after that.
 */
export const HISTORY_RANGE = '10y';

/** One trading day's close, dated by New York's calendar. */
export type DailyClose = [date: string, close: number];

/** What the Dashboard keeps between visits — market data, nothing household. */
export interface IndexHistory {
  /** Oldest first; the last entry is the latest price (live during a session). */
  closes: DailyClose[];
  /** ISO — when the APP fetched it; drives the refresh rule and the "as of". */
  fetchedAt: string;
}

function isPositive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/**
 * Below this many closes the response cannot be the ten-year history it was
 * asked for. That is what a quote proxy deployed before the range parameter
 * existed answers (it ignores `range` and relays one day), and it must read
 * as "the proxy needs updating", never as a 0% year.
 */
export const MIN_HISTORY_CLOSES = 5 * 250;

export class HistoryTooShortError extends Error {
  constructor(count: number) {
    super(
      `the quote proxy returned ${count} daily close${count === 1 ? '' : 's'}, not ten years — ` +
        'it predates the history range and needs redeploying',
    );
    this.name = 'HistoryTooShortError';
  }
}

/**
 * Yahoo's chart JSON down to dated closes. Null closes (Yahoo leaves a hole on
 * the odd half-day) are skipped. The latest price replaces the day's bar when
 * it is fresher — mid-session the bar's close and the live price agree, but
 * nothing guarantees it.
 */
export function parseIndexHistory(body: unknown): DailyClose[] {
  const chart = (body as { chart?: unknown } | null)?.chart as
    | { result?: unknown; error?: { description?: string; code?: string } | null }
    | undefined;
  if (!chart) throw new Error('the quote response has no chart payload');
  if (chart.error) {
    throw new Error(
      `Yahoo rejected ${SP500_SYMBOL}: ${chart.error.description ?? chart.error.code ?? 'unknown error'}`,
    );
  }
  const result = (Array.isArray(chart.result) ? chart.result[0] : undefined) as
    | {
        meta?: { regularMarketPrice?: unknown; regularMarketTime?: unknown };
        timestamp?: unknown;
        indicators?: { quote?: Array<{ close?: unknown }> };
      }
    | undefined;
  if (!result) throw new Error('the quote response has no result');
  const stamps = Array.isArray(result.timestamp) ? (result.timestamp as unknown[]) : [];
  const rawCloses = result.indicators?.quote?.[0]?.close;
  const closes = Array.isArray(rawCloses) ? (rawCloses as unknown[]) : [];
  const out: DailyClose[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const t = stamps[i];
    const c = closes[i];
    if (typeof t !== 'number' || !isPositive(c)) continue;
    const date = etDate(t * 1000);
    // Yahoo can repeat the live day; keep the later figure.
    if (out.length > 0 && out[out.length - 1][0] === date) out[out.length - 1] = [date, c];
    else out.push([date, c]);
  }
  const price = result.meta?.regularMarketPrice;
  const time = result.meta?.regularMarketTime;
  if (isPositive(price) && typeof time === 'number') {
    const date = etDate(time * 1000);
    const last = out[out.length - 1];
    if (last === undefined || last[0] < date) out.push([date, price]);
    else if (last[0] === date) out[out.length - 1] = [date, price];
  }
  if (out.length < MIN_HISTORY_CLOSES) throw new HistoryTooShortError(out.length);
  return out;
}

/** A trailing window's answer: where it started, where it ended, and the move. */
export interface TrailingReturn {
  years: number;
  from: DailyClose;
  to: DailyClose;
  /** Total change over the window, as a fraction (0.057 = +5.7%). */
  change: number;
  /** The same change as a compound yearly rate. */
  annualized: number;
}

/** 'YYYY-MM-DD' minus whole years, with Feb 29 landing on Feb 28. */
function yearsBefore(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y - years, m - 1, d));
  // Feb 29 → Mar 1 in a common year; step back to the 28th instead.
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/**
 * The change from the last close ON OR BEFORE the same calendar date `years`
 * ago to the latest close. Null when the history does not reach back that far
 * — a window measured from a later start would be a different window under
 * the same label.
 */
export function trailingReturn(closes: readonly DailyClose[], years: number): TrailingReturn | null {
  const to = closes[closes.length - 1];
  if (to === undefined) return null;
  const target = yearsBefore(to[0], years);
  let from: DailyClose | undefined;
  // Binary search for the last close dated <= target.
  let lo = 0;
  let hi = closes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid][0] <= target) {
      from = closes[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (from === undefined) return null;
  const change = to[1] / from[1] - 1;
  return { years, from, to, change, annualized: Math.pow(1 + change, 1 / years) - 1 };
}

/** The Dashboard's windows: the headline first, then the zoom-outs. */
export const WINDOW_YEARS = [1, 3, 5] as const;

const ONE_DP = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "+5.7%", "−3.2%", "0.0%" — a typographic minus, and no sign on a flat zero. */
export function formatSignedPct(fraction: number): string {
  const text = ONE_DP.format(Math.abs(fraction) * 100);
  if (text === '0.0') return '0.0%';
  return `${fraction > 0 ? '+' : '−'}${text}%`;
}

/** "Nov 20, 2025" from a 'YYYY-MM-DD' — a calendar date, so no zone shift. */
export function formatCloseDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

/** An instant's New York calendar date, 'YYYY-MM-DD'. */
function etDate(ms: number): string {
  const w = etWall(ms);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
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

/** Should an activation refetch? The reason is for tests. */
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
// The "as of" stamp
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
