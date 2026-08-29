/**
 * The quote service: the ONE place in the app that touches a market-data
 * network endpoint.
 *
 * Prices are INPUTS. The user presses Refresh, the fetched quotes land in
 * quotes.json, and everything else — runs, searches, the profile editor, a
 * net-worth snapshot — reads that file. A simulation that fetched its own
 * prices would make the run cache a lie (same inputs, different answer,
 * depending on the market's mood at fetch time), so runs never call anything
 * in this module; only the refresh flow and the snapshot flow do.
 *
 * Source: Yahoo Finance's public chart endpoint, which serves ETFs and mutual
 * funds alike and needs only a browser-ish User-Agent. The fetch is ONE small
 * function (`fetchYahooQuote`) on an injected fetch, so an alternate source
 * later means writing its sibling and switching the call site — not
 * refactoring the batch/persist machinery around it. Deliberately no second
 * source today: two sources need a precedence rule, and there is no question
 * yet that rule would answer.
 *
 * ENVIRONMENT-NEUTRAL since Phase 3 of the browser port: persistence goes
 * through the DataStore factory parameter, and the fetch was always injected.
 * (In the browser the production fetch will be the CORS proxy's — Phase 6;
 * nothing here changes for that beyond the URL builder its FetchLike wraps.)
 */
import type { Profile, QuoteRefreshOutcome, QuoteRefreshResult, StoredQuote } from '../shared/types';
import { holdingsSymbols } from '../shared/holdings';
import { ValidationError, type DataStore } from './dataStore';

/** Per-symbol network budget. Yahoo answers in ~100ms; 10s means "hung". */
const FETCH_TIMEOUT_MS = 10_000;

/** What one successful fetch parses down to (pre-storage shape). */
export interface FetchedQuote {
  symbol: string;
  price: number;
  currency: string;
  /** ISO of the exchange's regularMarketTime — the moment the price is FROM. */
  asOf: string;
}

/** The subset of fetch this module needs, injectable so tests never hit the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function yahooChartUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1d&range=1d`;
}

/**
 * Parse Yahoo's chart response down to the four fields the store keeps.
 * Throws a plain-English Error on anything malformed — the caller records it
 * as that symbol's failure, never the batch's.
 */
export function parseYahooChart(symbol: string, body: unknown): FetchedQuote {
  const chart = (body as { chart?: unknown })?.chart as
    | { result?: unknown; error?: { description?: string; code?: string } | null }
    | undefined;
  if (!chart) throw new Error(`Yahoo response for ${symbol} has no chart payload`);
  if (chart.error) {
    // Yahoo's own verdict (e.g. "No data found, symbol may be delisted") is
    // more actionable than anything we could synthesise around it.
    throw new Error(
      `Yahoo rejected ${symbol}: ${chart.error.description ?? chart.error.code ?? 'unknown error'}`,
    );
  }
  const meta = (Array.isArray(chart.result) ? chart.result[0] : undefined)?.meta as
    | { regularMarketPrice?: unknown; currency?: unknown; regularMarketTime?: unknown }
    | undefined;
  if (!meta) throw new Error(`Yahoo response for ${symbol} has no result meta`);
  const { regularMarketPrice: price, currency, regularMarketTime: time } = meta;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Yahoo response for ${symbol} has no usable regularMarketPrice`);
  }
  if (typeof currency !== 'string' || currency.length === 0) {
    throw new Error(`Yahoo response for ${symbol} names no currency`);
  }
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new Error(`Yahoo response for ${symbol} has no regularMarketTime`);
  }
  return { symbol, price, currency, asOf: new Date(time * 1000).toISOString() };
}

/**
 * Fetch one symbol's quote. The one function an alternate source would
 * replace. The User-Agent header is load-bearing: Yahoo's edge returns 429 to
 * clients that send none.
 */
export async function fetchYahooQuote(
  symbol: string,
  fetchImpl: FetchLike,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchedQuote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(yahooChartUrl(symbol), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Yahoo returned HTTP ${res.status} for ${symbol}`);
    return parseYahooChart(symbol, await res.json());
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Timed out fetching ${symbol} after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Injectable seams for tests; production uses the defaults. */
export interface RefreshDeps {
  fetchImpl?: FetchLike;
  /** The clock that stamps fetchedAt. */
  now?: () => Date;
}

export interface QuoteService {
  refreshQuotes(symbols: readonly string[], deps?: RefreshDeps): Promise<QuoteRefreshResult>;
}

export function createQuoteService(data: DataStore): QuoteService {
  return {
    /**
     * Refresh a batch of symbols into quotes.json.
     *
     * PER-SYMBOL FAILURE IS PER-SYMBOL DATA. One delisted ticker, one timeout
     * or one currency surprise must not take down the other nine quotes — the
     * user pressed one button for their whole portfolio, and the honest
     * answer is "eight stored, VXUS timed out", not a batch error that stored
     * nothing. A failed symbol's PREVIOUS stored quote survives untouched: a
     * stale price with an honest asOf label beats no price.
     *
     * NON-USD IS REJECTED, NOT CONVERTED. Every dollar in the model is USD;
     * storing a Toronto listing's CAD price would silently misprice the
     * account by the exchange rate. The rejection names the currency so the
     * fix (use the US listing) is obvious.
     */
    async refreshQuotes(
      symbols: readonly string[],
      deps: RefreshDeps = {},
    ): Promise<QuoteRefreshResult> {
      const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
      const now = deps.now ?? (() => new Date());
      const quotes = await data.loadQuotes();
      const results: QuoteRefreshOutcome[] = [];

      for (const symbol of symbols) {
        try {
          const fetched = await fetchYahooQuote(symbol, fetchImpl);
          if (fetched.currency !== 'USD') {
            throw new Error(
              `${symbol} quotes in ${fetched.currency} — the model is USD-only, so the quote was ` +
                'not stored. Use the US listing of the fund instead.',
            );
          }
          const quote: StoredQuote = {
            price: fetched.price,
            currency: fetched.currency,
            asOf: fetched.asOf,
            source: 'yahoo',
            fetchedAt: now().toISOString(),
          };
          quotes[symbol] = quote;
          results.push({ symbol, ok: true, quote });
        } catch (err) {
          results.push({ symbol, ok: false, error: (err as Error).message });
        }
      }

      await data.saveQuotes(quotes);
      return { quotes, results };
    },
  };
}

/**
 * The refresh flow's default batch: every symbol any account holds. An empty
 * answer is a 400 with the reason — a refresh that "succeeded" over nothing
 * would read as prices being current when none exist.
 */
export function defaultRefreshSymbols(profile: Profile): string[] {
  const symbols = holdingsSymbols(profile);
  if (symbols.length === 0) {
    throw new ValidationError(
      'No holdings to refresh: no account lists any symbols. Switch an account to holdings ' +
        'mode on the Profile tab first, or name symbols explicitly.',
    );
  }
  return symbols;
}
