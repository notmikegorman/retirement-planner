/**
 * PHASE 3'S BROWSER GATES, in real headless Chromium against real OPFS:
 *
 *   1. THE DRIVER CONTRACT — the same case list the node:fs and in-memory
 *      drivers pass in the node lane (tests/store/fileStoreContract.ts),
 *      run against the FileSystemDirectoryHandle driver. The case-name lists
 *      are pinned equal across lanes, so the three drivers can never drift
 *      apart silently.
 *   2. THE PORTED STORE SUITE — the store-behaviour cases from the server
 *      test files (tests/store/storeSuite.ts), same pinning.
 *   3. THE GOLDEN CROSS-DRIVER GATE — one scripted session over the ported
 *      store surface (tests/golden/goldenStoreSequence.ts) executed against
 *      a node temp dir HERE and against OPFS IN THE PAGE; the two trees must
 *      be byte-identical modulo the enumerated masks. This is the Phase-3
 *      equivalent of the commit-to-commit golden-folder diff: same code,
 *      different driver, same bytes.
 *   4. THE WRITER GUARD — Web Locks exclusion proven with two real tabs of
 *      one browser profile, plus the lease-file refusal/takeover/sync-
 *      conflict behaviour on the real driver.
 *
 * Same lane discipline as parity.test.ts: self-contained, offline, ephemeral
 * port, any off-origin request aborted and failed.
 */
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createNodeFileStore } from '../../src/server/fileStore';
import { createStores } from '../../src/store';
import { DEFAULT_HEARTBEAT_MS, STALE_AFTER_BEATS } from '../../src/store/writerLease';
import { fileStoreContractCases } from '../store/fileStoreContract';
import { storeSuiteCases } from '../store/storeSuite';
import {
  maskGoldenTree,
  runGoldenFreshSequence,
  runGoldenLegacySequence,
  treeSnapshot,
} from '../golden/goldenStoreSequence';
import { buildParityHarness, HARNESS_OUT_DIR } from './buildHarness';
import { serveStatic, type StaticServer } from './staticServer';
import type { StoreWindow } from './harness/storeMain';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');
const vtiFixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'yahoo-chart-vti.json'), 'utf8'),
) as unknown;

const contractNames = fileStoreContractCases().map((c) => c.name);
const suiteNames = storeSuiteCases().map((c) => c.name);

/** Point at the first differing byte with context, like the parity gate. */
function assertByteEqual(label: string, nodeText: string, browserText: string): void {
  if (nodeText === browserText) return;
  let i = 0;
  const max = Math.min(nodeText.length, browserText.length);
  while (i < max && nodeText[i] === browserText[i]) i++;
  const from = Math.max(0, i - 90);
  throw new Error(
    `GOLDEN CROSS-DRIVER BROKEN for ${label}: node and OPFS produced different bytes ` +
      `(first divergence at char ${i} of ${nodeText.length}/${browserText.length}).\n` +
      `  node: …${nodeText.slice(from, i + 90)}…\n` +
      `  opfs: …${browserText.slice(from, i + 90)}…\n` +
      'If the divergence is a new no-seam wall-clock/randomness stamp, it must be added ' +
      'to maskGoldenTree AND the mask list in goldenStoreSequence.ts (and the harness ' +
      'header it mirrors). Anything else is a real store-driver fork — find it before ' +
      'touching the masks.',
  );
}

describe('browser storage engine (OPFS, real Chromium)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let page2: Page;
  let server: StaticServer;
  const pageErrors: string[] = [];
  const tmpDirs: string[] = [];

  // Playwright's evaluate passes ONE serializable argument; the page's
  // window is reached inside the callback, exactly as parity.test.ts does.
  const store = (p: Page) => ({
    evaluate: <T>(fn: (arg: string) => T | Promise<T>, arg = ''): Promise<T> =>
      p.evaluate(fn as never, arg) as Promise<T>,
  });

  beforeAll(async () => {
    await buildParityHarness();
    server = await serveStatic(HARNESS_OUT_DIR);
    browser = await chromium.launch();
    // ONE context, TWO pages: the Web Locks scenarios only mean something if
    // both tabs share a browser profile — separate contexts would be separate
    // profiles, where Web Locks (correctly) do not reach and the test would
    // prove nothing.
    context = await browser.newContext();
    const origin = server.origin;
    await context.route('**/*', (route) => {
      if (route.request().url().startsWith(`${origin}/`)) return route.continue();
      pageErrors.push(`blocked off-origin request: ${route.request().url()}`);
      return route.abort();
    });
    const wire = (p: Page): void => {
      p.on('pageerror', (err) => pageErrors.push(String(err)));
      p.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text());
      });
    };
    page = await context.newPage();
    wire(page);
    await page.goto(`${origin}/store.html`);
    await page.waitForFunction(
      () => (window as unknown as { __store?: { ready?: boolean } }).__store?.ready === true,
      undefined,
      { timeout: 30000 },
    );
    // The second tab attaches with ?keep so it does not wipe the first's root.
    page2 = await context.newPage();
    wire(page2);
    await page2.goto(`${origin}/store.html?keep`);
    await page2.waitForFunction(
      () => (window as unknown as { __store?: { ready?: boolean } }).__store?.ready === true,
      undefined,
      { timeout: 30000 },
    );
  }, 240000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('runs the same driver-contract case list as the node lane — pinned', async () => {
    const names = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.contractCaseNames);
    expect(names).toEqual(contractNames);
  });

  it('runs the same ported store suite case list as the node lane — pinned', async () => {
    const names = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.suiteCaseNames);
    expect(names).toEqual(suiteNames);
    // The port budgeted for a substantial count; shrinking it must go red.
    expect(suiteNames.length).toBeGreaterThanOrEqual(70);
  });

  describe('FileStore contract: OPFS driver', () => {
    for (const name of contractNames) {
      it(name, async () => {
        await store(page).evaluate((n) => (window as unknown as StoreWindow).__store.runContractCase(n), name);
      });
    }
  });

  describe('ported store suite: OPFS driver', () => {
    for (const name of suiteNames) {
      it(name, async () => {
        await store(page).evaluate((n) => (window as unknown as StoreWindow).__store.runSuiteCase(n), name);
      });
    }
  });

  it('golden cross-driver: the same session writes byte-identical trees on node and OPFS', async () => {
    // Node side: the same shared sequence, the real fs driver, temp folders.
    const nodeTrees: Record<'fresh' | 'legacy', Record<string, string>> = {
      fresh: {},
      legacy: {},
    };
    for (const which of ['fresh', 'legacy'] as const) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `fplan-golden-${which}-`));
      tmpDirs.push(dir);
      const files = createNodeFileStore(() => dir);
      const defaults = createNodeFileStore(() => defaultsDir);
      const ctx = { files, defaults, stores: createStores({ files, defaults }), vtiFixture };
      if (which === 'fresh') await runGoldenFreshSequence(ctx);
      else await runGoldenLegacySequence(ctx);
      nodeTrees[which] = maskGoldenTree(await treeSnapshot(files));
    }

    // Browser side: same sequence, the OPFS driver, bundled defaults.
    const browserTrees = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.golden());

    for (const which of ['fresh', 'legacy'] as const) {
      const nodeTree = nodeTrees[which];
      const browserTree = browserTrees[which];
      expect(Object.keys(browserTree).sort()).toEqual(Object.keys(nodeTree).sort());
      for (const [rel, nodeText] of Object.entries(nodeTree)) {
        assertByteEqual(`${which}/${rel}`, nodeText, browserTree[rel]);
      }
    }

    // Anti-vacuity: the comparison must have covered the whole seeded surface
    // plus every record file the sequence writes.
    const freshFiles = Object.keys(nodeTrees.fresh);
    expect(freshFiles.length).toBeGreaterThanOrEqual(14);
    for (const expected of [
      'profile.json',
      'profile.starter.json',
      'plan.json',
      'plan-history.json',
      'networth.json',
      'quotes.json',
      'assumptions/market.json',
      'assumptions/historical-returns.csv',
      'assumptions/tax/federal-2026.json',
    ]) {
      expect(freshFiles).toContain(expected);
    }
    expect(Object.keys(nodeTrees.legacy)).toContain('scenarios/trap-case.json');
  });

  describe('the writer guard (Web Locks + lease) on the real driver', () => {
    it('acquires a free folder, writes the lease, and release removes it', async () => {
      const r = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('solo', 'client-a', 'Tab One'));
      expect(r.ok).toBe(true);
      expect(r.takeoverNote).toBeNull();
      expect(await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseHolder('solo'))).toBe('client-a');
      const released = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseRelease('solo'));
      expect(released.leaseGone).toBe(true);
    });

    it('a second TAB of the same profile is refused by Web Locks, and freed by release', async () => {
      const first = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('shared', 'client-a', 'Tab One'));
      expect(first.ok).toBe(true);
      // The second tab loses at the Web Locks layer — before the lease file
      // is even consulted — because within one profile that layer is airtight
      // and instant.
      const second = await store(page2).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('shared', 'client-b', 'Tab Two'));
      expect(second.ok).toBe(false);
      expect(second.reason).toBe('tab');
      expect(second.message).toContain('Another tab');
      // Release frees both layers; the second tab can now take the folder.
      await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseRelease('shared'));
      const retry = await store(page2).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('shared', 'client-b', 'Tab Two'));
      expect(retry.ok).toBe(true);
      expect(await store(page2).evaluate(() => (window as unknown as StoreWindow).__store.leaseHolder('shared'))).toBe('client-b');
      await store(page2).evaluate(() => (window as unknown as StoreWindow).__store.leaseRelease('shared'));
    });

    it('respects a FRESH foreign lease: refused, holder named — like .writer.lock today', async () => {
      // A lease from "another machine": no Web Lock held anywhere (different
      // folderId than any held guard), file fresh by its own heartbeat math.
      const foreign = JSON.stringify({
        holder: { clientId: 'client-far', label: 'Chrome on other-machine' },
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        renewedAt: new Date().toISOString(),
        heartbeatMs: DEFAULT_HEARTBEAT_MS,
      });
      await store(page).evaluate((raw) => (window as unknown as StoreWindow).__store.leaseWrite('foreign', '.writer.lease', raw), foreign);
      const r = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('foreign', 'client-a', 'Tab One'));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('held');
      expect(r.message).toContain('Chrome on other-machine');
      expect(r.message).toContain('ADVISORY across machines');
      // The foreign lease was not touched.
      expect(await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseHolder('foreign'))).toBe('client-far');
    });

    it('takes over a STALE lease with a logged note', async () => {
      const staleAge = DEFAULT_HEARTBEAT_MS * STALE_AFTER_BEATS + 60_000;
      const stale = JSON.stringify({
        holder: { clientId: 'client-dead', label: 'a crashed tab' },
        acquiredAt: new Date(Date.now() - staleAge - 60_000).toISOString(),
        renewedAt: new Date(Date.now() - staleAge).toISOString(),
        heartbeatMs: DEFAULT_HEARTBEAT_MS,
      });
      await store(page).evaluate((raw) => (window as unknown as StoreWindow).__store.leaseWrite('stale', '.writer.lease', raw), stale);
      const r = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('stale', 'client-a', 'Tab One'));
      expect(r.ok).toBe(true);
      expect(r.takeoverNote).toContain('a crashed tab');
      expect(await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseHolder('stale'))).toBe('client-a');
      await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseRelease('stale'));
    });

    it('refuses to open a folder carrying sync-conflict artifacts until resolved', async () => {
      await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseWrite('conflicted', '.plan.json.icloud', ''));
      const r = await store(page).evaluate(() => (window as unknown as StoreWindow).__store.leaseAcquire('conflicted', 'client-a', 'Tab One'));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('sync-conflict');
      expect(r.message).toContain('.plan.json.icloud');
      expect(r.message).toContain('Resolve them');
    });
  });

  it('made no off-origin request and threw no page error', () => {
    expect(pageErrors).toEqual([]);
  });
});
