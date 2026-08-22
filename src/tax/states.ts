/**
 * State income-tax modules (SPEC §7): Virginia, South Carolina, North Carolina.
 *
 * Fully data-driven off `StateTaxData`: each deduction applies when its data
 * block is present, so a future-year data file can change amounts (or drop a
 * deduction) without code changes. All three 2026 states start from federal
 * AGI and exempt Social Security. The generic 'federal_taxable_income'
 * starting point is also supported (uses fed.taxableIncome and skips the
 * state standard deduction, since the federal deduction is already netted
 * out) even though no 2026 state file uses it.
 *
 * FILING STATUS. At the state level the widow penalty is almost entirely a
 * DEDUCTIONS story rather than a bracket story, which is why this file has no
 * per-status bracket tables: Virginia imposes its rates on "every individual"
 * (§58.1-320) with no filing-status split, South Carolina's $30,000 bracket
 * threshold does not vary by status either, and North Carolina is flat. What
 * DOES halve is Virginia's standard deduction ($17,500 -> $8,750), South
 * Carolina's SCIAD ($30,000 -> $15,000, phasing out from $40,000 instead of
 * $80,000) and North Carolina's standard deduction ($25,500 -> $12,750).
 *
 * Two things here are per-PERSON rather than per-status and so need no
 * single-filer data at all — they simply see a one-person household after a
 * death: Virginia's personal exemptions and 65+ add-ons, and South Carolina's
 * retirement-income and senior deductions. The one genuinely non-proportional
 * figure is Virginia's age-deduction AFAGI threshold, which falls from $75,000
 * to $50,000 rather than to $37,500.
 *
 * Documented simplifications:
 * - Each state applies its own standard deduction (or SCIAD) regardless of
 *   whether the household itemized federally.
 * - Bracket thresholds and deduction amounts scale by inputs.inflationIndex
 *   ONLY when data.indexed is true (all three 2026 files ship false).
 *
 * Pure and deterministic. When `trace` is undefined this function does ZERO
 * trace work — it runs ~2M times inside Monte Carlo. (Optional chaining on
 * `trace?.push(...)` short-circuits argument evaluation, so no strings or
 * objects are built on the hot path.)
 */

import type { StateCode, StateTaxData, TaxYearInputs, TraceLine } from '../shared/types';

/** Federal figures the state calculation needs (produced by computeYear). */
export interface FederalSummaryForState {
  agi: number;
  taxableIncome: number; // federal taxable income (standard-deduction basis)
  ssTaxableAmount: number; // federally taxable portion of Social Security
  standardDeduction: number;
  itemizedDeduction: number;
  deductionUsed: 'standard' | 'itemized';
}

const STATE_NAMES: Record<StateCode, string> = {
  va: 'Virginia',
  sc: 'South Carolina',
  nc: 'North Carolina',
};

/** Account types whose taxable distributions count as pre-tax retirement income (SC deduction). */
const PRETAX_RETIREMENT_TYPES: ReadonlySet<string> = new Set(['401k', 'traditional_ira']);

/** "0.0575" -> "5.75%", "0.02" -> "2%". */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function usd(x: number): string {
  return `$${x.toFixed(2)}`;
}

/**
 * Sum taxable pre-tax retirement distributions ('401k' / 'traditional_ira')
 * per person, as an array aligned with inputs.agesAtYearEnd.
 *
 * TaxYearInputs carries no personId list, so distinct personIds seen in
 * inputs.distributions are mapped to person indexes in order of first
 * appearance. When both household members share a birth year the mapping can
 * never attach the wrong age; when they do not, the risk is a per-person age
 * deduction applied to the wrong one. If person-id plumbing is ever added to
 * TaxYearInputs this should switch to an exact lookup.
 */
function retirementTaxableByPerson(inputs: TaxYearInputs): number[] {
  const perPerson = new Array<number>(inputs.agesAtYearEnd.length).fill(0);
  if (perPerson.length === 0) return perPerson;
  const idToIndex = new Map<string, number>();
  for (const d of inputs.distributions) {
    if (!PRETAX_RETIREMENT_TYPES.has(d.accountType)) continue;
    let i = idToIndex.get(d.personId);
    if (i === undefined) {
      i = Math.min(idToIndex.size, perPerson.length - 1);
      idToIndex.set(d.personId, i);
    }
    perPerson[i] += Math.max(0, d.taxableAmount);
  }
  return perPerson;
}

/** Progressive-bracket tax. `scale` multiplies each threshold (inflation indexing). */
function bracketTax(
  taxable: number,
  brackets: NonNullable<StateTaxData['brackets']>,
  scale: number,
  trace?: TraceLine[],
): number {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo === null ? Infinity : b.upTo * scale;
    if (taxable <= lower) break;
    const slice = Math.min(taxable, upper) - lower;
    const sliceTax = slice * b.rate;
    tax += sliceTax;
    trace?.push({
      label: `${pct(b.rate)} bracket`,
      amount: sliceTax,
      note: `on ${usd(slice)} of income`,
      indent: 2,
    });
    lower = upper;
  }
  return tax;
}

/**
 * Compute state income tax for the year. Returns state taxable income and the
 * total state tax, both floored at 0.
 */
export function computeStateTax(
  inputs: TaxYearInputs,
  data: StateTaxData,
  fed: FederalSummaryForState,
  trace?: TraceLine[],
): { taxableIncome: number; total: number } {
  const name = STATE_NAMES[data.state];
  const single = inputs.filingStatus === 'single';
  const statusLabel = single ? 'single' : 'MFJ';
  // Thresholds/deductions index with inflation only when the data file says so.
  const scale = data.indexed ? inputs.inflationIndex : 1;
  const fromFederalTaxable = data.startingPoint === 'federal_taxable_income';
  const start = fromFederalTaxable ? fed.taxableIncome : fed.agi;

  trace?.push({ label: `${name} state tax (${inputs.year})` });
  trace?.push({
    label: `Starting point: ${fromFederalTaxable ? 'federal taxable income' : 'federal AGI'}`,
    amount: start,
    indent: 1,
  });

  let taxable = start;

  // --- Social Security exemption (all three states) -------------------------
  if (!data.socialSecurityTaxed && fed.ssTaxableAmount > 0) {
    taxable -= fed.ssTaxableAmount;
    trace?.push({
      label: 'Less: federally taxable Social Security (state-exempt)',
      amount: -fed.ssTaxableAmount,
      indent: 1,
    });
  }

  // --- State standard deduction (VA, NC) ------------------------------------
  // The state's own deduction applies regardless of the federal
  // standard-vs-itemized choice (documented simplification). Skipped when the
  // starting point is federal taxable income — the federal deduction is
  // already netted out of that figure. A year-specific schedule
  // (standardDeductionMfjByYear, e.g. Virginia's enacted 2025-2029 elevated
  // amounts) takes precedence; years absent from the map fall back to
  // standardDeductionMfj.
  //
  // A SINGLE filer reads the parallel single fields, resolved the same way.
  // There is deliberately NO fallback from the single fields to the MFJ ones:
  // a data file that forgot the single schedule would otherwise hand a widow
  // the couple's deduction and understate the survivor's tax for life, and the
  // whole point of the widow score is that it must not flatter it. An absent single
  // deduction means no deduction, which is wrong in the direction that gets
  // noticed.
  const stdBase = single
    ? (data.standardDeductionSingleByYear?.[String(inputs.year)] ?? data.standardDeductionSingle)
    : (data.standardDeductionMfjByYear?.[String(inputs.year)] ?? data.standardDeductionMfj);
  if (!fromFederalTaxable && stdBase !== undefined) {
    const std = stdBase * scale;
    taxable -= std;
    trace?.push({
      label: `Less: ${name} standard deduction (${statusLabel})`,
      amount: -std,
      indent: 1,
    });
  }

  const numPeople = inputs.agesAtYearEnd.length;
  let num65 = 0;
  for (const age of inputs.agesAtYearEnd) if (age >= 65) num65++;

  // --- VA personal exemptions -----------------------------------------------
  if (data.vaExemptions) {
    const exemptions =
      (data.vaExemptions.perPerson * numPeople + data.vaExemptions.additional65 * num65) * scale;
    if (exemptions > 0) {
      taxable -= exemptions;
      trace?.push({
        label: 'Less: personal exemptions',
        amount: -exemptions,
        note: `${numPeople} x ${usd(data.vaExemptions.perPerson * scale)}${
          num65 > 0 ? ` + ${num65} x ${usd(data.vaExemptions.additional65 * scale)} (65+)` : ''
        }`,
        indent: 1,
      });
    }
  }

  // --- VA age deduction ------------------------------------------------------
  // $12,000 per person 65+, reduced $1-for-$1 by combined AFAGI over the
  // threshold for the filing status, where AFAGI = federal AGI minus federally
  // taxable SS. Floor 0.
  //
  // THE THRESHOLD IS THE ONE VIRGINIA FIGURE THAT IS NOT PROPORTIONAL:
  // §58.1-322.03(5.b) says "$50,000 for single taxpayers or $75,000 for
  // married taxpayers", so it drops by a third rather than by half. A widow
  // therefore starts losing this deduction $25,000 of income sooner than a
  // halving rule would have predicted.
  if (data.vaAgeDeduction && num65 > 0) {
    const afagi = fed.agi - fed.ssTaxableAmount;
    const thresholdBase = single
      ? (data.vaAgeDeduction.afagiThresholdSingle ?? data.vaAgeDeduction.afagiThresholdMfj)
      : data.vaAgeDeduction.afagiThresholdMfj;
    const threshold = thresholdBase * scale;
    const grossDeduction = data.vaAgeDeduction.perPerson65Plus * scale * num65;
    const reduction = Math.max(0, afagi - threshold);
    const ageDeduction = Math.max(0, grossDeduction - reduction);
    if (ageDeduction > 0) {
      taxable -= ageDeduction;
      trace?.push({
        label: 'Less: age deduction (65+)',
        amount: -ageDeduction,
        note:
          reduction > 0
            ? `${usd(grossDeduction)} reduced by AFAGI ${usd(afagi)} over ${usd(threshold)}`
            : `${num65} x ${usd(data.vaAgeDeduction.perPerson65Plus * scale)}; AFAGI ${usd(afagi)} under ${usd(threshold)} threshold`,
        indent: 1,
      });
    } else {
      trace?.push({
        label: 'Age deduction fully phased out',
        amount: 0,
        note: `AFAGI ${usd(afagi)} exceeds ${usd(threshold)} by more than ${usd(grossDeduction)}`,
        indent: 1,
      });
    }
  }

  // --- SC deductions ---------------------------------------------------------
  if (data.scDeductions) {
    const sc = data.scDeductions;

    // SCIAD (H.4216 TY2026+): flat deduction replacing the federal standard
    // deduction, phased out proportionally over FAGI phaseoutStart..+range.
    if (sc.sciad) {
      // Single: $15,000, phasing out from $40,000 over a $55,000 range — every
      // figure exactly half the MFJ one for 2026, and written out rather than
      // halved for the reason the federal 37% bracket exists to teach.
      const sciadAmount = single ? (sc.sciad.amountSingle ?? 0) : sc.sciad.amountMfj;
      const phaseoutStart =
        (single ? (sc.sciad.phaseoutStartSingle ?? 0) : sc.sciad.phaseoutStartMfj) * scale;
      const phaseoutRange =
        (single ? (sc.sciad.phaseoutRangeSingle ?? 0) : sc.sciad.phaseoutRangeMfj) * scale;
      const excess = Math.max(0, fed.agi - phaseoutStart);
      const factor =
        phaseoutRange > 0 ? Math.max(0, 1 - excess / phaseoutRange) : excess > 0 ? 0 : 1;
      const sciad = sciadAmount * scale * factor;
      if (sciad > 0) {
        taxable -= sciad;
        trace?.push({
          label: `Less: SC Income Adjusted Deduction (SCIAD${single ? ', single' : ''})`,
          amount: -sciad,
          note:
            factor < 1
              ? `${usd(sciadAmount * scale)} x ${factor.toFixed(4)} (FAGI ${usd(fed.agi)} in phase-out ${usd(phaseoutStart)}-${usd(phaseoutStart + phaseoutRange)})`
              : `full amount; FAGI ${usd(fed.agi)} under ${usd(phaseoutStart)}`,
          indent: 1,
        });
      } else {
        trace?.push({
          label: 'SCIAD fully phased out',
          amount: 0,
          note: `FAGI ${usd(fed.agi)} at or above ${usd(phaseoutStart + phaseoutRange)}`,
          indent: 1,
        });
      }
    }

    // Retirement-income deduction: per person, taxable pre-tax retirement
    // distributions capped at $3,000 under 65 / $10,000 at 65+.
    const retirementTaxable = retirementTaxableByPerson(inputs);
    const claimed = new Array<number>(numPeople).fill(0);
    let retirementDeduction = 0;
    for (let i = 0; i < numPeople; i++) {
      const cap =
        (inputs.agesAtYearEnd[i] >= 65 ? sc.retirementDeduction65Plus : sc.retirementDeductionUnder65) *
        scale;
      claimed[i] = Math.min(retirementTaxable[i], cap);
      retirementDeduction += claimed[i];
    }
    if (retirementDeduction > 0) {
      taxable -= retirementDeduction;
      trace?.push({
        label: 'Less: retirement-income deduction',
        amount: -retirementDeduction,
        note: claimed
          .map((c, i) => `person ${i + 1}: ${usd(c)} (age ${inputs.agesAtYearEnd[i]})`)
          .join('; '),
        indent: 1,
      });
    }

    // Senior deduction: per person 65+, $15,000 reduced by the retirement
    // deduction that person claimed.
    let seniorDeduction = 0;
    for (let i = 0; i < numPeople; i++) {
      if (inputs.agesAtYearEnd[i] >= 65) {
        seniorDeduction += Math.max(0, sc.seniorDeduction65Plus * scale - claimed[i]);
      }
    }
    if (seniorDeduction > 0) {
      taxable -= seniorDeduction;
      trace?.push({
        label: 'Less: senior deduction (65+)',
        amount: -seniorDeduction,
        note: `${usd(sc.seniorDeduction65Plus * scale)} per person 65+, reduced by that person's retirement deduction`,
        indent: 1,
      });
    }
  }

  // --- Floor and tax ---------------------------------------------------------
  taxable = Math.max(0, taxable);
  trace?.push({ label: `${name} taxable income`, amount: taxable, indent: 1 });

  let total: number;
  if (data.kind === 'flat') {
    const rate = data.flatRateByYear?.[String(inputs.year)] ?? data.flatRateFallback;
    if (rate === undefined) {
      throw new Error(
        `State tax data for '${data.state}' is kind 'flat' but has no rate for ${inputs.year} and no flatRateFallback`,
      );
    }
    total = taxable * rate;
    trace?.push({
      label: `Flat rate ${pct(rate)}`,
      amount: total,
      note:
        data.flatRateByYear?.[String(inputs.year)] !== undefined
          ? `rate for ${inputs.year}`
          : 'fallback rate (year beyond schedule)',
      indent: 1,
    });
  } else {
    if (!data.brackets || data.brackets.length === 0) {
      throw new Error(`State tax data for '${data.state}' is kind 'brackets' but has no brackets`);
    }
    total = bracketTax(taxable, data.brackets, scale, trace);
  }

  total = Math.max(0, total);
  trace?.push({ label: `${name} tax`, amount: total, indent: 1 });

  return { taxableIncome: taxable, total };
}
