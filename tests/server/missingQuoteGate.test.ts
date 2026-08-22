/**
 * The FATAL side of the resolution chokepoint: a run or a search whose
 * holdings symbol has no stored quote must REFUSE, naming the symbols and the
 * fix — never simulate from the last-resolved cache wearing a fresh
 * timestamp. loadResolvedProfile itself is deliberately lenient (the profile
 * editor must render before the first refresh; see networth.test.ts), so the
 * refusal lives in the run and search managers, and each gate is pinned HERE:
 * a disabled gate fails these tests, not just a code-review eyeball.
 *
 * Only the refusal path is exercised — the happy path would spawn real
 * worker threads and is covered by the manager lifecycle tests. The message
 * assertion is the shared missingQuotesMessage sentence, which nothing else
 * in the server produces, so a throw for any OTHER reason cannot fake a pass.
 *
 * Each test points FPLAN_DATA_DIR at a fresh temp dir seeded from
 * data-defaults; the user's real data folder is never read or touched.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario, SearchRequest } from '../../src/shared/types';
import {
  ValidationError,
  initDataDir,
  loadProfile,
  saveProfile,
} from '../../src/server/dataStore';
import { startRun } from '../../src/server/runManager';
import { startSearch } from '../../src/server/searchManager';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-quotegate-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();

  // The seeded starter profile's IRA goes holdings-mode with NO quotes.json
  // beside it — the exact state of a folder that switched to holdings and
  // never pressed Refresh.
  const profile = await loadProfile();
  const ira = profile.accounts.find((a) => a.id === 'ira1')!;
  ira.holdings = [
    { symbol: 'VTI', quantity: 100, assetClass: 'stocks' },
    { symbol: 'BND', quantity: 200, assetClass: 'bonds' },
  ];
  ira.cash = 50;
  await saveProfile(profile);
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The smallest scenario the schema accepts — the gate fires before any event matters. */
const plan: Scenario = { name: 'Plan', events: [] } as unknown as Scenario;

describe('the run manager refuses unpriced holdings', () => {
  it('startRun throws the missing-quotes sentence, naming the symbols and the fix', async () => {
    await expect(startRun({ scenario: plan, mode: 'deterministic' })).rejects.toThrow(
      ValidationError,
    );
    await expect(startRun({ scenario: plan, mode: 'deterministic' })).rejects.toThrow(
      /no stored quote \(BND, VTI\)/,
    );
    await expect(startRun({ scenario: plan, mode: 'deterministic' })).rejects.toThrow(
      /Refresh prices on the Profile tab/,
    );
  });
});

describe('the search manager refuses unpriced holdings', () => {
  it('startSearch throws the same sentence before any worker exists', async () => {
    // The gate fires before the request body is ever read, so the minimal
    // cast is honest: a search that cannot price the profile has no use for
    // axes or budgets.
    const request = { base: plan, axes: [] } as unknown as SearchRequest;
    await expect(startSearch(request)).rejects.toThrow(ValidationError);
    await expect(startSearch(request)).rejects.toThrow(/no stored quote \(BND, VTI\)/);
  });
});
