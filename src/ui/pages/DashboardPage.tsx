/**
 * THE DASHBOARD — the page the app opens on (the owner's ask, 2026-11-21).
 *
 * Its job is perspective. A 3% Friday, read off a daily ticker, is a five-
 * or six-figure loss in a week; the same Friday, read off twelve months, is
 * a smaller gain than it was on Thursday. So the page answers two questions
 * and only at the zoomed-out scale:
 *
 *  1. HOW HAS THE MARKET DONE? The S&P 500 over the last 12 months, with 3
 *     and 5 years beside it. The index stands in for the portfolio: the
 *     household keeps investing every month, so its own balance mixes
 *     market moves with contributions, and the app holds no share counts to
 *     separate them. No daily or weekly move appears anywhere on this page,
 *     by design — and a down year reads in the text colour, never red.
 *
 *  2. IS THE PLAN STILL ON TRACK? The newest recorded score. Arriving takes
 *     today's net-worth snapshot if none exists yet (../dailySnapshot.ts, the
 *     same once-a-day rule the Net worth page keeps), which refreshes every
 *     holding's price and re-scores the plan against them. The net worth
 *     itself is not shown: it is a dollar figure that moves with the news,
 *     which is the very thing this page exists to step back from.
 *
 * WHEN THE MARKET HISTORY FETCHES: on mount and whenever the app is
 * ACTIVATED while this page is up — the window regains focus, the tab
 * becomes visible, or a page restores from the back-forward cache — subject
 * to indexRefreshDecision (shared/marketIndex.ts): never a value under an
 * hour old, and after the close only the fetch that captures the settled
 * close. Through the same quote proxy Refresh prices uses, asked for one
 * symbol, ^GSPC, with range=10y; with no proxy configured the market card
 * renders nothing and makes no request (the offline lanes stay offline).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HISTORY_RANGE,
  HistoryTooShortError,
  SP500_SYMBOL,
  formatCloseDate,
  formatEtTimestamp,
  formatSignedPct,
  indexRefreshDecision,
  parseIndexHistory,
  type IndexHistory,
  type TrailingReturn,
} from '../../shared/marketIndex';
import type { NetWorthSnapshot, Profile } from '../../shared/types';
import { formatUSD } from '../../shared/util';
import { api } from '../api';
import { ensureTodaysSnapshot } from '../dailySnapshot';
import { DASHBOARD_FIRST_RUN, simulationReadiness } from '../firstRun';
import type { PageProps } from '../nav';
import { ModuleBanner } from '../modules/ModuleBanner';
import { QUOTE_PROXY_STORAGE_KEY, resolveQuoteProxyUrl } from '../local/proxyQuoteFetcher';
import {
  HISTORY_CACHE_KEY,
  latestScored,
  marketWindows,
  readHistoryCache,
  scoreStatus,
} from './dashboardLogic';
import { formatSnapshotDate } from './netWorthChart';
import { formatScorePct } from './netWorthScoreChart';

const FETCH_TIMEOUT_MS = 15_000;
const SCORING_POLL_MS = 2500;

function readCache(): IndexHistory | null {
  try {
    return readHistoryCache(localStorage.getItem(HISTORY_CACHE_KEY));
  } catch {
    return null;
  }
}

function writeCache(h: IndexHistory): void {
  try {
    localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(h));
  } catch {
    // Storage disabled or full: the numbers still show; they refetch next visit.
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

/** The S&P 500's history: cached, refreshed on activation by the hour/close rule. */
function useIndexHistory(proxyUrl: string | null): {
  history: IndexHistory | null;
  error: string | null;
} {
  const [history, setHistory] = useState<IndexHistory | null>(readCache);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const maybeRefresh = useCallback(async () => {
    if (proxyUrl === null || inFlight.current) return;
    // A hidden window is not an activation; visibilitychange will call again.
    if (document.visibilityState === 'hidden') return;
    // Re-read rather than trusting state: another window may have fetched.
    const cached = readCache();
    if (!indexRefreshDecision(Date.now(), cached).refresh) {
      setHistory(cached);
      return;
    }
    inFlight.current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const target = new URL(proxyUrl);
      target.searchParams.set('symbol', SP500_SYMBOL);
      target.searchParams.set('range', HISTORY_RANGE);
      const res = await fetch(target.toString(), { signal: controller.signal });
      const next: IndexHistory = {
        closes: parseIndexHistory(await res.json()),
        fetchedAt: new Date().toISOString(),
      };
      writeCache(next);
      setHistory(next);
      setError(null);
    } catch (e) {
      setError(
        e instanceof HistoryTooShortError
          ? 'The quote proxy needs redeploying before it can serve market history.'
          : 'Not refreshed — the market data could not be reached.',
      );
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

  return { history, error };
}

function ZoomOut({ years, result }: { years: number; result: TrailingReturn | null }) {
  return (
    <div className="dashZoom">
      <div className="dashZoomLabel">{years} years</div>
      {result === null ? (
        <div className="dashZoomValue muted">—</div>
      ) : (
        <>
          <div className={`dashZoomValue ${result.change >= 0 ? 'up' : ''}`}>
            {formatSignedPct(result.change)}
          </div>
          <div className="dashZoomRate">{formatSignedPct(result.annualized)} a year</div>
        </>
      )}
    </div>
  );
}

function MarketCard({ proxyUrl }: { proxyUrl: string }) {
  const { history, error } = useIndexHistory(proxyUrl);
  const windows = history === null ? null : marketWindows(history.closes);
  const headline = windows?.headline ?? null;
  return (
    <section className="card dashCard" aria-label="The market, zoomed out">
      <div className="dashLabel">S&amp;P 500 · last 12 months</div>
      {headline === null ? (
        <div className="dashHeadline muted">{error ?? 'Loading…'}</div>
      ) : (
        <>
          <div className={`dashHeadline ${headline.change >= 0 ? 'up' : ''}`}>
            {headline.change >= 0 ? 'Up ' : 'Down '}
            {formatSignedPct(Math.abs(headline.change)).replace('+', '')}
          </div>
          <div className="dashSub">
            {formatCloseDate(headline.from[0])} → {formatCloseDate(headline.to[0])}
          </div>
          <div className="dashZoomRow">
            {windows?.zoomOut.map((z) => <ZoomOut key={z.years} {...z} />)}
          </div>
          <div className="dashStamp">
            As of {formatEtTimestamp(Date.parse(history!.fetchedAt))}
            {error === null ? '' : ` · ${error}`}
          </div>
        </>
      )}
    </section>
  );
}

function PlanCard() {
  const [snapshots, setSnapshots] = useState<NetWorthSnapshot[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scoring, setScoring] = useState<string[]>([]);
  const tried = useRef(false);

  const load = useCallback(async () => {
    try {
      const [list, prof] = await Promise.all([api.getNetWorth(), api.getProfile()]);
      setSnapshots(list);
      setProfile(prof);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const poll = useCallback(async () => {
    let ids: string[];
    try {
      ids = (await api.getNetWorthScoring()).scoring;
    } catch {
      return;
    }
    setScoring(ids);
    // Reload while running too: the probability lands before the spend solve.
    await load();
  }, [load]);

  useEffect(() => {
    void load();
    void poll();
  }, [load, poll]);

  const idle = scoring.length === 0;
  useEffect(() => {
    if (idle) return undefined;
    const timer = setInterval(() => void poll(), SCORING_POLL_MS);
    return () => clearInterval(timer);
  }, [idle, poll]);

  // Today's snapshot, behind the scenes — once per mount.
  useEffect(() => {
    if (tried.current || snapshots === null || profile === null) return;
    tried.current = true;
    setRefreshing(true);
    void (async () => {
      try {
        const snapshot = await ensureTodaysSnapshot({ snapshots, profile });
        if (snapshot !== null) {
          setSnapshots((prev) =>
            (prev ?? []).some((s) => s.id === snapshot.id) ? prev : [...(prev ?? []), snapshot],
          );
          setScoring((prev) => [...prev.filter((x) => x !== snapshot.id), snapshot.id]);
        }
      } catch (e) {
        setSnapshotError(e instanceof Error ? e.message : String(e));
      } finally {
        setRefreshing(false);
      }
    })();
  }, [snapshots, profile]);

  const gated = profile !== null && simulationReadiness(profile).state === 'no-accounts';
  const scored = snapshots === null ? null : latestScored(snapshots);
  const status =
    snapshots === null
      ? null
      : scoreStatus({ snapshots, scoring, refreshing, formatDate: formatSnapshotDate });

  return (
    <section className="card dashCard" aria-label="The retirement plan">
      <div className="dashLabel">Retirement plan</div>
      {loadError !== null ? (
        <div className="error-banner">{loadError}</div>
      ) : snapshots === null || profile === null ? (
        <div className="dashHeadline muted">Loading…</div>
      ) : gated ? (
        <div className="dashSub">{DASHBOARD_FIRST_RUN}</div>
      ) : scored === null ? (
        <div className="dashHeadline muted">{status ?? 'Not scored yet'}</div>
      ) : (
        <>
          <div className="dashHeadline">{formatScorePct(scored.score.success * 100)}</div>
          <div className="dashSub">chance the money lasts</div>
          {scored.score.sustainableSpend === undefined ? null : (
            <div className="dashSpend">
              Supports up to <strong>{formatUSD(scored.score.sustainableSpend)}</strong> a year
            </div>
          )}
          {status === null ? null : <div className="dashStamp">{status}</div>}
        </>
      )}
      {snapshotError === null ? null : (
        <div className="error-banner">Today&rsquo;s refresh failed: {snapshotError}</div>
      )}
    </section>
  );
}

export function DashboardPage(_props: PageProps) {
  const [proxyUrl] = useState(proxyUrlForSession);
  return (
    <>
      <ModuleBanner title="Dashboard" />
      <div className="moduleBody">
        <div className="dashGrid">
          {proxyUrl === null ? null : <MarketCard proxyUrl={proxyUrl} />}
          <PlanCard />
        </div>
      </div>
    </>
  );
}
