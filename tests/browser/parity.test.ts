/**
 * THE PARITY GATE: the browser-built engine, fed the same SimulationInput,
 * produces the same RunResult BYTES as the Node engine — not "close",
 * byte-identical.
 *
 * Nothing else in the port is allowed to matter until this holds: every later
 * phase compares bytes (record files, cache keys, golden digests), and the
 * failure this gate exists to prevent is the quiet one — a bundler transform
 * or lib difference shipping plausible-but-different numbers on real money
 * questions, with every screen still rendering.
 *
 * Mechanics (browser-port plan §3):
 *   1. Both sides build IDENTICAL inputs with the same code (parityCases.ts)
 *      from the same bundled defaults — Node reads the files, the harness
 *      bundle embeds them.
 *   2. The Node side runs execute() in this process. The browser side is the
 *      REAL pipeline: Vite-built bundle, real Web Worker, real headless
 *      Chromium (not jsdom — a fake would test the fake).
 *   3. Each side serializes ITS OWN result with the same shared
 *      scrub+stableStringify code (parityScrub.ts), and the gate compares the
 *      two strings byte for byte. meta.hashes, meta.runKey and engineVersion
 *      ride inside that comparison and are ALSO asserted individually,
 *      because those are the bytes the content-keyed run cache lives on: a
 *      runKey fork breaks nothing visibly — it just silently orphans every
 *      cached run.
 *   4. The ONLY exclusions are the enumerated wall-clock fields, pinned below
 *      — see parityScrub.ts for why the list is data, not judgment.
 *
 * The lane is self-contained and offline: it builds the harness itself, serves
 * it on an OS-assigned ephemeral port (never :5174/:5599 — on this machine
 * those may be a live app on real data), and aborts any request that leaves
 * that origin.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { execute } from '../../src/engine/index';
import { ENGINE_VERSION } from '../../src/shared/types';
import type { RunResult } from '../../src/shared/types';
import { buildParityCases, type ParityRawDefaults } from './parityCases';
import { PARITY_EXCLUDED_FIELDS, parityText } from './parityScrub';
import { buildParityHarness, HARNESS_OUT_DIR } from './buildHarness';
import { serveStatic, type StaticServer } from './staticServer';
import type { ParityRunReply, ParityWindow } from './harness/main';

function readDefault(rel: string): string {
  return readFileSync(new URL(`../../data-defaults/${rel}`, import.meta.url), 'utf8');
}

/** The same bytes the harness bundles, acquired the Node way. */
function rawDefaultsFromDisk(): ParityRawDefaults {
  const json = (rel: string): unknown => JSON.parse(readDefault(rel));
  return {
    historicalCsv: readDefault('assumptions/historical-returns.csv'),
    market: json('assumptions/market.json'),
    federal: json('assumptions/tax/federal-2026.json'),
    va: json('assumptions/tax/va-2026.json'),
    sc: json('assumptions/tax/sc-2026.json'),
    nc: json('assumptions/tax/nc-2026.json'),
    socialSecurity: json('assumptions/social-security.json'),
    medicare: json('assumptions/medicare-2026.json'),
    aca: json('assumptions/aca-2026.json'),
    rmd: json('assumptions/rmd-table.json'),
    starterProfile: json('profile.starter.json'),
    scenarios: {
      baseCase: json('scenarios/base-case.json'),
      downsizeCash: json('scenarios/downsize-cash.json'),
      retireSepp: json('scenarios/retire-2030-sepp.json'),
    },
  };
}

const cases = buildParityCases(rawDefaultsFromDisk());

/**
 * Point at the first differing byte instead of dumping two multi-megabyte
 * strings: a fan array diverging at year 31 should read as one line of
 * context, not a wall the reader scrolls past.
 */
function assertByteEqual(caseId: string, nodeText: string, browserText: string): void {
  if (nodeText === browserText) return;
  let i = 0;
  const max = Math.min(nodeText.length, browserText.length);
  while (i < max && nodeText[i] === browserText[i]) i++;
  const from = Math.max(0, i - 90);
  throw new Error(
    `PARITY BROKEN for case '${caseId}': Node and Chromium produced different bytes ` +
      `(first divergence at char ${i} of ${nodeText.length}/${browserText.length}).\n` +
      `  node:    …${nodeText.slice(from, i + 90)}…\n` +
      `  browser: …${browserText.slice(from, i + 90)}…\n` +
      'If the divergence is a new wall-clock field, it must be added to ' +
      'PARITY_EXCLUDED_FIELDS *and* to the pin in this file. Anything else is a ' +
      'real engine-environment fork — find it before touching the gate.',
  );
}

describe('browser/Node engine parity', () => {
  let browser: Browser;
  let page: Page;
  let server: StaticServer;
  const pageErrors: string[] = [];
  /** Browser replies kept by case id, for the cross-test reuse assertions. */
  const browserReplies = new Map<string, ParityRunReply>();

  beforeAll(async () => {
    await buildParityHarness();
    server = await serveStatic(HARNESS_OUT_DIR);
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text());
    });
    // Defense in depth: the harness is built to make no request beyond its own
    // bundle, and this proves it — anything aimed off-origin (a dev server on
    // :5174/:5599, the network) is aborted, not just unexpected.
    const origin = server.origin;
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(`${origin}/`)) return route.continue();
      pageErrors.push(`blocked off-origin request: ${route.request().url()}`);
      return route.abort();
    });
    await page.goto(`${origin}/`);
    await page
      .waitForFunction(() => (window as unknown as { __parity?: { ready?: boolean } }).__parity?.ready === true, undefined, { timeout: 30000 })
      .catch(() => {
        throw new Error(
          `the parity harness never became ready. Page errors:\n${pageErrors.join('\n') || '(none captured)'}`,
        );
      });
  }, 240000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('pins the exclusion list: wall-clock fields only, enumerated, nothing else', () => {
    // Growing PARITY_EXCLUDED_FIELDS without editing this line fails the gate
    // — an exclusion is a claim that a field is a measurement of the machine,
    // and that claim gets made here, in review, never as a scrub side effect.
    expect([...PARITY_EXCLUDED_FIELDS]).toEqual(['elapsedMs']);
  });

  it('drives the same case list on both sides', async () => {
    const browserIds = await page.evaluate(() => (window as unknown as ParityWindow).__parity.caseIds);
    expect(browserIds).toEqual(cases.map((c) => c.id));
    // The fixture requirements, pinned: losing a case silently would shrink
    // the gate's coverage with nothing going red.
    expect(cases.some((c) => c.input.paths === 10000)).toBe(true);
    expect(cases.some((c) => c.input.scenario.name.includes('—'))).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it('bakes the same ENGINE_VERSION into the browser bundle', async () => {
    const bundled = await page.evaluate(() => (window as unknown as ParityWindow).__parity.engineVersion);
    expect(bundled).toBe(ENGINE_VERSION);
  });

  for (const c of cases) {
    it(`${c.id}: byte-equal RunResult, runKey, hashes across Node and Chromium`, async () => {
      const nodeResult: RunResult = execute(c.input);
      // The exclusion must be scrubbing something real: if elapsedMs ever
      // stopped being produced, the excluded-list pin would be stale.
      expect(typeof nodeResult.elapsedMs).toBe('number');

      const reply = await page.evaluate(
        (id) => (window as unknown as ParityWindow).__parity.run(id),
        c.id,
      );
      browserReplies.set(c.id, reply);

      // The pointed assertions first, for failure messages that name the
      // broken thing: these are the bytes the run cache is keyed on.
      expect(reply.meta.engineVersion).toBe(nodeResult.meta.engineVersion);
      expect(reply.meta.hashes).toEqual(nodeResult.meta.hashes);
      expect(reply.meta.runKey).toBe(nodeResult.meta.runKey);
      // createdAt is deliberately '' from the engine (the server stamps it);
      // a non-empty value here means something started reading a clock.
      expect(reply.meta.createdAt).toBe('');
      expect(nodeResult.meta.createdAt).toBe('');

      // The gate itself. The length floor guards against the comparison going
      // VACUOUS — two sides agreeing on '{}' because a scrub bug deleted the
      // result would otherwise pass byte-equality forever.
      expect(reply.text.length).toBeGreaterThan(10000);
      assertByteEqual(c.id, parityText(nodeResult), reply.text);

      // Progress protocol: frames are throttled by the worker to >=2%
      // advances, every run ends on a frame of exactly 1 (the engine's own
      // guarantee), and progress never runs backwards.
      const fracs = reply.progressFracs;
      expect(fracs.length).toBeGreaterThanOrEqual(1);
      expect(fracs[fracs.length - 1]).toBe(1);
      for (let i = 1; i < fracs.length; i++) {
        expect(fracs[i]).toBeGreaterThanOrEqual(fracs[i - 1]);
        expect(fracs[i] - fracs[i - 1] >= 0.02 || fracs[i] >= 1).toBe(true);
      }
    });
  }

  it('10,000-path run streams throttled progress, not a firehose and not silence', () => {
    const reply = browserReplies.get('sepp-bridge-mc10000');
    expect(reply).toBeDefined();
    // ~50 frames at a 2% throttle; the wide band tolerates coarser engine
    // reporting without ever tolerating 10,000 frames or 1.
    expect(reply!.progressFracs.length).toBeGreaterThanOrEqual(10);
    expect(reply!.progressFracs.length).toBeLessThanOrEqual(60);
  });

  it('reports a malformed input as an error message, not a dead worker', async () => {
    const outcome = await page.evaluate(() =>
      (window as unknown as ParityWindow).__parity.runRaw({ not: 'a SimulationInput' }),
    );
    expect(outcome.type).toBe('error');
    expect(outcome.error).toBeTruthy();
  });

  it('the reused worker still computes byte-equal results after an error', async () => {
    // Phase 4 holds ONE worker for the tab's lifetime, so a run that follows a
    // failed run must be as good as a first run — same bytes as this file
    // already proved for the same case on the same worker.
    const first = browserReplies.get('starter-base-deterministic');
    expect(first).toBeDefined();
    const again = await page.evaluate(
      (id) => (window as unknown as ParityWindow).__parity.run(id),
      'starter-base-deterministic',
    );
    assertByteEqual('starter-base-deterministic (after error)', first!.text, again.text);
  });

  it('made no off-origin request and threw no page error', () => {
    expect(pageErrors).toEqual([]);
  });
});
