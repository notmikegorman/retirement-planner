/**
 * The "Bonds are" preset select — under the Investing module since
 * 2026-08-30, its ONE home after the two-door era (it was born on the Plan
 * card from the feedback "expected a dropdown of BND or VGIT", with a twin
 * percent field on the overrides card; both workbench doors closed with the
 * move). It edits assumption_overrides.market.bondComposition.
 * corporateFraction on the PLAN, by get-mutate-put. The pure mapping
 * (preset <-> fraction), the surgical write (everything else in the
 * override survives), and the absence rules (absent stays absent; a flip
 * away-and-back leaves no residue) live in scenarioHelpers and are tested
 * here directly. The wiring — which component reads what — is source-scanned,
 * following tests/ui/tithingTab.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOTAL_BOND_CORPORATE_FRACTION,
  bondPresetFor,
  bondPresetFraction,
  buildOverrides,
  corporateFractionOf,
  corporateShareErrorText,
  corporateShareText,
  overrideFieldErrors,
  overrideFieldsFrom,
  setCorporateFraction,
} from '../../src/ui/components/scenarios/scenarioHelpers';
import type { AssumptionOverrides } from '../../src/shared/types';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const planCard = read('../../src/ui/components/scenarios/PlanCard.tsx');
const overridesCard = read('../../src/ui/components/scenarios/OverridesCard.tsx');
const scenarioPanel = read('../../src/ui/components/workbench/ScenarioPanel.tsx');
const sharedField = read('../../src/ui/components/scenarios/CorporateShareField.tsx');

describe('bond preset <-> corporateFraction mapping', () => {
  it('maps each stored fraction to its preset: absent/0 → Treasuries, 0.3 → total bond, else Custom', () => {
    // Absent AND explicit 0 both read as Treasuries: they price identically
    // (the engine default is all-Treasury), so the select never shows
    // "Custom" for a zero the user typed into the Settings field.
    expect(bondPresetFor(undefined)).toBe('treasuries');
    expect(bondPresetFor(0)).toBe('treasuries');
    expect(bondPresetFor(TOTAL_BOND_CORPORATE_FRACTION)).toBe('total_bond');
    expect(bondPresetFor(0.3)).toBe('total_bond');
    // Anything else — including values NEAR the preset — is Custom with the
    // value: only the exact 0.3 may claim the BND-like label.
    expect(bondPresetFor(0.15)).toBe('custom');
    expect(bondPresetFor(0.31)).toBe('custom');
    expect(bondPresetFor(1)).toBe('custom');
  });

  it('maps each preset pick to the fraction it writes, and back to itself', () => {
    // treasuries writes ABSENCE (undefined), not 0 — see the absence tests.
    expect(bondPresetFraction('treasuries')).toBeUndefined();
    expect(bondPresetFraction('total_bond')).toBe(0.3);
    // Round trip: what a pick writes is what the select then shows. This is
    // the pair a mutation to either mapping breaks.
    for (const preset of ['treasuries', 'total_bond'] as const) {
      const o = setCorporateFraction(undefined, bondPresetFraction(preset));
      expect(bondPresetFor(corporateFractionOf(o))).toBe(preset);
    }
    // And the custom path: a typed 12.5% stores 0.125 and reads back Custom,
    // shown with its value (corporateShareText is what the box is seeded with).
    const custom = setCorporateFraction(undefined, 0.125);
    expect(corporateFractionOf(custom)).toBe(0.125);
    expect(bondPresetFor(corporateFractionOf(custom))).toBe('custom');
    expect(corporateShareText(0.125)).toBe('12.5');
  });

  it('the custom box round-trips percent text without float dust', () => {
    // The Plan card seeds its Custom box with corporateShareText, and the
    // select must recognise a committed value when it comes back around.
    expect(corporateShareText(30 / 100)).toBe('30');
    expect(bondPresetFor(30 / 100)).toBe('total_bond');
    expect(corporateShareText(1)).toBe('100');
    expect(corporateShareText(0)).toBe('0');
    // The dust cases: 0.3 happens to multiply clean, but 7/100 and 29/100 do
    // not (0.07 * 100 === 7.000000000000001) — these are the values that
    // catch a dropped precision trim, which the mutation run proved the
    // clean cases cannot.
    expect(corporateShareText(7 / 100)).toBe('7');
    expect(corporateShareText(29 / 100)).toBe('29');
    expect(corporateShareText(14.5 / 100)).toBe('14.5');
  });
});

describe('setCorporateFraction (the surgical write both presets and the custom box use)', () => {
  it('leaves absent absent when Treasuries is picked and nothing was ever set', () => {
    // The no-redundant-0 rule: picking the preset named for the default must
    // not turn "never said" into "said 0". The OverridesCard's explicit-0
    // convention covers the OTHER direction (a 0 the user TYPED stays); a
    // preset pick is not a typed number, and absence is what keeps a
    // never-touched plan byte-identical.
    expect(setCorporateFraction(undefined, undefined)).toBeUndefined();
    // Same with unrelated overrides present: nothing is invented, nothing lost.
    const other: AssumptionOverrides = { settings: { horizonAge: 95 } };
    expect(setCorporateFraction(other, undefined)).toEqual({ settings: { horizonAge: 95 } });
  });

  it('flipping Treasuries → total bond → Treasuries leaves no residue', () => {
    const bnd = setCorporateFraction(undefined, bondPresetFraction('total_bond'));
    expect(bnd).toEqual({ market: { bondComposition: { corporateFraction: 0.3 } } });
    // Back to Treasuries: the whole chain prunes — bondComposition, then the
    // emptied market block, then the emptied overrides object itself.
    expect(setCorporateFraction(bnd, bondPresetFraction('treasuries'))).toBeUndefined();
  });

  it('preserves every override it does not own — expenses, cash yield, settings', () => {
    // The reason this is NOT buildOverrides: a surgical patch from a card
    // that edits one dial must round-trip overrides it has never heard of.
    const o: AssumptionOverrides = {
      market: { cashYieldNominal: 0.0425 },
      expenses: { livingMonthly: 5200 },
      settings: { successTarget: 0.9 },
    };
    const withBnd = setCorporateFraction(o, 0.3);
    expect(withBnd).toEqual({
      market: { cashYieldNominal: 0.0425, bondComposition: { corporateFraction: 0.3 } },
      expenses: { livingMonthly: 5200 },
      settings: { successTarget: 0.9 },
    });
    // And clearing takes only its own key out — the market block survives
    // because the cash yield still lives there.
    expect(setCorporateFraction(withBnd, undefined)).toEqual(o);
    // Never mutates its input.
    expect(o.market).toEqual({ cashYieldNominal: 0.0425 });
  });
});

describe('the select and the stored override stay in sync (the two-door era\u2019s pure mapping)', () => {
  it('a preset pick is what the OverridesCard field then shows', () => {
    // Plan card writes 0.3; the Settings field (overrideFieldsFrom is its
    // read path) shows "30" — the number the user was promised he would
    // find there.
    const o = setCorporateFraction(undefined, bondPresetFraction('total_bond'));
    expect(overrideFieldsFrom(o).market.corporateShare).toBe('30');
    // And clearing shows blank there, not "0".
    expect(
      overrideFieldsFrom(setCorporateFraction(o, undefined)).market.corporateShare,
    ).toBe('');
  });

  it('a share typed into the OverridesCard is what the select then shows', () => {
    const defaults = { stocks: 0, bonds: 0, bills: 0, inflation: 0 };
    const f = overrideFieldsFrom(undefined);
    f.market.corporateShare = '30';
    const o = buildOverrides(f, defaults);
    expect(bondPresetFor(corporateFractionOf(o))).toBe('total_bond');
    f.market.corporateShare = '12.5';
    expect(bondPresetFor(corporateFractionOf(buildOverrides(f, defaults)))).toBe('custom');
    // The OverridesCard's explicit-0 convention: a TYPED 0 is stored as a
    // stated 0 — and the select reads it as the Treasuries option, because
    // the two spellings price identically. The conventions meet in the
    // middle without contradiction.
    f.market.corporateShare = '0';
    const zero = buildOverrides(f, defaults);
    expect(corporateFractionOf(zero)).toBe(0);
    expect(bondPresetFor(corporateFractionOf(zero))).toBe('treasuries');
  });

  it('both doors run the same bound check', () => {
    // corporateShareErrorText IS the checker overrideFieldErrors delegates
    // to — asserted here so a future edit to one cannot quietly fork the
    // other (the messages are owner-visible).
    for (const raw of ['', '0', '0.3', '30', '100', '150', '-5', 'abc']) {
      const f = overrideFieldsFrom(undefined);
      f.market.corporateShare = raw;
      expect(overrideFieldErrors(f).corporateShare).toBe(corporateShareErrorText(raw));
    }
    expect(corporateShareErrorText('150')).toContain('between 0 and 100');
    expect(corporateShareErrorText('abc')).toBe('must be a number');
    expect(corporateShareErrorText('')).toBeUndefined();
  });
});

describe('the wiring (source scan)', () => {
  it('the Investing module hosts the select, fed by the loaded plan and put whole', () => {
    // ONE DIAL, ONE DOOR (the owner's relocation, 2026-08-30): the select
    // moved off the Plan page — where it lived twice — into an always-active
    // card under Investing. It still edits the PLAN (assumption_overrides),
    // through get-mutate-put on the loaded plan.
    const bondsSelect = read('../../src/ui/components/scenarios/BondsAreSelect.tsx');
    const investingModule = read('../../src/ui/modules/InvestingModule.tsx');
    expect(bondsSelect).toContain('export function BondsAreSelect');
    expect(bondsSelect).toContain('corporateFractionOf(overrides)');
    expect(investingModule).toContain('<BondsAreSelect overrides={plan.assumption_overrides}');
    // Ordered against the workbench's own writes, both directions: the mount
    // fetch waits out any pending autosave flush (a whole-plan PUT built on
    // a pre-flush fetch would RESURRECT the pre-edit plan), and each write
    // goes through chainPlanWrite, which serializes it and registers it as
    // the pending write the Plan page's next load waits for.
    expect(investingModule).toContain('awaitPendingPlanSave()');
    expect(investingModule).toContain('chainPlanWrite(() => api.putPlan(next))');
    // Both workbench doors CLOSED with the move: the Plan card renders no
    // bonds section, and the overrides card passes the stored value through
    // untouched instead of editing it.
    expect(planCard).not.toContain('<BondsAreSelect');
    expect(overridesCard).not.toContain('<CorporateShareField');
    expect(overridesCard).toContain('corporateShare: fresh.market.corporateShare');
  });

  it('Custom reveals the percent field, with its bound check and clear-on-blank', () => {
    const bondsSelect = read('../../src/ui/components/scenarios/BondsAreSelect.tsx');
    expect(bondsSelect).toMatch(/preset === 'custom' &&[\s\S]*?<CorporateShareField/);
    expect(sharedField).toContain('Corporate share of bonds (%)');
    expect(sharedField).toContain('corporateShareErrorText');
    // The commit converts percent → fraction exactly as buildOverrides does
    // (the box speaks 30, the schema speaks 0.3), and blank clears rather
    // than writing anything. Pinned at the source because the handler is the
    // one atom of this feature a pure test cannot execute.
    expect(bondsSelect).toContain('share === null ? undefined : share / 100');
  });

  it('compositions lead, funds anchor: the labels name what bonds ARE, and say the mapping is loose', () => {
    const bondsSelect = read('../../src/ui/components/scenarios/BondsAreSelect.tsx');
    // The model does not endorse products — the fund names appear only as
    // parenthetical anchors after the composition they stand for.
    expect(bondsSelect).toContain('US Treasuries — what VGIT tracks');
    expect(bondsSelect).toContain('Total bond market — what BND approximates (~30% corporate)');
    // The one-line tip: whole-plan scope (it is a market assumption, not a
    // per-event setting) and the approximate mapping, said out loud.
    expect(bondsSelect).toContain('One setting for the whole plan');
    expect(bondsSelect).toContain('The fund mapping is approximate');
  });
});
