/**
 * THE FRESH-MACHINE WALKTHROUGH (Phase 7's gate): the BASED Pages bundle —
 * built exactly as .github/workflows/pages.yml builds it (base
 * /retirement-planner/, VITE_FPLAN_BACKEND=local, the pagesExtras 404
 * trick) — served under the /retirement-planner/ prefix with GitHub Pages'
 * own semantics (staticServer's basePath + pages404 emulation), and driven
 * as a brand-new user who just clicked the URL:
 *
 *   boot screen (THE question, one visible action since the 2026-08-29
 *   chooser cut) → OPFS seeded through the storage-choice seam (headless
 *   Chromium ships the picker API but cannot complete the native dialog;
 *   the seeded value is byte-identical to a pre-cut browser-private user's
 *   remembered choice, so this leg IS the never-strand proof) →
 *   ZERO-START: the setup step, not an invented household (abandon +
 *   reload lands back on it with nothing written; the submitted form
 *   writes the stranger's own minimal profile) → the GATED workbench (no
 *   success percentage, no simulated figure anywhere in the results
 *   column; Net Worth's snapshot button replaced by the honest note) →
 *   the first account through the documented seam → the FIRST simulation,
 *   its number carrying its conditions (the quick chip AND the zero-spend
 *   caption) → drive-scale profile through the seam → Run now
 *   (fixture-fed quote refresh, then the final-quality run) → a net-worth
 *   snapshot with score AND spend attached → a reload that lands back in
 *   the same storage with the cached final run restored (and boot-sweeps
 *   planted .crswap orphans) → Profile > Settings' D7 run-cache size → a deep
 *   link that reloads through the 404 trick (status 404, app rendered) →
 *   the D8 fallback asserted by feature-flagging showDirectoryPicker away
 *   in a fresh context — the ONE place the fictional starter household
 *   still seeds, asserted by name.
 *
 * WHY THIS LANE EXISTS: it is the only place the BASE PATH is executed.
 * Every other browser test serves at '/', where a forgotten stripBase or a
 * bare-rooted worker URL is invisible; here, any path assumption that
 * escapes the base 404s loudly. It is also the only place the FIRST-VISIT
 * chooser is rendered and asserted — including the pin that no visible UI
 * path reaches OPFS on a picker-capable browser (every other lane pre-seeds
 * the choice as a returning user via addInitScript; this one seeds the same
 * key mid-walkthrough, after the chooser assertions, for the same reason:
 * the native folder dialog is undrivable headless) — and the only place the
 * ZERO-START boot is executed end to end as a stranger would meet it (the
 * other lanes seed explicit profiles and never see the setup step). It is
 * also the place that pins the lane discipline for the service
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
  const setupHeading = () => page.getByRole('heading', { name: 'Who is this plan for?' });
  const verdict = () => page.locator('.verdict').first();

  /** Whether the OPFS data folder holds a profile.json — zero-start's fact. */
  const opfsProfileExists = (): Promise<boolean> =>
    page.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory();
      try {
        const root = await opfs.getDirectoryHandle('fplan-data');
        await root.getFileHandle('profile.json');
        return true;
      } catch {
        return false;
      }
    });

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
    // backend default, the workflow's extras. The base goes in through
    // FPLAN_BASE — the same door build:pages uses — so vite.config's
    // env-driven `base:` line is executed here, not emulated: hardcode that
    // line back to '/' and this lane 404s its own assets. VITE_FPLAN_SW
    // deliberately unset — the lane runs the app, never the service worker.
    process.env.VITE_FPLAN_BACKEND = 'local';
    process.env.FPLAN_BASE = `${BASE}/`;
    try {
      await build({
        configFile: path.join(repoRoot, 'vite.config.ts'),
        logLevel: 'warn',
        build: { outDir: distPages, emptyOutDir: true },
      });
    } finally {
      delete process.env.VITE_FPLAN_BACKEND;
      delete process.env.FPLAN_BASE;
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

  it('a brand-new visit under the base asks THE question — one action, no OPFS door', async () => {
    await page.goto(`${staticServer.origin}${BASE}/`);
    await chooserHeading().waitFor({ state: 'visible', timeout: 60_000 });
    // Chromium ships the picker, so the folder action is THE answer…
    await expect
      .poll(() => page.getByRole('button', { name: 'Pick a folder…' }).isVisible())
      .toBe(true);
    // …and it is the ONLY action: the browser-private card was cut on
    // 2026-08-29 (DECISIONS.md, "The chooser loses its second answer").
    // Exactly one button on the page pins that no visible UI path reaches
    // OPFS on a picker-capable browser — the seam in the next leg is the
    // only way there, which is the whole point of the seam's documentation.
    expect(await page.locator('button').count()).toBe(1);
    const chooserText = await page.locator('body').innerText();
    expect(chooserText).not.toContain('Browser-private');
    expect(chooserText).toContain('simulations run on this machine');
    expect(chooserText).toContain('your data never leaves it');
  }, 120_000);

  it('a remembered OPFS choice (pre-cut user, or the lane seam) boots ZERO-START: the setup step, not an invented household', async () => {
    // Headless Chromium cannot complete the native folder dialog, so the
    // lane cannot click through the one visible action. It boots OPFS the
    // way every other lane always has (Phase 7's returning-user pre-seed):
    // write the remembered choice and reload. The written value is
    // byte-identical to what the retired "Use browser-private storage"
    // button stored, so this leg doubles as the never-strand proof — and
    // since zero-start, what a fresh boot lands on is the SETUP STEP: the
    // fictional starter household no longer seeds anywhere but the D8 demo
    // (the last leg asserts that half).
    await page.evaluate(() => localStorage.setItem('fplan-storage', 'opfs'));
    await page.reload();
    await setupHeading().waitFor({ state: 'visible', timeout: 240_000 });
    expect(await chooserHeading().count()).toBe(0);
    expect(await page.locator('.demo-banner').count()).toBe(0);
    // The folder got its reference data and NOTHING resembling a household:
    // the boot seeded assumptions, and profile.json does not exist.
    expect(await opfsProfileExists()).toBe(false);
  }, 300_000);

  it('abandoning setup and reloading lands back on setup — nothing is written until submit', async () => {
    // Type half an answer, walk away, come back: the setup step again, with
    // the folder still profile-less. A half-written household surviving an
    // abandoned form is exactly the bug this pins out.
    await page.getByLabel('Your name').fill('Halfway');
    await page.getByLabel('Your name').press('Tab');
    await page.reload();
    await setupHeading().waitFor({ state: 'visible', timeout: 240_000 });
    expect(await opfsProfileExists()).toBe(false);
  }, 300_000);

  it('the submitted setup writes the stranger’s own minimal profile and lands on the GATED workbench', async () => {
    // A single-person household, typed by the lane the way a stranger would
    // type their own — nothing here comes from data-defaults.
    await page.getByLabel('Your name').fill('Riley Kim');
    await page.getByLabel('Your name').press('Tab');
    await page.getByLabel('Birth year').fill('1980');
    await page.getByLabel('Birth year').press('Tab');
    await page.getByLabel('Birth month').selectOption('6');
    await page.getByLabel('State').selectOption('nc');
    await page.getByRole('button', { name: 'Start with this household' }).click();

    // The app renders — on the first-run state, not on a simulation.
    await page
      .getByRole('heading', { name: 'Nothing to simulate yet' })
      .waitFor({ state: 'visible', timeout: 240_000 });

    // What the folder now holds is exactly what was typed: one person, the
    // chosen state, EMPTY accounts, single filing (derived from one person).
    const profile = await page.evaluate(() =>
      (window as unknown as { __fplanApi: { getProfile(): Promise<Profile> } }).__fplanApi
        .getProfile(),
    );
    expect(profile.people.map((p) => p.name)).toEqual(['Riley Kim']);
    expect(profile.people[0].birthYear).toBe(1980);
    expect(profile.people[0].birthMonth).toBe(6);
    expect(profile.filing).toEqual({ status: 'single', state: 'nc' });
    expect(profile.accounts).toEqual([]);

    // THE GATE, asserted on the whole results column: no verdict, no
    // percentage, no simulated figure of any kind — only the honest state
    // saying what is missing and where to add it.
    expect(await verdict().count()).toBe(0);
    const resultsText = await page.locator('.wb-results').innerText();
    expect(resultsText).toContain('Add your accounts on the Accounts page');
    expect(resultsText).not.toContain('%');
    expect(await page.locator('.wb-metric-value').count()).toBe(0);

    // The sidebar's folder control names the storage this session actually
    // booted on — the OPFS seam boots browser-private, and the control must
    // say so by the app's one name for it (folderControlLogic).
    expect((await page.locator('.folder-name').innerText()).trim()).toBe(
      'Browser-private storage',
    );
  }, 300_000);

  it('Net Worth degrades honestly too: no snapshot button, the reason in its place', async () => {
    await page.getByRole('button', { name: 'Net worth' }).click();
    // Poll for the note first — the page shows "Loading…" until the profile
    // answers, and the button assertion would pass vacuously against it.
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('there is nothing to record yet'), {
        timeout: 60_000,
      })
      .toBe(true);
    expect(await page.getByRole('button', { name: 'Take snapshot' }).count()).toBe(0);
    await page.locator('.sideNav').getByRole('button', { name: 'Plan', exact: true }).click();
  }, 120_000);

  it('the FIRST account opens the gate: one simulation appears, its number carrying its conditions', async () => {
    // get-mutate-put through the documented seam — the same shape the
    // Accounts card's editor produces, added the way the owner scripts it.
    await page.evaluate(async () => {
      const api = (
        window as unknown as {
          __fplanApi: { getProfile(): Promise<Profile>; putProfile(p: Profile): Promise<unknown> };
        }
      ).__fplanApi;
      const p = await api.getProfile();
      p.accounts.push({
        id: 'sav1',
        name: 'Savings',
        type: 'savings',
        owner: 'p1',
        balance: 50_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      } as Profile['accounts'][number]);
      await api.putProfile(p);
    });
    await page.reload();
    await verdict().waitFor({ state: 'visible', timeout: 240_000 });
    // The number carries its run conditions (the chip)…
    expect((await page.locator('.wb-chip').first().innerText()).trim()).toBe(
      'Quick run · 1,000 paths',
    );
    // …AND its zero-spend condition: nothing recorded is spent, so the score
    // must say beside itself what kind of statement it is.
    const resultsText = await page.locator('.wb-results').innerText();
    expect(resultsText).toContain('Recorded spending is $0/month');
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
    await page.getByRole('button', { name: 'Net worth' }).click();
    await page.getByRole('button', { name: 'Take snapshot' }).click();
    const dialogInputs = page.locator('dialog input');
    await dialogInputs.first().fill(String(DRIVE_HOME_VALUE));
    await dialogInputs.first().press('Enter');
    await dialogInputs.nth(1).fill(DRIVE_NOTE);
    await dialogInputs.nth(1).press('Tab');
    await page.locator('dialog button.primary').click();
    // The table lives on the Snapshots tab since the ledger grew tabs.
    await page.getByRole('tab', { name: 'Snapshots' }).click();
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
    await page.locator('.sideNav').getByRole('button', { name: 'Plan', exact: true }).click();
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

  it('the Settings module shows the run cache (D7) and the switch-storage affordance', async () => {
    // The data-folder card moved here when the Dashboard retired (2026-08-30);
    // decision D7's visibility bargain and the switch-storage door came with
    // it. It sits OUTSIDE the module's view/edit form, so everything below is
    // visible without pressing Edit.
    // Scoped to the sidebar: the Plan page (where the previous test ends)
    // mounts a 'Settings' SECTION header of its own since the input panel
    // became expand/collapse sections (2026-08-30).
    await page.locator('.sideNav').getByRole('button', { name: 'Settings', exact: true }).click();
    // The data-folder card lives on the ADVANCED tab now (Settings grew tabs
    // 2026-08-30), alongside Appearance — both outside the view/edit form.
    await page.getByRole('tab', { name: 'Advanced' }).click();
    const card = page.locator('.card').filter({ hasText: 'Data folder' });
    await card.waitFor({ state: 'visible', timeout: 120_000 });
    // The card fills in after its meta() round trip; wait for the D7 row
    // rather than reading the transient Loading… state.
    await card.getByText(/Run cache:/).waitFor({ state: 'visible', timeout: 120_000 });
    const cardText = await card.innerText();
    expect(cardText).toContain('(browser-private storage)');
    const runCache = /Run cache: (\d+) runs · ([\d.]+ (?:B|KB|MB))/.exec(cardText);
    expect(runCache).not.toBeNull();
    // The session computed at least the first-account quick, the drive quick
    // and the drive final — a zero here would mean the metric measures nothing.
    expect(Number(runCache![1])).toBeGreaterThanOrEqual(3);
    expect(cardText).toMatch(/storage (persistent|best-effort)/);
    expect(cardText).toContain('Switch storage…');
  }, 120_000);

  it('a deep link under the base reloads through the 404 trick', async () => {
    const response = await page.goto(`${staticServer.origin}${BASE}/expenses`);
    // The status IS the proof: no file answered — the custom 404 page (a
    // copy of index.html) did, and booted the app on the deep path.
    expect(response!.status()).toBe(404);
    await expect
      .poll(async () => (await page.locator('.bannerTitle').first().innerText()).trim(), {
        timeout: 240_000,
      })
      .toBe('Expenses');
    // The router kept the based path rather than rewriting it out of the site.
    expect(new URL(page.url()).pathname).toBe(`${BASE}/expenses`);
  }, 300_000);

  it('a LEGACY /profile deep link lands on the module its tab became, and the URL cleans up', async () => {
    // Links from before the module split (2026-08-30) still resolve: the 404
    // trick serves the app, parseRoute maps /profile/expenses onto the
    // Expenses module, and the canonical rewrite fixes the address bar —
    // still under the base.
    const response = await page.goto(`${staticServer.origin}${BASE}/profile/expenses`);
    expect(response!.status()).toBe(404);
    await expect
      .poll(async () => (await page.locator('.bannerTitle').first().innerText()).trim(), {
        timeout: 240_000,
      })
      .toBe('Expenses');
    expect(new URL(page.url()).pathname).toBe(`${BASE}/expenses`);
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
    // The honest-cost sentence moved here with the card: on these browsers
    // the demo door still says what it costs, exactly as before the cut.
    expect(chooserText).toContain('Clear browsing data erases everything');
    expect(await fbPage.getByRole('button', { name: 'Pick a folder…' }).count()).toBe(0);

    await fbPage.getByRole('button', { name: 'Try it in demo storage' }).click();
    await fbPage.locator('.verdict').first().waitFor({ state: 'visible', timeout: 240_000 });
    // The standing banner: every session in this browser says demo, forever.
    const banner = fbPage.locator('.demo-banner');
    expect(await banner.isVisible()).toBe(true);
    expect(await banner.innerText()).toContain('Demo storage.');
    // THE ONE PLACE THE FICTIONAL HOUSEHOLD SURVIVES (zero-start): the demo's
    // purpose is showing a filled example, so it seeds the starter — Alex and
    // Jordan, by name, with the verdict above proving it simulates. No setup
    // step here: the demo seeds, it never asks.
    const demoProfile = await fbPage.evaluate(() =>
      (window as unknown as { __fplanApi: { getProfile(): Promise<Profile> } }).__fplanApi
        .getProfile(),
    );
    expect(demoProfile.people.map((p) => p.name)).toEqual(['Alex', 'Jordan']);

    // The folder control degrades with the storage: "Demo storage" as the
    // name, and its menu explains rather than offering folders this browser
    // cannot pick (folderControlLogic's demo-note branch).
    expect((await fbPage.locator('.folder-name').innerText()).trim()).toBe('Demo storage');
    await fbPage.locator('.folder-toggle').click();
    const menuText = await fbPage.locator('.folder-menu').innerText();
    expect(menuText).toContain('there is no folder connection to switch');
    expect(await fbPage.getByRole('menuitem', { name: 'Open another folder…' }).count()).toBe(0);
    await fallbackContext.close();
  }, 600_000);

  it('threw no page error anywhere in the walkthrough', () => {
    expect(pageErrors).toEqual([]);
  });
});
