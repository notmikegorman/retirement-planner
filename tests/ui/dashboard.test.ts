/**
 * THE DASHBOARD (src/ui/pages/DashboardPage.tsx) — its pure half
 * (dashboardLogic.ts), the shared once-a-day snapshot (dailySnapshot.ts),
 * and source pins for the promises the page makes: no daily move, no red,
 * no net-worth dollars.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetWorthSnapshot, Profile } from '../../src/shared/types';

const takeNetWorthSnapshot = vi.fn();
vi.mock('../../src/ui/api', () => ({ api: { takeNetWorthSnapshot } }));

const {
  defaultHomeValue,
  ensureTodaysSnapshot,
  localDayKey,
  resetDailySnapshotForTests,
  snapshotTakenToday,
} = await import('../../src/ui/dailySnapshot');
const { latestScored, marketWindows, readHistoryCache, scoreStatus } = await import(
  '../../src/ui/pages/dashboardLogic'
);

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

describe('the plan card', () => {
  const fmt = (iso: string) => iso.slice(0, 10);

  it('shows the NEWEST scored row, skipping one still scoring', () => {
    const list = [
      row('a', '2026-11-19T12:00:00Z', { score: score(0.98, 88_000) }),
      row('b', '2026-11-20T12:00:00Z', { score: score(0.99, 90_000) }),
      row('c', '2026-11-21T12:00:00Z'),
    ];
    expect(latestScored(list)?.id).toBe('b');
    expect(latestScored([row('z', '2026-11-21T12:00:00Z')])).toBeNull();
  });

  it("says which day's prices the score used, or that today's are being scored", () => {
    const list = [
      row('b', '2026-11-20T12:00:00Z', { score: score(0.99) }),
      row('c', '2026-11-21T12:00:00Z'),
    ];
    expect(scoreStatus({ snapshots: list, scoring: [], refreshing: true, formatDate: fmt })).toBe(
      'Refreshing prices…',
    );
    expect(scoreStatus({ snapshots: list, scoring: ['c'], refreshing: false, formatDate: fmt })).toBe(
      'Re-scoring with today’s prices…',
    );
    const scored = [row('c', '2026-11-21T12:00:00Z', { score: score(0.99) })];
    expect(scoreStatus({ snapshots: scored, scoring: ['c'], refreshing: false, formatDate: fmt })).toBe(
      'Solving what the plan supports…',
    );
    expect(scoreStatus({ snapshots: list, scoring: [], refreshing: false, formatDate: fmt })).toBe(
      'Scored 2026-11-20, with that day’s prices',
    );
    expect(scoreStatus({ snapshots: [], scoring: [], refreshing: false, formatDate: fmt })).toBeNull();
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
