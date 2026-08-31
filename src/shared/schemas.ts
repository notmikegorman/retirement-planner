/**
 * Zod validation for everything loaded from the data folder.
 * Malformed input must produce helpful errors, never crashes (SPEC §2).
 */
import { z } from 'zod';
import type { Profile, Scenario } from './types';

const yearMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected "YYYY-MM"');

const assetMix = z
  .object({
    stocks: z.number().min(0).max(1),
    bonds: z.number().min(0).max(1),
    bills: z.number().min(0).max(1),
  })
  .refine(
    (m) => Math.abs(m.stocks + m.bonds + m.bills - 1) < 1e-6,
    'allocation weights must sum to 1',
  );

const stateCode = z.enum(['va', 'sc', 'nc']);

export const personSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  birthYear: z.number().int().min(1900).max(2010),
  birthMonth: z.number().int().min(1).max(12),
  /** SSA statement figure (assumes continued earnings through 62). */
  piaMonthlyAtFraIfWorkingTo62: z.number().min(0),
  /** ssa.gov estimate with $0 future earnings. */
  piaMonthlyAtFraIfStoppingNow: z.number().min(0),
  hasOwnBenefit: z.boolean(),
  notes: z.string().optional(),
});

/** Account types allowed to be owned jointly (retirement accounts are individually owned by law). */
const JOINT_OWNABLE_TYPES = new Set(['taxable_brokerage', 'savings']);

/**
 * A ticker as the quote source spells it: uppercase letters and digits plus
 * the three separators real symbols use (BRK.B's dot, ^GSPC's caret, BF-B's
 * dash), at most 10 characters. Lowercase is REJECTED rather than folded —
 * the schema validates what is stored, and quotes.json is keyed by the exact
 * string, so "vti" and "VTI" passing as the same symbol would be two cache
 * entries for one fund. The UI uppercases on commit instead.
 */
const SYMBOL_RE = /^[A-Z0-9.^-]{1,10}$/;
const symbolSchema = z
  .string()
  .regex(SYMBOL_RE, 'expected a ticker symbol (uppercase letters/digits/.^-, at most 10 chars)');

/**
 * One holdings-mode position. Quantity must be strictly positive — a zero-share
 * row is a deleted position wearing a row, and a negative one is a short the
 * model does not price — but fractional is fine (funds settle in thousandths).
 */
const holdingSchema = z.strictObject({
  symbol: symbolSchema,
  quantity: z.number().positive().finite(),
  assetClass: z.enum(['stocks', 'bonds', 'bills']),
});

export const accountSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['traditional_ira', 'roth_ira', 'taxable_brokerage', 'savings', '401k']),
    /** Person id, or 'joint' (taxable_brokerage/savings only). */
    owner: z.string().min(1),
    balance: z.number().min(0),
    costBasis: z.number().min(0).optional(),
    /**
     * Retirement accounts only: lifetime dollars contributed (never the growth
     * on them). Absent means UNKNOWN — the 'tithe_account' giving rule then
     * treats this account's untithed base as 0 and flags the year. Not capped
     * at `balance`: a lifetime of contributions can legitimately exceed a
     * balance that a bad decade or a decade of withdrawals shrank.
     */
    lifetimeContributions: z.number().min(0).optional(),
    allocation: assetMix,
    /**
     * Holdings mode: positions the server prices from stored quotes, deriving
     * balance and allocation. Absent = a manual account, exactly as before.
     * An EMPTY list is legal beside cash (an account that is all sweep money);
     * balance/allocation stay required either way — they are the resolved
     * cache the engine reads, overwritten at every resolution point.
     */
    holdings: z.array(holdingSchema).max(100).optional(),
    /** Uninvested dollars beside the positions; counted as bills. */
    cash: z.number().min(0).optional(),
    currentEmployer: z.boolean().optional(),
    /** @deprecated Ignored (401(k)→IRA rollover at separation is modeled); kept so old files parse. */
    ruleOf55Eligible: z.boolean().optional(),
    /** @deprecated Ignored; kept so old files parse. */
    allowsPartialWithdrawals: z.boolean().nullable().optional(),
    targetDateFund: z.object({ targetYear: z.number().int().min(1990).max(2100) }).optional(),
    rothBasis: z
      .object({
        contributions: z.number().min(0),
        conversions: z.array(z.object({ year: z.number().int(), amount: z.number().min(0) })),
      })
      .optional(),
    notes: z.string().optional(),
  })
  .refine((a) => a.owner !== 'joint' || JOINT_OWNABLE_TYPES.has(a.type), {
    path: ['owner'],
    message:
      "owner 'joint' is only allowed for taxable_brokerage and savings accounts — retirement accounts are individually owned by law",
  })
  .refine((a) => a.cash === undefined || a.holdings !== undefined, {
    path: ['cash'],
    // On a manual account the balance already includes any cash; a second
    // cash figure would be a number nothing reads, which is worse than an
    // error — it looks recorded.
    message: 'cash is only meaningful on a holdings-mode account (add holdings, or fold it into balance)',
  });

/**
 * Ceiling on any monthly-dollars field: high enough that no plausible
 * household hits it, low enough to catch an annual figure pasted into a
 * monthly box only if it is absurd. Shared by the profile's streams, the
 * scenario overrides, and the 'amount' giving rule so they cannot drift apart.
 */
const MAX_MONTHLY = 1_000_000;

/** A monthly-dollars figure in today's dollars: non-negative, sanity-capped. */
const monthlyDollars = z.number().min(0).max(MAX_MONTHLY);

/**
 * Ceiling on the Tithe Account's defer window. A plan that accumulates for
 * fifty years never gives anything away in the user's lifetime, which is not
 * what the rule is for; 30 is longer than any realistic "give it later"
 * intention and still leaves the schema catching a year pasted in as a date.
 */
const MAX_TITHE_DEFER_YEARS = 30;

/**
 * Ceiling on the pot's payout window, the same 30 as the defer cap and for the
 * same reason: a distribution stretched over half a century is "never give it"
 * wearing a schedule, and the bound still catches a year pasted in as a date.
 * The floor is 1 — a 0 would mean "distribute over no years", which is either
 * "instantly" or "never" depending on who reads it, so the schema refuses it.
 */
const MAX_TITHE_DISTRIBUTE_YEARS = 30;

/**
 * Ceiling on a life-insurance face amount: $100,000,000. High enough that no
 * household this planner is for could hit it, low enough to catch a premium
 * pasted into the benefit box or a stray extra zero on a policy that is
 * supposed to be the difference between a 64% widow score and a 91% one.
 */
const MAX_DEATH_BENEFIT = 100_000_000;

/**
 * Giving-in-retirement rule (ProfileExpenses.retirementGiving). Strict on
 * every variant: a typo'd key must fail loudly rather than silently leave the
 * household on the default rule. Bounds:
 * - percent: 0..1 (a decimal fraction, not a percentage — 0.1 = 10%)
 * - smoothingYears: integer 1..10
 * - capMonthly: >= 0, in today's dollars
 * - monthly ('amount'): >= 0, in today's dollars, same ceiling as the streams
 * - deferYears ('tithe_account'): integer 0..MAX_TITHE_DEFER_YEARS
 * - distributeYears ('tithe_account'): integer 1..MAX_TITHE_DISTRIBUTE_YEARS,
 *   optional (absent = DEFAULT_TITHE_DISTRIBUTE_YEARS)
 * - earlyRelease ('tithe_account'): optional boolean (absent = true)
 */
const retirementGivingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('continue') }),
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ type: z.literal('amount'), monthly: monthlyDollars }),
  z.strictObject({
    type: z.literal('percent_of_growth'),
    percent: z.number().min(0).max(1),
    smoothingYears: z.number().int().min(1).max(10).optional(),
    capMonthly: z.number().min(0).optional(),
  }),
  z.strictObject({
    type: z.literal('percent_of_income'),
    percent: z.number().min(0).max(1),
  }),
  /**
   * LEGACY. The bundled tithe-account rule stays ACCEPTED so every file
   * written before the two-knob split still parses, but it is normalised into
   * ongoing + `untithedPot` at load (dataStore migrations; prepareSim as the
   * engine-boundary net) and never governs a simulation year.
   */
  z.strictObject({
    type: z.literal('tithe_account'),
    percent: z.number().min(0).max(1),
    deferYears: z.number().int().min(0).max(MAX_TITHE_DEFER_YEARS),
    seedFromExistingGains: z.boolean(),
    /** Absent = DEFAULT_TITHE_DISTRIBUTE_YEARS (10). */
    distributeYears: z.number().int().min(1).max(MAX_TITHE_DISTRIBUTE_YEARS).optional(),
    /** Absent = TRUE (the safe-zone release matches the deferral's purpose). */
    earlyRelease: z.boolean().optional(),
    /** Absent = the parent IRA's mix (see the type's doc comment). */
    allocation: assetMix.optional(),
  }),
]);

/**
 * The un-tithed pot (ProfileExpenses.untithedPot / the expenses override) —
 * the pot half of the old bundled rule, now its own knob. Strict on both
 * members for the same reason the giving rule is: a typo'd key must fail
 * loudly rather than silently leave the pot on defaults. Bounds carry over
 * from the bundle field for field: `holdYears` IS the old `deferYears`
 * (0..30), `distributeYears` keeps its 1..30, `percent` its 0..1.
 *
 * The `{ enabled: false }` member is the EXPLICIT "no pot": on a scenario
 * override an absent pot inherits the profile's, so suppressing an inherited
 * pot needs a spelling of its own — it is what the migration writes into every
 * pre-split override that used to suppress the pot by replacing the whole
 * bundled rule.
 */
const untithedPotSchema = z.union([
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true).optional(),
    /** Seed share of the never-tithed gains. Absent = 0.10 (the tithe). */
    percent: z.number().min(0).max(1).optional(),
    holdYears: z.number().int().min(0).max(MAX_TITHE_DEFER_YEARS),
    /** Absent = DEFAULT_TITHE_DISTRIBUTE_YEARS (10). */
    distributeYears: z.number().int().min(1).max(MAX_TITHE_DISTRIBUTE_YEARS).optional(),
    /** Absent = TRUE (the safe-zone release matches the hold's purpose). */
    earlyRelease: z.boolean().optional(),
    /** Absent = 'accrue_to_pot' (the bundled behaviour, so migration can omit it). */
    ongoingDuringHold: z.enum(['accrue_to_pot', 'give_cash']).optional(),
    /** Absent = TRUE (the one-time catch-up is the pot's purpose). */
    seedFromGains: z.boolean().optional(),
    /** Absent = the parent IRA's mix. */
    allocation: assetMix.optional(),
  }),
]);

const mortgageSchema = z.object({
  originalPrincipal: z.number().min(0),
  balance: z.number().min(0),
  rate: z.number().min(0).max(0.25),
  termYears: z.number().int().min(1).max(50),
  startYear: z.number().int(),
  startMonth: z.number().int().min(1).max(12),
});

/**
 * One transcribed budget line. `monthlyRetired` and `monthlySurvivor` are
 * optional because ABSENT CARRIES MEANING — "same as the state before it" —
 * and writing the inherited number in would make a deliberate choice
 * indistinguishable from an untouched default.
 */
const expenseLineSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  category: z.enum([
    'living',
    'charitable',
    'investing',
    'insurance',
    'modeled_elsewhere',
    'excluded',
  ]),
  monthlyNow: monthlyDollars,
  monthlyRetired: monthlyDollars.optional(),
  /** While between homes (sold, renting, purchase pending). Absent = in-force figure. */
  monthlyRenting: monthlyDollars.optional(),
  monthlySurvivor: monthlyDollars.optional(),
  note: z.string().max(500).optional(),
});

const lifeInsurancePolicySchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  insured: z.string().min(1),
  premiumMonthly: monthlyDollars,
  deathBenefit: z.number().min(0).max(MAX_DEATH_BENEFIT),
  termEnd: yearMonth.optional(),
  termStart: yearMonth.optional(),
  cancelAtRetirement: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

export const profileSchema: z.ZodType<Profile> = z.object({
  people: z.array(personSchema).min(1).max(2),
  /**
   * The PROFILE's status is the household's own, and for a couple that is
   * 'mfj'. 'single' is accepted so a genuinely single household can use the
   * planner, but note that a survivor does NOT get here: a widow's single
   * status comes from a `death` event and is resolved per YEAR by the engine
   * (the year of death is still a joint return), not by editing this field.
   */
  filing: z.object({ status: z.enum(['mfj', 'single']), state: stateCode }),
  accounts: z.array(accountSchema),
  home: z.object({
    value: z.number().min(0),
    costBasis: z.number().min(0),
    state: stateCode,
    propertyTaxAnnual: z.number().min(0),
    insuranceAnnual: z.number().min(0),
    maintenancePctOfValue: z.number().min(0).max(0.2),
    sellingCostPct: z.number().min(0).max(0.2),
    mortgage: mortgageSchema.nullable().optional(),
  }),
  income: z.object({
    salaries: z.record(z.string(), z.number().min(0)),
    contribution401k: z.number().min(0),
    employerMatch401k: z.number().min(0),
    /** Retired-side income stream, $/month in today's dollars. Absent = 0. */
    retirementMonthly: monthlyDollars.optional(),
    /** Absent = true (ordinary income); false = spendable cash outside AGI. */
    /** Parsed but ignored since 2026-08-31: always ordinary income. */
    retirementIncomeTaxable: z.boolean().optional(),
  }),
  expenses: z.object({
    livingMonthly: z.number().min(0),
    /** Absent = the same as livingMonthly (living costs do not stop with the salary). */
    livingMonthlyRetired: monthlyDollars.optional(),
    charitableMonthly: z.number().min(0),
    investingMonthly: z.number().min(0),
    /** Parsed but ignored since 2026-08-31: investing stops at retirement. */
    investingMonthlyRetired: monthlyDollars.optional(),
    lifeInsuranceMonthly: monthlyDollars.optional(),
    /**
     * The rest of the policy: face amount (NOMINAL dollars — level term does
     * not inflate), the last month of coverage, and whose life it covers.
     * Absent means, respectively: no benefit, coverage ending with the
     * paycheck (the pre-existing rule), and the first person with a salary.
     */
    lifeInsuranceDeathBenefit: z.number().min(0).max(MAX_DEATH_BENEFIT).optional(),
    lifeInsuranceTermEnd: yearMonth.optional(),
    lifeInsuranceTermStart: yearMonth.optional(),
    lifeInsuranceInsured: z.string().min(1).optional(),
    /**
     * The itemised budget. Present and non-empty means the three scalar
     * streams above are DERIVED from it; absent means the scalars are the
     * truth, which is every profile written before this existed.
     */
    lines: z.array(expenseLineSchema).max(200).optional(),
    /** Every policy in force. Non-empty supersedes the single-policy fields. */
    lifeInsurancePolicies: z.array(lifeInsurancePolicySchema).max(20).optional(),
    /** Absent = { type: 'continue' } (the paycheck stream runs for life). */
    retirementGiving: retirementGivingSchema.optional(),
    /** Absent = no pot, like every profile that never chose the bundled rule. */
    untithedPot: untithedPotSchema.optional(),
  }),
  health: z.object({
    acaBenchmarkMonthly: z.number().min(0),
    acaQuoteYear: z.number().int().min(2024).max(2100),
    partDPlanMonthly: z.number().min(0),
    employerPremiumShareMonthly: z.number().min(0),
    notes: z.string().optional(),
  }),
  settings: z.object({
    horizonAge: z.number().int().min(70).max(110),
    successTarget: z.number().min(0).max(1),
    mcPathsInteractive: z.number().int().min(100).max(100000),
    mcPathsFinal: z.number().int().min(100).max(100000),
    seed: z.number().int(),
    terminalFloorReal: z.number().min(0).optional(),
    spendingPolicy: z.object({
      type: z.enum(['fixed_real', 'fixed_percent', 'guardrails']),
      percent: z.number().min(0).max(0.25).optional(),
      guardrails: z
        .object({
          // Rails are multiples of the INITIAL withdrawal rate. Upper must
          // exceed lower or the band is inverted and every year breaches both.
          upper: z.number().min(1).max(3),
          lower: z.number().min(0.2).max(1),
          adjustment: z.number().min(0.01).max(0.5),
          floorFraction: z.number().min(0.1).max(1).optional(),
          // Cap on raises as a multiple of plan spending; absent = uncapped
          // (the published prosperity rule). Min 1: a ceiling below plan
          // would turn the prosperity rule into a second cutting rule and
          // fight the floor over the same territory.
          raiseCeiling: z.number().min(1).max(3).optional(),
        })
        .refine((g) => g.upper > g.lower, {
          message: 'guardrails.upper must be greater than guardrails.lower',
        })
        .optional(),
    }),
    withdrawalPolicy: z.object({
      order: z.array(z.enum(['cash', 'taxable', 'pretax', 'roth'])).min(1),
      pretaxPreference: z.enum(['ira_first', 'proportional']),
    }),
  }),
}) as z.ZodType<Profile>;

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('retire'), person: z.string(), date: yearMonth }),
  z.object({ type: z.literal('claim_social_security'), person: z.string(), date: yearMonth }),
  /**
   * One person dies (see ScenarioEvent's 'death' member). `livingFraction` is
   * bounded 0..1: a survivor who spends MORE than the couple did is a real
   * situation (paid care), but it is an EXPENSE, not a change in household
   * size, and belongs in a one_time_expense or expense_change where it can be
   * dated and sized honestly rather than smeared across every remaining year.
   */
  z.object({
    type: z.literal('death'),
    person: z.string().min(1),
    date: yearMonth,
    livingFraction: z.number().min(0).max(1).optional(),
    survivorClaim: yearMonth.optional(),
  }),
  z.object({
    type: z.literal('expense_change'),
    date: yearMonth,
    multiplier: z.number().min(0).optional(),
    delta: z.number().optional(),
    category: z.enum(['living', 'charitable']).optional(),
  }),
  z.object({ type: z.literal('state_change'), date: yearMonth, state: stateCode }),
  z.object({ type: z.literal('sell_house'), date: yearMonth }),
  z.object({
    type: z.literal('rent'),
    start: yearMonth,
    months: z.number().int().min(1).max(600),
    monthlyCost: z.number().min(0),
  }),
  z.object({
    type: z.literal('buy_house'),
    date: yearMonth,
    price: z.union([z.number().min(0), z.literal('sale_proceeds')]),
    financing: z.union([
      z.literal('cash'),
      z
        .object({
          downPct: z.number().min(0).max(1),
          rate: z.number().min(0).max(0.25),
          termYears: z.number().int().min(1).max(50),
          // Lump payoff N years in: 1..29 (a 30-year term is the longest the
          // planner defaults to, and 0 would be "pay cash" spelled strangely).
          // The cross-field bound is enforced below — termYears is REQUIRED on
          // an event, so "strictly inside the term" is always expressible here.
          payoffAfterYears: z.number().int().min(1).max(29).optional(),
        })
        .superRefine((f, ctx) => {
          if (f.payoffAfterYears !== undefined && f.payoffAfterYears >= f.termYears) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['payoffAfterYears'],
              message: `payoffAfterYears (${f.payoffAfterYears}) must be strictly below termYears (${f.termYears}) — at or past maturity there is no principal left to pay off`,
            });
          }
        }),
    ]),
    propertyTaxAnnual: z.number().min(0),
    insuranceAnnual: z.number().min(0),
  }),
  z.object({
    type: z.literal('allocation_change'),
    date: yearMonth,
    mix: assetMix,
    account: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('glidepath'),
    start: yearMonth,
    end: yearMonth,
    fromMix: assetMix,
    toMix: assetMix,
    account: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('withdrawal_strategy'),
    date: yearMonth,
    policy: z.object({
      order: z.array(z.enum(['cash', 'taxable', 'pretax', 'roth'])).min(1),
      pretaxPreference: z.enum(['ira_first', 'proportional']),
    }),
  }),
  z.object({ type: z.literal('one_time_expense'), date: yearMonth, amount: z.number() }),
  z.object({
    type: z.literal('one_time_income'),
    date: yearMonth,
    amount: z.number(),
    taxable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('start_72t'),
    date: yearMonth,
    account: z.string(),
    /** Desired SEPP annual payment; engine caps at the IRS formula max (split-IRA technique). */
    annualAmount: z.number().min(0).optional(),
    /** Amortization rate; default = the Notice 2022-6 cap. */
    interestRate: z.number().min(0).max(0.06).optional(),
  }),
  z.object({
    type: z.literal('roth_conversion'),
    date: yearMonth.optional(),
    yearly: z.boolean().optional(),
    amount: z.number().min(0).optional(),
    toBracketTop: z.number().min(0).max(1).optional(),
  }),
]);

/**
 * Scenario-level housing plan (types.ts HousingPlan).
 *
 * Every optional field here means "let the engine choose" — the mortgage
 * defaults (20% down, 30 years, the current PMMS rate), the insurance estimate
 * and the CPI-linked appreciation all live in engine/housingPlan.ts, NOT in
 * `.default()` calls here. Defaulting in the schema would bake today's mortgage
 * rate into every scenario the moment it was saved, so a rate correction would
 * silently miss every existing file; leaving the field absent keeps it live.
 *
 * Bounds mirror the equivalent event fields (downPct 0-1, rate 0-0.25,
 * termYears 1-50), plus a 0-0.2 band on appreciation — a scenario claiming 40%
 * annual home growth is a typo, not a plan.
 */
const housingPlanSchema = z.object({
  sellDate: yearMonth,
  appreciationRate: z.number().min(-0.2).max(0.2).optional(),
  rentMonths: z.number().int().min(0).max(600),
  rentMonthly: z.number().min(0),
  // 'sale_proceeds' = buy with whatever the move leaves (a residual claim);
  // a number = a firm commitment the 72(t) bridge must reserve. See types.ts.
  purchasePrice: z.union([
    z.number().min(0),
    z.literal('sale_proceeds'),
    z.literal('none'),
  ]),
  // What the SURVIVOR buys at when a death precedes the purchase month; absent
  // = the plan price (types.ts). Same bounds as purchasePrice, minus 'none':
  // "the survivor sells and never buys" is a different plan, not a survivor price.
  survivorPurchasePrice: z.union([z.number().min(0), z.literal('sale_proceeds')]).optional(),
  // What the survivor does with the house when a death lands AT/AFTER the
  // purchase month (the post-purchase counterpart of survivorPurchasePrice;
  // types.ts). A number = sell after the delay and rebuy at that price, cash;
  // 'none' = sell and rent to the horizon. Here 'none' IS allowed — unlike a
  // survivor purchase price, "sell and never rebuy" is a legitimate answer to
  // what the survivor does with a house they already own.
  survivorDownsizeTo: z.union([z.number().min(0), z.literal('none')]).optional(),
  // Months from the death to the downsize sale; absent = 12 (housingPlan.ts).
  survivorDownsizeDelayMonths: z.number().int().min(0).max(600).optional(),
  propertyTaxAnnual: z.number().min(0),
  insuranceAnnual: z.number().min(0).optional(),
  financing: z.discriminatedUnion('type', [
    z.object({ type: z.literal('cash') }),
    z.object({
      type: z.literal('mortgage'),
      downPct: z.number().min(0).max(1).optional(),
      rate: z.number().min(0).max(0.25).optional(),
      termYears: z.number().int().min(1).max(50).optional(),
      payoffAfterYears: z.number().int().min(1).max(29).optional(),
    }),
  ]),
})
  /*
   * payoffAfterYears must sit STRICTLY inside the term. The check lives out
   * here on the plan object, not on the mortgage variant, because zod's
   * discriminatedUnion refuses a .superRefine-wrapped member outright (it
   * needs plain ZodObjects to read the discriminator) — measured: wrapping the
   * variant throws at module load, not at parse time.
   *
   * Only a STATED term is checked: an absent term means the engine's 30-year
   * default, and the 1..29 bounds above already keep every value inside that.
   * Validating against the default here instead would bake today's 30 into
   * the schema the same way a .default() would (see the header comment) — so
   * the engine keeps its own guard for inputs built outside the schema.
   */
  .superRefine((plan, ctx) => {
    const f = plan.financing;
    if (
      f.type === 'mortgage' &&
      f.payoffAfterYears !== undefined &&
      f.termYears !== undefined &&
      f.payoffAfterYears >= f.termYears
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['financing', 'payoffAfterYears'],
        message: `payoffAfterYears (${f.payoffAfterYears}) must be strictly below termYears (${f.termYears}) — at or past maturity there is no principal left to pay off`,
      });
    }
  });

const solverSchema = z.discriminatedUnion('type', [
  /**
   * The widow score, swept by year of death. No `targetSuccess` on purpose —
   * the survivor is held to the household's own bar, which is what makes the
   * two numbers comparable (see targetFor in engine/solvers.ts).
   */
  z.object({
    type: z.literal('widow_score'),
    person: z.string().min(1).optional(),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    step: z.number().int().min(1).max(10).optional(),
    livingFraction: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('retire_year_sweep'),
    from: z.number().int(),
    to: z.number().int(),
    alsoMaxSpend: z.boolean().optional(),
  }),
  z.object({ type: z.literal('ss_claim_sweep'), stepMonths: z.number().int().min(1).max(12).optional() }),
  z.object({
    type: z.literal('swr_curve'),
    spendFrom: z.number().min(0),
    spendTo: z.number().min(0),
    step: z.number().min(1),
  }),
  z.object({ type: z.literal('max_spend'), targetSuccess: z.number().min(0).max(1).optional() }),
  z.object({
    type: z.literal('earliest_retirement'),
    targetSuccess: z.number().min(0).max(1).optional(),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  }),
]);

/** A real return / spread expressed as a decimal, with sensible sanity bounds. */
const realReturn = z.number().min(-0.2).max(0.2);
const expenseRatio = z.number().min(0).max(0.05);
const realSpread = z.number().min(-0.05).max(0.1);

/**
 * Bounded partial of MarketAssumptions for scenario assumption_overrides.
 * Strict: unknown keys are rejected so a typo'd override fails loudly
 * instead of silently doing nothing.
 */
const marketOverrideSchema = z.strictObject({
  deterministicReal: z
    .strictObject({ stocks: realReturn, bonds: realReturn, bills: realReturn })
    .optional(),
  deterministicInflation: z.number().min(-0.05).max(0.15).optional(),
  expenseRatios: z
    .strictObject({ stocks: expenseRatio, bonds: expenseRatio, bills: expenseRatio })
    .optional(),
  stockDividendYield: z.number().min(0).max(0.1).optional(),
  bootstrapBlockYears: z.number().int().min(1).max(10).optional(),
  homeAppreciationRealSpread: realSpread.optional(),
  medicalInflationRealSpread: realSpread.optional(),
  rentGrowthRealSpread: realSpread.optional(),
  // Nominal yield on savings cash; absent = the bills return (see types.ts).
  cashYieldNominal: z.number().min(0).max(0.25).optional(),
  // Corporate (Baa) share of the bond sleeve, 0..1; absent = 0 = pure
  // Treasury. Strict inner object: a typo'd key ("corporateFrac") must fail
  // loudly, not silently leave the sleeve in Treasuries.
  bondComposition: z
    .strictObject({ corporateFraction: z.number().min(0).max(1) })
    .optional(),
});

/**
 * Bounded partial of the overridable ProfileSettings fields. Strict; the
 * bounds mirror the profile schema (horizonAge 70-110, successTarget 0-1,
 * spendingPolicy identical shape).
 */
const settingsOverrideSchema = z.strictObject({
  horizonAge: z.number().int().min(70).max(110).optional(),
  successTarget: z.number().min(0).max(1).optional(),
  terminalFloorReal: z.number().min(0).optional(),
  spendingPolicy: z.object({
      type: z.enum(['fixed_real', 'fixed_percent', 'guardrails']),
      percent: z.number().min(0).max(0.25).optional(),
      guardrails: z
        .object({
          // Rails are multiples of the INITIAL withdrawal rate. Upper must
          // exceed lower or the band is inverted and every year breaches both.
          upper: z.number().min(1).max(3),
          lower: z.number().min(0.2).max(1),
          adjustment: z.number().min(0.01).max(0.5),
          floorFraction: z.number().min(0.1).max(1).optional(),
          // Mirrors the profile schema above (raiseCeiling: 1..3, absent =
          // uncapped) — the override carries the same band shape.
          raiseCeiling: z.number().min(1).max(3).optional(),
        })
        .refine((g) => g.upper > g.lower, {
          message: 'guardrails.upper must be greater than guardrails.lower',
        })
        .optional(),
    })
    .optional(),
});

/**
 * Bounded partial of the profile's expense streams — BOTH sides of each pair.
 * Strict, like the market/settings overrides: a typo'd key must fail loudly
 * rather than silently leave spending at the profile value. Bounds mirror the
 * profile schema's `min(0)` plus the shared $1,000,000/month sanity ceiling.
 */
const expensesOverrideSchema = z.strictObject({
  livingMonthly: monthlyDollars.optional(),
  livingMonthlyRetired: monthlyDollars.optional(),
  charitableMonthly: monthlyDollars.optional(),
  investingMonthly: monthlyDollars.optional(),
  /** Parsed but ignored since 2026-08-31: investing stops at retirement. */
  investingMonthlyRetired: monthlyDollars.optional(),
  /**
   * The life-insurance policy, overridable as a whole. AssumptionOverrides has
   * declared `lifeInsuranceMonthly` since the premium was added and simulate.ts
   * has always read it, but this strict schema never accepted it — so a plan
   * that tried to override the premium was rejected outright. Fixed here
   * alongside the three new fields, because "five years of term at retirement"
   * is a question about a PLAN and has to be askable without editing the
   * household's profile: two scenarios must be able to disagree about the
   * policy at the same time, which is the entire mechanism behind "does the
   * premium buy enough widow score to be worth paying?".
   */
  lifeInsuranceMonthly: monthlyDollars.optional(),
  lifeInsuranceDeathBenefit: z.number().min(0).max(MAX_DEATH_BENEFIT).optional(),
  lifeInsuranceTermEnd: yearMonth.optional(),
    lifeInsuranceTermStart: yearMonth.optional(),
  lifeInsuranceInsured: z.string().min(1).optional(),
  /**
   * Per-policy disposition for profiles carrying a policy LIST, keyed by policy
   * id. The five fields above cannot reach a listed policy (the list supersedes
   * them — resolvePolicies), so this map is how a plan cancels one policy and
   * keeps another. The DISPOSITION is a closed enum — a typo'd verb must fail
   * loudly like any other override key — but an id naming no profile policy is
   * DELIBERATELY legal: profiles evolve, and a saved scenario must not start
   * failing validation because a policy was renamed. The engine ignores such an
   * id; the scenario store flags it (policy_plan_unknown_policy).
   */
  lifeInsurancePolicyPlans: z
    .record(
      z.string().min(1).max(64),
      z.enum(['cancel_now', 'cancel_at_retirement', 'keep_to_term']),
    )
    .optional(),
  /**
   * Ongoing giving method for this run only, so a what-if can compare methods
   * side by side without editing the profile. Absent keeps the profile's rule.
   */
  retirementGiving: retirementGivingSchema.optional(),
  /**
   * The pot for this run only — the other half of the pair, overridable
   * independently. Absent INHERITS the profile's pot; `{ enabled: false }` is
   * the explicit "no pot in this run" (see the schema's doc above for why the
   * two must be different spellings).
   */
  untithedPot: untithedPotSchema.optional(),
});

/**
 * Bounded partial of the profile's RETIREMENT INCOME, mirroring the expense
 * override: a plan can try "what if we bring in 2,000/month consulting?"
 * without editing the profile. Strict, and deliberately narrow — salaries and
 * 401(k) contributions are payroll facts the profile owns.
 */
const incomeOverrideSchema = z.strictObject({
  retirementMonthly: monthlyDollars.optional(),
  /** Parsed but ignored since 2026-08-31: always ordinary income. */
  retirementIncomeTaxable: z.boolean().optional(),
});

export const scenarioSchema: z.ZodType<Scenario> = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Automatic 72(t)/SEPP bridge. ABSENT MEANS ON — a scenario file written
   * before this field existed still gets the automatic election; only an
   * explicit `false` turns it off. (Semantics documented on Scenario.autoSepp.)
   */
  autoSepp: z.boolean().optional(),
  assumption_overrides: z
    .object({
      market: marketOverrideSchema.optional(),
      aca: z.object({ enhancedCreditsExtended: z.boolean().optional() }).optional(),
      settings: settingsOverrideSchema.optional(),
      expenses: expensesOverrideSchema.optional(),
      income: incomeOverrideSchema.optional(),
    })
    .optional(),
  /**
   * The move as first-class config. PRESENT supersedes any hand-written
   * sell_house / rent / buy_house event in `events` (the engine drops them);
   * ABSENT leaves those events behaving exactly as they always have.
   */
  housing: housingPlanSchema.optional(),
  events: z.array(eventSchema),
  solver: solverSchema.optional(),
}) as z.ZodType<Scenario>;

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/**
 * One axis of the decision space. Strict on every variant and non-empty on
 * every level list: an axis with no levels searches nothing while looking like
 * it searched something, and a typo'd dimension name must fail loudly rather
 * than silently drop a decision the user asked about.
 *
 * Level counts are capped at 24 per axis. The cap is not about memory — it is
 * about the report: a dimension with 40 levels has too few observations per
 * level for its marginal effect to mean anything at any realistic budget.
 */
const axisLevels = <T extends z.ZodTypeAny>(inner: T) => z.array(inner).min(1).max(24);

const glideShape = z.enum(['step_now', 'step_at_retirement', 'glide_to_target', 'rising_equity']);

/**
 * Why a `fixed_percent` level is refused, in the user's language. The default
 * rejection ("Invalid discriminator value...") reads as a schema bug, not as a
 * decision — and this rejection IS a decision, made after the search fabricated
 * a winner from a level it could not rank. The sentence rides the zod issue so
 * the route's formatter surfaces it verbatim.
 */
const FIXED_PERCENT_LEVEL_MESSAGE =
  'A percent-of-portfolio level cannot be searched: that policy sets spending by formula, so ' +
  '"maximum sustainable spending" has no answer for it — the search once fabricated a ' +
  '+$290,000/yr winner this way. Use fixed_real or guardrails levels.';

const spendingPolicyLevelSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('fixed_real') }),
    z.strictObject({ type: z.literal('guardrails') }),
  ],
  {
    errorMap: (issue, ctx) => {
      const type =
        typeof ctx.data === 'object' && ctx.data !== null
          ? (ctx.data as { type?: unknown }).type
          : undefined;
      if (issue.code === z.ZodIssueCode.invalid_union_discriminator && type === 'fixed_percent') {
        return { message: FIXED_PERCENT_LEVEL_MESSAGE };
      }
      return { message: ctx.defaultError };
    },
  },
);

const searchAxisSchema = z.discriminatedUnion('dim', [
  z.strictObject({
    dim: z.literal('retireYear'),
    levels: axisLevels(z.number().int().min(2020).max(2100)),
  }),
  z.strictObject({ dim: z.literal('autoSepp'), levels: axisLevels(z.boolean()) }),
  z.strictObject({ dim: z.literal('stockShare'), levels: axisLevels(z.number().min(0).max(1)) }),
  z.strictObject({ dim: z.literal('glideShape'), levels: axisLevels(glideShape) }),
  z.strictObject({
    dim: z.literal('housePrice'),
    levels: axisLevels(
      z.union([z.number().min(0).max(100_000_000), z.literal('sale_proceeds'), z.literal('none')]),
    ),
  }),
  z.strictObject({
    dim: z.literal('financing'),
    levels: axisLevels(z.enum(['cash', 'mortgage'])),
  }),
  z.strictObject({
    dim: z.literal('moveOffsetYears'),
    levels: axisLevels(z.number().int().min(0).max(40)),
  }),
  z.strictObject({ dim: z.literal('claimAge'), levels: axisLevels(z.number().int().min(62).max(70)) }),
  z.strictObject({ dim: z.literal('givingRule'), levels: axisLevels(retirementGivingSchema) }),
  z.strictObject({
    dim: z.literal('rothConversion'),
    levels: axisLevels(z.union([z.number().min(0).max(1), z.literal('none')])),
  }),
  z.strictObject({ dim: z.literal('state'), levels: axisLevels(stateCode) }),
  /*
   * A spending POLICY axis may only offer fixed_real and guardrails levels.
   *
   * The search ranks on maximum sustainable spending, found by bisecting the
   * living figure. Under `fixed_percent` the policy sets living spending
   * outright and never reads that figure, so the bisection is inert: every
   * probe scores identically and it returns the top of its bracket. Measured on
   * a representative plan, a 4%-of-portfolio level scored 1.000000 at spends of
   * $60k, $120k, $250k and $399k alike, and duly won a search with a fabricated
   * "+$290,000/yr, Real" verdict — the single worst thing this feature could do,
   * which is report a confident wrong winner.
   *
   * Rejecting it at the schema is the honest fix. "How much can I sustainably
   * spend under a policy that defines my spending" is not a question with an
   * answer, so the search should decline it rather than invent one.
   *
   * Guardrails, by contrast, IS rankable: the policy READS the living figure
   * the bisection sweeps (spending holds real; the rails only correct the
   * withdrawal rate), so probes separate and the objective has an answer. A
   * level carries no band — the compiler runs the user's configured rails.
   */
  z.strictObject({
    dim: z.literal('spendingPolicy'),
    levels: axisLevels(spendingPolicyLevelSchema),
  }),
]);

const searchObjectiveSchema = z.strictObject({
  metric: z.enum(['sustainable_spend', 'success']).optional(),
  probeSpend: z.number().min(0).max(1_000_000).optional(),
  probeTargetSuccess: z.number().min(0.05).max(0.99).optional(),
  practicalFloor: z.number().min(0).optional(),
});

/**
 * Compute budget. The upper bounds are sanity rails, not recommendations: 4,096
 * candidates at 40 report seeds is a multi-hour search, and the caller sees the
 * projected evaluation count before it starts.
 */
const searchBudgetSchema = z.strictObject({
  candidates: z.number().int().min(1).max(8192).optional(),
  enumerate: z.boolean().optional(),
  eta: z.number().min(1.5).max(10).optional(),
  finalists: z.number().int().min(1).max(32).optional(),
  screenPaths: z.number().int().min(100).max(100_000).optional(),
  racePaths: z.number().int().min(100).max(100_000).optional(),
  reportPaths: z.number().int().min(100).max(100_000).optional(),
  selectionSeedCount: z.number().int().min(1).max(64).optional(),
  reportSeedCount: z.number().int().min(2).max(64).optional(),
  seedBase: z.number().int().optional(),
  attribution: z.boolean().optional(),
  polish: z.boolean().optional(),
  polishSeedCount: z.number().int().min(2).max(64).optional(),
  widowProbe: z.boolean().optional(),
  widowProbeYear: z.number().int().min(2020).max(2100).optional(),
  workers: z.number().int().min(1).max(32).optional(),
});

export const searchRequestSchema = z
  .object({
    base: scenarioSchema,
    /**
     * At least one axis: a search over nothing is a plain run, and answering it
     * with a report full of ties would be actively misleading.
     */
    axes: z.array(searchAxisSchema).min(1).max(12),
    objective: searchObjectiveSchema.optional(),
    budget: searchBudgetSchema.optional(),
    label: z.string().max(120).optional(),
  })
  .refine((r) => new Set(r.axes.map((a) => a.dim)).size === r.axes.length, {
    path: ['axes'],
    // Two axes on one dimension is not a bigger search, it is an ambiguous one:
    // the compiler would apply both and the second would silently win.
    message: 'each dimension may appear at most once',
  });

// ---------------------------------------------------------------------------
// Quotes (quotes.json) and net worth (networth.json)
// ---------------------------------------------------------------------------

/**
 * One stored quote. `currency` is validated to the literal 'USD' — the refresh
 * route already rejects anything else before storing, so a non-USD entry in
 * the file can only mean a hand edit, and it should fail the load loudly
 * rather than price a USD model in euros.
 */
const storedQuoteSchema = z.object({
  price: z.number().positive().finite(),
  currency: z.literal('USD'),
  asOf: z.string().min(1),
  source: z.literal('yahoo'),
  fetchedAt: z.string().min(1),
});

/** quotes.json: symbol → stored quote. Keys must be legal symbols. */
export const quotesFileSchema = z.record(symbolSchema, storedQuoteSchema);

/**
 * POST /api/quotes/refresh body. `symbols` absent = every symbol appearing in
 * any account's holdings — the default the UI's one button uses.
 */
export const quotesRefreshRequestSchema = z.strictObject({
  symbols: z.array(symbolSchema).min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// The plan's history (plan-history.json)
// ---------------------------------------------------------------------------

const runMode = z.enum(['deterministic', 'historical', 'montecarlo']);

/**
 * The fields every recorded score carries, shared by a history entry's score
 * and a net-worth row's. One shape, spread into both: they answer the same
 * question about the same plan, and two copies that drifted by one field would
 * make the same number parse on one page and fail on the other.
 *
 * `paths` is bounded far wider than the profile's own 100..100,000 on purpose:
 * this parses a RECORD, and a row written when the settings allowed something
 * else must still be readable — a ledger that refused to parse would take the
 * history down with the score.
 */
const planScoreShape = {
  success: z.number().min(0).max(1),
  medianTerminalReal: z.number().optional(),
  sustainableSpend: z.number().min(0).optional(),
  sustainableSpendPaths: z.number().int().min(1).max(1_000_000).optional(),
  sustainableSpendError: z.string().max(1000).optional(),
  mode: runMode,
  paths: z.number().int().min(1).max(1_000_000),
  seed: z.number().int(),
  engineVersion: z.string().min(1),
  scoredAt: z.string().min(1),
};

const planScoreSchema = z.object(planScoreShape);

/**
 * One filed version of the plan. `plan` goes through the full scenario schema,
 * so an entry can only hold something the engine could actually run — a
 * restore must never hand plan.json a shape the workbench cannot open.
 */
export const planHistoryEntrySchema = z.object({
  id: z.string().min(1).max(64),
  takenAt: z.string().min(1),
  kind: z.enum(['day-start', 'kept']),
  plan: scenarioSchema,
  planHash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest'),
  label: z.string().min(1).max(120).optional(),
  score: planScoreSchema.optional(),
  scoreError: z.string().max(1000).optional(),
});

/** plan-history.json: append-only, oldest first on disk. */
export const planHistoryFileSchema = z.array(planHistoryEntrySchema);

/**
 * POST /api/plan/history body: file THIS plan without making it the plan —
 * the "keep this finalist" move. The id, the moment and the hash are the
 * server's, exactly as with a snapshot: a record whose writer chooses its own
 * timestamp cannot order a history.
 */
export const planKeepSchema = z.strictObject({
  plan: scenarioSchema,
  label: z.string().min(1).max(120).optional(),
});

/**
 * One recorded score on a net-worth row: the shared score shape, plus what it
 * points back at.
 *
 * `planHash` is OPTIONAL and always will be. Rows recorded while the app had a
 * separate frozen "baseline plan" carry the four baseline fields instead, and
 * those are historical facts about numbers already on the chart — a schema that
 * refused them would not delete them, it would make networth.json fail to
 * parse and take the whole ledger down with the score.
 */
const snapshotScoreSchema = z.object({
  ...planScoreShape,
  planHash: z.string().min(1).max(64).optional(),
  planHistoryId: z.string().min(1).max(64).optional(),
  baselineRevision: z.number().int().min(1).optional(),
  baselineHash: z.string().min(1).max(64).optional(),
  baselineLabel: z.string().min(1).max(120).optional(),
  planDriftedFromBaseline: z.boolean().optional(),
});

/**
 * One net-worth snapshot as stored. `takenAt`/`total`/`accounts`/`prices` are
 * server-computed; the write schema below is what the client may send.
 *
 * `score` and `scoreError` are OPTIONAL and must stay that way: every row
 * written before scoring existed — including the first real snapshot —
 * has neither, and parsing that file must produce "not scored", never a
 * validation failure and never a zero.
 */
const netWorthSnapshotSchema = z.object({
  id: z.string().min(1).max(64),
  takenAt: z.string().min(1),
  total: z.number().finite(),
  homeValue: z.number().min(0),
  accounts: z.array(
    z.object({ id: z.string().min(1), name: z.string().min(1), balance: z.number().finite() }),
  ),
  prices: z.record(symbolSchema, z.object({ price: z.number().positive(), asOf: z.string().min(1) })),
  note: z.string().max(500).optional(),
  score: snapshotScoreSchema.optional(),
  scoreError: z.string().max(1000).optional(),
});

/** networth.json: append-only snapshot list. */
export const netWorthFileSchema = z.array(netWorthSnapshotSchema);

/**
 * POST /api/networth/snapshot body: the home value is the user's own number
 * (the one figure no quote feed can supply), plus an optional note. Everything
 * else — the timestamp, the balances, the prices — is the server's to compute,
 * which is what makes a snapshot a record rather than a claim.
 */
export const netWorthSnapshotWriteSchema = z.strictObject({
  homeValue: z.number().min(0).max(1_000_000_000),
  note: z.string().max(500).optional(),
});

/**
 * One write-ahead scoring intent, and the file that holds them
 * (.scoring-intent.json — store/scoringIntent.ts). Validated like every other
 * data file so a hand-edited or half-synced entry fails loudly at the seam
 * rather than steering the healer; the store treats an unparseable FILE as
 * empty (a torn write cannot name what was in flight), but a file that parses
 * must mean what it says.
 */
const scoringIntentSchema = z.object({
  kind: z.enum(['snapshot', 'plan-version']),
  id: z.string().min(1).max(64),
  phase: z.enum(['score', 'spend']),
  runKey: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest'),
  startedAt: z.string().min(1),
});

/** .scoring-intent.json: the in-flight scoring runs, at most one per record. */
export const scoringIntentFileSchema = z.array(scoringIntentSchema);

/**
 * POST /api/scoring/finish body: which interrupted record to finish. The
 * backend re-verifies the intent's runKey against today's inputs before a
 * single path is simulated — the click is a request, not an override.
 */
export const finishScoringRequestSchema = z.strictObject({
  kind: z.enum(['snapshot', 'plan-version']),
  id: z.string().min(1).max(64),
});

/** Format a ZodError into a short human-readable message list. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 10)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new Error(`Invalid ${label}: ${formatZodError(res.error)}`);
  }
  return res.data;
}
