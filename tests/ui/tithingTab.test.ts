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
const workbenchLogic = read('../../src/ui/components/workbench/workbenchLogic.ts');
const spendingCard = read('../../src/ui/components/workbench/SpendingCard.tsx');
const tithingCard = read('../../src/ui/components/workbench/TithingCard.tsx');

describe('the ScenarioPanel Tithing tab', () => {
  it('is in the strip, right after Spending, and renders the TithingCard', () => {
    // PANEL_TABS lives in workbenchLogic since the storage behaviors became
    // executable (tests/ui/inputSections.test.ts).
    const tabIds = [...workbenchLogic.matchAll(/\{ id: '([a-z]+)', label: '[^']+' \}/g)].map(
      (m) => m[1],
    );
    expect(tabIds).toEqual([
      'plan',
      'spending',
      'tithing',
      'income',
      'housing',
      'events',
      // Last, labelled ADVANCED since 2026-08-30 (the id is the stored
      // open-set vocabulary and stays). History left for the Settings
      // module the same day.
      'settings',
    ]);
    expect(scenarioPanel).toContain("section(\n          'tithing',");
    expect(scenarioPanel).toContain('<TithingCard');
  });

  it('restores its open set from localStorage — and only from there', () => {
    // The input sections are localStorage-only BY OWNER DECISION
    // (DECISIONS.md): the URL never names them, so storage always decides.
    // The storage behaviors themselves are EXECUTED in
    // tests/ui/inputSections.test.ts; what this scan pins is the wiring —
    // the panel rides workbenchLogic's shared reader/writer pair rather
    // than inventing its own, which is what makes a stored 'tithing'
    // restorable through the same code the tests run.
    expect(scenarioPanel).toContain('readStoredOpenSections');
    expect(scenarioPanel).toContain('storeOpenSections(new Set(next === null ? [] : [next]))');
    expect(workbenchLogic).toContain("export const PANEL_OPEN_STORAGE_KEY = 'fplan-inputs-open'");
    expect(workbenchLogic).toContain("export const PANEL_TAB_LEGACY_KEY = 'fplan-inputs-tab'");
    // And deliberately NOT in the URL: no route segment for the input sections.
    expect(workbenchLogic).toContain('deliberately NOT in the URL');
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
