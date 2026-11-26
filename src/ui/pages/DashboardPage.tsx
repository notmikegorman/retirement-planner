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
 *  2. IS THE PLAN STILL ON TRACK? The Plan page's OWN final-quality run —
 *     the same request (scoreRunRequest's shape: the plan as written, Monte
 *     Carlo, the final path count, the profile's seed), so the same runKey,
 *     the same cache entry and the same number, always (the owner's
 *     2026-11-21 report: 92.8% here against 96.5% there, because this card
 *     read a ledger row scored by a stale bundle). Arriving first takes
 *     today's net-worth snapshot if none exists (../dailySnapshot.ts, the
 *     once-a-day rule the Net worth page keeps), which refreshes every
 *     holding's price; its scorer then runs exactly this request, and the
 *     run manager dedupes the two. What the plan SUPPORTS a month is the same
 *     trick for the snapshot scorer's second run: the max-spend solve, asked
 *     with spendRunRequest's exact shape, so a solve the scorer already made
 *     today is a cache hit and one it has not is computed here (2026-11-26:
 *     matching ledger rows by plan hash missed whenever plan.json had been
 *     re-saved since the snapshot, and the card read "Not solved"). The
 *     net worth itself is not shown: it is a dollar figure that moves with
 *     the news, which is the very thing this page exists to step back from.
 *
 * THE CARDS (the owner's layout, 2026-11-21, plus 2026-11-26's inputs row):
 * the 12-month move and the plan score large across the top; 3 years, 5 years
 * and the monthly spend the plan supports in the middle; and the plan's two
 * key inputs — when it retires, and the next house — along the bottom.
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
import {
  type NetWorthSnapshot,
  type Profile,
  type RunResult,
  type Scenario,
} from '../../shared/types';
import { formatPct, formatUSD } from '../../shared/util';
import { api, pollRun } from '../api';
import { scenarioForPlainRun } from '../components/results/resultsData';
import { finalRunParams } from '../components/workbench/workbenchLogic';
import { ensureTodaysSnapshot } from '../dailySnapshot';
import { DASHBOARD_FIRST_RUN, simulationReadiness } from '../firstRun';
import type { PageProps } from '../nav';
import { ModuleBanner } from '../modules/ModuleBanner';
import { QUOTE_PROXY_STORAGE_KEY, resolveQuoteProxyUrl } from '../local/proxyQuoteFetcher';
import {
  HISTORY_CACHE_KEY,
  marketWindows,
  monthlyFromYearly,
  nextHouse,
  readHistoryCache,
  retirementDates,
  spendFromSolve,
  type SpendAnswer,
} from './dashboardLogic';

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

/** One card: a small caps label, the big number, and what qualifies it. */
function Card(props: {
  size: 'large' | 'small' | 'input';
  label: string;
  ariaLabel: string;
  value: string | null;
  tone?: 'up' | null;
  sub?: string | null;
  stamp?: string | null;
  muted?: string | null;
}) {
  const { size, label, ariaLabel, value, tone, sub, stamp, muted } = props;
  return (
    <section className={`card dashCard ${size}`} aria-label={ariaLabel}>
      <div className="dashLabel">{label}</div>
      <div className="dashBody">
        {value === null ? (
          <div className="dashMuted">{muted ?? 'Loading…'}</div>
        ) : (
          <>
            <div className={`dashValue${tone === 'up' ? ' up' : ''}`}>{value}</div>
            {sub ? <div className="dashSub">{sub}</div> : null}
          </>
        )}
      </div>
      {stamp ? <div className="dashStamp">{stamp}</div> : null}
    </section>
  );
}

/** A trailing window as a card's value: "+52.0%", or null when unreachable. */
function windowValue(r: TrailingReturn | null): string | null {
  return r === null ? null : formatSignedPct(r.change);
}

function windowRange(r: TrailingReturn | null): string | null {
  return r === null ? null : `${formatCloseDate(r.from[0])} → ${formatCloseDate(r.to[0])}`;
}

/** Everything the plan cards need, loaded and measured once per visit. */
function usePlanMeasure(): {
  gated: boolean;
  loadError: string | null;
  result: RunResult | null;
  progress: number | null;
  runError: string | null;
  refreshError: string | null;
  spend: SpendAnswer | null;
  spendProgress: number | null;
  plan: Scenario | null;
} {
  const [snapshots, setSnapshots] = useState<NetWorthSnapshot[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<Scenario | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [scoring, setScoring] = useState<string[]>([]);
  const [spend, setSpend] = useState<SpendAnswer | null>(null);
  const [spendProgress, setSpendProgress] = useState<number | null>(null);
  const started = useRef(false);
  const alive = useRef(true);
  // Set on EVERY mount, not only at creation: StrictMode's dev double-mount
  // runs this cleanup and then the effect again on the same refs, and a flag
  // only ever cleared would drop every answer after it.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadLedger = useCallback(async () => {
    try {
      setSnapshots(await api.getNetWorth());
    } catch {
      // The spend card degrades; the score does not depend on the ledger.
    }
  }, []);

  const poll = useCallback(async () => {
    let ids: string[];
    try {
      ids = (await api.getNetWorthScoring()).scoring;
    } catch {
      return;
    }
    if (!alive.current) return;
    setScoring(ids);
    await loadLedger();
  }, [loadLedger]);

  useEffect(() => {
    void (async () => {
      try {
        const [list, prof, pl] = await Promise.all([
          api.getNetWorth(),
          api.getProfile(),
          api.getPlan(),
        ]);
        if (!alive.current) return;
        setSnapshots(list);
        setProfile(prof);
        setPlan(pl);
      } catch (e) {
        if (alive.current) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    void poll();
  }, [poll]);

  const idle = scoring.length === 0;
  useEffect(() => {
    if (idle) return undefined;
    const timer = setInterval(() => void poll(), SCORING_POLL_MS);
    return () => clearInterval(timer);
  }, [idle, poll]);

  const gated = profile !== null && simulationReadiness(profile).state === 'no-accounts';

  useEffect(() => {
    if (started.current || snapshots === null || profile === null || plan === null || gated) {
      return;
    }
    started.current = true;
    void (async () => {
      // Today's prices first: the snapshot refreshes every holding's quote,
      // and the run below must see them or it measures yesterday.
      try {
        const snapshot = await ensureTodaysSnapshot({ snapshots, profile });
        if (snapshot !== null && alive.current) {
          setSnapshots((prev) =>
            (prev ?? []).some((s) => s.id === snapshot.id) ? prev : [...(prev ?? []), snapshot],
          );
          setScoring((prev) => [...prev.filter((x) => x !== snapshot.id), snapshot.id]);
        }
      } catch (e) {
        if (alive.current) setRefreshError(e instanceof Error ? e.message : String(e));
      }
      // The Plan page's final run. A cache hit answers at once; a run the
      // snapshot scorer already started is the SAME runKey, which the run
      // manager joins rather than repeats.
      try {
        const { runId } = await api.startRun({
          scenario: scenarioForPlainRun(plan),
          ...finalRunParams(profile.settings),
        });
        const done = await pollRun(
          runId,
          (p) => {
            if (alive.current) setProgress(p.progress);
          },
          500,
        );
        if (!alive.current) return;
        if (done.status !== 'done' || !done.result) throw new Error(done.error ?? 'Run failed');
        setResult(done.result);
      } catch (e) {
        if (alive.current) setRunError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setProgress(null);
      }
      // What the plan supports: the snapshot scorer's max-spend solve, the
      // same request (scoreRunner.spendRunRequest), so the same cache entry.
      try {
        const { runId } = await api.startRun({
          scenario: { ...scenarioForPlainRun(plan), solver: { type: 'max_spend' } },
          ...finalRunParams(profile.settings),
        });
        const done = await pollRun(
          runId,
          (p) => {
            if (alive.current) setSpendProgress(p.progress);
          },
          500,
        );
        if (!alive.current) return;
        if (done.status !== 'done' || !done.result) throw new Error(done.error ?? 'Solve failed');
        setSpend(spendFromSolve(done.result.solverOutput?.answer));
      } catch (e) {
        if (alive.current) {
          setSpend({ kind: 'reason', text: `Could not solve: ${e instanceof Error ? e.message : String(e)}` });
        }
      } finally {
        if (alive.current) setSpendProgress(null);
      }
    })();
  }, [snapshots, profile, plan, gated]);

  return { gated, loadError, result, progress, runError, refreshError, spend, spendProgress, plan };
}

export function DashboardPage(_props: PageProps) {
  const [proxyUrl] = useState(proxyUrlForSession);
  const { history, error: marketError } = useIndexHistory(proxyUrl);
  const m = usePlanMeasure();

  const windows = history === null ? null : marketWindows(history.closes);
  const year = windows?.headline ?? null;
  const [three, five] = windows?.zoomOut.map((z) => z.result) ?? [null, null];
  const marketMuted =
    proxyUrl === null ? 'No market data source is configured.' : (marketError ?? 'Loading…');
  const asOf =
    history === null
      ? null
      : `As of ${formatEtTimestamp(Date.parse(history.fetchedAt))}` +
        (marketError === null ? '' : ` · ${marketError}`);

  const retire = m.plan === null ? null : retirementDates(m.plan);
  const house = m.plan === null ? null : nextHouse(m.plan);

  const planMuted = m.loadError
    ? m.loadError
    : m.gated
      ? DASHBOARD_FIRST_RUN
      : m.runError
        ? `Could not score the plan: ${m.runError}`
        : m.progress !== null
          ? `Scoring… ${Math.round(m.progress * 100)}%`
          : 'Loading…';

  return (
    <>
      <ModuleBanner title="Dashboard" />
      <div className="moduleBody">
        <div className="dashGrid">
          <Card
            size="large"
            label="S&P 500 · last 12 months"
            ariaLabel="The market, last 12 months"
            value={
              year === null
                ? null
                : `${year.change >= 0 ? 'Up' : 'Down'} ${formatSignedPct(Math.abs(year.change)).replace('+', '')}`
            }
            tone={year !== null && year.change >= 0 ? 'up' : null}
            sub={windowRange(year)}
            stamp={asOf}
            muted={marketMuted}
          />
          <Card
            size="large"
            label="Retirement plan"
            ariaLabel="The retirement plan"
            value={m.result === null || m.gated ? null : formatPct(m.result.success, 1)}
            sub="chance the money lasts"
            stamp={
              m.result === null
                ? null
                : `${m.result.meta.paths.toLocaleString('en-US')} simulated futures, today’s prices` +
                  (m.refreshError === null ? '' : ` · prices not refreshed: ${m.refreshError}`)
            }
            muted={planMuted}
          />
          {[
            { years: 3, r: three },
            { years: 5, r: five },
          ].map(({ years, r }) => (
            <Card
              key={years}
              size="small"
              label={`S&P 500 · ${years} years`}
              ariaLabel={`The market, last ${years} years`}
              value={windowValue(r)}
              tone={r !== null && r.change >= 0 ? 'up' : null}
              sub={r === null ? null : `${formatSignedPct(r.annualized)} a year`}
              stamp={windowRange(r)}
              muted={history === null ? marketMuted : 'Not enough history'}
            />
          ))}
          <Card
            size="small"
            label="The plan supports"
            ariaLabel="What the plan supports"
            value={
              m.gated || m.spend?.kind !== 'value'
                ? null
                : `${formatUSD(monthlyFromYearly(m.spend.yearly))} / mo`
            }
            sub={m.spend?.kind === 'value' ? `${formatUSD(m.spend.yearly)} a year` : null}
            stamp={m.spend?.kind === 'value' ? 'At the plan’s success target, today’s prices' : null}
            muted={
              m.gated
                ? DASHBOARD_FIRST_RUN
                : m.spend?.kind === 'reason'
                  ? m.spend.text
                  : m.spendProgress !== null
                    ? `Solving… ${Math.round(m.spendProgress * 100)}%`
                    : 'Waiting for the score…'
            }
          />
          <Card
            size="input"
            label="Retirement"
            ariaLabel="When the plan retires"
            value={retire === null ? null : retire.headline}
            sub={retire?.detail ?? null}
            muted={m.plan === null ? 'Loading…' : 'No retirement date in the plan'}
          />
          <Card
            size="input"
            label="Next house"
            ariaLabel="The next house"
            value={house === null ? null : house.headline}
            sub={house?.detail ?? null}
            muted={m.plan === null ? 'Loading…' : 'No home purchase in the plan'}
          />
        </div>
      </div>
    </>
  );
}
