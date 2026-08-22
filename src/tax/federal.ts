/**
 * Federal income tax (SPEC §7): ordinary brackets, LTCG/qualified-dividend
 * stacking, the Social Security taxation worksheet, NIIT, the 10%
 * early-withdrawal penalty, the standard-vs-itemized deduction choice with the
 * OBBBA SALT cap, the OBBBA charitable deductions (itemizer 0.5%-of-AGI floor
 * + 60%-of-AGI cash ceiling; non-itemizer above-the-line deduction), and the
 * MAGI variants (ACA / IRMAA / NIIT).
 *
 * FILING STATUS. Every status-dependent figure is read through one of the
 * small resolvers at the top of this file, and each resolver reads a LITERAL
 * table for the status it is given — nothing here derives a single-filer
 * number from an MFJ one. That is not fastidiousness: halving the MFJ brackets
 * gets the 37% entry wrong by $256,250 (it produces the married-filing-
 * separately figure), halving the LTCG 15% ceiling gets it wrong by $238,650,
 * and the same trap sits in the top IRMAA tier one module over. The single
 * side of this file is what makes a widow score honest; a model that ran a
 * survivor's cash flows through joint brackets would systematically flatter
 * the answer and could tell a household it is safe to drop a life-insurance
 * policy when it is not.
 *
 * Indexing convention (SPEC §7):
 * - INDEXED by inputs.inflationIndex: brackets, standard deduction (incl. the
 *   65+ add-on), LTCG breakpoints, SALT phase-down MAGI threshold.
 * - STATUTORY / NEVER indexed: SS provisional-income thresholds ($32k/$44k MFJ,
 *   $25k/$34k single), NIIT threshold ($250k MFJ, $200k single), the SALT cap
 *   dollar amounts themselves (per-year table + fallback), the non-itemizer
 *   charitable deduction cap ($2k MFJ, $1k single). The charitable itemizer
 *   floor/ceiling are AGI fractions.
 * - NOT status-dependent at all: the SALT cap and its phase-down. IRC
 *   164(b)(6) gives single and joint filers the SAME applicable limitation
 *   amount and the same $500,000-ish phase-down threshold; only married filing
 *   separately takes half of each, and this planner does not model that status.
 *   Verified against the statute, because "surely it halves like everything
 *   else" was the tempting wrong answer.
 *
 * Documented simplification: net capital losses offset at most $3,000 of
 * ordinary income (IRC §1211(b)) and there is NO loss carryforward — the
 * engine realizes gains, not harvested losses, in normal operation.
 *
 * Pure and deterministic. Trace convention: when a `trace` array is provided,
 * push human-readable TraceLine rows for every meaningful step. When `trace`
 * is undefined, do ZERO trace work — this code runs ~2M times inside Monte
 * Carlo. (Optional chaining on `trace?.push(...)` short-circuits argument
 * evaluation, so no strings or objects are built on the hot path.)
 */

import type {
  FederalBracket,
  FederalTaxData,
  FilingStatus,
  TaxYearInputs,
  TaxYearResult,
  TraceLine,
} from '../shared/types';

// ---------------------------------------------------------------------------
// Filing-status resolvers
// ---------------------------------------------------------------------------
// One per status-dependent figure, each returning a literal table. They are
// exported so tests (and the UI's tax-detail view) can ask the same question
// the engine asks, and so nothing anywhere has to remember which fields pair
// with which status.

/** Ordinary bracket table for the status. */
export function bracketsFor(data: FederalTaxData, status: FilingStatus): FederalBracket[] {
  return status === 'single' ? data.bracketsSingle : data.bracketsMfj;
}

/**
 * Base standard deduction and the per-person 65+ add-on for the status.
 *
 * The add-on is the subtle one. §63(f) sets $1,650 per aged/blind individual
 * and raises it to $2,050 "if the individual is also unmarried and not a
 * surviving spouse" — where "surviving spouse" means the §2(a) status that
 * requires a dependent child. A widow with no dependent child is therefore
 * unmarried AND not a surviving spouse, so they get the larger figure. Reusing
 * the married per-spouse amount for both statuses would quietly cost them $400
 * of deduction a year for the rest of their life.
 */
export function standardDeductionParts(
  data: FederalTaxData,
  status: FilingStatus,
): { base: number; per65: number } {
  return status === 'single'
    ? { base: data.standardDeductionSingle, per65: data.additionalStdDeduction65Unmarried }
    : { base: data.standardDeductionMfj, per65: data.additionalStdDeduction65 };
}

/** 0%/15%/20% LTCG breakpoints for the status. */
export function ltcgBreakpointsFor(
  data: FederalTaxData,
  status: FilingStatus,
): { zeroRateTop: number; fifteenRateTop: number } {
  return status === 'single' ? data.ltcgBreakpointsSingle : data.ltcgBreakpointsMfj;
}

/** NIIT MAGI threshold for the status (statutory, never indexed). */
export function niitThresholdFor(data: FederalTaxData, status: FilingStatus): number {
  return status === 'single' ? data.niitThresholdSingle : data.niitThresholdMfj;
}

/** Social Security provisional-income thresholds for the status (statutory, never indexed). */
export function ssThresholdsFor(
  data: FederalTaxData,
  status: FilingStatus,
): { tier1: number; tier2: number } {
  return status === 'single' ? data.ssTaxationThresholdsSingle : data.ssTaxationThresholdsMfj;
}

/** Non-itemizer charitable deduction cap for the status (IRC 170(p); never indexed). */
export function nonItemizerCharitableCap(data: FederalTaxData, status: FilingStatus): number {
  return status === 'single'
    ? data.charitable.nonItemizerDeductionSingle
    : data.charitable.nonItemizerDeductionMfj;
}

/**
 * §121 primary-residence gain exclusion for a sale in `saleYear`.
 *
 * $500,000 on a joint return, $250,000 unmarried — EXCEPT that §121(b)(4)
 * keeps the full $500,000 for an unmarried surviving spouse when the sale
 * "occurs not later than 2 years after the date of death of such spouse and
 * the requirements of paragraph (2)(A) were met immediately before such date
 * of death". A household that sells around retirement lives inside that
 * window, so a death-then-sale sequence keeps the whole exclusion.
 *
 * `deathYear` is the calendar year of a `death` event, or null when nobody
 * died. The two-year test is really date-to-date; with annual steps the engine
 * reads it as saleYear <= deathYear + 2, which is the generous end of the
 * range for a sale late in year+2. That is deliberate: overstating a widow's
 * tax in the exact scenario the widow score exists to test would be the worse
 * error, and any household close enough to the boundary for the month to
 * matter is a household that should time the sale rather than trust a model.
 */
export function homeSaleExclusionFor(
  data: FederalTaxData,
  status: FilingStatus,
  saleYear: number,
  deathYear: number | null,
): number {
  if (status !== 'single') return data.homeSaleExclusionMfj;
  if (deathYear !== null && saleYear <= deathYear + 2) return data.homeSaleExclusionMfj;
  return data.homeSaleExclusionSingle;
}

/** "0.038" -> "3.8%", "0.1" -> "10%". */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function usd(x: number): string {
  return `$${x.toFixed(2)}`;
}

/** Scale a base-year dollar amount by the cumulative CPI index. */
export function indexAmount(x: number, inflationIndex: number): number {
  return x * inflationIndex;
}

/**
 * Continuous piecewise-linear progressive bracket tax. Bracket `upTo`
 * thresholds scale by `index` (CPI indexing); rates are fixed. No rounding.
 */
export function bracketTax(
  taxable: number,
  brackets: FederalBracket[],
  index: number,
  trace?: TraceLine[],
): number {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo === null ? Infinity : b.upTo * index;
    if (taxable <= lower) break;
    const slice = Math.min(taxable, upper) - lower;
    const sliceTax = slice * b.rate;
    tax += sliceTax;
    trace?.push({
      label: `${pct(b.rate)} bracket`,
      amount: sliceTax,
      note: `on ${usd(slice)} of ordinary income (bracket ${usd(lower)}-${
        upper === Infinity ? 'up' : usd(upper)
      })`,
      indent: 2,
    });
    lower = upper;
  }
  return tax;
}

/**
 * Social Security taxation worksheet (IRC §86), implemented exactly.
 * Provisional income PI = otherIncome + taxExemptInterest + 0.5 x ssGross.
 * Thresholds are STATUTORY and never indexed (which is why SS taxation creeps
 * upward in real terms): $32,000 / $44,000 on a joint return, $25,000 /
 * $34,000 for a single filer. The survivor's pair is $7,000 lower at BOTH
 * tiers on a benefit that has itself just fallen, so the share of it they keep
 * tax-free falls twice over.
 *
 * - PI <= t1: 0 taxable.
 * - t1 < PI <= t2: min(0.5 x (PI - t1), 0.5 x ssGross).
 * - PI > t2: min(0.85 x ssGross,
 *               0.85 x (PI - t2)
 *               + min(min(0.5 x (PI - t1), 0.5 x ssGross), 0.5 x (t2 - t1))).
 *   The last min-term is the lesser of the tier-1 amount and $6,000.
 */
export function ssTaxableWorksheet(
  ssGross: number,
  otherIncomeForProvisional: number,
  taxExemptInterest: number,
  thresholds: { tier1: number; tier2: number },
  trace?: TraceLine[],
): number {
  if (ssGross <= 0) return 0;
  const t1 = thresholds.tier1;
  const t2 = thresholds.tier2;
  const pi = otherIncomeForProvisional + taxExemptInterest + 0.5 * ssGross;

  trace?.push({
    label: 'Social Security taxation worksheet',
    indent: 1,
  });
  trace?.push({
    label: 'Provisional income',
    amount: pi,
    note: `other income ${usd(otherIncomeForProvisional)} + tax-exempt interest ${usd(
      taxExemptInterest,
    )} + 50% of SS ${usd(0.5 * ssGross)}; thresholds ${usd(t1)}/${usd(t2)} statutory, never indexed`,
    indent: 2,
  });

  let taxable: number;
  if (pi <= t1) {
    taxable = 0;
    trace?.push({
      label: 'Tier: none taxable',
      amount: 0,
      note: `provisional income ${usd(pi)} <= ${usd(t1)}`,
      indent: 2,
    });
  } else if (pi <= t2) {
    taxable = Math.min(0.5 * (pi - t1), 0.5 * ssGross);
    trace?.push({
      label: 'Tier: up to 50% taxable',
      amount: taxable,
      note: `min(50% x (PI - ${usd(t1)}) = ${usd(0.5 * (pi - t1))}, 50% x SS = ${usd(
        0.5 * ssGross,
      )})`,
      indent: 2,
    });
  } else {
    const tier1Amount = Math.min(0.5 * (pi - t1), 0.5 * ssGross);
    const capped = Math.min(tier1Amount, 0.5 * (t2 - t1));
    const formula = 0.85 * (pi - t2) + capped;
    taxable = Math.min(0.85 * ssGross, formula);
    trace?.push({
      label: 'Tier: up to 85% taxable',
      amount: taxable,
      note: `min(85% x SS = ${usd(0.85 * ssGross)}, 85% x (PI - ${usd(t2)}) = ${usd(
        0.85 * (pi - t2),
      )} + min(tier-1 amount ${usd(tier1Amount)}, ${usd(0.5 * (t2 - t1))}) = ${usd(formula)})${
        0.85 * ssGross <= formula ? ' — 85% cap binds' : ''
      }`,
      indent: 2,
    });
  }
  return taxable;
}

/**
 * SALT itemized-deduction cap for the year. Years present in `saltCapByYear`
 * carry the elevated OBBBA cap, which phases down by `rate` x (MAGI - indexed
 * threshold), floored at `floor`. Years past the table use the (unindexed)
 * statutory fallback with no phase-down.
 */
export function saltCap(
  data: FederalTaxData,
  year: number,
  magi: number,
  inflationIndex: number,
): number {
  const elevated = data.saltCapByYear[String(year)];
  if (elevated === undefined) return data.saltCapFallback;
  const excess = Math.max(0, magi - data.saltPhaseDown.magiThreshold * inflationIndex);
  return Math.max(data.saltPhaseDown.floor, elevated - data.saltPhaseDown.rate * excess);
}

/** Income-side pieces shared by the preliminary (state) and final federal passes. */
export interface FederalIncomePieces {
  /** All income except Social Security (net capital losses capped at -$3,000). */
  otherIncome: number;
  /** Federally taxable portion of Social Security (worksheet). */
  ssTaxableAmount: number;
  /** otherIncome + ssTaxableAmount. */
  agi: number;
  /** (status base + per-person 65+ add-ons) x inflationIndex. */
  standardDeduction: number;
}

/**
 * Compute other income, taxable Social Security, AGI, and the standard
 * deduction. Exported separately so computeYear can run a cheap preliminary
 * standard-deduction pass to feed the state module before the final federal
 * pass (state income tax feeds the federal SALT itemization; no circularity
 * because every 2026 state module starts from AGI, not federal taxable income).
 */
export function computeFederalIncomePieces(
  inputs: TaxYearInputs,
  data: FederalTaxData,
  trace?: TraceLine[],
): FederalIncomePieces {
  // Net capital losses offset at most $3,000 of ordinary income (IRC
  // §1211(b)); no carryforward — documented simplification.
  const ltcgIncluded = Math.max(inputs.ltcg, -3000);

  const otherIncome =
    inputs.wages +
    inputs.taxableInterest +
    inputs.ordinaryDividends +
    inputs.pretaxDistributions +
    inputs.otherOrdinaryIncome +
    ltcgIncluded;

  if (trace) {
    if (inputs.wages !== 0) trace.push({ label: 'Wages', amount: inputs.wages, indent: 1 });
    if (inputs.taxableInterest !== 0)
      trace.push({ label: 'Taxable interest', amount: inputs.taxableInterest, indent: 1 });
    if (inputs.ordinaryDividends !== 0)
      trace.push({
        label: 'Ordinary dividends',
        amount: inputs.ordinaryDividends,
        note: `includes ${usd(inputs.qualifiedDividends)} qualified`,
        indent: 1,
      });
    if (inputs.pretaxDistributions !== 0)
      trace.push({
        label: 'Pre-tax retirement distributions (incl. RMDs and Roth conversions)',
        amount: inputs.pretaxDistributions,
        indent: 1,
      });
    if (inputs.otherOrdinaryIncome !== 0)
      trace.push({ label: 'Other ordinary income', amount: inputs.otherOrdinaryIncome, indent: 1 });
    if (inputs.ltcg !== 0)
      trace.push({
        label: 'Net long-term capital gain included in income',
        amount: ltcgIncluded,
        note:
          inputs.ltcg < -3000
            ? `net loss ${usd(inputs.ltcg)} capped at -$3,000 against ordinary income (no carryforward modeled)`
            : undefined,
        indent: 1,
      });
    trace.push({
      label: 'Total income excluding Social Security',
      amount: otherIncome,
      indent: 1,
    });
    if (inputs.socialSecurityGross !== 0)
      trace.push({
        label: 'Social Security benefits (gross)',
        amount: inputs.socialSecurityGross,
        indent: 1,
      });
  }

  const ssTaxableAmount = ssTaxableWorksheet(
    inputs.socialSecurityGross,
    otherIncome,
    inputs.taxExemptInterest,
    ssThresholdsFor(data, inputs.filingStatus),
    trace,
  );
  const agi = otherIncome + ssTaxableAmount;

  // agesAtYearEnd carries the year's TAX HOUSEHOLD (see TaxYearInputs), so a
  // widow's year counts one person and gets one 65+ add-on — at the higher
  // unmarried rate — without any special-casing here.
  let num65 = 0;
  for (const age of inputs.agesAtYearEnd) if (age >= 65) num65++;
  const std = standardDeductionParts(data, inputs.filingStatus);
  const standardDeduction = (std.base + std.per65 * num65) * inputs.inflationIndex;

  return { otherIncome, ssTaxableAmount, agi, standardDeduction };
}

/** Everything TaxYearResult.federal needs, plus the MAGI variants and penalties. */
export interface FederalResult {
  agi: number;
  standardDeduction: number;
  itemizedDeduction: number;
  deductionUsed: 'standard' | 'itemized';
  taxableIncome: number;
  taxableOrdinaryIncome: number;
  ssTaxableAmount: number;
  ordinaryTax: number;
  ltcgTax: number;
  niit: number;
  /** ordinaryTax + ltcgTax + niit (penalties reported separately). */
  total: number;
  magi: TaxYearResult['magi'];
  penalties: number;
}

/**
 * Full federal pass. `stateTaxForSalt` is the state income tax for the year
 * (computed by the caller from a preliminary standard-deduction pass), which
 * joins property tax under the SALT cap in the itemized deduction.
 */
export function computeFederal(
  inputs: TaxYearInputs,
  data: FederalTaxData,
  stateTaxForSalt: number,
  trace?: TraceLine[],
): FederalResult {
  const single = inputs.filingStatus === 'single';
  const statusLabel = single ? 'single' : 'MFJ';
  /*
   * An MFJ trace must come out BYTE-IDENTICAL to the one this file produced
   * before filing status existed. Two engine tests digest the whole reference
   * path — traces included — precisely so that an unintended change to a joint
   * run fails loudly, and a cosmetic label edit that moved those hashes would
   * spend that alarm on nothing. So every status annotation below is a SUFFIX
   * that is empty for MFJ, never a rewrite of the existing wording.
   */
  const statusSuffix = single ? ', single' : '';
  trace?.push({ label: `Federal income tax (${inputs.year}${statusSuffix})` });

  // --- 1. Income and AGI -----------------------------------------------------
  const pieces = computeFederalIncomePieces(inputs, data, trace);
  const { agi, ssTaxableAmount, standardDeduction } = pieces;
  trace?.push({ label: 'Adjusted gross income (AGI)', amount: agi, indent: 1 });

  // --- 2. Deductions ---------------------------------------------------------
  // Standard: (MFJ base + per-person 65+ add-on) x CPI index.
  // Itemized: mortgage interest + min(property tax + state income tax, SALT cap)
  // + charitable, where the elevated OBBBA SALT cap phases down with MAGI (~= AGI).
  const cap = saltCap(data, inputs.year, agi, inputs.inflationIndex);
  const saltPaid = inputs.itemizable.propertyTax + stateTaxForSalt;
  const saltAllowed = Math.min(saltPaid, cap);
  // Charitable (OBBBA, TY2026+, permanent). Itemizers: cash gifts are capped
  // at 60% of AGI (permanent ceiling), and only the portion above the
  // 0.5%-of-AGI floor is deductible. Both limits are fractions of AGI, so no
  // CPI indexing applies.
  const cashGifts = Math.max(0, inputs.charitableGiving);
  const charitableItemized = Math.max(
    0,
    Math.min(cashGifts, 0.6 * agi) - data.charitable.itemizerAgiFloor * agi,
  );
  const itemizedDeduction =
    inputs.itemizable.mortgageInterest + saltAllowed + charitableItemized;
  // Deduction choice is unchanged: max(standard, itemized). Documented
  // simplification: the rare filer whose standard + non-itemizer charitable
  // beats a marginally-larger itemized total is still modeled as itemizing.
  const deductionUsed: 'standard' | 'itemized' =
    itemizedDeduction > standardDeduction ? 'itemized' : 'standard';
  const deduction = Math.max(standardDeduction, itemizedDeduction);
  // Non-itemizer charitable deduction (OBBBA, TY2026+, permanent): when the
  // standard deduction is used, cash gifts up to the MFJ cap (statutory,
  // NEVER indexed) additionally reduce TAXABLE INCOME — not AGI, so the
  // ACA/IRMAA/NIIT MAGI variants are unaffected.
  const nonItemizerCap = nonItemizerCharitableCap(data, inputs.filingStatus);
  const nonItemizerCharitable =
    deductionUsed === 'standard' ? Math.min(cashGifts, nonItemizerCap) : 0;

  if (trace) {
    let num65 = 0;
    for (const age of inputs.agesAtYearEnd) if (age >= 65) num65++;
    const std = standardDeductionParts(data, inputs.filingStatus);
    trace.push({
      label: 'Standard deduction',
      amount: standardDeduction,
      note: `(${usd(std.base)} ${statusLabel}${
        num65 > 0
          ? ` + ${num65} x ${usd(std.per65)} (65+${
              inputs.filingStatus === 'single' ? ', unmarried rate' : ''
            })`
          : ''
      }) x ${inputs.inflationIndex.toFixed(4)} CPI index`,
      indent: 1,
    });
    const elevated = data.saltCapByYear[String(inputs.year)] !== undefined;
    const phaseNote =
      elevated && cap < (data.saltCapByYear[String(inputs.year)] as number)
        ? `; elevated cap ${usd(data.saltCapByYear[String(inputs.year)] as number)} phased down to ${usd(
            cap,
          )} by 30%-of-MAGI-excess rule`
        : '';
    trace.push({
      label: 'Itemized deduction',
      amount: itemizedDeduction,
      note: `mortgage interest ${usd(inputs.itemizable.mortgageInterest)} + SALT min(property ${usd(
        inputs.itemizable.propertyTax,
      )} + state income ${usd(stateTaxForSalt)}, cap ${usd(cap)}) = ${usd(saltAllowed)}${
        cashGifts > 0 ? ` + charitable ${usd(charitableItemized)}` : ''
      }${phaseNote}`,
      indent: 1,
    });
    if (cashGifts > 0) {
      trace.push({
        label: 'Charitable (itemized component)',
        amount: charitableItemized,
        note: `min(cash gifts ${usd(cashGifts)}, 60% x AGI = ${usd(0.6 * agi)}) - ${pct(
          data.charitable.itemizerAgiFloor,
        )}-of-AGI floor ${usd(data.charitable.itemizerAgiFloor * agi)}, not below $0 (OBBBA TY2026+)`,
        indent: 2,
      });
    }
    trace.push({
      label: `Deduction used: ${deductionUsed} (the larger)`,
      amount: deduction,
      indent: 1,
    });
    if (nonItemizerCharitable > 0) {
      trace.push({
        label: 'Non-itemizer charitable deduction',
        amount: nonItemizerCharitable,
        note: `min(cash gifts ${usd(cashGifts)}, ${usd(
          nonItemizerCap,
        )} ${statusLabel} cap, statutory/never indexed) — reduces taxable income, not AGI (OBBBA TY2026+)`,
        indent: 1,
      });
    }
  }

  // --- 3. Taxable income and the ordinary/preferential split -----------------
  const taxableIncome = Math.max(0, agi - deduction - nonItemizerCharitable);
  // Preferential income = qualified dividends + net LTCG (losses excluded).
  // The deduction eats into ORDINARY income first, preferential income last:
  // if the deduction reaches into preferential income, P shrinks to taxable.
  let preferential = inputs.qualifiedDividends + Math.max(0, inputs.ltcg);
  if (preferential > taxableIncome) preferential = taxableIncome;
  const taxableOrdinaryIncome = taxableIncome - preferential;

  trace?.push({ label: 'Taxable income', amount: taxableIncome, indent: 1 });
  trace?.push({
    label: 'Preferential income (qualified dividends + net LTCG)',
    amount: preferential,
    note: 'deduction applies to ordinary income first, preferential income last',
    indent: 1,
  });
  trace?.push({
    label: 'Ordinary taxable income',
    amount: taxableOrdinaryIncome,
    indent: 1,
  });

  // --- 4. Ordinary tax through the brackets ----------------------------------
  trace?.push({ label: `Ordinary tax by bracket${statusSuffix}`, indent: 1 });
  const ordinaryTax = bracketTax(
    taxableOrdinaryIncome,
    bracketsFor(data, inputs.filingStatus),
    inputs.inflationIndex,
    trace,
  );
  trace?.push({ label: 'Ordinary tax', amount: ordinaryTax, indent: 1 });

  // --- 5. LTCG/QD stacking on top of ordinary income -------------------------
  // Preferential income stacks ON TOP of ordinary income against the
  // CPI-indexed 0%/15%/20% breakpoints.
  const ltcgBands = ltcgBreakpointsFor(data, inputs.filingStatus);
  const zeroTop = ltcgBands.zeroRateTop * inputs.inflationIndex;
  const fifteenTop = ltcgBands.fifteenRateTop * inputs.inflationIndex;
  const zeroAmt = Math.min(Math.max(zeroTop - taxableOrdinaryIncome, 0), preferential);
  const fifteenAmt = Math.min(
    Math.max(fifteenTop - Math.max(taxableOrdinaryIncome, zeroTop), 0),
    preferential - zeroAmt,
  );
  const twentyAmt = preferential - zeroAmt - fifteenAmt;
  const ltcgTax = 0.15 * fifteenAmt + 0.2 * twentyAmt;

  if (trace && preferential > 0) {
    trace.push({
      label: 'LTCG/QD stacking (on top of ordinary income)',
      note: `0% up to ${usd(zeroTop)}, 15% up to ${usd(fifteenTop)} (breakpoints x ${inputs.inflationIndex.toFixed(4)} CPI index)`,
      indent: 1,
    });
    trace.push({ label: 'Taxed at 0%', amount: zeroAmt, note: 'no tax', indent: 2 });
    trace.push({ label: 'Taxed at 15%', amount: fifteenAmt, note: `tax ${usd(0.15 * fifteenAmt)}`, indent: 2 });
    trace.push({ label: 'Taxed at 20%', amount: twentyAmt, note: `tax ${usd(0.2 * twentyAmt)}`, indent: 2 });
    trace.push({ label: 'LTCG/QD tax', amount: ltcgTax, indent: 1 });
  }

  // --- 6. NIIT ---------------------------------------------------------------
  // 3.8% on min(net investment income, MAGI over the STATUTORY threshold —
  // $250k on a joint return, $200k single, neither ever indexed). NIIT MAGI =
  // AGI. §1411(b)(1) extends the $250k figure to a §2(a) surviving spouse as
  // well as a joint filer, which a widow with no dependent child is not — so
  // the survivor drops $50,000 in the first full year after the death.
  const nii = inputs.taxableInterest + inputs.ordinaryDividends + Math.max(0, inputs.ltcg);
  const niitMagi = agi;
  const niitThreshold = niitThresholdFor(data, inputs.filingStatus);
  const niitExcess = Math.max(0, niitMagi - niitThreshold);
  const niit = data.niitRate * Math.min(nii, niitExcess);

  if (trace && (nii > 0 || niitExcess > 0)) {
    trace.push({
      label: 'Net investment income tax (NIIT)',
      amount: niit,
      note: `${pct(data.niitRate)} x min(NII ${usd(nii)}, MAGI ${usd(niitMagi)} - ${usd(
        niitThreshold,
      )} threshold${statusSuffix} (statutory, never indexed) = ${usd(niitExcess)})`,
      indent: 1,
    });
  }

  // --- 7. Early-withdrawal penalty -------------------------------------------
  let penaltyBaseTotal = 0;
  for (const d of inputs.distributions) {
    penaltyBaseTotal += d.penaltyBase;
  }
  const penalties = data.earlyWithdrawalPenaltyRate * penaltyBaseTotal;

  if (trace && inputs.distributions.length > 0) {
    trace.push({
      label: `Early-withdrawal penalty (${pct(data.earlyWithdrawalPenaltyRate)})`,
      indent: 1,
    });
    for (const d of inputs.distributions) {
      trace.push({
        label: `${d.accountType} distribution ${usd(d.amount)} — exception: ${d.penaltyException}`,
        amount: d.penaltyBase * data.earlyWithdrawalPenaltyRate,
        note:
          d.penaltyBase > 0
            ? `penalty base ${usd(d.penaltyBase)}`
            : 'no penalty',
        indent: 2,
      });
    }
    trace.push({ label: 'Total penalty', amount: penalties, indent: 1 });
  }

  // --- 8. MAGI variants (SPEC §7) --------------------------------------------
  const magi: TaxYearResult['magi'] = {
    agi,
    // ACA MAGI adds back tax-exempt interest AND the untaxed portion of SS.
    acaMagi: agi + inputs.taxExemptInterest + (inputs.socialSecurityGross - ssTaxableAmount),
    // IRMAA MAGI adds back tax-exempt interest only.
    irmaaMagi: agi + inputs.taxExemptInterest,
    // NIIT MAGI = AGI (no foreign-income add-backs modeled).
    niitMagi,
  };

  const total = ordinaryTax + ltcgTax + niit;

  if (trace) {
    trace.push({ label: 'Federal tax (ordinary + LTCG + NIIT)', amount: total, indent: 1 });
    trace.push({
      label: 'MAGI variants',
      note: `AGI ${usd(magi.agi)}; ACA ${usd(magi.acaMagi)} (+ tax-exempt interest + untaxed SS); IRMAA ${usd(
        magi.irmaaMagi,
      )} (+ tax-exempt interest); NIIT ${usd(magi.niitMagi)}`,
      indent: 1,
    });
  }

  return {
    agi,
    standardDeduction,
    itemizedDeduction,
    deductionUsed,
    taxableIncome,
    taxableOrdinaryIncome,
    ssTaxableAmount,
    ordinaryTax,
    ltcgTax,
    niit,
    total,
    magi,
    penalties,
  };
}
