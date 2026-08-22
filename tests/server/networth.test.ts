/**
 * Net-worth snapshots (src/server/networthStore.ts) and the resolved-profile
 * chokepoint they price through (dataStore.loadResolvedProfile):
 *
 * - the chokepoint derives holdings balances from stored quotes and leaves
 *   manual accounts alone — and is LENIENT about missing quotes (the editor
 *   must render before the first refresh), reporting them for the run/search
 *   managers to treat as fatal;
 * - a snapshot totals every account plus the typed home value, records the
 *   prices it used, and REFUSES to record when a symbol has no quote at all
 *   (a ledger row priced from nothing would be a record of nothing);
 * - the ledger is append-only and delete-by-id, and survives a round-trip.
 *
 * Each test points FPLAN_DATA_DIR at a fresh temp dir seeded from
 * data-defaults; the user's real data folder is never read or touched.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile, QuotesFile } from '../../src/shared/types';
import {
  NotFoundError,
  ValidationError,
  initDataDir,
  loadProfile,
  loadResolvedProfile,
  saveProfile,
  saveQuotes,
} from '../../src/server/dataStore';
import { deleteSnapshot, listSnapshots, takeSnapshot } from '../../src/server/networthStore';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-networth-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Switch the seeded starter profile's IRA to holdings mode and save it. */
async function holdingsProfile(): Promise<Profile> {
  const profile = await loadProfile();
  const ira = profile.accounts.find((a) => a.id === 'ira1')!;
  ira.holdings = [
    { symbol: 'VTI', quantity: 100, assetClass: 'stocks' },
    { symbol: 'BND', quantity: 200, assetClass: 'bonds' },
  ];
  ira.cash = 50;
  await saveProfile(profile);
  return profile;
}

const QUOTES: QuotesFile = {
  VTI: {
    price: 379.04,
    currency: 'USD',
    asOf: '2026-08-18T20:00:00.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-18T21:00:00.000Z',
  },
  BND: {
    price: 72.1,
    currency: 'USD',
    asOf: '2026-08-18T20:00:00.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-18T21:00:00.000Z',
  },
};

const IRA_DERIVED = 100 * 379.04 + 200 * 72.1 + 50;

describe('loadResolvedProfile (the chokepoint)', () => {
  it('derives holdings balances from stored quotes and leaves manual accounts alone', async () => {
    await holdingsProfile();
    await saveQuotes(QUOTES);
    const raw = await loadProfile();
    const { profile, missing } = await loadResolvedProfile();
    expect(missing).toEqual([]);
    const ira = profile.accounts.find((a) => a.id === 'ira1')!;
    expect(ira.balance).toBeCloseTo(IRA_DERIVED, 6);
    expect(ira.allocation.stocks).toBeCloseTo((100 * 379.04) / IRA_DERIVED, 12);
    // Every other account is exactly the stored file's.
    for (const a of profile.accounts.filter((x) => x.id !== 'ira1')) {
      expect(a).toEqual(raw.accounts.find((x) => x.id === a.id));
    }
  });

  it('is lenient about missing quotes: stored figures survive, symbols reported', async () => {
    const before = await holdingsProfile();
    const storedBalance = before.accounts.find((a) => a.id === 'ira1')!.balance;
    const { profile, missing } = await loadResolvedProfile();
    expect(missing).toEqual(['BND', 'VTI']);
    expect(profile.accounts.find((a) => a.id === 'ira1')!.balance).toBe(storedBalance);
  });
});

describe('takeSnapshot', () => {
  it('totals every account plus the typed home value, and records the prices used', async () => {
    await holdingsProfile();
    await saveQuotes(QUOTES);
    const { profile } = await loadResolvedProfile();
    const portfolio = profile.accounts.reduce((s, a) => s + a.balance, 0);

    const snap = await takeSnapshot({ homeValue: 1_200_000, note: '  first look  ' });
    expect(snap.total).toBeCloseTo(portfolio + 1_200_000, 6);
    expect(snap.homeValue).toBe(1_200_000);
    expect(snap.accounts.map((a) => a.id).sort()).toEqual(
      profile.accounts.map((a) => a.id).sort(),
    );
    expect(snap.accounts.find((a) => a.id === 'ira1')!.balance).toBeCloseTo(IRA_DERIVED, 6);
    // The prices behind the derived balances, with their own asOf moments —
    // what lets a row say "prices as of the snapshot moment" forever.
    expect(snap.prices).toEqual({
      VTI: { price: 379.04, asOf: '2026-08-18T20:00:00.000Z' },
      BND: { price: 72.1, asOf: '2026-08-18T20:00:00.000Z' },
    });
    expect(snap.note).toBe('first look');
    expect(snap.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to record when a holdings symbol has no stored quote, naming the fix', async () => {
    await holdingsProfile();
    await expect(takeSnapshot({ homeValue: 1_000_000 })).rejects.toThrow(ValidationError);
    await expect(takeSnapshot({ homeValue: 1_000_000 })).rejects.toThrow(
      /Refresh prices on the Profile tab/,
    );
    // And nothing was written — a refused snapshot leaves no half-row behind.
    expect(await listSnapshots()).toEqual([]);
  });

  it('is append-only and round-trips through disk; delete removes exactly its row', async () => {
    await holdingsProfile();
    await saveQuotes(QUOTES);
    const first = await takeSnapshot({ homeValue: 1_000_000 });
    const second = await takeSnapshot({ homeValue: 900_000, note: 'later' });
    const listed = await listSnapshots();
    expect(listed.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(listed[0].id).not.toBe(listed[1].id);

    await deleteSnapshot(first.id);
    expect((await listSnapshots()).map((s) => s.id)).toEqual([second.id]);
    await expect(deleteSnapshot(first.id)).rejects.toThrow(NotFoundError);
  });

  it('a manual-only profile snapshots without any quotes at all', async () => {
    // The starter profile has no holdings accounts; the ledger must not
    // demand prices for a household that types every balance by hand.
    const snap = await takeSnapshot({ homeValue: 550_000 });
    const profile = await loadProfile();
    const portfolio = profile.accounts.reduce((s, a) => s + a.balance, 0);
    expect(snap.total).toBeCloseTo(portfolio + 550_000, 6);
    expect(snap.prices).toEqual({});
  });
});
