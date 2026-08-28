/**
 * Candidate -> Scenario. A pure JSON transform, and deliberately NOT in the
 * engine.
 *
 * tests/shared/engineVersion.test.ts hashes the contents AND filenames of every
 * .ts under src/engine, so adding src/engine/search.ts would fail the pin and
 * force an ENGINE_VERSION bump — which, because the version is part of the
 * run-cache key, invalidates every cached run (currently ~113MB) and makes
 * every metric stored beside a saved scenario engine-stale. That is a fine
 * price to pay once for a real engine change. It is not a fine price to pay
 * every time somebody edits the search space, which is exactly what would
 * happen if this file lived there. So the search compiles down to the same
 * events a hand-written what-if would, using only the public Scenario contract,
 * and the engine is not modified at all.
 *
 * One consequence worth stating plainly: the spend override below duplicates
 * four lines of engine/solvers.ts's private `scenarioWithSpend`. Importing it
 * would mean exporting it, which is an edit to src/engine, which is a bump. The
 * duplication is the cheaper mistake, and this comment is the mitigation.
 */
import { sha256Hex } from '../../shared/sha256';
import type {
  AssetMix,
  GlideShape,
  HousingPlan,
  Person,
  Profile,
  Scenario,
  ScenarioEvent,
  SearchAssignment,
  SearchAxis,
  SearchDim,
  SpendingPolicy,
  SpendingPolicyLevel,
  StateCode,
  YearMonth,
} from '../../shared/types';
import { DEFAULT_GUARDRAILS } from '../../shared/types';
import { deriveExpenseStreams } from '../../shared/expenses';
import { formatUSD, parseYearMonth, stableStringify } from '../../shared/util';
import { penaltyFreeFromYear, SIM_START_YEAR } from '../../engine/household';

/*
 * Month the search retires people in.
 *
 * July matched engine/solvers.ts's sweeps, but it made the retireYear axis's
 * level for the plan's OWN year fail to be a no-op: when a plan retires in
 * June, every candidate — including the one nominally equal to that plan —
 * gained an extra month of a $180,000 salary that the baseline never had.
 * About $15k of gross, far above the $500/yr floor the report ranks against,
 * applied to every candidate and to none of the baseline. `retireMonthFor` reads the
 * plan's own month instead, so "retire in the year I already retire" compiles
 * to the plan I already have.
 */
const RETIRE_MONTH = 7;

/** The month the scenario already retires in, else the July default. */
function retireMonthFor(scenario: Scenario): number {
  for (const e of scenario.events) {
    if (e.type === 'retire') return parseYearMonth(e.date).month;
  }
  return RETIRE_MONTH;
}

/** Property tax as a share of purchase price, when a house price is searched. */
const PROPERTY_TAX_RATE_FALLBACK = 0.0056;

/** Defaults for a housing axis on a plan that has no housing plan of its own. */
const DEFAULT_RENT_MONTHS = 12;
const DEFAULT_RENT_MONTHLY = 3000;

function ym(year: number, month: number): YearMonth {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function mixFromStockShare(share: number): AssetMix {
  const stocks = Math.min(1, Math.max(0, share));
  return { stocks, bonds: 1 - stocks, bills: 0 };
}

// ---------------------------------------------------------------------------
// Reading the base plan
// ---------------------------------------------------------------------------

/** The plan's own retirement year (the earliest retire event), or undefined. */
export function baseRetireYear(scenario: Scenario): number | undefined {
  const years = scenario.events
    .filter((e): e is Extract<ScenarioEvent, { type: 'retire' }> => e.type === 'retire')
    .map((e) => parseYearMonth(e.date).year);
  return years.length > 0 ? Math.min(...years) : undefined;
}

/**
 * The mix the plan is heading for today: the last allocation_change or
 * glidepath target it carries, else the portfolio's own current weighted mix.
 * Used as the "from" end of a glidepath and as the target when glideShape is
 * searched without stockShare.
 */
export function baseTargetMix(profile: Profile, scenario: Scenario): AssetMix {
  let latest: { date: string; mix: AssetMix } | undefined;
  for (const e of scenario.events) {
    if (e.type === 'allocation_change' && (!latest || e.date > latest.date)) {
      latest = { date: e.date, mix: e.mix };
    } else if (e.type === 'glidepath' && (!latest || e.end > latest.date)) {
      latest = { date: e.end, mix: e.toMix };
    }
  }
  if (latest) return latest.mix;
  return currentPortfolioMix(profile);
}

/** Balance-weighted mix across every non-savings account. */
export function currentPortfolioMix(profile: Profile): AssetMix {
  let total = 0;
  const sum: AssetMix = { stocks: 0, bonds: 0, bills: 0 };
  for (const a of profile.accounts) {
    if (a.type === 'savings') continue;
    total += a.balance;
    sum.stocks += a.balance * a.allocation.stocks;
    sum.bonds += a.balance * a.allocation.bonds;
    sum.bills += a.balance * a.allocation.bills;
  }
  if (total <= 0) return { stocks: 1, bonds: 0, bills: 0 };
  return { stocks: sum.stocks / total, bonds: sum.bonds / total, bills: sum.bills / total };
}

/**
 * The plan's ANNUAL living spend: the scenario override if it has one, else the
 * profile's stream. This is the number the search screens against and the
 * number "success at today's spending" is measured at.
 *
 * Through `deriveExpenseStreams`, not `profile.expenses.livingMonthly`, because
 * with an itemised budget that scalar is a CACHE of the rows and can be stale:
 * scripts/transcribe-budget.ts writes `lines` and never refreshes it. prepareSim
 * derives, so reading the scalar here labelled a plan $85,200/yr while the run
 * it screened actually spent $84,000 — the search reporting one number and
 * simulating another is the exact failure this codebase keeps paying for.
 */
export function planSpendAnnual(profile: Profile, scenario: Scenario): number {
  const monthly =
    scenario.assumption_overrides?.expenses?.livingMonthly ??
    deriveExpenseStreams(profile.expenses).livingMonthly;
  return monthly * 12;
}

/**
 * A scenario whose LIVING spend is `annual` dollars a year.
 *
 * Both sides of the working/retired pair move, in proportion. engine/solvers.ts
 * sets only `livingMonthly`, which is correct for this household (its profile
 * has no separate retired figure, so the retired side inherits the working
 * one) and silently wrong for a household that has one — there, a spend sweep
 * would leave retirement spending untouched and flatten the entire curve. The
 * ratio is preserved rather than both sides being set equal, so "we plan to
 * live on 10% less once we stop" survives the probe.
 *
 * BOTH SIDES COME OFF THE DERIVATION, for the same reason planSpendAnnual does:
 * an itemised budget makes the scalars a cache, and a stale one breaks this
 * function in precisely the way it exists to prevent. A budget whose rows say
 * $8,000/mo working and $6,000 retired leaves a profile still reading 7,100 and
 * NO retired figure at all — so the `retired !== undefined` test below fails,
 * the retired side is never written, and prepareSim then falls through to the
 * budget's own $6,000. Every probe from $90k to $240k retires on the same
 * $6,000/mo, which for a 2028 retirement is 35 of 40 years the sweep does not
 * touch: the flat curve, arrived at through the one branch meant to stop it.
 */
export function withSpend(profile: Profile, scenario: Scenario, annual: number): Scenario {
  const out = structuredClone(scenario);
  const overrides = out.assumption_overrides?.expenses;
  const derived = deriveExpenseStreams(profile.expenses);
  const working = overrides?.livingMonthly ?? derived.livingMonthly;
  const retired = overrides?.livingMonthlyRetired ?? derived.livingMonthlyRetired;
  const monthly = annual / 12;
  const expenses: NonNullable<NonNullable<Scenario['assumption_overrides']>['expenses']> = {
    ...overrides,
    livingMonthly: monthly,
  };
  if (retired !== undefined && working > 0) {
    expenses.livingMonthlyRetired = monthly * (retired / working);
  }
  out.assumption_overrides = { ...out.assumption_overrides, expenses };
  return out;
}

// ---------------------------------------------------------------------------
// Applying one axis
// ---------------------------------------------------------------------------

/** Every event type a given axis owns and therefore replaces wholesale. */
function stripEvents(events: ScenarioEvent[], types: ReadonlyArray<ScenarioEvent['type']>) {
  return events.filter((e) => !types.includes(e.type));
}

function housingBase(scenario: Scenario, sellDate: YearMonth): HousingPlan {
  const existing = scenario.housing;
  return {
    sellDate,
    ...(existing?.appreciationRate !== undefined
      ? { appreciationRate: existing.appreciationRate }
      : {}),
    rentMonths: existing?.rentMonths ?? DEFAULT_RENT_MONTHS,
    rentMonthly: existing?.rentMonthly ?? DEFAULT_RENT_MONTHLY,
    purchasePrice: existing?.purchasePrice ?? 'sale_proceeds',
    // The survivor price is a statement about what the SURVIVOR would do, not about
    // which candidate house the axis is pricing — so it rides through every
    // level like appreciationRate does. Dropping it would make the widow probe
    // model the survivor executing each candidate's full price, the exact assumption
    // the field exists to correct.
    ...(existing?.survivorPurchasePrice !== undefined
      ? { survivorPurchasePrice: existing.survivorPurchasePrice }
      : {}),
    // The downsize is the same kind of statement for a death AFTER the
    // purchase — it rides through for the same reason.
    ...(existing?.survivorDownsizeTo !== undefined
      ? { survivorDownsizeTo: existing.survivorDownsizeTo }
      : {}),
    ...(existing?.survivorDownsizeDelayMonths !== undefined
      ? { survivorDownsizeDelayMonths: existing.survivorDownsizeDelayMonths }
      : {}),
    propertyTaxAnnual: existing?.propertyTaxAnnual ?? 0,
    ...(existing?.insuranceAnnual !== undefined ? { insuranceAnnual: existing.insuranceAnnual } : {}),
    financing: existing?.financing ?? { type: 'cash' },
  };
}

interface CompileCtx {
  profile: Profile;
  base: Scenario;
  axes: SearchAxis[];
}

/**
 * Apply one dimension's level to a scenario in place.
 *
 * Every axis REPLACES rather than adds: a retireYear level strips every retire
 * event before writing its own, a claimAge level strips every claim. Adding
 * would leave the base plan's own decision in place alongside the candidate's,
 * and the engine would honour whichever it saw first — a bug that would look
 * exactly like "this decision does not matter".
 */
function applyLevel(ctx: CompileCtx, out: Scenario, axis: SearchAxis, levelIndex: number): void {
  const { profile } = ctx;
  switch (axis.dim) {
    case 'retireYear': {
      const year = axis.levels[levelIndex];
      out.events = stripEvents(out.events, ['retire']);
      for (const p of profile.people) {
        out.events.push({ type: 'retire', person: p.id, date: ym(year, retireMonthFor(ctx.base)) });
      }
      return;
    }
    case 'autoSepp': {
      out.autoSepp = axis.levels[levelIndex];
      return;
    }
    case 'stockShare':
    case 'glideShape': {
      // Handled together below: the mix and the path to it are one decision and
      // writing them independently would emit two conflicting allocation events.
      return;
    }
    case 'housePrice':
    case 'financing':
    case 'moveOffsetYears': {
      // Likewise: one HousingPlan, written once from all three axes.
      return;
    }
    case 'claimAge': {
      const age = axis.levels[levelIndex];
      const p1 = profile.people[0];
      // The household claims on ONE date: person 2's benefit here is purely
      // spousal and gated by person 1's filing (SPEC 9.5), which is why the
      // axis is an age and not a date per person.
      const abs = p1.birthYear * 12 + (p1.birthMonth - 1) + age * 12;
      const date = ym(Math.floor(abs / 12), (abs % 12) + 1);
      out.events = stripEvents(out.events, ['claim_social_security']);
      for (const p of profile.people) {
        out.events.push({ type: 'claim_social_security', person: p.id, date });
      }
      return;
    }
    case 'givingRule': {
      out.assumption_overrides = {
        ...out.assumption_overrides,
        expenses: {
          ...out.assumption_overrides?.expenses,
          retirementGiving: structuredClone(axis.levels[levelIndex]),
        },
      };
      return;
    }
    case 'rothConversion': {
      const level = axis.levels[levelIndex];
      out.events = stripEvents(out.events, ['roth_conversion']);
      if (level !== 'none') {
        out.events.push({ type: 'roth_conversion', yearly: true, toBracketTop: level });
      }
      return;
    }
    case 'state': {
      const state: StateCode = axis.levels[levelIndex];
      out.events = stripEvents(out.events, ['state_change']);
      if (state !== profile.filing.state) {
        // The move happens when the house does, else at the start of the run —
        // a state change with no move is "we relocate now", which is the only
        // sensible reading when nothing else in the plan dates it.
        const date = out.housing?.sellDate ?? ym(SIM_START_YEAR, RETIRE_MONTH);
        out.events.push({ type: 'state_change', date, state });
      }
      return;
    }
    case 'spendingPolicy': {
      const level: SpendingPolicyLevel = axis.levels[levelIndex];
      /*
       * A guardrails level rides on the OWNER's configured band, written out
       * in full. The level itself carries no parameters — the decision
       * searched is "rails or no rails", never "which rails". The engine would
       * in fact reach the same band from a bare {type:'guardrails'}: overrides
       * deep-merge key-wise onto profile settings (events.ts), and simulate.ts
       * falls back to DEFAULT_GUARDRAILS only when no band survives the merge.
       * But the candidate must not lean on merge semantics to mean what it
       * means: writing the band explicitly (profile's, else the defaults)
       * makes the plan self-describing — the report shows WHICH rails it ran —
       * and gives canonicalise a deterministic shape to weigh against the
       * incumbent.
       */
      const spendingPolicy: SpendingPolicy =
        level.type === 'guardrails'
          ? {
              type: 'guardrails',
              guardrails: structuredClone(
                profile.settings.spendingPolicy.guardrails ?? DEFAULT_GUARDRAILS,
              ),
            }
          : { type: 'fixed_real' };
      out.assumption_overrides = {
        ...out.assumption_overrides,
        settings: {
          ...out.assumption_overrides?.settings,
          spendingPolicy,
        },
      };
      return;
    }
  }
}

/** Allocation: stockShare + glideShape are one decision, so they compile together. */
function applyAllocation(ctx: CompileCtx, out: Scenario, assignment: SearchAssignment): void {
  const shareAxis = ctx.axes.find((a) => a.dim === 'stockShare');
  const shapeAxis = ctx.axes.find((a) => a.dim === 'glideShape');
  const shareIdx = assignment.stockShare;
  const shapeIdx = assignment.glideShape;
  const hasShare = shareAxis?.dim === 'stockShare' && shareIdx !== undefined;
  const hasShape = shapeAxis?.dim === 'glideShape' && shapeIdx !== undefined;
  if (!hasShare && !hasShape) return;

  const target: AssetMix = hasShare
    ? mixFromStockShare((shareAxis as Extract<SearchAxis, { dim: 'stockShare' }>).levels[shareIdx])
    : baseTargetMix(ctx.profile, ctx.base);
  const shape: GlideShape = hasShape
    ? (shapeAxis as Extract<SearchAxis, { dim: 'glideShape' }>).levels[shapeIdx]
    : 'step_now';

  const retireYear = baseRetireYear(out) ?? SIM_START_YEAR;
  const retireDate = out.events
    .filter((e): e is Extract<ScenarioEvent, { type: 'retire' }> => e.type === 'retire')
    .map((e) => e.date)
    .sort()[0] ?? ym(SIM_START_YEAR, RETIRE_MONTH);

  out.events = stripEvents(out.events, ['allocation_change', 'glidepath']);
  const from = currentPortfolioMix(ctx.profile);

  switch (shape) {
    case 'step_now':
      out.events.push({ type: 'allocation_change', date: ym(SIM_START_YEAR, 6), mix: target });
      return;
    case 'step_at_retirement':
      out.events.push({ type: 'allocation_change', date: retireDate, mix: target });
      return;
    case 'glide_to_target':
      out.events.push({
        type: 'glidepath',
        start: retireDate,
        end: ym(retireYear + 5, parseYearMonth(retireDate).month),
        fromMix: from,
        toMix: target,
      });
      return;
    case 'rising_equity': {
      // The rising-equity glidepath: start AT the target and climb 20 points of
      // stock over ten years. It is in the space because it is a real published
      // idea (a rising equity path defends against sequence risk early), and
      // because the user already asked the question once.
      const up = mixFromStockShare(Math.min(1, target.stocks + 0.2));
      out.events.push({
        type: 'glidepath',
        start: retireDate,
        end: ym(retireYear + 10, parseYearMonth(retireDate).month),
        fromMix: target,
        toMix: up,
      });
      return;
    }
  }
}

/** Housing: price, financing and timing are one HousingPlan, written once. */
function applyHousing(ctx: CompileCtx, out: Scenario, assignment: SearchAssignment): void {
  const priceAxis = ctx.axes.find((a) => a.dim === 'housePrice');
  const finAxis = ctx.axes.find((a) => a.dim === 'financing');
  const offsetAxis = ctx.axes.find((a) => a.dim === 'moveOffsetYears');
  const priceIdx = assignment.housePrice;
  const finIdx = assignment.financing;
  const offsetIdx = assignment.moveOffsetYears;
  const touches =
    (priceAxis && priceIdx !== undefined) ||
    (finAxis && finIdx !== undefined) ||
    (offsetAxis && offsetIdx !== undefined);
  if (!touches) return;

  const retireYear = baseRetireYear(out) ?? SIM_START_YEAR;
  const baseSellMonth = ctx.base.housing
    ? parseYearMonth(ctx.base.housing.sellDate).month
    : RETIRE_MONTH;

  /*
   * The sell date only moves when moveOffsetYears is ACTUALLY being searched.
   *
   * It used to be recomputed as retireYear + offset whenever any of the three
   * housing axes fired, with offset inferred from the base plan and clamped at
   * zero. On the user's own plan — sell June 2027, retire June 2028 — that
   * inference is -1, the clamp turns it into 0, and searching nothing but
   * PRICE silently pushed the sale a year later on every candidate while
   * leaving the baseline where it was. Every price comparison then carried a
   * year of housing timing it never asked about, in the same direction for all
   * of them, so nothing in the report would have looked wrong.
   *
   * A plan that sells before it retires is perfectly ordinary and the clamp
   * cannot represent it. So: no offset axis, no re-dating.
   */
  const searchingOffset = offsetAxis?.dim === 'moveOffsetYears' && offsetIdx !== undefined;
  const sellDate = searchingOffset
    ? ym(retireYear + offsetAxis.levels[offsetIdx], baseSellMonth)
    : (ctx.base.housing?.sellDate ?? ym(retireYear, baseSellMonth));

  const plan = housingBase(ctx.base, sellDate);

  if (priceAxis?.dim === 'housePrice' && priceIdx !== undefined) {
    const price = priceAxis.levels[priceIdx];
    plan.purchasePrice = price;
    /*
     * Insurance is dropped for EVERY level, not just the numeric ones, so all
     * of them share one basis: the engine's price-based estimator (which reads
     * projected net proceeds for 'sale_proceeds' and returns zero for 'none').
     * Dropping it only for numeric prices left the base plan's explicit figure
     * standing on the other levels, so a single axis compared an estimated
     * premium against a hand-entered one and charged the difference to the
     * price decision.
     */
    delete plan.insuranceAnnual;
    if (typeof price === 'number') {
      // Property tax scales with the house. Holding the base plan's figure
      // across a $900k and a $1.5M purchase would price a decision the search
      // is trying to measure into a constant, and the difference is real money
      // every year for thirty years.
      const baseRate =
        ctx.base.housing && typeof ctx.base.housing.purchasePrice === 'number' &&
        ctx.base.housing.purchasePrice > 0
          ? ctx.base.housing.propertyTaxAnnual / ctx.base.housing.purchasePrice
          : PROPERTY_TAX_RATE_FALLBACK;
      plan.propertyTaxAnnual = Math.round((price * baseRate) / 50) * 50;
    }
  }

  if (finAxis?.dim === 'financing' && finIdx !== undefined) {
    /*
     * payoffAfterYears rides through the axis the way survivorPurchasePrice
     * rides through housingBase: it is a statement about how the household
     * retires the loan, not about which financing level is being priced, so a
     * base plan that schedules a payoff keeps it on every MORTGAGE level —
     * dropping it would make the axis's "mortgage" a different loan from the
     * incumbent's and charge the difference to the financing decision. The
     * CASH level drops it with the rest of the mortgage fields: no loan, no
     * payoff, and an inert field would fragment the cache key over a knob
     * that cannot act (the same reason canonicalise() strips the survivor
     * price from a 'none' purchase).
     */
    const basePayoff =
      ctx.base.housing?.financing.type === 'mortgage'
        ? ctx.base.housing.financing.payoffAfterYears
        : undefined;
    plan.financing =
      finAxis.levels[finIdx] === 'cash'
        ? { type: 'cash' }
        : {
            type: 'mortgage',
            downPct: 0.2,
            ...(basePayoff !== undefined ? { payoffAfterYears: basePayoff } : {}),
          };
  }

  out.housing = plan;
  // A housing PLAN supersedes hand-written move events anyway (the engine drops
  // them), but leaving them in the scenario would change its hash without
  // changing its meaning — a guaranteed cache miss for an identical plan.
  out.events = stripEvents(out.events, ['sell_house', 'rent', 'buy_house']);
}

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

/**
 * The order events are emitted in. stableStringify sorts object keys but NOT
 * array elements, so two logically identical plans whose events came out in
 * different orders hash differently: a guaranteed cache miss plus a duplicate
 * ~472KB file on disk. Sorting by (type, date) makes emission order irrelevant.
 */
function eventSortKey(e: ScenarioEvent): string {
  const date = 'date' in e && typeof e.date === 'string' ? e.date : 'start' in e ? e.start : '';
  const person = 'person' in e && typeof e.person === 'string' ? e.person : '';
  return `${e.type}|${date}|${person}`;
}

export function sortEvents(events: ScenarioEvent[]): ScenarioEvent[] {
  return [...events].sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
}

/**
 * The policy the engine would run under this override: assumption overrides
 * deep-merge onto profile settings key-wise. Mirrors the private merge in
 * engine/events.ts for this ONE object — exporting the engine's own would be
 * an engine edit and a version bump (see the header comment); the same
 * duplication bargain as the spend override.
 */
function mergedSpendingPolicy(base: SpendingPolicy, override: SpendingPolicy): SpendingPolicy {
  const percent = override.percent ?? base.percent;
  const guardrails =
    override.guardrails === undefined
      ? base.guardrails
      : base.guardrails === undefined
        ? override.guardrails
        : { ...base.guardrails, ...override.guardrails };
  return {
    type: override.type,
    ...(percent !== undefined ? { percent } : {}),
    ...(guardrails !== undefined ? { guardrails } : {}),
  };
}

/**
 * A key that is equal exactly when the ENGINE would behave the same: only the
 * fields the policy type actually reads, with the engine's own defaults
 * applied (band and floor fall back to DEFAULT_GUARDRAILS — simulate.ts reads
 * them with the same ?? chain). A byte-compare instead would keep overrides
 * that differ only in fields nothing reads, and the cache would run one plan
 * twice.
 */
function engineSpendingPolicyKey(policy: SpendingPolicy): string {
  if (policy.type === 'guardrails') {
    const band = policy.guardrails ?? DEFAULT_GUARDRAILS;
    return stableStringify({
      type: 'guardrails',
      upper: band.upper,
      lower: band.lower,
      adjustment: band.adjustment,
      floorFraction: band.floorFraction ?? DEFAULT_GUARDRAILS.floorFraction,
      // No default here, unlike the floor: the engine reads an absent ceiling
      // as "uncapped" via its own undefined check, so absent and every number
      // are DIFFERENT simulations. Left out of this key, an override that
      // only added raiseCeiling compared equal to the uncapped incumbent and
      // canonicalise() silently searched the wrong plan.
      ...(band.raiseCeiling !== undefined ? { raiseCeiling: band.raiseCeiling } : {}),
    });
  }
  if (policy.type === 'fixed_percent') {
    return stableStringify({ type: 'fixed_percent', percent: policy.percent });
  }
  return stableStringify({ type: 'fixed_real' });
}

/**
 * Strip every field that cannot act, so two candidates that differ only in a
 * knob with no effect become ONE plan.
 *
 * This is not tidiness, it is a third of the compute budget. The space is not a
 * clean cartesian product:
 *   - autoSepp is inert once every retirement lands in a penalty-free year;
 *   - financing, property tax and insurance are inert when nothing is bought;
 *   - a glidepath from a mix to itself is inert.
 * Byte-different scenarios that are numerically identical hash to different
 * runKeys, so runManager's cache will NOT dedupe them and the engine runs the
 * same simulation twice. Canonicalising first typically collapses 15-30% of a
 * space like this one.
 *
 * It also lets the report say the true thing — "72(t) on or off is the same
 * plan once you retire in 2031; the question does not arise" — instead of
 * reporting a spurious near-zero effect averaged over cells where the knob was
 * physically incapable of doing anything.
 *
 * The engine's own hashing is deliberately NOT changed to do this: that would
 * be an engine edit for no benefit and a version bump.
 */
export function canonicalise(profile: Profile, scenario: Scenario): Scenario {
  const out = structuredClone(scenario);

  // A solver would make runSolver recurse over the candidate. Never.
  delete out.solver;
  // The name is display-only and would otherwise fragment the cache.
  out.name = 'candidate';
  delete out.description;

  if (out.autoSepp === true) {
    // The engine tests `autoSepp !== false`, so `true` and absent are the same
    // plan in every case — not merely when the election is inert. Left alone,
    // an autoSepp axis would give the incumbent a second runKey, evaluate it
    // twice, and let it "beat" itself by a delta of exactly zero.
    delete out.autoSepp;
  } else if (out.autoSepp === false) {
    const retires = out.events.filter(
      (e): e is Extract<ScenarioEvent, { type: 'retire' }> => e.type === 'retire',
    );
    const anyEarly = retires.some((e) => {
      const person = profile.people.find((p) => p.id === e.person);
      if (!person) return true;
      return parseYearMonth(e.date).year < penaltyFreeFromYear(person);
    });
    const hasExplicit = out.events.some((e) => e.type === 'start_72t');
    // An explicit start_72t always wins, so the automatic flag cannot act then
    // either. Dropping it here is what makes `false` and absent one plan.
    if (!anyEarly || hasExplicit) delete out.autoSepp;
  }

  /*
   * A spending-policy override that says what the plan would do anyway is the
   * same incumbent-duplicate trap the autoSepp flag had: a guardrails level on
   * a profile ALREADY running guardrails with that band is byte-different from
   * "no level at all" but numerically identical, so the incumbent would get a
   * second runKey, be evaluated twice, and beat itself by exactly zero.
   * Compared through the ENGINE's eyes — the override deep-merges onto the
   * profile policy, band and floor default to DEFAULT_GUARDRAILS, and fields
   * the policy type ignores (a fixed_percent `percent` under fixed_real) do
   * not count — so equality here is "the simulation cannot differ".
   */
  const overrides = out.assumption_overrides;
  const settingsOverride = overrides?.settings;
  const policyOverride = settingsOverride?.spendingPolicy;
  if (
    overrides &&
    settingsOverride &&
    policyOverride &&
    engineSpendingPolicyKey(mergedSpendingPolicy(profile.settings.spendingPolicy, policyOverride)) ===
      engineSpendingPolicyKey(profile.settings.spendingPolicy)
  ) {
    delete settingsOverride.spendingPolicy;
    // Empty shells left behind would still fragment the hash against a base
    // plan that never had overrides at all.
    if (Object.keys(settingsOverride).length === 0) delete overrides.settings;
    if (Object.keys(overrides).length === 0) delete out.assumption_overrides;
  }

  if (out.housing) {
    const h = out.housing;
    if (h.purchasePrice === 'none') {
      h.propertyTaxAnnual = 0;
      delete h.insuranceAnnual;
      h.financing = { type: 'cash' };
      // No purchase means no survivor re-pricing either (the engine ignores
      // it); left in, it would fragment the cache key over an inert field.
      delete h.survivorPurchasePrice;
      // Nothing bought, nothing to downsize — the same inert-field rule.
      delete h.survivorDownsizeTo;
      delete h.survivorDownsizeDelayMonths;
    }
    if (h.rentMonths === 0) {
      // Rent is inert with no rental period; the rate must not fragment the key.
      h.rentMonthly = 0;
    }
    if (h.survivorDownsizeTo === undefined) {
      // A delay with no downsize is inert (the engine reads it only beside
      // survivorDownsizeTo); left in, it would fragment the cache key.
      delete h.survivorDownsizeDelayMonths;
    }
  }

  out.events = sortEvents(
    out.events.filter((e) => {
      // A glidepath from a mix to itself is an allocation_change with extra
      // steps and no effect on any number.
      if (e.type === 'glidepath') {
        const same =
          Math.abs(e.fromMix.stocks - e.toMix.stocks) < 1e-9 &&
          Math.abs(e.fromMix.bonds - e.toMix.bonds) < 1e-9 &&
          Math.abs(e.fromMix.bills - e.toMix.bills) < 1e-9;
        if (same) return false;
      }
      return true;
    }),
  );

  return out;
}

/** sha256 of the EFFECTIVE plan. Equal hashes are one plan, whatever the labels. */
export function planHash(scenario: Scenario): string {
  return sha256Hex(stableStringify(scenario)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * A point in the space, compiled to a canonical Scenario.
 *
 * A dimension ABSENT from `assignment` means "leave the base plan's own
 * setting" — which is what makes the revert-one-knob attribution honest: the
 * search never has to guess which level the incumbent is on, it simply declines
 * to write that axis.
 */
export function compileCandidate(
  profile: Profile,
  base: Scenario,
  axes: SearchAxis[],
  assignment: SearchAssignment,
): Scenario {
  const ctx: CompileCtx = { profile, base, axes };
  const out = structuredClone(base);
  // Retirement first: housing timing and the allocation glide both anchor to it.
  const ordered = [...axes].sort((a, b) => (a.dim === 'retireYear' ? -1 : b.dim === 'retireYear' ? 1 : 0));
  for (const axis of ordered) {
    const idx = assignment[axis.dim];
    if (idx === undefined) continue;
    applyLevel(ctx, out, axis, idx);
  }
  applyAllocation(ctx, out, assignment);
  applyHousing(ctx, out, assignment);
  return canonicalise(profile, out);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const DIM_LABELS: Record<SearchDim, string> = {
  retireYear: 'retirement year',
  autoSepp: '72(t) bridge',
  stockShare: 'stock share',
  glideShape: 'allocation path',
  housePrice: 'house price',
  financing: 'financing',
  moveOffsetYears: 'move timing',
  claimAge: 'claiming age',
  givingRule: 'giving rule',
  rothConversion: 'Roth conversions',
  state: 'state',
  spendingPolicy: 'spending policy',
};

export function dimLabel(dim: SearchDim): string {
  return DIM_LABELS[dim];
}

const GLIDE_LABELS: Record<GlideShape, string> = {
  step_now: 'switch now',
  step_at_retirement: 'switch at retirement',
  glide_to_target: '5-year glide from retirement',
  rising_equity: 'rising equity over 10 years',
};

/** One level, in English. */
export function levelLabel(axis: SearchAxis, index: number): string {
  switch (axis.dim) {
    case 'retireYear':
      return `retire ${axis.levels[index]}`;
    case 'autoSepp':
      return axis.levels[index] ? '72(t) on' : '72(t) off';
    case 'stockShare': {
      const s = Math.round(axis.levels[index] * 100);
      return `${s}/${100 - s}`;
    }
    case 'glideShape':
      return GLIDE_LABELS[axis.levels[index]];
    case 'housePrice': {
      const v = axis.levels[index];
      if (v === 'none') return 'rent for good';
      if (v === 'sale_proceeds') return 'buy with whatever the sale leaves';
      return `${formatUSD(v)} house`;
    }
    case 'financing':
      return axis.levels[index] === 'cash' ? 'cash' : '20% down mortgage';
    case 'moveOffsetYears': {
      const y = axis.levels[index];
      return y === 0 ? 'sell at retirement' : `sell ${y}y after retirement`;
    }
    case 'claimAge':
      return `claim at ${axis.levels[index]}`;
    case 'givingRule': {
      const g = axis.levels[index];
      switch (g.type) {
        case 'continue':
          return 'keep giving as now';
        case 'none':
          return 'stop giving at retirement';
        case 'amount':
          return `give ${formatUSD(g.monthly)}/mo`;
        case 'percent_of_growth':
          return `give ${Math.round(g.percent * 100)}% of growth${
            g.smoothingYears ? `, smoothed ${g.smoothingYears}y` : ''
          }`;
        case 'percent_of_income':
          return `give ${Math.round(g.percent * 100)}% of income`;
        case 'tithe_account':
          return `tithe account ${Math.round(g.percent * 100)}%, defer ${g.deferYears}y`;
      }
      return 'giving rule';
    }
    case 'rothConversion': {
      const v = axis.levels[index];
      return v === 'none' ? 'no Roth conversions' : `convert to top of ${Math.round(v * 100)}%`;
    }
    case 'state':
      return `live in ${axis.levels[index].toUpperCase()}`;
    case 'spendingPolicy':
      // Honest names: the old percent label called a fixed_percent level
      // "guardrails", which is the policy it precisely was not.
      return axis.levels[index].type === 'fixed_real'
        ? 'fixed real spending'
        : 'guardrails spending';
  }
}

/** The whole point in the space, in English, as the leaderboard shows it. */
export function describeAssignment(axes: SearchAxis[], assignment: SearchAssignment): string {
  const parts: string[] = [];
  for (const axis of axes) {
    const idx = assignment[axis.dim];
    if (idx === undefined) continue;
    parts.push(levelLabel(axis, idx));
  }
  return parts.length > 0 ? parts.join(' - ') : 'your plan as it stands';
}

/** The chosen level VALUE per dimension — self-describing, for the report. */
export function assignmentValues(
  axes: SearchAxis[],
  assignment: SearchAssignment,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const axis of axes) {
    const idx = assignment[axis.dim];
    if (idx === undefined) continue;
    out[axis.dim] = axis.levels[idx];
  }
  return out;
}

/** Stable hash of the space itself, so two searches over it are linkable. */
export function spaceHash(base: Scenario, axes: SearchAxis[]): string {
  return sha256Hex(
    stableStringify({ base, axes: [...axes].sort((a, b) => a.dim.localeCompare(b.dim)) }),
  ).slice(0, 16);
}

/** Penalty-free year per person, for callers that need the inert-level rule. */
export function penaltyFreeYearByPerson(people: readonly Person[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of people) out[p.id] = penaltyFreeFromYear(p);
  return out;
}
