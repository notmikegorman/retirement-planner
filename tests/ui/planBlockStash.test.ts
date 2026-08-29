/**
 * THE PLAN-BLOCK STASH (src/ui/planBlockStash.ts) and housing's use of it
 * (src/ui/components/workbench/housingStash.ts) — the pattern that keeps a
 * toggle from throwing away what the owner typed.
 *
 * The incident under test, so the properties make sense: Housing's "Turn
 * off" removes the block (the engine's absent-means-unmodeled contract),
 * and re-enabling used to seed a fresh form. The owner refilled it from
 * memory, missed an insurance quote that had been entered, and the engine's
 * estimate stood in at roughly double — a point of probability lost to a number the user had
 * already typed once. The properties that prevent a recurrence:
 *
 *  1. The stash is keyed PER DATA FOLDER, by the identity the writer guard
 *     already mints — two folders never inherit each other's stash.
 *  2. Garbage on the shelf reads as "no stash", never as a throw or as a
 *     fabricated block.
 *  3. The rehydrate order is stash → newest history version with a housing
 *     block → seeded blank, and each restored source carries a provenance
 *     line naming itself and its moment.
 */
import { describe, expect, it } from 'vitest';
import type { HousingPlan, PlanHistoryEntry, Scenario } from '../../src/shared/types';
import {
  parseStash,
  readBlockStash,
  resolveStashFolderKey,
  stashKey,
  writeBlockStash,
} from '../../src/ui/planBlockStash';
import {
  historyRestoredNote,
  newestHousingVersion,
  readHousingStash,
  stashOfferNote,
  stashRestoredNote,
} from '../../src/ui/components/workbench/housingStash';

/** A Map-backed Storage stand-in — the injectable seam, exercised. */
function fakeStore(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const housing = (over: Partial<HousingPlan> = {}): HousingPlan => ({
  sellDate: '2027-06',
  rentMonths: 12,
  rentMonthly: 3000,
  purchasePrice: 1_750_000,
  propertyTaxAnnual: 7500,
  // THE FIELD THE INCIDENT WAS ABOUT: a real quote whose absence means a
  // price-based estimate. It must round-trip the stash exactly.
  insuranceAnnual: 1725,
  financing: { type: 'cash' },
  ...over,
});

describe('the shelf key is per folder, per block', () => {
  it('builds from the folder identity the guard already mints', () => {
    expect(stashKey('folder-a1b2c3d4', 'housing')).toBe('fplan-stash:folder-a1b2c3d4:housing');
    expect(stashKey('opfs:fplan-data', 'housing')).toBe('fplan-stash:opfs:fplan-data:housing');
  });

  it('two folders never share a shelf', () => {
    const store = fakeStore();
    writeBlockStash('folder-one', 'housing', housing(), new Date('2026-08-29T17:42:00'), store);
    expect(readBlockStash('folder-two', 'housing', store)).toBeNull();
    expect(readBlockStash<HousingPlan>('folder-one', 'housing', store)?.value.insuranceAnnual).toBe(
      1725,
    );
  });

  it('resolves the identity by mode: minted folder id, the OPFS id, or the server dataDir', () => {
    expect(
      resolveStashFolderKey({ mode: 'local', choice: 'folder', folderId: 'folder-abc', dataDir: null }),
    ).toBe('folder-abc');
    expect(
      resolveStashFolderKey({ mode: 'local', choice: 'opfs', folderId: null, dataDir: null }),
    ).toBe('opfs:fplan-data');
    expect(
      resolveStashFolderKey({ mode: 'http', choice: null, folderId: null, dataDir: '/x/data' }),
    ).toBe('/x/data');
    // Missing facts read as "no identity" — nothing stashes, nothing
    // rehydrates from a stash; the folder-resident sources still stand.
    expect(
      resolveStashFolderKey({ mode: 'local', choice: 'folder', folderId: null, dataDir: null }),
    ).toBeNull();
    expect(
      resolveStashFolderKey({ mode: 'local', choice: null, folderId: null, dataDir: null }),
    ).toBeNull();
  });
});

describe('what the shelf holds round-trips; what it does not parses as nothing', () => {
  it('round-trips the block with the moment it was removed', () => {
    const store = fakeStore();
    const at = new Date('2026-08-29T17:42:11.000Z');
    writeBlockStash('f', 'housing', housing(), at, store);
    const back = readBlockStash<HousingPlan>('f', 'housing', store);
    expect(back?.stashedAt).toBe('2026-08-29T17:42:11.000Z');
    expect(back?.value).toEqual(housing());
  });

  it('reads garbage as "no stash" — never a throw, never a fabricated block', () => {
    expect(parseStash(null)).toBeNull();
    expect(parseStash('not json')).toBeNull();
    expect(parseStash('42')).toBeNull();
    expect(parseStash('{"value":{}}')).toBeNull(); // no stashedAt
    expect(parseStash('{"stashedAt":"2026-08-29T00:00:00Z"}')).toBeNull(); // no value
    const ok = parseStash<{ a: number }>('{"value":{"a":1},"stashedAt":"2026-08-29T00:00:00Z"}');
    expect(ok?.value.a).toBe(1);
  });

  it('survives a disabled storage: writes are silent no-ops, reads are null', () => {
    expect(() => writeBlockStash('f', 'housing', housing(), new Date(), null)).not.toThrow();
    expect(readBlockStash('f', 'housing', null)).toBeNull();
  });

  it('readHousingStash is the generic read on the housing shelf', () => {
    const store = fakeStore();
    writeBlockStash('f', 'housing', housing(), new Date('2026-08-29T17:42:00Z'), store);
    // The housing wrapper reads the same shelf the generic write filled —
    // same key, same envelope. (The wrapper defaults to localStorage; the
    // generic read stands in for it here with the injected store.)
    expect(readBlockStash<HousingPlan>('f', 'housing', store)?.value).toEqual(housing());
    expect(typeof readHousingStash).toBe('function');
  });
});

describe('the history fallback: the newest version that modelled the move', () => {
  const plan = (over: Partial<Scenario> = {}): Scenario => ({ name: 'Plan', events: [], ...over });
  const entry = (
    id: string,
    takenAt: string,
    over: Partial<PlanHistoryEntry> = {},
  ): PlanHistoryEntry => ({
    id,
    takenAt,
    kind: 'day-start',
    plan: plan(),
    planHash: 'a'.repeat(64),
    ...over,
  });

  it('picks the newest entry whose plan carries a housing block, whatever the wire order', () => {
    const found = newestHousingVersion([
      entry('older', '2026-08-18T09:00:00.000Z', { plan: plan({ housing: housing({ rentMonths: 6 }) }) }),
      entry('none', '2026-08-29T09:00:00.000Z'),
      entry('newer', '2026-08-21T09:00:00.000Z', { plan: plan({ housing: housing() }) }),
    ]);
    expect(found?.id).toBe('newer');
  });

  it('answers null when no version ever modelled the move — then blank is the truth', () => {
    expect(newestHousingVersion([entry('a', '2026-08-29T09:00:00.000Z')])).toBeNull();
    expect(newestHousingVersion([])).toBeNull();
  });
});

describe('a restored value carries its condition (the provenance wordings)', () => {
  it('the stash names the owner and the moment of the turn-off', () => {
    const note = stashRestoredNote('2026-08-29T17:42:00.000Z');
    expect(note).toContain('your housing configuration as it was when you turned it off');
    expect(note).toMatch(/Aug 29, 2026, \d{1,2}:\d{2} (AM|PM)/);
    expect(note).toContain('review before running');
  });

  it('the history fallback names the lending version, by kind', () => {
    const dayStart = historyRestoredNote({
      id: 'x',
      takenAt: '2026-08-29T09:00:00.000Z',
      kind: 'day-start',
      plan: { name: 'Plan', events: [] },
      planHash: 'a'.repeat(64),
    });
    expect(dayStart).toContain('Restored from history');
    expect(dayStart).toMatch(/the Aug 29, 2026, \d{1,2}:\d{2} (AM|PM) day-start version/);
    expect(dayStart).toContain('review before running');

    const kept = historyRestoredNote({
      id: 'y',
      takenAt: '2026-08-21T09:00:00.000Z',
      kind: 'kept',
      label: 'Finalist B',
      plan: { name: 'Plan', events: [] },
      planHash: 'a'.repeat(64),
    });
    expect(kept).toContain('“Finalist B”');
    expect(kept).toContain('kept Aug 21, 2026');
  });

  it('the OFF state promises the restore BEFORE the press', () => {
    const offer = stashOfferNote('2026-08-29T17:42:00.000Z');
    expect(offer).toContain('Turning this on restores your housing configuration');
    expect(offer).toMatch(/Aug 29, 2026/);
  });
});
