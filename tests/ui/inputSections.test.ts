/**
 * The Plan input panel's OPEN-SET storage, executed — not string-pinned.
 *
 * ScenarioPanel's sections (the tab era's successor, 2026-08-30) remember
 * which folds are open in localStorage. Four behaviors are load-bearing and
 * each is a real branch in readStoredOpenSections, so they are run here
 * against a stubbed localStorage rather than scanned as source text:
 *
 *   1. no stored value → the default single open section (Plan), unless the
 *      TAB ERA's single-selection key survives to seed it;
 *   2. a stored empty array is a REAL state — all sections closed on
 *      purpose stays all-closed;
 *   3. a stored array keeps its valid ids and drops stale ones — but an
 *      array whose EVERY id is stale reads as version skew, not intent,
 *      and falls back to the default;
 *   4. malformed JSON falls back to the default (via the legacy seed).
 *
 * The write side is storeOpenSections: strip order, not click order, so the
 * stored value is a stable function of the state.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PANEL_OPEN_STORAGE_KEY,
  PANEL_TAB_LEGACY_KEY,
  PANEL_TABS,
  readStoredOpenSections,
  storeOpenSections,
} from '../../src/ui/components/workbench/workbenchLogic';

/** A minimal localStorage: exactly what the two functions touch. */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe('readStoredOpenSections', () => {
  it('defaults to Plan alone — the column starts short', () => {
    expect([...readStoredOpenSections()]).toEqual(['plan']);
  });

  it('seeds from the tab era’s single selection, so an upgrade keeps your place', () => {
    stubStorage({ [PANEL_TAB_LEGACY_KEY]: 'housing' });
    expect([...readStoredOpenSections()]).toEqual(['housing']);
  });

  it('ignores a stale legacy selection rather than opening nothing recognizable', () => {
    stubStorage({ [PANEL_TAB_LEGACY_KEY]: 'methodology' });
    expect([...readStoredOpenSections()]).toEqual(['plan']);
  });

  it('restores a stored set and prefers it over the legacy key', () => {
    stubStorage({
      [PANEL_OPEN_STORAGE_KEY]: '["spending","history"]',
      [PANEL_TAB_LEGACY_KEY]: 'housing',
    });
    expect([...readStoredOpenSections()].sort()).toEqual(['history', 'spending']);
  });

  it('honors a stored EMPTY set — all closed on purpose stays all closed', () => {
    stubStorage({ [PANEL_OPEN_STORAGE_KEY]: '[]', [PANEL_TAB_LEGACY_KEY]: 'housing' });
    expect([...readStoredOpenSections()]).toEqual([]);
  });

  it('drops stale ids but keeps the valid ones beside them', () => {
    stubStorage({ [PANEL_OPEN_STORAGE_KEY]: '["events","budget",42]' });
    expect([...readStoredOpenSections()]).toEqual(['events']);
  });

  it('reads an all-stale array as version skew, not as all-closed intent', () => {
    stubStorage({ [PANEL_OPEN_STORAGE_KEY]: '["budget","methodology"]' });
    expect([...readStoredOpenSections()]).toEqual(['plan']);
  });

  it('falls back through malformed JSON to the legacy seed', () => {
    stubStorage({ [PANEL_OPEN_STORAGE_KEY]: '{not json', [PANEL_TAB_LEGACY_KEY]: 'settings' });
    expect([...readStoredOpenSections()]).toEqual(['settings']);
  });

  it('survives storage being absent entirely', () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect([...readStoredOpenSections()]).toEqual(['plan']);
  });
});

describe('storeOpenSections', () => {
  it('writes strip order whatever the click order was', () => {
    const store = stubStorage();
    storeOpenSections(new Set(['history', 'plan', 'spending']));
    expect(store.get(PANEL_OPEN_STORAGE_KEY)).toBe('["plan","spending","history"]');
  });

  it('round-trips through the reader', () => {
    stubStorage();
    storeOpenSections(new Set(['tithing', 'events']));
    expect([...readStoredOpenSections()].sort()).toEqual(['events', 'tithing']);
  });

  it('writes the empty set as itself, completing the all-closed contract', () => {
    const store = stubStorage();
    storeOpenSections(new Set());
    expect(store.get(PANEL_OPEN_STORAGE_KEY)).toBe('[]');
    expect([...readStoredOpenSections()]).toEqual([]);
  });
});

describe('File > New forgets the open set', () => {
  it('clears the open-set key AND its legacy seed in resetRememberedViews', () => {
    // A surviving legacy key would re-seed the open set with the OLD
    // household's reading position — the exact regression the reset exists
    // for (a brand-new plan once opened on Housing instead of Plan).
    const main = readFileSync(
      new URL('../../src/ui/main.tsx', import.meta.url),
      'utf8',
    );
    const reset = main.slice(main.indexOf('function resetRememberedViews'));
    expect(reset).toContain("'fplan-inputs-open'");
    expect(reset).toContain("'fplan-inputs-tab'");
  });
});

describe('the section list', () => {
  it('holds the eight sections, Plan first and History last', () => {
    // The order IS the storage serialization order (strip order), so it is
    // part of the contract these tests execute, not just chrome.
    expect(PANEL_TABS.map((t) => t.id)).toEqual([
      'plan',
      'spending',
      'tithing',
      'income',
      'housing',
      'events',
      'settings',
      'history',
    ]);
  });
});
