/**
 * The Housing tab: the move, as one form.
 *
 * Selling a house, renting for a while and buying another is ONE decision with
 * several knobs, not three unrelated events — but until `scenario.housing`
 * existed it had to be entered as three hand-written events with a purchase
 * date the user recomputed in their head every time they tried a different rental
 * length. This card edits the plan-level `HousingPlan` instead, and the engine
 * compiles it back down to those same events (engine/housingPlan.ts), so
 * nothing downstream had to change.
 *
 * TWO RULES GOVERN WHAT THIS CARD SHOWS.
 *
 *  1. EVERY DERIVED FIGURE COMES FROM THE ENGINE'S OWN HELPERS. The purchase
 *     date, the insurance estimate and the mortgage payment are computed by
 *     importing `purchaseDate`, `estimateHomeInsuranceAnnual` and
 *     `annuityMonthlyPayment` from the engine rather than by re-deriving them
 *     here. A form that displays a number the simulation does not use is worse
 *     than one that displays nothing — the user would plan against the label
 *     instead of the model.
 *  2. NOTHING IS ENTERED TWICE. The purchase date is the sale date plus the
 *     rental months; the sale price is the profile home compounded to the sale
 *     year. Both are shown, neither is typed. What IS typed is either a
 *     decision (when, how long, what price, how financed) or a quote the user
 *     actually holds (property tax, and insurance when he has a real number).
 *
 * SUPERSEDE IS SAID OUT LOUD. While a housing plan is present the engine drops
 * every hand-written sell_house / rent / buy_house event in the scenario. That
 * is the right rule — two sale events would sell the house twice — but a silent
 * drop would leave the Events tab listing a move that is not being simulated,
 * so the card says so and offers to delete the dead events.
 */
import { useEffect, useState } from 'react';
import type {
  Home,
  HousingFinancing,
  HousingPlan,
  PlanHistoryEntry,
  PurchaseFundingTrace,
  RunResult,
  ScenarioEvent,
  YearMonth,
} from '../../../shared/types';
import { api } from '../../api';
import { stashFolderKey, type StashedBlock } from '../../planBlockStash';
import {
  historyRestoredNote,
  newestHousingVersion,
  readHousingStash,
  stashHousing,
  stashOfferNote,
  stashRestoredNote,
} from './housingStash';
import { clamp, formatPct, formatUSD, parseYearMonth } from '../../../shared/util';
// The engine's own figures, not lookalikes: what is displayed here IS what is
// modelled (see the module comment).
import { annuityMonthlyPayment, projectedPayoffLump } from '../../../engine/housing';
import { SIM_START_YEAR } from '../../../engine/household';
import {
  DEFAULT_DOWN_PCT,
  DEFAULT_MORTGAGE_RATE,
  DEFAULT_MORTGAGE_TERM_YEARS,
  DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS,
  estimateHomeInsuranceAnnual,
  purchaseDate,
} from '../../../engine/housingPlan';
import { FieldLabel, FieldNote, InfoTip, NumberField, SelectField } from '../profile/fields';
import { pctDisplayValue } from '../profile/profileLogic';
import { monthsBetween, type MarketDefaults } from '../scenarios/scenarioHelpers';

type MortgageFinancing = Extract<HousingFinancing, { type: 'mortgage' }>;

// ---------------------------------------------------------------------------
// Help text (verbose help lives behind the "?" — see fields.tsx)
// ---------------------------------------------------------------------------

/** The section-header tip (ScenarioPanel renders it beside the fold). */
export const HOUSING_CARD_TIP =
  'The move is plan-level configuration, not an event: the profile holds the house you HAVE, ' +
  'the plan holds what you will DO with it. The engine turns what you enter here back into the ' +
  'sale, the rental and the purchase it has always simulated — the §121 exclusion, selling ' +
  'costs, PMI below 20% down, amortization and the cash-before-IRA withdrawal order are all the ' +
  'same machinery as before.';

const SELL_DATE_TIP =
  'The month the current house is sold. If you have already stopped working by then the net ' +
  'proceeds are living money: the withdrawal order is cash, then taxable, then pre-tax, then ' +
  'Roth, and the proceeds land in cash — so they are spent before the IRA is touched.';

const APPRECIATION_TIP =
  'How fast houses appreciate in this plan, as a nominal annual rate. It REPLACES the market ' +
  'assumption (inflation plus the home spread) rather than adding to it, and it governs the ' +
  'replacement house too — one rate, one rule. Setting it also makes the sale price the same in ' +
  'every simulated future; leaving it blank lets the house track inflation, which in Monte Carlo ' +
  'mode means a sale price that varies from path to path.';

const RENT_MONTHS_TIP =
  'Months between selling and buying. 0 buys in the month the old house sells and simulates no ' +
  'rental at all. The purchase date is this plus the sale date — you never enter it, so changing ' +
  'the rental length moves the purchase with it.';

const RENT_DOLLARS_TIP =
  'What you expect to pay PER MONTH WHEN YOU MOVE — not what that flat costs today. The engine ' +
  'starts the rent index at the year the tenancy begins, so this figure is taken literally in the ' +
  'first rented year however far away the sale is, and grows with rent inflation from there. For a ' +
  'move a year or two out the distinction barely matters; for one a decade out, entering today’s ' +
  'rent understates it by a quarter or more.';

const PURCHASE_MODE_TIP =
  'A SET PRICE is a firm commitment: the plan reserves that cash, and anything the sale and your ' +
  'savings do not cover comes out of the IRA. WHATEVER THE MOVE LEAVES buys with the cash that ' +
  'actually survives — a year of rent and living costs come out of the proceeds first and the house ' +
  'is whatever is left. The difference is not cosmetic: a firm commitment makes the automatic 72(t) ' +
  'reserve the whole purchase, which can start the series a year or two earlier than it needs to and ' +
  'force taxable income you did not want.';

const PURCHASE_PRICE_TIP =
  'What the replacement house costs, in dollars at the purchase date. Unlike the sale price this ' +
  'is a decision rather than a projection, so it is entered. Whether the money is there is the ' +
  'simulation’s problem: it spends cash first, then the brokerage, then the IRA — a price the ' +
  'cash cannot cover is not an error, it is an IRA withdrawal and the tax bill that comes with it.';

const SURVIVOR_PRICE_TIP =
  'What the survivor buys if a death lands BEFORE the purchase month — the widow score reads it ' +
  'on every pre-purchase death year, so the number and its assumption travel together. Left ' +
  'blank, the survivor is modelled executing the plan price above exactly as written, which can ' +
  'be a far bigger commitment than one person would take on alone. “Whatever the sale nets” is ' +
  'the always-safe answer: the house is whatever the old one paid for. A death in or after the ' +
  'purchase month is the next field’s question — the house is already bought.';

const SURVIVOR_DOWNSIZE_TIP =
  'What the survivor does with the house if a death lands IN OR AFTER the purchase month — the ' +
  'other half of the timeline the field above covers. Left blank, the survivor is modelled keeping the ' +
  'house for good, property tax and all; staying put is an assumption exactly as much as ' +
  'selling is. “Sells and rebuys cheaper” sells after the delay below (ordinary selling costs ' +
  'come out of the proceeds) and buys the smaller house for cash the same month; “sells and ' +
  'rents” sells on the same schedule and rents at the plan’s rent for the rest of the plan. ' +
  'The widow score reads this on every post-purchase death year.';

const SURVIVOR_DOWNSIZE_DELAY_TIP =
  'Months between the death and the downsize sale. The default is 12 — nobody lists a house ' +
  'from a funeral, and a year is the conventional “no major decisions in the first year of ' +
  'widowhood” advice. 0 sells in the death month.';

const PROPERTY_TAX_TIP =
  'Annual property tax on the new house in purchase-year dollars; the engine indexes it to ' +
  'inflation from then on. Look up the real rate for the county you are buying in — at these ' +
  'prices it is the largest ownership cost by a wide margin.';

const INSURANCE_TIP =
  'Annual homeowners insurance in purchase-year dollars. Blank uses 0.22% of the purchase price, ' +
  'which is roughly what a policy costs as a fraction of a house’s value on an inland, ' +
  'low-catastrophe risk; it sits at the low end of published averages, which are dragged up by ' +
  'coastal wind and wildfire states. Enter a real quote when you have one. Below 20% down, PMI is charged on top of this and ' +
  'reported together with it.';

const FINANCING_TIP =
  'Cash spends what is on hand and withdraws the rest — savings, then the brokerage, then the ' +
  'IRA — so a large cash purchase can push a lot of ordinary income into one year. A mortgage ' +
  'keeps the money invested and spreads the cost, at the price of a payment for as long as the ' +
  'term runs.';

const DOWN_PCT_TIP =
  '20% is the line at which conventional mortgage insurance stops applying (Fannie Mae B7-1-01: ' +
  'MI is required above 80% LTV). Below it the simulation charges PMI at 0.5%/yr of the loan ' +
  'balance and reports it inside the insurance figure. Blank = 20%.';

const RATE_TIP =
  'Note rate, annual. Blank uses 6.67% — the Freddie Mac 30-year fixed average for the week of ' +
  '13 August 2026, rate only, so a real APR with fees and points will be a little higher. It is ' +
  'a spot rate, not a long-run assumption: re-check it before trusting a run made a year from now.';

const PAYOFF_TIP =
  'Pay the remaining principal in ONE lump this many years after buying — same calendar month, ' +
  'N years later. The lump is drawn through the ordinary withdrawal order that year (taxed, and ' +
  'penalized before 59½ where a draw is penalizable), the automatic 72(t) bridge reserves for ' +
  'it, and from that month the payment, interest and any PMI stop while property tax and ' +
  'insurance continue. Blank = pay the full term. A year the portfolio cannot afford follows ' +
  'the ordinary shortfall path, like any other big expense.';

const LEFTOVER_CASH_NOTE =
  'Cash left over after the down payment stays invested and is still spent before the IRA is ' +
  'touched — the ordering is unchanged, the money just earns a market return instead of the ' +
  'savings rate while it waits.';

const SUPERSEDE_TEXT =
  'While a housing plan is present, every hand-written sell / rent / buy event in this plan is ' +
  'IGNORED by the simulation — the plan is the single source of truth for the move, because two ' +
  'sale events would sell the house twice.';

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

interface SaleProjection {
  gross: number;
  /**
   * What actually reaches savings: gross, less selling costs, less any mortgage
   * still owed. The mortgage payoff was missing here while housing.ts has
   * always subtracted it, so a household with a $400k balance was shown a net
   * $372k higher than the engine credited — a card whose whole promise is that
   * the figure shown is the figure modelled.
   */
  net: number;
  rate: number;
  /** True when the plan names the rate, so the figure is the one every path sees. */
  exact: boolean;
}

/**
 * The projected gross sale price.
 *
 * THE EXPONENT IS FULL YEARS OWNED, not elapsed months. engine/housing.ts
 * appreciates the home at the END of each year it is held throughout, and the
 * sale year itself does not appreciate — so a June-2027 sale from a 2026 start
 * compounds ONCE, not one and a half times. Getting that wrong would overstate
 * the proceeds by most of a year's growth on a seven-figure asset.
 *
 * With no `appreciationRate` the engine grows the house at inflation plus the
 * home spread, which is stochastic per path in Monte Carlo; the figure is then
 * the deterministic-mode value and is labelled as one.
 */
function projectedSalePrice(
  home: Home,
  plan: HousingPlan,
  marketDefaults: MarketDefaults | null,
): SaleProjection | null {
  const rate = plan.appreciationRate ?? cpiLinkedHomeGrowth(marketDefaults);
  if (rate === null) return null;
  const gross = grossSalePrice(home, plan.sellDate, rate);
  if (gross === null) return null;
  const net = Math.max(0, gross * (1 - home.sellingCostPct) - (home.mortgage?.balance ?? 0));
  return { gross, net, rate, exact: plan.appreciationRate !== undefined };
}

/** The house grown to its sale year; null while the date is half-typed. */
function grossSalePrice(home: Home, sellDate: YearMonth, rate: number): number | null {
  let saleYear: number;
  try {
    saleYear = parseYearMonth(sellDate).year;
  } catch {
    return null; // the readout waits rather than lying
  }
  return home.value * Math.pow(1 + rate, Math.max(0, saleYear - SIM_START_YEAR));
}

/** The growth rate the engine uses when the plan names none; null until market.json loads. */
function cpiLinkedHomeGrowth(marketDefaults: MarketDefaults | null): number | null {
  if (marketDefaults === null) return null;
  return marketDefaults.inflation + (marketDefaults.homeSpread ?? 0);
}

interface MortgageFigures {
  downPct: number;
  down: number;
  loan: number;
  monthly: number;
  rate: number;
  termYears: number;
  /** Below 20% down the engine charges PMI; the card has to say so. */
  pmi: boolean;
  /**
   * The lump a scheduled payoff will draw — the ENGINE's projection
   * (projectedPayoffLump wraps the same amortization loop the simulation
   * runs), so the readout and the simulated outflow are the same figure.
   * Null when no payoff is scheduled.
   */
  payoffLump: number | null;
}

/** Down payment, loan and monthly principal-and-interest for a financed purchase. */
function mortgageFigures(price: number, financing: MortgageFinancing): MortgageFigures {
  const downPct = financing.downPct ?? DEFAULT_DOWN_PCT;
  const rate = financing.rate ?? DEFAULT_MORTGAGE_RATE;
  const termYears = financing.termYears ?? DEFAULT_MORTGAGE_TERM_YEARS;
  const down = price * downPct;
  const loan = price - down;
  return {
    downPct,
    down,
    loan,
    monthly: annuityMonthlyPayment(loan, rate, termYears),
    rate,
    termYears,
    pmi: downPct < DEFAULT_DOWN_PCT,
    payoffLump:
      financing.payoffAfterYears !== undefined
        ? projectedPayoffLump(price, {
            downPct,
            rate,
            termYears,
            payoffAfterYears: financing.payoffAfterYears,
          })
        : null,
  };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A complete, well-formed "YYYY-MM". */
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The purchase month, or null if the sale date is not a usable one.
 *
 * `purchaseDate` THROWS on a malformed date, and this card renders inside the
 * inputs panel with no error boundary above it — a throw here would blank the
 * whole workbench, results included, over a half-cleared date field. The field
 * below already refuses to commit anything malformed; this is the second lock
 * on the same door, because the cost of being wrong is the entire page.
 */
function safePurchaseDate(plan: HousingPlan): YearMonth | null {
  try {
    return purchaseDate(plan);
  } catch {
    return null;
  }
}

/** "2028-06" -> "June 2028"; falls back to the raw string while it is half-typed. */
function formatMonth(ym: YearMonth): string {
  try {
    const { year, month } = parseYearMonth(ym);
    return `${MONTH_NAMES[month - 1]} ${year}`;
  } catch {
    return ym;
  }
}

// ---------------------------------------------------------------------------
// Turning the plan on
// ---------------------------------------------------------------------------

function findEvent<T extends ScenarioEvent['type']>(
  events: readonly ScenarioEvent[],
  type: T,
): Extract<ScenarioEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<ScenarioEvent, { type: T }> => e.type === type);
}

/** The hand-written housing events a plan supersedes. */
export function handWrittenHousingEvents(events: readonly ScenarioEvent[]): ScenarioEvent[] {
  return events.filter(
    (e) => e.type === 'sell_house' || e.type === 'rent' || e.type === 'buy_house',
  );
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * The plan the "Model the move here" button creates.
 *
 * SEEDED FROM WHAT IS ALREADY THERE: the user's plan.json already describes
 * this move as three events, and a button that silently re-priced the house the
 * moment he clicked it would make the two representations impossible to
 * compare. Every field is lifted from the existing events where they exist, and
 * derived from the profile where they do not.
 *
 * The rental length comes from the GAP between the sale and the purchase rather
 * than from the rent event's own `months`, because that gap is what fixes the
 * purchase date and the purchase date is the thing the user would notice
 * moving. (They agree in a well-formed plan; the gap wins when they do not.)
 *
 * ONE THING CANNOT BE CARRIED OVER, AND IT IS NOT SMALL. A `buy_house` event
 * can be priced at `'sale_proceeds'` — "buy whatever the old house fetches" —
 * and a HousingPlan cannot: it states a price, because choosing the house is
 * the decision the tab exists to model. So the seed freezes the PROJECTED net
 * proceeds into a number, and that changes the risk being simulated: a floating
 * price bought less house when the market disappointed, while a fixed price is
 * a commitment the portfolio has to meet. On a representative plan that swap is
 * worth about five points of success probability in Monte Carlo — measured, not
 * estimated — so the card says so before the button is pressed rather than
 * letting a number move unexplained.
 *
 * The appreciation rate is seeded to the market assumption the engine would
 * otherwise use rather than left blank: the point of the tab is a sale price
 * you can see and steer, and seeding at the engine's own deterministic default
 * means the deterministic answer does not move on the click. In Monte Carlo it
 * does change one thing — the sale price becomes identical across paths instead
 * of tracking each path's inflation — which is what the field's help says.
 */
export function seedHousingPlan(
  home: Home,
  events: readonly ScenarioEvent[],
  marketDefaults: MarketDefaults | null,
): HousingPlan {
  const sell = findEvent(events, 'sell_house');
  const rent = findEvent(events, 'rent');
  const buy = findEvent(events, 'buy_house');
  const retire = findEvent(events, 'retire');

  // Sell when the events say; failing that, when work stops — the move being
  // modelled is a retirement move; failing that, the middle of next year.
  const sellDate: YearMonth = sell?.date ?? retire?.date ?? `${SIM_START_YEAR + 1}-06`;
  const rentMonths = buy ? Math.max(0, monthsBetween(sellDate, buy.date)) : (rent?.months ?? 12);

  const cpiLinked = cpiLinkedHomeGrowth(marketDefaults);

  // A buy_house event priced at 'sale_proceeds' carries no number to lift, so
  // the seed uses the projected net proceeds — the number that event would most
  // often have produced — rather than the house's value today, which ignores
  // both the appreciation to the sale date and the 6% that goes to selling it.
  const gross = cpiLinked === null ? null : grossSalePrice(home, sellDate, cpiLinked);
  const projectedNet = gross === null ? null : Math.round(gross * (1 - home.sellingCostPct));
  const purchasePrice =
    buy && typeof buy.price === 'number'
      ? buy.price
      : (projectedNet ?? Math.round(home.value * (1 - home.sellingCostPct)));

  const financing: HousingFinancing =
    buy && buy.financing !== 'cash'
      ? {
          type: 'mortgage',
          downPct: buy.financing.downPct,
          rate: buy.financing.rate,
          termYears: buy.financing.termYears,
          // Lifted like the other three: a hand-written event that schedules a
          // payoff must seed a plan that schedules the same one, or the button
          // would silently lengthen the loan back to full term.
          ...(buy.financing.payoffAfterYears !== undefined
            ? { payoffAfterYears: buy.financing.payoffAfterYears }
            : {}),
        }
      : { type: 'cash' };

  return {
    sellDate,
    appreciationRate: cpiLinked === null ? undefined : round4(cpiLinked),
    rentMonths,
    rentMonthly: rent?.monthlyCost ?? DEFAULT_RENT_MONTHLY,
    purchasePrice,
    propertyTaxAnnual: buy?.propertyTaxAnnual ?? home.propertyTaxAnnual,
    // Absent unless a hand-written event carried a real figure: absent means
    // "estimate it from the price", which is the honest default.
    insuranceAnnual: buy?.insuranceAnnual,
    financing,
  };
}

/**
 * Rent to assume when nothing in the plan names one. Nothing in the profile
 * implies a rent — the household owns — so this is a placeholder the user is
 * expected to replace, and the field sits right next to the months so it is
 * hard to miss.
 */
const DEFAULT_RENT_MONTHLY = 3000;

/**
 * The plan with the survivor purchase price set — or, for `undefined`,
 * REMOVED. A cleared field comes OUT of the object rather than sitting in it
 * as `undefined`, for the same reason the mortgage sub-fields do: the plan is
 * JSON on disk, and ABSENT is the spelling that means "the survivor executes
 * the plan price". An `undefined` value would survive the in-memory draft,
 * disagree with what the schema hands back after a save/load, and make "did
 * the user state a survivor price?" unanswerable by inspection.
 */
export function withSurvivorPurchasePrice(
  plan: HousingPlan,
  value: number | 'sale_proceeds' | undefined,
): HousingPlan {
  const next = { ...plan };
  if (value === undefined) delete next.survivorPurchasePrice;
  else next.survivorPurchasePrice = value;
  return next;
}

/**
 * The plan with the survivor downsize set — or, for `undefined`, REMOVED,
 * along with its delay: the delay qualifies the downsize, and a dangling
 * `survivorDownsizeDelayMonths` beside an absent `survivorDownsizeTo` is an
 * inert field the schema round-trips but nothing reads (the search compiler
 * strips exactly that shape to keep cache keys whole). Same absent-not-
 * undefined contract as `withSurvivorPurchasePrice`, for the same reasons.
 */
export function withSurvivorDownsize(
  plan: HousingPlan,
  value: number | 'none' | undefined,
  delayMonths?: number,
): HousingPlan {
  const next = { ...plan };
  if (value === undefined) {
    delete next.survivorDownsizeTo;
    delete next.survivorDownsizeDelayMonths;
    return next;
  }
  next.survivorDownsizeTo = value;
  if (delayMonths === undefined) delete next.survivorDownsizeDelayMonths;
  else next.survivorDownsizeDelayMonths = delayMonths;
  return next;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface HousingCardProps {
  /** The plan's housing configuration; absent means the move is not modelled here. */
  housing: HousingPlan | undefined;
  /** The whole event list, for the supersede warning and for seeding. */
  events: ScenarioEvent[];
  /** The house the household owns today (from the profile). */
  home: Home;
  /** market.json defaults, for the appreciation seed and the blank-rate preview. */
  marketDefaults: MarketDefaults | null;
  /**
   * The last completed run, for the cash-at-purchase readout. THE RUN, not a
   * recomputation: `result.purchaseFunding` is the engine's own record of the
   * reference path's sale → rent → buy cash story, so what the card shows is
   * exactly what the simulation did — and it survives a refresh because the
   * workbench re-runs on load and the server's run cache re-serves the same
   * completed run rather than recomputing it. No run yet (or no window in the
   * last run) renders nothing rather than a row of zeros.
   */
  result: RunResult | null;
  onChange: (housing: HousingPlan | undefined) => void;
  onChangeEvents: (events: ScenarioEvent[]) => void;
}

export function HousingCard(props: HousingCardProps) {
  const { housing, events, home, marketDefaults, result, onChange, onChangeEvents } = props;
  /**
   * THE TOGGLE KEEPS ITS CONFIGURATION (2026-08-29; the pattern and its
   * incident: src/ui/planBlockStash.ts). Turn off still REMOVES `housing`
   * from the plan — the engine's absent-means-unmodeled contract is
   * untouchable — but the removed block is stashed per data folder, and
   * turning back on restores it (or, failing the stash, the newest history
   * version that modelled the move), with a provenance line saying where the
   * values came from and when. Only with neither source does the seeded
   * blank form appear, because then blank is the truth.
   */
  const [folderKey, setFolderKey] = useState<string | null>(null);
  const [restoredNote, setRestoredNote] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void stashFolderKey().then((key) => {
      if (!cancelled) setFolderKey(key);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!housing) {
    const stashed = folderKey === null ? null : readHousingStash(folderKey);
    const turnOn = async (): Promise<void> => {
      if (stashed !== null) {
        setRestoredNote(stashRestoredNote(stashed.stashedAt));
        onChange(stashed.value);
        return;
      }
      // The folder-resident fallback: the newest filed version whose plan
      // modelled the move. Asked only at the press — the OFF state must not
      // poll the history to render a button.
      setTurningOn(true);
      let fallback: PlanHistoryEntry | null = null;
      try {
        fallback = newestHousingVersion(await api.planHistory());
      } catch {
        fallback = null; // an unreadable history must not block the form
      } finally {
        setTurningOn(false);
      }
      if (fallback !== null && fallback.plan.housing !== undefined) {
        setRestoredNote(historyRestoredNote(fallback));
        onChange(fallback.plan.housing);
        return;
      }
      setRestoredNote(null);
      onChange(seedHousingPlan(home, events, marketDefaults));
    };
    return (
      <HousingOff {...props} stashed={stashed} turningOn={turningOn} onTurnOn={turnOn} />
    );
  }

  const plan = housing;
  const financing = plan.financing;
  const set = (patch: Partial<HousingPlan>) => onChange({ ...plan, ...patch });

  const sale = projectedSalePrice(home, plan, marketDefaults);
  /*
   * The price to SHOW and to derive from. A 'sale_proceeds' purchase has no
   * stated price — it buys with whatever the move leaves — so the projected net
   * proceeds stand in for every downstream figure (insurance, maintenance, the
   * mortgage arithmetic). The engine will cap the real purchase at the cash
   * that actually survived a year of renting, so this is an upper bound and the
   * help text says so.
   */
  const noPurchase = plan.purchasePrice === 'none';
  const residual = plan.purchasePrice === 'sale_proceeds';
  // Narrowed off plan.purchasePrice directly: TypeScript cannot follow the
  // boolean consts above back to the union.
  const effectivePrice: number =
    plan.purchasePrice === 'sale_proceeds'
      ? (sale?.net ?? 0)
      : plan.purchasePrice === 'none'
        ? 0
        : plan.purchasePrice;
  const insuranceEstimate = estimateHomeInsuranceAnnual(effectivePrice);
  const buyDate = safePurchaseDate(plan);
  const stale = handWrittenHousingEvents(events);
  const retire = findEvent(events, 'retire');

  return (
    <div className="card">
      <div className="row">
        {/* No heading: the section header names this card. */}
        <span className="spacer" />
        <button
          onClick={() => {
            // THE STASH WRITE, before the removal: the block leaves the plan
            // (absent means unmodeled — the engine's contract), and the UI
            // keeps what the owner typed so turning back on restores it.
            if (folderKey !== null) stashHousing(folderKey, plan, new Date());
            setRestoredNote(null);
            onChange(undefined);
          }}
          title="Stop modelling the move here and go back to hand-written events"
        >
          Turn off
        </button>
      </div>

      {/* Where a restored form's values came from, and when — a restored
          number carries its condition like any other conditional figure. */}
      {restoredNote !== null && (
        <div className="lib-warning warn" role="status" style={{ marginTop: 10 }}>
          {restoredNote}
        </div>
      )}

      {stale.length > 0 && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          This plan still carries {stale.length} hand-written housing{' '}
          {stale.length === 1 ? 'event' : 'events'} ({stale.map(eventWord).join(', ')}).{' '}
          {SUPERSEDE_TEXT}
          <button
            style={{ marginLeft: 8 }}
            onClick={() =>
              onChangeEvents(
                events.filter(
                  (e) => e.type !== 'sell_house' && e.type !== 'rent' && e.type !== 'buy_house',
                ),
              )
            }
          >
            Delete them
          </button>
        </div>
      )}

      {/* ------------------------------ selling ------------------------------ */}
      <h3 className="housing-step">Selling</h3>
      <div className="row">
        <label className="field" style={{ width: 150 }}>
          <FieldLabel label="Sell in" tip={SELL_DATE_TIP} />
          <input
            type="month"
            value={plan.sellDate}
            // A month input reports "" while a segment is blank — and it has a
            // clear button. Committing that would write a plan the schema
            // rejects, which stops the autosave dead and shows a red banner
            // instead of a date. Incomplete input simply is not committed, so
            // the field falls back to the last good month, exactly the way
            // NumberField reverts an unparseable number.
            onChange={(e) => {
              const v = e.target.value;
              if (YEAR_MONTH_RE.test(v)) set({ sellDate: v as YearMonth });
            }}
          />
        </label>
        <NumberField
          // Keyed by the stored value so a rate the schema would reject comes
          // back on screen CLAMPED: the field keeps its own text state, and a
          // box reading 50% over a plan holding 20% is the worst of both.
          key={`appreciation:${plan.appreciationRate ?? 'cpi'}`}
          label="Appreciation %/yr"
          width={140}
          pct
          allowEmpty
          placeholder="inflation"
          tip={APPRECIATION_TIP}
          value={plan.appreciationRate}
          onCommit={(v) =>
            set({ appreciationRate: v === undefined ? undefined : clamp(v, -0.2, 0.2) })
          }
        />
      </div>

      <Readout
        lines={[
          {
            label: sale?.exact ? 'Sale price' : 'Sale price (deterministic mode)',
            value: sale ? formatUSD(sale.gross) : '—',
          },
          {
            label: `Less selling costs (${formatPct(home.sellingCostPct, 0)})`,
            value: sale ? `− ${formatUSD(sale.gross * home.sellingCostPct)}` : '—',
          },
          ...(home.mortgage
            ? [
                {
                  label: 'Less mortgage payoff',
                  value: `− ${formatUSD(home.mortgage.balance)}`,
                },
              ]
            : []),
          {
            label: 'Net proceeds AT THE SALE',
            value: sale ? formatUSD(sale.net) : '—',
          },
        ]}
      />
      <div className="field-help" style={{ marginTop: 4 }}>
        {saleNote(home, sale)}
      </div>
      {plan.rentMonths > 0 && plan.purchasePrice !== 'none' && (
        <div className="field-help" style={{ marginTop: 4 }}>
          <strong>This is the figure at the sale, not your buying power.</strong> You live on this
          money for the {plan.rentMonths} months you rent, so less of it reaches the next house
          — offset by whatever it earns in the meantime. On a plan selling in 2027 and buying a year
          later the difference measured about $113,000. The exact number is whatever the run
          produces; the Cashflow tab shows the year the purchase actually lands.
        </div>
      )}
      {retire && (
        <div className="field-help" style={{ marginTop: 4 }}>
          {retirementOrderNote(retire.date, plan.sellDate)}
        </div>
      )}

      {/* ------------------------------ renting ------------------------------ */}
      <h3 className="housing-step">Renting</h3>
      <div className="row">
        <NumberField
          key={`rentMonths:${plan.rentMonths}`}
          label="Months renting"
          width={130}
          int
          tip={RENT_MONTHS_TIP}
          value={plan.rentMonths}
          onCommit={(v) => set({ rentMonths: Math.round(clamp(v ?? 0, 0, 600)) })}
        />
        <NumberField
          label="Rent $/mo"
          width={130}
          help="In sale-year dollars"
          tip={RENT_DOLLARS_TIP}
          value={plan.rentMonthly}
          onCommit={(v) => set({ rentMonthly: Math.max(0, v ?? 0) })}
        />
      </div>
      <Readout
        lines={
          plan.rentMonths === 0
            ? [
                {
                  label: 'No rental — you buy the month you sell',
                  value: buyDate === null ? '—' : formatMonth(buyDate),
                },
              ]
            : [
                {
                  label: `Rent, ${plan.rentMonths} months from ${formatMonth(plan.sellDate)}`,
                  value: `${formatUSD(plan.rentMonthly * plan.rentMonths)} total`,
                },
                { label: 'Buy in', value: buyDate === null ? '—' : formatMonth(buyDate) },
              ]
        }
      />

      {/* ------------------------------ buying ------------------------------- */}
      <h3 className="housing-step">Buying</h3>
      <div className="row">
        <SelectField
          label="Buy for"
          width={190}
          tip={PURCHASE_MODE_TIP}
          value={noPurchase ? 'none' : residual ? 'sale_proceeds' : 'price'}
          options={[
            { value: 'price', label: 'A set price' },
            { value: 'sale_proceeds', label: 'Whatever the move leaves' },
            { value: 'none', label: 'Don’t buy — rent from then on' },
          ]}
          onChange={(v) =>
            set({
              purchasePrice:
                v === 'sale_proceeds' ? 'sale_proceeds' : v === 'none' ? 'none' : Math.round(effectivePrice),
            })
          }
        />
        {noPurchase ? (
          <FieldNote className="muted">
            renting to the end of the plan at {formatUSD(plan.rentMonthly)}/mo — no house is bought,
            and the proceeds stay invested
          </FieldNote>
        ) : residual ? (
          <FieldNote className="muted">
            up to {formatUSD(effectivePrice)} — capped at the cash left after renting
          </FieldNote>
        ) : (
          <NumberField
            label="Purchase price"
            width={150}
            tip={PURCHASE_PRICE_TIP}
            value={plan.purchasePrice as number}
            onCommit={(v) => set({ purchasePrice: Math.max(0, v ?? 0) })}
          />
        )}
        <NumberField
          label="Property tax $/yr"
          width={150}
          tip={PROPERTY_TAX_TIP}
          value={plan.propertyTaxAnnual}
          onCommit={(v) => set({ propertyTaxAnnual: Math.max(0, v ?? 0) })}
        />
      </div>
      {/* The survivor's own price — hidden for a rent-forever plan, where
          there is no purchase for anyone to re-price. The stored value is
          KEPT when the user toggles to "Don't buy" and back: an assumption
          he typed once should not be lost to trying an alternative. */}
      {!noPurchase && (
        <div className="row">
          <SelectField
            label="If one of us dies before the purchase"
            width={250}
            tip={SURVIVOR_PRICE_TIP}
            value={
              plan.survivorPurchasePrice === undefined
                ? 'plan'
                : plan.survivorPurchasePrice === 'sale_proceeds'
                  ? 'sale_proceeds'
                  : 'price'
            }
            options={[
              { value: 'plan', label: 'The survivor buys at the plan price' },
              { value: 'price', label: 'The survivor buys at their own price' },
              { value: 'sale_proceeds', label: 'The survivor buys what the sale nets' },
            ]}
            onChange={(v) =>
              onChange(
                withSurvivorPurchasePrice(
                  plan,
                  v === 'plan'
                    ? undefined
                    : v === 'sale_proceeds'
                      ? 'sale_proceeds'
                      : // Seeded at the plan's own effective price, like the
                        // "Buy for" select: a mode switch must not invent a
                        // number the user never saw.
                        Math.round(effectivePrice),
                ),
              )
            }
          />
          {plan.survivorPurchasePrice === undefined ? (
            <FieldNote className="muted">
              blank = the plan price: a pre-purchase death is modelled executing the purchase
              above exactly as written
            </FieldNote>
          ) : plan.survivorPurchasePrice === 'sale_proceeds' ? (
            <FieldNote className="muted">
              the always-safe answer — the next house is whatever the old one paid for
            </FieldNote>
          ) : (
            <NumberField
              label="Survivor price"
              width={150}
              value={plan.survivorPurchasePrice}
              onCommit={(v) =>
                onChange(withSurvivorPurchasePrice(plan, Math.max(0, v ?? 0)))
              }
            />
          )}
        </div>
      )}
      {/* The OTHER half of the death timeline: what the survivor does with a
          house that is already bought. Hidden for a rent-forever plan for the
          same reason the pre-purchase field is — nothing is bought, so there
          is nothing to keep or downsize. */}
      {!noPurchase && (
        <div className="row">
          <SelectField
            label="If one of us dies after the purchase"
            width={250}
            tip={SURVIVOR_DOWNSIZE_TIP}
            value={
              plan.survivorDownsizeTo === undefined
                ? 'keep'
                : plan.survivorDownsizeTo === 'none'
                  ? 'rent'
                  : 'downsize'
            }
            options={[
              { value: 'keep', label: 'The survivor keeps the house' },
              { value: 'downsize', label: 'The survivor sells and rebuys cheaper' },
              { value: 'rent', label: 'The survivor sells and rents' },
            ]}
            onChange={(v) =>
              onChange(
                withSurvivorDownsize(
                  plan,
                  v === 'keep'
                    ? undefined
                    : v === 'rent'
                      ? 'none'
                      : // Seeded at the plan's own effective price, like the
                        // survivor-price select: a mode switch must not invent
                        // a number the user never saw. The point is to lower
                        // it, and the field is right there.
                        Math.round(effectivePrice),
                  plan.survivorDownsizeDelayMonths,
                ),
              )
            }
          />
          {plan.survivorDownsizeTo === undefined ? (
            <FieldNote className="muted">
              blank = they keep it: a post-purchase death is modelled staying in the house above
              for good
            </FieldNote>
          ) : (
            <>
              {plan.survivorDownsizeTo !== 'none' && (
                <NumberField
                  label="Downsize to"
                  width={150}
                  value={plan.survivorDownsizeTo}
                  onCommit={(v) =>
                    onChange(
                      withSurvivorDownsize(plan, Math.max(0, v ?? 0), plan.survivorDownsizeDelayMonths),
                    )
                  }
                />
              )}
              <NumberField
                label="Months after death"
                width={150}
                allowEmpty
                placeholder={String(DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS)}
                tip={SURVIVOR_DOWNSIZE_DELAY_TIP}
                help={
                  plan.survivorDownsizeDelayMonths === undefined
                    ? `Blank = ${DEFAULT_SURVIVOR_DOWNSIZE_DELAY_MONTHS} months`
                    : undefined
                }
                value={plan.survivorDownsizeDelayMonths}
                onCommit={(v) =>
                  onChange(
                    withSurvivorDownsize(
                      plan,
                      plan.survivorDownsizeTo,
                      v === undefined ? undefined : Math.max(0, Math.round(v)),
                    ),
                  )
                }
              />
            </>
          )}
        </div>
      )}
      <div className="row">
        <NumberField
          key={`insurance:${plan.insuranceAnnual ?? 'estimate'}`}
          label="Insurance $/yr"
          width={150}
          allowEmpty
          placeholder={String(insuranceEstimate)}
          tip={INSURANCE_TIP}
          help={
            plan.insuranceAnnual === undefined
              ? `Estimated: ${formatUSD(insuranceEstimate)}`
              : `Estimate would be ${formatUSD(insuranceEstimate)}`
          }
          value={plan.insuranceAnnual}
          onCommit={(v) => set({ insuranceAnnual: v === undefined ? undefined : Math.max(0, v) })}
        />
        <SelectField
          label="Paid with"
          width={150}
          tip={FINANCING_TIP}
          value={financing.type}
          options={[
            { value: 'cash', label: 'Cash' },
            { value: 'mortgage', label: 'Mortgage' },
          ]}
          onChange={(v) =>
            set({
              financing:
                v === 'mortgage'
                  ? // Sub-fields left absent on purpose: absent means "whatever
                    // the engine's current default is", so saving a plan today
                    // does not freeze today's mortgage rate into the file.
                    { type: 'mortgage' }
                  : { type: 'cash' },
            })
          }
        />
      </div>

      {financing.type === 'mortgage' ? (
        <MortgageFields
          financing={financing}
          price={effectivePrice}
          onChange={(next) => set({ financing: next })}
        />
      ) : (
        <CashFields
          plan={plan}
          home={home}
          insuranceEstimate={insuranceEstimate}
          price={effectivePrice}
        />
      )}

      {/* No run yet, or no between-homes window in the last run's plan:
          render NOTHING rather than a column of zeros pretending to be an
          answer (the props doc says why the run is the source). */}
      {!noPurchase && result?.purchaseFunding !== undefined && (
        <PurchaseFundingReadout funding={result.purchaseFunding} />
      )}
    </div>
  );
}

/**
 * Where the house money comes from, as the LAST COMPLETED RUN measured it:
 * the five funding components, their sum, and that sum against the cash the
 * purchase actually took. Every figure is the engine's own
 * (RunResult.purchaseFunding) — the card adds no arithmetic beyond
 * formatting, so it can never disagree with the simulation.
 */
function PurchaseFundingReadout({ funding }: { funding: PurchaseFundingTrace }) {
  const f = funding;
  const shortfall = f.surplus < 0;
  return (
    <>
      <h3 className="housing-step">Cash at the purchase</h3>
      <Readout
        lines={[
          { label: 'Savings before the sale', value: formatUSD(f.preExistingSavings) },
          { label: 'Net sale proceeds', value: `+ ${formatUSD(f.netSaleProceeds)}` },
          { label: 'Investing banked to cash', value: `+ ${formatUSD(f.bankedInvesting)}` },
          {
            label: 'Living reduction banked (renting column)',
            value: `+ ${formatUSD(f.bankedLivingReduction)}`,
          },
          { label: 'Interest earned while waiting', value: `+ ${formatUSD(f.interestEarned)}` },
          {
            label: `Cash available at the buy month (${formatMonth(f.buyDate)})`,
            value: formatUSD(f.totalCash),
          },
          {
            label: f.financing === 'cash' ? 'Purchase price' : 'Down payment at closing',
            value: `− ${formatUSD(f.cashOutflow)}`,
          },
          shortfall
            ? { label: 'Shortfall — drawn from the IRA', value: formatUSD(-f.surplus) }
            : { label: 'Surplus — stays in cash and keeps earning', value: formatUSD(f.surplus) },
        ]}
      />
      <div className="field-help" style={{ marginTop: 4 }}>
        From the last completed run, in nominal dollars of the buy year — the sum of the five
        lines above, exactly as the simulation banked them across the {f.windowMonths}-month
        window from {formatMonth(f.sellDate)}.{' '}
        {shortfall
          ? 'The shortfall is withdrawn through the normal order — whatever cash and brokerage ' +
            'money remains first, then the IRA, with that year’s tax bill to match.'
          : 'Money the purchase does not consume is spent on living before the IRA is touched.'}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Financing arms
// ---------------------------------------------------------------------------

/**
 * The mortgage-only fields and what they add up to. A separate component so the
 * discriminated financing union is narrowed ONCE, at the call site, instead of
 * inside every callback (where TypeScript would have lost the narrowing).
 */
function MortgageFields({
  financing,
  price,
  onChange,
}: {
  financing: MortgageFinancing;
  price: number;
  onChange: (financing: MortgageFinancing) => void;
}) {
  const figures = mortgageFigures(price, financing);

  /**
   * Patch one sub-field. A cleared field must come back OUT of the object
   * rather than sit in it as `undefined`: the plan is JSON on disk, and
   * "absent" is what means "use the engine's default".
   */
  const set = (patch: Partial<Omit<MortgageFinancing, 'type'>>) => {
    const next: MortgageFinancing = { ...financing, ...patch };
    for (const key of ['downPct', 'rate', 'termYears', 'payoffAfterYears'] as const) {
      if (key in patch && patch[key] === undefined) delete next[key];
    }
    /*
     * The payoff must stay STRICTLY inside the term — the schema rejects a
     * plan where it does not, and a card that can produce an unsaveable plan
     * is a trap. Shortening the term below an existing payoff CLAMPS the
     * payoff to term - 1 rather than dropping it: "pay this off early" is the
     * owner's stated intent and should survive a term edit; a one-year term
     * leaves no early month to pay off in, so there the field goes entirely.
     */
    const effTerm = next.termYears ?? DEFAULT_MORTGAGE_TERM_YEARS;
    if (next.payoffAfterYears !== undefined && next.payoffAfterYears >= effTerm) {
      if (effTerm > 1) next.payoffAfterYears = effTerm - 1;
      else delete next.payoffAfterYears;
    }
    onChange(next);
  };

  /** Widest payoff the current term admits (29 against the 30-year default). */
  const maxPayoff = Math.min(29, (financing.termYears ?? DEFAULT_MORTGAGE_TERM_YEARS) - 1);

  return (
    <>
      <div className="row">
        <NumberField
          key={`downPct:${financing.downPct ?? 'default'}`}
          label="Down payment %"
          width={140}
          pct
          allowEmpty
          placeholder={String(pctDisplayValue(DEFAULT_DOWN_PCT))}
          tip={DOWN_PCT_TIP}
          value={financing.downPct}
          onCommit={(v) => set({ downPct: v === undefined ? undefined : clamp(v, 0, 1) })}
        />
        <NumberField
          key={`payoff:${financing.payoffAfterYears ?? 'default'}`}
          label="Pay off after (years)"
          width={140}
          int
          allowEmpty
          placeholder="full term"
          tip={PAYOFF_TIP}
          value={financing.payoffAfterYears}
          onCommit={(v) =>
            set({
              payoffAfterYears:
                // A term of 1 admits no early payoff at all; a committed value
                // is otherwise clamped into [1, term - 1] like every other
                // bounded field on this card.
                v === undefined || maxPayoff < 1
                  ? undefined
                  : Math.round(clamp(v, 1, maxPayoff)),
            })
          }
        />
        <NumberField
          key={`rate:${financing.rate ?? 'default'}`}
          label="Rate %"
          width={110}
          pct
          allowEmpty
          placeholder={String(pctDisplayValue(DEFAULT_MORTGAGE_RATE))}
          tip={RATE_TIP}
          value={financing.rate}
          onCommit={(v) => set({ rate: v === undefined ? undefined : clamp(v, 0, 0.25) })}
        />
        <NumberField
          key={`term:${financing.termYears ?? 'default'}`}
          label="Term (years)"
          width={110}
          int
          allowEmpty
          placeholder={String(DEFAULT_MORTGAGE_TERM_YEARS)}
          value={financing.termYears}
          onCommit={(v) =>
            set({ termYears: v === undefined ? undefined : Math.round(clamp(v, 1, 50)) })
          }
        />
      </div>
      <Readout
        lines={[
          {
            label: `Down payment (${formatPct(figures.downPct, 0)}, from cash)`,
            value: formatUSD(figures.down),
          },
          { label: 'Loan amount', value: formatUSD(figures.loan) },
          {
            label: `Payment at ${formatPct(figures.rate, 2)} over ${figures.termYears} years`,
            value: `${formatUSD(figures.monthly)}/mo`,
          },
          // The engine's own projection of the lump (see MortgageFigures) — a
          // planned six-figure outflow the user should see before the run does.
          ...(figures.payoffLump !== null && financing.payoffAfterYears !== undefined
            ? [
                {
                  label: `Payoff lump after ${financing.payoffAfterYears} years (from the portfolio)`,
                  value: formatUSD(figures.payoffLump),
                },
              ]
            : []),
        ]}
      />
      {figures.pmi && (
        <div className="field-help warn" style={{ marginTop: 4 }}>
          Below 20% down: PMI of about {formatUSD(0.005 * figures.loan)}/yr is charged on the
          opening balance, falling as the loan amortizes.
        </div>
      )}
      <div className="field-help" style={{ marginTop: 4 }}>
        {LEFTOVER_CASH_NOTE}
      </div>
    </>
  );
}

/** What a cash purchase costs up front and to hold. */
function CashFields({
  plan,
  home,
  insuranceEstimate,
  price,
}: {
  plan: HousingPlan;
  home: Home;
  insuranceEstimate: number;
  /** Resolved: the stated price, or the projected proceeds for a residual buy. */
  price: number;
}) {
  const insurance = plan.insuranceAnnual ?? insuranceEstimate;
  const maintenance = price * home.maintenancePctOfValue;
  return (
    <>
      <Readout
        lines={[
          { label: 'Cash needed at closing', value: formatUSD(price) },
          {
            label: 'Ownership cost, first year',
            value: `${formatUSD(plan.propertyTaxAnnual + insurance + maintenance)}/yr`,
          },
        ]}
      />
      <div className="field-help" style={{ marginTop: 4 }}>
        Ownership cost is tax plus insurance plus maintenance at{' '}
        {formatPct(home.maintenancePctOfValue, 1)} of value — the rate your profile already uses
        for the house you own now. The cash comes from savings first, then the brokerage, then the
        IRA, so a price the sale proceeds cannot cover is an IRA withdrawal in that year.
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notes and readouts
// ---------------------------------------------------------------------------

/** A short name for a superseded event, for the warning banner. */
function eventWord(e: ScenarioEvent): string {
  return e.type === 'sell_house' ? 'sell' : e.type === 'rent' ? 'rent' : 'buy';
}

/** What the sale-price figure is, and how far to trust it. */
function saleNote(home: Home, sale: SaleProjection | null): string {
  if (!sale) {
    return 'Set an appreciation rate to project the sale price.';
  }
  const base =
    `${formatUSD(home.value)} today, compounded at ${formatPct(sale.rate)} for each full year ` +
    `owned — the sale year itself does not appreciate.`;
  const mortgage = home.mortgage
    ? ' The outstanding mortgage is paid off at closing, so less cash arrives than the net proceeds shown.'
    : '';
  return sale.exact
    ? `${base} The same in every simulated future.${mortgage}`
    : `${base} That is the market assumption, so in Monte Carlo mode the sale price varies from ` +
        `path to path.${mortgage}`;
}

/** Whether the proceeds land before or after the salary stops. */
function retirementOrderNote(retireDate: YearMonth, sellDate: YearMonth): string {
  const gap = monthsBetween(retireDate, sellDate);
  return gap >= 0
    ? `You stop working ${formatMonth(retireDate)} and sell ${formatMonth(sellDate)}, so the ` +
        `proceeds are living money — spent down before anything is withdrawn from the IRA.`
    : `You sell ${formatMonth(sellDate)}, ${-gap} months before you stop working, so the proceeds ` +
        `wait in cash and are spent first once the salary stops.`;
}

/** Derived figures: label left, value right, in the box the paired cards use. */
function Readout({ lines }: { lines: Array<{ label: string; value: string }> }) {
  return (
    <div className="pair-readonly" style={{ marginTop: 8 }}>
      {lines.map((l) => (
        <div className="pair-readonly-line" key={l.label}>
          <span className="muted">{l.label}</span>
          <span>{l.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The off state
// ---------------------------------------------------------------------------

/**
 * What the tab shows when the plan carries no `housing` block: ONE action, and
 * the plain truth about what it does to the events already there. There is
 * deliberately no half-form to fill in first — a partly-entered housing plan
 * that is not yet driving the simulation is exactly the ambiguity the plan
 * object exists to remove.
 *
 * When a STASH exists (the block a Turn off removed, in this folder), the
 * button restores it and this state says so BEFORE the press — a button that
 * silently produced last month's numbers would read as the form inventing
 * them. The event-copy explanation renders only when the button will really
 * copy events, i.e. when no stash stands in front of it.
 */
function HousingOff({
  events,
  stashed,
  turningOn,
  onTurnOn,
}: HousingCardProps & {
  /** The block Turn off removed, keyed to this folder — or null. */
  stashed: StashedBlock<HousingPlan> | null;
  /** True while the press is reading the plan history for the fallback. */
  turningOn: boolean;
  /** The parent's stash → history → seeded-blank decision (see HousingCard). */
  onTurnOn: () => Promise<void>;
}) {
  const stale = handWrittenHousingEvents(events);
  // "Buy whatever the sale fetches" has no equivalent in a housing plan, and
  // pinning it to a number is a real change in the risk being run — the one
  // thing about this switch that is not a straight copy.
  const floatingPrice = stale.some((e) => e.type === 'buy_house' && e.price === 'sale_proceeds');
  return (
    <div className="card">
      {/* No heading: the section header names this card. */}
      <div className="muted">
        The move is not modelled here yet. Turning it on replaces the sell / rent / buy events with
        one form: you say when you sell, how long you rent and what you buy, and the sale price,
        the purchase date, the insurance estimate and the mortgage payment all follow from that.
      </div>

      {stashed !== null && (
        <div className="field-help" style={{ marginTop: 10 }}>
          {stashOfferNote(stashed.stashedAt)}
        </div>
      )}

      {stale.length > 0 ? (
        <>
          <div className="field-help" style={{ marginTop: 10 }}>
            This plan already describes a move as{' '}
            {stale.length === 1 ? 'one event' : `${stale.length} events`}:
          </div>
          <Readout lines={stale.map(describeHousingEvent)} />
          <div className="field-help warn" style={{ marginTop: 6 }}>
            {SUPERSEDE_TEXT}{' '}
            {stashed === null
              ? 'The button below copies those events into the housing plan first, so you start ' +
                'from what you already have — but from then on the form is what the simulation ' +
                'reads, and the events are dead weight worth deleting.'
              : 'The button below restores your stashed configuration rather than copying these ' +
                'events — from then on the form is what the simulation reads, and the events are ' +
                'dead weight worth deleting.'}
          </div>
          {floatingPrice && stashed === null && (
            <div className="field-help warn" style={{ marginTop: 6 }}>
              One thing does not survive the copy. Your buy event is priced at “the sale proceeds”,
              which means buying whatever the old house happens to fetch; a housing plan states a
              price instead, because choosing the house is the decision it exists to model. The
              seeded price is the projected net proceeds — but a fixed price is a commitment the
              portfolio has to meet when the sale disappoints, so expect the success rate to fall a
              few points when you turn this on. That is the risk becoming visible, not the plan
              getting worse.
            </div>
          )}
        </>
      ) : (
        <div className="field-help" style={{ marginTop: 10 }}>
          {SUPERSEDE_TEXT} There are none in this plan right now, so nothing is lost by turning it
          on.
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={turningOn} onClick={() => void onTurnOn()}>
          {turningOn ? 'Looking for your last configuration…' : 'Model the move here'}
        </button>
      </div>
    </div>
  );
}

/** One superseded event, as a readout line. */
function describeHousingEvent(e: ScenarioEvent): { label: string; value: string } {
  switch (e.type) {
    case 'sell_house':
      return { label: 'Sell the house', value: formatMonth(e.date) };
    case 'rent':
      return {
        label: `Rent ${e.months} months at ${formatUSD(e.monthlyCost)}/mo`,
        value: formatMonth(e.start),
      };
    case 'buy_house':
      return {
        label: `Buy for ${typeof e.price === 'number' ? formatUSD(e.price) : 'the sale proceeds'} (${
          e.financing === 'cash' ? 'cash' : 'mortgage'
        })`,
        value: formatMonth(e.date),
      };
    default:
      return { label: e.type, value: '' };
  }
}
