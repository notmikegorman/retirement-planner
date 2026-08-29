/**
 * THE QUOTE PROXY'S CLIENT SIDE: a FetchLike that routes the store's Yahoo
 * chart URL through the deployed CORS proxy (workers/quote-proxy — the app's
 * only network step, Phase 6 of the browser port).
 *
 * The store is untouched on purpose. quotes.ts builds the exact Yahoo URL it
 * has always built and hands it to its injected FetchLike; THIS module maps
 * that URL onto the proxy's one-symbol contract (GET ?symbol=…) and lets the
 * proxy add the User-Agent Yahoo demands (a page cannot set that header —
 * it is browser-forbidden and silently dropped). The response body comes back
 * VERBATIM from Yahoo, so parseYahooChart and the USD-only rejection stay
 * client-side: a Yahoo shape change is an app fix, not a proxy redeploy.
 *
 * WHERE THE PROXY URL COMES FROM — two layers, both origin-local:
 *
 *  1. A RUNTIME OVERRIDE in localStorage (QUOTE_PROXY_STORAGE_KEY), so the
 *     deploy-then-point flow needs no rebuild: deploy the Worker, open the
 *     app, paste one line in the console (the README shows it), reload.
 *     localStorage is the right authority here because only the user (via
 *     devtools) or same-origin code can write it — a link someone hands the
 *     owner cannot plant a proxy, which matters because the proxy sees every
 *     symbol the portfolio holds. A URL query parameter was rejected for
 *     exactly that reason.
 *  2. The BUILD-TIME default (VITE_FPLAN_QUOTE_PROXY), for builds made after
 *     the proxy exists.
 *
 * Either source must parse as https:// (or http:// to localhost/127.0.0.1,
 * for dev and the offline test lane). Anything else is ignored with the
 * reason reported — a corrupted or hostile value must not silently receive
 * the symbol list.
 */
import type { FetchLike } from '../../store/quotes';

export const QUOTE_PROXY_STORAGE_KEY = 'fplan-quote-proxy';

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1)$/;

/** Is this a proxy URL the fetcher may send portfolio symbols to? */
function acceptableProxyUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOST_RE.test(url.hostname);
}

/**
 * Which proxy URL this session uses, from the two layers above — pure, so the
 * whole rule is testable. `rejected` names a value that was present but
 * unusable, for the boot log.
 */
export function resolveQuoteProxyUrl(opts: {
  stored: string | null;
  buildDefault: string | undefined;
}): { url: string | null; rejected: string | null } {
  if (opts.stored !== null && opts.stored !== '') {
    if (acceptableProxyUrl(opts.stored)) return { url: opts.stored, rejected: null };
    return {
      url:
        opts.buildDefault !== undefined && acceptableProxyUrl(opts.buildDefault)
          ? opts.buildDefault
          : null,
      rejected: opts.stored,
    };
  }
  if (opts.buildDefault !== undefined && opts.buildDefault !== '') {
    if (acceptableProxyUrl(opts.buildDefault)) return { url: opts.buildDefault, rejected: null };
    return { url: null, rejected: opts.buildDefault };
  }
  return { url: null, rejected: null };
}

/**
 * The FetchLike quotes.ts runs its refreshes through when a proxy is
 * configured. `init.signal` rides along so fetchYahooQuote's own 10s timeout
 * still aborts a hung proxy exactly as it aborts a hung Yahoo.
 */
export function createProxyQuoteFetcher(proxyUrl: string): FetchLike {
  return async (url, init) => {
    // The symbol is the Yahoo chart URL's last path segment
    // (…/v8/finance/chart/<symbol>?interval=…), already URI-encoded by the
    // store's builder; searchParams.set re-encodes the decoded form, so the
    // proxy receives exactly the symbol the store asked for.
    const symbol = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const target = new URL(proxyUrl);
    target.searchParams.set('symbol', symbol);
    // No headers on purpose: the browser forbids User-Agent anyway (the proxy
    // supplies it upstream), and a header-free GET stays a simple CORS
    // request — no preflight round-trip per symbol.
    return fetch(target.toString(), { signal: init.signal });
  };
}
