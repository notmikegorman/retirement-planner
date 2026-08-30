/**
 * THE INTERRUPTION MATRIX (Phase 6 gate): kill the tab mid-scoring, after the
 * write-ahead intent lands, and prove the reopened app resolves the row into
 * exactly the promised states — never a silent permanent blank. This is the
 * browser-lane proof of the machinery the Aug-20 incident demanded
 * (store/scoringIntent.ts): in a pure browser the tab IS the process, so a
 * closed tab mid-scoring is the ordinary case, not a rare crash.
 *
 * Three legs over three isolated OPFS worlds (one per browser context), all
 * seeded with identical bytes:
 *
 *   CONTROL      — take a snapshot, let scoring finish untouched. Also where
 *                  the beforeunload guard's arm/disarm is observed: armed
 *                  exactly while the scoring is in flight, gone after.
 *   INTERRUPTED  — same snapshot; the tab is killed the moment the intent
 *                  file exists. Reopen: the row reads INTERRUPTED with a
 *                  Finish-scoring button; the click completes the SAME
 *                  measurement, and the finished networth.json is BYTE-EQUAL
 *                  to the control's under masked stamps (ids, takenAt,
 *                  scoredAt — wall clock and randomness, nothing else).
 *   MOVED        — same kill, but the plan is edited before the app reopens.
 *                  Boot healing stamps the honest reason (a figure computed
 *                  now would belong to now), clears the intent, and the row
 *                  reads permanently unmeasured — with the reason, not a gap.
 *
 * The final-quality path count is raised to 4,000 so the kill provably lands
 * inside the score run (~2s of simulation) rather than racing a 400-path
 * blink; everything else is the dual-stack drive's seed world.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { InterruptedScoring, NetWorthSnapshot, Profile } from '../../src/shared/types';
import { VTI_FIXTURE_TEXT, driveProfile, driveQuotes } from './driveFixtures';
import { serveStatic, type StaticServer } from './staticServer';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const distUi = path.join(repoRoot, 'dist', 'ui');

const HOME_VALUE = 500_000;
/** Big enough that the score run alone is seconds — the kill window. */
const FINAL_PATHS = 4_000;

/** The seed bytes, identical for every leg. */
function seedFiles(): Record<string, string> {
  const profile: Profile = driveProfile();
  profile.settings.mcPathsFinal = FINAL_PATHS;
  return {
    'profile.json': `${JSON.stringify(profile, null, 2)}\n`,
    'quotes.json': `${JSON.stringify(driveQuotes(), null, 2)}\n`,
  };
}

/** Wall-clock and randomness masked; every figure and condition compared. */
function maskLedger(text: string): string {
  return text
    .replace(/"id": "nw-[^"]+"/g, '"id": "nw-MASKED"')
    .replace(/^(\s*)"takenAt": "[^"]+"/gm, '$1"takenAt": "MASKED"')
    .replace(/^(\s*)"scoredAt": "[^"]+"/gm, '$1"scoredAt": "MASKED"');
}

type ApiWindow = Window & {
  __fplanApi: {
    getNetWorth(): Promise<NetWorthSnapshot[]>;
    takeNetWorthSnapshot(body: { homeValue: number }): Promise<NetWorthSnapshot>;
    getScoringIntents(): Promise<{ intents: InterruptedScoring[] }>;
    getNetWorthScoring(): Promise<{ scoring: string[] }>;
  };
};

describe('interruption matrix: killed tab, write-ahead intent, honest resolution', () => {
  let browser: Browser;
  let staticServer: StaticServer;
  const contexts: BrowserContext[] = [];
  const pageErrors: string[] = [];

  beforeAll(async () => {
    await build({ configFile: path.join(repoRoot, 'vite.config.ts'), logLevel: 'warn' });
    browser = await chromium.launch();
    staticServer = await serveStatic(distUi, { spaFallback: true });
  }, 300_000);

  afterAll(async () => {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    await browser?.close();
    await staticServer?.close();
  });

  /** A fresh isolated world: own OPFS, own localStorage, fixture quotes. */
  async function newWorld(): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    contexts.push(context);
    await context.route('**/*', (route) => {
      if (route.request().url().startsWith(`${staticServer.origin}/`)) return route.continue();
      pageErrors.push(`blocked off-origin request: ${route.request().url()}`);
      return route.abort();
    });
    // The snapshot flow refreshes quotes first; the injected fetcher serves
    // the same fixture bytes the folder was seeded from, so a refresh
    // rewrites identical values and the runKey cannot move under the test.
    await context.addInitScript(
      ({ fixture }: { fixture: string }) => {
        // A returning user's remembered storage choice (Phase 7's boot gate
        // would otherwise stop each world at the first-visit chooser).
        try {
          localStorage.setItem('fplan-storage', 'opfs');
        } catch {
          /* storage disabled: the gate will ask, and the leg will fail loudly */
        }
        (window as unknown as Record<string, unknown>).__fplanLocalOptions = {
          quoteFetcher: async (url: string) => {
            if (!url.includes('/VTI?')) throw new Error(`no fixture for ${url}`);
            return { ok: true, status: 200, json: async () => JSON.parse(fixture) as unknown };
          },
        };
      },
      { fixture: VTI_FIXTURE_TEXT },
    );
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
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
    }, seedFiles());
    return { context, page };
  }

  async function bootApp(page: Page): Promise<void> {
    await page.goto(`${staticServer.origin}/?backend=local`);
    await page.locator('.verdict').first().waitFor({ state: 'visible', timeout: 240_000 });
  }

  function readOpfsText(page: Page, rel: string): Promise<string> {
    return page.evaluate(async (relPath: string) => {
      const opfs = await navigator.storage.getDirectory();
      const root = await opfs.getDirectoryHandle('fplan-data');
      const handle = await root.getFileHandle(relPath);
      return (await handle.getFile()).text();
    }, rel);
  }

  function opfsFileExists(page: Page, rel: string): Promise<boolean> {
    return page.evaluate(async (relPath: string) => {
      try {
        const opfs = await navigator.storage.getDirectory();
        const root = await opfs.getDirectoryHandle('fplan-data');
        await root.getFileHandle(relPath);
        return true;
      } catch {
        return false;
      }
    }, rel);
  }

  function beforeUnloadArmed(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  }

  async function waitForRowComplete(page: Page, timeoutMs = 300_000): Promise<NetWorthSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await page.evaluate(() =>
        (window as unknown as ApiWindow).__fplanApi.getNetWorth(),
      );
      const row = rows[rows.length - 1];
      if (
        row &&
        (row.scoreError !== undefined ||
          (row.score !== undefined &&
            (row.score.sustainableSpend !== undefined ||
              row.score.sustainableSpendError !== undefined)))
      ) {
        return row;
      }
      if (Date.now() > deadline) throw new Error('the scoring never completed');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  let controlLedger: string;

  it('CONTROL: an uninterrupted scoring completes, with the unload guard armed exactly meanwhile', async () => {
    const { page } = await newWorld();
    await bootApp(page);

    // Idle: nothing in flight, closing costs nothing — the guard is silent.
    expect(await beforeUnloadArmed(page)).toBe(false);

    await page.evaluate(
      (homeValue: number) =>
        (window as unknown as ApiWindow).__fplanApi.takeNetWorthSnapshot({ homeValue }),
      HOME_VALUE,
    );

    // ARMED: the row answered instantly but its simulation is in flight, and
    // closing the tab now is exactly what the guard exists to pause.
    expect(await beforeUnloadArmed(page)).toBe(true);

    const row = await waitForRowComplete(page);
    expect(row.score?.sustainableSpend).toBeDefined();

    // DISARMED: nothing in flight — a warning now would be a cry of wolf.
    expect(await beforeUnloadArmed(page)).toBe(false);
    // And the transient intent is gone from the finished world.
    expect(await opfsFileExists(page, '.scoring-intent.json')).toBe(false);

    controlLedger = await readOpfsText(page, 'networth.json');
    await page.close();
  }, 420_000);

  it('INTERRUPTED: kill after the intent lands → Interrupted + Finish scoring → byte-equal record', async () => {
    const { context, page } = await newWorld();
    await bootApp(page);

    await page.evaluate(
      (homeValue: number) =>
        (window as unknown as ApiWindow).__fplanApi.takeNetWorthSnapshot({ homeValue }),
      HOME_VALUE,
    );

    // The kill lands the moment the write-ahead intent is durable — the
    // score run (seconds at 4,000 paths) is still in flight.
    const deadline = Date.now() + 60_000;
    while (!(await opfsFileExists(page, '.scoring-intent.json'))) {
      if (Date.now() > deadline) throw new Error('the intent file never appeared');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await beforeUnloadArmed(page)).toBe(true); // armed at the moment of death
    await page.close(); // the tab dies; the simulation dies with it

    // REOPEN. Boot healing verifies the orphan against today's inputs (they
    // have not moved) and keeps it; the page draws the row as interrupted.
    const page2 = await context.newPage();
    page2.on('pageerror', (err) => pageErrors.push(String(err)));
    await bootApp(page2);
    const intents = await page2.evaluate(() =>
      (window as unknown as ApiWindow).__fplanApi.getScoringIntents(),
    );
    expect(intents.intents).toHaveLength(1);
    expect(intents.intents[0].kind).toBe('snapshot');

    await page2.getByRole('button', { name: 'Net worth' }).click();
    const scoreCell = page2.locator('tbody tr').first().locator('td').nth(4);
    await scoreCell.locator('.flag', { hasText: 'interrupted' }).waitFor({ timeout: 60_000 });

    // THE ONE CLICK (decision D4). The row flips to scoring…, the same
    // measurement completes, and the guard re-arms while it runs.
    await page2.getByRole('button', { name: 'Finish scoring' }).click();
    await scoreCell.locator('.muted', { hasText: 'scoring…' }).waitFor({ timeout: 60_000 });
    expect(await beforeUnloadArmed(page2)).toBe(true);

    const row = await waitForRowComplete(page2);
    expect(row.score?.sustainableSpend).toBeDefined();
    expect(await beforeUnloadArmed(page2)).toBe(false);
    expect(await opfsFileExists(page2, '.scoring-intent.json')).toBe(false);
    expect(
      (await page2.evaluate(() =>
        (window as unknown as ApiWindow).__fplanApi.getScoringIntents(),
      )).intents,
    ).toEqual([]);

    // THE CLAIM THE WHOLE DESIGN MAKES: the finished record is byte-equal to
    // an uninterrupted session's, wall-clock stamps masked — the completion
    // was the SAME measurement, not a lookalike taken later.
    const healedLedger = await readOpfsText(page2, 'networth.json');
    expect(maskLedger(healedLedger)).toBe(maskLedger(controlLedger));

    // And on screen: a percentage, like any scored row.
    await scoreCell
      .locator('span[title*="Scored"]')
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    expect(await scoreCell.innerText()).toMatch(/%/);
    await page2.close();
  }, 420_000);

  it('MOVED: kill, edit the plan, reopen → honestly unmeasured with the reason, intent cleared', async () => {
    const { context, page } = await newWorld();
    await bootApp(page);

    await page.evaluate(
      (homeValue: number) =>
        (window as unknown as ApiWindow).__fplanApi.takeNetWorthSnapshot({ homeValue }),
      HOME_VALUE,
    );
    const deadline = Date.now() + 60_000;
    while (!(await opfsFileExists(page, '.scoring-intent.json'))) {
      if (Date.now() > deadline) throw new Error('the intent file never appeared');
      await new Promise((r) => setTimeout(r, 25));
    }
    await page.close();

    // The world moves while the app is closed: the plan is edited (here, on a
    // blank seed page over the same OPFS — the moral equivalent of any other
    // writer or another day's editing session).
    const page2 = await context.newPage();
    page2.on('pageerror', (err) => pageErrors.push(String(err)));
    await page2.goto(`${staticServer.origin}/__seed.html`);
    await page2.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory();
      const root = await opfs.getDirectoryHandle('fplan-data');
      const handle = await root.getFileHandle('plan.json');
      const plan = JSON.parse(await (await handle.getFile()).text()) as {
        events: { date: string }[];
      };
      plan.events[0].date = '2036-01'; // a different retirement — a different run
      const writable = await handle.createWritable();
      await writable.write(`${JSON.stringify(plan, null, 2)}\n`);
      await writable.close();
    });

    // REOPEN. Boot healing computes today's runKey, finds it moved, stamps
    // the reason, clears the intent — before any page reads the row.
    await bootApp(page2);
    expect(
      (await page2.evaluate(() =>
        (window as unknown as ApiWindow).__fplanApi.getScoringIntents(),
      )).intents,
    ).toEqual([]);

    const rows = await page2.evaluate(() =>
      (window as unknown as ApiWindow).__fplanApi.getNetWorth(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBeUndefined();
    expect(rows[0].scoreError).toContain('a figure computed now would belong to now');
    expect(await opfsFileExists(page2, '.scoring-intent.json')).toBe(false);

    // On screen: the permanent no-score reading with the reason in full — and
    // no Finish button anywhere, because finishing would be dishonest.
    await page2.getByRole('button', { name: 'Net worth' }).click();
    const scoreCell = page2.locator('tbody tr').first().locator('td').nth(4);
    await scoreCell.locator('.flag', { hasText: 'no score' }).waitFor({ timeout: 60_000 });
    expect(await page2.getByRole('button', { name: 'Finish scoring' }).count()).toBe(0);
    expect(await page2.locator('.field-help', { hasText: 'belong to now' }).count()).toBe(1);
    await page2.close();
  }, 420_000);

  it('threw no page error in any leg', () => {
    expect(pageErrors).toEqual([]);
  });
});
