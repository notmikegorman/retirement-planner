/**
 * THE QUOTE PROXY, END TO END IN THE BROWSER LANE (Phase 6): the REAL app in
 * local mode, the REAL proxy handler module mounted on a local port
 * (quoteProxyAdapter.ts — the same bytes wrangler deploys), a fixture Yahoo
 * upstream — and a real Refresh-prices click flowing through all of it. No
 * Cloudflare account, no network: the lane stays offline because the
 * handler's upstream base is an env parameter, which is exactly the seam the
 * unit tests use.
 *
 * The pointing mechanism under test is the REAL one, not an injection: the
 * page boots with the localStorage override (fplan-quote-proxy) set to the
 * adapter's origin — the same deploy-then-point flow the README documents,
 * exercised end to end.
 *
 * Failure legs, per the store's own rule (per-symbol failure is DATA):
 *  - a symbol the upstream rejects (Yahoo's 404 + chart.error shape) lands as
 *    that one symbol's error, never a thrown refresh;
 *  - a DOWN upstream (server gone) turns into the proxy's 502, which lands
 *    the same way — and the previously stored quote survives untouched, with
 *    its honest fetchedAt.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import type { QuoteRefreshResult, QuotesFile } from '../../src/shared/types';
import { syntheticIndexChart } from '../fixtures/syntheticIndexHistory';
import { VTI_FIXTURE_TEXT, driveSeedFiles } from './driveFixtures';
import { mountQuoteProxy, type MountedProxy } from './quoteProxyAdapter';
import { serveStatic, type StaticServer } from './staticServer';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const distUi = path.join(repoRoot, 'dist', 'ui');

/**
 * Ten years of ^GSPC closes, stepped so each window's answer is a round
 * number: 12 months 6000 → 6600 (+10.0%), 3 years 5000 → (+32.0%), 5 years
 * 4000 → (+65.0%).
 */
const GSPC_HISTORY_TEXT = JSON.stringify(
  syntheticIndexChart({
    from: '2016-11-21',
    to: '2026-11-20',
    close: (d) =>
      d < '2021-12-01' ? 4000 : d < '2023-12-01' ? 5000 : d < '2025-12-01' ? 6000 : 6600,
  }),
);

/** The seeded quote's fetchedAt — what a successful refresh must move. */
const SEEDED_FETCHED_AT = '2026-08-28T12:00:00.000Z';

type ApiWindow = Window & {
  __fplanApi: {
    getQuotes(): Promise<QuotesFile>;
    refreshQuotes(symbols?: string[]): Promise<QuoteRefreshResult>;
  };
};

describe('quote proxy e2e: local mode, real handler, fixture upstream', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let staticServer: StaticServer;
  let upstream: Server;
  let proxy: MountedProxy;
  const pageErrors: string[] = [];
  /** Upstream requests for ^GSPC — the Dashboard's history, and only its. */
  let gspcHits = 0;
  /** The range each of those asked for. */
  const gspcRanges: string[] = [];

  beforeAll(async () => {
    await build({ configFile: path.join(repoRoot, 'vite.config.ts'), logLevel: 'warn' });
    browser = await chromium.launch();
    staticServer = await serveStatic(distUi, { spaFallback: true });

    // The Yahoo double: the captured VTI fixture, and Yahoo's own
    // unknown-symbol shape (HTTP 404 + chart.error) for anything else.
    upstream = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/v8/finance/chart/%5EGSPC')) {
        gspcHits += 1;
        gspcRanges.push(new URL(req.url ?? '', 'http://x').searchParams.get('range') ?? '');
        res.writeHead(200, { 'content-type': 'application/json' }).end(GSPC_HISTORY_TEXT);
        return;
      }
      if ((req.url ?? '').startsWith('/v8/finance/chart/VTI')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(VTI_FIXTURE_TEXT);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          chart: {
            result: null,
            error: { code: 'Not Found', description: 'No data found, symbol may be delisted' },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const addr = upstream.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    proxy = await mountQuoteProxy({ UPSTREAM_BASE: `http://127.0.0.1:${addr.port}` });

    context = await browser.newContext();
    // Offline discipline: the page may reach its own origin and the proxy —
    // nothing else. (The proxy reaches the fixture upstream from NODE, so no
    // browser route exists for it at all.)
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`${staticServer.origin}/`) || url.startsWith(`${proxy.origin}/`)) {
        return route.continue();
      }
      pageErrors.push(`blocked off-origin request: ${url}`);
      return route.abort();
    });
    // The REAL pointing mechanism: the localStorage override, set the way the
    // README's deploy-then-point step sets it (before the app boots). The
    // storage choice rides along as a returning user's remembered answer, so
    // Phase 7's boot gate doesn't stop this leg at the first-visit chooser.
    await context.addInitScript((proxyUrl: string) => {
      localStorage.setItem('fplan-quote-proxy', proxyUrl);
      localStorage.setItem('fplan-storage', 'opfs');
      // Friend mode defaults ON; this lane is a real-data session.
      localStorage.setItem('fplan-friend-mode', 'off');
    }, proxy.origin);

    page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // Seed OPFS from a same-origin blank page, then boot the app in local mode.
    await page.goto(`${staticServer.origin}/__seed.html`);
    await page.evaluate(async (files: Record<string, string>) => {
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry('fplan-data', { recursive: true }).catch(() => undefined);
      const root = await opfs.getDirectoryHandle('fplan-data', { create: true });
      for (const [rel, text] of Object.entries(files)) {
        const handle = await root.getFileHandle(rel, { create: true });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
      }
    }, driveSeedFiles());
    // Plan, not the root: the root is the Dashboard, which takes a snapshot
    // on arrival — and a snapshot refreshes VTI through the proxy, which
    // would hand the Refresh-prices leg below its answer before its click.
    // The Dashboard gets its own leg further down.
    await page.goto(`${staticServer.origin}/workbench?backend=local`);
    await page.locator('.verdict').first().waitFor({ state: 'visible', timeout: 180_000 });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await staticServer?.close();
    await proxy?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('a real Refresh-prices click flows through the proxy and stores the quote', async () => {
    // The Accounts module (2026-08-30): a sidebar item, with Refresh prices
    // in the module banner.
    await page.getByRole('button', { name: 'Accounts' }).click();
    await page.getByRole('button', { name: 'Refresh prices' }).click();

    // The stored quote moves: same fixture price, a fresh fetchedAt.
    const deadline = Date.now() + 60_000;
    let quotes: QuotesFile;
    for (;;) {
      quotes = await page.evaluate(() => (window as unknown as ApiWindow).__fplanApi.getQuotes());
      if (quotes.VTI?.fetchedAt !== SEEDED_FETCHED_AT) break;
      if (Date.now() > deadline) throw new Error('the refresh never rewrote quotes.json');
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(quotes.VTI?.price).toBeGreaterThan(0);
    expect(quotes.VTI?.currency).toBe('USD');
    expect(quotes.VTI?.source).toBe('yahoo');

    // It went THROUGH the proxy, carrying the page's origin (which the
    // allowlist echoed — otherwise the page could never have read the body).
    const hit = proxy.seen.find((s) => s.url.includes('symbol=VTI'));
    expect(hit).toBeDefined();
    expect(hit?.origin).toBe(staticServer.origin);

    // And nothing failed per-symbol: no warn line under the button.
    expect(await page.locator('.field-help.warn').count()).toBe(0);
    expect(await page.locator('.error-banner', { hasText: 'Refresh failed' }).count()).toBe(0);
  }, 120_000);

  it('a symbol the upstream rejects lands as that symbol’s data, not a thrown refresh', async () => {
    const result = await page.evaluate(() =>
      (window as unknown as ApiWindow).__fplanApi.refreshQuotes(['NOPE']),
    );
    expect(result.results).toHaveLength(1);
    const outcome = result.results[0];
    if (outcome.ok) throw new Error('expected the unknown symbol to fail');
    expect(outcome.error).toContain('HTTP 404');
    // Nothing was stored for it, and the batch still answered.
    expect(result.quotes.NOPE).toBeUndefined();
  }, 60_000);

  it('the proxy’s own 400 is readable FROM THE PAGE — the CORS echo covers refusals too', async () => {
    const answer = await page.evaluate(async (proxyOrigin: string) => {
      const res = await fetch(`${proxyOrigin}/?symbol=${encodeURIComponent('bad!')}`);
      return { status: res.status, body: (await res.json()) as { error: string } };
    }, proxy.origin);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain('ticker symbol');
  }, 60_000);

  it('the Dashboard: the S&P 500 zoomed out, fetched once, skipped within the hour, refetched when stale — and the plan re-scored', async () => {
    // The sidebar: Dashboard first, behind its separator, and no ticker.
    const trail = await page
      .locator('.sideNavItems > *')
      .evaluateAll((els) => els.map((e) => `${e.className}|${(e.textContent ?? '').trim()}`));
    expect(trail[0]).toContain('Dashboard');
    expect(trail[1]).toMatch(/^sideNavSep\|/);
    expect(trail.some((t) => t.includes('S&P 500'))).toBe(false);
    expect(gspcHits).toBe(0);

    await page.locator('.sideNav').getByRole('button', { name: 'Dashboard', exact: true }).click();
    const market = page.getByRole('region', { name: 'The market, zoomed out' });
    await expect.poll(() => market.innerText(), { timeout: 60_000 }).toContain('Up 10.0%');
    const text = await market.innerText();
    expect(text).toContain('Nov 20, 2025 → Nov 20, 2026');
    expect(text).toContain('+32.0%');
    expect(text).toContain('+65.0%');
    expect(text).toMatch(/\b(EDT|EST)\b/);
    expect(gspcRanges).toEqual(['10y']);

    // An activation within the hour does NOT refetch...
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1_000);
    expect(gspcHits).toBe(1);

    // ...but a stale value does, whatever the real clock says (years old is
    // past the hour mid-session and before the settled close after it).
    await page.evaluate(() => {
      const key = 'fplan-sp500-history';
      const stale = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      stale.fetchedAt = '2020-01-06T15:00:00.000Z';
      localStorage.setItem(key, JSON.stringify(stale));
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(() => gspcHits, { timeout: 30_000 }).toBe(2);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              JSON.parse(localStorage.getItem('fplan-sp500-history') ?? '{}') as {
                fetchedAt?: string;
              }
            ).fetchedAt ?? '',
        ),
      )
      .not.toMatch(/^2020-/);

    // The plan half: arriving took today's snapshot (the seed holds none
    // from today) and its score lands on the card.
    const plan = page.getByRole('region', { name: 'The retirement plan' });
    await expect
      .poll(() => plan.innerText(), { timeout: 300_000 })
      .toContain('chance the money lasts');
    const rows = await page.evaluate(() =>
      (
        window as unknown as { __fplanApi: { getNetWorth(): Promise<Array<{ takenAt: string }>> } }
      ).__fplanApi.getNetWorth(),
    );
    const today = new Date().toDateString();
    expect(rows.filter((r) => new Date(r.takenAt).toDateString() === today)).toHaveLength(1);
  }, 420_000);

  it('a DOWN upstream fails per-symbol and the stored quote survives untouched', async () => {
    const before = await page.evaluate(() =>
      (window as unknown as ApiWindow).__fplanApi.getQuotes(),
    );
    await new Promise<void>((resolve) => upstream.close(() => resolve()));

    const result = await page.evaluate(() =>
      (window as unknown as ApiWindow).__fplanApi.refreshQuotes(['VTI']),
    );
    const outcome = result.results[0];
    if (outcome.ok) throw new Error('expected the down-upstream refresh to fail');
    expect(outcome.error).toContain('HTTP 502');

    // The failed symbol's PREVIOUS stored quote is intact — a stale price
    // with an honest asOf beats no price (the store's own rule).
    const after = await page.evaluate(() =>
      (window as unknown as ApiWindow).__fplanApi.getQuotes(),
    );
    expect(after.VTI).toEqual(before.VTI);
  }, 60_000);

  it('threw no page error', () => {
    expect(pageErrors).toEqual([]);
  });
});
