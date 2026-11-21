/**
 * THE DASHBOARD'S MARKET-WINDOW RULES (src/shared/marketIndex.ts).
 *
 * Every instant below is written with its explicit UTC offset — -04:00 for
 * EDT, -05:00 for EST — so the tests pin the Eastern-time arithmetic rather
 * than whatever zone the machine running them happens to sit in. The cases
 * that matter most are the ones that would pass under the WRONG offset in one
 * season and fail in the other; each is marked.
 *
 * Calendar used: Friday 2026-09-11 (EDT), Thursday 2026-01-15 (EST).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as marketIndex from '../../src/shared/marketIndex';
import {
  HistoryTooShortError,
  formatCloseDate,
  formatEtTimestamp,
  formatSignedPct,
  indexRefreshDecision,
  parseIndexHistory,
  trailingReturn,
  type DailyClose,
} from '../../src/shared/marketIndex';
import { syntheticIndexChart } from '../fixtures/syntheticIndexHistory';

/**
 * Yahoo's real one-day ^GSPC response, captured through the deployed proxy on
 * 2026-09-11 — exactly what a proxy that predates the range parameter answers.
 */
const GSPC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/yahoo-chart-gspc.json', import.meta.url)), 'utf8'),
) as unknown;

const at = (iso: string): number => Date.parse(iso);
const fetchedAt = (iso: string) => ({ fetchedAt: new Date(at(iso)).toISOString() });
const decide = (nowIso: string, fetchedIso: string | null) =>
  indexRefreshDecision(at(nowIso), fetchedIso === null ? null : fetchedAt(fetchedIso));

const TEN_YEARS = { from: '2016-11-21', to: '2026-11-20' };

describe('parseIndexHistory', () => {
  it('reads every close, dated by New York calendar, oldest first', () => {
    const closes = parseIndexHistory(syntheticIndexChart({ ...TEN_YEARS, close: (_d, i) => 1000 + i }));
    expect(closes[0]).toEqual(['2016-11-21', 1000]);
    expect(closes[closes.length - 1][0]).toBe('2026-11-20');
    expect(closes.length).toBeGreaterThan(2500);
    for (let i = 1; i < closes.length; i++) expect(closes[i][0] > closes[i - 1][0]).toBe(true);
  });

  it('skips the holes Yahoo leaves as null closes', () => {
    const closes = parseIndexHistory(
      syntheticIndexChart({ ...TEN_YEARS, close: (d) => (d === '2026-11-19' ? null : 5000) }),
    );
    expect(closes.some(([d]) => d === '2026-11-19')).toBe(false);
    expect(closes.some(([d]) => d === '2026-11-18')).toBe(true);
  });

  it("lets the live price replace the day's bar, and append a day the bars have not reached", () => {
    const body = syntheticIndexChart({ ...TEN_YEARS, close: () => 5000 }) as {
      chart: { result: Array<{ meta: { regularMarketPrice: number; regularMarketTime: number } }> };
    };
    const meta = body.chart.result[0].meta;
    meta.regularMarketPrice = 5100;
    expect(parseIndexHistory(body).at(-1)).toEqual(['2026-11-20', 5100]);
    // Monday's session, before its bar exists.
    meta.regularMarketTime = Date.parse('2026-11-23T15:00:00Z') / 1000;
    expect(parseIndexHistory(body).slice(-2)).toEqual([
      ['2026-11-20', 5000],
      ['2026-11-23', 5100],
    ]);
  });

  it('dates in EASTERN time, not UTC — a winter evening stamp stays on its day', () => {
    // 9:30 PM EST on Nov 20 is already Nov 21 in UTC.
    const body = syntheticIndexChart({ ...TEN_YEARS, close: () => 5000 }) as {
      chart: { result: Array<{ meta: { regularMarketTime: number } }> };
    };
    body.chart.result[0].meta.regularMarketTime = Date.parse('2026-11-20T21:30:00-05:00') / 1000;
    expect(parseIndexHistory(body).at(-1)?.[0]).toBe('2026-11-20');
  });

  it('calls a one-day answer what it is — an old proxy — not a flat decade', () => {
    expect(() => parseIndexHistory(GSPC)).toThrow(HistoryTooShortError);
    expect(() => parseIndexHistory(GSPC)).toThrow(/redeploying/);
  });

  it("passes Yahoo's own verdict through, and refuses a non-chart", () => {
    const body = { chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } };
    expect(() => parseIndexHistory(body)).toThrow(/No data found/);
    expect(() => parseIndexHistory(null)).toThrow(/no chart payload/);
    expect(() => parseIndexHistory({ chart: { result: [], error: null } })).toThrow(/no result/);
  });
});

describe('trailingReturn — the zoomed-out windows', () => {
  // A month of closes that encodes its own date, so the window's ends are
  // readable straight off the answer.
  const closes: DailyClose[] = [
    ['2021-11-19', 4000],
    ['2021-11-22', 4100],
    ['2023-11-20', 4500],
    ['2025-11-20', 6500],
    ['2025-11-21', 6600],
    ['2026-11-13', 7560],
    ['2026-11-20', 6910],
  ];

  it('measures from the same calendar date a year back to the latest close', () => {
    const r = trailingReturn(closes, 1);
    expect(r?.from).toEqual(['2025-11-20', 6500]);
    expect(r?.to).toEqual(['2026-11-20', 6910]);
    expect(r?.change).toBeCloseTo(6910 / 6500 - 1, 12);
    expect(r?.annualized).toBeCloseTo(6910 / 6500 - 1, 12);
  });

  it('uses the last close ON OR BEFORE that date when it was not a trading day', () => {
    // 2021-11-20 was a Saturday: Friday's close starts the five-year window.
    expect(trailingReturn(closes, 5)?.from).toEqual(['2021-11-19', 4000]);
  });

  it('annualizes the longer windows', () => {
    const r = trailingReturn(closes, 3);
    expect(r?.from).toEqual(['2023-11-20', 4500]);
    expect(r?.annualized).toBeCloseTo(Math.pow(6910 / 4500, 1 / 3) - 1, 12);
  });

  it('answers null when the history does not reach back — never a shorter window', () => {
    expect(trailingReturn(closes, 10)).toBeNull();
    expect(trailingReturn([], 1)).toBeNull();
  });

  it('lands Feb 29 on Feb 28 a year later', () => {
    const leap: DailyClose[] = [
      ['2027-02-26', 100],
      ['2028-02-28', 105],
      ['2028-02-29', 110],
    ];
    expect(trailingReturn(leap, 1)?.from).toEqual(['2027-02-26', 100]);
    const back: DailyClose[] = [
      ['2027-02-28', 100],
      ['2027-03-01', 999],
      ['2028-02-29', 110],
    ];
    expect(trailingReturn(back, 1)?.from).toEqual(['2027-02-28', 100]);
  });
});

describe('formatting', () => {
  it('signs a percentage with one decimal and a typographic minus', () => {
    expect(formatSignedPct(0.0568)).toBe('+5.7%');
    expect(formatSignedPct(-0.0861)).toBe('−8.6%');
    expect(formatSignedPct(0.5196)).toBe('+52.0%');
    expect(formatSignedPct(0.00004)).toBe('0.0%');
    expect(formatSignedPct(-0.00004)).toBe('0.0%');
  });

  it('prints a close date without shifting it a day in any zone', () => {
    expect(formatCloseDate('2025-11-20')).toBe('Nov 20, 2025');
    expect(formatCloseDate('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('has no daily-change formatter at all — the page shows no daily move', () => {
    expect(Object.keys(marketIndex)).not.toContain('formatIndexChange');
    expect(Object.keys(marketIndex)).not.toContain('indexChange');
  });
});

describe('indexRefreshDecision — when an activation fetches', () => {
  it('fetches when there is nothing on hand, or what is on hand is unreadable', () => {
    expect(decide('2026-09-11T20:00:00-04:00', null)).toEqual({ refresh: true, reason: 'no-value' });
    expect(indexRefreshDecision(at('2026-09-11T20:00:00-04:00'), { fetchedAt: 'garbage' })).toEqual({
      refresh: true,
      reason: 'no-value',
    });
  });

  it('never refetches a value under an hour old — open or closed', () => {
    expect(decide('2026-09-11T11:00:00-04:00', '2026-09-11T10:30:00-04:00').reason).toBe('recent');
    expect(decide('2026-09-11T16:10:00-04:00', '2026-09-11T15:45:00-04:00').reason).toBe('recent');
  });

  it('fetches during the session once the value is an hour old', () => {
    expect(decide('2026-09-11T11:00:00-04:00', '2026-09-11T09:59:00-04:00')).toEqual({
      refresh: true,
      reason: 'market-open',
    });
  });

  it('opens at 9:30 exactly and closes at 4:00 exactly', () => {
    const yesterdayEvening = '2026-09-10T18:00:00-04:00';
    expect(decide('2026-09-11T09:29:00-04:00', yesterdayEvening).reason).toBe('close-final');
    expect(decide('2026-09-11T09:30:00-04:00', yesterdayEvening).reason).toBe('market-open');
    expect(decide('2026-09-11T15:59:00-04:00', '2026-09-11T14:00:00-04:00').reason).toBe('market-open');
    expect(decide('2026-09-11T16:00:00-04:00', '2026-09-11T14:30:00-04:00').reason).toBe('capture-close');
  });

  it('after the close, fetches once more to capture the settled close — then stops', () => {
    // Fetched at 3 PM: the closing value is not on hand, so one more fetch.
    expect(decide('2026-09-11T17:30:00-04:00', '2026-09-11T15:00:00-04:00').reason).toBe('capture-close');
    // Fetched at 4:40 PM: after the bell but before it settles — once more.
    expect(decide('2026-09-11T18:00:00-04:00', '2026-09-11T16:40:00-04:00').reason).toBe('capture-close');
    // Fetched at or after 5 PM: that is the close, and nothing moves it tonight.
    expect(decide('2026-09-11T20:00:00-04:00', '2026-09-11T17:05:00-04:00')).toEqual({
      refresh: false,
      reason: 'close-final',
    });
    expect(decide('2026-09-11T19:30:00-04:00', '2026-09-11T18:00:00-04:00').reason).toBe('close-final');
  });

  it("carries Friday's close through the weekend", () => {
    expect(decide('2026-09-12T11:00:00-04:00', '2026-09-11T17:30:00-04:00').reason).toBe('close-final');
    expect(decide('2026-09-13T23:00:00-04:00', '2026-09-11T17:30:00-04:00').reason).toBe('close-final');
    // A Friday-lunchtime value is not the close, so Saturday fetches it once.
    expect(decide('2026-09-12T11:00:00-04:00', '2026-09-11T14:00:00-04:00').reason).toBe('capture-close');
  });

  it("holds Friday's close through Monday's pre-market, then fetches at the open", () => {
    expect(decide('2026-09-14T08:00:00-04:00', '2026-09-11T18:00:00-04:00').reason).toBe('close-final');
    expect(decide('2026-09-14T08:00:00-04:00', '2026-09-11T12:00:00-04:00').reason).toBe('capture-close');
    expect(decide('2026-09-14T09:30:00-04:00', '2026-09-11T18:00:00-04:00').reason).toBe('market-open');
  });

  it('uses STANDARD time in winter — cases a wrong offset would get backwards', () => {
    // 9:15 AM EST is pre-market. Read as EDT it would be 10:15 and "open".
    expect(decide('2026-01-15T09:15:00-05:00', '2026-01-14T18:00:00-05:00').reason).toBe('close-final');
    // 3:59 PM EST is still open. Read as EDT it would be 4:59 and "closed".
    expect(decide('2026-01-15T15:59:00-05:00', '2026-01-15T14:00:00-05:00').reason).toBe('market-open');
  });

  it('refetches when the stored time is in the future — the device clock moved', () => {
    expect(decide('2026-09-11T11:00:00-04:00', '2026-09-11T12:00:00-04:00')).toEqual({
      refresh: true,
      reason: 'clock-skew',
    });
  });
});

describe('formatEtTimestamp — EST or EDT, as the date requires', () => {
  it('says EDT in summer and EST in winter', () => {
    expect(formatEtTimestamp(at('2026-09-11T16:46:20-04:00'))).toBe('Sep 11, 4:46 PM EDT');
    expect(formatEtTimestamp(at('2026-01-15T16:05:00-05:00'))).toBe('Jan 15, 4:05 PM EST');
  });

  it('switches across the March change (2026-03-08)', () => {
    expect(formatEtTimestamp(at('2026-03-07T12:00:00-05:00'))).toBe('Mar 7, 12:00 PM EST');
    expect(formatEtTimestamp(at('2026-03-09T12:00:00-04:00'))).toBe('Mar 9, 12:00 PM EDT');
  });

  it('prints the moment in Eastern time whatever zone it was captured in', () => {
    // 20:46 UTC is 4:46 PM in New York on a September day.
    expect(formatEtTimestamp(at('2026-09-11T20:46:20Z'))).toBe('Sep 11, 4:46 PM EDT');
  });

  it('uses plain spaces, not the narrow no-break space newer ICU emits', () => {
    expect(formatEtTimestamp(at('2026-09-11T16:46:20-04:00'))).not.toMatch(/[  ]/);
  });
});
