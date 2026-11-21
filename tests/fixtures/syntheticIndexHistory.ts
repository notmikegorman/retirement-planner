/**
 * A Yahoo chart response with years of daily closes, built rather than
 * captured: a real ten-year ^GSPC response is ~260 KB, and every test that
 * needs one wants to choose the numbers anyway. The SHAPE is Yahoo's (the
 * captured one-day fixture beside this file is the reference) — timestamps at
 * the 9:30 AM Eastern bar open, closes under indicators.quote[0].close, the
 * live price in meta.regularMarketPrice/regularMarketTime.
 */

/** Every weekday from `from` to `to` inclusive ('YYYY-MM-DD'), oldest first. */
export function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The chart body. `close(date, i)` prices each day; the last day's close is
 * also the live price, stamped at 4:00 PM Eastern (21:00 UTC is safe in either
 * season: it is 4 or 5 PM in New York, the same calendar day).
 */
export function syntheticIndexChart(opts: {
  from: string;
  to: string;
  close: (date: string, index: number) => number | null;
}): unknown {
  const days = weekdays(opts.from, opts.to);
  const closes = days.map((d, i) => opts.close(d, i));
  const last = days[days.length - 1];
  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            symbol: '^GSPC',
            regularMarketPrice: closes[closes.length - 1],
            regularMarketTime: Date.parse(`${last}T21:00:00Z`) / 1000,
            range: '10y',
            dataGranularity: '1d',
          },
          // 14:30 UTC is 9:30 or 10:30 AM in New York — the same calendar day.
          timestamp: days.map((d) => Date.parse(`${d}T14:30:00Z`) / 1000),
          indicators: { quote: [{ close: closes }] },
        },
      ],
      error: null,
    },
  };
}
