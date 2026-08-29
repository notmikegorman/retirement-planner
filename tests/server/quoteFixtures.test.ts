/**
 * The server quote face's ONE test seam: FPLAN_QUOTE_FIXTURES_DIR
 * (src/server/quotes.ts).
 *
 * The dual-stack gate drives a real server process through the real snapshot
 * flow, whose quote refresh must not reach Yahoo from a test — so with the
 * variable set, the DEFAULT fetcher answers from <dir>/<SYMBOL>.json instead
 * of the network. What is pinned here:
 *
 *   - the fixture path is consulted per call (set the env, no restart),
 *   - a present fixture stores exactly what the same bytes through an
 *     injected fetcher would store,
 *   - a missing fixture fails THAT symbol as data — the per-symbol contract,
 *     with the file's name in the message so a broken fixture setup is
 *     diagnosable from the failure it caused,
 *   - explicitly passed deps still win: the seam is a default, not an
 *     override, so every existing injected-fetcher test keeps meaning what it
 *     meant.
 */
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir, loadQuotes } from '../../src/server/dataStore';
import { refreshQuotes } from '../../src/server/quotes';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const vtiFixture = readFileSync(
  path.join(repoRoot, 'tests', 'fixtures', 'yahoo-chart-vti.json'),
  'utf8',
);

let tmpDir: string;
let fixturesDir: string;
let prevDataDir: string | undefined;
let prevFixtures: string | undefined;

beforeEach(async () => {
  prevDataDir = process.env.FPLAN_DATA_DIR;
  prevFixtures = process.env.FPLAN_QUOTE_FIXTURES_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-quotefix-'));
  fixturesDir = path.join(tmpDir, 'fixtures');
  await fs.mkdir(fixturesDir);
  process.env.FPLAN_DATA_DIR = path.join(tmpDir, 'data');
  process.env.FPLAN_QUOTE_FIXTURES_DIR = fixturesDir;
  await initDataDir();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevDataDir;
  if (prevFixtures === undefined) delete process.env.FPLAN_QUOTE_FIXTURES_DIR;
  else process.env.FPLAN_QUOTE_FIXTURES_DIR = prevFixtures;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('FPLAN_QUOTE_FIXTURES_DIR', () => {
  it('answers a refresh from <dir>/<SYMBOL>.json without any injected deps', async () => {
    await fs.writeFile(path.join(fixturesDir, 'VTI.json'), vtiFixture);
    const res = await refreshQuotes(['VTI']);
    expect(res.results).toEqual([
      { symbol: 'VTI', ok: true, quote: expect.objectContaining({ price: 379.04, currency: 'USD' }) },
    ]);
    // …and it persisted, like any refresh.
    expect((await loadQuotes()).VTI?.price).toBe(379.04);
  });

  it('a missing fixture fails that one symbol as data, naming the file', async () => {
    await fs.writeFile(path.join(fixturesDir, 'VTI.json'), vtiFixture);
    const res = await refreshQuotes(['VTI', 'GHOST']);
    expect(res.results[0]).toMatchObject({ symbol: 'VTI', ok: true });
    expect(res.results[1]).toMatchObject({ symbol: 'GHOST', ok: false });
    expect((res.results[1] as { error: string }).error).toContain('GHOST.json');
  });

  it('explicitly passed deps still win — the seam is a default, not an override', async () => {
    // No VTI fixture on disk; the injected fetcher must be the one consulted.
    const res = await refreshQuotes(['VTI'], {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => JSON.parse(vtiFixture) as unknown,
      }),
    });
    expect(res.results[0]).toMatchObject({ symbol: 'VTI', ok: true });
  });
});
