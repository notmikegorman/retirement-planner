/**
 * The quote service (src/server/quotes.ts): parsing, USD-only enforcement,
 * per-symbol failure isolation, and persistence into quotes.json.
 *
 * NO LIVE NETWORK. Every fetch is injected; the Yahoo response shape comes
 * from tests/fixtures/yahoo-chart-vti.json — a REAL response captured
 * 2026-08-18 (VTI, $379.04, USD) — so the parser is tested against what the
 * endpoint actually returns, not against a hand-typed imitation of it.
 *
 * Each test points FPLAN_DATA_DIR at a fresh temp dir; the user's real data
 * folder is never read or touched.
 */
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadQuotes } from '../../src/server/dataStore';
import {
  fetchYahooQuote,
  parseYahooChart,
  refreshQuotes,
  type FetchLike,
} from '../../src/server/quotes';

const fixturePath = fileURLToPath(new URL('../fixtures/yahoo-chart-vti.json', import.meta.url));
const vtiFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-quotes-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A FetchLike that answers every URL with the given JSON body. */
function fetchReturning(body: unknown, status = 200): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

/** Clone the fixture with a mutator applied to chart.result[0].meta. */
function fixtureWithMeta(mutate: (meta: Record<string, unknown>) => void): unknown {
  const clone = structuredClone(vtiFixture) as {
    chart: { result: Array<{ meta: Record<string, unknown> }> };
  };
  mutate(clone.chart.result[0].meta);
  return clone;
}

describe('parseYahooChart', () => {
  it('reads price, currency and time from the real captured response', () => {
    const q = parseYahooChart('VTI', vtiFixture);
    expect(q.price).toBe(379.04);
    expect(q.currency).toBe('USD');
    // regularMarketTime 1787083200 is seconds; asOf must be its ISO form.
    expect(q.asOf).toBe(new Date(1787083200 * 1000).toISOString());
  });

  it("surfaces Yahoo's own error description for a bad symbol", () => {
    const body = {
      chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
    };
    expect(() => parseYahooChart('NOPE', body)).toThrow(/symbol may be delisted/);
  });

  it('refuses responses missing the fields the store needs, naming the symbol', () => {
    expect(() => parseYahooChart('VTI', {})).toThrow(/VTI/);
    expect(() =>
      parseYahooChart('VTI', fixtureWithMeta((m) => delete m.regularMarketPrice)),
    ).toThrow(/regularMarketPrice/);
    expect(() =>
      parseYahooChart('VTI', fixtureWithMeta((m) => (m.regularMarketPrice = 0))),
    ).toThrow(/regularMarketPrice/);
    expect(() => parseYahooChart('VTI', fixtureWithMeta((m) => delete m.currency))).toThrow(
      /currency/,
    );
    expect(() =>
      parseYahooChart('VTI', fixtureWithMeta((m) => delete m.regularMarketTime)),
    ).toThrow(/regularMarketTime/);
  });
});

describe('fetchYahooQuote', () => {
  it('sends the load-bearing User-Agent and parses through', async () => {
    let seenUrl = '';
    let seenUa: string | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenUa = (init.headers as Record<string, string>)['User-Agent'];
      return { ok: true, status: 200, json: async () => vtiFixture };
    };
    const q = await fetchYahooQuote('VTI', fetchImpl);
    expect(q.price).toBe(379.04);
    expect(seenUrl).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/VTI?interval=1d&range=1d',
    );
    // Yahoo's edge 429s clients that send no User-Agent — the header is not
    // decoration, and losing it in a refactor must fail a test.
    expect(seenUa).toBe('Mozilla/5.0');
  });

  it('reports an HTTP failure with its status', async () => {
    await expect(fetchYahooQuote('VTI', fetchReturning({}, 429))).rejects.toThrow(/HTTP 429/);
  });

  it('turns the abort of a hung request into a plain-English timeout', async () => {
    const never: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    await expect(fetchYahooQuote('VTI', never, 10)).rejects.toThrow(/Timed out fetching VTI/);
  });
});

describe('refreshQuotes', () => {
  it('stores a USD quote with asOf from the exchange and fetchedAt from the clock', async () => {
    const now = () => new Date('2026-08-18T21:30:00.000Z');
    const res = await refreshQuotes(['VTI'], { fetchImpl: fetchReturning(vtiFixture), now });
    expect(res.results).toEqual([
      {
        symbol: 'VTI',
        ok: true,
        quote: {
          price: 379.04,
          currency: 'USD',
          asOf: new Date(1787083200 * 1000).toISOString(),
          source: 'yahoo',
          fetchedAt: '2026-08-18T21:30:00.000Z',
        },
      },
    ]);
    // Persisted: a fresh load from disk sees exactly what the result carried.
    expect(await loadQuotes()).toEqual(res.quotes);
  });

  it('rejects a non-USD quote per symbol, naming the currency, and stores nothing for it', async () => {
    const cad = fixtureWithMeta((m) => (m.currency = 'CAD'));
    const res = await refreshQuotes(['VTI'], { fetchImpl: fetchReturning(cad) });
    expect(res.results[0].ok).toBe(false);
    const failure = res.results[0] as { error: string };
    expect(failure.error).toContain('CAD');
    expect(failure.error).toContain('USD-only');
    expect(await loadQuotes()).toEqual({});
  });

  it('isolates one symbol’s failure: the batch survives and the rest are stored', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/GHOST?')) throw new Error('connection reset');
      return { ok: true, status: 200, json: async () => vtiFixture };
    };
    const res = await refreshQuotes(['VTI', 'GHOST', 'BND'], { fetchImpl });
    expect(res.results.map((r) => r.ok)).toEqual([true, false, true]);
    const stored = await loadQuotes();
    expect(Object.keys(stored).sort()).toEqual(['BND', 'VTI']);
  });

  it('a failed refresh leaves the symbol’s PREVIOUS quote untouched', async () => {
    // First refresh lands a price; the second fails; the stale-but-honest
    // stored quote must survive — its asOf still tells the truth about it.
    await refreshQuotes(['VTI'], { fetchImpl: fetchReturning(vtiFixture) });
    const res = await refreshQuotes(['VTI'], { fetchImpl: fetchReturning({}, 500) });
    expect(res.results[0].ok).toBe(false);
    expect((await loadQuotes()).VTI.price).toBe(379.04);
  });
});
