/**
 * HousingPlan compiler (shared/types.ts HousingPlan).
 *
 * A move used to be three hand-written events — sell_house, rent, buy_house —
 * which meant every permutation a user wanted to try (sell a year later, rent
 * 24 months instead of 12, mortgage instead of cash) was a three-event edit
 * with a purchase date they had to recompute in their head. A move is one
 * decision with several knobs, not three independent events, so it gets one
 * config object.
 *
 * WHAT THIS MODULE IS NOT: a second housing engine. It compiles the plan DOWN
 * to the exact `sell_house` / `rent` / `buy_house` events the pipeline has
 * always consumed, and hands them to the unchanged `parseEvents`. Everything
 * downstream — the §121 exclusion, selling costs, mortgage amortization, the
 * PMI charge below 20% down, the cash-first withdrawal ordering that lets the
 * household live off the proceeds before touching the IRA, the SPEC §9.3 move
 * of unspent proceeds into the brokerage — is untouched machinery that already
 * works and is already tested. The only thing that changes shape is the input.
 *
 * SUPERSEDE, DON'T MERGE: when a scenario has a housing plan, the compiler
 * DROPS any hand-written sell_house/rent/buy_house events it also carries.
 * Merging would be actively wrong — two sell_house events means the engine
 * takes the last one and silently ignores the other, and two buy_house events
 * in different years means buying two houses. The plan is the single source of
 * truth for the move, or there is no plan.
 */

import type { HousingPlan, ScenarioEvent, YearMonth } from '../shared/types';
import { parseYearMonth } from '../shared/util';

// ---------------------------------------------------------------------------
// Defaults (exported so the UI can show the figure the engine will actually use)
// ---------------------------------------------------------------------------

/**
 * Down payment when a mortgage plan does not name one.
 *
 * 20% is not a round-number convention, it is the conventional mortgage
 * insurance line: Fannie Mae's Selling Guide B7-1-01 requires mortgage
 * insurance on any conventional first mortgage above 80% LTV. At or above 20%
 * down there is no PMI; below it there is. The engine already charges that
 * (housing.ts: 0.5%/yr of the loan balance while `downPctAtOrigination < 0.2`),
 * so a plan that dips under 20% picks up the cost automatically — this module
 * deliberately does NOT re-implement or duplicate the PMI calculation.
 */
export const DEFAULT_DOWN_PCT = 0.2;

/**
 * Note rate when a mortgage plan does not name one: 6.67%.
 *
 * Freddie Mac Primary Mortgage Market Survey, 30-year fixed-rate average, week
 * of 2026-08-13 (6.67%, down from 6.69% the prior week). PMMS no longer
 * publishes fees and points, so this is a rate-only figure and a real APR will
 * be a little higher. Re-check it if this plan is still being run a year from
 * now — it is a spot rate, not a long-run assumption.
 */
export const DEFAULT_MORTGAGE_RATE = 0.0667;

/** Term when a mortgage plan does not name one: the standard 30-year conventional. */
export const DEFAULT_MORTGAGE_TERM_YEARS = 30;

/**
 * Months between a death and the survivor's downsize sale when the plan does
 * not name a delay: 12. Nobody lists a house from a funeral — a year is the
 * conventional "no major decisions in the first year of widowhood" advice,
 * and it is also roughly what listing, selling and closing take when the
 * decision is made deliberately rather than under duress. Exported so the UI
 * shows the figure the engine will actually use.
 */
export const DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS = 12;

/**
 * Homeowners insurance as a fraction of purchase price, used when a plan does
 * not override the premium: 0.22%.
 *
 * Three things agree on roughly this number, which is why it is defensible
 * rather than invented:
 *
 * 1. A real quote used to calibrate this: a $900,000 home insured for
 *    $1,950/yr — 0.217% of value — on an inland, low-catastrophe risk. A
 *    quote for the kind of house actually being priced beats any national
 *    average as a starting point.
 * 2. Structure, not land. Only the dwelling is insured; land is typically
 *    25-30% of price in this market and cannot burn down. A premium of ~0.3%
 *    of replacement cost on ~72% of the price lands at ~0.22% of price.
 * 3. Geography. Published national averages run 0.3-0.5% of home value, but
 *    they are dragged up by coastal wind/hail and wildfire states. An inland
 *    state with no coastal wind or wildfire load sits at the bottom of that
 *    range.
 *
 * A percentage-of-price rate is a simplification in one known direction: real
 * premiums are sublinear in price (a $2M house does not cost twice a $1M house
 * to insure), so this OVERSTATES the premium at the top end. It is a cost, so
 * overstating is the safe side of the error — and the whole figure is a
 * rounding error against property tax anyway. Override `insuranceAnnual` on
 * the plan with a real quote when there is one.
 */
export const HOME_INSURANCE_RATE_OF_PRICE = 0.0022;

/**
 * Estimated annual homeowners insurance for a house at `purchasePrice`, in
 * purchase-year dollars.
 *
 * Exported and pure so the UI can display exactly the number the engine will
 * model — a screen that shows an estimate the simulation does not use is worse
 * than showing nothing. Rounded to whole dollars for the same reason: the
 * displayed figure and the modelled figure must be identical, not merely
 * close.
 */
export function estimateHomeInsuranceAnnual(purchasePrice: number): number {
  return Math.round(Math.max(0, purchasePrice) * HOME_INSURANCE_RATE_OF_PRICE);
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** Event types a housing plan owns outright and therefore replaces. */
const PLAN_OWNED_EVENT_TYPES: ReadonlySet<ScenarioEvent['type']> = new Set([
  'sell_house',
  'rent',
  'buy_house',
]);

/** Shift a "YYYY-MM" by whole months. Month is 1-12; December + 1 rolls the year. */
function addMonths(ym: YearMonth, months: number): YearMonth {
  const { year, month } = parseYearMonth(ym);
  const abs = year * 12 + (month - 1) + months;
  const y = Math.floor(abs / 12);
  const m = (abs % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * The month the replacement house is bought: the sale month plus the rental
 * months. DERIVED, never entered — the whole point of the plan is that the
 * owner states a sale date and a rental length and the purchase date follows.
 * `rentMonths: 0` therefore buys in the same month the old house sells.
 */
export function purchaseDate(plan: HousingPlan): YearMonth {
  return addMonths(plan.sellDate, plan.rentMonths);
}

/**
 * Insurance the plan will actually model: the override when there is one, the
 * price-based estimate otherwise.
 */
export function planInsuranceAnnual(plan: HousingPlan, saleProceedsEstimate = 0): number {
  if (plan.purchasePrice === 'none') return 0; // nothing owned, nothing to insure
  if (plan.insuranceAnnual !== undefined) return plan.insuranceAnnual;
  // A 'sale_proceeds' purchase has no stated price to estimate from, so the
  // projected net proceeds stand in — the same figure the card shows.
  const basis =
    plan.purchasePrice === 'sale_proceeds' ? saleProceedsEstimate : plan.purchasePrice;
  return estimateHomeInsuranceAnnual(basis);
}

/**
 * Compile a HousingPlan into the equivalent scenario events.
 *
 * Note what is NOT here: the sale price. The engine derives it from the home it
 * is already tracking (profile value, grown year by year, less selling costs,
 * less any mortgage payoff), so `sell_house` carries a date and nothing else.
 * The plan's `appreciationRate` reaches the sale price by REPLACING the growth
 * rate the engine applies (see `planHomeGrowthRate` below), not by computing a
 * price here — two independently-computed sale prices would eventually
 * disagree.
 */
export function compileHousingPlan(plan: HousingPlan, horizonMonths?: number): ScenarioEvent[] {
  const out: ScenarioEvent[] = [{ type: 'sell_house', date: plan.sellDate }];

  /*
   * SELL AND RENT FROM THEN ON. No replacement house, and the rental runs to
   * the horizon rather than for `rentMonths` — "we rent for 12 months and then
   * live in nothing" is not a plan anybody means. `horizonMonths` is the
   * distance from the sale to the end of the run; without it (a pure unit-test
   * call) the stated rentMonths stands.
   */
  /*
   * A price of ZERO is the same statement as 'none'.
   *
   * 'none' is the honest way to say "sell and rent from then on", but 0 is what
   * a person types when the field demands a number and they do not intend to
   * buy — and emitting a $0 purchase modelled a household that owned nothing,
   * rented nothing and paid no housing costs for the rest of its life. Treating
   * the two identically closes the trap however it is expressed.
   */
  if (plan.purchasePrice === 'none' || plan.purchasePrice === 0) {
    const months = horizonMonths ?? plan.rentMonths;
    if (months > 0) {
      out.push({
        type: 'rent',
        start: plan.sellDate,
        months,
        monthlyCost: plan.rentMonthly,
      });
    }
    return out;
  }

  // rentMonths: 0 is a legitimate plan (sell and buy the same month), and it
  // must emit no rent event at all rather than a zero-month one — a zero-month
  // rent would still show up in the year's fired-events list as if the
  // household had moved into a rental.
  if (plan.rentMonths > 0) {
    out.push({
      type: 'rent',
      start: plan.sellDate,
      months: plan.rentMonths,
      monthlyCost: plan.rentMonthly,
    });
  }

  out.push({
    type: 'buy_house',
    date: purchaseDate(plan),
    /*
     * Passed through as given, and the distinction matters more than it looks.
     *
     * A NUMBER is a firm commitment: the 72(t) bridge reserves it out of
     * accessible cash (simulate.ts), and a shortfall is met from the IRA.
     * 'sale_proceeds' is a RESIDUAL claim: living comes first, the house is
     * capped at the cash that survived, and the bridge reserves nothing — which
     * is what stops the series electing a year early to fund a purchase that
     * would simply have been smaller. Compiling everything to a number silently
     * turned a residual-priced plan into the first case and moved its election
     * from 2029 to 2027.
     */
    price: plan.purchasePrice as number | 'sale_proceeds',
    financing:
      plan.financing.type === 'cash'
        ? 'cash'
        : {
            downPct: plan.financing.downPct ?? DEFAULT_DOWN_PCT,
            rate: plan.financing.rate ?? DEFAULT_MORTGAGE_RATE,
            termYears: plan.financing.termYears ?? DEFAULT_MORTGAGE_TERM_YEARS,
            // Conditional spread, not `payoffAfterYears: undefined`: the
            // compiled event is compared and hashed, and a key holding
            // undefined would make "plan without the field" and "plan with
            // the field cleared" different shapes for the same instruction.
            ...(plan.financing.payoffAfterYears !== undefined
              ? { payoffAfterYears: plan.financing.payoffAfterYears }
              : {}),
          },
    propertyTaxAnnual: plan.propertyTaxAnnual,
    insuranceAnnual: planInsuranceAnnual(plan),
  });

  return out;
}

/**
 * The plan as the household this run actually simulates would execute it: when
 * any `death` event lands STRICTLY BEFORE the purchase month and the plan
 * names a `survivorPurchasePrice`, the purchase price is that price.
 *
 * THIS IS THE ONE PLACE THE SWITCH HAPPENS, deliberately. The compiled
 * `buy_house` event's price is the single figure everything downstream reads —
 * the cash-vs-shortfall arithmetic, the 72(t) bridge's reservation, the
 * rental-window banking gate, the purchaseFunding trace, and (via
 * `planInsuranceAnnual` on the effective plan) the insurance estimate — so
 * switching before compilation means nothing can disagree about which price
 * this run is living in. Property tax is NOT rescaled: the plan owns
 * `propertyTaxAnnual`, and inventing a proportional figure here would show the
 * a number nobody entered.
 *
 * Death IN the buy month or after changes nothing: the house is already
 * bought, and the survivor inherits it like every other asset. STRICTLY
 * before, because a July death against a July purchase is a household that
 * completed its move.
 *
 * Same reference back when nothing switches — a plan without the field must
 * stay bit-for-bit the plan it was before the field existed.
 */
export function survivorHousingPlan(
  plan: HousingPlan,
  events: readonly ScenarioEvent[],
): HousingPlan {
  if (plan.survivorPurchasePrice === undefined) return plan;
  // No purchase, no price to switch: a rent-forever plan stays rent-forever
  // whoever survives (the derived "purchase date" of such a plan is a month in
  // which nothing happens).
  if (plan.purchasePrice === 'none' || plan.purchasePrice === 0) return plan;
  const buy = parseYearMonth(purchaseDate(plan));
  const buyAbs = buy.year * 12 + (buy.month - 1);
  for (const e of events) {
    if (e.type !== 'death') continue;
    const d = parseYearMonth(e.date);
    if (d.year * 12 + (d.month - 1) < buyAbs) {
      // A survivor price of 0 falls into compileHousingPlan's "0 is the same
      // statement as 'none'" rule and rents to the horizon — the same trap
      // closure the plan price has, however the zero got here.
      return { ...plan, purchasePrice: plan.survivorPurchasePrice };
    }
  }
  return plan;
}

/**
 * The SURVIVOR'S DOWNSIZE, as the second sell→buy cycle it really is: when any
 * `death` event lands IN OR AFTER the purchase month and the plan names a
 * `survivorDownsizeTo`, the survivor sells the just-bought home
 * `survivorDownsizeDelayMonths` (absent = 12) after the death and either
 * rebuys at the stated price — cash, same month — or ('none') rents to the
 * horizon at the plan's `rentMonthly`.
 *
 * COMPILED, NOT SIMULATED: these are ordinary sell_house / rent / buy_house
 * events appended after the plan's own cycle, so everything the first cycle
 * already gets — selling costs, the §121 exclusion (including the survivor's
 * two-year window), proceeds landing in savings, the withdrawal ordering —
 * applies to the widow's move through machinery that is already tested. This
 * is exactly why the engine had to learn N sell→buy cycles first.
 *
 * The conventions are `survivorPurchasePrice`'s own: property tax is NOT
 * rescaled (the plan owns `propertyTaxAnnual`; inventing a proportional figure
 * would show a number nobody entered), and insurance comes from
 * `planInsuranceAnnual` on the effective price — the override when there is
 * one, the price-based estimate otherwise.
 *
 * IN OR AFTER the purchase month, mirroring survivorHousingPlan's STRICTLY
 * BEFORE: the two fields partition the death timeline at the buy month, so no
 * death can both re-price the purchase and trigger a downsize. A death before
 * the purchase means the survivor never bought the big house; there is nothing
 * to downsize FROM.
 *
 * A downsize sale past the simulated horizon compiles to nothing — the same
 * all-or-nothing rule the plan's own sale follows, and for the same reason: a
 * dangling half-cycle is worse than none. Without a `window` (a pure
 * unit-test call) the 'none' variant emits the sale but no rent event, since
 * the rental's length is "to the horizon" and there is no horizon to measure
 * against; production always passes the window.
 */
export function survivorDownsizeEvents(
  plan: HousingPlan,
  events: readonly ScenarioEvent[],
  window?: { startYear: number; horizonYears: number },
): ScenarioEvent[] {
  if (plan.survivorDownsizeTo === undefined) return [];
  // Never bought — a rent-forever plan has nothing to downsize. The 0-means-
  // 'none' trap closure, one more time.
  if (plan.purchasePrice === 'none' || plan.purchasePrice === 0) return [];
  const buy = parseYearMonth(purchaseDate(plan));
  const buyAbs = buy.year * 12 + (buy.month - 1);
  // The EARLIEST death at/after the purchase: the household's move completed,
  // then someone died. (The engine only simulates one survivor, but scanning
  // for the earliest keeps the rule deterministic if several deaths appear.)
  let deathAbs: number | null = null;
  for (const e of events) {
    if (e.type !== 'death') continue;
    const d = parseYearMonth(e.date);
    const abs = d.year * 12 + (d.month - 1);
    if (abs >= buyAbs && (deathAbs === null || abs < deathAbs)) deathAbs = abs;
  }
  if (deathAbs === null) return [];
  const delay = plan.survivorDownsizeDelayMonths ?? DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS;
  let sellAbs = deathAbs + delay;
  /*
   * A SALE IN THE PURCHASE'S OWN CALENDAR YEAR WAITS FOR JANUARY. The engine
   * runs at most one sale and one purchase per calendar year, SALE FIRST
   * (housing.ts): a downsize sale scheduled in the plan purchase's year would
   * find no home at the sale step (the year's home is bought after it), and
   * the downsize rebuy would clobber the plan's own purchase in the
   * one-buy-per-year slot. Reachable with ordinary inputs — a death in the
   * buy month and a 3-month delay lands here — so the compiler must not emit
   * a shape the engine cannot execute. January of the next year is the
   * earliest month the machinery can honestly run the transaction.
   */
  if (Math.floor(sellAbs / 12) === buy.year) sellAbs = (buy.year + 1) * 12;
  const sellYear = Math.floor(sellAbs / 12);
  const sellMonth = (sellAbs % 12) + 1;
  const sellDate: YearMonth = `${sellYear}-${String(sellMonth).padStart(2, '0')}`;
  if (window) {
    const inWindow =
      sellYear >= window.startYear && sellYear < window.startYear + window.horizonYears;
    if (!inWindow) return [];
  }
  const out: ScenarioEvent[] = [{ type: 'sell_house', date: sellDate }];
  // A downsize price of 0 is the same statement as 'none' — the trap closure
  // compileHousingPlan makes for the plan price, however the zero got here: a
  // $0 rebuy would model a survivor who owns nothing, rents nothing and pays
  // no housing costs for the rest of their life.
  if (plan.survivorDownsizeTo === 'none' || plan.survivorDownsizeTo === 0) {
    if (window) {
      const endYear = window.startYear + window.horizonYears - 1;
      const months = Math.max(0, (endYear - sellYear) * 12 + (12 - sellMonth) + 1);
      if (months > 0) {
        out.push({ type: 'rent', start: sellDate, months, monthlyCost: plan.rentMonthly });
      }
    }
    return out;
  }
  out.push({
    type: 'buy_house',
    date: sellDate, // same month as the sale: the downsize is one transaction
    price: plan.survivorDownsizeTo,
    financing: 'cash',
    propertyTaxAnnual: plan.propertyTaxAnnual,
    insuranceAnnual: planInsuranceAnnual({ ...plan, purchasePrice: plan.survivorDownsizeTo }),
  });
  return out;
}

/**
 * The scenario's event list as the engine should see it once the plan has been
 * applied: hand-written housing events removed, compiled ones appended.
 *
 * With no plan the input array is returned UNCHANGED (same reference) — the
 * absent-plan path must be bit-for-bit what it was before this module existed,
 * because existing saved plans and a pile of tests still drive the move with
 * hand-written events.
 */
export function eventsWithHousingPlan(
  events: ScenarioEvent[],
  plan: HousingPlan | undefined,
  window?: { startYear: number; horizonYears: number },
): ScenarioEvent[] {
  if (!plan) return events;
  /*
   * THE SALE IS THE PLAN. If its date falls outside the simulated window the
   * whole move is unreachable, and compiling it anyway is actively dangerous:
   * prepareSim drops each event independently, so an out-of-range SALE was
   * discarded while the derived PURCHASE survived — the household bought a
   * replacement house it never sold the first one to pay for, the profile home
   * vanished from the balance sheet, and the purchase was funded by a fully
   * penalized raid on the IRA. One mistyped digit in a date did that silently.
   *
   * So the plan is all-or-nothing: no reachable sale, no compiled events, and
   * the scenario runs as though it had no housing plan at all.
   */
  let horizonMonths: number | undefined;
  if (window) {
    const saleYear = Number(plan.sellDate.slice(0, 4));
    const inWindow =
      Number.isFinite(saleYear) &&
      saleYear >= window.startYear &&
      saleYear < window.startYear + window.horizonYears;
    if (!inWindow) return events;
    // Months from the sale to the last simulated month, for a rent-forever plan.
    const saleMonth = Number(plan.sellDate.slice(5, 7));
    const endYear = window.startYear + window.horizonYears - 1;
    horizonMonths = Math.max(0, (endYear - saleYear) * 12 + (12 - saleMonth) + 1);
  }
  return [
    ...events.filter((e) => !PLAN_OWNED_EVENT_TYPES.has(e.type)),
    // The survivor switch reads the SAME event list being compiled into, which
    // is what makes it cover every way a death arrives: hand-written, the
    // widow sweep's probes, the search's widow probe — they are all `death`
    // events in `events` by the time prepareSim calls this.
    ...compileHousingPlan(survivorHousingPlan(plan, events), horizonMonths),
    // The downsize is the SECOND cycle, appended after the plan's own: a
    // death at/after the purchase month sells the just-bought home and rebuys
    // (or rents) on the survivor's schedule. Empty for every plan without the
    // field, every run without a death, and every death before the purchase.
    ...survivorDownsizeEvents(plan, events, window),
  ];
}

/**
 * The home appreciation rate the plan imposes, or null to keep the engine's own.
 *
 * THIS OVERRIDES, IT DOES NOT COMPOUND ON TOP. The engine already grows the
 * home every full year of ownership at `cpi + market.homeAppreciationRealSpread`
 * (housing.ts), so the sale price is ALREADY an appreciated figure — applying
 * the plan's rate as well would double-count growth and inflate the proceeds by
 * years of compounding. Instead the plan's rate REPLACES that rate wherever the
 * housing module would have used it.
 *
 * The consequence is the property the user asked for: with an override, the
 * sale price is exactly
 *
 *     profile.home.value x (1 + rate) ^ (saleYear - simulationStartYear)
 *
 * less selling costs and any mortgage payoff. (The exponent is the count of
 * FULL years owned: housing.ts appreciates at the end of each year the home is
 * held throughout, and the sale year itself does not appreciate.) It is also
 * deterministic across Monte Carlo paths, where the CPI-linked default is not.
 *
 * The override applies to the replacement house too, for the rest of the run.
 * One rate for "how fast houses go up in this plan" is a rule someone can hold
 * in their head; a rate that governs the old house and then silently reverts to
 * the market assumption for the new one is not.
 */
export function planHomeGrowthRate(plan: HousingPlan | undefined): number | null {
  return plan?.appreciationRate ?? null;
}
