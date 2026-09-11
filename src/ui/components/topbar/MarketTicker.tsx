/**
 * THE S&P 500 TICKER — under Widow's Playbook, behind a separator.
 *
 * WHEN IT FETCHES: on launch, and whenever the app is ACTIVATED — the window
 * regains focus, the tab becomes visible, or a page restores from the
 * back-forward cache — subject to indexRefreshDecision (shared/marketIndex.ts),
 * which skips values under an hour old and, after the close, anything but the
 * one fetch that captures the settled close.
 *
 * WHY THREE EVENTS, AND WHY THAT COVERS THE INSTALLED APP. An installed PWA
 * runs in its own window with no tab strip, so "clicking on the tab" is
 * switching to that window. Switching between apps fires `focus` on the
 * window; minimising and restoring, or changing macOS Spaces, fires
 * `visibilitychange`; a browser tab restored from the back-forward cache fires
 * `pageshow` without remounting React. Any one of them can fire alone, and
 * they often fire together — the in-flight guard and the one-hour rule make
 * the duplicates free. It does NOT poll while the window sits focused: the ask
 * was an update on activation, and a timer would spend the proxy's quota on a
 * number nobody is looking away from.
 *
 * WHERE THE NUMBER COMES FROM: the same quote proxy the Accounts refresh uses,
 * asked for one symbol, ^GSPC. The proxy sees that symbol and nothing about
 * the household. With no proxy configured — a local dev build, the offline
 * test lanes — the ticker renders NOTHING, separator included, and makes no
 * request, rather than showing a box that can never fill.
 *
 * WHAT IT REMEMBERS: the last good value, in localStorage under `fplan-sp500`.
 * Market data, not household data, so it is per browser rather than per folder
 * and Show a friend mode has nothing to hide in it. A failed fetch keeps the
 * last value and its timestamp on screen and says it was not refreshed; the
 * next activation tries again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SP500_SYMBOL,
  formatEtTimestamp,
  formatIndexChange,
  formatIndexLevel,
  indexChange,
  indexRefreshDecision,
  parseIndexChart,
  type IndexQuote,
} from '../../../shared/marketIndex';
// Pure and tiny (its only import is a type): the same proxy-URL rule the local
// backend uses, so the ticker and Refresh prices can never disagree about
// where quotes come from.
import { QUOTE_PROXY_STORAGE_KEY, resolveQuoteProxyUrl } from '../../local/proxyQuoteFetcher';

const CACHE_KEY = 'fplan-sp500';
const FETCH_TIMEOUT_MS = 10_000;

const TICKER_TIP =
  'Refreshes when you come back to the app — at most once an hour, and after the close only ' +
  'until the closing value is in.';

function readCached(): IndexQuote | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const o = JSON.parse(raw) as Partial<IndexQuote>;
    if (
      typeof o.price !== 'number' ||
      !(o.price > 0) ||
      typeof o.previousClose !== 'number' ||
      !(o.previousClose > 0) ||
      typeof o.fetchedAt !== 'string' ||
      Number.isNaN(Date.parse(o.fetchedAt))
    ) {
      return null;
    }
    return { price: o.price, previousClose: o.previousClose, fetchedAt: o.fetchedAt };
  } catch {
    return null;
  }
}

function writeCached(q: IndexQuote): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(q));
  } catch {
    // Storage disabled: the value still shows; it just refetches next launch.
  }
}

function proxyUrlForSession(): string | null {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(QUOTE_PROXY_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return resolveQuoteProxyUrl({
    stored,
    buildDefault: import.meta.env?.VITE_FPLAN_QUOTE_PROXY as string | undefined,
  }).url;
}

export function MarketTicker() {
  const [proxyUrl] = useState(proxyUrlForSession);
  const [quote, setQuote] = useState<IndexQuote | null>(readCached);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  const maybeRefresh = useCallback(async () => {
    if (proxyUrl === null || inFlight.current) return;
    // A hidden window is not an activation; visibilitychange will call again.
    if (document.visibilityState === 'hidden') return;
    // Re-read rather than trusting state: another window of the app may have
    // fetched since this one last looked.
    const cached = readCached();
    if (!indexRefreshDecision(Date.now(), cached).refresh) {
      setQuote(cached);
      return;
    }
    inFlight.current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const target = new URL(proxyUrl);
      target.searchParams.set('symbol', SP500_SYMBOL);
      const res = await fetch(target.toString(), { signal: controller.signal });
      const next: IndexQuote = {
        ...parseIndexChart(await res.json()),
        fetchedAt: new Date().toISOString(),
      };
      writeCached(next);
      setQuote(next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
    }
  }, [proxyUrl]);

  useEffect(() => {
    if (proxyUrl === null) return undefined;
    void maybeRefresh();
    const onActivate = () => void maybeRefresh();
    window.addEventListener('focus', onActivate);
    window.addEventListener('pageshow', onActivate);
    document.addEventListener('visibilitychange', onActivate);
    return () => {
      window.removeEventListener('focus', onActivate);
      window.removeEventListener('pageshow', onActivate);
      document.removeEventListener('visibilitychange', onActivate);
    };
  }, [proxyUrl, maybeRefresh]);

  if (proxyUrl === null) return null;

  return (
    <>
      <div className="sideNavSep" aria-hidden="true" />
      <div className="marketTicker" role="group" aria-label="S&P 500" title={TICKER_TIP}>
        <div className="marketTickerLabel">S&amp;P 500</div>
        {quote === null ? (
          <div className="marketTickerTime">{failed ? 'Unavailable right now' : 'Loading…'}</div>
        ) : (
          <>
            <div className="marketTickerLine">
              <span className="marketTickerPrice">{formatIndexLevel(quote.price)}</span>
              <span className={`marketTickerChange ${indexChange(quote).direction}`}>
                {formatIndexChange(quote)}
              </span>
            </div>
            <div className="marketTickerTime">
              {formatEtTimestamp(Date.parse(quote.fetchedAt))}
              {failed ? ' · not refreshed' : ''}
            </div>
          </>
        )}
      </div>
    </>
  );
}
