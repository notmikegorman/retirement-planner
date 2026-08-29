/**
 * THE FRESH-MACHINE WALKTHROUGH (Phase 7's gate): the BASED Pages bundle —
 * built exactly as .github/workflows/pages.yml builds it (base
 * /retirement-planner/, VITE_FPLAN_BACKEND=local, the pagesExtras 404
 * trick) — served under the /retirement-planner/ prefix with GitHub Pages'
 * own semantics (staticServer's basePath + pages404 emulation), and driven
 * as a brand-new user who just clicked the URL:
 *
 *   boot screen (THE question) → choose browser-private storage → the
 *   starter household appears → the quick run completes → drive-scale
 *   profile through the seam → Run now (fixture-fed quote refresh, then
 *   the final-quality run) → a net-worth snapshot with score AND spend
 *   attached → a reload that lands back in the same storage with the
 *   cached final run restored (and boot-sweeps planted .crswap orphans) →
 *   the Dashboard's D7 run-cache size → a deep link that reloads through
 *   the 404 trick (status 404, app rendered) → the D8 fallback asserted by
 *   feature-flagging showDirectoryPicker away in a fresh context.
 *
 * WHY THIS LANE EXISTS: it is the only place the BASE PATH is executed.
 * Every other browser test serves at '/', where a forgotten stripBase or a
 * bare-rooted worker URL is invisible; here, any path assumption that
 * escapes the base 404s loudly. It is also the only place the FIRST-VISIT
 * chooser is driven (every other lane pre-seeds the choice as a returning
 * user), and the place that pins the lane discipline for the service
 * worker: the walkthrough build does NOT set VITE_FPLAN_SW, so nothing
 * registers — asserted, so a future registration cannot quietly start
 * intercepting lane traffic.
 *
 * Lane discipline as everywhere in tests/browser: self-contained, offline
 * (off-origin requests aborted), ephemeral port, own dist directory
 * (dist/ui-pages — never the dist/ui the other lanes build).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Profile } from '../../src/shared/types';
import { writePagesExtras } from '../../scripts/pagesExtras';
import {
  DRIVE_HOME_VALUE,
  DRIVE_NOTE,
  DRIVE_PATHS_FINAL,
  DRIVE_PATHS_INTERACTIVE,
  VTI_FIXTURE_TEXT,
  driveProfile,
} from './driveFixtures';
import { serveStatic, type StaticServer } from './staticServer';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const distPages = path.join(repoRoot, 'dist', 'ui-pages');

/** The deployed shape, decision D6: <origin>/retirement-planner/. */
const BASE = '/retirement-planner';

describe('pages walkthrough: the based bundle, driven as a brand-new user', () => {
  let browser: Browser;
  let staticServer: StaticServer;
  let context: BrowserContext;
  let page: Page;
  const pageErrors: string[] = [];

  const chooserHeading = () =>
    page.getByRole('heading', { name: 'Where should your data live?' });
  const verdict = () => page.locator('.verdict').first();

  /** Fixture quotes + off-origin blocking; NO storage pre-seed — that is the point. */
  async function wireContext(ctx: BrowserContext): Promise<void> {
    await ctx.route('**/*', (route) => {
      if (route.request().url().startsWith(`${staticServer.origin}/`)) return route.continue();
      pageErrors.push(`blocked off-origin request: ${route.request().url()}`);
      return route.abort();
    });
    await ctx.addInitScript(
      ({ fixture }: { fixture: string }) => {
        (window as unknown as Record<string, unknown>).__fplanLocalOptions = {
          quoteFetcher: async (url: string) => {
            if (!url.includes('/VTI?')) throw new Error(`no walkthrough fixture for ${url}`);
            return { ok: true, status: 200, json: async () => JSON.parse(fixture) as unknown };
          },
        };
      },
      { fixture: VTI_FIXTURE_TEXT },
    );
  }

  beforeAll(async () => {
    // The EXACT pages build: same config file, the workflow's base and
    // backend default, the workflow's extras. VITE_FPLAN_SW deliberately
    // unset — the lane runs the app, never the service worker.
    process.env.VITE_FPLAN_BACKEND = 'local';
    try {
      await build({
        configFile: path.join(repoRoot, 'vite.config.ts'),
        base: `${BASE}/`,
        logLevel: 'warn',
        build: { outDir: distPages, emptyOutDir: true },
      });
    } finally {
      delete process.env.VITE_FPLAN_BACKEND;
    }
    await writePagesExtras(distPages);

    staticServer = await serveStatic(distPages, { basePath: BASE, pages404: true });
    browser = await chromium.launch();
    context = await browser.newContext();
    await wireContext(context);
    page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await staticServer?.close();
  });

  it('a brand-new visit under the base asks THE question', async () => {
    await page.goto(`${staticServer.origin}${BASE}/`);
    await chooserHeading().waitFor({ state: 'visible', timeout: 60_000 });
    // Chromium ships the picker, so the durable option leads…
    await expect
      .poll(() => page.getByRole('button', { name: 'Pick a folder…' }).isVisible())
      .toBe(true);
    // …and the browser-private option is labelled with its honest cost.
    const chooserText = await page.locator('body').innerText();
    expect(chooserText).toContain('Clear browsing data erases everything');
    expect(chooserText).toContain('simulations run on this machine');
  }, 120_000);

  it('choosing browser-private storage boots the starter household and its quick run', async () => {
    await page.getByRole('button', { name: 'Use browser-private storage' }).click();
    await verdict().waitFor({ state: 'visible', timeout: 240_000 });
    // The starter household seeded from bundled defaults: Alex and Jordan.
    const profile = await page.evaluate(() =>
      (window as unknown as { __fplanApi: { getProfile(): Promise<Profile> } }).__fplanApi
        .getProfile(),
    );
    expect(profile.people.map((p) => p.name)).toEqual(['Alex', 'Jordan']);
    // The starter's own quick run, at the starter's own scale.
    expect((await page.locator('.wb-chip').first().innerText()).trim()).toBe(
      'Quick run · 1,000 paths',
    );
  }, 300_000);

  it('the household goes to drive scale through the documented seam', async () => {
    // __fplanApi is the app's scripting surface (DEVELOPMENT.md): the
    // walkthrough uses it the way the owner would, to swap in the
    // drive-scale profile (VTI holdings, 100/400 paths) so the rest of the
    // session exercises the quote path without CI-scale simulation cost.
    await page.evaluate(
      (p: Profile) =>
        (window as unknown as { __fplanApi: { putProfile(x: Profile): Promise<unknown> } })
          .__fplanApi.putProfile(p),
      driveProfile(),
    );
    // The drive profile prices its brokerage from VTI, and a run REFUSES on
    // missing quotes (the fatal gate) — so refresh once through the seam,
    // exactly what the Accounts card's Refresh button would do, before the
    // reload's quick run needs the price.
    await page.evaluate(() =>
      (
        window as unknown as {
          __fplanApi: { refreshQuotes(s?: string[]): Promise<unknown> };
        }
      ).__fplanApi.refreshQuotes(['VTI']),
    );
    await page.reload();
    await verdict().waitFor({ state: 'visible', timeout: 240_000 });
    // Same storage, no re-asking: the chooser must NOT reappear on reload.
    expect(await chooserHeading().count()).toBe(0);
    await expect
      .poll(async () => (await page.locator('.wb-chip').first().innerText()).trim(), {
        timeout: 120_000,
      })
      .toBe(`Quick run · ${DRIVE_PATHS_INTERACTIVE.toLocaleString('en-US')} paths`);
  }, 300_000);

  it('Run now: fixture-fed refresh, then the final-quality run', async () => {
    await page.getByRole('button', { name: 'Run now' }).click();
    const finalChip = page.locator('.wb-chip.good').filter({ hasText: 'Final quality' });
    await finalChip.waitFor({ state: 'visible', timeout: 240_000 });
    expect((await finalChip.innerText()).trim()).toBe(
      `Final quality · ${DRIVE_PATHS_FINAL.toLocaleString('en-US')} paths`,
    );
  }, 300_000);

  it('a snapshot gets its score AND its sustainable-spend figure', async () => {
    await page.getByRole('button', { name: 'Net Worth' }).click();
    await page.getByRole('button', { name: 'Take snapshot' }).click();
    const dialogInputs = page.locator('dialog input');
    await dialogInputs.first().fill(String(DRIVE_HOME_VALUE));
    await dialogInputs.first().press('Enter');
    await dialogInputs.nth(1).fill(DRIVE_NOTE);
    await dialogInputs.nth(1).press('Tab');
    await page.locator('dialog button.primary').click();
    const scoreCell = page.locator('tbody tr').first().locator('td').nth(4);
    await expect
      .poll(async () => scoreCell.innerText().catch(() => ''), { timeout: 300_000 })
      .toMatch(/%/);
    // Terminal state through the seam — the spend solve lands after the
    // score, and the dual-stack gate learned the hard way not to move on
    // before it does.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const api = (
              window as unknown as {
                __fplanApi: {
                  getNetWorth(): Promise<{ score?: { sustainableSpend?: number } }[]>;
                };
              }
            ).__fplanApi;
            const rows = await api.getNetWorth();
            return rows.some((r) => r.score?.sustainableSpend !== undefined);
          }),
        { timeout: 300_000 },
      )
      .toBe(true);
  }, 600_000);

  it('a reload lands back in the same storage, restores the cached final run, and sweeps planted .crswap orphans', async () => {
    // Back to the workbench first: the reload must land where the cached-
    // final-run contract shows itself (the snapshot leg left us on Net
    // Worth, whose page has no verdict to wait for).
    await page.getByRole('button', { name: 'Workbench' }).click();
    await verdict().waitFor({ state: 'visible', timeout: 240_000 });

    // Plant the orphans a killed mid-write tab would leave (Phase-3's known
    // leftover, decided in Phase 7: sweep on boot).
    await page.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory();
      const root = await opfs.getDirectoryHandle('fplan-data');
      const plant = async (dir: FileSystemDirectoryHandle, name: string) => {
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write('{"half":"written');
        await w.close();
      };
      await plant(root, 'networth.json.crswap');
      await plant(await root.getDirectoryHandle('runs'), 'orphan.json.crswap');
    });

    await page.reload();
    await verdict().waitFor({ state: 'visible', timeout: 240_000 });
    expect(await chooserHeading().count()).toBe(0);

    // The cached-final-run contract (commit 243ee48), now on the shipped
    // path: a load with a final-quality answer on disk shows THAT — the
    // chip reads Final quality straight after boot, with the honest
    // "Computed …" moment beside it.
    const finalChip = page.locator('.wb-chip.good').filter({ hasText: 'Final quality' });
    await finalChip.waitFor({ state: 'visible', timeout: 240_000 });
    expect((await finalChip.innerText()).trim()).toBe(
      `Final quality · ${DRIVE_PATHS_FINAL.toLocaleString('en-US')} paths`,
    );
    expect(await page.locator('.wb-chip').filter({ hasText: 'Computed' }).isVisible()).toBe(true);

    // Both orphans swept by the boot's guard-held sweep.
    expect(
      await page.evaluate(async () => {
        const opfs = await navigator.storage.getDirectory();
        const root = await opfs.getDirectoryHandle('fplan-data');
        const exists = async (dir: FileSystemDirectoryHandle, name: string) => {
          try {
            await dir.getFileHandle(name);
            return true;
          } catch {
            return false;
          }
        };
        return {
          root: await exists(root, 'networth.json.crswap'),
          runs: await exists(await root.getDirectoryHandle('runs'), 'orphan.json.crswap'),
        };
      }),
    ).toEqual({ root: false, runs: false });
  }, 600_000);

  it('the Dashboard shows the run cache (D7) and the switch-storage affordance', async () => {
    await page.getByRole('button', { name: 'Dashboard' }).click();
    const cardText = await page
      .locator('.card')
      .filter({ hasText: 'Data folder' })
      .innerText();
    expect(cardText).toContain('(browser-private storage)');
    const runCache = /Run cache: (\d+) runs · ([\d.]+ (?:B|KB|MB))/.exec(cardText);
    expect(runCache).not.toBeNull();
    // The session computed at least the starter quick, the drive quick and
    // the drive final — a zero here would mean the metric measures nothing.
    expect(Number(runCache![1])).toBeGreaterThanOrEqual(3);
    expect(cardText).toMatch(/storage (persistent|best-effort)/);
    expect(cardText).toContain('Switch storage…');
  }, 120_000);

  it('a deep link under the base reloads through the 404 trick', async () => {
    const response = await page.goto(`${staticServer.origin}${BASE}/profile/expenses`);
    // The status IS the proof: no file answered — the custom 404 page (a
    // copy of index.html) did, and booted the app on the deep path.
    expect(response!.status()).toBe(404);
    await page
      .getByRole('tablist', { name: 'Profile sections' })
      .waitFor({ state: 'visible', timeout: 240_000 });
    expect(
      await page
        .getByRole('tablist', { name: 'Profile sections' })
        .getByRole('tab', { name: 'Expenses' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    // The router kept the based path rather than rewriting it out of the site.
    expect(new URL(page.url()).pathname).toBe(`${BASE}/profile/expenses`);
  }, 300_000);

  it('no service worker registered in the lane — the walkthrough build does not opt in', async () => {
    expect(
      await page.evaluate(async () =>
        'serviceWorker' in navigator
          ? (await navigator.serviceWorker.getRegistrations()).length
          : 0,
      ),
    ).toBe(0);
  });

  it('no picker: the D8 fallback is offered honestly, and boots demo-scoped', async () => {
    const fallbackContext = await browser.newContext();
    await wireContext(fallbackContext);
    // Feature-flag the picker away: this is Safari/Firefox as far as the
    // boot gate can tell (supportsFolderPicker feature-detects, so this is
    // the same branch, not a lookalike).
    await fallbackContext.addInitScript(() => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        value: undefined,
        configurable: true,
      });
    });
    const fbPage = await fallbackContext.newPage();
    fbPage.on('pageerror', (err) => pageErrors.push(String(err)));

    await fbPage.goto(`${staticServer.origin}${BASE}/`);
    await fbPage
      .getByRole('heading', { name: 'Where should your data live?' })
      .waitFor({ state: 'visible', timeout: 60_000 });
    const chooserText = await fbPage.locator('body').innerText();
    expect(chooserText).toContain("This browser can't hold a durable folder connection");
    expect(chooserText).toContain('open this page in one of those browsers');
    expect(await fbPage.getByRole('button', { name: 'Pick a folder…' }).count()).toBe(0);

    await fbPage.getByRole('button', { name: 'Try it in demo storage' }).click();
    await fbPage.locator('.verdict').first().waitFor({ state: 'visible', timeout: 240_000 });
    // The standing banner: every session in this browser says demo, forever.
    const banner = fbPage.locator('.demo-banner');
    expect(await banner.isVisible()).toBe(true);
    expect(await banner.innerText()).toContain('Demo storage.');
    await fallbackContext.close();
  }, 600_000);

  it('threw no page error anywhere in the walkthrough', () => {
    expect(pageErrors).toEqual([]);
  });
});
