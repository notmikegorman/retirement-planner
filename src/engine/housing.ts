/**
 * Housing module (SPEC §4.1 step "housing module", §9 scenarios 2-3):
 * own-home carrying costs, mortgage amortization, sale with the §121
 * exclusion, renting, and purchases (cash or financed).
 *
 * Pure and deterministic; mutates only the HousingState it is handed (each
 * simulated path owns its own copy).
 *
 * Documented conventions:
 * - Property tax and insurance are stated in dollars of the home's cost base
 *   year (2026 for the profile home; the event year for a bought home) and
 *   scale with CPI from that base.
 * - Maintenance = maintenancePctOfValue x current home value (already
 *   nominal; no extra CPI scaling).
 * - Home value grows by CPI + homeAppreciationRealSpread at the end of every
 *   full year of ownership; a home bought during the year starts growing the
 *   following year.
 * - Sale in month m: that year's ownership costs are prorated to m/12; a
 *   purchase in month m carries (13-m)/12 of a year's costs.
 * - PMI: a financed purchase with downPct >= 0.20 avoids PMI; below that,
 *   0.5%/yr of the loan balance (start-of-year, prorated by active months) is
 *   added as extra cost until the loan is paid off (simplified: no automatic
 *   removal at 80% LTV). PMI is reported inside the `insurance` figure.
 * - A pre-existing profile mortgage is assumed to have had >= 20% down (no PMI).
 * - Mortgage payments: standard monthly annuity aggregated to annual, split
 *   into interest (itemizable) and principal; the balance amortizes monthly.
 * - A buy_house while a home is still owned replaces it (scenarios are
 *   expected to sell first).
 */

import type { Home, Mortgage } from '../shared/types';
import type { ParsedBuyHouse } from './events';

export interface MortgageState {
  balance: number;
  rate: number; // annual
  monthlyPayment: number;
  /** Down-payment fraction at origination (drives PMI); >= 0.2 for pre-existing loans. */
  downPctAtOrigination: number;
  /**
   * Monthly payments made since origination. The engine's payment calendar is
   * consecutive: (13 - buyMonth) payments in the purchase year, then 12 a
   * year, so payment k lands in absolute month (origination + k - 1). This
   * counter is what lets a scheduled payoff find its month without the state
   * carrying absolute dates.
   */
  monthsElapsed: number;
  /**
   * Pay the remaining principal in one lump after this many MONTHLY PAYMENTS
   * (payoffAfterYears x 12 — the lump lands in the same calendar month as the
   * purchase, N years later, in the slot payment N x 12 + 1 would have
   * occupied). Null = amortize the full term (every pre-existing loan, and
   * every financed purchase without the field).
   */
  payoffAfterMonths: number | null;
}

export interface HomeState {
  value: number;
  costBasis: number;
  /** Dollars of `costBaseIdx`'s year. */
  propertyTaxAnnual: number;
  insuranceAnnual: number;
  /** Cumulative CPI index at the cost base year (1.0 for the profile home). */
  costBaseIdx: number;
  maintenancePctOfValue: number;
  sellingCostPct: number;
  mortgage: MortgageState | null;
}

export interface HousingState {
  home: HomeState | null;
  /** Defaults inherited by a bought home (buy_house events carry no pct fields). */
  defaultMaintenancePct: number;
  defaultSellingCostPct: number;
}

/** Standard mortgage annuity: monthly payment for principal P at annual `rate` over `termYears`. */
export function annuityMonthlyPayment(principal: number, rate: number, termYears: number): number {
  const n = termYears * 12;
  if (rate === 0) return principal / n;
  const r = rate / 12;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

/** Build the initial housing state from the profile home. Value 0 = effectively no home. */
export function initHousingState(home: Home): HousingState {
  const mortgage: MortgageState | null = home.mortgage
    ? fromProfileMortgage(home.mortgage)
    : null;
  return {
    home: {
      value: home.value,
      costBasis: home.costBasis,
      propertyTaxAnnual: home.propertyTaxAnnual,
      insuranceAnnual: home.insuranceAnnual,
      costBaseIdx: 1,
      maintenancePctOfValue: home.maintenancePctOfValue,
      sellingCostPct: home.sellingCostPct,
      mortgage,
    },
    defaultMaintenancePct: home.maintenancePctOfValue,
    defaultSellingCostPct: home.sellingCostPct,
  };
}

function fromProfileMortgage(m: Mortgage): MortgageState {
  return {
    balance: m.balance,
    rate: m.rate,
    monthlyPayment: annuityMonthlyPayment(m.originalPrincipal, m.rate, m.termYears),
    downPctAtOrigination: 0.2, // assumed no-PMI for pre-existing loans (documented)
    monthsElapsed: 0,
    payoffAfterMonths: null, // profile loans carry no scheduled payoff
  };
}

/** Deep-clone a housing state for a new simulation path. */
export function cloneHousingState(s: HousingState): HousingState {
  return {
    home: s.home
      ? { ...s.home, mortgage: s.home.mortgage ? { ...s.home.mortgage } : null }
      : null,
    defaultMaintenancePct: s.defaultMaintenancePct,
    defaultSellingCostPct: s.defaultSellingCostPct,
  };
}

/** Amortize `months` payments; mutates m.balance (and the payment counter). Returns totals. */
function amortize(m: MortgageState, months: number): { payment: number; interest: number; principal: number } {
  let payment = 0;
  let interest = 0;
  let principal = 0;
  const r = m.rate / 12;
  for (let i = 0; i < months; i++) {
    if (m.balance <= 0) break;
    const int = m.balance * r;
    const pay = Math.min(m.monthlyPayment, m.balance + int);
    const princ = pay - int;
    m.balance -= princ;
    payment += pay;
    interest += int;
    principal += princ;
    // Counted only for months actually paid. The counter can therefore stall
    // once the balance hits zero — but the loan only zeroes at natural
    // maturity or at the lump itself, and the payoff window ends before
    // either, so within the months a payoff can fire the count is
    // calendar-true.
    m.monthsElapsed += 1;
  }
  return { payment, interest, principal };
}

/**
 * The balance a loan of `principal` at `annualRate` with `monthlyPayment`
 * still owes after `payments` monthly payments — the SAME arithmetic as
 * `amortize` (including the final-payment min()), run on a copy, so the
 * projected lump a payoff will demand and the lump the engine later charges
 * are the same float, not merely close.
 *
 * Pure and exported: the 72(t) calendar-aware carve prices future payoffs
 * with it, the Housing card shows the figure with it, and the tests pin it
 * against the closed-form annuity identity.
 */
export function remainingBalanceAfterPayments(
  principal: number,
  annualRate: number,
  monthlyPayment: number,
  payments: number,
): number {
  const m: MortgageState = {
    balance: principal,
    rate: annualRate,
    monthlyPayment,
    downPctAtOrigination: 0.2, // irrelevant to amortization
    monthsElapsed: 0,
    payoffAfterMonths: null,
  };
  amortize(m, Math.max(0, payments));
  return m.balance;
}

/**
 * The lump a financed purchase's scheduled payoff will demand: the remaining
 * balance after payoffAfterYears x 12 payments. Null when the financing
 * carries no payoff, or one at/past the term (nothing left to pay off then —
 * see the runHousingYear purchase block for the clamp ruling).
 */
export function projectedPayoffLump(
  price: number,
  financing: { downPct: number; rate: number; termYears: number; payoffAfterYears?: number },
): number | null {
  if (financing.payoffAfterYears === undefined) return null;
  if (financing.payoffAfterYears >= financing.termYears) return null;
  const principal = price * (1 - financing.downPct);
  if (principal <= 0) return null;
  return remainingBalanceAfterPayments(
    principal,
    financing.rate,
    annuityMonthlyPayment(principal, financing.rate, financing.termYears),
    financing.payoffAfterYears * 12,
  );
}

export interface HousingYearArgs {
  year: number;
  /** Cumulative CPI index at the start of this year (1.0 in the first sim year). */
  idx: number;
  /** sell_house month this year, or null. */
  sellMonth: number | null;
  /** buy_house event this year, or null. */
  buy: ParsedBuyHouse | null;
  /** Tracked net proceeds from the last sale (resolves price: 'sale_proceeds'). */
  saleProceedsAvailable: number;
  /**
   * The SAVINGS balance the household still holds, which caps a
   * `price: 'sale_proceeds'` CASH purchase.
   *
   * The tracked proceeds are a memory of what the sale produced; they do not
   * fall when the household spends in the meantime. A move that rents for a
   * year is exactly that case — living costs come out of the proceeds first,
   * under the household's own cash-first withdrawal order — and buying at the
   * remembered figure would spend money that is no longer there, forcing an
   * IRA withdrawal to buy a house. The house gets what survived instead.
   *
   * SAVINGS, not every liquid account: the proceeds land in savings and living
   * draws there first under a cash-first order, so what is left in savings IS
   * what is left of the sale. Including the brokerage would let the house
   * swallow investments the household held long before it moved.
   */
  cashAvailable: number;
  /** Rent due this year, already in nominal dollars (monthlyCost x months x rent index). */
  rentNominal: number;
  /** §121 primary-residence exclusion (MFJ). */
  homeSaleExclusion: number;
  /** This year's home appreciation rate: cpi + homeAppreciationRealSpread. */
  homeGrowthRate: number;
}

export interface HousingYearResult {
  propertyTax: number;
  /** Includes PMI (documented). */
  insurance: number;
  pmi: number;
  maintenance: number;
  mortgagePayment: number;
  mortgageInterest: number;
  rent: number;
  /** Net cash from a sale this year (after selling costs and mortgage payoff); 0 otherwise. */
  saleNetCash: number;
  /** Taxable LTCG from the sale above the §121 exclusion; 0 otherwise. */
  saleLtcg: number;
  /** True when a home was actually sold this year. */
  homeSold: boolean;
  /** Sale detail for the §121 tax trace (all 0 unless homeSold). */
  saleAmountRealized: number;
  saleCostBasis: number;
  saleGain: number;
  /** §121 exclusion actually applied: min(max(0, gain), exclusion). */
  saleExclusionUsed: number;
  /** Cash needed for a purchase this year (full price, or the down payment when financed). */
  purchaseOutflow: number;
  /**
   * Remaining principal paid off in ONE lump this year by a scheduled
   * `payoffAfterYears` (0 in every other year, and in every run without the
   * field). Like `purchaseOutflow` it is a CAPITAL outflow, not a carrying
   * cost: it stays out of `totalCosts` (so expenses.housing keeps meaning
   * "what the house costs to hold") and simulate.ts feeds it to the ordinary
   * withdrawal solve as its own term, exactly as it feeds the purchase.
   */
  mortgagePayoff: number;
  /** Updated tracked sale proceeds (consumed by any purchase this year). */
  saleProceedsRemaining: number;
  /**
   * Tracked sale proceeds a purchase this year did NOT consume (e.g. the 80%
   * above a 20% down payment on a financed buy). SPEC §9.3: simulate.ts moves
   * this amount out of savings into the taxable brokerage so it grows per
   * allocation instead of earning the bills rate.
   */
  proceedsToInvest: number;
  /** All housing cash outflows: ownership costs + PMI + mortgage payments + rent. */
  totalCosts: number;
  /** Home value at year end (0 when no home owned). */
  homeValueEnd: number;
}

/**
 * Run one calendar year of the housing module. Mutates `state` (amortization,
 * sale, purchase, appreciation) and returns the year's cash flows.
 */
export function runHousingYear(state: HousingState, args: HousingYearArgs): HousingYearResult {
  const res: HousingYearResult = {
    propertyTax: 0,
    insurance: 0,
    pmi: 0,
    maintenance: 0,
    mortgagePayment: 0,
    mortgageInterest: 0,
    rent: args.rentNominal,
    saleNetCash: 0,
    saleLtcg: 0,
    homeSold: false,
    saleAmountRealized: 0,
    saleCostBasis: 0,
    saleGain: 0,
    saleExclusionUsed: 0,
    purchaseOutflow: 0,
    mortgagePayoff: 0,
    saleProceedsRemaining: args.saleProceedsAvailable,
    proceedsToInvest: 0,
    totalCosts: 0,
    homeValueEnd: 0,
  };

  const ownedAtStart = state.home !== null;

  // --- Ownership costs + amortization for the home held at year start -------
  if (state.home) {
    const home = state.home;
    const activeMonths = args.sellMonth !== null ? args.sellMonth : 12;
    const frac = activeMonths / 12;
    const cpiFromBase = args.idx / home.costBaseIdx;
    res.propertyTax += home.propertyTaxAnnual * cpiFromBase * frac;
    res.insurance += home.insuranceAnnual * cpiFromBase * frac;
    res.maintenance += home.maintenancePctOfValue * home.value * frac;
    if (home.mortgage) {
      const mort = home.mortgage;
      /*
       * A scheduled payoff's month within THIS year. Payments run in
       * consecutive calendar months (see MortgageState.monthsElapsed), so at
       * year start payment (monthsElapsed + j) falls in month j — and the
       * lump, which replaces payment payoffAfterMonths + 1, falls in month
       * payoffAfterMonths - monthsElapsed + 1. Null slot (no payoff, or a
       * payoff in a later year: slot > 12) leaves every figure below
       * bit-identical to the pre-field engine — payMonths degrades to
       * activeMonths and no branch below fires.
       */
      const payoffSlot =
        mort.payoffAfterMonths !== null ? mort.payoffAfterMonths - mort.monthsElapsed + 1 : null;
      /*
       * Months the loan is actually paid this year: ordinary years the full
       * active span, a payoff year only the months BEFORE the lump. PMI uses
       * the same count — the premium dies with the loan, not with the year.
       */
      const payMonths =
        payoffSlot !== null ? Math.max(0, Math.min(activeMonths, payoffSlot - 1)) : activeMonths;
      if (mort.downPctAtOrigination < 0.2 && mort.balance > 0) {
        const pmi = 0.005 * mort.balance * (payMonths / 12);
        res.pmi += pmi;
        res.insurance += pmi;
      }
      const a = amortize(mort, payMonths);
      res.mortgagePayment += a.payment;
      res.mortgageInterest += a.interest;
      /*
       * The lump itself. Fires when the payoff month falls inside this year's
       * active span — and STRICTLY before any sale month: a payoff and a sale
       * in the same month would pay the loan twice over (the sale's own net
       * already deducts the balance), so the sale wins the tie and the lump
       * simply never happens. From here the mortgage is GONE — interest,
       * payments and PMI stop; property tax, insurance and maintenance carry
       * on with the house.
       */
      if (
        payoffSlot !== null &&
        payoffSlot <= activeMonths &&
        (args.sellMonth === null || payoffSlot < args.sellMonth) &&
        mort.balance > 0
      ) {
        res.mortgagePayoff += mort.balance;
        mort.balance = 0;
        home.mortgage = null;
      }
    }
  }

  // --- Sale ------------------------------------------------------------------
  if (args.sellMonth !== null && state.home) {
    const home = state.home;
    const amountRealized = home.value * (1 - home.sellingCostPct);
    const gain = amountRealized - home.costBasis;
    const excludable = Math.min(Math.max(0, gain), args.homeSaleExclusion);
    res.saleLtcg = Math.max(0, gain - excludable);
    res.homeSold = true;
    res.saleAmountRealized = amountRealized;
    res.saleCostBasis = home.costBasis;
    res.saleGain = gain;
    res.saleExclusionUsed = excludable;
    const payoff = home.mortgage ? home.mortgage.balance : 0;
    res.saleNetCash = amountRealized - payoff;
    res.saleProceedsRemaining = res.saleNetCash;
    state.home = null;
  }

  // --- Purchase --------------------------------------------------------------
  if (args.buy) {
    const buy = args.buy;
    const price =
      buy.price === 'sale_proceeds'
        ? // Capped for a CASH purchase only: a financed buy needs a down
          // payment rather than the whole price, and shrinking the house to
          // this year's cash would understate what it can actually afford.
          buy.financing === 'cash'
          ? Math.min(res.saleProceedsRemaining, Math.max(0, args.cashAvailable))
          : res.saleProceedsRemaining
        : buy.price;
    /*
     * A house bought in month m is held months m..12, so (13 - m)/12 — but the
     * home SOLD this year was already charged months 1..sellMonth inclusive,
     * and the shared month was therefore billed twice. Selling and buying in
     * the same June charged 13 months of ownership costs in one calendar year
     * (measured: $7,900 of property tax where twelve months is ~$7,400).
     *
     * Capping the pair at twelve months fixes the overlap without touching a
     * standalone purchase, which still gets its full (13 - m)/12: the cap only
     * binds when a sale in the same year already consumed part of it.
     */
    const soldMonthsThisYear = args.sellMonth ?? 0;
    const frac = Math.max(0, Math.min(13 - buy.ym.month, 12 - soldMonthsThisYear)) / 12;
    let mortgage: MortgageState | null = null;
    if (buy.financing === 'cash') {
      res.purchaseOutflow += price;
    } else {
      const down = buy.financing.downPct * price;
      res.purchaseOutflow += down;
      /*
       * ENGINE CLAMP for the payoff schedule: a payoff at or past the term is
       * IGNORED (null), not clamped to term - 1. The schema rejects a stated
       * violation, but events can be built in code — and "pay off in year 30
       * of a 30-year loan" is the full term stated redundantly, since the
       * schedule amortizes to zero in exactly that month anyway. Rounding it
       * to 29 would invent a lump nobody asked for; honouring it as written
       * would fire a zero-dollar lump (or a float-epsilon one) and stamp a
       * phantom payoff chip on the year. Null is the only reading that
       * changes nothing.
       */
      const payoffYears = buy.financing.payoffAfterYears;
      mortgage = {
        balance: price - down,
        rate: buy.financing.rate,
        monthlyPayment: annuityMonthlyPayment(price - down, buy.financing.rate, buy.financing.termYears),
        downPctAtOrigination: buy.financing.downPct,
        monthsElapsed: 0,
        payoffAfterMonths:
          payoffYears !== undefined && payoffYears < buy.financing.termYears
            ? payoffYears * 12
            : null,
      };
    }
    // A purchase consumes the tracked sale proceeds: the price (or the down
    // payment when financed) is spent via purchaseOutflow, and whatever
    // tracked cash remains beyond that outflow is freed for investment
    // (SPEC §9.3 — simulate.ts moves it savings -> taxable brokerage).
    res.proceedsToInvest = Math.max(0, res.saleProceedsRemaining - res.purchaseOutflow);
    res.saleProceedsRemaining = 0;
    state.home = {
      value: price,
      costBasis: price,
      propertyTaxAnnual: buy.propertyTaxAnnual,
      insuranceAnnual: buy.insuranceAnnual,
      costBaseIdx: args.idx, // event-year dollars
      maintenancePctOfValue: state.defaultMaintenancePct,
      sellingCostPct: state.defaultSellingCostPct,
      mortgage,
    };
    const home = state.home;
    res.propertyTax += home.propertyTaxAnnual * frac;
    res.insurance += home.insuranceAnnual * frac;
    res.maintenance += home.maintenancePctOfValue * home.value * frac;
    if (mortgage) {
      if (mortgage.downPctAtOrigination < 0.2 && mortgage.balance > 0) {
        const pmi = 0.005 * mortgage.balance * frac;
        res.pmi += pmi;
        res.insurance += pmi;
      }
      // No payoff cap needed here: payoffAfterMonths >= 12 (payoffAfterYears
      // >= 1) while the purchase year pays at most 13 - m <= 12 payments, so
      // the lump can never land in the purchase year itself.
      const a = amortize(mortgage, 13 - buy.ym.month);
      res.mortgagePayment += a.payment;
      res.mortgageInterest += a.interest;
    }
  }

  // --- Appreciation ----------------------------------------------------------
  // Grows only when owned at year start AND still owned (bought-this-year
  // homes start growing next year; sold homes obviously don't).
  if (state.home && ownedAtStart && args.sellMonth === null && !args.buy) {
    state.home.value *= 1 + args.homeGrowthRate;
  }

  res.homeValueEnd = state.home ? state.home.value : 0;
  res.totalCosts =
    res.propertyTax + res.insurance + res.maintenance + res.mortgagePayment + res.rent;
  return res;
}
