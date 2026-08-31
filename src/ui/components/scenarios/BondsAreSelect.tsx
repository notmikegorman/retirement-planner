/**
 * The bond-composition dial, extracted whole from PlanCard.tsx when the
 * owner moved it under the Investing module (2026-08-30). The component
 * still edits the PLAN (assumption_overrides), not the profile — the
 * Investing module hosts it as an always-active card with its own
 * get-mutate-put write path (see InvestingModule.BondsCard).
 */
import { useState } from 'react';
import type { AssumptionOverrides } from '../../../shared/types';
import { CorporateShareField } from './CorporateShareField';
import {
  bondPresetFor,
  bondPresetFraction,
  corporateFractionOf,
  corporateShareErrorText,
  corporateShareText,
  parseNumber,
  setCorporateFraction,
  type BondPreset,
} from './scenarioHelpers';

/**
 * "Bonds are" — what the bond share IS, in the vocabulary of the instruments
 * the user would actually buy.
 *
 * ONE DIAL, ONE DOOR (the owner's relocation, 2026-08-30): this select is
 * the only editor of assumption_overrides.market.bondComposition.
 * corporateFraction now. It lived on the Plan card (with a twin field on the
 * assumption-overrides card) through the two-door era; the owner moved the
 * decision under the Investing module, and both workbench doors closed —
 * which also retired the cross-door staleness guards the review panels had
 * to add.
 * It OUTLIVED the allocation section it was born inside: the what-if that
 * section modeled was executed for real (2026-08-18) and the section retired,
 * but the accounts hold bonds every year of every plan, so the composition
 * dial keeps its own section on the card.
 *
 * The fund names are parenthetical anchors, never the primary vocabulary:
 * the model names compositions, not products, and the option labels carry
 * the approximate-mapping caveat themselves (the explanatory footer died
 * under the fluff rule, 2026-08-31).
 */
export function BondsAreSelect({
  overrides,
  onChange,
}: {
  overrides: AssumptionOverrides | undefined;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}) {
  const fraction = corporateFractionOf(overrides);
  const stored = bondPresetFor(fraction);
  /*
   * Menu intent, not a cached value. Picking "Custom" writes nothing until a
   * number is committed, so without this flag the select would snap straight
   * back to the stored preset and the field could never be revealed. It only
   * ever FORCES 'custom': the two concrete presets write through immediately
   * and re-derive from the stored plan, and a remount (tab switch, plan
   * replace) re-derives everything from the override again.
   */
  const [customChosen, setCustomChosen] = useState(false);
  const preset: BondPreset = customChosen ? 'custom' : stored;
  /** The Custom box's typing buffer (parse-on-blur, like every number field). */
  const [customText, setCustomText] = useState(() =>
    fraction !== undefined ? corporateShareText(fraction) : '',
  );

  const pick = (next: BondPreset) => {
    if (next === 'custom') {
      // Seed the box from what is stored NOW (0.3 flips to "30", ready to
      // edit), then just reveal it — nothing is written until it commits.
      setCustomText(fraction !== undefined ? corporateShareText(fraction) : '');
      setCustomChosen(true);
      return;
    }
    setCustomChosen(false);
    // Treasuries CLEARS rather than writing 0: absent already means
    // all-Treasury, so a plan that never set the dial stays untouched and a
    // flip away-and-back leaves no residue (setCorporateFraction has the
    // full contrast with the OverridesCard's typed-0 convention).
    onChange(setCorporateFraction(overrides, bondPresetFraction(next)));
  };

  const commitCustom = (text: string) => {
    // Out-of-range or non-numeric input shows its error inline (the shared
    // field computes it) and is never written — the OverridesCard rule.
    if (corporateShareErrorText(text) !== undefined) return;
    const share = parseNumber(text);
    // Blank clears, like blanking the Settings field: "no stated share".
    onChange(setCorporateFraction(overrides, share === null ? undefined : share / 100));
  };

  return (
    // No inner divider: the Section heading above already sets this block off.
    <div>
      <div className="row">
        <label className="field" style={{ width: 340 }}>
          <span className="field-label">Bonds are</span>
          <select value={preset} onChange={(e) => pick(e.target.value as BondPreset)}>
            <option value="treasuries">US Treasuries — what VGIT tracks</option>
            <option value="total_bond">
              Total bond market — what BND approximates (~30% corporate)
            </option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {preset === 'custom' && (
          <CorporateShareField
            value={customText}
            placeholder="0"
            onChange={setCustomText}
            onBlur={commitCustom}
          />
        )}
      </div>
      {/* No explanatory footer (the owner's fluff rule, 2026-08-31). */}
    </div>
  );
}
