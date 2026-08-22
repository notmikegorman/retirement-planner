/**
 * ACA premium tax credit (Form 8962 tax-return true-up) and Medicare
 * premium / IRMAA computation. Pure and deterministic; called from
 * tax/computeYear (SPEC §7).
 *
 * Trace convention: when a `trace` array is provided, push human-readable
 * TraceLine rows for every meaningful step. When `trace` is undefined, do
 * ZERO trace work — this code runs ~2M times inside Monte Carlo.
 *
 * NOTE on the word "cliff": property tests grep the trace for it to assert
 * the 400%-FPL cliff is the tax system's only intended discontinuity. It must
 * therefore appear in the trace if and only if the cliff actually applied.
 */

import type {
  AcaData,
  MedicareData,
  TaxYearInputs,
  TaxYearResult,
  TraceLine,
} from '../shared/types';

/** MAGI above this multiple of FPL forfeits the entire PTC under pre-ARPA law. */
const ACA_CLIFF_FPL_RATIO = 4.0;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pctStr(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * Applicable percentage for a given FPL ratio via linear interpolation within
 * the matching table row: pct = pctFrom + (pctTo - pctFrom) x
 * (fplPct - fplFrom) / (fplTo - fplFrom). Rows are matched half-open
 * [fplFrom, fplTo) so a ratio at a row boundary uses the higher row (per the
 * Rev. Proc. tables, e.g. exactly 133% FPL falls in the 133-150 band). A
 * ratio equal to the last row's upper bound (exactly 400% FPL — eligible,
 * not over the cliff) uses that row's ending percentage. Rows with
 * fplTo === null are flat at pctFrom.
 */
function applicablePctFor(fplPct: number, table: AcaData['applicablePctTable']): number {
  for (const row of table) {
    if (fplPct >= row.fplFrom && (row.fplTo === null || fplPct < row.fplTo)) {
      if (row.fplTo === null || row.fplTo === row.fplFrom) return row.pctFrom;
      return (
        row.pctFrom +
        ((row.pctTo - row.pctFrom) * (fplPct - row.fplFrom)) / (row.fplTo - row.fplFrom)
      );
    }
  }
  // Fell through: fplPct sits exactly on the last row's upper bound.
  return table[table.length - 1].pctTo;
}

/**
 * ACA Premium Tax Credit as the Form 8962 reconciliation for the year.
 * `acaMagi` is the household ACA MAGI computed by the caller.
 *
 * HOUSEHOLD SIZE follows the filing status: two people on a joint return, one
 * for a single filer. That single line is quite possibly the biggest number in
 * a widow score. A household retiring in its mid-fifties sits on the exchange
 * for roughly a decade before Medicare, and the 400%-of-FPL cliff for one
 * person is $62,600 of MAGI against $84,600 for the couple — so the same
 * withdrawal that cleared the cliff with $20,000 to spare while both were
 * alive is $20,000 OVER it the first year the survivor files single, and the
 * entire premium tax credit is forfeited. The benchmark premium they are charged
 * against is the caller's problem (the engine scales the household quote down
 * to one person); the denominator is this one.
 *
 * The applicable-percentage schedule itself is household-size independent, so
 * only the FPL denominator changes.
 *
 * enrolledMonths scales BOTH the benchmark premium and the expected
 * contribution (monthly reconciliation), so a partial year prorates the
 * credit consistently.
 */
export function computeAca(
  inputs: TaxYearInputs,
  data: AcaData,
  acaMagi: number,
  trace?: TraceLine[],
): NonNullable<TaxYearResult['aca']> | null {
  const aca = inputs.aca;
  if (aca === null || aca.enrolledMonths === 0) return null;

  const months = aca.enrolledMonths;
  const householdSize = inputs.filingStatus === 'single' ? 1 : 2;
  const fplBase = householdSize === 1 ? data.fpl1Person : data.fpl2Person;
  const fpl = fplBase * inputs.inflationIndex;
  const fplPct = acaMagi / fpl;
  const enhanced = data.enhancedCreditsExtended;
  const table = enhanced ? data.applicablePctTableEnhanced : data.applicablePctTable;
  const grossPremium = (aca.grossAnnualPremium * months) / 12;
  const cliffHeadroom = enhanced ? null : ACA_CLIFF_FPL_RATIO * fpl - acaMagi;

  if (trace) {
    trace.push({ label: 'ACA premium tax credit (Form 8962 true-up)' });
    trace.push({
      label: `Federal poverty level, ${householdSize}-person household`,
      amount: fpl,
      note:
        `${money(fplBase)} base-year x ${inputs.inflationIndex.toFixed(4)} CPI index` +
        (householdSize === 1
          ? `; the 400% cliff for one person is ${money(ACA_CLIFF_FPL_RATIO * fpl)}, against ` +
            `${money(ACA_CLIFF_FPL_RATIO * data.fpl2Person * inputs.inflationIndex)} for the couple`
          : ''),
      indent: 1,
    });
    trace.push({
      label: 'ACA MAGI',
      amount: acaMagi,
      note: `${(fplPct * 100).toFixed(1)}% of FPL`,
      indent: 1,
    });
  }

  // MEDICAID EXPANSION (both regimes — ARPA changed the PTC schedule, not
  // Medicaid): in an expansion state (VA since 2019, NC since 2023) a
  // household under 138% FPL is Medicaid-eligible and therefore NOT
  // PTC-eligible. Medicaid is modeled as a $0 premium; no marketplace
  // premium is owed at all. SC never expanded, so it skips this branch and
  // (below 100% FPL, pre-ARPA) falls into the coverage gap instead.
  if (data.medicaidExpansion[inputs.state] && fplPct < data.medicaidThresholdFpl) {
    if (trace) {
      const thresholdPct = `${(data.medicaidThresholdFpl * 100).toFixed(0)}%`;
      trace.push({
        label: `Medicaid — expansion state, MAGI below ${thresholdPct} FPL`,
        amount: 0,
        note:
          `${inputs.state.toUpperCase()} expanded Medicaid and ${(fplPct * 100).toFixed(1)}% of FPL is below ${thresholdPct}: ` +
          `modeled as Medicaid at a $0 premium; no marketplace PTC (households below ${thresholdPct} FPL in expansion states are Medicaid-eligible, not PTC-eligible)`,
        indent: 1,
      });
    }
    return {
      enrolled: true,
      fplPct,
      applicablePct: null,
      expectedContribution: 0,
      ptc: 0,
      grossPremium: 0,
      netPremium: 0,
      cliffApplied: false,
      cliffHeadroom,
    };
  }

  // THE CLIFF (pre-ARPA law only): MAGI strictly above 400% FPL forfeits the
  // entire credit. This is the single intended discontinuity in the tax system.
  if (!enhanced && fplPct > ACA_CLIFF_FPL_RATIO) {
    if (trace) {
      trace.push({
        label: '400% FPL cliff applied — entire premium tax credit forfeited',
        amount: 0,
        note: `MAGI ${money(acaMagi)} exceeds ${money(ACA_CLIFF_FPL_RATIO * fpl)} by ${money(
          -(cliffHeadroom as number),
        )}`,
        indent: 1,
      });
      trace.push({ label: 'Gross premium (no credit)', amount: grossPremium, indent: 1 });
    }
    return {
      enrolled: true,
      fplPct,
      applicablePct: null,
      expectedContribution: 0,
      ptc: 0,
      grossPremium,
      netPremium: grossPremium,
      cliffApplied: true,
      cliffHeadroom,
    };
  }

  // Below 100% FPL under pre-ARPA 2026 law (IRC §36B(c)(1)(A)) the household
  // is not an "applicable taxpayer": no PTC at all, and the full gross premium
  // is owed. (Not the 400% cliff — cliffApplied stays false.) Only reachable
  // in a NON-expansion state (expansion states short-circuited to Medicaid
  // above), so this is the real coverage gap — SC never expanded Medicaid.
  // Under the enhanced ARPA regime, handled below, under-100% households in
  // non-expansion states remain eligible at the enhanced table's 0% band.
  if (!enhanced && fplPct < 1.0) {
    if (trace) {
      trace.push({
        label: 'No premium tax credit — MAGI below 100% FPL',
        amount: 0,
        note:
          'not PTC-eligible under 2026 law (a household under 100% FPL is not an applicable taxpayer, IRC §36B); coverage gap — SC never expanded Medicaid, so there is no Medicaid fallback and the full gross premium is owed',
        indent: 1,
      });
      trace.push({ label: 'Gross premium (no credit)', amount: grossPremium, indent: 1 });
    }
    return {
      enrolled: true,
      fplPct,
      applicablePct: null,
      expectedContribution: 0,
      ptc: 0,
      grossPremium,
      netPremium: grossPremium,
      cliffApplied: false,
      cliffHeadroom,
    };
  }

  let applicablePct: number;
  if (fplPct < 1.0) {
    // Enhanced (ARPA-style) regime only: under-100% households are eligible
    // at the enhanced table's lowest percentage (0%) — correct ARPA law.
    applicablePct = table[0].pctFrom;
    if (trace) {
      trace.push({
        label: 'Applicable percentage',
        note: `${pctStr(applicablePct)} — below 100% FPL — eligible under the enhanced (ARPA) schedule at the lowest percentage`,
        indent: 1,
      });
    }
  } else {
    applicablePct = applicablePctFor(fplPct, table);
    if (trace) {
      trace.push({
        label: 'Applicable percentage',
        note: `${pctStr(applicablePct)} (interpolated at ${(fplPct * 100).toFixed(1)}% FPL, ${
          enhanced ? 'enhanced schedule' : 'standard schedule'
        })`,
        indent: 1,
      });
    }
  }

  // Annual expected contribution; floored at 0 for degenerate negative MAGI.
  const expectedContribution = Math.max(0, applicablePct * acaMagi);
  const benchmarkProrated = (aca.benchmarkAnnualPremium * months) / 12;
  const contributionProrated = (expectedContribution * months) / 12;
  const ptc = Math.max(0, benchmarkProrated - contributionProrated);
  const netPremium = Math.max(0, grossPremium - ptc);

  if (trace) {
    trace.push({
      label: 'Expected contribution (annual)',
      amount: expectedContribution,
      note: `${pctStr(applicablePct)} x MAGI ${money(acaMagi)}`,
      indent: 1,
    });
    trace.push({
      label: `Benchmark premium (${months}/12 months)`,
      amount: benchmarkProrated,
      indent: 1,
    });
    trace.push({
      label: 'Premium tax credit',
      amount: ptc,
      note: `benchmark ${money(benchmarkProrated)} - contribution ${money(
        contributionProrated,
      )} (${months}/12 months each), floored at 0`,
      indent: 1,
    });
    trace.push({
      label: `Gross premium (${months}/12 months)`,
      amount: grossPremium,
      indent: 1,
    });
    trace.push({ label: 'Net premium after PTC', amount: netPremium, indent: 1 });
    if (!enhanced) {
      trace.push({
        label: 'Headroom to 400% FPL',
        amount: cliffHeadroom as number,
        indent: 1,
      });
    }
  }

  return {
    enrolled: true,
    fplPct,
    applicablePct,
    expectedContribution,
    ptc,
    grossPremium,
    netPremium,
    cliffApplied: false,
    cliffHeadroom,
  };
}

/**
 * Medicare Part B + Part D premiums with IRMAA surcharges keyed to MAGI from
 * two years prior. IRMAA MAGI *thresholds* index with plain CPI
 * (inputs.inflationIndex); premium *amounts* scale by the medical-inflation
 * premiumIndex. The Part D plan premium is supplied in current-year dollars
 * and is NOT indexed again here.
 *
 * FILING STATUS picks the tier table. The premium amounts are identical
 * tier-for-tier; only the MAGI thresholds move, which is exactly how a widow
 * drawing unchanged income can jump one or two tiers the year after the death
 * — and, because IRMAA reads MAGI from two years prior, the surcharge from
 * their last joint years follows the survivor into their first single ones.
 */
export function computeMedicare(
  inputs: TaxYearInputs,
  data: MedicareData,
  trace?: TraceLine[],
): NonNullable<TaxYearResult['medicare']> | null {
  const med = inputs.medicare;
  if (med === null) return null;
  if (!med.enrolledMonthsPerPerson.some((m) => m > 0)) return null;

  const cpiIndex = inputs.inflationIndex;
  const premiumIndex = med.premiumIndex;
  const magi = med.magiTwoYearsPrior;

  // Highest tier whose CPI-indexed threshold the lookback MAGI strictly exceeds.
  const tiers =
    inputs.filingStatus === 'single' ? data.irmaaTiersSingle : data.irmaaTiersMfj;
  let tierIndex = 0;
  let tier: MedicareData['irmaaTiersMfj'][number] | null = null;
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i];
    if (magi > t.magiOver * cpiIndex) {
      tier = t;
      tierIndex = i + 1;
      break;
    }
  }

  const baseBMonthly = data.partBStandardMonthly * premiumIndex;
  const irmaaBMonthly = tier
    ? (tier.partBTotalMonthly - data.partBStandardMonthly) * premiumIndex
    : 0;
  const partDPlanMonthly = med.partDPlanMonthly; // already current-year dollars
  const irmaaDMonthly = tier ? tier.partDAddOnMonthly * premiumIndex : 0;

  let partB = 0;
  let irmaaPartB = 0;
  let partDPlan = 0;
  let irmaaPartD = 0;
  let personMonths = 0;
  for (const m of med.enrolledMonthsPerPerson) {
    partB += baseBMonthly * m;
    irmaaPartB += irmaaBMonthly * m;
    partDPlan += partDPlanMonthly * m;
    irmaaPartD += irmaaDMonthly * m;
    personMonths += m;
  }
  const total = partB + irmaaPartB + partDPlan + irmaaPartD;

  if (trace) {
    trace.push({ label: 'Medicare premiums (Part B / Part D + IRMAA)' });
    trace.push({
      label: 'IRMAA MAGI (from 2 years prior)',
      amount: magi,
      indent: 1,
    });
    if (tier) {
      trace.push({
        label: `IRMAA tier ${tierIndex}${inputs.filingStatus === 'single' ? ' (single tiers)' : ''}`,
        note: `MAGI ${money(magi)} > tier-${tierIndex} threshold ${money(
          tier.magiOver * cpiIndex,
        )} (${money(tier.magiOver)} base-year x ${cpiIndex.toFixed(4)} CPI index)`,
        indent: 1,
      });
    } else {
      const t1 = tiers[0];
      trace.push({
        label: 'No IRMAA — standard premiums',
        note: `MAGI ${money(magi)} <= tier-1 threshold ${money(t1.magiOver * cpiIndex)} (${money(
          t1.magiOver,
        )} base-year x ${cpiIndex.toFixed(4)} CPI index)`,
        indent: 1,
      });
    }
    med.enrolledMonthsPerPerson.forEach((m, i) => {
      trace.push({ label: `Person ${i + 1} enrolled months: ${m}`, indent: 1 });
    });
    trace.push({
      label: 'Part B base premium',
      amount: partB,
      note: `${money(baseBMonthly)}/mo (standard x ${premiumIndex.toFixed(
        4,
      )} premium index) x ${personMonths} person-months`,
      indent: 1,
    });
    trace.push({
      label: 'Part B IRMAA surcharge',
      amount: irmaaPartB,
      note: tier ? `${money(irmaaBMonthly)}/mo x ${personMonths} person-months` : 'none',
      indent: 1,
    });
    trace.push({
      label: 'Part D plan premium',
      amount: partDPlan,
      note: `${money(partDPlanMonthly)}/mo (current-year dollars, not premium-indexed) x ${personMonths} person-months`,
      indent: 1,
    });
    trace.push({
      label: 'Part D IRMAA surcharge',
      amount: irmaaPartD,
      note: tier ? `${money(irmaaDMonthly)}/mo x ${personMonths} person-months` : 'none',
      indent: 1,
    });
    trace.push({ label: 'Total Medicare premiums', amount: total, indent: 1 });
  }

  return { partB, partDPlan, irmaaPartB, irmaaPartD, total, tierIndex };
}
