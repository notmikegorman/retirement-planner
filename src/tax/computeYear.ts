/**
 * tax.computeYear — the SPEC §7 entry point. Orchestrates federal, state,
 * ACA premium tax credit, and Medicare/IRMAA for one tax year.
 *
 * Ordering (no circularity): the federal itemized deduction needs the state
 * income tax for SALT, but every 2026 state module starts from federal AGI
 * (not federal taxable income), so:
 *   1. preliminary federal pass — income pieces (AGI, taxable SS) plus the
 *      standard deduction only, to fill FederalSummaryForState;
 *   2. state tax from that summary;
 *   3. final federal pass with stateTaxForSalt = state total;
 *   4. ACA PTC (on ACA MAGI) and Medicare premiums/IRMAA;
 *   5. assemble TaxYearResult. totalTax = federal + state + penalties —
 *      ACA/Medicare premiums are expense-side and returned separately.
 *
 * Pure and deterministic. Trace work happens only when opts.trace is set;
 * the untraced path allocates no trace strings/objects (Monte Carlo hot path).
 */

import type {
  ComputeYearOptions,
  TaxDataBundle,
  TaxYearInputs,
  TaxYearResult,
  TraceLine,
} from '../shared/types';
import { computeAca, computeMedicare } from './acaMedicare';
import { computeFederal, computeFederalIncomePieces } from './federal';
import { computeStateTax, type FederalSummaryForState } from './states';

export function computeYear(
  inputs: TaxYearInputs,
  data: TaxDataBundle,
  opts?: ComputeYearOptions,
): TaxYearResult {
  const trace: TraceLine[] | undefined = opts?.trace ? [] : undefined;
  trace?.push({
    // MFJ wording is untouched on purpose: engine tests digest the reference
    // path's traces, and a joint run must be byte-identical to the one this
    // file produced before filing status existed.
    label:
      inputs.filingStatus === 'single'
        ? `Tax year ${inputs.year} — SINGLE (survivor), ${inputs.state.toUpperCase()} resident, ${inputs.agesAtYearEnd.length} in the tax household`
        : `Tax year ${inputs.year} — MFJ, ${inputs.state.toUpperCase()} resident`,
    note:
      'State tax is computed from a preliminary standard-deduction federal pass, then feeds the federal SALT itemization (no circularity: all 2026 state modules start from federal AGI).' +
      (inputs.filingStatus === 'single'
        ? ' SINGLE is the survivor: from the first full year after a death the household files alone, on roughly half the standard deduction, brackets that compress far faster, Social Security taxable $7,000 of provisional income sooner, NIIT at $200,000, single IRMAA tiers and a one-person federal poverty level.'
        : ''),
  });

  const stateData = data.states[inputs.state];
  if (!stateData) {
    throw new Error(`No state tax data for '${inputs.state}' (year ${inputs.year})`);
  }

  // --- 1. Preliminary federal pass (standard-deduction basis, untraced) ------
  const prelim = computeFederalIncomePieces(inputs, data.federal);
  const fedForState: FederalSummaryForState = {
    agi: prelim.agi,
    // Standard-deduction basis by construction (charitable deductions —
    // itemized or non-itemizer — are federal-only and excluded here); only
    // relevant to hypothetical 'federal_taxable_income' starting points
    // (no 2026 state uses one — all three start from federal AGI).
    taxableIncome: Math.max(0, prelim.agi - prelim.standardDeduction),
    ssTaxableAmount: prelim.ssTaxableAmount,
    standardDeduction: prelim.standardDeduction,
    itemizedDeduction: 0,
    deductionUsed: 'standard',
  };

  // --- 2. State tax ----------------------------------------------------------
  // Traced into its own buffer so the final trace reads federal-first even
  // though the state must be computed before the final federal pass.
  const stateTrace: TraceLine[] | undefined = trace ? [] : undefined;
  const state = computeStateTax(inputs, stateData, fedForState, stateTrace);

  // --- 3. Final federal pass with state income tax feeding SALT --------------
  const fed = computeFederal(inputs, data.federal, state.total, trace);
  if (trace && stateTrace) trace.push(...stateTrace);

  // --- 4. ACA premium tax credit and Medicare premiums/IRMAA -----------------
  const aca = computeAca(inputs, data.aca, fed.magi.acaMagi, trace);
  const medicare = computeMedicare(inputs, data.medicare, trace);

  // --- 5. Assemble -----------------------------------------------------------
  const { magi, penalties, ...federal } = fed;
  const totalTax = federal.total + state.total + penalties;
  trace?.push({
    label: 'Total tax (federal + state + penalties)',
    amount: totalTax,
    note: `federal ${federal.total.toFixed(2)} + state ${state.total.toFixed(
      2,
    )} + penalties ${penalties.toFixed(2)}; ACA/Medicare premiums are expenses, not taxes`,
  });

  return {
    federal,
    state: { code: inputs.state, taxableIncome: state.taxableIncome, total: state.total },
    penalties,
    aca,
    medicare,
    magi,
    totalTax,
    ...(trace ? { trace } : {}),
  };
}
