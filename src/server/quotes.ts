/**
 * The quote service's NODE FACE. Parsing, the USD-only rule, per-symbol
 * failure isolation and persistence moved whole to src/store/quotes.ts in
 * Phase 3 of the browser port (see that header for every WHY); this module
 * binds the persisting half to the real data folder and keeps the historical
 * export surface.
 *
 * ONE test seam of its own, off by default: FPLAN_QUOTE_FIXTURES_DIR. The
 * dual-stack gate (tests/browser/dualStack.test.ts) drives a REAL server
 * process through the REAL snapshot flow, and that flow refreshes quotes —
 * which must not reach Yahoo from a test, and must return the same bytes the
 * local stack's injected fetcher returns or the byte-diff gate would compare
 * two different worlds. With the variable set, the default fetcher reads
 * `<dir>/<SYMBOL>.json` (a stored Yahoo chart response) instead of the
 * network; a missing file fails that one symbol with a message naming it —
 * per-symbol failure is data, exactly as a network failure would be. Unset —
 * every ordinary launch — nothing here consults it and the store's real fetch
 * runs untouched. The file is read through the FileStore seam, keeping
 * fileStoreSeam.test.ts's "only the driver imports fs" scan airtight.
 */
import type { QuoteRefreshResult } from '../shared/types';
import type { FetchLike, RefreshDeps } from '../store/quotes';
import { createNodeFileStore } from './fileStore';
import { stores } from './stores';

export {
  defaultRefreshSymbols,
  fetchYahooQuote,
  parseYahooChart,
  type FetchLike,
  type FetchedQuote,
  type RefreshDeps,
} from '../store/quotes';

/** The chart URL's symbol, undone: .../chart/<SYMBOL>?interval=... */
function symbolOfChartUrl(url: string): string | null {
  const m = /\/chart\/([^?/]+)\?/.exec(url);
  return m === null ? null : decodeURIComponent(m[1]);
}

/** A fetcher answering from <dir>/<SYMBOL>.json through the storage seam. */
function fixtureFetch(dir: string): FetchLike {
  const files = createNodeFileStore(() => dir);
  return async (url) => {
    const symbol = symbolOfChartUrl(url);
    if (symbol === null) throw new Error(`quote fixture fetcher got a non-chart URL: ${url}`);
    const text = await files.readText(`${symbol}.json`); // absent -> that symbol fails, as data
    return { ok: true, status: 200, json: async () => JSON.parse(text) as unknown };
  };
}

/** The env-driven default deps: fixtures when asked, the real fetch otherwise. */
function envDeps(): RefreshDeps | undefined {
  const dir = process.env.FPLAN_QUOTE_FIXTURES_DIR;
  return dir ? { fetchImpl: fixtureFetch(dir) } : undefined;
}

/** See src/store/quotes.ts (refreshQuotes). */
export const refreshQuotes = (
  symbols: readonly string[],
  deps?: RefreshDeps,
): Promise<QuoteRefreshResult> => stores.quotes.refreshQuotes(symbols, deps ?? envDeps());
