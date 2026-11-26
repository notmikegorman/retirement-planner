/**
 * THE DASHBOARD (src/ui/pages/DashboardPage.tsx) — its pure half
 * (dashboardLogic.ts), the shared once-a-day snapshot (dailySnapshot.ts),
 * and source pins for the promises the page makes: no daily move, no red,
 * no net-worth dollars.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetWorthSnapshot, Profile, Scenario } from '../../src/shared/types';

const takeNetWorthSnapshot = vi.fn();
vi.mock('../../src/ui/api', () => ({ api: { takeNetWorthSnapshot } }));

const {
  defaultHomeValue,
  ensureTodaysSnapshot,
  localDayKey,
  resetDailySnapshotForTests,
  snapshotTakenToday,
} = await import('../../src/ui/dailySnapshot');
const { marketWindows, monthlyFromYearly, nextHouse, readHistoryCache, retirementDates, spendFromSolve } =
  await import('../../src/ui/pages/dashboardLogic');

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const starter = JSON.parse(read('../../data-defaults/profile.starter.json')) as Profile;
const withAccounts: Profile = starter;
const noAccounts: Profile = { ...starter, accounts: [] };

function row(id: string, takenAt: string, extra: Partial<NetWorthSnapshot> = {}): NetWorthSnapshot {
  return { id, takenAt, total: 1, homeValue: 500_000, accounts: [], prices: {}, ...extra };
}

const score = (success: number, sustainableSpend?: number) => ({
  success,
  ...(sustainableSpend === undefined ? {} : { sustainableSpend }),
  mode: 'montecarlo' as const,
  paths: 1000,
  seed: 1,
  engineVersion: '1.0.0',
  scoredAt: '2026-11-20T12:00:00Z',
});

describe('the starter profile the gate tests lean on', () => {
  it('has accounts', () => {
    expect(withAccounts.accounts.length).toBeGreaterThan(0);
  });
});

describe('ensureTodaysSnapshot — one snapshot a day, two doors', () => {
  const now = new Date(2026, 10, 21, 9, 0);
  beforeEach(() => {
    resetDailySnapshotForTests();
    takeNetWorthSnapshot.mockReset();
  });

  it("takes today's snapshot with the last row's home value", async () => {
    takeNetWorthSnapshot.mockResolvedValue(row('new', now.toISOString()));
    const prior = [row('a', new Date(2026, 10, 20, 9).toISOString(), { homeValue: 812_000 })];
    const got = await ensureTodaysSnapshot({ snapshots: prior, profile: withAccounts, now });
    expect(got?.id).toBe('new');
    expect(takeNetWorthSnapshot).toHaveBeenCalledWith({ homeValue: 812_000 });
  });

  it('takes nothing when a row from today exists', async () => {
    const today = [row('a', new Date(2026, 10, 21, 7).toISOString())];
    expect(await ensureTodaysSnapshot({ snapshots: today, profile: withAccounts, now })).toBeNull();
    expect(takeNetWorthSnapshot).not.toHaveBeenCalled();
  });

  it('takes nothing behind the zero-start gate', async () => {
    expect(await ensureTodaysSnapshot({ snapshots: [], profile: noAccounts, now })).toBeNull();
    expect(takeNetWorthSnapshot).not.toHaveBeenCalled();
  });

  it('lets a second door JOIN the first one in flight, not post again', async () => {
    let resolve!: (s: NetWorthSnapshot) => void;
    takeNetWorthSnapshot.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = ensureTodaysSnapshot({ snapshots: [], profile: withAccounts, now });
    const second = ensureTodaysSnapshot({ snapshots: [], profile: withAccounts, now });
    resolve(row('only', now.toISOString()));
    expect((await first)?.id).toBe('only');
    expect((await second)?.id).toBe('only');
    expect(takeNetWorthSnapshot).toHaveBeenCalledTimes(1);
  });

  it('remembers a landed snapshot against a list read before it landed', async () => {
    takeNetWorthSnapshot.mockResolvedValue(row('x', now.toISOString()));
    await ensureTodaysSnapshot({ snapshots: [], profile: withAccounts, now });
    // The other door's stale list still has no row from today.
    expect(await ensureTodaysSnapshot({ snapshots: [], profile: withAccounts, now })).toBeNull();
    expect(takeNetWorthSnapshot).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failure — a failed POST is not a taken day', async () => {
    takeNetWorthSnapshot.mockRejectedValueOnce(new Error('offline'));
    await expect(
      ensureTodaysSnapshot({ snapshots: [], profile: withAccounts, now }),
    ).rejects.toThrow('offline');
    takeNetWorthSnapshot.mockResolvedValue(row('y', now.toISOString()));
    expect((await ensureTodaysSnapshot({ snapshots: [], profile: withAccounts, now }))?.id).toBe('y');
  });

  it('counts days by the local calendar', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-1-5');
    expect(snapshotTakenToday([row('a', new Date(2026, 10, 21, 0, 1).toISOString())], now)).toBe(true);
    expect(snapshotTakenToday([row('a', new Date(2026, 10, 20, 23, 59).toISOString())], now)).toBe(false);
  });

  it("defaults the home value to the profile's only for an empty ledger", () => {
    expect(defaultHomeValue([], { home: { ...starter.home, value: 640_000 } })).toBe(640_000);
  });
});

describe('the plan cards', () => {
  it('reads the solve with the scorer’s rules: a figure, none, or above the bracket', () => {
    expect(spendFromSolve(76_035.15625)).toEqual({ kind: 'value', yearly: 76_035.15625 });
    expect(spendFromSolve(undefined).kind).toBe('reason');
    expect(spendFromSolve(400_000)).toEqual({ kind: 'reason', text: 'More than $33,333 a month' });
  });

  it('states the spend monthly, in whole dollars, never rounding up', () => {
    expect(monthlyFromYearly(66_757.8125)).toBe(5_563);
    expect(monthlyFromYearly(72_000)).toBe(6_000);
  });

  it('names the retirement year — one date, or each when they differ', () => {
    const retire = (person: string, date: string) => ({ type: 'retire' as const, person, date });
    expect(retirementDates({ events: [retire('p1', '2027-06'), retire('p2', '2027-06')] })).toEqual({
      headline: '2027',
      detail: 'June 2027',
    });
    expect(retirementDates({ events: [retire('p2', '2029-01'), retire('p1', '2027-06')] })).toEqual({
      headline: '2027–2029',
      detail: 'June 2027 · January 2029',
    });
    expect(retirementDates({ events: [] })).toBeNull();
  });

  it('prices the next house and dates the purchase from the sale plus the rental months', () => {
    const h = { sellDate: '2028-03', rentMonths: 3, purchasePrice: 1_450_000 } as Scenario['housing'];
    expect(nextHouse({ housing: h })).toEqual({ headline: '$1,450,000', detail: 'Bought June 2028' });
    expect(nextHouse({ housing: { ...h!, purchasePrice: 'sale_proceeds' } })?.headline).toBe(
      'The sale’s proceeds',
    );
    expect(nextHouse({ housing: { ...h!, purchasePrice: 'none' } })).toBeNull();
    expect(nextHouse({ housing: undefined })).toBeNull();
  });
});

describe('the market card', () => {
  it('reads a good cache back and refuses anything else', () => {
    const good = { fetchedAt: '2026-11-20T22:00:00Z', closes: [['2026-11-20', 6910.39]] };
    expect(readHistoryCache(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      null,
      'not json',
      '{}',
      JSON.stringify({ fetchedAt: 'never', closes: good.closes }),
      JSON.stringify({ fetchedAt: good.fetchedAt, closes: [] }),
      JSON.stringify({ fetchedAt: good.fetchedAt, closes: [['2026-11-20', -1]] }),
      JSON.stringify({ fetchedAt: good.fetchedAt, closes: [[20261120, 5]] }),
    ]) {
      expect(readHistoryCache(bad)).toBeNull();
    }
  });

  it('leads with 12 months and zooms out to 3 and 5 years', () => {
    const w = marketWindows([
      ['2021-11-19', 4698],
      ['2023-11-20', 4547],
      ['2025-11-20', 6539],
      ['2026-11-20', 6910],
    ]);
    expect(w.headline?.from[0]).toBe('2025-11-20');
    expect(w.zoomOut.map((z) => [z.years, z.result?.from[0]])).toEqual([
      [3, '2023-11-20'],
      [5, '2021-11-19'],
    ]);
  });
});

describe('the page keeps its promises (source scan)', () => {
  const page = read('../../src/ui/pages/DashboardPage.tsx');
  const css = read('../../src/ui/styles.css');
  const dashCss = css.slice(css.indexOf('.dashGrid {'), css.indexOf("/* The app's 'you are here'"));

  it('shows no daily move — the market module has no formatter for one', () => {
    expect(page).not.toMatch(/previousClose|indexChange|formatIndexChange/);
  });

  it('never paints a loss red', () => {
    expect(dashCss).not.toContain('--bad');
  });

  it('scores with the Plan page’s own final run — same request, same number', () => {
    expect(page).toContain('scenario: scenarioForPlainRun(plan),');
    expect(page).toContain('...finalRunParams(profile.settings),');
    // Formatted exactly as the Plan page's verdict formats it.
    expect(page).toContain('formatPct(m.result.success, 1)');
    // After today's prices: the run is started only once the snapshot settled.
    const measure = page.slice(page.indexOf('function usePlanMeasure'));
    expect(measure.indexOf('ensureTodaysSnapshot')).toBeLessThan(measure.indexOf('api.startRun'));
  });

  it('lays out the owner’s cards: two large, three small, two inputs', () => {
    const order = [...page.matchAll(/size="(large|small)"\s+label=\{?[`"]([^`"]+)/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(order).toEqual([
      'large:S&P 500 · last 12 months',
      'large:Retirement plan',
      'small:S&P 500 · ${years} years',
      'small:The plan supports',
    ]);
    expect(page).toMatch(/size="input"\s+label="Retirement"/);
    expect(page).toMatch(/size="input"\s+label="Next house"/);
    // The spend is the scorer's own max-spend request, so today's solve is a cache hit.
    expect(page).toContain("scenario: { ...scenarioForPlainRun(plan), solver: { type: 'max_spend' } },");
    expect(page).toContain('{ years: 3, r: three }');
    expect(page).toContain('{ years: 5, r: five }');
  });

  it('re-arms its still-mounted flag on every mount (StrictMode remounts on the same refs)', () => {
    expect(page).toMatch(/useEffect\(\(\) => \{\s*alive\.current = true;\s*return \(\) => \{\s*alive\.current = false;/);
  });

  it('does not show the net worth in dollars', () => {
    expect(page).not.toMatch(/\.total\b/);
  });

  it('asks the proxy for the ten-year history of the index', () => {
    expect(page).toContain("target.searchParams.set('range', HISTORY_RANGE)");
    expect(page).toContain("target.searchParams.set('symbol', SP500_SYMBOL)");
  });

  it('is the root, and the sidebar no longer carries a ticker', () => {
    const app = read('../../src/ui/App.tsx');
    expect(app).not.toContain('MarketTicker');
    expect(app).toContain("{page === 'dashboard' && <DashboardPage {...props} />}");
  });
});
