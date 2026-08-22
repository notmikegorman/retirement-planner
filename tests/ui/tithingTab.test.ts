/**
 * The Workbench's Tithing tab (the two-knob giving split, note 21): the tab
 * exists and restores like the others, the two clearly-headed sections write
 * their own overrides, and the Spending card no longer carries the giving
 * dropdown it used to squeeze into a cell.
 *
 * Source-scan tests, following tests/ui/profileExpenses.test.ts: the panel's
 * tab strip and card wiring are plain declarations, and reading them is what
 * catches the regression that matters — a tab or a binding quietly dropped —
 * without dragging a DOM into the suite.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8');

const scenarioPanel = read('../../src/ui/components/workbench/ScenarioPanel.tsx');
const spendingCard = read('../../src/ui/components/workbench/SpendingCard.tsx');
const tithingCard = read('../../src/ui/components/workbench/TithingCard.tsx');

describe('the ScenarioPanel Tithing tab', () => {
  it('is in the strip, right after Spending, and renders the TithingCard', () => {
    const tabIds = [...scenarioPanel.matchAll(/\{ id: '([a-z]+)', label: '[^']+' \}/g)].map(
      (m) => m[1],
    );
    expect(tabIds).toEqual([
      'plan',
      'spending',
      'tithing',
      'income',
      'housing',
      'events',
      'settings',
      // Last, after Settings: History is the one tab that does not edit the
      // plan. It replaced the deleted 'saved' tab, and its position is pinned
      // here for the same reason Tithing's is — a tab quietly dropped or
      // reordered is exactly the regression this list exists to catch.
      'history',
    ]);
    expect(scenarioPanel).toContain("tab === 'tithing' && (");
    expect(scenarioPanel).toContain('<TithingCard');
  });

  it('restores from localStorage like every other input tab — and only from there', () => {
    // The left tabs are localStorage-only BY OWNER DECISION (DECISIONS.md):
    // the URL never names them, so storage always decides. The Tithing tab
    // must ride the existing key and validator, not invent its own — that is
    // what makes a stored 'tithing' restorable and any stale value fall back
    // to 'plan' instead of crashing the strip.
    expect(scenarioPanel).toContain("const PANEL_TAB_STORAGE_KEY = 'fplan-inputs-tab'");
    expect(scenarioPanel).toContain('localStorage.getItem(PANEL_TAB_STORAGE_KEY)');
    expect(scenarioPanel).toContain('localStorage.setItem(PANEL_TAB_STORAGE_KEY, id)');
    // The validator is derived from PANEL_TABS itself, so 'tithing' is legal
    // by construction and this file cannot drift from the strip.
    expect(scenarioPanel).toContain('PANEL_TABS.some((t) => t.id === v)');
    // And deliberately NOT in the URL: no route segment for the input tabs.
    expect(scenarioPanel).toContain('deliberately NOT in the URL');
  });
});

describe('the TithingCard writes the two halves independently', () => {
  it('has the two clearly-headed sections', () => {
    expect(tithingCard).toContain('The un-tithed pot');
    expect(tithingCard).toContain('Tithing going forward');
  });

  it('writes each half through its own override setter', () => {
    // The pot section writes untithedPot; the ongoing section writes
    // retirementGiving — never each other's field, which is the entire point
    // of the decomposition.
    expect(tithingCard).toContain('setPotOverride(overrides,');
    expect(tithingCard).toContain('setGivingOverride(overrides,');
  });

  it('turning the pot off writes the EXPLICIT disable, never a bare absence', () => {
    // An absent override inherits the profile's pot, so "off" must be the
    // spelled-out form or unticking the box on a profile WITH a pot would do
    // nothing at all.
    expect(tithingCard).toContain('{ enabled: false }');
  });

  it('shows the profile values as the inherited baseline, like every override card', () => {
    expect(tithingCard).toContain('potSummary(profilePot)');
    expect(tithingCard).toContain('givingRuleSummary(');
    expect(tithingCard.match(/reset/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('the Spending card after the split', () => {
  it('no longer carries the giving-rule dropdown or any pot control', () => {
    expect(spendingCard).not.toContain('GIVING_RULE_OPTIONS');
    expect(spendingCard).not.toContain('setGivingOverride');
    expect(spendingCard).not.toContain('untithedPot');
    expect(spendingCard).not.toContain('tithe_account');
  });

  it('keeps the working-side charitable stream and points at the new tab', () => {
    expect(spendingCard).toContain("'charitableMonthly'");
    expect(spendingCard).toContain('Set on the Tithing tab');
  });
});
