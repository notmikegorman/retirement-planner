/**
 * THE DUAL-STACK GATE: the same scripted session, driven through the REAL UI
 * twice — once against the Node server (spawned privately on an OS-assigned
 * ephemeral port over a temp data dir; never :5599/:5174), once in local mode
 * over seeded OPFS — and the two worlds compared at the end:
 *
 *   - every runs/<runKey>.json byte-equal modulo the createdAt stamp, with
 *     the FILENAMES equal too (a runKey fork breaks nothing visibly — it just
 *     silently orphans every cached run, which is why it is asserted here and
 *     not left to the parity gate alone);
 *   - the store folders byte-equal under the enumerated masks (the golden
 *     masks plus the drive's own real-clock stamps — every mask is a claim
 *     that a field measures the machine, listed here in review);
 *   - the UI states consistent: same verdict, same chips, same score cells,
 *     same refusal sentence.
 *
 * The session (browser-port plan, Phase 4 gate): boot → cached-final-run
 * check (nothing falsely restored on a cold folder; the final run IS restored
 * after a reload — commit 243ee48's contract) → a plan edit (the daily guard
 * files the day-start version) → the quick run completes → Run now (quotes
 * through the injected/fixture fetcher, then a final-quality run) → a
 * net-worth snapshot with score + spend attached → a history version scored →
 * the immutability refusal (a second score is refused with the recorded
 * sentence) → restore that version. Local mode additionally proves the writer
 * guard end-to-end: a second tab of the same profile gets the guard's own
 * refusal page while the first holds the folder.
 *
 * PHASE 5 EXTENDS THE GATE with the search legs: the same small-but-real
 * search request (two axes, drive-scale paths, fixed seeds, attribution +
 * polish + the per-seed spend bisection all on) driven through each stack's
 * own seam — HTTP for the server, window.__fplanApi for local mode, where it
 * runs in the coordinator worker over a Web Worker pool. The persisted
 * searches/<id>.json reports must be byte-equal under the enumerated masks
 * (searchId, createdAt, elapsedMs — ids and wall clock, nothing else), the
 * slim score-cache trees equal INCLUDING their runKey filenames, and a second
 * oversized search cancelled mid-flight must leave the same truncated
 * partial-report shape on both stacks, wording compared verbatim.
 *
 * Lane discipline as everywhere else in tests/browser: self-contained,
 * offline (every off-origin request aborted), ephemeral ports, temp dirs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Scenario, SearchProgress, SearchReport, SearchRequest } from '../../src/shared/types';
import { maskGoldenTree } from '../golden/goldenStoreSequence';
import {
  DRIVE_HOME_VALUE,
  DRIVE_LIVING_OVERRIDE,
  DRIVE_NOTE,
  DRIVE_PATHS_FINAL,
  DRIVE_PATHS_INTERACTIVE,
  VTI_FIXTURE_TEXT,
  driveCancelSearchRequest,
  driveSearchRequest,
  driveSeedFiles,
} from './driveFixtures';
import { serveStatic, type StaticServer } from './staticServer';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const distUi = path.join(repoRoot, 'dist', 'ui');

/** Guard artifacts, not records: each stack's writer machinery leaves its own. */
const TREE_EXCLUDED = new Set(['.writer.lock', '.writer.lease', '.last-browser-open']);

// ---------------------------------------------------------------------------
// Small machinery
// ---------------------------------------------------------------------------

/** Poll until fn() is truthy; the label names what never came true. */
async function until<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  label: string,
  timeoutMs = 180_000,
  stepMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = undefined as T;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; last saw: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** An OS-assigned free port, released immediately for the server to take. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no TCP port assigned'));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

/** Every file under dir as {relPath → text}, sorted, guard artifacts excluded. */
async function nodeTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(abs: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (TREE_EXCLUDED.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(path.join(abs, entry.name), rel);
      else out[rel] = await fs.readFile(path.join(abs, entry.name), 'utf8');
    }
  }
  await walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The drive's masks ON TOP of the golden ones: the session runs on the real
 * clock (a scripted UI cannot inject `now` through a form), so every
 * wall-clock stamp the stores write without a seam is masked — and nothing
 * else. Values, hashes, run keys, prices, spend figures all stay compared.
 */
function maskDriveTree(tree: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(maskGoldenTree(tree))) {
    let masked = text;
    if (rel === 'networth.json' || rel === 'plan-history.json') {
      masked = masked.replace(/^(\s*)"scoredAt": "[^"]+"/gm, '$1"scoredAt": "MASKED"');
    }
    if (rel === 'plan-history.json') {
      // The entry id's time36 prefix is the REAL clock here (the golden
      // sequence pins it; the drive cannot), so the whole id masks — and
      // takenAt with it. maskGoldenTree already replaced the random suffix,
      // so the pattern accepts either the hex or its MASKED stand-in.
      masked = masked.replace(
        /"id": "ph-[0-9a-z]+-(?:[0-9a-f]{6}|MASKED)"/g,
        '"id": "ph-MASKED"',
      );
      masked = masked.replace(/^(\s*)"takenAt": "[^"]+"/gm, '$1"takenAt": "MASKED"');
    }
    if (rel === 'quotes.json') {
      masked = masked.replace(/^(\s*)"fetchedAt": "[^"]+"/gm, '$1"fetchedAt": "MASKED"');
    }
    if (rel.startsWith('runs/')) {
      masked = masked.replace(/^(\s*)"createdAt": "[^"]+"/gm, '$1"createdAt": "MASKED"');
      // The run's own wall-clock timing — the SAME exclusion the parity gate
      // pins (PARITY_EXCLUDED_FIELDS = ['elapsedMs']): a measurement of the
      // machine, not of the plan.
      masked = masked.replace(/^(\s*)"elapsedMs": [0-9.eE+-]+/gm, '$1"elapsedMs": "MASKED"');
    }
    let outRel = rel;
    if (rel.startsWith('searches/scores/')) {
      // Slim scores are compact JSON; elapsedMs is the one machine measurement
      // in them. The FILENAMES (runKeys) are deliberately not masked — the
      // cross-backend runKey agreement is half of what this gate exists to pin.
      masked = masked.replace(/"elapsedMs":[0-9.eE+-]+/g, '"elapsedMs":"MASKED"');
    } else if (/^searches\/[0-9a-z]{8,40}\.json$/.test(rel)) {
      // The completed search's report. Exactly one exists at snapshot time
      // (the cancel leg runs after the trees are read); its NAME is the
      // searchId — timestamp36 + random, a different id per stack by
      // construction — so the file is renamed to a fixed key and the id
      // masked inside. createdAt/elapsedMs are the machine's clock, same as
      // everywhere. Scores, runKeys, rankings, verdict sentences, caveats,
      // hashes all stay compared verbatim.
      outRel = 'searches/REPORT.json';
      masked = masked
        .replace(/^(\s*)"searchId": "[^"]+"/gm, '$1"searchId": "MASKED"')
        .replace(/^(\s*)"createdAt": "[^"]+"/gm, '$1"createdAt": "MASKED"')
        .replace(/^(\s*)"elapsedMs": [0-9.eE+-]+/gm, '$1"elapsedMs": "MASKED"');
    }
    out[outRel] = masked;
  }
  // Re-sorted after the rename so key ORDER (asserted below via toEqual on the
  // key lists) cannot depend on where each stack's searchId happened to sort.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Point at the first differing byte with context (the lane's house diff). */
function assertByteEqual(label: string, nodeText: string, localText: string): void {
  if (nodeText === localText) return;
  let i = 0;
  const max = Math.min(nodeText.length, localText.length);
  while (i < max && nodeText[i] === localText[i]) i++;
  const from = Math.max(0, i - 90);
  throw new Error(
    `DUAL-STACK FORK in ${label}: the two stacks wrote different bytes ` +
      `(first divergence at char ${i} of ${nodeText.length}/${localText.length}).\n` +
      `  node:  …${nodeText.slice(from, i + 90)}…\n` +
      `  local: …${localText.slice(from, i + 90)}…\n` +
      'If the divergence is a new no-seam wall-clock/randomness stamp, add it to ' +
      'maskDriveTree WITH its justification. Anything else is a real backend fork — ' +
      'find it before touching the masks.',
  );
}

// ---------------------------------------------------------------------------
// The search legs — Phase 5's extension of this gate
// ---------------------------------------------------------------------------

const TERMINAL_SEARCH = new Set(['done', 'error', 'cancelled']);

/** What a mid-flight cancel leaves behind; compared verbatim across stacks. */
interface CancelShape {
  status: string;
  stageLabel: string;
  truncated: boolean;
  firstCaveat: string;
}

/** The node stack's seam is HTTP; this is api.ts's request(), test-side. */
async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(
    url,
    init?.body === undefined
      ? init
      : { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } },
  );
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `${res.status} for ${url}`);
  }
  return body;
}

/**
 * Run the drive's search to completion against the Node server and wait for
 * its report to reach the folder. The status flips to done BEFORE the report
 * is persisted (the manager sets progress, then awaits the write), so the
 * wait is on the FILE — the terminal state the folder comparison reads.
 */
async function nodeSearchLeg(origin: string, dataDir: string): Promise<void> {
  const base = await httpJson<Scenario>(`${origin}/api/plan`);
  const { searchId } = await httpJson<{ searchId: string }>(`${origin}/api/search`, {
    method: 'POST',
    body: JSON.stringify(driveSearchRequest(base)),
  });
  const done = await until(
    () => httpJson<SearchProgress>(`${origin}/api/search/${searchId}`),
    (p) => TERMINAL_SEARCH.has(p.status),
    'the node search to finish',
    480_000,
    500,
  );
  expect(done.status).toBe('done');
  await until(
    () =>
      fs.access(path.join(dataDir, 'searches', `${searchId}.json`)).then(
        () => true,
        () => false,
      ),
    (ok) => ok,
    'the node search report to persist',
    60_000,
    250,
  );
}

/** Start the oversized cancel-leg search, stop it mid-flight, keep the shape. */
async function nodeCancelLeg(origin: string, dataDir: string): Promise<CancelShape> {
  const base = await httpJson<Scenario>(`${origin}/api/plan`);
  const { searchId } = await httpJson<{ searchId: string }>(`${origin}/api/search`, {
    method: 'POST',
    body: JSON.stringify(driveCancelSearchRequest(base)),
  });
  // Provably mid-flight: running, with real evaluations already burned.
  await until(
    () => httpJson<SearchProgress>(`${origin}/api/search/${searchId}`),
    (p) => p.status === 'running' && p.evaluated >= 3,
    'the node cancel-leg search to get going',
    240_000,
    100,
  );
  await httpJson<{ ok: true }>(`${origin}/api/search/${searchId}/cancel`, { method: 'POST' });
  const terminal = await until(
    () => httpJson<SearchProgress>(`${origin}/api/search/${searchId}`),
    (p) => TERMINAL_SEARCH.has(p.status),
    'the cancelled node search to settle',
    240_000,
    250,
  );
  const report = await httpJson<SearchReport>(`${origin}/api/search/${searchId}/report`);
  // A cancelled search persists its partial report like any other.
  await until(
    () =>
      fs.access(path.join(dataDir, 'searches', `${searchId}.json`)).then(
        () => true,
        () => false,
      ),
    (ok) => ok,
    'the cancelled node report to persist',
    60_000,
    250,
  );
  return {
    status: terminal.status,
    stageLabel: terminal.stageLabel,
    truncated: report.truncated,
    firstCaveat: report.caveats[0] ?? '',
  };
}

/** The local stack's seam is window.__fplanApi — the same object the UI calls. */
type SearchApiWindow = Window & {
  __fplanApi: {
    getPlan(): Promise<Scenario>;
    startSearch(req: SearchRequest): Promise<{ searchId: string }>;
    getSearch(id: string): Promise<SearchProgress>;
    getSearchReport(id: string): Promise<SearchReport>;
    cancelSearch(id: string): Promise<{ ok: true; stopping: boolean }>;
  };
};

async function localReportPersisted(page: Page, searchId: string, label: string): Promise<void> {
  await until(
    () =>
      page.evaluate(async (id: string) => {
        try {
          const opfs = await navigator.storage.getDirectory();
          const root = await opfs.getDirectoryHandle('fplan-data');
          const dir = await root.getDirectoryHandle('searches');
          await dir.getFileHandle(`${id}.json`);
          return true;
        } catch {
          return false;
        }
      }, searchId),
    (ok) => ok,
    label,
    60_000,
    250,
  );
}

async function localSearchLeg(page: Page): Promise<void> {
  // The SAME fixture request the node leg posts, built on THIS stack's own
  // saved plan (byte-equal across stacks by the Phase-4 half of this gate).
  const base = await page.evaluate(() =>
    (window as unknown as SearchApiWindow).__fplanApi.getPlan(),
  );
  const started = await page.evaluate(
    (req: SearchRequest) =>
      (window as unknown as SearchApiWindow).__fplanApi.startSearch(req),
    driveSearchRequest(base),
  );
  const done = await until(
    () =>
      page.evaluate(async (id: string) => {
        const p = await (window as unknown as SearchApiWindow).__fplanApi.getSearch(id);
        return { status: p.status, evaluated: p.evaluated, stageLabel: p.stageLabel };
      }, started.searchId),
    (p) => TERMINAL_SEARCH.has(p.status),
    'the local search to finish',
    480_000,
    500,
  );
  expect(done.status).toBe('done');
  await localReportPersisted(page, started.searchId, 'the local search report to persist');
}

/** Every OPFS file under fplan-data as {relPath → text}, read via the page. */
function readOpfsTree(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const root = await opfs.getDirectoryHandle('fplan-data');
    const out: Record<string, string> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const entry of dir.values()) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle, rel);
        } else {
          out[rel] = await (await (entry as FileSystemFileHandle).getFile()).text();
        }
      }
    };
    await walk(root, '');
    return out;
  });
}

async function localCancelLeg(page: Page): Promise<CancelShape> {
  const base = await page.evaluate(() =>
    (window as unknown as SearchApiWindow).__fplanApi.getPlan(),
  );
  const started = await page.evaluate(
    (req: SearchRequest) =>
      (window as unknown as SearchApiWindow).__fplanApi.startSearch(req),
    driveCancelSearchRequest(base),
  );
  await until(
    () =>
      page.evaluate(async (id: string) => {
        const p = await (window as unknown as SearchApiWindow).__fplanApi.getSearch(id);
        return { status: p.status, evaluated: p.evaluated };
      }, started.searchId),
    (p) => p.status === 'running' && p.evaluated >= 3,
    'the local cancel-leg search to get going',
    240_000,
    100,
  );
  // THE KILLED-TAB GUARD (decision D5), observed live: while a search is in
  // flight the local backend holds a beforeunload confirmation — a synthetic
  // cancelable dispatch reports defaultPrevented without closing anything.
  expect(
    await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  ).toBe(true);
  await page.evaluate(
    (id: string) => (window as unknown as SearchApiWindow).__fplanApi.cancelSearch(id),
    started.searchId,
  );
  const terminal = await until(
    () =>
      page.evaluate(async (id: string) => {
        const p = await (window as unknown as SearchApiWindow).__fplanApi.getSearch(id);
        return { status: p.status, stageLabel: p.stageLabel };
      }, started.searchId),
    (p) => TERMINAL_SEARCH.has(p.status),
    'the cancelled local search to settle',
    240_000,
    250,
  );
  const report = await page.evaluate(async (id: string) => {
    const r = await (window as unknown as SearchApiWindow).__fplanApi.getSearchReport(id);
    return { truncated: r.truncated, firstCaveat: r.caveats[0] ?? '' };
  }, started.searchId);
  await localReportPersisted(page, started.searchId, 'the cancelled local report to persist');
  // ... and the guard disarms the moment no search is in flight: closing the
  // tab now costs nothing, so the warning would be a cry of wolf.
  expect(
    await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
  ).toBe(false);
  return {
    status: terminal.status,
    stageLabel: terminal.stageLabel,
    truncated: report.truncated,
    firstCaveat: report.firstCaveat,
  };
}

// ---------------------------------------------------------------------------
// The scripted session — one function, both stacks
// ---------------------------------------------------------------------------

/** What the session saw on screen; compared verbatim across the stacks. */
interface DriveUiState {
  bootChip: string;
  finalChip: string;
  verdictAfterRunNow: string;
  reloadChip: string;
  reloadComputedChip: boolean;
  snapshotScoreCell: string;
  historyScoreLine: string;
  refusalMessage: string;
  verdictAfterRestore: string;
}

async function driveSession(page: Page, entryUrl: string): Promise<DriveUiState> {
  const verdict = page.locator('.verdict').first();
  const qualityChip = page.locator('.wb-chip').first();
  const provenance = page.locator('div.muted').filter({ hasText: '· run' }).first();

  // --- Boot: the quick run lands; nothing is falsely "restored" cold --------
  await page.goto(entryUrl);
  await verdict.waitFor({ state: 'visible', timeout: 180_000 });
  const bootChip = (await qualityChip.innerText()).trim();
  expect(bootChip).toBe(
    `Quick run · ${DRIVE_PATHS_INTERACTIVE.toLocaleString('en-US')} paths`,
  );

  // --- The plan edit: the daily guard's one chance to fire ------------------
  const runBefore = await provenance.innerText();
  await page
    .getByRole('tablist', { name: 'Plan inputs' })
    .getByRole('tab', { name: 'Spending' })
    .click();
  const livingBox = page.locator('#wb-input-panel-spending .pair-cell input').first();
  await livingBox.fill(String(DRIVE_LIVING_OVERRIDE));
  await livingBox.press('Enter');
  // The debounced save+run fire together; the provenance line changing is the
  // quick run for the EDITED plan landing on screen.
  await until(
    () => provenance.innerText(),
    (t) => t !== runBefore,
    'the edited plan’s quick run',
  );

  // --- Run now: fixture-fed refresh, then the final-quality run -------------
  await page.getByRole('button', { name: 'Run now' }).click();
  const finalChipLocator = page.locator('.wb-chip.good').filter({ hasText: 'Final quality' });
  await finalChipLocator.waitFor({ state: 'visible', timeout: 180_000 });
  const finalChip = (await finalChipLocator.innerText()).trim();
  expect(finalChip).toBe(`Final quality · ${DRIVE_PATHS_FINAL.toLocaleString('en-US')} paths`);
  const verdictAfterRunNow = (await verdict.innerText()).trim();

  // --- Reload: the cached-final-run contract (commit 243ee48) ---------------
  // A page load with a final-quality answer on disk shows THAT, not a quick
  // recompute that disagrees with it: the chip reading "Final quality" right
  // after boot is the structural proof (a non-restoring load runs quick), and
  // the "Computed …" chip states the moment honestly.
  await page.reload();
  await verdict.waitFor({ state: 'visible', timeout: 180_000 });
  await finalChipLocator.waitFor({ state: 'visible', timeout: 180_000 });
  const reloadChip = (await finalChipLocator.innerText()).trim();
  const reloadComputedChip = await page
    .locator('.wb-chip')
    .filter({ hasText: 'Computed' })
    .isVisible();

  // --- The snapshot: row now, score + spend when the simulations land -------
  await page.getByRole('button', { name: 'Net Worth' }).click();
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  const dialogInputs = page.locator('dialog input');
  await dialogInputs.first().fill(String(DRIVE_HOME_VALUE));
  await dialogInputs.first().press('Enter');
  await dialogInputs.nth(1).fill(DRIVE_NOTE);
  await dialogInputs.nth(1).press('Tab');
  await page.locator('dialog button.primary').click();
  const scoreCell = page.locator('tbody tr').first().locator('td').nth(4);
  const snapshotScoreCell = (
    await until(
      () => scoreCell.innerText().catch(() => ''),
      (t) => /%/.test(t),
      'the snapshot’s score to attach',
      300_000,
    )
  ).trim();
  // The spend solve lands AFTER the success score (a dozen serialized runs on
  // one worker), and a slow runner can walk through that window: CI once read
  // the row between the two attaches and every later folder assertion
  // inherited the miss. Wait for the terminal state through the seam itself.
  await until(
    () =>
      page.evaluate(async () => {
        const api = (
          window as unknown as {
            __fplanApi: { getNetWorth(): Promise<{ score?: { sustainableSpend?: number } }[]> };
          }
        ).__fplanApi;
        const rows = await api.getNetWorth();
        return rows.some((r) => r.score?.sustainableSpend !== undefined) ? 'done' : '';
      }),
    (t) => t === 'done',
    'the snapshot’s sustainable-spend figure to attach',
    300_000,
  );

  // --- Score the day-start version, then the refusal, then restore it -------
  await page.getByRole('button', { name: 'Workbench' }).click();
  await page
    .getByRole('tablist', { name: 'Plan inputs' })
    .getByRole('tab', { name: 'History' })
    .click();
  await page.getByRole('button', { name: 'Score it' }).click();
  const scoreLine = page.locator('.hist-score').first();
  const historyScoreLine = (
    await until(
      () => scoreLine.innerText().catch(() => ''),
      // Terminal state only: the success score alone is an INTERMEDIATE render
      // (the spend solve is still running behind it), and accepting it let a
      // slow CI runner move on before the figure landed — permanently, since
      // nothing re-scores a scored version. The spend phrase is the proof the
      // whole attach finished.
      (t) => /\/yr sustainable living spend/.test(t),
      'the history version’s score AND spend figure to attach',
      300_000,
    )
  ).trim();

  // The refusal the UI deliberately draws no button for, asserted through the
  // seam itself (window.__fplanApi — the same object on both backends).
  const refusalMessage = await page.evaluate(async () => {
    const api = (window as unknown as { __fplanApi: { planHistory(): Promise<{ id: string }[]>; scorePlanVersion(id: string): Promise<unknown> } }).__fplanApi;
    const entries = await api.planHistory();
    try {
      await api.scorePlanVersion(entries[0].id);
      return 'NO-REFUSAL';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });
  expect(refusalMessage).toContain('already has a score');

  // Restore: an ordinary guarded save of the version's plan. The workbench
  // re-runs against it — and lands on the FINAL run the version scoring just
  // cached, which is the cached-final contract working a second way.
  const runBeforeRestore = await provenance.innerText();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Restore it' }).click();
  await until(
    () => provenance.innerText(),
    (t) => t !== runBeforeRestore,
    'the restored plan’s run',
  );
  const verdictAfterRestore = (await verdict.innerText()).trim();
  // Let the trailing debounced (no-op) autosave land before the folder is read.
  await page.waitForTimeout(1_200);

  return {
    bootChip,
    finalChip,
    verdictAfterRunNow,
    reloadChip,
    reloadComputedChip,
    snapshotScoreCell,
    historyScoreLine,
    refusalMessage,
    verdictAfterRestore,
  };
}

// ---------------------------------------------------------------------------
// The two stacks
// ---------------------------------------------------------------------------

describe('dual-stack drive: one UI, two backends, same session, same bytes', () => {
  let browser: Browser;
  let nodeContext: BrowserContext | undefined;
  let localContext: BrowserContext | undefined;
  let localPage: Page;
  let staticServer: StaticServer | undefined;
  let serverProc: ChildProcess | undefined;
  let nodeDataDir: string;
  let fixturesDir: string;
  const pageErrors: string[] = [];

  let nodeState: DriveUiState;
  let localState: DriveUiState;
  let nodeFolder: Record<string, string>;
  let localFolder: Record<string, string>;
  let rawLocalTree: Record<string, string>;
  let nodeCancel: CancelShape;
  let localCancel: CancelShape;

  const wirePage = (p: Page): void => {
    p.on('pageerror', (err) => pageErrors.push(String(err)));
  };

  const restrictContext = async (ctx: BrowserContext, origin: string): Promise<void> => {
    await ctx.route('**/*', (route) => {
      if (route.request().url().startsWith(`${origin}/`)) return route.continue();
      pageErrors.push(`blocked off-origin request: ${route.request().url()}`);
      return route.abort();
    });
  };

  beforeAll(async () => {
    // The REAL app bundle — the same build `npm start` serves — built once and
    // used by BOTH stacks: the Fastify server serves dist/ui itself, and the
    // local stack serves the same files statically.
    await build({ configFile: path.join(repoRoot, 'vite.config.ts'), logLevel: 'warn' });
    browser = await chromium.launch();
  }, 240_000);

  afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) {
      serverProc.kill('SIGTERM');
      await new Promise((r) => serverProc!.once('exit', r));
    }
    await browser?.close();
    await staticServer?.close();
    if (nodeDataDir) await fs.rm(path.dirname(nodeDataDir), { recursive: true, force: true });
  });

  it('drives the session against the Node server (private port, temp folder)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-dualstack-'));
    nodeDataDir = path.join(tmp, 'data');
    fixturesDir = path.join(tmp, 'quote-fixtures');
    await fs.mkdir(nodeDataDir, { recursive: true });
    await fs.mkdir(fixturesDir, { recursive: true });
    await fs.writeFile(path.join(fixturesDir, 'VTI.json'), VTI_FIXTURE_TEXT);
    for (const [rel, text] of Object.entries(driveSeedFiles())) {
      await fs.writeFile(path.join(nodeDataDir, rel), text);
    }

    const port = await freePort();
    serverProc = spawn(
      path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
      ['src/server/server.ts'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FPLAN_DATA_DIR: nodeDataDir,
          FPLAN_PORT: String(port),
          FPLAN_NO_OPEN: '1',
          FPLAN_QUOTE_FIXTURES_DIR: fixturesDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const serverLog: string[] = [];
    serverProc.stdout?.on('data', (d: Buffer) => serverLog.push(d.toString()));
    serverProc.stderr?.on('data', (d: Buffer) => serverLog.push(d.toString()));

    const origin = `http://127.0.0.1:${port}`;
    await until(
      async () => {
        if (serverProc?.exitCode !== null) {
          throw new Error(`server exited before ready:\n${serverLog.join('')}`);
        }
        try {
          return (await fetch(`${origin}/api/meta`)).ok;
        } catch {
          return false;
        }
      },
      (ok) => ok === true,
      'the private server to answer /api/meta',
      60_000,
    );

    nodeContext = await browser.newContext();
    await restrictContext(nodeContext, origin);
    const page = await nodeContext.newPage();
    wirePage(page);
    nodeState = await driveSession(page, `${origin}/`);
    await nodeContext.close();
    nodeContext = undefined;

    // Phase 5's search leg, driven through the server's own seam (HTTP).
    await nodeSearchLeg(origin, nodeDataDir);

    // Snapshot BEFORE the cancel leg: where a cancel lands is wall-clock, not
    // arithmetic, so its report and its late slim scores are deliberately
    // outside the byte-compared world. Reading under the live server is safe
    // here because every compared write was waited to its terminal state ON
    // DISK (the session's settle waits above, the report-file wait in the
    // search leg) — not merely to a status flag.
    nodeFolder = maskDriveTree(await nodeTree(nodeDataDir));

    nodeCancel = await nodeCancelLeg(origin, nodeDataDir);

    serverProc.kill('SIGTERM');
    await new Promise((r) => serverProc!.once('exit', r));
    serverProc = undefined;
  }, 900_000);

  it('drives the same session in local mode (seeded OPFS, no server anywhere)', async () => {
    staticServer = await serveStatic(distUi, { spaFallback: true });
    const origin = staticServer.origin;

    localContext = await browser.newContext();
    await restrictContext(localContext, origin);
    // The injected quote fetcher — the seam Phase 6's proxy will fill. It
    // serves the same fixture bytes the node stack's FPLAN_QUOTE_FIXTURES_DIR
    // serves, so the two stacks refresh identical quotes.
    await localContext.addInitScript(
      ({ fixture }: { fixture: string }) => {
        (window as unknown as Record<string, unknown>).__fplanLocalOptions = {
          quoteFetcher: async (url: string) => {
            if (!url.includes('/VTI?')) throw new Error(`no drive fixture for ${url}`);
            return { ok: true, status: 200, json: async () => JSON.parse(fixture) as unknown };
          },
        };
      },
      { fixture: VTI_FIXTURE_TEXT },
    );

    localPage = await localContext.newPage();
    wirePage(localPage);

    // Seed OPFS from a same-origin page BEFORE the app boots: the local
    // backend must find the same starting folder the node server found. The
    // .html extension keeps the SPA fallback from serving the app here — the
    // seeding must run on a blank page, not under a booting Workbench.
    await localPage.goto(`${origin}/__seed.html`);
    await localPage.evaluate(async (files: Record<string, string>) => {
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry('fplan-data', { recursive: true }).catch(() => undefined);
      const root = await opfs.getDirectoryHandle('fplan-data', { create: true });
      for (const [rel, text] of Object.entries(files)) {
        const parts = rel.split('/');
        let dir = root;
        for (const seg of parts.slice(0, -1)) {
          dir = await dir.getDirectoryHandle(seg, { create: true });
        }
        const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
      }
    }, driveSeedFiles());

    localState = await driveSession(localPage, `${origin}/?backend=local`);

    // The same search, in the coordinator worker over the same folder — then
    // the OPFS snapshot at the same moment the node leg took its own (after
    // the completed search, before the cancel leg), so the two byte-compared
    // worlds hold the same set of settled writes.
    await localSearchLeg(localPage);
    rawLocalTree = await readOpfsTree(localPage);
    localCancel = await localCancelLeg(localPage);
    // The page stays open: the guard-refusal test below needs the writer alive.
  }, 900_000);

  it('a second tab of the same profile gets the guard’s refusal, rendered', async () => {
    const page2 = await localContext!.newPage();
    wirePage(page2);
    await page2.goto(`${staticServer!.origin}/?backend=local`);
    await page2
      .getByRole('heading', { name: 'This data folder already has a writer' })
      .waitFor({ state: 'visible', timeout: 60_000 });
    const message = await page2.locator('pre').innerText();
    expect(message).toContain('Another tab in this browser is already writing this data folder');
    await page2.close();
  }, 120_000);

  it('the two folders are byte-equal under the enumerated masks', async () => {
    await localContext!.close();
    localContext = undefined;
    localFolder = maskDriveTree(
      Object.fromEntries(
        Object.entries(rawLocalTree)
          .filter(([rel]) => !TREE_EXCLUDED.has(rel.split('/').pop() ?? rel))
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    );

    // Phase 6: the write-ahead scoring intent is TRANSIENT, and this asserts
    // it ABSENT rather than excluding it (deliberately NOT in TREE_EXCLUDED —
    // stronger than a mask). Both stacks scored a snapshot and a plan version
    // in this session, so both wrote intents; a finished tree still carrying
    // one means some terminal path forgot to clear it, which is exactly the
    // leak that would make every later boot claim an interruption.
    expect(Object.keys(nodeFolder)).not.toContain('.scoring-intent.json');
    expect(Object.keys(localFolder)).not.toContain('.scoring-intent.json');

    // The same files exist — including the same runs/<runKey>.json NAMES,
    // which is the content-keyed cache agreeing across backends.
    expect(Object.keys(localFolder)).toEqual(Object.keys(nodeFolder));
    for (const [rel, nodeText] of Object.entries(nodeFolder)) {
      assertByteEqual(rel, nodeText, localFolder[rel]);
    }

    // Anti-vacuity: the session's exact write choreography. Six distinct runs
    // (two quick, two final, two spend solves), the record files, the seeded
    // surface. Shrinking this list means the session stopped exercising
    // something — go find out what.
    const runFiles = Object.keys(nodeFolder).filter((f) => f.startsWith('runs/'));
    expect(runFiles).toHaveLength(6);
    for (const expected of [
      'profile.json',
      'profile.starter.json',
      'plan.json',
      'plan-history.json',
      'networth.json',
      'quotes.json',
      'assumptions/market.json',
      'assumptions/historical-returns.csv',
    ]) {
      expect(Object.keys(nodeFolder)).toContain(expected);
    }
    // The record files carry what the session attached (masked fields aside).
    expect(nodeFolder['networth.json']).toContain('"sustainableSpend');
    expect(nodeFolder['plan-history.json']).toContain('"sustainableSpend');
    expect(nodeFolder['networth.json']).toContain(`"note": "${DRIVE_NOTE}"`);

    // Phase 5's anti-vacuity: the search leg really persisted its world.
    // One completed report (renamed from its per-stack id by the mask); a
    // real population of slim scores whose FILENAMES are runKeys — their
    // equality across stacks (pinned by the key-list comparison above) is the
    // cross-backend runKey/score-cache agreement this phase must not fork.
    expect(Object.keys(nodeFolder)).toContain('searches/REPORT.json');
    const scoreFiles = Object.keys(nodeFolder).filter((f) => f.startsWith('searches/scores/'));
    expect(scoreFiles.length).toBeGreaterThanOrEqual(20);
    for (const f of scoreFiles) expect(f).toMatch(/^searches\/scores\/[0-9a-f]{64}\.json$/);
    const report = nodeFolder['searches/REPORT.json'];
    expect(report).toContain('"label": "dual-stack search"');
    expect(report).toContain('"truncated": false');
    expect(report).toContain('"rank": 1');
    // The verdict prose is inside the byte-compared body; prove it exists so
    // the comparison above cannot be passing on an empty report.
    expect(report).toMatch(/"note": "/);
  }, 120_000);

  it('a cancel mid-search produces the same truncated shape on both stacks', () => {
    expect(nodeCancel.status).toBe('cancelled');
    expect(nodeCancel.truncated).toBe(true);
    expect(nodeCancel.stageLabel).toBe('stopped early — partial report');
    expect(nodeCancel.firstCaveat).toMatch(/^CANCELLED before the search finished/);
    // Verbatim across the stacks — the truncated-partial-report contract is
    // shared executor/manager code, and this pins that it STAYS shared: same
    // status, same stage label, same leading caveat sentence.
    expect(localCancel).toEqual(nodeCancel);
  });

  it('the UI told the same story on both stacks', () => {
    /**
     * The same rule as the folder masks, applied to the screen: the moments
     * ("scored Aug 29, 2026, 8:44 AM", "measured on 2026-08-29") are the
     * machine's clock, and the two drives legitimately straddle a minute (or,
     * on an unlucky CI run, a midnight). Everything else — every number,
     * every sentence — compares verbatim.
     */
    const scrubMoments = (s: DriveUiState): DriveUiState => ({
      ...s,
      historyScoreLine: s.historyScoreLine.replace(/scored .+$/m, 'scored MASKED'),
      refusalMessage: s.refusalMessage.replace(
        /measured on \d{4}-\d{2}-\d{2}/,
        'measured on MASKED',
      ),
    });
    expect(scrubMoments(localState)).toEqual(scrubMoments(nodeState));
    expect(nodeState.reloadComputedChip).toBe(true);
    expect(nodeState.reloadChip).toContain('Final quality');
    // The line carried real numbers before the scrub — the mask must never be
    // what made the comparison pass.
    expect(nodeState.historyScoreLine).toMatch(/% chance of never running out/);
    expect(nodeState.historyScoreLine).toMatch(/\/yr sustainable living spend/);
  });

  it('threw no page error on either stack', () => {
    expect(pageErrors).toEqual([]);
  });
});
