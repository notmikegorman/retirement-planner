/**
 * Shared contract types for the finance planner.
 *
 * This file is the single source of truth for the shapes passed between
 * ui <-> server <-> engine <-> tax. Modules must not invent parallel types
 * for anything defined here.
 *
 * Conventions:
 * - All money values are nominal USD for the year in question unless a field
 *   name ends in `Real` (2026 dollars).
 * - Rates and percentages are decimals (0.05 = 5%).
 * - Dates in data files are "YYYY-MM" strings (YearMonth). Ages are evaluated
 *   at year end: ageAtYearEnd = year - birthYear, with birthMonth deciding
 *   half-birthdays (59 1/2, 70 1/2).
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type StateCode = 'va' | 'sc' | 'nc';
/**
 * Federal filing status. 'single' exists for ONE reason: the survivor.
 *
 * A married couple files jointly right up to and INCLUDING the year one spouse
 * dies (IRC 6013(a)(3); IRS Pub. 501, "The year of death is the last year for
 * which you can file jointly with your deceased spouse"). From the first FULL
 * year after the death the survivor files SINGLE — and, with no dependent
 * child, there is no two-year grace period at joint rates: qualifying
 * surviving spouse status under IRC 2(a)(1)(B) requires a dependent
 * son/stepson/daughter/stepdaughter in the household, joined to the other
 * conditions by "and". So the widow penalty lands the very next year.
 *
 * That penalty is why this type exists and why nothing here may derive single
 * figures from MFJ ones by halving. Roughly half the standard deduction,
 * brackets that compress far faster (the 37% entry is $640,600 single vs
 * $768,700 MFJ — NOT half, which would be the MFS figure), Social Security
 * taxable from $25,000/$34,000 instead of $32,000/$44,000, NIIT at $200,000
 * instead of $250,000, single-filer IRMAA tiers whose TOP tier is $500,000 and
 * not half of the MFJ $750,000, and a one-person federal poverty level for the
 * ACA. Every single-filer figure in the data files is its own literal table.
 */
export type FilingStatus = 'mfj' | 'single';
export type AccountType =
  | 'traditional_ira'
  | 'roth_ira'
  | 'taxable_brokerage'
  | 'savings'
  | '401k';
export type AssetClass = 'stocks' | 'bonds' | 'bills';
/** Weights over asset classes; must sum to 1. */
export interface AssetMix {
  stocks: number;
  bonds: number;
  bills: number;
}
/** "YYYY-MM" */
export type YearMonth = string;

/**
 * BUMP THIS WHENEVER THE ENGINE'S NUMBERS CHANGE.
 *
 * It is part of the run-cache key (runManager: sha256 of engineVersion + input),
 * which is the only thing standing between a behaviour change and the app
 * confidently showing results computed by the previous engine. Same plan, same
 * profile, stale answer — and nothing on screen admits it.
 *
 * It went unbumped through several behaviour changes, including the tithe
 * rule's base moving from portfolio balance to cumulative real gain, which is
 * how a fixed engine kept reporting an empty giving column from disk.
 * tests/shared/engineVersion.test.ts now fails when the engine's source
 * changes without this constant moving.
 */
export const ENGINE_VERSION = '1.22.0';

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface Person {
  id: string;
  name: string;
  birthYear: number;
  birthMonth: number; // 1-12
  /**
   * Primary Insurance Amount at Full Retirement Age, $/month, as shown on the
   * SSA statement. SSA statement estimates ASSUME CONTINUED EARNINGS at the
   * current salary through age 62 — this is the "keep working" figure.
   */
  piaMonthlyAtFraIfWorkingTo62: number;
  /**
   * PIA at FRA, $/month, assuming the person stops working NOW ($0 future
   * earnings) — from ssa.gov's estimator with "average future annual salary"
   * set to $0. The engine interpolates between this and
   * `piaMonthlyAtFraIfWorkingTo62` based on the scenario's retirement date
   * (linear by years worked between now and age 62; documented simplification).
   */
  piaMonthlyAtFraIfStoppingNow: number;
  /**
   * false when the person lacks 40 SS credits: own worker benefit is 0 and
   * only the spousal benefit applies.
   */
  hasOwnBenefit: boolean;
  notes?: string;
}

export interface RothBasis {
  /** Lifetime direct contributions (withdrawable anytime tax/penalty-free). */
  contributions: number;
  /** Conversion buckets; each has its own 5-year clock pre-59.5. */
  conversions: Array<{ year: number; amount: number }>;
}

/**
 * ONE POSITION in a holdings-mode account: this many shares of this ticker,
 * bucketed into the asset class the engine actually models. The class is
 * OWNER-DECLARED, not looked up — a fund's composition is a fact about the
 * fund (VTI is stocks, BND is bonds), and asking a quote feed to classify it
 * would put a network guess where a one-word fact belongs.
 */
export interface Holding {
  /** Ticker as the quote source knows it (VTI, BND, VTTHX). Uppercase. */
  symbol: string;
  /** Shares held. Fractional is real — funds settle in thousandths. */
  quantity: number;
  /** Which modeled sleeve this position's market value counts toward. */
  assetClass: AssetClass;
}

export interface Account {
  /** Stable internal key (referenced by events like start_72t and withdrawals.byAccount). */
  id: string;
  /** Display name shown everywhere in the UI (e.g. "Alex's 401(k)"). */
  name: string;
  type: AccountType;
  /**
   * Person id of the owner, or the literal 'joint'. 'joint' is allowed ONLY
   * for 'taxable_brokerage' and 'savings' — retirement accounts are
   * individually owned by law.
   */
  owner: string;
  balance: number;
  /** Taxable brokerage only: cost basis for LTCG on sales. */
  costBasis?: number;
  /**
   * Retirement accounts (pre-tax and Roth) only: the lifetime dollars the
   * account owner PUT IN — deferrals, employer match, direct contributions, rollovers
   * of the same — never the growth on them.
   *
   * WHY THE ENGINE WANTS IT: under the household's giving doctrine — "tithe
   * the gross, once" — every contributed dollar arrived out of gross pay that
   * was already tithed the year it was earned. Tithing the account balance
   * again would tithe those same dollars a second time. Only the EXCESS over
   * lifetime contributions is money that has never passed under a tithe, so
   * `max(0, balance - lifetimeContributions)` is the untithed base the
   * 'tithe_account' rule seeds itself from.
   *
   * ABSENT MEANS UNKNOWN, NOT ZERO. A pre-tax account carries no contribution
   * history anywhere in this model (unlike a Roth, which has `rothBasis`, and
   * a brokerage, which has `costBasis`), and guessing would either
   * double-tithe a lifetime of already-tithed pay or under-tithe decades of
   * gains. So the engine treats an absent figure as an untithed base of ZERO
   * for that account — the conservative direction, since it seeds nothing it
   * cannot justify — and flags the year so the user is told the number is
   * missing rather than quietly getting a smaller carve-out.
   *
   * NOT USED FOR TAX. There is no Form 8606 basis modeling here: pre-tax
   * distributions are fully taxable regardless of what this says. It is a
   * giving-doctrine input only.
   */
  lifetimeContributions?: number;
  allocation: AssetMix;
  /**
   * THE ACCOUNT'S POSITIONS, when the user tracks it by holdings instead of
   * typing a balance. PRESENT switches the account to HOLDINGS MODE: `balance`
   * and `allocation` become DERIVED — balance = Σ quantity × stored quote
   * price + `cash`, allocation from the per-class market values — and the
   * server recomputes both from quotes.json at every chokepoint where the
   * profile is loaded (dataStore.loadResolvedProfile), so the engine, the
   * search compiler and the API all see the derived figures. ABSENT means the
   * account is manual, exactly as every account was before this field existed.
   *
   * The stored `balance`/`allocation` on a holdings-mode account are the
   * LAST-RESOLVED CACHE, not an independent input: they stay required because
   * the engine's arithmetic reads them unconditionally, and they are
   * overwritten by resolution wherever the numbers matter. A symbol with no
   * stored quote fails a RUN loudly (naming the symbol and the fix) rather
   * than silently pricing from the cache — a simulation quietly using last
   * month's prices is the bug this design exists to prevent.
   *
   * Runs NEVER fetch the network: prices enter through the explicit refresh
   * route (POST /api/quotes/refresh) and are read from disk after that.
   */
  holdings?: Holding[];
  /**
   * Uninvested dollars sitting in a holdings-mode account (the sweep/core
   * position a brokerage reports beside the positions). Counted as BILLS in
   * the derived allocation — it is cash-like, not stocks. Only meaningful
   * beside `holdings`; the schema rejects it on a manual account, where the
   * balance already includes any cash.
   */
  cash?: number;
  /** 401k only: which plan receives ongoing contributions/match. */
  currentEmployer?: boolean;
  /**
   * @deprecated Ignored: the engine models an automatic 401(k)→IRA rollover at
   * separation, so rule-of-55 no longer applies. Kept so old files parse.
   */
  ruleOf55Eligible?: boolean;
  /**
   * @deprecated Ignored (see ruleOf55Eligible). Kept so old files parse.
   */
  allowsPartialWithdrawals?: boolean | null;
  /**
   * Marks a target-date-fund holding (e.g. a 2035 target-retirement fund). The
   * engine glides this account's allocation automatically along an approximate
   * industry-standard target-date glidepath; the `allocation` field is the
   * CURRENT mix.
   */
  targetDateFund?: { targetYear: number };
  /** Roth only */
  rothBasis?: RothBasis;
  notes?: string;
}

export interface Mortgage {
  originalPrincipal: number;
  balance: number;
  rate: number; // annual
  termYears: number;
  startYear: number;
  startMonth: number;
}

export interface Home {
  value: number;
  /** Purchase price + improvements; needed for the §121 exclusion. */
  costBasis: number;
  state: StateCode;
  propertyTaxAnnual: number;
  insuranceAnnual: number;
  maintenancePctOfValue: number;
  /** Selling costs as fraction of sale price (agent fees etc). */
  sellingCostPct: number;
  mortgage?: Mortgage | null;
}

export interface ProfileIncome {
  /** personId -> annual gross salary while working. */
  salaries: Record<string, number>;
  /** Annual employee 401(k) deferral while person1 works (reduces wages for tax). */
  contribution401k: number;
  /** Annual employer match while working (goes into the 401k, not wages). */
  employerMatch401k: number;
  /**
   * Recurring income the household expects AFTER it stops working — part-time
   * work, consulting, a rental, a pension — in TODAY's dollars per month.
   *
   * The retired counterpart of `salaries`: it starts in the first year nobody
   * draws a salary (the same worked-months signal that switches the living,
   * investing and giving streams over), is PRORATED in the retirement year by
   * the months nobody worked, inflates with CPI like every other monthly
   * figure here, and then continues for life. ABSENT MEANS 0 — a profile
   * written before this field existed is unaffected.
   *
   * It is spendable cash: it reduces the withdrawal the year needs, and it is
   * reported in YearRow.income.retirement.
   *
   * DOCUMENTED SIMPLIFICATION — the Social Security EARNINGS TEST is not
   * modeled. A person who claims before Full Retirement Age while earning
   * above the annual exempt amount has benefits withheld ($1 for every $2 over
   * the limit, $1 for every $3 in the FRA year), and the withheld months are
   * credited back as a permanently higher benefit at FRA. This household
   * claims at 67 (its FRA), where the test does not apply at all, so nothing
   * here is affected — but a plan that claims at 62 AND carries part-time
   * earnings above the limit would overstate benefits in those years.
   */
  retirementMonthly?: number;
  /**
   * Whether `retirementMonthly` is taxable as ORDINARY income (wages from
   * part-time work, consulting, a pension, rent). ABSENT MEANS TRUE, which is
   * the honest default for anything earned. `false` models money that is not
   * income at all — a return of capital, a gift, a reimbursement: spendable
   * cash that raises neither AGI nor any MAGI, so it never touches the ACA
   * cliff, IRMAA, NIIT, or the taxability of Social Security.
   *
   * DOCUMENTED SIMPLIFICATION: taxable retirement income is treated as plain
   * ordinary income, NOT as wages — it is not subject to payroll tax, does not
   * create earned income for IRA-contribution purposes, and (per
   * `retirementMonthly`) does not trigger the Social Security earnings test.
   */
  retirementIncomeTaxable?: boolean;
}

/**
 * How giving is computed once NOBODY in the household is earning a salary —
 * the RETIRED SIDE of the charitable stream, the counterpart of
 * `livingMonthlyRetired` and `investingMonthlyRetired`. Giving gets a rule
 * rather than a plain second number because the household wants to express
 * "a tithe on what the portfolio actually produced", not only "this many
 * dollars"; `{ type: 'amount' }` is the plain-number case.
 *
 * `charitableMonthly` is a share of a paycheck: it has a base while wages are
 * coming in and no base afterwards. This rule says what replaces it. It takes
 * over from the first year in which nobody works (the same worked-months
 * signal that switches the living and investing streams), and the retirement
 * year itself is prorated — the paycheck stream for the months worked, the
 * rule for the rest.
 *
 * Every variant keeps feeding YearRow.expenses.charitable, expenses.total, and
 * the year's charitable tax deductions — with ONE deliberate exception,
 * 'tithe_account', whose defer years give nothing in cash by design and
 * therefore produce no deduction either. See that variant for why.
 */
export type RetirementGivingRule =
  /**
   * Keep the paycheck stream running for life: charitableMonthly x 12 x CPI,
   * still subject to 'charitable' expense_change events. This is what the
   * engine does when the field is absent, so every scenario written before the
   * field existed is unaffected.
   */
  | { type: 'continue' }
  /** Giving stops with the paychecks: 0 from the first fully-retired year. */
  | { type: 'none' }
  /**
   * A plain DIFFERENT AMOUNT once the paychecks stop: `monthly` in today's
   * dollars, inflated by CPI in-sim exactly like the paycheck stream — so
   * `{ type: 'amount', monthly: charitableMonthly }` is 'continue' by another
   * name, and any other figure is "we intend to give this much instead".
   *
   * Unlike the paycheck stream it is NOT retargeted by 'charitable'
   * expense_change events: once a rule governs a year, the rule's own
   * parameters set the giving (the same convention every non-'continue'
   * variant follows).
   */
  | { type: 'amount'; monthly: number }
  /**
   * A percentage of the PRIOR year's REAL portfolio growth.
   *
   * Real growth = the year's nominal investment gain across all accounts
   * (distributed interest and dividends + the growth applied to balances)
   * MINUS that year's inflation on the start-of-year total balance. It is the
   * increase in purchasing power the portfolio actually produced — the money
   * that was never part of a tithed paycheck.
   *
   * The PRIOR year is deliberate: this year's growth depends on this year's
   * withdrawals, which depend on this year's spending, which would include the
   * giving — a circular definition the withdrawal fixed point cannot resolve.
   * It is also the number a person would actually have in hand when deciding
   * what to give.
   *
   * A negative (down) year produces 0, never a negative gift.
   */
  | {
      type: 'percent_of_growth';
      /** Decimal fraction of the growth base (0.10 = 10%). */
      percent: number;
      /**
       * Average the last N years of real growth before applying `percent`
       * (default 1 = last year only, unsmoothed). Fewer than N completed years
       * average whatever years exist. Smoothing is how people tame a figure
       * that swings hard year to year; it also means a single down year no
       * longer zeroes giving outright.
       */
      smoothingYears?: number;
      /**
       * Optional ceiling on the monthly result, in TODAY's dollars (inflated
       * by CPI in-sim like every other monthly figure here). Applied to the
       * rule's full-year amount before any retirement-year proration.
       */
      capMonthly?: number;
    }
  /**
   * A percentage of the PRIOR year's cash income in retirement: Social
   * Security plus gross withdrawals (cash + taxable + pre-tax including RMDs
   * and 72(t) payments + Roth). Roth CONVERSIONS are excluded — a conversion
   * moves money between accounts and is not income to spend.
   *
   * Prior-year for the same non-circularity reason as percent_of_growth.
   * Smoother than growth-based giving, and it never pays 0 in a down year, but
   * it gives on principal that was already tithed on the way in.
   */
  | { type: 'percent_of_income'; percent: number }
  /**
   * LEGACY — THE BUNDLED TITHE ACCOUNT. This variant bundled two independent
   * decisions into one rule: an ongoing growth tithe AND the un-tithed pot.
   * The user thinks of them as two knobs (what to do with the pot of
   * never-tithed gains; how to tithe going forward), so the pair now lives as
   * `retirementGiving` (the ongoing method, the non-pot variants above) plus
   * `ProfileExpenses.untithedPot` (UntithedPotPolicy). The variant STAYS
   * ACCEPTED by the schema so old files parse, but it is normalised into the
   * pair at load (dataStore migrations; prepareSim as the engine-boundary
   * safety net) and MUST NEVER GOVERN A SIMULATION YEAR — the engine's
   * PreparedSim carries OngoingGivingRule, which excludes it by type.
   *
   * Everything below is the historical description of the bundled behaviour;
   * the migrated pair reproduces it bit for bit (pinned by the equivalence
   * digests in tests/engine/tithePair.test.ts).
   *
   * THE TITHE ACCOUNT. Giving stops being a monthly cheque and becomes a
   * BALANCE the household sets aside for charity and then disburses: a
   * carve-out inside the user's largest pre-tax IRA, seeded on the day the
   * last paycheck stops, fed for `deferYears` out of new portfolio highs,
   * frozen after that, disbursed as cash from then on, and given away whole at
   * death.
   *
   * WHY A CARVE-OUT INSIDE THE IRA AND NOT A SEPARATE ACCOUNT. Funding a real
   * brokerage "giving account" out of an IRA means a taxable distribution:
   * on a seed the size this household's would be, tens of thousands of dollars
   * of federal + state tax and a wiped-out ACA subsidy, all to move money the
   * household was going to give away anyway. The carve-out is an ACCOUNTING
   * ENTRY — the same split-IRA device the 72(t) machinery already uses (see
   * `<id>-sepp`) — so the seed and every later transfer cost exactly nothing.
   * It is modeled as a second traditional IRA with the id `<parentId>-tithe`.
   *
   * IT IS NOT A DONOR-ADVISED FUND, and must never be "improved" into one: a
   * DAF is expressly excluded from qualified-charitable-distribution treatment
   * (Notice 2007-7, A-35), and it is the direct IRA -> 501(c)(3) route that
   * makes the disbursement phase work in real life. Nothing ever sits in an
   * intermediary here; the balance is a label on money still inside the IRA.
   *
   * THE FOUR PHASES:
   * 1. SEED, on the first fully-retired year. When `seedFromExistingGains`,
   *    the carve-out opens at `percent` x the household's UNTITHED gains —
   *    summed over pre-tax and Roth accounts as
   *    `max(0, balance - lifetimeContributions)` (see Account
   *    .lifetimeContributions for why contributions are excluded and what an
   *    absent figure means). This is the one-time catch-up on a working
   *    lifetime of growth that a tithe on gross pay never touched.
   * 2. DEFER — the SOFT WINDOW. No cash giving. At each year end `percent` of
   *    the year's growth base moves from the parent IRA into the carve-out —
   *    an internal transfer, so no tax, no withdrawal, no income and no
   *    expense. The household is accumulating the gift, not making it. BUT the
   *    balance still COUNTS: it stays in balances.spendable and in the success
   *    metric, and the withdrawal machinery may reach it — LAST, after every
   *    other bucket is dry (it is a promise, so it is the last money touched;
   *    see computeWithdrawalPlan for the ordering decision). A draw shrinks
   *    the pot permanently: the promise absorbs the emergency, which is the
   *    break-glass behaviour made automatic. WHY: retirement planning hangs on
   *    the first fragile years, and the deferral exists to move the tithing
   *    DRAG past them — a hard lock on retirement day would remove spendable
   *    money at the worst possible moment and front-load the drag to exactly
   *    the years the window was designed to protect.
   * 3. LOCK + DISTRIBUTE, when cash giving starts. The window closes at the
   *    earlier of `deferYears` elapsing and the safe-zone `earlyRelease`
   *    trigger (see the fields below). From that year the carve-out locks
   *    exactly as a hard carve: out of balances.spendable, out of every
   *    success metric, out of the withdrawal ordering — charity money in
   *    escrow. The accrued pot then pays out in cash over `distributeYears`
   *    (each year gives balance / years-remaining, so growth is distributed
   *    too and the pot is empty on schedule), IN ADDITION to `percent` of the
   *    PRIOR year's growth base through the machinery every other rule uses.
   *    Pot exhausted -> only the growth stream remains. Both land in
   *    expenses.charitable, expenses.total and the charitable deductions.
   * 4. DEATH. Whatever still sits in the carve-out goes to charity — including
   *    a death DURING the soft window: the pot goes to charity, not the
   *    survivor. The engine models no estate, so this is an accounting
   *    statement rather than a cash flow: the balance is excluded from
   *    terminal wealth and reported instead as charitable legacy. That is also
   *    the correct tax answer — a traditional IRA left to a 501(c)(3) is
   *    income in respect of a decedent received by a tax-exempt entity
   *    (IRC 691(a)(1)) with an uncapped estate deduction (IRC 2055(a)), so 100
   *    cents on the dollar reaches the charity.
   *
   * THE GROWTH BASE IS A HIGH-WATER MARK on the REAL value of the SPENDABLE
   * portfolio (everything except the carve-out — never tithe the tithe). Each
   * year the base is `max(0, realEnd - previousRealPeak)` and the peak then
   * advances to `realEnd`. WHY: "tithe the gross, once". A portfolio that
   * falls 30% and climbs back has re-earned ground that was already tithed on
   * the way up; tithing the recovery would tithe those same dollars twice. So
   * nothing accrues until the portfolio is genuinely higher in purchasing
   * power than it has ever been. The peak starts at the spendable portfolio on
   * retirement day, because the seed has just settled everything that came
   * before it.
   */
  | {
      type: 'tithe_account';
      /** Decimal fraction, applied to both the seed and the growth base (0.10 = 10%). */
      percent: number;
      /**
       * How many fully-retired years accumulate instead of giving — the
       * LONGEST the soft window can run; `earlyRelease` can close it sooner.
       * 0 = never defer: the carve-out locks on retirement day and
       * distribution starts at once. While the window is open the pot counts
       * as spendable and may be drawn as a last resort (see the type's doc).
       */
      deferYears: number;
      /**
       * Years the accrued pot takes to pay out in cash once the window
       * closes, alongside the trailing-growth stream. Each distribution year
       * gives balance / years-remaining — the same annuitisation an RMD uses —
       * so growth earned mid-distribution is given too and the pot is exactly
       * empty on schedule (a flat pot/N would strand that growth forever).
       * ABSENT MEANS 10 (DEFAULT_TITHE_DISTRIBUTE_YEARS).
       */
      distributeYears?: number;
      /**
       * SAFE-ZONE EARLY RELEASE. The deferral exists to carry the promise
       * past the fragile first years of retirement — not to delay giving for
       * its own sake. When true (AND WHEN ABSENT — the default matches the
       * window's stated purpose), a path whose SPENDABLE REAL balance sets a
       * new high after the first fully-retired year has demonstrably left the
       * fragile zone, and distribution (and the lock) start the next year
       * instead of waiting out the full `deferYears`. REAL, not nominal: a
       * nominal high is set in almost every year of mild inflation and would
       * make the trigger meaningless. False = always wait the full window.
       */
      earlyRelease?: boolean;
      /**
       * Whether the carve-out opens with the one-time catch-up on gains that
       * were never tithed (phase 1). False starts it empty: the household
       * tithes what the portfolio earns from here on and lets the past lie.
       */
      seedFromExistingGains: boolean;
      /**
       * Mix the carve-out is seeded with. ABSENT MEANS THE PARENT IRA'S MIX.
       * Set it when the gift should be invested differently from the money
       * that has to fund a retirement — a longer horizon argues for more
       * equity, an imminent disbursement for less.
       *
       * It sets the STARTING mix. Allocation events reach the carve-out
       * afterwards exactly as they reach a 72(t) carve-out: an untargeted
       * allocation_change or glidepath sweeps every non-savings account, and a
       * targeted one naming the parent IRA follows through to it, because the
       * user only ever holds one account there.
       */
      allocation?: AssetMix;
    };

/**
 * What an absent `distributeYears` means, shared by the engine and the UI so
 * a blank box and the engine's arithmetic can never disagree about the same
 * plan. A round decade: long enough that the payout does not spike one year's
 * AGI (each instalment is ~a tenth of the pot, and AGI drives the ACA credit,
 * IRMAA and Social Security taxability), short enough that the household
 * actually sees the money given within a normal retirement.
 */
export const DEFAULT_TITHE_DISTRIBUTE_YEARS = 10;

/**
 * What an absent `earlyRelease` means. TRUE, deliberately: the deferral's
 * whole purpose is to shield the fragile first years, so once the plan has
 * provably outgrown them the default should release the gift rather than sit
 * on it — waiting out the calendar is the opt-in, not the release.
 */
export const DEFAULT_TITHE_EARLY_RELEASE = true;

/**
 * THE ONGOING METHOD — a RetirementGivingRule that is NOT the legacy bundled
 * 'tithe_account'. This is what the engine consumes: the bundle is normalised
 * into (ongoing method, UntithedPotPolicy) before PreparedSim is built, so a
 * variant carrying a pot inside it can never govern a simulation year.
 */
export type OngoingGivingRule = Exclude<RetirementGivingRule, { type: 'tithe_account' }>;

/**
 * THE UN-TITHED POT — the other half of the old bundled 'tithe_account' rule,
 * now its own decision on ProfileExpenses.untithedPot.
 *
 * WHY A PAIR. The user thinks in two independent decisions and said so:
 * (1) what to do with the pot — a share of the never-tithed gains, seeded at
 * retirement, held soft through the fragile first years, paid out over a
 * window, remainder to charity at death; and (2) how to tithe going forward —
 * a share of growth at new real highs, a share of income drawn, a fixed
 * amount, or nothing. The bundled rule fused them: choosing percent_of_income
 * silently meant "no pot at all". The pair lets each be configured alone.
 *
 * MECHANICS ARE UNCHANGED from the bundled rule (see the legacy variant's
 * four-phase description): seed at retirement, soft hold with the last-resort
 * draw order, lock at the earlier of `holdYears` elapsing and the safe-zone
 * early release, payout over `distributeYears`, remainder to charity at death.
 * This type only moves the knobs; tests pin the old and new paths bit-identical.
 *
 * ABSENT MEANS NO POT — exactly like every profile that never chose the
 * bundled rule. The `{ enabled: false }` form exists for SCENARIO OVERRIDES,
 * where absent means "inherit the profile's pot" and suppressing an inherited
 * pot therefore needs an explicit spelling (see AssumptionOverrides.expenses).
 */
export interface UntithedPotPolicy {
  /**
   * Present so `enabled` can be read off either member of UntithedPotSetting;
   * `true` and absent are the same policy.
   */
  enabled?: true;
  /**
   * Share of the never-tithed gains the seed takes (decimal fraction).
   * ABSENT MEANS 0.10 (DEFAULT_POT_PERCENT) — the tithe. This is the SEED's
   * percentage only; the ongoing growth tithe carries its own `percent`, which
   * is what lets the two be set independently at last.
   */
  percent?: number;
  /**
   * How many fully-retired years the pot HOLDS before it locks and starts
   * paying out — the old rule's `deferYears`, renamed for what it does: the
   * hold defers the POT, not necessarily the ongoing giving (see
   * `ongoingDuringHold`). 0 = lock on retirement day. While held the pot
   * counts as spendable and is reachable as the LAST RESORT.
   */
  holdYears: number;
  /** Years the locked pot takes to pay out. ABSENT MEANS 10 (DEFAULT_TITHE_DISTRIBUTE_YEARS). */
  distributeYears?: number;
  /**
   * Safe-zone early release: a new REAL spendable high after the first
   * fully-retired year closes the hold early. ABSENT MEANS TRUE
   * (DEFAULT_TITHE_EARLY_RELEASE — the release matches the hold's purpose).
   */
  earlyRelease?: boolean;
  /**
   * What the ONGOING method does while the pot holds:
   * - 'accrue_to_pot' (ABSENT MEANS THIS — it is the old bundled behaviour,
   *   which is why the migration can omit the key): a percent_of_growth
   *   ongoing method accrues its growth tithe INTO the pot instead of paying
   *   cash, exactly as the bundle did. Only a growth tithe has anything
   *   growth-shaped to accrue; under any other ongoing method the hold defers
   *   the POT alone and the ongoing method simply pays cash.
   * - 'give_cash': the ongoing method pays cash from retirement day, fully
   *   independent of the pot — the new capability the split exists for.
   */
  ongoingDuringHold?: 'accrue_to_pot' | 'give_cash';
  /**
   * Whether the pot opens with the one-time catch-up on gains never tithed
   * (the old rule's `seedFromExistingGains`). ABSENT MEANS TRUE
   * (DEFAULT_POT_SEED_FROM_GAINS) — the catch-up is the reason the pot exists.
   * False still leaves the pot real: an accruing hold can fill it from future
   * growth; it merely seeds nothing.
   */
  seedFromGains?: boolean;
  /** Mix the carve-out is seeded with. ABSENT MEANS THE PARENT IRA'S MIX. */
  allocation?: AssetMix;
}

/**
 * A pot field as stored: a policy, or the explicit "no pot" spelling.
 *
 * On the PROFILE the disabled form is redundant (absent already means no pot)
 * but legal. On a SCENARIO OVERRIDE the two differ: absent inherits the
 * profile's pot; `{ enabled: false }` suppresses it. The distinction is what
 * keeps an old override that REPLACED a bundled rule (and with it the pot)
 * meaning "no pot" after migration, instead of quietly resurrecting the
 * profile's pot — a saved plan.json is the case in point.
 */
export type UntithedPotSetting = UntithedPotPolicy | { enabled: false };

/** What an absent pot `percent` means: the tithe, 10%. */
export const DEFAULT_POT_PERCENT = 0.1;

/** What an absent `seedFromGains` means: seed the catch-up (the pot's purpose). */
export const DEFAULT_POT_SEED_FROM_GAINS = true;

/** What an absent `ongoingDuringHold` means: the old bundled behaviour. */
export const DEFAULT_POT_ONGOING_DURING_HOLD = 'accrue_to_pot' as const;

/**
 * The household's three monthly streams, each a PAIR: what is in play WHILE
 * WORKING and what is in play AFTER nobody works. The working value is the
 * required one and keeps its original name; the retired counterpart is
 * optional, and what its absence means differs per stream because the honest
 * default differs per stream (see each field).
 *
 * The switch happens on one signal for all three — the first year in which
 * nobody in the household earns a salary — and the retirement year itself is
 * prorated by the months worked.
 */
/**
 * ONE LINE OF THE HOUSEHOLD BUDGET, with its own answer for each of the three
 * states the plan has to model.
 *
 * WHY THREE EXPLICIT NUMBERS RATHER THAN RULES THE MODEL APPLIES FOR YOU.
 * The alternative was for the engine to "know" things — that investing stops
 * with the paycheck, that a survivor spends 75% of the couple's baseline. It
 * already knew one such thing, and it cost real money: $820/mo of housing sat
 * inside the living baseline while the engine ALSO modeled property tax and
 * insurance separately, double-charging it for thirty years. Nobody saw it,
 * because an invisible rule has nothing to look at.
 *
 * A global survivor percentage fails the same way on a real budget. A household
 * with ONE car does not see its $610 payment fall by a quarter when one of two
 * people dies — it does not fall at all. No single fraction expresses that;
 * three numbers per line express it exactly.
 *
 * So: the mechanism is completely generic and every figure is on screen and
 * editable. What used to be built-in knowledge survives only as DEFAULTS —
 * `defaultRetiredMonthly` and friends seed the column, and the user sees the
 * number and can argue with it. The behaviour is the same; the difference is
 * that it can be audited.
 */
export interface ExpenseLine {
  /** Stable id, so edits and reorders never re-key a row. */
  id: string;
  /** The user's own name for it, as it appears on their budget. */
  label: string;
  /** Which modeled stream this line feeds — see ExpenseLineCategory. */
  category: ExpenseLineCategory;
  /** $/month TODAY, while a salary is coming in. Today's dollars. */
  monthlyNow: number;
  /**
   * $/month once NOBODY works. Today's dollars.
   * ABSENT MEANS THE SAME AS `monthlyNow` — the honest default, since most
   * costs do not notice the salary stopping.
   */
  monthlyRetired?: number;
  /**
   * $/month while the household is BETWEEN HOMES — sold, renting, purchase
   * pending. Today's dollars. ABSENT MEANS WHATEVER IS OTHERWISE IN FORCE
   * (the working/retired figure for that month), because most lines do not
   * notice the dwelling: groceries cost the same in an apartment.
   *
   * The lines that DO notice it are why the column exists: heating oil and
   * the security system go to zero in an apartment, electricity roughly
   * halves. THE WINDOW IS NOT PROFILE DATA — it comes from the scenario's
   * housing plan (the sale month through the month before the purchase, the
   * same span the rent is charged for), so the same budget prices every
   * what-if move without editing a single line.
   *
   * LIVING LINES ONLY. Giving and investing do not change by dwelling, so
   * the engine never reads this field off those categories and their tabs
   * render no cell for it (LINE_TAB_COLUMNS). After a death the SURVIVOR
   * column governs and this one is ignored — see the engine's rule at the
   * blend site.
   */
  monthlyRenting?: number;
  /**
   * $/month for the SURVIVOR alone, from the month of death. Today's dollars.
   * ABSENT MEANS THE SAME AS whichever of the two above is in force — i.e. the
   * cost does not change, which is the right default for every household-level
   * line (the mortgage, the one car, the property tax) and wrong only for the
   * genuinely per-person ones, which is exactly where a number should be typed.
   */
  monthlySurvivor?: number;
  /** Free-text, e.g. which YNAB category it came from. */
  note?: string;
}

/**
 * Where a budget line goes in the model — and, just as importantly, which
 * lines go NOWHERE.
 *
 * The categories that do not feed a stream are the point of this type. A
 * budget contains rows that are not household consumption at all (credit-card
 * payments, when everything is run through a card for the cash back) and rows
 * the engine already models from its own inputs (property tax and insurance
 * from the housing plan, premiums from the health profile). Both must be
 * VISIBLE, so the transcribed budget reconciles against the real one, and
 * neither must be SUMMED. That is the double-count bug, encoded as a type so
 * it cannot happen twice.
 */
export type ExpenseLineCategory =
  /** Ordinary consumption. Sums into `livingMonthly`. */
  | 'living'
  /** Giving. Sums into `charitableMonthly`; the retired side is a RULE. */
  | 'charitable'
  /** Transfer to the brokerage, not consumption. Sums into `investingMonthly`. */
  | 'investing'
  /**
   * A life-insurance premium. Shown here so the budget reconciles, but the
   * POLICIES are authoritative for what is actually charged and until when —
   * see `lifeInsurancePolicies`. Never summed from here.
   */
  | 'insurance'
  /**
   * The engine already has this from somewhere else: property tax, home
   * insurance, maintenance, rent, mortgage (housing plan); health premiums
   * (health profile). Displayed for reconciliation, never summed.
   */
  | 'modeled_elsewhere'
  /** Not an expense — a transfer, a reimbursement, a placeholder. Never summed. */
  | 'excluded';

/** Categories that actually feed a modeled stream. The rest are display-only. */
export const SUMMED_EXPENSE_CATEGORIES = ['living', 'charitable', 'investing'] as const;

/**
 * ONE LIFE INSURANCE POLICY.
 *
 * A list, because a household can hold two with different expiry dates, and the
 * single-policy fields could not say so. Modeling them as one policy ending at
 * retirement is wrong in a way that costs the plan money in both directions:
 * it drops a $1,900/yr premium four years early AND it drops $2,500,000 of
 * coverage four years early, in exactly the years before Social Security
 * starts when a death would hurt most.
 */
export interface LifeInsurancePolicy {
  id: string;
  /** The carrier, or whatever the user calls it. */
  label: string;
  /** Person id insured. The benefit pays only if THIS person dies in term. */
  insured: string;
  /** Premium $/month in today's dollars. */
  premiumMonthly: number;
  /**
   * Face amount in NOMINAL dollars — level term does not inflate, and that
   * erosion is a real part of deciding how long to carry it.
   */
  deathBenefit: number;
  /** Coverage runs THROUGH this month. Absent = runs to the horizon. */
  termEnd?: YearMonth;
  /** Coverage starts here. Absent = already in force. */
  termStart?: YearMonth;
  /**
   * Whether the premium stops when the salary does, even if the term has not
   * expired. FALSE by default: a policy you are paying for is a policy you are
   * paying for, and dropping it is a DECISION the plan should show you making
   * rather than one it makes silently on your behalf.
   */
  cancelAtRetirement?: boolean;
  note?: string;
}

/**
 * A SCENARIO'S ANSWER to "what do we do with this policy?" — one per policy id,
 * in `AssumptionOverrides.expenses.lifeInsurancePolicyPlans`.
 *
 * The profile states the policies the household actually holds; whether to KEEP
 * holding one is a question about a plan, and it has to be askable per policy —
 * "drop the small one, keep the big one" is exactly the comparison a household
 * with two policies is weighing. The legacy single-policy override fields
 * cannot ask it: a non-empty policy list supersedes them entirely (see
 * resolvePolicies), which left three live-looking workbench inputs changing
 * nothing for any profile that had transcribed its policies.
 *
 * - 'cancel_now': the policy is out of this plan entirely — no premium charged,
 *   no benefit payable, from the first simulated month.
 * - 'cancel_at_retirement': forces `cancelAtRetirement` true — premium and
 *   cover both stop with the household's last paycheck.
 * - 'keep_to_term': forces `cancelAtRetirement` false — the policy stands on
 *   its own term dates whether anyone is earning or not.
 *
 * ABSENT — the whole map, or any policy's id — means the profile's own
 * configuration runs unchanged, which is what keeps every scenario written
 * before this field bit-identical.
 */
export type LifeInsurancePolicyPlan = 'cancel_now' | 'cancel_at_retirement' | 'keep_to_term';

export interface ProfileExpenses {
  /**
   * Monthly baseline consumption WHILE WORKING, in today's dollars. EXCLUDES
   * health premiums, housing items (property tax, insurance, maintenance,
   * rent, mortgage), charitable giving, and investing — the engine models
   * those separately.
   */
  livingMonthly: number;
  /**
   * THE ITEMISED BUDGET. When present and non-empty, the three scalar streams
   * (`livingMonthly`, `charitableMonthly`, `investingMonthly`) are DERIVED from
   * it — see `deriveExpenseStreams` — and the scalars become a cache of the
   * sum rather than an independent input.
   *
   * ABSENT OR EMPTY means the scalars are the truth, which is every profile
   * written before this field existed. Nothing about those profiles changes.
   */
  lines?: ExpenseLine[];
  /**
   * EVERY life insurance policy in force. When present and non-empty this
   * SUPERSEDES the single-policy fields below, which remain only so that
   * profiles written before it keep running unchanged.
   */
  lifeInsurancePolicies?: LifeInsurancePolicy[];
  /**
   * Monthly baseline consumption AFTER nobody works, in today's dollars.
   *
   * ABSENT MEANS THE SAME AS `livingMonthly`. Living costs do not drop the day
   * the salary stops — groceries, utilities, insurance and the rest carry
   * straight over — so "unchanged" is the honest default, and it is also the
   * behavior of every profile written before this field existed.
   *
   * Under the `fixed_percent` spending policy the policy still sets living
   * spending wholesale (a percentage of the start-of-year portfolio) and this
   * field is not consulted.
   */
  livingMonthlyRetired?: number;
  /**
   * Monthly charitable giving WHILE WORKING — its own stream, separate from
   * living expenses. Feeds the charitable tax deductions; scenarios can change
   * it via an expense_change event with category 'charitable'. The retired
   * side of this pair is `retirementGiving`, which is a RULE rather than a
   * plain number (see RetirementGivingRule).
   */
  charitableMonthly: number;
  /**
   * Monthly transfer to the taxable brokerage WHILE WORKING. NOT consumption:
   * it moves money between accounts (balance + basis) and is capped at the
   * year's available surplus, so it can never force a withdrawal.
   */
  investingMonthly: number;
  /**
   * Monthly transfer to the taxable brokerage AFTER nobody works.
   *
   * ABSENT MEANS 0 — investing out of a paycheck ends with the paycheck, which
   * is exactly what the engine did before this field existed. A household that
   * expects to keep investing in retirement (a big forced RMD, a pension it
   * does not spend) sets a figure here; it is capped at the year's surplus
   * exactly like the working stream, so it still can never force a withdrawal.
   */
  investingMonthlyRetired?: number;
  /**
   * Life insurance premium, $/month WHILE WORKING, in today's dollars. It goes
   * to ZERO the moment nobody earns a salary, prorated in the retirement year
   * like every other stream here.
   *
   * It is its own line rather than part of `livingMonthly` because it is the
   * one household expense with a built-in end date. Term life is INCOME
   * REPLACEMENT: it exists so that a salary disappearing early does not take
   * the household's future with it, and when there is no salary left to
   * replace there is nothing left for it to do. Folding it into living
   * expenses would carry a premium into retirement for thirty years that
   * nobody would actually pay.
   *
   * ABSENT MEANS 0 — a household that names no premium simply has none, and
   * every profile written before this field existed keeps its exact behaviour.
   *
   * IT MUST NOT ALSO BE IN `livingMonthly`. Like property tax and giving before
   * it, naming it here and leaving it in the baseline charges it twice.
   */
  lifeInsuranceMonthly?: number;
  /**
   * THE OTHER HALF OF THE POLICY: the face amount paid to the survivor if the
   * insured dies while the term is still running, in NOMINAL dollars.
   *
   * Nominal, not today's dollars, and deliberately: level term is a fixed
   * dollar face amount that does not inflate. A million-dollar policy pays a
   * million dollars in 2040, which is worth considerably less than a million
   * today — and that erosion is a real part of deciding how long to carry it.
   * Every other monthly figure in this interface IS in today's dollars, so
   * this one is the exception and says so.
   *
   * ABSENT MEANS 0 — a premium with no face amount is money leaving the
   * household that buys nothing, which is what the model did before this field
   * existed, and every profile written then keeps its exact behaviour.
   *
   * TAX TREATMENT: not income. IRC 101(a)(1) — "gross income does not include
   * amounts received (whether in a single sum or otherwise) under a life
   * insurance contract, if such amounts are paid by reason of the death of the
   * insured" — with no dollar cap and no filing-status condition. So it raises
   * neither AGI nor any MAGI variant: no ACA cliff, no IRMAA tier, no NIIT, no
   * effect on how much of the survivor's Social Security is taxable. The engine lands it
   * in savings like house-sale proceeds rather than routing it through the
   * income lines, which is also what keeps a working-year death from
   * "consuming" a seven-figure benefit as unbudgeted spending.
   */
  lifeInsuranceDeathBenefit?: number;
  /**
   * Last month of term coverage, "YYYY-MM" inclusive.
   *
   * ABSENT MEANS THE COVERAGE ENDS WITH THE PAYCHECK — the pre-existing rule,
   * where the premium is charged for the months somebody worked and the policy
   * is treated as gone the moment there is no salary left to replace. PRESENT
   * OVERRIDES THAT ENTIRELY: the premium is charged, and the death benefit is
   * payable, through this month whether or not anyone is still earning.
   *
   * This is the field that makes the user's question expressible: "five years
   * of term at retirement" is a premium, a face amount, and a term end five
   * years out. Answering it means comparing the widow score with the term and
   * after it lapses, which is exactly the comparison this pair enables.
   */
  lifeInsuranceTermEnd?: YearMonth;
  /**
   * First month the policy is in force. ABSENT = the simulation start, which
   * is the right default for a policy the household is already paying for.
   *
   * It exists because a term END alone cannot express the user's actual
   * question. "Five years of term AT RETIREMENT" is a policy bought in 2027
   * and lapsing in 2032 — but with only an end date the engine charged the
   * premium from 2026, seventy-eight months instead of sixty, and made the
   * policy look worse than it is at exactly the moment he is deciding whether
   * to buy one. A start and an end together say what he means.
   */
  lifeInsuranceTermStart?: YearMonth;
  /**
   * Person id whose life the policy covers. ABSENT = the first person in the
   * profile who draws a salary (income replacement insures the earner), and
   * failing that the first person. Only a `death` event on THIS person pays
   * the benefit.
   */
  lifeInsuranceInsured?: string;
  /**
   * The RETIRED SIDE OF GIVING: what giving does once nobody is earning a
   * salary any more. ABSENT MEANS { type: 'continue' } — the paycheck stream
   * keeps running, inflation adjusted, exactly as it did before this field
   * existed. `{ type: 'amount', monthly }` is the plain "a different number"
   * case; the other variants express rules the user cannot write as a fixed
   * figure (a share of real portfolio growth, a share of income drawn).
   *
   * In current files this is THE ONGOING METHOD — one half of the two-knob
   * decomposition (the other is `untithedPot` below). The legacy bundled
   * 'tithe_account' value is still parsed but is normalised into the pair at
   * load; see OngoingGivingRule and UntithedPotPolicy.
   */
  retirementGiving?: RetirementGivingRule;
  /**
   * THE UN-TITHED POT (UntithedPotPolicy) — the other half of the pair.
   * ABSENT MEANS NO POT, exactly like every profile that never chose the
   * bundled 'tithe_account' rule. Composes with ANY ongoing method above;
   * see UntithedPotPolicy.ongoingDuringHold for how the two interact while
   * the pot holds.
   */
  untithedPot?: UntithedPotSetting;
}

export interface HealthProfile {
  /**
   * Owner-supplied monthly benchmark (second-lowest-cost silver) premium quote
   * for the household at `acaQuoteYear` ages, used for the PTC. We assume the
   * household buys the benchmark plan, so gross premium = benchmark.
   */
  acaBenchmarkMonthly: number;
  acaQuoteYear: number;
  /** Monthly Part D plan premium per person in 2026 dollars (base, pre-IRMAA). */
  partDPlanMonthly: number;
  /**
   * Employee's share of the employer health premium, $/month. Modeled as a
   * pre-tax (Section 125) payroll deduction while working — reduces W-2 wages
   * like the 401(k) deferral — and ends at retirement when ACA takes over.
   */
  employerPremiumShareMonthly: number;
  notes?: string;
}

export interface SpendingPolicy {
  type: 'fixed_real' | 'fixed_percent' | 'guardrails';
  /** fixed_percent only: fraction of start-of-year portfolio to spend. */
  percent?: number;
  /**
   * guardrails only: the Guyton-Klinger band and the size of the correction.
   *
   * WHY THIS EXISTS. `fixed_real` spends the same real dollars through a 40%
   * crash — nobody does that, and assuming it understates every plan. But
   * `fixed_percent` overcorrects the other way: spending tracks the portfolio
   * every single year, so a 12% dip cuts the grocery budget 12% and the
   * household's standard of living swings with the market.
   *
   * Guardrails are what people actually do. Spending holds constant in real
   * terms while the CURRENT withdrawal rate (this year's spend over this
   * year's portfolio) stays inside a band around the rate the plan started at.
   * Drift above the upper rail and spending is cut by `adjustment`; drift below
   * the lower rail and it is raised by the same. Between the rails, nothing
   * happens — which is the entire point, and the difference from a percentage
   * rule.
   *
   * These are decisions, not facts, which is why they are configurable and why
   * the defaults are named rather than buried: `DEFAULT_GUARDRAILS`.
   */
  guardrails?: {
    /** Upper rail as a MULTIPLE of the initial withdrawal rate, e.g. 1.2. */
    upper: number;
    /** Lower rail as a multiple of the initial withdrawal rate, e.g. 0.8. */
    lower: number;
    /** Fractional cut or raise applied when a rail is breached, e.g. 0.1. */
    adjustment: number;
    /**
     * Never let real spending fall below this fraction of the plan's original
     * figure, however many cuts stack up. A rule with no floor can grind a
     * household down to nothing and still call the path a success.
     */
    floorFraction?: number;
    /**
     * Never let raises push real spending ABOVE this multiple of the plan's
     * original figure. ABSENT MEANS NO CEILING — the published Guyton-Klinger
     * prosperity rule, and the engine's behaviour before the knob existed,
     * bit for bit. 1.0 means "never spend above plan": the rails still cut
     * and still restore, but prosperity stops at the plan's own number. A
     * raise the ceiling absorbs entirely is not a raise (nothing moved), the
     * same ruling the floor already makes for an absorbed cut.
     */
    raiseCeiling?: number;
  };
}

/**
 * Guyton-Klinger's own numbers: rails at +/-20% of the initial withdrawal
 * rate, 10% corrections. The floor is ours, not theirs — the published rule has
 * none, and without one a bad sequence can stack cuts until the plan "succeeds"
 * on a standard of living nobody would accept.
 */
export const DEFAULT_GUARDRAILS: {
  readonly upper: number;
  readonly lower: number;
  readonly adjustment: number;
  /** Non-optional here (unlike the band): guardFloor's own fallback must exist. */
  readonly floorFraction: number;
  /**
   * Never present — absent = uncapped, the published prosperity rule — but
   * DECLARED so `(band ?? DEFAULT_GUARDRAILS).raiseCeiling` type-checks: the
   * engine reads the ceiling off whichever object that fallback yields.
   */
  readonly raiseCeiling?: number;
} = {
  upper: 1.2,
  lower: 0.8,
  adjustment: 0.1,
  floorFraction: 0.7,
} as const;

/**
 * One Monte Carlo path's guardrails history, reduced to the five facts the
 * aggregate cares about. The engine used to apply every cut and raise
 * internally and report only survival — a plan could be "97% safe" while
 * quietly funding that safety with spending cuts in a third of its futures,
 * and nothing on screen said so.
 */
export interface GuardrailPathStats {
  /**
   * A rail CUT spending at least once on this path. A cut the floor absorbed
   * entirely does not count — nothing about the household's spending moved.
   */
  everCut: boolean;
  /**
   * The lowest spending factor the path ever ran at, as a fraction of plan
   * (1 = never below plan). How DEEP the cuts went.
   */
  minFactor: number;
  /**
   * Years the path ran with its factor below 1 — how LONG the household
   * lived below plan, not how many times a rail fired (one cut that never
   * recovers counts every remaining year).
   */
  yearsBelow: number;
  /** Real spending ever ran strictly ABOVE plan (factor > 1) on this path. */
  everAbovePlan: boolean;
  /** A cut ran into the floor on this path (clamped, or absorbed entirely). */
  floorTouched: boolean;
}

/**
 * The guardrails cut/raise statistics across every simulated future
 * (RunResult.guardrailStats — present only under the guardrails policy).
 *
 * THE MEDIANS ARE CONDITIONAL ON CUTTING, deliberately: "typically bottoms at
 * 87% of plan" must describe the futures where a cut happened, and averaging
 * in the untouched majority (minFactor 1, zero years below) would dilute both
 * numbers toward "nothing happened" exactly when the user is asking how bad
 * it gets when something does.
 */
export interface GuardrailStats {
  /** Fraction of paths (0..1) on which a rail ever cut spending. */
  everCutFraction: number;
  /**
   * Median of `minFactor` AMONG THE PATHS THAT EVER CUT — how deep a cut
   * future typically bottoms. Null when no path cut (there is then no such
   * future to describe, not a depth of zero).
   */
  medianMinFactorAmongCut: number | null;
  /** Median of `yearsBelow` among the paths that ever cut. Null when none cut. */
  medianYearsBelowAmongCut: number | null;
  /** Fraction of paths on which spending ever ran strictly above plan. */
  everAbovePlanFraction: number;
  /** Fraction of paths on which a cut ran into the floor. */
  floorTouchedFraction: number;
  /**
   * The floor the run enforced (floorFraction, defaulted) — carried so the UI
   * can name "the 70% floor" from the result alone; a comparison run may have
   * used a different one.
   */
  floor: number;
  /** The raise ceiling in force, when the band named one. Absent = uncapped. */
  ceiling?: number;
}

export type WithdrawalBucket = 'cash' | 'taxable' | 'pretax' | 'roth';

export interface WithdrawalPolicy {
  /** Order in which buckets are tapped to cover spending. */
  order: WithdrawalBucket[];
  /**
   * Within pretax: which pre-tax accounts to tap first. ('rule_of_55_first'
   * was removed — the engine models an automatic 401(k)→IRA rollover at
   * separation, which makes it meaningless; old profiles migrate to
   * 'ira_first'.)
   */
  pretaxPreference: 'ira_first' | 'proportional';
}

export interface ProfileSettings {
  /** Simulate through the year both reach this age. */
  horizonAge: number; // default 95
  successTarget: number; // default 0.85
  mcPathsInteractive: number; // default 1000
  mcPathsFinal: number; // default 10000
  seed: number;
  /** Optional floor on terminal portfolio (real $) for "success". */
  terminalFloorReal?: number;
  spendingPolicy: SpendingPolicy;
  withdrawalPolicy: WithdrawalPolicy;
}

export interface Profile {
  people: Person[];
  filing: { status: FilingStatus; state: StateCode };
  accounts: Account[];
  home: Home;
  income: ProfileIncome;
  expenses: ProfileExpenses;
  health: HealthProfile;
  settings: ProfileSettings;
}

// ---------------------------------------------------------------------------
// Assumption data files
// ---------------------------------------------------------------------------

export interface DataFileMeta {
  year?: number;
  source?: string;
  verified_on?: string;
  needs_verification?: boolean;
  notes?: string;
}

export interface MarketAssumptions {
  meta?: DataFileMeta;
  /** Deterministic-mode fixed REAL returns per class. */
  deterministicReal: { stocks: number; bonds: number; bills: number };
  deterministicInflation: number;
  /** Expense-ratio drag per class (subtracted from nominal returns). */
  expenseRatios: { stocks: number; bonds: number; bills: number };
  /** Qualified-dividend yield on stocks (taxable accounts). */
  stockDividendYield: number;
  /** Block size (years) for bootstrap MC; 1-10. */
  bootstrapBlockYears: number;
  /** Home appreciation = CPI + this spread. */
  homeAppreciationRealSpread: number;
  /** Health premium growth = CPI + this spread (ACA + Medicare premiums). */
  medicalInflationRealSpread: number;
  /** Rent growth = CPI + this spread. */
  rentGrowthRealSpread: number;
  /**
   * What the bond sleeve is made of. `corporateFraction` (0..1) is the share
   * held in Baa corporates; the rest is 10-yr Treasuries. ABSENT = 0 = pure
   * Treasury, which is what the engine always modeled — the default must stay
   * bit-identical, so the whole object is optional rather than defaulted in
   * data.
   *
   * The blend happens where each sampled historical year's bond return enters
   * the engine: (1-f)*bonds10 + f*baa on the SAME row, so the 2008 trade
   * (Treasuries +20.10%, Baa -3.44%) is priced by history rather than by an
   * assumed correlation. ~0.30 approximates a total-bond fund like BND
   * (roughly a third credit); 1 is the visible extreme, not a recommendation.
   *
   * An assumption dial, not a plan decision: deliberately NOT a search axis.
   */
  bondComposition?: { corporateFraction: number };
  /**
   * NOMINAL annual yield on savings-account cash, as a decimal.
   *
   * ABSENT = the bills return for the year, which is what the engine did
   * before this existed and remains the right default for money genuinely
   * sitting in a bank account.
   *
   * It is here because a household holding a large cash balance for a year or
   * two — house-sale proceeds, a spending reserve — does not leave it earning
   * the T-bill rate by accident, and the difference is not academic: moving
   * $800,000 from the modelled ~3.1% to a 4.5% CD ladder adds roughly $11,000
   * to a single year's taxable interest, which is consumed almost entirely by
   * the ACA cliff's remaining headroom.
   *
   * NOMINAL rather than real on purpose: a CD or a T-bill is quoted nominally,
   * so this is the number the user reads off the offer sheet rather than one
   * they have to inflation-adjust in their head. It applies ONLY to savings
   * balances — the bills sleeve of an investment allocation keeps the market's
   * own bills return, because that is a market assumption rather than a choice
   * about where to park cash.
   */
  cashYieldNominal?: number;
}

export interface HistoricalRow {
  year: number;
  stocks: number;
  bonds10: number;
  tbills: number;
  cpi: number;
  /**
   * Baa corporate bond total return (Damodaran, same page and vintage as the
   * other columns; yield-derived, so it ignores defaults/downgrades and
   * slightly flatters corporates). Feeds the bondComposition blend; a row
   * without it cannot price a corporate sleeve, so the column is required.
   */
  baa: number;
}

export interface FederalBracket {
  rate: number;
  /** Upper bound of the bracket in base-year dollars; null = no limit. */
  upTo: number | null;
}

export interface FederalTaxData {
  meta?: DataFileMeta;
  baseYear: number; // 2026 — indexed values are inflated from this year
  bracketsMfj: FederalBracket[];
  /**
   * SINGLE ordinary brackets — its own literal table, never derived from the
   * MFJ one. The first five thresholds happen to be exactly half of MFJ, which
   * makes halving look safe; it is not. The 37% bracket opens at $640,600
   * single against $768,700 MFJ (a ratio of 0.833), and half of the MFJ figure
   * — $384,350 — is the MARRIED FILING SEPARATELY threshold, a status this
   * planner does not model. A halving implementation would silently understate
   * the top of a widow's bracket run by a quarter of a million dollars.
   */
  bracketsSingle: FederalBracket[];
  standardDeductionMfj: number;
  /** SINGLE standard deduction (§63(c)(2)); happens to be half of MFJ for 2026. */
  standardDeductionSingle: number;
  /** Additional standard deduction per spouse 65+, MFJ. */
  additionalStdDeduction65: number;
  /**
   * Additional standard deduction at 65+ (or blind) for an UNMARRIED filer,
   * §63(f): "The additional standard deduction amount is increased to $2,050 if
   * the individual is also unmarried and not a surviving spouse." A widow with
   * no dependent child is not a §2(a) surviving spouse, so they get the higher
   * unmarried figure — the one crumb of comfort in the widow penalty, and it
   * must not be dropped by reusing `additionalStdDeduction65` (the married
   * per-spouse amount) for both statuses.
   */
  additionalStdDeduction65Unmarried: number;
  ltcgBreakpointsMfj: { zeroRateTop: number; fifteenRateTop: number };
  /**
   * SINGLE LTCG breakpoints. Same trap as the brackets in a different place:
   * zeroRateTop IS exactly half of MFJ, fifteenRateTop is NOT ($545,500 single
   * vs $613,700 MFJ; half would be $306,850, the MFS figure).
   */
  ltcgBreakpointsSingle: { zeroRateTop: number; fifteenRateTop: number };
  /** Statutory, unindexed. */
  niitThresholdMfj: number;
  /**
   * SINGLE NIIT threshold, §1411(b)(3). Statutory and UNINDEXED like the MFJ
   * figure. §1411(b)(1) grants the $250,000 threshold to "a taxpayer making a
   * joint return under section 6013 OR a surviving spouse (as defined in
   * section 2(a))" — and a widow with no dependent child is neither, from the
   * first full year after the death.
   */
  niitThresholdSingle: number;
  niitRate: number;
  /** Statutory, unindexed provisional-income thresholds MFJ. */
  ssTaxationThresholdsMfj: { tier1: number; tier2: number };
  /**
   * SINGLE provisional-income thresholds, §86(c): $25,000 / $34,000.
   * Statutory and unindexed, exactly like the MFJ pair. This is one of the
   * sharpest edges of the widow penalty — the same benefit becomes taxable
   * $7,000 of provisional income earlier.
   */
  ssTaxationThresholdsSingle: { tier1: number; tier2: number };
  earlyWithdrawalPenaltyRate: number; // 0.10
  /** SALT itemized-deduction cap by year; fallback used for years past the map. */
  saltCapByYear: Record<string, number>;
  saltCapFallback: number;
  /**
   * OBBBA 2025-2029 phase-down of the elevated SALT cap: cap reduced by
   * `rate` x (MAGI - threshold), floored at `floor`. Threshold ~= $505k (2026).
   */
  saltPhaseDown: { magiThreshold: number; rate: number; floor: number };
  /** §121 primary-residence gain exclusion, MFJ. */
  homeSaleExclusionMfj: number;
  /**
   * §121 exclusion for an unmarried filer, §121(b)(1).
   *
   * A WIDOW DOES NOT NECESSARILY DROP TO THIS. §121(b)(4) preserves the full
   * $500,000 "if such sale occurs not later than 2 years after the date of
   * death of such spouse and the requirements of paragraph (2)(A) were met
   * immediately before such date of death" — which is exactly the window a
   * household planning to sell around retirement lands in. The engine applies
   * the two-year rule (tax/federal.ts, homeSaleExclusionFor); modelling a
   * survivor's sale at a flat $250,000 would overstate their tax in precisely the
   * scenario the widow score is built to test.
   */
  homeSaleExclusionSingle: number;
  /**
   * 2026 OBBBA charitable provisions:
   * - nonItemizerDeductionMfj: above-the-line charitable deduction for
   *   non-itemizers, MFJ.
   * - nonItemizerDeductionSingle: the same for a single filer (IRC 170(p)):
   *   $1,000, statutory and never indexed.
   * - itemizerAgiFloor: floor on itemized charitable deductions as a fraction
   *   of AGI (only giving above AGI x floor is deductible).
   */
  charitable: {
    nonItemizerDeductionMfj: number;
    nonItemizerDeductionSingle: number;
    itemizerAgiFloor: number;
  };
}

export interface StateTaxData {
  meta?: DataFileMeta;
  state: StateCode;
  baseYear: number;
  /**
   * 'brackets': tax = brackets over state taxable income (VA, SC).
   * 'flat': single rate (NC).
   */
  kind: 'brackets' | 'flat';
  brackets?: FederalBracket[];
  /** NC: rate by year (declining schedule); fallback for later years. */
  flatRateByYear?: Record<string, number>;
  flatRateFallback?: number;
  /** VA/NC: state standard deduction MFJ. SC starts from federal taxable income. */
  standardDeductionMfj?: number;
  /**
   * Year-specific MFJ standard deduction schedule (e.g. Virginia's enacted
   * 2025-2029 elevated amounts). Resolution for a tax year:
   * standardDeductionMfjByYear?.[String(year)] ?? standardDeductionMfj —
   * i.e. years absent from the map fall back to standardDeductionMfj.
   */
  standardDeductionMfjByYear?: Record<string, number>;
  /**
   * SINGLE state standard deduction, and its year-specific schedule — the same
   * two-field shape as the MFJ pair above and resolved the same way.
   *
   * At the STATE level the widow penalty is almost entirely a deductions
   * story, not a bracket story: Virginia taxes "every individual" on one
   * bracket table (§58.1-320), South Carolina's $30,000 bracket threshold does
   * not vary by status, and North Carolina is flat. What halves is this.
   */
  standardDeductionSingle?: number;
  standardDeductionSingleByYear?: Record<string, number>;
  /** 'federal_agi' (VA, NC) or 'federal_taxable_income' (SC). */
  startingPoint: 'federal_agi' | 'federal_taxable_income';
  /** All three states exclude SS from state tax. */
  socialSecurityTaxed: boolean;
  /**
   * VA: $12k per person 65+, phased out $1-for-$1 over AFAGI threshold.
   *
   * `afagiThresholdSingle` is the one VA figure that is NOT proportional:
   * §58.1-322.03(5.b) reads "$50,000 for single taxpayers or $75,000 for
   * married taxpayers" — the threshold falls by a third, not by half, so a
   * widow's age deduction starts phasing out $25,000 of income earlier than a
   * halving rule would predict. Encoded explicitly for that reason.
   */
  vaAgeDeduction?: {
    perPerson65Plus: number;
    afagiThresholdMfj: number;
    afagiThresholdSingle?: number;
  };
  /** VA personal exemptions: $930/person + $800 extra per person 65+. */
  vaExemptions?: { perPerson: number; additional65: number };
  /** SC: retirement-income + 65+ deductions, and the 2026 SCIAD. */
  scDeductions?: {
    retirementDeductionUnder65: number;
    retirementDeduction65Plus: number;
    /** Per-taxpayer 65+ deduction, reduced by retirement deduction claimed. */
    seniorDeduction65Plus: number;
    /**
     * SC Income Adjusted Deduction (H.4216, TY2026+): flat deduction replacing
     * the federal standard deduction, reduced proportionally by
     * (FAGI - phaseoutStart) / phaseoutRange, to zero.
     *
     * The `...Single` trio is the single-filer version: $15,000, phasing out
     * from FAGI $40,000 over a $55,000 range (gone at $95,000). Every SC figure
     * here happens to be exactly half the MFJ one, which is why they are
     * written out rather than derived — "it happens to be half this year" is
     * not a rule, and the federal 37% bracket and the top IRMAA tier are the
     * standing proof of what assuming it costs.
     *
     * The retirement-income and 65+ deductions above need no single variants:
     * they are already PER INDIVIDUAL TAXPAYER (§12-6-1170), and the engine
     * applies them per person in the tax household.
     */
    sciad?: {
      amountMfj: number;
      phaseoutStartMfj: number;
      phaseoutRangeMfj: number;
      amountSingle?: number;
      phaseoutStartSingle?: number;
      phaseoutRangeSingle?: number;
    };
  };
  /** Whether bracket thresholds / deductions index with inflation in the sim. */
  indexed: boolean;
}

export interface SocialSecurityData {
  meta?: DataFileMeta;
  fraYearsByBirthYear: Record<string, number>; // '1960+' -> 67
  fraDefaultYears: number; // 67
  /** Worker benefit early-claim reduction: per month for first 36, then per month beyond. */
  workerReductionFirst36PerMonth: number; // 5/9 of 1%
  workerReductionBeyond36PerMonth: number; // 5/12 of 1%
  delayedCreditPerMonth: number; // 2/3 of 1%
  maxClaimAge: number; // 70
  minClaimAge: number; // 62
  /** Spousal: 50% of worker PIA at spouse FRA; reduced when claimed early; no delayed credits. */
  spousalMaxPctOfPia: number; // 0.5
  spousalReductionFirst36PerMonth: number; // 25/36 of 1%
  spousalReductionBeyond36PerMonth: number; // 5/12 of 1%

  // --- Survivor (widow/widower) benefit ------------------------------------
  // A survivor benefit is NOT a bigger spousal benefit. It is 100% of the
  // deceased's PIA rather than 50%, it can start at 60 rather than 62, it uses
  // a DIFFERENT full-retirement-age table, and it is reduced on a completely
  // different schedule. Reusing any worker or spousal parameter here produces
  // a number that is wrong at every claim age.

  /**
   * Survivor FRA by birth year — its own table (20 CFR 404.409(b)), NOT the
   * retirement table in `fraYearsByBirthYear`. They agree at 67 for anyone
   * born 1/2/1962 or later but diverge in between (FRA 66 covers 1943-1955 for
   * retirement and 1945-1957 for survivors), so a general model must not reuse
   * one for the other. Same key convention: "1962" means "born 1962 or later".
   */
  survivorFraYearsByBirthYear: Record<string, number>;
  survivorFraDefaultYears: number; // 67
  /** Earliest survivor claim: 60, not 62 (20 CFR 404.409(c)). */
  survivorMinClaimAge: number; // 60
  /**
   * Maximum survivor reduction, 28.5% at the minimum claim age, spread EVENLY
   * across the whole 60-to-survivor-FRA window (20 CFR 404.410(c)(1)): the
   * per-month reduction is 0.285 / (months from 60 to survivor FRA). There is
   * no 36-month kink like the worker benefit — for survivor FRA 67 the window
   * is 84 months and the published fraction is 19/56 of 1% per month
   * (0.285/84 = 0.0033928571 exactly).
   */
  survivorMaxReduction: number; // 0.285
  /**
   * Floor/cap when the deceased had already claimed EARLY (the RIB-LIM rule,
   * POMS RS 00615.320): the survivor's benefit is the larger of this fraction
   * of the deceased's PIA and the reduced benefit the deceased was actually
   * receiving. It is as much a floor as a cap — the widow of a man who claimed
   * at 62 is not dropped to a 70%-of-PIA cheque. Inert whenever the deceased
   * claimed at or after FRA, which is this household's plan; it goes live the
   * moment a scenario drags the claim age below FRA.
   */
  survivorRibLimFloorPctOfPia: number; // 0.825
  /**
   * One-time lump-sum death payment to a surviving spouse: $255. Statutory
   * (Social Security Act §202(i)) and frozen at that figure since the 1981
   * amendments — it is not indexed and never has been. It is financial noise
   * against a seven-figure plan, and it is here because modelling it correctly
   * costs one line and leaving it out invites the question every time.
   */
  lumpSumDeathPayment: number; // 255
}

export interface MedicareData {
  meta?: DataFileMeta;
  baseYear: number;
  partBStandardMonthly: number;
  /** Part D base beneficiary premium used for IRMAA math (plan premium comes from profile). */
  partDBaseMonthly: number;
  /**
   * MFJ IRMAA tiers in base-year dollars. magiOver of first tier is the standard
   * boundary. Thresholds and premiums are CPI-indexed in the sim.
   */
  irmaaTiersMfj: Array<{
    magiOver: number;
    partBTotalMonthly: number;
    partDAddOnMonthly: number;
  }>;
  /**
   * SINGLE IRMAA tiers. The premium AMOUNTS are identical tier-for-tier; only
   * the MAGI thresholds move — which is the whole point, because a widow
   * drawing the same income can jump one or two tiers purely from the filing
   * change.
   *
   * THE TRAP: the first four thresholds are exactly half the MFJ ones
   * ($218k/$274k/$342k/$410k -> $109k/$137k/$171k/$205k), but the top tier is
   * $500,000 single against $750,000 MFJ. A "divide by two" implementation
   * would put it at $375,000 and overcharge IRMAA for every widow with MAGI
   * between $375,000 and $500,000.
   */
  irmaaTiersSingle: Array<{
    magiOver: number;
    partBTotalMonthly: number;
    partDAddOnMonthly: number;
  }>;
  medicareStartAge: number; // 65
  /** IRMAA uses MAGI from this many years prior. */
  magiLookbackYears: number; // 2
}

export interface AcaData {
  meta?: DataFileMeta;
  baseYear: number;
  /** FPL for a 2-person household (48 states), for the base coverage year; CPI-indexed. */
  fpl2Person: number;
  /**
   * FPL for a ONE-person household — the survivor's denominator, and quite
   * possibly the largest single driver of a widow score. A household that
   * retires in its mid-fifties sits on the exchange for roughly nine years
   * before Medicare, and the 400%-of-FPL cliff for one person is 4 x $15,650 =
   * $62,600 against $84,600 for the couple. The same withdrawal that cleared
   * the cliff by $20,000 as a couple is $20,000 over it as a widow, and the
   * entire credit is forfeited.
   *
   * The applicable-percentage table itself is household-size independent (the
   * same Rev. Proc. schedule applies), so only this denominator changes.
   */
  fpl1Person: number;
  /**
   * Applicable-percentage schedule when enhanced credits are NOT in effect
   * (pre-ARPA law: 400% FPL cliff). Rows: linear interpolation pctFrom->pctTo
   * across fplFrom->fplTo.
   */
  applicablePctTable: Array<{
    fplFrom: number;
    fplTo: number | null;
    pctFrom: number;
    pctTo: number;
  }>;
  /** Enhanced (ARPA-style) schedule: capped 8.5%, no cliff. */
  applicablePctTableEnhanced: Array<{
    fplFrom: number;
    fplTo: number | null;
    pctFrom: number;
    pctTo: number;
  }>;
  /** Scenario-togglable: Congress keeps fighting about it. */
  enhancedCreditsExtended: boolean;
  /**
   * Medicaid-expansion status per modeled state (VA expanded 2019, NC 2023,
   * SC never). In an expansion state a household with ACA MAGI below
   * medicaidThresholdFpl is modeled as Medicaid-enrolled: $0 premium, no PTC.
   */
  medicaidExpansion: Record<StateCode, boolean>;
  /** Medicaid eligibility ceiling as a multiple of FPL (1.38 = 138% in expansion states). */
  medicaidThresholdFpl: number;
  /** Federal age-rating curve used to scale the user's benchmark quote by age. */
  ageCurve: Record<string, number>;
}

export interface RmdTableData {
  meta?: DataFileMeta;
  /** Uniform Lifetime Table: age -> distribution period (divisor). */
  uniformLifetimeTable: Record<string, number>;
  /** Both owners born after 1960 -> RMDs begin at this age. */
  rmdStartAge: number; // 75
}

export interface Assumptions {
  market: MarketAssumptions;
  historical: HistoricalRow[];
  federal: FederalTaxData;
  states: Record<StateCode, StateTaxData>;
  socialSecurity: SocialSecurityData;
  medicare: MedicareData;
  aca: AcaData;
  rmd: RmdTableData;
}

// ---------------------------------------------------------------------------
// Scenarios & events
// ---------------------------------------------------------------------------

/**
 * Default share of the COUPLE's living baseline a lone survivor is modelled to
 * spend, when a `death` event does not name one.
 *
 * There is no primary source for this number and there cannot be — it is a
 * judgment about one household's consumption, not a statute. The literature
 * gives a range: the OECD-modified equivalence scale puts two adults at 1.5
 * consumption units against 1.0 for one (0.67), the square-root scale gives
 * 1/sqrt(2) = 0.71, and retirement-planning practice commonly uses 70-80%.
 *
 * 0.75 sits in that range, on the higher side, ON PURPOSE. The equivalence
 * scales are built for TOTAL household spending, and this baseline is not
 * total: housing, property tax, insurance, maintenance, rent and mortgage are
 * modelled separately by the housing module, and health premiums separately
 * again. Those are the costs that fall LEAST when a household halves — a house
 * does not become cheaper to heat — so stripping them out leaves a remainder
 * (food, personal, transport, discretionary) that should fall further than the
 * whole would. But the remainder still carries genuinely fixed items: one car
 * does not become half a car, subscriptions and insurance do not halve.
 *
 * Erring high is the conservative direction for a widow score: it spends more
 * of that money, so it reports a lower probability of success. A household that
 * has actually thought about it should set `livingFraction` on the event and
 * argue with this number rather than inherit it.
 */
export const DEFAULT_SURVIVOR_LIVING_FRACTION = 0.75;

export type ScenarioEvent =
  | { type: 'retire'; person: string; date: YearMonth }
  | { type: 'claim_social_security'; person: string; date: YearMonth }
  /**
   * ONE PERSON DIES. The event behind the widow score.
   *
   * What it does, in the order the year sees it:
   * - TAX. The year of death is still MFJ (IRC 6013(a)(3)); every year after
   *   is SINGLE, with no qualifying-surviving-spouse grace period available to
   *   a household with no dependent child. The deceased remains in the tax
   *   household for the death year itself (a joint return counts both) and is
   *   gone from it after, which is what drops the household to one standard
   *   deduction, one personal exemption, one Medicare enrollee and a
   *   one-person federal poverty level.
   * - SOCIAL SECURITY. The deceased's benefit stops (no benefit is payable for
   *   the month of death); the survivor is paid the LARGER of their own benefit
   *   and a survivor benefit worth 100% of the deceased's PIA — so a household
   *   drawing that benefit plus a 50% spousal top-up loses exactly a third of
   *   its
   *   Social Security, permanently, in the same year it starts filing
   *   single.
   * - ACCOUNTS. Everything the deceased owned passes to the survivor by
   *   SPOUSAL ROLLOVER: the IRA becomes the SURVIVOR'S IRA on the SURVIVOR'S
   *   required-distribution schedule, not an inherited IRA on the 10-year
   *   rule, and the 401(k) rolls to an IRA of theirs. Taxable holdings take a
   *   basis step-up. Any 72(t) series of the deceased's ends — death is an
   *   exception to the modification rules — so the account unlocks instead of
   *   forcing payments out of a dead person's IRA.
   * - SPENDING. The household is one person: living costs fall to
   *   `livingFraction` of the couple's baseline and health coverage covers one.
   * - INSURANCE. A term policy on the deceased that is still in force pays its
   *   face amount to the survivor, tax-free (IRC 101(a)(1)).
   *
   * NOT MODELLED: probate, estate tax (the unlimited marital deduction makes
   * it moot for a spouse), final medical or funeral costs, and any change to
   * the survivor's own earnings.
   */
  | {
      type: 'death';
      /** Person id who dies. At least one person must survive. */
      person: string;
      /**
       * Month of death. Benefits, salary and premiums run through the month
       * BEFORE this one, matching the `retire` convention (retiring in month m
       * means months 1..m-1 were worked) and the Social Security rule that no
       * benefit is payable for the month of death.
       */
      date: YearMonth;
      /**
       * Share of the couple's living baseline the survivor spends, from the
       * month of death. ABSENT = DEFAULT_SURVIVOR_LIVING_FRACTION — see that
       * constant for the (entirely non-statutory) reasoning, which is exactly
       * the kind of assumption that should be argued with rather than
       * inherited. 1 models a survivor whose costs do not fall at all.
       */
      livingFraction?: number;
      /**
       * Month the survivor's own benefit starts, when they have not already
       * claimed. ABSENT means the plan's own answer: the later of the month of
       * death and whatever `claim_social_security` date the scenario already
       * gives them, floored at the survivor minimum claim age of 60.
       *
       * WHY THAT DEFAULT: a widow already collecting converts automatically in
       * the month of death (correct, and it is what the plan says they do).
       * One who has not claimed yet has a real decision — 71.5% at 60 against
       * 100% at survivor FRA — and silently making it for them would let a
       * death event quietly rewrite a claiming choice the user made on
       * purpose. So the plan's stated intent stands unless this says otherwise.
       * Never earlier than 60: there is no benefit before it.
       */
      survivorClaim?: YearMonth;
    }
  | {
      type: 'expense_change';
      date: YearMonth;
      multiplier?: number;
      delta?: number;
      /** Which expense stream to change; absent = 'living'. */
      category?: 'living' | 'charitable';
    }
  | { type: 'state_change'; date: YearMonth; state: StateCode }
  | { type: 'sell_house'; date: YearMonth }
  | { type: 'rent'; start: YearMonth; months: number; monthlyCost: number }
  | {
      type: 'buy_house';
      date: YearMonth;
      price: number | 'sale_proceeds';
      financing:
        | 'cash'
        | {
            downPct: number;
            rate: number;
            termYears: number;
            /**
             * Pay the remaining principal in ONE lump this many years after
             * origination (same calendar month, N years later), drawn from the
             * portfolio through the ordinary withdrawal order — taxed and
             * penalized like any other big cash need that year. From the
             * payoff month, interest and payments stop; property tax and
             * insurance continue. ABSENT = amortize the full term. Must be
             * strictly below termYears; a value at/after maturity is ignored
             * (the schedule already amortizes to zero by then).
             */
            payoffAfterYears?: number;
          };
      propertyTaxAnnual: number;
      insuranceAnnual: number;
    }
  | {
      type: 'allocation_change';
      date: YearMonth;
      mix: AssetMix;
      /** Account id to target; absent = all non-savings accounts. */
      account?: string;
    }
  | {
      type: 'glidepath';
      start: YearMonth;
      end: YearMonth;
      fromMix: AssetMix;
      toMix: AssetMix;
      /** Account id to target; absent = all non-savings accounts. */
      account?: string;
    }
  | { type: 'withdrawal_strategy'; date: YearMonth; policy: WithdrawalPolicy }
  | { type: 'one_time_expense'; date: YearMonth; amount: number }
  | { type: 'one_time_income'; date: YearMonth; amount: number; taxable?: boolean }
  | {
      type: 'start_72t';
      date: YearMonth;
      account: string;
      /**
       * Desired SEPP annual payment. The engine caps it at the IRS
       * fixed-amortization formula maximum for the account — models the
       * split-IRA technique (a smaller desired payment implies carving off a
       * smaller IRA slice). Absent = the formula maximum.
       */
      annualAmount?: number;
      /**
       * Amortization interest rate (decimal, 0-0.06). Absent = the Notice
       * 2022-6 cap (greater of 5% or 120% of the mid-term AFR).
       */
      interestRate?: number;
    }
  | {
      type: 'roth_conversion';
      date?: YearMonth;
      yearly?: boolean;
      amount?: number;
      /** Convert up to the top of the bracket whose rate is <= this (e.g. 0.12). */
      toBracketTop?: number;
    };

// ---------------------------------------------------------------------------
// Housing plan (first-class move modelling)
// ---------------------------------------------------------------------------

/**
 * How the replacement house is paid for.
 *
 * CASH: the whole price is a cash outflow in the purchase year. It is met by
 * the household's ordinary withdrawal order — savings (where the sale proceeds
 * landed) first, then the taxable brokerage, then the IRA. So "use all the cash
 * on hand and take the rest from the IRA" is not special-cased anywhere; it is
 * what the existing ordering already does with a large one-off outflow.
 *
 * MORTGAGE: only the down payment is a cash outflow; the remainder becomes an
 * amortizing loan whose payments are a housing cost for the rest of the run.
 * Sale proceeds beyond the down payment are not left idle — the engine moves
 * them into the taxable brokerage (SPEC §9.3), from which living costs are
 * drawn before the IRA is touched.
 */
export type HousingFinancing =
  | { type: 'cash' }
  | {
      type: 'mortgage';
      /**
       * Down payment as a fraction of the purchase price.
       *
       * ABSENT = 0.20, the level at which conventional mortgage insurance stops
       * applying. Values below 0.20 are allowed and are NOT free: the existing
       * housing module charges PMI at 0.5%/yr of the loan balance for any loan
       * originated under 20% down (see engine/housing.ts), and this plan feeds
       * that same machinery rather than re-implementing it.
       */
      downPct?: number;
      /** Annual nominal note rate as a decimal. ABSENT = DEFAULT_MORTGAGE_RATE. */
      rate?: number;
      /** Amortization term in years. ABSENT = DEFAULT_MORTGAGE_TERM_YEARS (30). */
      termYears?: number;
      /**
       * Pay off the remaining principal N years after origination, in one lump
       * from the portfolio through the ordinary withdrawal machinery.
       *
       * The lump lands in the same calendar month the house was bought, N
       * years later, and it is a committed cash need of that year exactly like
       * a purchase top-up: the withdrawal order funds it (taxed draws,
       * penalties under 59 1/2 where they apply), the automatic 72(t) bridge's
       * calendar-aware carve reserves for it, and a year the portfolio cannot
       * afford follows the ordinary shortfall path — never a hard stop. From
       * the payoff month, interest, payments and any PMI stop; property tax,
       * insurance and maintenance continue.
       *
       * ABSENT = amortize the full term, bit-identical to before this field
       * existed. Must be strictly below the effective term (the schema rejects
       * a stated violation; against the DEFAULT 30-year term the 1..29 bounds
       * make one impossible to state).
       */
      payoffAfterYears?: number;
    };

/**
 * A move, modelled as first-class plan configuration rather than as three
 * hand-written events.
 *
 * This lives on the SCENARIO, not the profile: the profile holds the house the
 * household HAS, the plan holds what it will DO with it. Two scenarios can
 * therefore disagree about the move — sell in 2027 vs 2029, rent 12 months vs
 * 24, cash vs mortgage — while sharing one profile.
 *
 * It is a CONFIGURATION SURFACE, not a second housing engine. The engine
 * compiles it down to the `sell_house` / `rent` / `buy_house` events the
 * pipeline has always consumed (engine/housingPlan.ts), so the proven sale /
 * §121 / PMI / amortization / withdrawal-ordering machinery is untouched.
 *
 * PRESENCE SUPERSEDES: when a scenario carries `housing`, every hand-written
 * `sell_house`, `rent` and `buy_house` event in that scenario is DISCARDED —
 * the plan is the single source of truth for the move, and a plan that quietly
 * stacked on top of leftover events would double-sell the house. When
 * `housing` is absent, nothing changes at all: those events behave exactly as
 * they always have.
 */
export interface HousingPlan {
  /** Month the current (profile) home is sold. */
  sellDate: YearMonth;
  /**
   * Nominal annual home appreciation, as a decimal (0.03 = 3%/yr).
   *
   * This REPLACES the engine's usual home growth rate (CPI +
   * `market.homeAppreciationRealSpread`); it is not added on top of it. The
   * sale price is therefore exactly the profile home value compounded at this
   * rate from the simulation start year to the sale year, which is what makes
   * the projected sale price predictable enough to reason about. The
   * replacement house appreciates at the same rate once bought — one rate, one
   * rule, no silent switch back to the market assumption mid-run.
   *
   * ABSENT = keep the engine's CPI-linked growth (which is stochastic per path
   * in Monte Carlo mode, so the sale price varies across paths).
   */
  appreciationRate?: number;
  /**
   * Months spent renting between the sale and the purchase. 0 means buying in
   * the same month the old house sells (no rental period at all).
   */
  rentMonths: number;
  /**
   * Rent in dollars per month, in SALE-YEAR dollars.
   *
   * Not today's dollars, and this was documented wrong in both directions. The
   * engine rebases the rent index to the rental's own start year, so the
   * multiplier is exactly 1.0 in the first rented year however far away it is:
   * $3,000/mo produces the same $21,000 for seven months whether the sale is in
   * 2027 or 2032. Rent then grows with rent inflation for the REST of the
   * tenancy.
   *
   * So enter what you expect to pay WHEN YOU MOVE, not what that flat costs
   * today. For a sale a year or two out the difference is small; for one a
   * decade out, entering today's rent understates it by a quarter or more.
   */
  rentMonthly: number;
  /**
   * Purchase price of the replacement house, in nominal dollars at the
   * purchase date. Entered by the user — unlike the sale price, this is a
   * decision, not a projection.
   *
   * 'sale_proceeds' means "buy with whatever the move leaves", and it is NOT a
   * synonym for the headline sale figure. The engine caps such a purchase at
   * the cash that actually survived (housing.ts), so a year of renting and
   * living comes out of the proceeds first and the house gets the remainder —
   * and, because it is a RESIDUAL claim rather than a fixed one, the automatic
   * 72(t) does not reserve it and so does not elect a year early to fund a
   * house the household was never going to overpay for. Entering the same
   * dollar figure as a NUMBER means the opposite: a firm commitment the bridge
   * must reserve, and any shortfall comes out of the IRA — which is exactly how
   * to model buying a bigger house than the sale paid for.
   *
   * 'none' means SELL AND RENT FROM THEN ON: no replacement house is bought,
   * and the rent runs to the horizon rather than for `rentMonths`. It exists
   * because the obvious way to say that — a purchase price of 0 — used to
   * model a household that owned nothing, rented nothing and paid no housing
   * costs at all for the rest of its life.
   */
  purchasePrice: number | 'sale_proceeds' | 'none';
  /**
   * The price the SURVIVOR buys at when a death lands strictly before the
   * purchase month. ABSENT = the plan price, exactly as before this field
   * existed.
   *
   * WHY IT EXISTS: the widow score used to model the survivor executing the
   * deceased's purchase as written. On a representative plan that meant the
   * survivor carrying out a $1.2M house purchase without the deceased's last
   * two salary years — 62.7% if the death is immediate — a thing no survivor
   * would actually do; priced at the sale proceeds instead it scores 100.0%.
   * This field lets the plan SAY what the survivor would really do, so every
   * death event compiled before the buy month (hand-written, the widow sweep's
   * probes, the search's widow probe) buys at THAT price instead.
   *
   * 'sale_proceeds' means buying whatever the sale nets — the always-safe
   * answer, and a RESIDUAL claim exactly like the plan-level spelling: the
   * 72(t) bridge reserves nothing for it. A death IN or AFTER the buy month
   * changes nothing — the house is already bought.
   */
  survivorPurchasePrice?: number | 'sale_proceeds';
  /**
   * What the SURVIVOR does with the house when a death lands IN OR AFTER the
   * purchase month — the post-purchase counterpart of `survivorPurchasePrice`,
   * and the two fields partition the death timeline at the buy month: strictly
   * before it the survivor buys at their own price; at or after it the house is
   * already bought and this field says whether they keep it. ABSENT = the
   * survivor keeps the home as bought, exactly as before the field existed.
   *
   * A NUMBER: `survivorDownsizeDelayMonths` after the death month the survivor
   * sells the home (ordinary engine machinery — selling costs, §121, proceeds
   * to savings) and rebuys at this price, cash, in the same month. Cash because
   * the sale of the larger house is the funding: a downsize that needs a
   * mortgage is a different plan, written by hand.
   *
   * 'none': the survivor sells on the same schedule and RENTS to the horizon at the
   * plan's `rentMonthly` — the same spelling `purchasePrice` uses for "no
   * replacement house".
   *
   * WHY IT EXISTS: the widow score modelled the survivor staying put in the
   * just-bought house forever. On a representative plan an uninsured death the
   * month after a $1.2M closing scored 93.0% staying put, while selling and
   * rebuying at $1.0M recovers roughly $135k net of ~$72k selling costs —
   * whether term cover above ~$1.0M is worth keeping hinges on exactly this
   * recovery, so the plan must be able to SAY the survivor would make it.
   */
  survivorDownsizeTo?: number | 'none';
  /**
   * Months between the death month and the survivor's downsize sale (absent =
   * 12 — nobody lists a house from a funeral). 0 sells in the death month.
   * Ignored unless `survivorDownsizeTo` is set.
   */
  survivorDownsizeDelayMonths?: number;
  /** Annual property tax on the new house, in purchase-year dollars (the engine indexes it to CPI thereafter). Ignored when there is no purchase. */
  propertyTaxAnnual: number;
  /**
   * Annual homeowners insurance on the new house, in purchase-year dollars.
   *
   * ABSENT = estimated from the purchase price by
   * `estimateHomeInsuranceAnnual` (engine/housingPlan.ts), which is the same
   * pure helper the UI calls to display the figure — so what is shown is
   * exactly what is modelled.
   */
  insuranceAnnual?: number;
  /** Cash or mortgage. */
  financing: HousingFinancing;
}

export type SolverSpec =
  /**
   * THE WIDOW SCORE, as a curve.
   *
   * Runs the plan once per candidate year with a `death` event in that year
   * and reports the SURVIVOR's probability of success — the same machinery,
   * the same metric, a different household from the death forward. There is no
   * parallel survivor engine: a widow score is a normal simulation of a plan
   * that happens to contain a death.
   *
   * Read it against the base run's own success, which the solver returns
   * alongside as it does for every sweep. A plan at 95% household and 64%
   * widow is a different plan from one at 95% and 91%, and the gap is the
   * thing the user is actually buying when he works another year or keeps a
   * term policy in force.
   */
  | {
      type: 'widow_score';
      /** Who dies. ABSENT = the first person in the profile who draws a salary. */
      person?: string;
      /** First death year to probe. ABSENT = the simulation's start year. */
      from?: number;
      /** Last death year to probe. ABSENT = 20 years after `from`. */
      to?: number;
      /** Years between probes. ABSENT = 1. */
      step?: number;
      /** Living fraction handed to each death event (see the event's field). */
      livingFraction?: number;
    }
  | { type: 'retire_year_sweep'; from: number; to: number; alsoMaxSpend?: boolean }
  | { type: 'ss_claim_sweep'; stepMonths?: number }
  | { type: 'swr_curve'; spendFrom: number; spendTo: number; step: number }
  | { type: 'max_spend'; targetSuccess?: number }
  | { type: 'earliest_retirement'; targetSuccess?: number; from?: number; to?: number };

export interface AssumptionOverrides {
  market?: Partial<MarketAssumptions>;
  aca?: Partial<Pick<AcaData, 'enhancedCreditsExtended'>>;
  settings?: Partial<
    Pick<ProfileSettings, 'horizonAge' | 'successTarget' | 'terminalFloorReal' | 'spendingPolicy'>
  >;
  /**
   * Scenario-level override of the profile's expense streams (ProfileExpenses,
   * $/month in 2026 dollars). A what-if can therefore drag spending — "what if
   * we lived on 500 less a month?" — WITHOUT rewriting profile.json, which is
   * the household's single shared baseline: the override lives in the
   * scenario, so two scenarios can disagree about spending at the same time.
   *
   * Each field present REPLACES the corresponding profile value for that run
   * (fields absent/undefined keep the profile's). Applied before anything
   * reads the streams, so `expense_change` events still multiply/offset the
   * overridden living and charitable baselines exactly as they would the
   * profile's, and the investing stream still stops at retirement and stays
   * capped at the year's surplus.
   */
  expenses?: {
    livingMonthly?: number;
    /** Retired-side living; absent keeps the profile's (and absent there = same as working). */
    livingMonthlyRetired?: number;
    charitableMonthly?: number;
    investingMonthly?: number;
    /** Retired-side investing; absent keeps the profile's (and absent there = 0). */
    investingMonthlyRetired?: number;
    /** Plan-level what-if on the premium; absent keeps the profile’s. */
    lifeInsuranceMonthly?: number;
    /**
     * The rest of the policy, overridable for the same reason the premium is:
     * "five years of term at retirement" is a QUESTION about a plan, not a
     * fact about the household, and it has to be askable without rewriting
     * profile.json — two scenarios must be able to disagree about the policy
     * at the same time. Absent keeps the profile's (and absent there means no
     * benefit / coverage ending with the paycheck).
     */
    lifeInsuranceDeathBenefit?: number;
    lifeInsuranceTermEnd?: YearMonth;
    /** Plan-level what-if on when cover begins; absent keeps the profile's. */
    lifeInsuranceTermStart?: YearMonth;
    lifeInsuranceInsured?: string;
    /**
     * Per-policy disposition for a profile that carries a POLICY LIST, keyed by
     * policy id (see LifeInsurancePolicyPlan for the three answers). The five
     * single-policy fields above cannot reach a listed policy at all — a
     * non-empty `lifeInsurancePolicies` supersedes them — so this map is the
     * only way a plan can say "cancel one policy, keep the other".
     *
     * An id naming no profile policy is IGNORED by the engine (the server
     * flags it as a warning): profiles evolve, and a saved scenario must not
     * start crashing because a policy was renamed. Absent — the map or an id —
     * keeps that policy exactly as the profile configures it.
     */
    lifeInsurancePolicyPlans?: Record<string, LifeInsurancePolicyPlan>;
    /**
     * Scenario-level ONGOING giving method: a what-if can compare methods —
     * continue vs. none vs. a different amount vs. a percentage of growth —
     * without touching the profile. Absent keeps the profile's method (and
     * absent there means 'continue'). A legacy bundled 'tithe_account' value
     * here is normalised into ongoing + `untithedPot` before the engine runs,
     * and — because the old override REPLACED the whole bundle — it also
     * supersedes the profile's pot for this run.
     */
    retirementGiving?: RetirementGivingRule;
    /**
     * Scenario-level pot override, the other half of the pair. ABSENT MEANS
     * "INHERIT THE PROFILE'S POT" — like every other field in this block —
     * which is why `{ enabled: false }` exists: it is the explicit "no pot in
     * this run" that an old-world override expressed simply by replacing the
     * bundled rule. The load-time migration writes exactly that disable into
     * any pre-split override so its meaning survives the new inheritance
     * semantics (a saved plan.json is the motivating case).
     */
    untithedPot?: UntithedPotSetting;
  };
  /**
   * Scenario-level override of the profile's RETIREMENT INCOME (ProfileIncome,
   * $/month in 2026 dollars for the amount), mirroring `expenses` above:
   * "what if the consulting work brings in 2,000 a month instead of nothing?"
   * is exactly the kind of question a plan should answer without rewriting
   * profile.json.
   *
   * Salaries and 401(k) contributions are deliberately NOT overridable: they
   * are payroll facts the profile owns, and the plan already moves the thing
   * that matters about them — the date they stop (the retire events).
   *
   * Each field present REPLACES the corresponding profile value for that run;
   * fields absent/undefined keep the profile's.
   */
  income?: {
    retirementMonthly?: number;
    retirementIncomeTaxable?: boolean;
  };
}

export interface Scenario {
  name: string;
  description?: string;
  /**
   * Automatic 72(t)/SEPP bridge.
   *
   * UNDEFINED MEANS ON. Every scenario — including ones saved before this
   * field existed — gets the automatic election unless it says `false`,
   * because there is no early-retirement plan in which the household would
   * NOT want penalty-free access to pre-tax money. Set `false` to turn it off
   * and model the un-bridged case (pre-59 1/2 IRA draws pay the 10% penalty).
   *
   * When on, any person who retires in a year BEFORE their own penalty-free
   * year (59 1/2, annual steps) elects a 72(t) series in the retirement year
   * on their largest traditional IRA — the one the 401(k) has just rolled
   * into, since the rollover happens first in that same year. The payment is
   * sized to the household's projected annual cash need over the bridge, not
   * to the IRS formula maximum, and the split-IRA technique carves out only
   * the principal that payment requires (see `seppSplit`), leaving the rest an
   * ordinary, fully accessible IRA.
   *
   * An explicit `start_72t` event always wins: a person who has one keeps
   * exactly the election the scenario wrote, and no automatic one is added.
   */
  autoSepp?: boolean;
  assumption_overrides?: AssumptionOverrides;
  /**
   * The move, as first-class configuration (see HousingPlan).
   *
   * PRESENT supersedes any hand-written `sell_house` / `rent` / `buy_house`
   * event in `events`; ABSENT leaves those events working exactly as before.
   */
  housing?: HousingPlan;
  events: ScenarioEvent[];
  solver?: SolverSpec;
}

export interface ScenarioFile extends Scenario {
  id: string; // filename without .json
}

// ---------------------------------------------------------------------------
// Tax engine contract (SPEC §7)
// ---------------------------------------------------------------------------

export type PenaltyException = 'none' | 'age_59_5' | 'rule_of_55' | 'sepp_72t' | 'roth_basis';

export interface RetirementDistribution {
  personId: string;
  accountType: AccountType;
  amount: number;
  /** Taxable amount (Roth qualified withdrawals are 0-taxable). */
  taxableAmount: number;
  penaltyException: PenaltyException;
  /** Amount subject to the 10% penalty (engine-computed; tax applies rate + traces). */
  penaltyBase: number;
}

export interface TaxYearInputs {
  year: number;
  filingStatus: FilingStatus;
  state: StateCode;
  /**
   * Per person IN THIS YEAR'S TAX HOUSEHOLD, in profile.people order.
   *
   * Normally that is everyone. After a `death` event it is everyone not dead
   * BEFORE this year — so the decedent is still counted in the year of death
   * (a joint return counts both spouses) and gone from the next year on. The
   * LENGTH of these arrays is load-bearing: it drives the number of 65+
   * standard-deduction add-ons, Virginia's personal exemptions and age
   * deduction, South Carolina's per-person retirement and senior deductions,
   * and how many people Medicare is billed for.
   */
  birthYears: number[];
  agesAtYearEnd: number[];
  /** W-2 wages AFTER 401(k) deferrals. */
  wages: number;
  taxableInterest: number;
  ordinaryDividends: number; // includes qualified
  qualifiedDividends: number;
  /** Taxable traditional 401(k)/IRA distributions incl. RMDs and Roth conversions. */
  pretaxDistributions: number;
  rothConversionAmount: number;
  /** Net long-term capital gains (taxable sales + home gain above §121). */
  ltcg: number;
  socialSecurityGross: number;
  distributions: RetirementDistribution[];
  taxExemptInterest: number;
  otherOrdinaryIncome: number;
  /** Cash charitable gifts for the year (drives the charitable deductions). */
  charitableGiving: number;
  itemizable: { mortgageInterest: number; propertyTax: number };
  /** null when not on ACA that year. */
  aca: {
    enrolledMonths: number;
    benchmarkAnnualPremium: number;
    grossAnnualPremium: number;
  } | null;
  /** null before Medicare. */
  medicare: {
    enrolledMonthsPerPerson: number[];
    magiTwoYearsPrior: number;
    /** Per-person Part D plan premium, $/mo, current-year dollars. */
    partDPlanMonthly: number;
    /**
     * Cumulative premium-growth factor from medicare baseYear (CPI +
     * medicalInflationRealSpread). Scales base premiums/IRMAA surcharges;
     * IRMAA MAGI *thresholds* scale by plain inflationIndex.
     */
    premiumIndex: number;
  } | null;
  /** Cumulative CPI factor from the tax data baseYear to `year` (1.0 in base year). */
  inflationIndex: number;
}

export interface TraceLine {
  label: string;
  amount?: number;
  note?: string;
  indent?: number;
}

export interface TaxYearResult {
  federal: {
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
    total: number; // ordinaryTax + ltcgTax + niit
  };
  state: {
    code: StateCode;
    taxableIncome: number;
    total: number;
  };
  penalties: number;
  aca: {
    enrolled: boolean;
    fplPct: number;
    applicablePct: number | null;
    expectedContribution: number;
    ptc: number;
    grossPremium: number;
    netPremium: number;
    /** true when MAGI > 400% FPL forfeited the whole credit. */
    cliffApplied: boolean;
    /** Distance to the cliff (fpl400Magi - acaMagi); negative = over. */
    cliffHeadroom: number | null;
  } | null;
  medicare: {
    partB: number;
    partDPlan: number;
    irmaaPartB: number;
    irmaaPartD: number;
    total: number;
    tierIndex: number; // 0 = no IRMAA
  } | null;
  magi: {
    agi: number;
    acaMagi: number;
    irmaaMagi: number;
    niitMagi: number;
  };
  /** federal.total + state.total + penalties (health premiums are expenses, not taxes). */
  totalTax: number;
  trace?: TraceLine[];
}

export interface ComputeYearOptions {
  trace?: boolean;
}

/** Static data handed to tax.computeYear (subset of Assumptions). */
export interface TaxDataBundle {
  federal: FederalTaxData;
  states: Record<StateCode, StateTaxData>;
  medicare: MedicareData;
  aca: AcaData;
}

// ---------------------------------------------------------------------------
// Engine contract (SPEC §4)
// ---------------------------------------------------------------------------

export type RunMode = 'deterministic' | 'historical' | 'montecarlo';

export interface YearReturns {
  stocks: number;
  bonds: number;
  bills: number;
  cpi: number;
}

export interface YearRow {
  year: number;
  agesAtYearEnd: number[];
  /** Cumulative CPI factor from sim start (1.0 in first year start). */
  inflationIndex: number;
  income: {
    wages: number;
    socialSecurity: number;
    taxableInterest: number;
    dividends: number;
    other: number;
    /**
     * The retirement income stream (ProfileIncome.retirementMonthly) for this
     * year: spendable cash, ordinary income when
     * ProfileIncome.retirementIncomeTaxable is not false. A separate cash
     * component of income, like wages and Social Security — not part of
     * `other` (one-time income).
     */
    retirement: number;
    /**
     * Employee share of the employer health premium (informational; wages are
     * reported net of it, like the 401(k) deferral).
     */
    employerHealthPremiumShare: number;
  };
  expenses: {
    baseline: number;
    charitable: number;
    housing: number;
    health: number;
    oneTime: number;
    /** baseline + charitable + housing + health + oneTime. */
    total: number;
  };
  /**
   * Transfer to the taxable brokerage (the investingMonthly /
   * investingMonthlyRetired pair). NOT consumption — excluded from
   * expenses.total.
   */
  investing: number;
  /**
   * Leftover cash a WORKING year consumed instead of accumulating: income minus
   * taxes, minus recorded expenses, minus the explicit investing transfer.
   *
   * The living-expense figure is a BUDGET BASELINE — it does not carry the
   * irregular, lumpy costs a real year brings (an air conditioner, a car
   * repair, a trip, home maintenance beyond the modeled percentage), and those
   * are where the leftover of a paycheck actually goes. So while anyone earns
   * a salary the engine consumes it rather than sweeping it into an account:
   * only the amount the household SAYS it invests is invested. Recording the
   * figure keeps the cash identity exact and lets the cashflow table show
   * where the money went.
   *
   * ALWAYS 0 once nobody earns: a retired year's withdrawal solve takes only
   * what is needed, so leftover cash there can only come from a FORCED
   * distribution (an RMD or a 72(t) payment) the year did not need — and that
   * money is reinvested in the taxable brokerage, not consumed.
   */
  unbudgeted: number;
  /**
   * CASH BANKED FOR AN IMMINENT PURCHASE (present only in a year the
   * between-homes banking actually moved money — sold, renting, purchase
   * pending — so every other run's rows keep their exact shape).
   *
   * `investing` is the slice of the year's investing transfer that went to
   * SAVINGS instead of the brokerage (it is already inside YearRow.investing;
   * this records the destination split). `livingReduction` is the living
   * money the renting column freed — (in-force living minus renting living),
   * month-prorated — parked in savings instead of being consumed as
   * `unbudgeted` (working years) or swept into the brokerage (retired years).
   * The reduction is its OWN term in the recorded-cash identity; the
   * investing slice is not (it rides inside `investing`).
   */
  banked?: {
    investing: number;
    livingReduction: number;
  };
  housing: {
    rent: number;
    mortgagePayment: number;
    mortgageInterest: number;
    propertyTax: number;
    insurance: number;
    maintenance: number;
    homeValue: number;
    saleProceeds: number;
  };
  withdrawals: {
    byAccount: Record<string, number>;
    cash: number;
    taxable: number;
    pretax: number;
    roth: number;
    rothConversion: number;
    rmd: number;
    penaltyBase: number;
    realizedLtcg: number;
  };
  taxes: TaxYearResult;
  balances: {
    byAccount: Record<string, number>;
    total: number;
    totalReal: number;
    /**
     * The tithe carve-out's end-of-year balance (0 whenever the household has
     * none). Already counted inside `total` — it is a real IRA balance — and
     * broken out here because it is the one part of the portfolio with a
     * different owner-in-waiting: last-resort money through the soft window,
     * untouchable escrow once the lock engages.
     */
    tithe: number;
    /**
     * The money that can fund a retirement. Equal to `total` through the
     * soft window — the pot still counts, and may be drawn last — and
     * `total - tithe` from the year the carve-out locks.
     */
    spendable: number;
    /**
     * spendable / inflationIndex. THIS, not `totalReal`, is what the fan
     * chart, the terminal value and the success rate are built from: once the
     * carve-out locks it is charity's money and must not flatter the odds the
     * plan survives (see RetirementGivingRule's 'tithe_account'). Equal to
     * `totalReal` to the cent whenever there is no carve-out or it has not
     * locked yet.
     */
    spendableReal: number;
  };
  /**
   * Tithe Account activity for the year — present only in a run whose giving
   * rule is 'tithe_account' AND only from the year the carve-out opens.
   */
  tithe?: {
    /** Account id of the carve-out (`<parentId>-tithe`). */
    accountId: string;
    /** End-of-year balance, nominal (same figure as balances.tithe). */
    balance: number;
    /** One-time catch-up on untithed gains; non-zero only in the seed year. */
    seeded: number;
    /**
     * Moved from the parent IRA into the carve-out at this year end. An
     * INTERNAL TRANSFER: no tax, no withdrawal, no income, no expense — it
     * appears nowhere in the cash identity, exactly like the 72(t) split.
     */
    accrued: number;
    /**
     * Cash actually given this year under the rule's TRAILING-GROWTH stream
     * (percent of the prior year's high-water base). Part of
     * expenses.charitable, never additional to it. 0 through the soft window.
     */
    given: number;
    /**
     * The pot instalment paid out this year: balance / years-remaining, from
     * the year the carve-out locks until `distributeYears` have elapsed. Cash
     * out of the IRA, given away the same year (part of expenses.charitable,
     * and of the charitable deduction, like every other gift here).
     */
    distributed: number;
    /**
     * Money the withdrawal ordering drew OUT of the carve-out as a LAST
     * RESORT during the soft window — every other bucket was dry first. It is
     * spent, not given: the promise absorbed the emergency and the pot is
     * permanently smaller. Always 0 once the carve-out locks.
     */
    drawn: number;
    /** True from the year the carve-out locks (distribution start) onward. */
    locked: boolean;
    /**
     * Money an RMD forced OUT of the carve-out and which was therefore given
     * away in cash the same year (also part of expenses.charitable). The IRS
     * sees one IRA and requires distributions off the whole balance; the
     * carve-out's share cannot stay inside, and it is not the household's to
     * spend — soft window or not, it is promised money — so it is disbursed.
     * Real-world instrument: a qualified charitable distribution.
     */
    forcedDistributionGiven: number;
    /**
     * BREAK GLASS: the carve-out's end-of-year balance in real (start-year)
     * dollars. In a LOCKED year this is money the household could have
     * reached only by breaking the promise; in a soft year it is simply what
     * the promise still holds, because the ordering already reaches it last.
     */
    breakGlassReal: number;
  };
  /**
   * Present from the year a `death` event fires and in every year after it —
   * absent entirely in a run with no death, so nothing about an ordinary plan
   * changes shape.
   *
   * It exists because the widow penalty is invisible in the other columns. Two
   * rows with the same withdrawals and the same balance can carry wildly
   * different tax bills, and the only thing that explains it is that one of
   * them is filing single on half the standard deduction. Recording the status
   * per year is what lets a reader see that rather than infer it.
   */
  survivor?: {
    /** Person id of the deceased. */
    deceased: string;
    /** True only in the year the death itself occurred (the last MFJ year). */
    deathYear: boolean;
    /** Filing status this year's tax was actually computed on. */
    filingStatus: FilingStatus;
    /** People in the tax household (2 through the death year, 1 after). */
    taxPeople: number;
    /** Life-insurance face amount received this year; non-taxable, lands in savings. */
    lifeInsuranceBenefit: number;
    /** Social Security lump-sum death payment received this year ($255, once). */
    ssLumpSum: number;
  };
  returns: YearReturns;
  eventsFired: string[];
  flags: string[];
}

export interface FanChart {
  years: number[];
  /** Real (start-year) dollars. */
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
}

export interface SolverPoint {
  /** x value: retirement year, claim age in months, or spending level. */
  x: number;
  label: string;
  success: number;
  medianTerminalReal?: number;
  maxSpend?: number;
  expectedLifetimeBenefits?: number;
}

export interface SolverResult {
  spec: SolverSpec;
  points: SolverPoint[];
  best?: SolverPoint;
  answer?: number;
  answerLabel?: string;
}

export interface RunMeta {
  engineVersion: string;
  mode: RunMode;
  seed: number;
  paths: number;
  createdAt: string;
  scenarioName: string;
  hashes: { profile: string; assumptions: string; scenario: string };
  runKey: string;
}

/**
 * WHERE THE HOUSE MONEY CAME FROM: the cash story of a sell → rent → buy
 * window, recorded by the engine on the reference path so the Housing card can
 * show a breakdown that is exactly what the simulation did rather than a
 * lookalike recomputed in the UI.
 *
 * All figures are NOMINAL dollars (the cash is a balance; a dollar banked in
 * 2027 is still a dollar in the 2028 buy month), and `totalCash` is BY
 * DEFINITION the sum of the five components — the UI's own summing test pins
 * that. It is a funding statement, not a bank statement: cash the household
 * DREW from savings during the window (a retired year living off the proceeds)
 * is not netted out of the components, so against a long unsalaried rental the
 * total reads high; the surplus/shortfall line against the purchase is where
 * the honest comparison lands, because `cashOutflow` is the engine's actual
 * closing figure.
 */
export interface PurchaseFundingTrace {
  /** Month the old home sold — the window opens here. */
  sellDate: YearMonth;
  /** Month the replacement was bought — the window closes the month before. */
  buyDate: YearMonth;
  /** Whole months between homes (sale month inclusive, buy month exclusive). */
  windowMonths: number;
  /** Savings balance at the START of the sale year — cash the move did not create. */
  preExistingSavings: number;
  /** Net sale proceeds (after selling costs and any mortgage payoff). */
  netSaleProceeds: number;
  /** Investing-stream dollars redirected to savings across the window. */
  bankedInvesting: number;
  /** Living reduction (renting column) banked to savings across the window. */
  bankedLivingReduction: number;
  /**
   * Savings interest credited from the sale year through the buy month (the
   * buy year's credit prorated to the months before the purchase).
   */
  interestEarned: number;
  /** The five components above, summed. */
  totalCash: number;
  /**
   * The configured purchase price in buy-month dollars (for a
   * 'sale_proceeds' purchase, the price the engine actually resolved).
   */
  purchasePrice: number;
  /** Cash that left at closing: the whole price, or the down payment financed. */
  cashOutflow: number;
  financing: 'cash' | 'mortgage';
  /** totalCash - cashOutflow. Negative = the shortfall was drawn from the IRA. */
  surplus: number;
}

export interface RunResult {
  meta: RunMeta;
  /** Fraction of paths never insolvent through horizon (0..1). */
  success: number;
  horizonYears: number;
  fan: FanChart;
  medianTerminalReal: number;
  /** Insolvency-year histogram for the worst decile of paths: year -> count. */
  worstDecileShortfallYears: Record<string, number>;
  /**
   * BREAK-GLASS FIGURE: across the paths that FAILED, the median tithe
   * carve-out balance (real start-year dollars) sitting in the account in the
   * year the path first could not meet its cash need. NULL when no path
   * failed, or when the plan has no carve-out at all.
   *
   * WHAT IT MEANS UNDER THE SOFT WINDOW: a path that fails while the window
   * is open has already drawn the pot down as its last resort, so it
   * typically fails at (near) 0 — the promise absorbed the emergency before
   * the path fell short, and a small figure here is the design working. A
   * path that fails AFTER the lock leaves the whole pot standing, and the
   * figure is what breaking the escrow would have recovered. Rounding aside,
   * a non-trivial figure therefore means "failed with the promise locked",
   * not "forgot the money existed".
   */
  breakGlassReal: number | null;
  /**
   * Lifetime charitable dollars from the reference path, in real (start-year)
   * dollars: every cash gift the run made, plus the carve-out balance that
   * goes to charity at death. The two halves are reported separately because
   * they are different promises — one already kept, one only intended.
   */
  charitableLegacy: {
    /** Sum of every year's expenses.charitable, deflated to start-year dollars. */
    cashGivenReal: number;
    /** Terminal carve-out balance, deflated. 0 without a carve-out. */
    terminalTitheReal: number;
    /** cashGivenReal + terminalTitheReal. */
    totalReal: number;
  };
  /**
   * Deterministic companion path with full tax traces — powers the cashflow
   * table, tax detail, and MAGI chart regardless of mode.
   */
  referencePath: YearRow[];
  /**
   * The reference path's sell → rent → buy cash story (see the type). ABSENT
   * whenever that path has no between-homes window — no sale, no purchase, a
   * same-month sale and buy, or a rent-to-the-horizon plan — so a run without
   * one keeps its exact shape.
   */
  purchaseFunding?: PurchaseFundingTrace;
  /**
   * Cut/raise statistics across every simulated path (see GuardrailStats).
   * ABSENT under every policy but 'guardrails' — the same conditional-spread
   * convention as purchaseFunding, so a run without the rails keeps its exact
   * JSON shape and the golden digests hold.
   */
  guardrailStats?: GuardrailStats;
  solverOutput?: SolverResult;
  /** Milliseconds spent simulating. */
  elapsedMs: number;
}

export interface SimulationInput {
  profile: Profile;
  assumptions: Assumptions;
  scenario: Scenario;
  mode: RunMode;
  paths: number;
  seed: number;
}

export type ProgressFn = (frac: number, message?: string) => void;

export interface RunRequest {
  /**
   * The plan to simulate, always sent inline: there is one plan and the UI
   * always has it in hand, so the server never resolves it from disk.
   */
  scenario: Scenario;
  mode: RunMode;
  paths?: number;
  seed?: number;
  /** Skip cache when true. */
  fresh?: boolean;
}

export interface RunProgress {
  runId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number; // 0..1
  message?: string;
  result?: RunResult;
  error?: string;
}

/**
 * What POST /api/run/cached returns: the run already computed for these exact
 * inputs, or null.
 *
 * `null` is a MISS, never a failure — it means nothing has ever been simulated
 * from this plan, this profile at these prices, these assumptions, this mode,
 * this path count and this seed on this engine. The caller's answer to a miss
 * is to run something; the point of the route is that the SERVER does not.
 */
export interface CachedRunResponse {
  result: RunResult | null;
}

// ---------------------------------------------------------------------------
// The plan's history (plan-history.json)
// ---------------------------------------------------------------------------

/**
 * What one version of the plan scored, with the conditions that make the
 * number mean something.
 *
 * A bare probability is not comparable to another bare probability: the engine
 * version is part of the run-cache key precisely because two engines do not
 * agree, and at this engine's noise level (~sqrt(p(1-p)/paths)) a different
 * seed or path count moves success by more than most of the decisions this
 * planner exists to compare. So every recorded number travels with all four.
 *
 * Every optional field here means NOT MEASURED, never zero. A row that was
 * never scored has no `score` at all; a row whose spend solve failed has
 * `sustainableSpendError` and no `sustainableSpend`.
 */
export interface PlanScore {
  /** Probability of success (0..1) for this exact plan. */
  success: number;
  /** Median terminal balance, real (start-year) dollars. */
  medianTerminalReal?: number;
  /**
   * Max sustainable annual LIVING spend at the plan's own success target, real
   * dollars. The dollar-denominated score: this household's success rate
   * saturates near the ceiling, so spending headroom is what actually
   * separates its versions.
   *
   * Living expenses only — the solver sweeps `expenses.livingMonthly` (and the
   * retired figure in proportion) and leaves charitable and investing streams
   * alone, so this is not total household spend.
   */
  sustainableSpend?: number;
  /**
   * Paths behind `sustainableSpend`, which is NOT `paths` above. The solver
   * caps its inner sweep runs at INNER_PATH_CAP (engine/solvers.ts) — a
   * bisection is a dozen runs, and a dozen final-quality runs is minutes — so
   * the spend figure is measured at lower precision than the success figure
   * beside it. Recorded rather than assumed: a label carries its own condition.
   */
  sustainableSpendPaths?: number;
  /** Why there is no `sustainableSpend`. Present only when the solve failed. */
  sustainableSpendError?: string;
  mode: RunMode;
  /** Paths per run — the profile's `mcPathsFinal`, so scores match in precision. */
  paths: number;
  /** The profile's seed: the same stream of futures for every score. */
  seed: number;
  /** ENGINE_VERSION at scoring time. A change breaks comparability. */
  engineVersion: string;
  /** When these numbers were computed (server clock). */
  scoredAt: string;
}

/**
 * ONE VERSION OF THE PLAN, frozen: what it was, when it became history, and
 * what it scored if anyone asked.
 *
 * The plan is saved as it is edited, so there is nothing to "open" and nothing
 * to lose — but that same property means an edit overwrites the only copy.
 * History is the undo: the first change of any day first files a copy of the
 * plan AS THE DAY BEGAN, so every day of editing has exactly one restore
 * point and a week of them is a week of recoverable decisions.
 *
 * `plan` is a WHOLE FROZEN COPY, never a pointer. A pointer would leave the
 * meaning of every recorded score at the mercy of a later edit: change the
 * plan, and last month's 93.8% silently becomes a score of something that did
 * not exist last month. Nothing ever edits a stored entry's `plan` in place —
 * restoring copies it forward onto plan.json and leaves the entry alone.
 */
export interface PlanHistoryEntry {
  /** Stable id: the URL path segment for restore and for scoring. */
  id: string;
  /** Server-stamped ISO moment this version was filed. */
  takenAt: string;
  /**
   * Why this version was filed, and the reason the daily guard can tell them
   * apart: only a 'day-start' entry satisfies "today already has a restore
   * point". A 'kept' entry is an explicit act — a search finalist put somewhere
   * safe — and letting one count as the day's restore point would mean saving a
   * finalist in the morning silently threw away the undo for that day's edits.
   */
  kind: 'day-start' | 'kept';
  /** The plan itself, exactly as the engine would consume it. */
  plan: Scenario;
  /**
   * sha256 of `planIdentityKey(plan)` — the plan's identity, name and
   * description excluded (shared/planIdentity.ts). What a recorded score
   * points back at, and what the score chart's comparability marks fire on.
   */
  planHash: string;
  /** What the user called this version, when he called it anything. */
  label?: string;
  /**
   * What this version scored, if it has ever been scored. ABSENT = never
   * scored.
   *
   * WRITE-ONCE. A score is a measurement of this plan against one day's
   * balances, prices and calendar, and the entry is a record of that; the
   * server refuses a second one (planHistoryScorer, and the guard in
   * attachPlanHistoryScore behind it). Present means finished, not "current".
   */
  score?: PlanScore;
  /**
   * Why the last scoring attempt produced no number. Cleared by a success, and
   * replaceable by another failure: a failure records no measurement, so a
   * version carrying only this one has still never been measured and may be
   * scored. That is the whole difference between it and `score` above.
   */
  scoreError?: string;
}

/** POST /api/plan/history/:id/restore — the plan as it now stands. */
export interface PlanRestoreResponse {
  ok: true;
  /** The restored plan, exactly as written to plan.json. */
  plan: Scenario;
  /** The entry it came from, so the page can name what it restored. */
  restoredFrom: PlanHistoryEntry;
}

// ---------------------------------------------------------------------------
// Quotes (quotes.json) and net worth (networth.json)
// ---------------------------------------------------------------------------

/**
 * One stored market quote (quotes.json, keyed by symbol). Prices are INPUTS,
 * not forecasts: a quote enters this file only through the explicit refresh
 * route, carries the moment it was priced (`asOf` — the exchange's own
 * regularMarketTime, typically the delayed close), and is then read from disk
 * by everything else. Runs never fetch; a run whose symbol is missing here
 * fails loudly instead of guessing.
 *
 * USD-ONLY BY CONSTRUCTION: the refresh route rejects a non-USD quote before
 * it is stored, so `currency` is recorded for the audit trail rather than as a
 * branch anything downstream takes.
 */
export interface StoredQuote {
  /** Price per share in USD at `asOf`. */
  price: number;
  /** Always 'USD' in a stored quote (non-USD is rejected at refresh). */
  currency: string;
  /** When the exchange priced it (ISO) — the figure every label carries. */
  asOf: string;
  /** Where it came from; one source today, structured so a second can slot in. */
  source: 'yahoo';
  /** When the refresh route stored it (ISO, server clock). */
  fetchedAt: string;
}

/** quotes.json: every stored quote, keyed by uppercase symbol. */
export type QuotesFile = Record<string, StoredQuote>;

/** Per-symbol outcome of a refresh — failures are data, never batch-fatal. */
export type QuoteRefreshOutcome =
  | { symbol: string; ok: true; quote: StoredQuote }
  | { symbol: string; ok: false; error: string };

/** What POST /api/quotes/refresh returns: the store after, and each verdict. */
export interface QuoteRefreshResult {
  quotes: QuotesFile;
  results: QuoteRefreshOutcome[];
}

/**
 * What GET /api/profile/derived reports for ONE holdings-mode account: the
 * derived figures plus the per-symbol prices (and their asOf moments) they
 * came from, so the UI can label every number with its condition instead of
 * presenting a stored price as a live one.
 */
export interface DerivedAccountView {
  balance: number;
  allocation: AssetMix;
  /** The account's uninvested cash (absent field = 0), counted as bills. */
  cash: number;
  holdings: Array<{
    symbol: string;
    quantity: number;
    assetClass: AssetClass;
    /** Stored price and its moment; null when no quote is stored yet. */
    price: number | null;
    asOf: string | null;
    /** quantity × price; 0 while the quote is missing. */
    value: number;
  }>;
  /** Symbols this account holds that have no stored quote (blocks runs). */
  missing: string[];
}

/** GET /api/profile/derived: derived views keyed by account id. */
export interface DerivedProfileResponse {
  accounts: Record<string, DerivedAccountView>;
  /** Every symbol across all holdings accounts with no stored quote. */
  missing: string[];
}

/**
 * ONE NET-WORTH SNAPSHOT (networth.json, append-only). A snapshot is a
 * RECORD, not a projection: account balances as the stored quotes priced them
 * at the moment the button was pressed (the server refreshes quotes first),
 * plus the home value the user typed. Every displayed total carries that
 * condition — prices as of the snapshot moment; home value as entered.
 */
export interface NetWorthSnapshot {
  id: string;
  /** Server-stamped ISO — the client never chooses its own timestamp. */
  takenAt: string;
  /** Σ account balances + homeValue, at snapshot time. */
  total: number;
  /** The user's number, typed beside the button. Not a model output. */
  homeValue: number;
  /** Every account's balance — derived for holdings accounts, manual otherwise. */
  accounts: Array<{ id: string; name: string; balance: number }>;
  /** The prices the derived balances used, with their own asOf moments. */
  prices: Record<string, { price: number; asOf: string }>;
  note?: string;
  /**
   * What THE PLAN scored around this snapshot's moment.
   *
   * ABSENT MEANS NOT SCORED, and it must never render as 0%. Two ordinary ways
   * a row ends up here: it was taken before this feature existed, or its run
   * failed (in which case `scoreError` says why). A row's net worth is the part
   * that can never be recreated — a market moment — so it is written first and
   * alone, and the score is attached afterwards or not at all.
   *
   * WRITE-ONCE, AND THE ONLY WRITER IS THE RUN THE SNAPSHOT POST STARTS. A row
   * is a record of a day; a score computed on a later one would not be true of
   * it. So absent here is permanent, and the page says "not measured" rather
   * than offering to fill it.
   */
  score?: SnapshotScore;
  /**
   * Why the scoring attempt produced no score, in the words the user gets
   * shown. Present ONLY after a failure, and permanent: nothing re-runs a
   * snapshot's scoring. Absent alongside an absent `score` means nobody ever
   * tried — which is not a failure and must not be dressed up as one.
   */
  scoreError?: string;
}

/**
 * ONE RECORDED SCORE on a net-worth row: what the plan scored at that moment,
 * stamped with every condition that decides whether it is comparable to the
 * score beside it.
 *
 * A chart's whole claim is that its points are on one scale, and two conditions
 * can break that silently:
 *
 *  - `planHash` — a score is a score OF A PLAN. Change the plan (retire a year
 *    later, a different house) and the line drawn through the change reads as
 *    "my plan improved" when the truth is "I am now measuring something else".
 *  - `engineVersion` — ENGINE_VERSION is part of the run-cache key precisely
 *    because two engines do not agree; a stored number carried across a bump is
 *    not comparable to one taken since.
 *
 * The chart marks both, rather than hiding them behind a smooth line.
 *
 * `paths` and `seed` are the other half: at this engine's noise level a
 * different seed moves success by around a point, which is more than most of
 * the real movement this trend exists to show. Both are pinned to the profile's
 * own settings so successive snapshots stay comparable by default.
 */
export interface SnapshotScore extends PlanScore {
  /**
   * The identity of the plan this scored (shared/planIdentity.ts).
   *
   * ABSENT on rows recorded before there was one plan — those carry the
   * baseline fields below instead, and are still perfectly good records of what
   * the plan of the day scored. A hash cannot be invented for them after the
   * fact: the baseline hash covered a different thing (the whole frozen record,
   * name included), so a value here would be a claim nobody measured.
   */
  planHash?: string;
  /**
   * The version in the plan's history this score's plan matches, when it
   * matches one — the newest such version, since the plan may have passed
   * through the same shape twice. It is what lets a point on the chart offer
   * "restore the plan this was scored under". ABSENT means the plan scored is
   * not (or is no longer) in the history.
   */
  planHistoryId?: string;
  /**
   * THE BASELINE FIELDS, kept readable and never written again.
   *
   * Scores recorded while the app had a separate frozen "baseline plan" carry
   * these four, and they are historical facts: the number was a score of that
   * revision, under that label, and `planDriftedFromBaseline` says whether the
   * plan being edited had already moved away from it. Dropping them from the
   * shape would not remove them from the user's ledger — it would make the
   * ledger fail to parse, which would take the net-worth history down with the
   * score.
   */
  baselineRevision?: number;
  baselineHash?: string;
  baselineLabel?: string;
  planDriftedFromBaseline?: boolean;
}

// ---------------------------------------------------------------------------
// The search: decision space
// ---------------------------------------------------------------------------

/**
 * How the portfolio gets from where it is to the target stock share.
 *
 * - 'step_now'            — one allocation_change at the simulation start.
 * - 'step_at_retirement'  — one allocation_change in the retirement month.
 * - 'glide_to_target'     — 5-year glidepath from today's mix to the target,
 *                           starting at retirement.
 * - 'rising_equity'       — 10-year glidepath from the target UP by 20 points
 *                           (capped at 100% stocks), starting at retirement.
 *                           In because the user already asked the question
 *                           once (allocation-glidepath.json).
 */
export type GlideShape = 'step_now' | 'step_at_retirement' | 'glide_to_target' | 'rising_equity';

/**
 * Spending policy level for the search's spendingPolicy axis.
 *
 * Only the two policies the objective can rank. Both READ the living figure
 * the sustainable-spend bisection sweeps — fixed_real spends it outright,
 * guardrails holds it real and only corrects when the withdrawal rate leaves
 * its band — so probes separate and "maximum sustainable spending" has an
 * answer. fixed_percent is deliberately absent: it DEFINES spending from the
 * portfolio and never reads the swept figure, every probe scores identically,
 * and the search once fabricated a +$290,000/yr winner from exactly that.
 *
 * A level carries NO parameters. A guardrails level runs the user's own
 * configured band (DEFAULT_GUARDRAILS when the profile has none) — the
 * compiler reads it from the profile, so the decision searched is "rails or
 * no rails", never "which rails".
 */
export interface SpendingPolicyLevel {
  type: 'fixed_real' | 'guardrails';
}

/**
 * ONE DIMENSION of the decision space, with the levels to try on it.
 *
 * A closed union rather than free-form JSON patches, for two reasons. It can be
 * validated (a typo'd axis fails loudly instead of silently searching nothing),
 * and the compiler can know which knobs go INERT under which settings of the
 * others — 72(t) on/off is not a decision once you retire after your
 * penalty-free year, and financing is not a decision if you never buy. A search
 * that cannot tell "no difference" from "the question does not arise" reports
 * a spurious zero effect and wastes half its budget computing it twice.
 *
 * EVERY AXIS IS EXPRESSIBLE ON THE SCENARIO. That is a hard constraint, not a
 * coincidence: the server resolves profile and assumptions from disk on every
 * run, so only the scenario varies. Account balances, salaries and PIA figures
 * are profile facts and cannot be searched here.
 */
export type SearchAxis =
  /** Calendar year both people stop working (July of that year). */
  | { dim: 'retireYear'; levels: number[] }
  /** Automatic 72(t)/SEPP bridge on or off. Inert once retirement is penalty-free. */
  | { dim: 'autoSepp'; levels: boolean[] }
  /** Target stock share (0..1); the remainder goes to bonds. */
  | { dim: 'stockShare'; levels: number[] }
  /** How the portfolio reaches that share. */
  | { dim: 'glideShape'; levels: GlideShape[] }
  /**
   * Replacement-house price in nominal purchase-year dollars, or
   * 'sale_proceeds' (a RESIDUAL claim the 72(t) does not reserve — genuinely a
   * different plan from the same number typed literally), or 'none' (sell and
   * rent to the horizon).
   */
  | { dim: 'housePrice'; levels: Array<number | 'sale_proceeds' | 'none'> }
  /** Cash or a 20%-down mortgage. Inert when there is no purchase. */
  | { dim: 'financing'; levels: Array<'cash' | 'mortgage'> }
  /** Years between retirement and the sale (0 = sell at retirement). */
  | { dim: 'moveOffsetYears'; levels: number[] }
  /** Household Social Security claiming age in whole years (62-70). */
  | { dim: 'claimAge'; levels: number[] }
  /** Giving rule in retirement. */
  | { dim: 'givingRule'; levels: RetirementGivingRule[] }
  /**
   * Yearly Roth conversion to the top of a marginal bracket, or 'none'.
   * Level values are the bracket rate as a decimal (0.12, 0.22, 0.24).
   */
  | { dim: 'rothConversion'; levels: Array<number | 'none'> }
  /** State of residence from the move onward. */
  | { dim: 'state'; levels: StateCode[] }
  /** Fixed real spending vs guardrails on the user's configured band. */
  | { dim: 'spendingPolicy'; levels: SpendingPolicyLevel[] };

export type SearchDim = SearchAxis['dim'];

/** A point in the space: dimension id -> the level index chosen on that axis. */
export type SearchAssignment = Partial<Record<SearchDim, number>>;

/**
 * What the search is trying to maximise.
 *
 * 'sustainable_spend' IS THE DEFAULT AND SHOULD STAY THAT WAY for an
 * over-funded plan. Measured over 20 structurally diverse plans at one
 * household's actual spending, six tied at exactly 100.00% success and the
 * entire spread across the space was 2.57 percentage points — retiring five
 * years earlier and buying a $950k house cost 0.05pp. Success rate cannot rank decisions for a
 * plan that is over-funded relative to what it spends; maximising it would be
 * maximising the random number generator. Dollars of sustainable spending move
 * by hundreds to thousands across the same space, comfortably above the noise.
 *
 * 'success' remains available for a household whose plan is genuinely tight,
 * where the probability is not pinned at the ceiling.
 */
export interface SearchObjective {
  metric: 'sustainable_spend' | 'success';
  /**
   * Annual living spend used to SCREEN candidates. Screening at the plan's own
   * spending is useless when success saturates there, so candidates are scored
   * at a stress level where the metric still has resolution. ABSENT = measured
   * in stage 0 as the level where the incumbent lands near
   * `probeTargetSuccess`.
   */
  probeSpend?: number;
  /** Success level stage 0 aims the probe spend at. Default 0.85. */
  probeTargetSuccess: number;
  /**
   * PRACTICAL-SIGNIFICANCE FLOOR — the difference below which two plans are
   * reported as the same plan, in the metric's own units ($/yr, or a success
   * fraction). Statistical significance is cheap when seeds can be bought;
   * "worth rearranging your life over" is the bar that matters. A result is
   * only called a win when the lower confidence bound clears this.
   */
  practicalFloor: number;
}

/**
 * Compute budget. Every default is measured, not guessed: on this machine a
 * 4,000-path run is ~1.66s single-threaded and an 8-worker pool sustains ~2.2
 * runs/s, so the defaults below land a 1,024-candidate search at about 20-25
 * minutes wall clock.
 */
export interface SearchBudget {
  /** Candidates drawn for round 1 (sampled mode). */
  candidates: number;
  /**
   * Enumerate the full cartesian product instead of sampling. Honest for a
   * small space; the caller is responsible for the arithmetic on a large one
   * (a hard cap still applies).
   */
  enumerate: boolean;
  /** Successive-halving cut factor: each round keeps 1/eta of its field. */
  eta: number;
  /** Candidates surviving to the report stage. */
  finalists: number;
  /** Paths for round 1 screening. */
  screenPaths: number;
  /** Paths for the racing rounds. */
  racePaths: number;
  /** Paths for every number the user reads. */
  reportPaths: number;
  /** Selection seeds (used to CHOOSE; never reported). */
  selectionSeedCount: number;
  /** Report seeds (used to REPORT; never used to choose). Disjoint from selection. */
  reportSeedCount: number;
  /** Base for both seed sets; ABSENT = the profile's own seed. */
  seedBase?: number;
  /** Run the add-one / revert-one attribution pass. */
  attribution: boolean;
  /** Run the coordinate-wise polish (local-optimum certificate). */
  polish: boolean;
  /** Report seeds used for the polish pass (a subset, for cost). */
  polishSeedCount: number;
  /** Probe the survivor's score for the baseline and every finalist. */
  widowProbe: boolean;
  /** Death year for that probe. ABSENT = the earliest retirement year in the space. */
  widowProbeYear?: number;
  /** Worker-pool size. ABSENT = min(8, max(2, cpus - 2)). */
  workers?: number;
}

export interface SearchRequest {
  /** The plan as it stands. The incumbent, the baseline, and the fallback. */
  base: Scenario;
  axes: SearchAxis[];
  objective?: Partial<SearchObjective>;
  budget?: Partial<SearchBudget>;
  /** Human label for the saved report. */
  label?: string;
}

// ---------------------------------------------------------------------------
// The search: statistics
// ---------------------------------------------------------------------------

/** A metric measured across several seeds. */
export interface SeedStat {
  mean: number;
  /** Sample standard deviation (n-1). 0 when n < 2. */
  sd: number;
  /** Standard error of the mean, sd/sqrt(n). */
  se: number;
  n: number;
  min: number;
  max: number;
  /** 95% CI on the MEAN via Student's t with n-1 df. Equals [mean, mean] at n=1. */
  ci95: [number, number];
  /** The per-seed values, in the seed set's own order. */
  values: number[];
}

/**
 * The verdict on a difference. The three failure states are deliberately
 * distinct, because collapsing them is the classic lie:
 * - 'equivalent'   — the whole interval sits inside +/- the practical floor.
 *                    "These are the same plan." A real, useful finding.
 * - 'inconclusive' — the interval straddles zero but is WIDER than the floor.
 *                    "We did not measure this well enough." Not the same thing
 *                    at all, and it must never be reported as no difference.
 */
export type DeltaVerdict = 'better' | 'worse' | 'equivalent' | 'inconclusive';

/**
 * A PAIRED difference measured seed-by-seed against a common baseline.
 *
 * Paired, always, and it is stronger here than the usual statistical argument.
 * bootstrapPaths() draws market futures from (historical rows, horizon, paths,
 * block years, seed, expense ratios) and nothing scenario-dependent, so two
 * plans at the same seed face BIT-IDENTICAL market futures: the difference is
 * attributable to the decision, with market luck literally held constant, not
 * merely averaged out. Measured variance-reduction factor ranges from 1.3x for
 * large structural changes to 6.4x for the near-ties that actually need
 * deciding — pairing buys the most precision exactly where it is needed.
 *
 * The pairing breaks if a comparison moves the horizon, the bootstrap block
 * length, expense ratios, or the path count. None of those is a search axis,
 * and that is not an accident.
 */
export interface PairedDelta {
  /** Mean of the per-seed differences (candidate - baseline). */
  mean: number;
  /** Sample sd of those differences. */
  sd: number;
  se: number;
  n: number;
  ci95: [number, number];
  /** Two-sided p from a paired t-test against 0. */
  p: number;
  /** Holm-Bonferroni-adjusted p across the family this row belongs to. */
  pAdjusted?: number;
  /** Sign test: seeds on which the candidate beat the baseline, out of n. */
  winsOn: number;
  verdict: DeltaVerdict;
  /** Plain-language reading, with units, interval, and what it does NOT say. */
  note: string;
  /**
   * True when this number was converted from success-at-probe-spend into
   * dollars using the measured local slope rather than measured directly by
   * bisection. Ranking-grade, not reporting-grade.
   */
  approximate?: boolean;
}

/**
 * What stage 0 measured about THIS plan before anything was searched.
 *
 * Measured rather than assumed on purpose: the noise floor moves by 3x
 * depending on where the plan sits (0.25pp at 4,000 paths near the ceiling,
 * 0.74pp in the discriminating middle), so a fixed constant would either
 * over-claim or under-claim precision on most plans.
 */
export interface SearchCalibration {
  /** Annual living spend the plan actually carries. */
  planSpend: number;
  /** Spend level candidates were screened at. */
  probeSpend: number;
  /** The incumbent's success at each calibration spend level. */
  ladder: Array<{ spend: number; success: SeedStat }>;
  /** Local slope of success per $1,000/yr of spending, at the probe. */
  successPerThousand: number;
  /** Incumbent success sd across seeds at screening precision. */
  noiseFloorScreen: number;
  /** ... and at reporting precision. Every on-screen number is read against this. */
  noiseFloorReport: number;
  /** Paired noise floor in dollars: practical resolution of a spend comparison. */
  pairedFloorDollars?: number;
}

// ---------------------------------------------------------------------------
// The search: results
// ---------------------------------------------------------------------------

/** One evaluated plan, with everything measured about it. */
export interface SearchFinalist {
  /** Stable id within this search ('baseline', or 'c0031'). */
  id: string;
  /** The chosen level VALUE per dimension (not the index) — self-describing. */
  assignment: Record<string, unknown>;
  /** English, not JSON: "retire 2029 - 72(t) on - 70/30 at retirement - ...". */
  label: string;
  /** The compiled plan, ready to keep in the plan's history or open in the workbench. */
  scenario: Scenario;
  /** Hash of the EFFECTIVE (canonicalised) scenario: equal hashes are one plan. */
  planHash: string;
  /** Screening score (success at the probe spend) from the last racing round. */
  screenScore?: number;
  /** Max sustainable annual spend, bisected per seed. The dollar score. */
  sustainableSpend?: SeedStat;
  /** Success at the probe spend, on report seeds. */
  probeSuccess?: SeedStat;
  /** Success at the plan's OWN spending — the feasibility gate. */
  successAtPlanSpend?: SeedStat;
  /** Survivor's success for a death in the probe year. */
  widowScore?: SeedStat;
  medianTerminalReal?: SeedStat;
  charitableTotalReal?: SeedStat;
  /** Earliest year any worst-decile path ran short (from the last report run). */
  worstDecileFirstShortfallYear?: number;
  /** successAtPlanSpend clears the plan's success target. */
  feasible: boolean;
  /** Paired difference against the baseline, in the objective's units. */
  delta?: PairedDelta;
  /** 1 = winner. */
  rank: number;
  /** Statistically indistinguishable from the winner after Holm adjustment. */
  tiedWithWinner: boolean;
}

/** One dimension's contribution, measured two ways because they answer differently. */
export interface SearchAttributionRow {
  dim: SearchDim;
  label: string;
  /** The winner's level on this dimension, in English. */
  winnerLevel: string;
  /**
   * REVERT-ONE-KNOB: put this dimension back to the plan's own setting while
   * everything else stays at the winner's. What dropping this decision costs,
   * given all the others. Sign convention: winner minus reverted, so positive
   * means the decision is earning its place.
   */
  insideWinner?: PairedDelta;
  /**
   * ADD-ONE-KNOB: change ONLY this dimension, from the plan as it stands.
   * What the decision is worth on its own, independent of the rest — which is
   * what the user can act on without adopting the whole winner.
   */
  onOwn?: PairedDelta;
  /**
   * True when the two agree: the decision is separable and can be taken alone.
   * False means it has a partner, and the note names it.
   */
  separable?: boolean;
  /**
   * The knob physically could not act under the winner's other settings (72(t)
   * with a penalty-free retirement, financing with no purchase). Reported as
   * "the question does not arise", never as a near-zero effect.
   */
  inert?: boolean;
  /** Every other level of this dimension at the winner's settings. */
  levels?: Array<{ label: string; delta: PairedDelta }>;
  note: string;
}

export type SearchStage =
  | 'queued'
  | 'calibrating'
  | 'screening'
  | 'racing'
  | 'reporting'
  | 'attributing'
  | 'polishing'
  | 'done'
  | 'cancelled'
  | 'error';

/** One completed or in-flight round of the successive-halving race. */
export interface SearchRound {
  index: number;
  /** Candidates entering the round. */
  candidates: number;
  /** Seeds each candidate is scored on this round. */
  seeds: number;
  paths: number;
  /** Candidates surviving into the next round. */
  keep: number;
  /**
   * The stress spending level this round scored at. It can RISE between
   * rounds: a probe calibrated on the incumbent loses all resolution once the
   * survivors are plans strong enough to score 100% at it, and a round that
   * cannot separate its field is not racing, it is shuffling. Present only
   * once the round has started.
   */
  probeSpend?: number;
  /** Share of the field that scored a saturated 100% at this round's probe. */
  saturatedFraction?: number;
  status: 'pending' | 'running' | 'done' | 'skipped';
}

/** A leaderboard row, carrying the precision it currently has. */
export interface SearchLeaderRow {
  id: string;
  label: string;
  /** Mean score this round, in the screening metric (success at probe spend). */
  score: number;
  /** Spread of that score across the round's seeds. */
  sd: number;
  seeds: number;
  paths: number;
  /**
   * Half-width of the 95% CI on the mean — the visible error bar.
   *
   * ABSENT at one seed, and that is deliberate: a single observation licenses
   * no interval at all, and a "± 0" would read as infinite precision on the
   * least precise row in the table. Show the row as a screening estimate with
   * no bar rather than inventing one.
   */
  ci95HalfWidth?: number;
  /** Slope-converted dollar reading of the score, for scale. */
  impliedSpend?: number;
  /**
   * TRUE until the held-out report stage has run. A screening score is a
   * RANKING signal, not a result: the maximum of a noisy sample is biased
   * upward by roughly sd x E[max of k], which at 1,024 candidates and the
   * measured 1-seed noise is +6.5pp of pure luck. The UI must badge these.
   */
  screeningEstimate: boolean;
}

/**
 * THE REPORT. Everything the user reads, and nothing chosen by the same seeds
 * that measured it.
 */
export interface SearchReport {
  searchId: string;
  label?: string;
  createdAt: string;
  engineVersion: string;
  /**
   * The profile and assumptions every plan in this report was scored under,
   * `"<profileHash>:<assumptionsHash>"`. Two reports with different values here
   * measured different worlds, however alike their plans look — a profile edit
   * moves a score exactly as an engine bump does.
   */
  inputsHash: string;
  /** Hash of the axes + base plan: two searches of the same space are linkable. */
  spaceHash: string;
  axes: SearchAxis[];
  objective: SearchObjective;
  /** The two disjoint seed sets, recorded so any of this can be re-paired later. */
  seeds: { selection: number[]; report: number[] };
  paths: { screen: number; race: number; report: number };
  calibration: SearchCalibration;
  /** Candidates drawn (including the incumbent and its one-knob neighbours). */
  candidatesGenerated: number;
  /** Distinct plans after inert-level canonicalisation. The honest denominator. */
  distinctPlans: number;
  /** Simulations actually executed. */
  evaluations: number;
  /** Simulations answered from cache instead. */
  cacheHits: number;
  rounds: SearchRound[];
  baseline: SearchFinalist;
  finalists: SearchFinalist[];
  /**
   * The complete set of plans statistically indistinguishable from the winner,
   * INCLUDING the winner's own id. A single crowned winner out of a noisy
   * search is the failure mode this whole design exists to avoid; when several
   * plans tie, saying so IS the result — "these three are the same plan as far
   * as this model can tell; choose among them on grounds it does not know."
   */
  tieBracket: string[];
  attribution: SearchAttributionRow[];
  /**
   * The winner's total gain minus the sum of the add-one-knob parts. The parts
   * never add up, and pretending they do is the classic attribution lie — so
   * the remainder is reported rather than hidden.
   */
  interactionResidual?: number;
  /**
   * Every claim the report is NOT entitled to make, in the user's language:
   * sampling coverage, cancelled stages, slope-converted approximations,
   * saturated metrics.
   */
  caveats: string[];
  /** True when the search was cancelled and this is the partial answer. */
  truncated: boolean;
  elapsedMs: number;
}

/** Poll shape for a running search. */
export interface SearchProgress {
  searchId: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  stage: SearchStage;
  /** Stage in words, e.g. "racing 64 plans on 8 seeds x 4,000 paths". */
  stageLabel: string;
  /** Simulations finished (cache hits included) and expected in total. */
  evaluated: number;
  total: number;
  cacheHits: number;
  /** Measured evaluations per second, cache hits excluded. */
  ratePerSec: number;
  startedAt: string;
  elapsedMs: number;
  /** Remaining time from the measured rate. ABSENT until it is meaningful. */
  etaMs?: number;
  rounds: SearchRound[];
  /** Top rows as they stand, with their current (visibly widening) error bars. */
  leaderboard: SearchLeaderRow[];
  calibration?: SearchCalibration;
  report?: SearchReport;
  error?: string;
  message?: string;
}

/** Row in the saved-search index. */
export interface SearchSummary {
  searchId: string;
  label?: string;
  createdAt: string;
  engineVersion: string;
  spaceHash: string;
  dims: SearchDim[];
  candidatesGenerated: number;
  winnerLabel?: string;
  truncated: boolean;
  elapsedMs: number;
}
