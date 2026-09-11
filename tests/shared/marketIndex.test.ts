/**
 * THE S&P 500 TICKER'S RULES (src/shared/marketIndex.ts).
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
import {
  formatEtTimestamp,
  formatIndexChange,
  formatIndexLevel,
  indexChange,
  indexRefreshDecision,
  parseIndexChart,
} from '../../src/shared/marketIndex';

/** Yahoo's real ^GSPC response, captured through the deployed proxy on 2026-09-11. */
const GSPC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/yahoo-chart-gspc.json', import.meta.url)), 'utf8'),
) as unknown;

const at = (iso: string): number => Date.parse(iso);
const fetchedAt = (iso: string) => ({ fetchedAt: new Date(at(iso)).toISOString() });
const decide = (nowIso: string, fetchedIso: string | null) =>
  indexRefreshDecision(at(nowIso), fetchedIso === null ? null : fetchedAt(fetchedIso));

describe('parseIndexChart', () => {
  it('reads the level and the previous close from a real response', () => {
    expect(parseIndexChart(GSPC)).toEqual({ price: 7656.98, previousClose: 7591.7 });
  });

  it('falls back to previousClose when chartPreviousClose is absent', () => {
    const body = {
      chart: { result: [{ meta: { regularMarketPrice: 7600, previousClose: 7500 } }], error: null },
    };
    expect(parseIndexChart(body)).toEqual({ price: 7600, previousClose: 7500 });
  });

  it("passes Yahoo's own verdict through", () => {
    const body = { chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } };
    expect(() => parseIndexChart(body)).toThrow(/No data found/);
  });

  it('refuses a response with no previous close — the green or red would be a guess', () => {
    const body = { chart: { result: [{ meta: { regularMarketPrice: 7600 } }], error: null } };
    expect(() => parseIndexChart(body)).toThrow(/previous close/);
  });

  it('refuses a price that is missing, zero or not a number', () => {
    for (const price of [undefined, 0, -1, Number.NaN, '7600']) {
      const body = {
        chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: 7500 } }], error: null },
      };
      expect(() => parseIndexChart(body)).toThrow(/usable price/);
    }
  });

  it('refuses something that is not a chart response at all', () => {
    expect(() => parseIndexChart(null)).toThrow(/no chart payload/);
    expect(() => parseIndexChart({ chart: { result: [], error: null } })).toThrow(/no result meta/);
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

describe('the change line', () => {
  it('is signed, two-decimal, with the percentage in parentheses', () => {
    expect(formatIndexChange({ price: 7656.98, previousClose: 7591.7 })).toBe('+65.28 (+0.86%)');
    expect(indexChange({ price: 7656.98, previousClose: 7591.7 }).direction).toBe('up');
    expect(formatIndexChange({ price: 7500, previousClose: 7600 })).toBe('−100.00 (−1.32%)');
    expect(indexChange({ price: 7500, previousClose: 7600 }).direction).toBe('down');
  });

  it('calls a move too small to print a cent flat, not green or red', () => {
    expect(indexChange({ price: 7600.004, previousClose: 7600 }).direction).toBe('flat');
    expect(formatIndexChange({ price: 7600.004, previousClose: 7600 })).toBe('0.00 (0.00%)');
    // The negative-zero case: -0.004 rounds to -0 cents, which is not "down".
    expect(indexChange({ price: 7599.996, previousClose: 7600 }).direction).toBe('flat');
    expect(formatIndexChange({ price: 7599.996, previousClose: 7600 })).toBe('0.00 (0.00%)');
  });

  it('groups thousands in both the level and a large move', () => {
    expect(formatIndexLevel(7656.98)).toBe('7,656.98');
    expect(formatIndexLevel(7600)).toBe('7,600.00');
    expect(formatIndexChange({ price: 8834.5, previousClose: 7600 })).toBe('+1,234.50 (+16.24%)');
  });
});
