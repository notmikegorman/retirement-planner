/**
 * The quote service's NODE FACE. Parsing, the USD-only rule, per-symbol
 * failure isolation and persistence moved whole to src/store/quotes.ts in
 * Phase 3 of the browser port (see that header for every WHY); this module
 * binds the persisting half to the real data folder and keeps the historical
 * export surface.
 */
import { stores } from './stores';

export {
  defaultRefreshSymbols,
  fetchYahooQuote,
  parseYahooChart,
  type FetchLike,
  type FetchedQuote,
  type RefreshDeps,
} from '../store/quotes';

/** See src/store/quotes.ts (refreshQuotes). */
export const refreshQuotes: typeof stores.quotes.refreshQuotes = stores.quotes.refreshQuotes;
