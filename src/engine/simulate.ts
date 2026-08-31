/**
 * Simulation engine core (SPEC §4): prepareSim / simulatePath / runSimulation.
 *
 * prepareSim precomputes everything path-independent (event schedules, claim
 * dates and benefit factors, health-coverage months, tax data bundle, horizon)
 * so Monte Carlo pays the setup cost once. simulatePath runs one return path
 * through the yearly loop; runSimulation orchestrates the three modes and the
 * metrics (SPEC §4.3/§4.5).
 *
 * Yearly order of operations (SPEC §4.1):
 *   1. ages at year end (year - birthYear); allocations for the year
 *      (untargeted allocation events -> account-targeted events -> automatic
 *      target-date-fund glide); 401(k) -> IRA rollover in a retirement year
 *   2. income: wages net of the 401(k) deferral AND the employee share of the
 *      employer health premium (both pre-tax payroll deductions), Social
 *      Security (effective PIA x claiming factor x cumulative simulated CPI =
 *      COLA, SPEC §5), the retirement income stream (retirementMonthly x the
 *      months nobody worked x CPI), savings interest (bills return,
 *      distributed as cash, not compounded), brokerage dividends (stocks
 *      sleeve x stockDividendYield, qualified) and bond/bill sleeve interest
 *      (full nominal return distributed, price flat), one-time income
 *   3. expenses: living (fixed_real: livingMonthly x 12 x CPI while anyone
 *      earns, livingMonthlyRetired once nobody does; fixed_percent: percent x
 *      start-of-year portfolio, which overrides both sides; guardrails: the
 *      fixed_real figure times a factor the rails move, note 22) x 'living'
 *      expense_change multipliers + deltas, charitable giving (the paycheck
 *      stream charitableMonthly x 12 x CPI x 'charitable' expense_change
 *      factors while anyone earns; the retirementGiving rule once nobody does),
 *      housing module, one-time
 *      expenses (health premiums join inside the tax loop because the ACA
 *      true-up needs MAGI)
 *   4. housing module (sale proceeds land in savings immediately)
 *   5. forced distributions: RMDs from rmdStartAge (prior-Dec-31 balances /
 *      Uniform Lifetime Table) and any active 72(t)/SEPP payment
 *   6. withdrawal solve: fixed-point iteration — taxes change required
 *      withdrawals, withdrawals change taxes; converges when the plan (and
 *      any Roth conversion) moves less than $1, max 60 iterations then the
 *      'no-convergence' flag
 *   7. the converged computeYear call IS the year's tax record (traced only
 *      on the reference path)
 *   8. apply flows, move the investing stream into the taxable brokerage; what
 *      is left over is REINVESTED there once nobody earns, and CONSUMED (never
 *      accumulated) in any year someone still earns; grow balances per allocation
 *      (savings never compounds its distributed interest; brokerage stocks
 *      grow at total return minus the distributed dividend yield; bond/bill
 *      sleeves are price-flat; retirement accounts compound full returns)
 *   9. record the YearRow
 *
 * Additional documented conventions:
 * - startYear = 2026, the tax-data base year: simulated year 1 is tax year
 *   2026 and all CPI indexing anchors there (inflationIndex = 1.0 at start).
 * - Scenario expense/income overrides: assumption_overrides.expenses replaces
 *   any of the profile's monthly streams (BOTH sides of each pair) for the run,
 *   and assumption_overrides.income replaces the retirement income stream
 *   (prepareSim applies them next to the market/aca/settings merge), so a
 *   what-if can drag spending or add part-time income without rewriting
 *   profile.json. Everything downstream — expense_change events, the
 *   working/retired switch, the solvers' spending sweeps — operates on the
 *   overridden values.
 * - PAIRED STREAMS (note 19). Living, investing and giving each have a value
 *   in play WHILE WORKING and a value in play AFTER nobody works, and all
 *   three switch on ONE signal: household.employerMonthsByYear, the months
 *   anyone in the household earned. 12 = the working figure, 0 = the retired
 *   figure, in between (the retirement year) = prorated between them by worked
 *   months. What an absent retired value means differs per stream, because the
 *   honest default differs: living keeps the WORKING figure (costs do not fall
 *   the day the salary stops), investing falls to 0 (investing out of a
 *   paycheck ends with the paycheck), giving keeps its 'continue' rule. In all
 *   three cases the absent case is bit-for-bit the engine before the pairs
 *   existed — the blend is skipped, not computed with equal operands.
 * - GUARDRAILS (note 22, SpendingPolicy type 'guardrails'; Guyton-Klinger).
 *   Real living spending HOLDS CONSTANT while the current withdrawal rate —
 *   this year's living spend over this year's spendable portfolio — stays
 *   inside [lower, upper] multiples of the rate the plan opened at. Above the
 *   upper rail spending is cut by `adjustment`, below the lower rail it is
 *   raised by the same, and BETWEEN THEM NOTHING HAPPENS. That inaction is the
 *   whole difference from fixed_percent, which re-prices spending every single
 *   year and swings the standard of living with the market. An absent band is
 *   DEFAULT_GUARDRAILS.
 *   THE OPENING RATE IS TAKEN IN THE FIRST FULLY RETIRED YEAR, not the first
 *   simulated one: while a salary is paying the bills the household withdraws
 *   nothing, so spending-over-portfolio there is not a withdrawal rate, and
 *   anchoring on it would hand a household a raise the day it retires purely
 *   because the portfolio grew while it was still earning. A plan that never
 *   retires inside the horizon never anchors, and behaves as fixed_real.
 *   THE FLOOR (floorFraction, default 0.7) is ours, not Guyton-Klinger's: the
 *   published rule has none, and without one a long bad sequence stacks cut on
 *   cut until the plan "succeeds" on a standard of living nobody would accept.
 *   Cuts do NOT re-anchor the band — the rate is always measured against the
 *   opening one, or a plan would ratchet itself down one crossing at a time.
 *   Years a rail actually moved spending carry a 'guardrail-cut' /
 *   'guardrail-raise' flag; years the floor absorbed the cut do not, because
 *   nothing about the household's spending changed.
 *   THE CEILING (raiseCeiling, ABSENT BY DEFAULT) is the same kind of knob on
 *   the prosperity side: raises may not push the factor above it. Absent means
 *   the published uncapped rule, bit for bit; a raise the ceiling absorbs
 *   entirely reports no raise, the floor's own ruling mirrored.
 *   EVERY PATH RECORDS its cut/raise history (GuardrailPathStats: ever cut,
 *   deepest factor, years below plan, ever above plan, floor touched) and
 *   runSimulation aggregates them into RunResult.guardrailStats — before this,
 *   each path applied its cuts internally and reported only survival, so a
 *   plan could look 97% safe while funding that safety with spending cuts in a
 *   third of its futures and nothing on screen said so.
 *   fixed_real and fixed_percent are untouched: the factor is exactly 1 under
 *   them, and multiplying by 1 is exact.
 * - PER-LINE SURVIVOR SPENDING (note 22, ProfileExpenses.lines). When the
 *   profile carries an itemised budget, a survivor's living costs are the sum
 *   of the per-line survivor amounts rather than one fraction of the couple's
 *   baseline. A household with ONE CAR does not see its $610 payment fall by
 *   a quarter when one of two people dies, and no single fraction can say so.
 *   An explicit `livingFraction` on the death event still wins (the user asked
 *   a specific what-if); with no budget the global default still applies. All of
 *   it is resolved path-independently in household.ts and arrives as the same
 *   `livingFactorByYear` multiplier the yearly loop always applied.
 * - MULTI-POLICY LIFE INSURANCE (note 22, ProfileExpenses.lifeInsurancePolicies).
 *   Each policy has its own insured, premium, term window and
 *   `cancelAtRetirement` flag (default FALSE — a policy you are paying for is
 *   one you are paying for, and dropping it is a decision the plan should show
 *   you making). Premiums sum across the policies in force, prorated inside the
 *   year a term ends; the benefit is the sum over the policies covering the
 *   month of death whose insured is the person who died. The single-policy
 *   fields resolve to exactly one policy through the same code, so a profile
 *   written before the list existed is bit-for-bit unchanged.
 * - Three expense streams (note 12): living and charitable are consumption and
 *   land in expenses.total; investing is NOT — it moves cash into the taxable
 *   brokerage (balance AND basis) and is capped at the year's surplus so it can
 *   never force a withdrawal, on both sides of the pair. While anyone earns,
 *   the EXPLICIT investing stream is the ONLY thing that accumulates: see
 *   'LEFTOVER CASH WHILE WORKING' below.
 * - LEFTOVER CASH WHILE WORKING IS CONSUMED, NOT ACCUMULATED (note 20). In any
 *   year someone earns a salary — employerMonthsByYear > 0, the same signal the
 *   paired streams switch on — the cash left after taxes, recorded expenses and
 *   the explicit investing transfer is CONSUMED. It does not enter the
 *   brokerage, it does not enter savings, and it never appears as a balance;
 *   it is recorded on the YearRow as `unbudgeted` so the cash identity still
 *   closes to the cent and the cashflow table can show where it went.
 *   WHY: livingMonthly is a BUDGET BASELINE. It does not carry the irregular,
 *   lumpy costs a real year brings — replacing an air conditioner, a car
 *   repair, a trip, home maintenance above the modeled percentage — and those
 *   are exactly what the leftover of a paycheck pays for. Sweeping that
 *   leftover into the brokerage assumes an accumulation that does not happen
 *   and flatters every result. The only accumulation the engine may assume
 *   while a salary is coming in is the amount the household SAYS it invests.
 *   THE RETIREMENT YEAR follows the WORKING rule in full (no sweep) rather than
 *   being prorated. Living, giving, investing and retirement income are all
 *   PER-MONTH flows, so splitting them 5/12 - 7/12 means something; a surplus
 *   is not a per-month flow, it is one undifferentiated pool of year-end cash
 *   mixing part-year salary with any forced distribution. Prorating it would
 *   assign salary dollars to the retired rule and forced-distribution dollars
 *   to the working rule in whatever ratio the calendar happened to produce —
 *   arithmetic without a meaning. The conservative reading is also the one the
 *   user can state in a sentence and check: in any year a paycheck arrives,
 *   leftover cash is consumed.
 *   A SHORTFALL is unaffected: when income cannot cover taxes + expenses + the
 *   explicit investing, the withdrawal machinery runs exactly as it always did.
 * - THE RENTING COLUMN (note 23, ExpenseLine.monthlyRenting). A living line can
 *   carry a third figure: what it costs while the household is BETWEEN HOMES —
 *   sold, renting, purchase pending. The window is not profile data: it is the
 *   span from the sale month (inclusive) to the purchase month (exclusive) of
 *   the scenario's compiled sell/buy events — exactly the months the rent is
 *   charged for — and a plan with no purchase (rent to the horizon) has NO
 *   window, because "between homes" requires a home to be between. The yearly
 *   loop blends month-accurately: in-window months price at the renting totals
 *   (lines without the field inherit their in-force figure), out-of-window
 *   months at the ordinary working/retired blend, and both interact with the
 *   retirement proration because worked months are a prefix of the year and
 *   the window is one contiguous span. ABSENT everywhere = the blend is
 *   skipped outright, bit-for-bit the pre-column engine. A scenario override
 *   of livingMonthly/livingMonthlyRetired disables the column for that run:
 *   the override states living wholesale (that is how the solvers sweep
 *   spending), and applying a per-line dwelling discount to a number that no
 *   longer comes from the lines would bank a reduction off a baseline nobody
 *   stated. PRECEDENCE WITH A DEATH: from the death YEAR on the survivor
 *   column governs and the renting column is ignored — see the blend site.
 * - CASH BANKING BETWEEN SALE AND PURCHASE (note 24). While a sale has
 *   happened and a PURCHASE is still pending — the same window as note 23,
 *   which by construction requires a coming purchase — money needed for the
 *   imminent buy must not be in stocks, so the household's deliberate
 *   accumulation is parked in cash: (a) the investingMonthly stream's
 *   in-window share is redirected to SAVINGS instead of the brokerage, and
 *   (b) the living reduction the renting column freed — (in-force base living
 *   minus renting living), month-prorated, when positive — is banked to
 *   savings as well instead of being consumed (working years, note 20) or
 *   swept into the brokerage (retired years). Both are capped by the year's
 *   actual surplus, so neither can force a withdrawal. Sale proceeds already
 *   sit in savings earning the cash yield (with the mid-year credit), so
 *   nothing here touches them — that would double-count. A rent-to-horizon
 *   plan has no window and keeps the old consumption rule everywhere. The
 *   reference path records the whole funding story in
 *   RunResult.purchaseFunding (pre-existing savings + proceeds + banked
 *   investing + banked reduction + interest vs. the purchase), which is what
 *   the Housing card's readout shows.
 * - RETIREMENT INCOME (note 19, ProfileIncome.retirementMonthly): the mirror
 *   image of a salary — part-time work, consulting, a rental, a pension — in
 *   today's dollars per month, inflation-adjusted, starting the first year
 *   nobody draws a salary (prorated in the retirement year) and continuing for
 *   life. It is spendable cash (it reduces the year's required withdrawal),
 *   it is ALWAYS ordinary income (the app's standing rule, 2026-08-31 — it
 *   raises AGI and every MAGI test; the old retirementIncomeTaxable flag is
 *   parsed but ignored), and it is reported in YearRow.income.retirement. The automatic-72(t) estimator counts a full
 *   retired year of it, so part-time work shrinks the series and locks up less
 *   of the IRA.
 *   DOCUMENTED SIMPLIFICATION: the Social Security EARNINGS TEST is not
 *   modeled. Claiming before Full Retirement Age while earning above the annual
 *   exempt amount withholds benefits ($1 per $2 over the limit; $1 per $3 in
 *   the FRA year) and credits the withheld months back at FRA. This household
 *   claims at 67 — its FRA — where the test never applies, so nothing here is
 *   affected; a 62 claim combined with part-time earnings above the limit would
 *   overstate benefits in those years. Taxable retirement income is also
 *   modeled as plain ordinary income, not wages: no payroll tax, and it creates
 *   no earned income for IRA-contribution purposes.
 * - GIVING IN RETIREMENT (note 18, ProfileExpenses.retirementGiving; ABSENT
 *   MEANS 'continue', which is bit-for-bit the pre-rule engine) — the retired
 *   side of the charitable pair. While anyone is still earning, charitable
 *   giving is the paycheck stream exactly as before. From the first year in
 *   which NOBODY earns — the same worked-months signal
 *   (household.employerMonthsByYear) that switches living and investing, so all
 *   three change together — the configured rule takes over, and
 *   the retirement year itself is prorated: the paycheck stream for the months
 *   worked, the rule for the rest. The percentage rules read the PRIOR year's
 *   base (real portfolio growth, or Social Security + gross withdrawals)
 *   because this year's base depends on this year's withdrawals, which depend
 *   on this year's spending, which would include the giving — a circular
 *   definition the fixed point cannot resolve; the prior year is also what a
 *   person would actually know when deciding what to give. Whatever the rule
 *   returns lands in exactly the same places the paycheck stream did:
 *   expenses.charitable, expenses.total, and TaxYearInputs.charitableGiving
 *   (so the OBBBA non-itemizer deduction and the 0.5%-of-AGI itemizer floor
 *   still apply). Years the rule governs carry the 'giving-rule' flag and, on
 *   the traced path, trace lines naming the rule and its base.
 *   REAL PORTFOLIO GROWTH for a year = that year's nominal investment gain
 *   across all accounts (distributed savings interest + bond/bill interest +
 *   dividends, plus the growth applied to balances in step 8) MINUS the year's
 *   CPI rate on the START-OF-YEAR total balance. Contributions, withdrawals,
 *   surplus sweeps and rollovers are not gains and never count.
 *   'charitable' expense_change events retarget the PAYCHECK stream (that is
 *   what they were built for); once a non-'continue' rule governs a year, the
 *   rule's own parameters set the giving.
 * - THE TITHE ACCOUNT (note 21 — now THE UN-TITHED POT,
 *   ProfileExpenses.untithedPot, paired with the ongoing method above). The
 *   user thinks in two independent decisions: what to do with the pot of
 *   never-tithed gains, and how to tithe going forward. The old bundled
 *   'tithe_account' rule fused them; it is normalised into the pair before
 *   PreparedSim is built (resolveGivingPair — the engine-boundary safety net;
 *   dataStore migrates stored files) and never governs a year. The pot's
 *   MECHANICS below are UNCHANGED — `deferYears` is now `holdYears`, the seed
 *   share is the pot's own `percent`, and the accrual/trailing stream is the
 *   ongoing percent_of_growth method — with ONE new knob:
 *   `ongoingDuringHold`. 'accrue_to_pot' (the default, and the bundle's
 *   behaviour) accrues the growth tithe into the pot through the hold;
 *   'give_cash' pays the ongoing method in cash from retirement day, fully
 *   independent of the pot. A pot paired with a NON-growth ongoing method
 *   (amount, percent_of_income, continue, none) seeds/holds/locks/distributes
 *   exactly the same, but the hold accrues nothing — only a growth tithe has
 *   anything growth-shaped to accrue — so the ongoing method simply pays cash
 *   throughout: the hold defers the POT, not the giving. When a pot is
 *   present, the ongoing percent_of_growth stream reads the HIGH-WATER-MARK
 *   base described below (that is what the bundle's trailing stream always
 *   was); without a pot it keeps its plain prior-year-growth base, so every
 *   existing non-pot plan is bit-for-bit unchanged. Giving stops
 *   being a monthly cheque and becomes a BALANCE. On the first fully-retired
 *   year the engine carves a second traditional IRA — `<parentId>-tithe`, out
 *   of the largest pre-tax account the household can actually split — using
 *   the same device the 72(t) split-IRA technique already uses (note 16). It
 *   is a pure balance re-label: no cash leg, no distribution, no tax. Funding a
 *   real brokerage giving-account instead would cost a taxable IRA withdrawal
 *   the household never intended to make.
 *   SEED: percent x the untithed gains across every pre-tax and Roth account,
 *   `max(0, balance - lifetimeContributions)` summed. An account with no
 *   `lifetimeContributions` contributes 0 and raises the 'tithe-basis-missing'
 *   flag — under "tithe the gross, once" contributed dollars came out of
 *   already-tithed pay, so without the figure the engine cannot tell tithed
 *   principal from untithed growth and refuses to guess.
 *   DEFER YEARS — THE SOFT WINDOW (until the lock; at most `deferYears`
 *   fully-retired years): CASH GIVING IS 0. At each year end percent x the
 *   growth base moves parent IRA -> carve-out. That transfer is
 *   intra-portfolio: it changes balances.byAccount and nothing else — no
 *   income, no expense, no withdrawal, no tax, and NO TERM IN THE CASH
 *   IDENTITY, exactly like the 72(t) split. The carve-out itself, though, is
 *   NOT yet locked: it counts in balances.spendable and the success metric,
 *   and the withdrawal solve may draw it — LAST, after every bucket the
 *   policy names (computeWithdrawalPlan's lastResortAccountId documents the
 *   ordering decision). A draw shrinks the pot for good: the promise absorbs
 *   the emergency, which is the break-glass behaviour made automatic. WHY the
 *   window is soft: the user deferred the giving to move the tithing DRAG
 *   past the fragile first retired years; a hard lock on retirement day
 *   removed spendable money on day one and front-loaded the drag to exactly
 *   those years, deferring only the DELIVERY.
 *   THE LOCK, at distribution start — the EARLIER of the defer window
 *   elapsing and the safe-zone early release (rule.earlyRelease, ABSENT =
 *   TRUE): once a path's spendable REAL balance sets a new high after the
 *   first fully-retired year, the fragile window is provably over and the
 *   lock (and distribution) start the NEXT year instead of waiting. Real, not
 *   nominal — a nominal high arrives in almost every mildly-inflationary year
 *   and would make the trigger meaningless. From the lock year the carve-out
 *   is charity money in escrow: out of spendable, out of the metrics, out of
 *   the ordering and conversions, exactly the old hard-carve treatment.
 *   DISTRIBUTION (from the lock year): transfers in stop, and two cash
 *   streams start. (1) THE POT pays out over rule.distributeYears (ABSENT =
 *   10): each year gives balance / years-remaining — an RMD-style
 *   annuitisation, so mid-distribution growth is given too and the pot is
 *   exactly empty on schedule. The instalment is a real IRA distribution
 *   (ordinary income, penalty rules apply) given away the same year.
 *   (2) TRAILING GROWTH: percent x the PRIOR year's growth base through the
 *   ordinary giving machinery, starting the year AFTER the lock (the lock
 *   year's own base was the last one accrued — see retirementGivingAnnual).
 *   Both land in expenses.charitable, expenses.total and the charitable
 *   deductions like any other rule's figure. Pot exhausted -> only the growth
 *   stream remains.
 *   GROWTH BASE = a HIGH-WATER MARK on the REAL value of the SPENDABLE
 *   portfolio (everything except the carve-out — never tithe the tithe):
 *   `max(0, realEnd - previousRealPeak)`, then the peak advances to realEnd.
 *   A portfolio that falls and recovers has re-earned ground already tithed on
 *   the way up, and tithing the recovery would tithe the same dollars twice.
 *   The peak starts at the spendable portfolio on retirement day, because the
 *   seed has just settled everything earned before it. The peak advances to
 *   the PRE-transfer value, so the dollars moved into the carve-out are never
 *   counted as growth again.
 *   SPENDABILITY FOLLOWS THE LOCK. The carve-out's id joins `locked` (the set
 *   that hides an account from the withdrawal ordering and from Roth
 *   conversions) in every year it exists — but through the soft window it is
 *   handed back to the solve as the LAST-RESORT account, so it funds a year
 *   only when everything else is dry. Its balance is subtracted from the real
 *   series that feeds the fan, the terminal value and the success rate ONLY
 *   from the lock year on: locked money is charity's and must not flatter
 *   the odds, soft money is the household's backstop and honestly counts.
 *   YearRow keeps both figures: balances.total/totalReal always include it
 *   (it is a real IRA balance); balances.spendable/spendableReal drop it from
 *   the lock year. RunResult.breakGlassReal stays "what sat in the account
 *   when a failing path first fell short" — under the soft window that is
 *   typically ~0 (the path drained its last resort before failing), and a
 *   large figure now specifically means the path failed AFTER the lock.
 *   IT IS STILL AN IRA FOR THE IRS. `locked` guards withdrawals and
 *   conversions; it does NOT guard RMDs, and it must not — the Service sees
 *   one account and the required distribution runs off the whole balance. So
 *   computeRmds keeps iterating every pre-tax account including this one (the
 *   household total is exactly invariant to the split: same owner, same age,
 *   same divisor). The dollars an RMD forces out of the carve-out cannot stay
 *   inside and are not the household's to spend, so they are GIVEN AWAY in
 *   cash that year, on top of whatever the rule prescribes.
 *   DOCUMENTED SIMPLIFICATION — NO QCD. A gift funded out of an IRA is modeled
 *   here as an ordinary taxable distribution plus a §170 cash contribution. In
 *   practice most households would use a qualified charitable distribution
 *   (IRC 408(d)(8)), which is EXCLUDED from gross income entirely rather than
 *   deducted from it — worth real money, because AGI drives the ACA credit,
 *   IRMAA, the taxability of Social Security, NIIT and the 0.5%-of-AGI
 *   charitable floor. Modeling it would take a new funding-source concept in
 *   the tax layer plus the 70 1/2 eligibility test and the annual per-owner cap
 *   ($111,000 for 2026, Notice 2025-67). Until then this rule is CONSERVATIVE:
 *   it overstates AGI in the disbursement years, never understates it.
 *   AT DEATH the whole carve-out goes to charity. There is no estate modeling,
 *   so that is an accounting statement, not a cash flow: the balance is out of
 *   terminal wealth and reported in RunResult.charitableLegacy instead. It is
 *   also the right tax answer — an IRA left to a 501(c)(3) is IRD received by a
 *   tax-exempt entity with an uncapped IRC 2055(a) estate deduction, so every
 *   dollar arrives.
 * - 401(k) -> IRA rollover at separation (note 7): in the year a person's
 *   retire event fires, every 401(k) they own merges into their first
 *   traditional IRA (a synthetic one is created when they own none) before the
 *   withdrawal solve. The rolled dollars adopt the DESTINATION IRA's
 *   allocation; the emptied 401(k) still appears in balances.byAccount at 0;
 *   that year's contributions/match (prorated to worked months) follow the
 *   money into the IRA. Consequence: no penalty-free pre-59 1/2 401(k) door
 *   survives — the bridge is savings + taxable + Roth basis + 72(t).
 * - Target-date funds (note 8) glide automatically toward 50/50 at the target
 *   year and 30/70 seven years later; any allocation event that touches the
 *   account switches the automatic glide off from that date.
 * - Non-qualified Roth earnings are taxed as otherOrdinaryIncome (their 10%
 *   penalty flows through the distributions slices).
 * - Cash purchases of a house are withdrawn through the normal withdrawal
 *   machinery as a NON-consumption outflow (the money becomes home equity).
 * - Tracked sale proceeds a purchase does not consume (e.g. the 80% above a
 *   20% down payment on a financed buy) move savings -> taxable brokerage at
 *   purchase time, raising basis, so they grow per allocation (SPEC §9.3);
 *   with no brokerage account they stay in savings.
 * - Surplus cash in a RETIRED year (nobody earns) is REINVESTED in the first
 *   taxable brokerage — balance AND costBasis rise, since it is after-tax
 *   money — falling back to the first savings account when the household holds
 *   no brokerage (and to a synthetic savings account when it holds neither).
 *   Such a surplus can only be a FORCED distribution the year did not need,
 *   because the withdrawal solve takes only what is needed: an RMD or a 72(t)
 *   payment arrives, the tax is paid, and the rest is bought back into the
 *   market rather than left earning the T-bill rate. In a WORKING year there
 *   is no sweep at all — the leftover is consumed (see note 20 above).
 *   House-SALE proceeds are the one exception: they still land in savings,
 *   because SPEC §9.3 then moves whatever a purchase does not consume into the
 *   brokerage.
 * - AUTOMATIC 72(t)/SEPP (scenario.autoSepp; UNDEFINED MEANS ON): a person who
 *   retires before their own penalty-free year elects a series in the
 *   retirement year on their largest traditional IRA — the account the 401(k)
 *   just rolled into, so the payment is sized off the merged balance. The
 *   payment is the household's projected FULL-YEAR cash need over the bridge
 *   (estimateBridgeAnnualNeed), capped at the whole-account formula maximum,
 *   and the split-IRA technique below carves out only the principal that
 *   payment requires — the remainder stays an ordinary, accessible IRA. An
 *   explicit start_72t event always wins: a person who wrote one gets no
 *   automatic election. Automatic elections show up in eventsFired as
 *   'auto-sepp' and trace exactly like hand-written ones.
 *   THE ELECTION RESPECTS THE CALENDAR (Fix A, DECISIONS.md): committed
 *   one-off outflows scheduled inside the prospective lock window —
 *   numeric-price house purchases above all — cap the carve so the un-carved
 *   remainder can still produce them; an election the cap zeroes is DECLINED
 *   that year and re-offered the next.
 * - BUSTING A 72(t) IS A PRICE, NOT A WALL (Fix B, DECISIONS.md): a year that
 *   cannot meet its need after every source the ordering may touch — the
 *   tithe last-resort seat included — while a live series still locks money
 *   BUSTS the series instead of failing: the lock lifts permanently, the draw
 *   proceeds (ordinary penalty rules apply to it), and the year is charged
 *   the IRC 72(t)(4) recapture — 10% of every pre-59 1/2 payment the series
 *   made, plus interest at the path's own T-bill return per elapsed year.
 *   Applies to hand-written start_72t series exactly as to automatic ones.
 *   eventsFired carries 'sepp-busted'; the trace itemises the price.
 * - Insolvency: the accessible buckets could not cover the year's cash need ->
 *   insolvencyYear (the success metric's failure signal) + the 'insolvent'
 *   flag. Balances are NOT zeroed: the plan already drew everything the
 *   ordering could reach, and money it could not reach — an illiquid balance,
 *   or a locked 72(t) SEPP IRA whose bust could not cover the year either —
 *   is still real and keeps compounding, so it stays in balances.byAccount,
 *   the fan, and the terminal value (SPEC §4.1). Since Fix B a year can only
 *   go insolvent BESIDE a locked SEPP IRA after busting it first (or when
 *   even the bust was not enough): failing while refusing to touch the
 *   household's own money is the behaviour the 0.0% incident retired.
 *   ONE DELIBERATE EXCEPTION, added with note 21: a LOCKED Tithe Account
 *   carve-out is money the household has promised away, so it stays in
 *   balances.byAccount and keeps compounding but is REMOVED from the fan and
 *   the terminal value. The difference from a locked SEPP IRA is what the
 *   money is for — a SEPP IRA is the household's own money it merely cannot
 *   reach this year, and it funds the household again the moment the lock
 *   lifts. (Through the SOFT window the carve-out is drawn LAST by the
 *   ordering, so an insolvent soft-window year has, by construction, already
 *   emptied it — there is nothing left to exclude.)
 * - 72(t)/SEPP split-IRA technique (note 16): an election with an
 *   `annualAmount` below the formula maximum SPLITS the account — a carved-out
 *   SEPP IRA `<id>-sepp` ("<name> (72(t) SEPP)") sized so its own formula
 *   maximum equals the requested payment, plus a remainder that keeps the
 *   original id and stays an ordinary, fully accessible traditional IRA
 *   (penalized before 59 1/2 like any other). ONLY the carve-out is locked;
 *   both halves grow per the account's allocation, and an allocation event
 *   naming the original account reaches both.
 * - IRMAA lookback years before the first simulated year fall back to the
 *   first simulated year's MAGI (0 for a household already on Medicare in
 *   year one, i.e. standard premiums).
 * - YearRow.expenses.total = baseline + charitable + housing + health +
 *   oneTime exactly (the shared-types contract; taxes are reported separately
 *   in taxes.totalTax). The withdrawal solve's internal cash need still adds
 *   taxes and health premiums on top — that number is not recorded as
 *   expenses.total. Recorded-cash identity for a solvent year:
 *   income.total + gross withdrawals (cash+taxable+pretax incl RMD and SEPP
 *   +roth) = expenses.total + taxes.totalTax + investing + surplus reinvested
 *   + unbudgeted + purchase outflows + mortgage-payoff lumps
 *   (payoffAfterYears — a capital outflow exactly like the purchase's, and
 *   like it deliberately NOT inside expenses.housing).
 *   `unbudgeted` is the leftover a WORKING year consumed (note 20); `surplus
 *   reinvested` is the retired year's sweep. At most one of the two is ever
 *   non-zero in a given year, and between them the identity closes TO THE CENT
 *   — the consumed cash is recorded, not left to vanish into a rounding gap.
 *   THE TITHE ACCOUNT ADDS NO TERM (note 21). Its seed and its yearly accrual
 *   are intra-portfolio balance moves — one IRA balance down, another up,
 *   total unchanged — so they belong in the identity exactly as much as the
 *   72(t) split does, which is not at all. The tithe money that IS cash — the
 *   trailing-growth gift, the pot's distribution instalments, and the
 *   carve-out's forced RMD — all arrives as `expenses.charitable`, a term the
 *   identity already had (the instalment and the RMD also arrive on the
 *   income side as forced pre-tax distributions, so they wash exactly). A
 *   soft-window LAST-RESORT draw is an ordinary withdrawal-plan slice and
 *   needs no term of its own.
 * - Untargeted allocation_change / glidepath events set every account's
 *   allocation except savings (savings is cash earning the bills rate by
 *   definition); events carrying an `account` set only that one.
 * - The employee share of the employer health premium is a payroll deduction,
 *   NOT a health expense: it lowers wages for tax and for take-home cash and
 *   is reported for information in income.employerHealthPremiumShare.
 */

import { sha256Hex } from '../shared/sha256';
import type {
  AssetMix,
  FilingStatus,
  GuardrailPathStats,
  LifeInsurancePolicy,
  LifeInsurancePolicyPlan,
  OngoingGivingRule,
  ProgressFn,
  PurchaseFundingTrace,
  RetirementDistribution,
  RunResult,
  SimulationInput,
  StateCode,
  TaxDataBundle,
  TaxYearInputs,
  TaxYearResult,
  WithdrawalPolicy,
  YearReturns,
  YearRow,
} from '../shared/types';
import { DEFAULT_GUARDRAILS, ENGINE_VERSION } from '../shared/types';
import { resolveGivingPair, type ResolvedUntithedPot } from '../shared/giving';
import { deriveExpenseStreams, rentingLivingMonthly } from '../shared/expenses';
import { stableStringify } from '../shared/util';
import { bracketsFor, computeYear, homeSaleExclusionFor } from '../tax/index';
import {
  allocationSchedules,
  applyAssumptionOverrides,
  expenseScheduleByYear,
  oneTimeExpenseByYear,
  oneTimeIncomeByYear,
  parseEvents,
  rentMonthsByYear,
  residencyByYear,
  rothConversionByYear,
  withdrawalPolicyByYear,
  type ParsedBuyHouse,
  type TargetedMix,
} from './events';
import { prepareHousehold, SIM_START_YEAR, type PreparedHousehold } from './household';
import { eventsWithHousingPlan, planHomeGrowthRate } from './housingPlan';
import {
  aggregateGuardrailStats,
  buildFan,
  percentileSorted,
  successRate,
  worstDecileShortfallYears,
} from './metrics';
import { bootstrapPaths, deterministicPath, historicalPaths } from './returns';
import {
  applyRmds,
  applyRothConversion,
  applyWithdrawalPlan,
  cloneAccountStates,
  computeRmds,
  computeWithdrawalPlan,
  conversionDistributions,
  initAccountStates,
  isPretax,
  isRetirementWrapper,
  planRothConversion,
  autoSeppForYear,
  prepareAutoSepp,
  prepareSepp,
  rmdDistributions,
  seppAnnualPayment,
  seppDistributions,
  seppSplit,
  type AccountState,
  type AutoSeppPlan,
  type ConversionSlice,
  type OwnerWithdrawalInfo,
  type PreparedSepp,
  type RmdItem,
  type SeppAccountRef,
  type WithdrawalPlan,
} from './withdrawals';
import {
  cloneHousingState,
  initHousingState,
  projectedPayoffLump,
  remainingBalanceAfterPayments,
  runHousingYear,
  type HousingState,
} from './housing';

/**
 * The most of an IRA an AUTOMATIC 72(t) will put under the series. Sizing to the
 * full projected need can drive the payment to the formula maximum, which locks
 * every dollar; the remainder outside the series is what covers a year needing
 * more than the fixed payment. An explicit start_72t is NOT capped — a
 * hand-written election is the user saying exactly what they want.
 */
const MAX_AUTO_SEPP_FRACTION = 0.75;

/**
 * Fix A's reserve prices the IRA draws a committed purchase will force, and a
 * pre-59 1/2 draw does not deliver its face value: the draw itself is ordinary
 * income plus the 10% penalty, so producing $X net takes roughly
 * X / (1 - penalty - marginal rate) gross. This flat stand-in for the marginal
 * ordinary rate is deliberately crude and deliberately HIGH: the draws a
 * house purchase forces are six-to-seven figures in ONE tax year, which puts
 * most of the money in the top federal bracket plus state (measured on the
 * repro fixture, the all-in average on the purchase year's draw is ~48%
 * including the penalty). It is load-bearing at that size — priced at 25% the
 * 2028 purchase still came up ~$450k short (the purchase year's own tax bill
 * landed on an already-exhausted remainder) and Fix B paid recapture for a
 * failure Fix A existed to prevent. Erring HIGH here is safe: a smaller
 * payment costs some ordinary 10% on bridge top-ups, and an over-reserve that
 * zeroes the payment only DECLINES an election that is re-offered every
 * remaining bridge year. Erring low costs a bust.
 */
const SEPP_RESERVE_MARGINAL_RATE = 0.4;

/** Simulated year 1 = tax year 2026 (defined in household.ts; documented above). */
export { SIM_START_YEAR } from './household';

const CONVERGE_TOLERANCE = 1; // dollars
const MAX_ITERATIONS = 60;

/** Shared empty set: the overwhelming majority of years lock nothing. */
const NO_LOCKED_ACCOUNTS: ReadonlySet<string> = new Set();

/** Shared empty list for runs where no automatic 72(t) can ever elect. */
const NO_AUTO_SEPP: readonly PreparedSepp[] = [];

/**
 * Default giving-in-retirement rule when ProfileExpenses.retirementGiving is
 * absent: the paycheck stream keeps running for life, which is exactly what
 * the engine did before the rule existed. Shared (and frozen) so prepareSim
 * allocates nothing in the common case.
 */
const DEFAULT_RETIREMENT_GIVING: OngoingGivingRule = Object.freeze({ type: 'continue' });

/** Vanguard-style target-date glide waypoints (documented approximation). */
const TDF_MIX_AT_TARGET: AssetMix = { stocks: 0.5, bonds: 0.5, bills: 0 };
const TDF_MIX_AT_LANDING: AssetMix = { stocks: 0.3, bonds: 0.7, bills: 0 };
/** Years after the target year the glide keeps de-risking before holding. */
const TDF_LANDING_LAG = 7;

/** A live 72(t) series: everything fixed at the election, plus its running state. */
interface SeppRunState {
  spec: PreparedSepp;
  /**
   * The account the series actually draws from and locks: the carved-out SEPP
   * IRA when the election split the account, otherwise the account itself.
   */
  lockedAccountId: string;
  /** Whole balance the election was sized against (after any same-year rollover). */
  balanceAtElection: number;
  /** SEPP IRA balance at the election — B in the amortization that fixed the payment. */
  seppPrincipal: number;
  /** Share of the account carved into the SEPP IRA (1 = no split). */
  fraction: number;
  /** Formula maximum on the WHOLE balance at the election. */
  maxPayment: number;
  /** The actual fixed nominal annual payment: min(requested, maxPayment). */
  payment: number;
  /** True once the SEPP IRA could not fund a full payment (the series dies). */
  depleted: boolean;
  /**
   * True once the OWNER died. A 72(t) series is the account owner's
   * obligation, and death ends it — the modification rules do not follow the
   * money to a beneficiary. So the series stops paying and, just as
   * importantly, stops LOCKING: a deceased person's SEPP IRA must not go on
   * forcing distributions out of an account the survivor now owns outright,
   * nor keep the survivor out of their own money for the rest of the original
   * five-year window.
   */
  terminated: boolean;
  /**
   * True once the household BUSTED the series: a year's need could not be met
   * from every source the ordering may touch (the tithe last-resort seat
   * included) while this locked account still held money, so the lock lifts —
   * permanently; a modified series does not resume (Rev. Rul. 2002-62
   * §2.02(e)) — the draw proceeds, and the year is charged the IRC 72(t)(4)
   * recapture: 10% on every pre-59 1/2 payment the series ever made, plus
   * interest. Before this existed the engine kept the wall absolute and an
   * automatic election could score a plan 0.0% while it held $1.4M+ (the
   * incident DECISIONS.md records); the bust turns the wall into a price.
   */
  busted: boolean;
  /**
   * Every distribution the series has forced, year-stamped — the recapture
   * base a bust reads. 10% of each pre-59 1/2 payment, with interest at the
   * path's own T-bill return per elapsed year, is what busting costs.
   */
  paid: Array<{ year: number; amount: number }>;
}

/** A 401(k) that merges into a traditional IRA when its owner retires. */
export interface PreparedRollover {
  fromId: string;
  /** Destination IRA; `synthetic` ones are created in-path on first use. */
  to: { id: string; name: string; owner: string; synthetic: boolean };
}

/**
 * Mix along an approximate Vanguard target-date glidepath: the profile's
 * CURRENT allocation at sim start, 50/50 at the fund's target year, 30/70
 * seven years later, then held (Vanguard's Target Retirement series keeps
 * de-risking for ~7 years past the target date before merging into the Income
 * fund). Interpolation is linear BY YEAR, matching the glidepath event.
 *
 * DOCUMENTED SIMPLIFICATIONS: the real fund holds international equity and
 * bond sleeves (proxied here by the US stock/bond historical classes) and a
 * short-TIPS sleeve near the landing point (folded into bonds); the waypoints
 * are approximations of the published glide, not the prospectus table.
 */
export function targetDateMix(
  startMix: AssetMix,
  startYear: number,
  targetYear: number,
  year: number,
): AssetMix {
  const lerp = (from: AssetMix, to: AssetMix, frac: number): AssetMix => ({
    stocks: from.stocks + (to.stocks - from.stocks) * frac,
    bonds: from.bonds + (to.bonds - from.bonds) * frac,
    bills: from.bills + (to.bills - from.bills) * frac,
  });
  if (year >= targetYear + TDF_LANDING_LAG) return { ...TDF_MIX_AT_LANDING };
  if (year >= targetYear) {
    return lerp(TDF_MIX_AT_TARGET, TDF_MIX_AT_LANDING, (year - targetYear) / TDF_LANDING_LAG);
  }
  if (year <= startYear) return { ...startMix };
  return lerp(startMix, TDF_MIX_AT_TARGET, (year - startYear) / (targetYear - startYear));
}

// ---------------------------------------------------------------------------
// PreparedSim
// ---------------------------------------------------------------------------

/**
 * A between-homes window (notes 23-24), resolved path-independently: the
 * span from a sale month (inclusive) to the first later purchase month
 * (exclusive). A run carries a LIST of these — one per sell→rent→buy cycle,
 * chronological and disjoint — and an EMPTY list wherever there is no such
 * pair inside the simulated years: no sale, no purchase, a same-month
 * sale-and-buy, or a rent-to-the-horizon plan. The empty list is the gate on
 * every renting-column and cash-banking branch downstream, which is what
 * makes "nothing about a plan without a window changes" checkable by
 * inspection.
 */
interface BetweenHomesWindow {
  sellYi: number;
  buyYi: number;
  sellYear: number;
  sellMonth: number;
  buyYear: number;
  buyMonth: number;
  /** Total months between homes (= the rent months of a compiled plan). */
  windowMonths: number;
}

export interface PreparedSim {
  startYear: number;
  horizonYear: number;
  horizonYears: number;
  profile: SimulationInput['profile'];
  market: SimulationInput['assumptions']['market'];
  settings: SimulationInput['profile']['settings'];
  taxData: TaxDataBundle;
  rmd: SimulationInput['assumptions']['rmd'];
  household: PreparedHousehold;
  residency: StateCode[];
  /** 'living'-category expense_change schedule (multiplier + real delta). */
  livingMultiplier: number[];
  livingDeltaReal: number[];
  /** 'charitable'-category expense_change schedule. */
  charitableMultiplier: number[];
  charitableDeltaReal: number[];
  /**
   * THE ONGOING giving method for the years nobody earns (note 18). Resolved
   * here — absent-means-'continue' applied, and any legacy bundled
   * 'tithe_account' already split into this plus `untithedPot` below
   * (resolveGivingPair) — so the yearly loop never sees the bundle at all.
   */
  retirementGiving: OngoingGivingRule;
  /**
   * THE UN-TITHED POT (note 21), with every absent-means default written in,
   * or null when the run has none. Composes with ANY ongoing method above;
   * the pair replaces the old bundled rule and reproduces it exactly when the
   * pot came from a migrated bundle (pinned by the equivalence digests).
   */
  untithedPot: ResolvedUntithedPot | null;
  /**
   * Retired-side living spending, $/month in start-year dollars, or undefined
   * when the profile does not name one. UNDEFINED IS NOT ZERO — it means "the
   * same as while working", and the yearly loop skips the working/retired
   * blend entirely in that case, so an untouched profile is bit-for-bit what
   * it was before the pair existed.
   */
  livingMonthlyRetired: number | undefined;
  /**
   * The living stream while between homes (note 23), $/month in start-year
   * dollars, or undefined when no living line names `monthlyRenting` — or when
   * the scenario overrides living wholesale (see the module header). UNDEFINED
   * MEANS THE BLEND IS SKIPPED OUTRIGHT, so a budget without the column walks
   * the exact float path it always did.
   */
  livingRenting: { working: number; retired: number } | undefined;
  /**
   * The sell→buy windows, chronological and disjoint; empty when there are
   * none (the gate on notes 23-24). One hand-written or compiled cycle makes
   * exactly one; the widow's downsize after the couple's own move makes two.
   */
  betweenHomes: BetweenHomesWindow[];
  /** Months of each year inside any window (0 everywhere when there is none). */
  betweenHomesMonthsByYear: number[];
  /**
   * The WORKED share of those months. Worked months are a prefix of the year
   * (retire/death both truncate at a month) and each window is a contiguous
   * span, so the per-window prefix overlaps sum to an exact blend.
   */
  betweenHomesWorkedMonthsByYear: number[];
  /**
   * The investing stream's in-window share (note 24a), start-year dollars —
   * the same monthly × months construction as household.investingRealByYear,
   * so the redirected slice can never exceed the stream it is a slice of.
   */
  investingWindowRealByYear: number[];
  /** Retirement income, $/month in start-year dollars (0 when the profile has none). */
  retirementIncomeMonthly: number;
  /** Untargeted allocation mix per year (all non-savings accounts), or null. */
  mixByYear: Array<AssetMix | null>;
  /** Account-targeted allocation mixes per year. */
  targetedMixByYear: TargetedMix[][];
  /** Automatic target-date-fund glide per year (only while it is not overridden). */
  tdfMixByYear: TargetedMix[][];
  /** 401(k) -> IRA rollovers firing in each year (retirement years only). */
  rolloversByYear: PreparedRollover[][];
  policyByYear: WithdrawalPolicy[];
  oneTimeExpense: number[];
  oneTimeIncome: Array<{ total: number; taxable: number }>;
  rothConv: Array<{ amount?: number; toBracketTop?: number } | null>;
  /** 72(t) elections starting in each year (the payment needs the in-path balance). */
  seppStartsByYear: PreparedSepp[][];
  /**
   * 72(t) elections whose lock covers each year (forced payment, no other
   * draws). Specs rather than account ids: which account a series locks — the
   * whole account, or only the SEPP IRA split out of it — depends on the
   * in-path balance, so simulate.ts resolves the id per path.
   */
  seppActiveByYear: PreparedSepp[][];
  /**
   * Automatic 72(t) elections (scenario.autoSepp) firing in each year — always
   * a retirement year. Only the fixed inputs are prepared here: the account,
   * the payment and the split all depend on the in-path post-rollover balance
   * and on the year's projected cash need, so simulate.ts resolves them
   * in-sim and builds the PreparedSepp there.
   */
  autoSeppStartsByYear: AutoSeppPlan[][];
  /** True when any automatic election can fire (skips per-path bookkeeping otherwise). */
  hasAutoSepp: boolean;
  rents: Array<{ startYear: number; monthlyCost: number; monthsByYear: number[] }>;
  sellMonthByYear: Array<number | null>;
  buyByYear: Array<ParsedBuyHouse | null>;
  /**
   * Nominal home appreciation imposed by `scenario.housing.appreciationRate`,
   * or null to keep the engine's own `cpi + homeAppreciationRealSpread`.
   *
   * REPLACES that rate rather than stacking on it — the housing module already
   * grows the home to the sale date, so adding a second rate would compound
   * growth twice. Null everywhere there is no housing plan, which is the
   * unchanged historical path.
   */
  homeGrowthRateOverride: number | null;
  eventsFiredByYear: string[][];
  accountsTemplate: AccountState[];
  housingTemplate: HousingState;
  scenarioName: string;
  birthYears: number[];
  /**
   * Birth years of each year's TAX household, aligned with
   * household.taxPeopleByYear. Identical to `birthYears` in every year of a
   * run with no death; after one it drops the decedent from the first full
   * year onward, in step with the filing-status switch.
   */
  taxBirthYearsByYear: number[][];
}

/**
 * The profile's policy list with a scenario's per-policy dispositions applied
 * (AssumptionOverrides.expenses.lifeInsurancePolicyPlans). Returns the list
 * UNCHANGED — same reference — when there is no map, so a scenario without one
 * cannot move a float anywhere.
 *
 * APPLIED HERE, IN profileWithOverrides, AND NOWHERE ELSE — not inside
 * resolvePolicies — because this is the one funnel every simulation passes
 * through: prepareSim hands the SAME rebuilt profile object to prepareHousehold
 * (whose resolvePolicies reads the list) and to ctx.profile (which simulatePath
 * reads directly), so a transform here provably reaches every consumer of the
 * policies, while resolvePolicies never sees the scenario at all and teaching
 * it to would still leave any direct profile.expenses reader on the untouched
 * list.
 *
 * 'cancel_now' ZEROES the policy's premium and benefit rather than dropping it
 * from the list. A policy that costs nothing and pays nothing is gone from the
 * simulation everywhere the engine looks (premiums multiply premiumMonthly,
 * benefits sum deathBenefit) — but FILTERING could leave the list EMPTY, and an
 * empty list hands control back to the legacy single-policy fields
 * (resolvePolicies' documented fallback, pinned in tests/engine/lifePolicies),
 * resurrecting a superseded policy in exactly the scenario that said "no cover
 * at all".
 *
 * An id naming no policy in the list matches nothing and does nothing, by
 * contract: profiles evolve, and a saved scenario must not change meaning —
 * or crash — because a policy was renamed. The server warns about it
 * (policy_plan_unknown_policy); the engine stays silent and exact.
 */
function policiesWithPlans(
  policies: LifeInsurancePolicy[] | undefined,
  plans: Record<string, LifeInsurancePolicyPlan> | undefined,
): LifeInsurancePolicy[] | undefined {
  if (policies === undefined || plans === undefined) return policies;
  return policies.map((p): LifeInsurancePolicy => {
    const plan = plans[p.id];
    if (plan === undefined) return p;
    if (plan === 'cancel_now') return { ...p, premiumMonthly: 0, deathBenefit: 0 };
    return { ...p, cancelAtRetirement: plan === 'cancel_at_retirement' };
  });
}

/**
 * Effective expense AND income streams for a run: the ITEMISED BUDGET's totals
 * where the profile has one, with any field the scenario's
 * `assumption_overrides.expenses` / `assumption_overrides.income` supplies
 * replacing them. Returns the profile object itself when there is neither, so
 * the common case allocates nothing.
 *
 * Both sides of every pair are overridable — a what-if can drag retired living
 * without touching the working figure, or hand the household 2,000/month of
 * consulting income it does not have in the profile.
 *
 * THE BUDGET IS DERIVED HERE AND NOWHERE ELSE. Every simulation passes through
 * prepareSim, so deriving once at this funnel is what makes it impossible for
 * the lines on screen and the scalars the engine reads to disagree — a line
 * edited to $6,900 and a `livingMonthly` still saying $7,100 would otherwise
 * show one number and simulate the other, with nothing anywhere admitting it.
 * The override still outranks the derivation: the solvers sweep spending by
 * writing `livingMonthly`, and a budget that beat them would flatten the whole
 * max-spend curve.
 */
function profileWithOverrides(
  profile: SimulationInput['profile'],
  overrides: SimulationInput['scenario']['assumption_overrides'],
): SimulationInput['profile'] {
  const e = overrides?.expenses;
  const i = overrides?.income;
  const hasExpense =
    e !== undefined &&
    (e.livingMonthly !== undefined ||
      e.livingMonthlyRetired !== undefined ||
      e.charitableMonthly !== undefined ||
      e.investingMonthly !== undefined ||
      e.investingMonthlyRetired !== undefined ||
      e.lifeInsuranceMonthly !== undefined ||
      e.lifeInsuranceDeathBenefit !== undefined ||
      e.lifeInsuranceTermEnd !== undefined ||
      e.lifeInsuranceTermStart !== undefined ||
      e.lifeInsuranceInsured !== undefined ||
      e.lifeInsurancePolicyPlans !== undefined ||
      e.retirementGiving !== undefined ||
      e.untithedPot !== undefined);
  const hasIncome = i !== undefined && i.retirementMonthly !== undefined;
  // An itemised budget is itself a reason to rebuild: its totals, not the
  // stored scalars, are what this run must spend. No lines and no override and
  // nothing has changed — the pre-budget profile takes the same object it
  // always did, so its numbers are bit-for-bit what they were.
  const hasLines = (profile.expenses.lines?.length ?? 0) > 0;
  if (!hasExpense && !hasIncome && !hasLines) return profile;
  const derived = deriveExpenseStreams(profile.expenses);
  /*
   * Field-by-field (not a spread): an explicit `undefined` in the override
   * object must keep the profile value, not erase it.
   *
   * THE COST OF THAT CHOICE, and a trap this code has already sprung once: a
   * literal rebuild silently DROPS any profile field the list forgets. When
   * the term-life benefit and term end were added, a plan carrying any
   * expenses override at all — a plan may carry one for giving —
   * quietly lost its life-insurance policy, and the survivor score came back
   * identical with and without a million dollars of cover. It failed silently
   * because dropping a field looks exactly like not having one.
   *
   * So: EVERY field of ProfileExpenses must appear below. If you add one to
   * the interface and not to this object, the engine will ignore it for any
   * scenario that overrides anything.
   */
  const next = { ...profile };
  if (hasExpense || hasLines) {
    next.expenses = {
      livingMonthly: e?.livingMonthly ?? derived.livingMonthly,
      livingMonthlyRetired: e?.livingMonthlyRetired ?? derived.livingMonthlyRetired,
      charitableMonthly: e?.charitableMonthly ?? derived.charitableMonthly,
      investingMonthly: e?.investingMonthly ?? derived.investingMonthly,
      investingMonthlyRetired:
        e?.investingMonthlyRetired ?? derived.investingMonthlyRetired,
      lifeInsuranceMonthly:
        e?.lifeInsuranceMonthly ?? profile.expenses.lifeInsuranceMonthly,
      lifeInsuranceDeathBenefit:
        e?.lifeInsuranceDeathBenefit ?? profile.expenses.lifeInsuranceDeathBenefit,
      lifeInsuranceTermEnd:
        e?.lifeInsuranceTermEnd ?? profile.expenses.lifeInsuranceTermEnd,
      lifeInsuranceTermStart:
        e?.lifeInsuranceTermStart ?? profile.expenses.lifeInsuranceTermStart,
      lifeInsuranceInsured:
        e?.lifeInsuranceInsured ?? profile.expenses.lifeInsuranceInsured,
      retirementGiving: e?.retirementGiving ?? profile.expenses.retirementGiving,
      // Naive half-by-half merge only. The AUTHORITATIVE pair — including the
      // rule that an override BUNDLE's pot half supersedes the profile's pot —
      // is resolveGivingPair in prepareSim, which reads the original profile
      // and the raw override; nothing downstream reads these two fields off
      // ctx.profile. They are carried so the every-field rule above holds.
      untithedPot: e?.untithedPot ?? profile.expenses.untithedPot,
      // The two list fields are carried, never derived away: the survivor's
      // per-line figures and the policies are read downstream from
      // ctx.profile, and dropping them here is the same silent failure the
      // comment above describes — a plan with any expenses override would lose
      // its budget's survivor detail and its cover in one go. The policy list
      // is the one place a scenario CAN reach a listed policy — the per-policy
      // dispositions apply here (see policiesWithPlans), and with no map the
      // list passes through by reference, untouched.
      lines: profile.expenses.lines,
      lifeInsurancePolicies: policiesWithPlans(
        profile.expenses.lifeInsurancePolicies,
        e?.lifeInsurancePolicyPlans,
      ),
    };
  }
  if (hasIncome && i !== undefined) {
    // (retirementIncomeTaxable is parsed but ignored since 2026-08-31 —
    // post-retirement income is always ordinary income — so the spread's
    // untouched copy of it is enough.)
    next.income = {
      ...profile.income,
      retirementMonthly: i.retirementMonthly ?? profile.income.retirementMonthly,
    };
  }
  return next;
}

/** Precompute everything path-independent. Pure; never mutates the input. */
export function prepareSim(input: SimulationInput): PreparedSim {
  // The scenario's expense/income overrides replace profile streams for this
  // run only (a what-if can drag spending, or add retirement income, without
  // rewriting profile.json). Applied here, alongside the market/aca/settings
  // merge, so EVERY consumer sees the overridden values: prepareHousehold's
  // investing and retirement-income streams below, and
  // ctx.profile.expenses.{livingMonthly,livingMonthlyRetired,charitableMonthly}
  // inside simulatePath. input.profile is never mutated — the hashes in
  // runSimulation still cover the user's real profile, and the override
  // rides in the scenario hash.
  const profile = profileWithOverrides(input.profile, input.scenario.assumption_overrides);
  const { market, aca, settings } = applyAssumptionOverrides(
    input.assumptions,
    profile.settings,
    input.scenario.assumption_overrides,
  );
  const startYear = SIM_START_YEAR;
  // Horizon = year BOTH people reach horizonAge (a 1975 birth -> 2070 for 95).
  const horizonYear = Math.max(...profile.people.map((p) => p.birthYear + settings.horizonAge));
  const horizonYears = horizonYear - startYear + 1;
  if (horizonYears <= 0) {
    throw new Error(`prepareSim: horizon year ${horizonYear} is before the start year ${startYear}`);
  }

  /*
   * The move, compiled. `scenario.housing` is configuration, not a second
   * engine: eventsWithHousingPlan turns it into the sell_house / rent /
   * buy_house events this pipeline has always consumed, DISCARDING any
   * hand-written ones of those types in the same scenario (the plan is the
   * single source of truth for a move, or there is no plan). With no housing
   * plan it returns the scenario's own array untouched, so every existing
   * scenario — including a saved plan.json that still writes the three events
   * by hand — parses exactly as it did before.
   */
  const parsed = parseEvents(
    eventsWithHousingPlan(input.scenario.events, input.scenario.housing, {
      startYear,
      horizonYears,
    }),
  );
  const household = prepareHousehold(
    profile,
    parsed,
    input.assumptions.socialSecurity,
    input.assumptions.medicare,
    aca,
    startYear,
    horizonYears,
  );
  const taxData: TaxDataBundle = {
    federal: input.assumptions.federal,
    states: input.assumptions.states,
    medicare: input.assumptions.medicare,
    aca,
  };
  const living = expenseScheduleByYear(
    parsed.expenseChanges.filter((c) => c.category === 'living'),
    startYear,
    horizonYears,
  );
  const charitable = expenseScheduleByYear(
    parsed.expenseChanges.filter((c) => c.category === 'charitable'),
    startYear,
    horizonYears,
  );

  // --- Allocation events + automatic target-date-fund glide (note 8) --------
  const alloc = allocationSchedules(
    parsed.allocationChanges,
    parsed.glidepaths,
    startYear,
    horizonYears,
  );
  const tdfMixByYear: TargetedMix[][] = Array.from({ length: horizonYears }, () => []);
  for (const a of profile.accounts) {
    if (!a.targetDateFund) continue;
    // An explicit allocation instruction — targeted at this account, or an
    // untargeted one that sweeps every non-savings account — turns the
    // automatic glide off from the year it takes effect.
    const overrideFrom = Math.min(
      alloc.globalFromYear ?? Infinity,
      alloc.targetedFromYear.get(a.id) ?? Infinity,
    );
    for (let yi = 0; yi < horizonYears; yi++) {
      const year = startYear + yi;
      if (year >= overrideFrom) break;
      tdfMixByYear[yi].push({
        accountId: a.id,
        mix: targetDateMix(a.allocation, startYear, a.targetDateFund.targetYear, year),
      });
    }
  }

  // --- 401(k) -> IRA rollover at separation (note 7) ------------------------
  // Path-independent: which 401(k) merges into which IRA, in which year. The
  // destination is the owner's first traditional IRA; when they own none a
  // synthetic one is created in-path (a second 401(k) rolling the same year
  // then merges into that same synthetic IRA).
  const rolloversByYear: PreparedRollover[][] = Array.from({ length: horizonYears }, () => []);
  const rolloverDestinations: SeppAccountRef[] = [];
  for (const person of profile.people) {
    const retire = parsed.retirements.get(person.id);
    if (!retire) continue;
    const yi = retire.year - startYear;
    if (yi < 0 || yi >= horizonYears) continue;
    let destination = profile.accounts.find(
      (a) => a.type === 'traditional_ira' && a.owner === person.id,
    );
    for (const k of profile.accounts.filter((a) => a.type === '401k' && a.owner === person.id)) {
      if (destination) {
        rolloversByYear[yi].push({
          fromId: k.id,
          to: { id: destination.id, name: destination.name, owner: person.id, synthetic: false },
        });
      } else {
        const synthetic = {
          id: `${k.id}-rollover-ira`,
          name: `${k.name} (rolled over)`,
          owner: person.id,
          synthetic: true,
        };
        rolloversByYear[yi].push({ fromId: k.id, to: synthetic });
        rolloverDestinations.push({ id: synthetic.id, name: synthetic.name, owner: person.id });
        // Subsequent 401(k)s of the same owner land in the IRA just created.
        destination = {
          ...k,
          id: synthetic.id,
          name: synthetic.name,
          type: 'traditional_ira',
        };
      }
    }
  }

  // --- 72(t)/SEPP elections (note 16) ---------------------------------------
  const seppPrepared = prepareSepp(
    parsed.start72t,
    [
      ...profile.accounts.map((a) => ({ id: a.id, name: a.name, owner: a.owner })),
      ...rolloverDestinations,
    ],
    profile.people,
    input.assumptions.rmd,
  );
  const seppStartsByYear: PreparedSepp[][] = Array.from({ length: horizonYears }, () => []);
  const seppActiveByYear: PreparedSepp[][] = Array.from({ length: horizonYears }, () => []);
  for (const s of seppPrepared) {
    const yi = s.eventYear - startYear;
    // An election outside the simulated window is ignored entirely — including
    // its lock. (A series already running before 2026 would need its original
    // payment amount, which the scenario cannot express; locking the account
    // with no payment attached would just strand the money.)
    if (yi < 0 || yi >= horizonYears) continue;
    seppStartsByYear[yi].push(s);
    for (let y = s.eventYear; y <= s.lockThroughYear; y++) {
      const i = y - startYear;
      if (i >= 0 && i < horizonYears) seppActiveByYear[i].push(s);
    }
  }

  // Automatic elections (scenario.autoSepp; ABSENT MEANS ON). One per person
  // who retires before their own penalty-free year and did not write a
  // start_72t of their own — see prepareAutoSepp.
  const autoSeppPlans = prepareAutoSepp(
    profile.people,
    parsed.retirements,
    seppPrepared,
    input.assumptions.rmd,
    input.scenario.autoSepp !== false,
  );
  /*
   * The plan is OFFERED in every year of its bridge, not just the retirement
   * year, and the yearly loop elects in the first one that actually needs
   * pre-tax money.
   *
   * Electing on the retirement day regardless was wrong for any household that
   * retires holding cash — most sharply, one that sells a house that year. A
   * 72(t) is irrevocable, so an election made a year early does not sit idle:
   * it forces its payment out of the IRA annually from then on. Measured on the
   * repro plan, electing in the retirement year rather than the year the cash
   * ran out took $120,000 out of an IRA that was not needed and doubled that
   * year's AGI, from about $120,000 to about $240,000.
   *
   * Deferring is not free either — the five-year minimum runs from the start,
   * so a later election stays locked later — which is why it is decided by
   * need each year rather than pushed as late as possible.
   */
  const autoSeppStartsByYear: AutoSeppPlan[][] = Array.from({ length: horizonYears }, () => []);
  let hasAutoSepp = false;
  for (const plan of autoSeppPlans) {
    for (let y = plan.retireYear; y < plan.penaltyFreeYear; y++) {
      const yi = y - startYear;
      // Years outside the simulated window elect nothing, exactly like an
      // out-of-window start_72t event.
      if (yi < 0 || yi >= horizonYears) continue;
      autoSeppStartsByYear[yi].push(plan);
      hasAutoSepp = true;
    }
  }

  const sellMonthByYear: Array<number | null> = new Array(horizonYears).fill(null);
  for (const sell of parsed.sellHouses) {
    const yi = sell.year - startYear;
    if (yi < 0 || yi >= horizonYears) continue;
    // The housing module runs ONE sale per calendar year — the home held at
    // year start. Two sells in the same year: the first is the only one with
    // a home to act on (the list is chronological), so the first wins.
    if (sellMonthByYear[yi] === null) sellMonthByYear[yi] = sell.month;
  }
  const buyByYear: Array<ParsedBuyHouse | null> = new Array(horizonYears).fill(null);
  for (const b of parsed.buys) {
    const yi = b.ym.year - startYear;
    if (yi >= 0 && yi < horizonYears) buyByYear[yi] = b;
  }

  // --- The between-homes windows (notes 23-24) ------------------------------
  // Sale month (inclusive) to purchase month (exclusive): the months the
  // household is out of a home with another one coming — exactly the months a
  // compiled plan charges rent for. STRICTLY LATER buy: a same-month
  // sale-and-buy has no months between homes and must leave every window
  // branch cold, and a rent-to-the-horizon plan compiles no buy at all. Both
  // ends must land inside the simulated years for the same reason prepareSim
  // drops out-of-range events: a sale that never fires banked nothing, and a
  // purchase past the horizon is not "soon" by any reading of the word.
  //
  // A LIST of windows, one per sell→buy cycle, chronological and DISJOINT by
  // construction: each sale claims the first unclaimed later purchase, and a
  // sale landing before the previous window closed is skipped (a household
  // between homes has nothing to sell). One cycle produces exactly the single
  // window this machinery was built around; N cycles — the couple's own move,
  // then the widow's downsize — each get their own months, banking and rent.
  const betweenHomes: BetweenHomesWindow[] = [];
  const betweenHomesMonthsByYear: number[] = new Array(horizonYears).fill(0);
  const betweenHomesWorkedMonthsByYear: number[] = new Array(horizonYears).fill(0);
  const investingWindowRealByYear: number[] = new Array(horizonYears).fill(0);
  {
    let buyFrom = 0; // parsed.buys index: buys before this are claimed
    let lastBuyAbs = -Infinity; // previous window's close (purchase month)
    let lastWindowSpannedYears = false; // previous window's sale year < buy year
    const sellYearsSeen = new Set<number>();
    for (const sell of parsed.sellHouses) {
      // A window may only open on a sale the engine will actually RUN, or
      // the banking gates open for months with no sale behind them. Three
      // shapes cannot run, all consequences of the one-sale-one-buy-per-year
      // granularity (runHousingYear executes the year's sale BEFORE its buy):
      const sellAbs = sell.year * 12 + (sell.month - 1);
      // 1. The year's one-sale slot is already taken (sellMonthByYear keeps
      //    the first sale in a year — the only one with a home to act on).
      if (sellYearsSeen.has(sell.year)) continue;
      sellYearsSeen.add(sell.year);
      // 2. Between homes already — nothing to sell.
      if (sellAbs < lastBuyAbs) continue;
      // 3. The previous window spanned years and closes IN this sale's year:
      //    the home arrives at that later buy month, so this year's sale
      //    step (which runs first) finds nothing to sell.
      if (lastWindowSpannedYears && sell.year * 12 <= lastBuyAbs) continue;
      let buy: ParsedBuyHouse | undefined;
      while (buyFrom < parsed.buys.length) {
        const cand = parsed.buys[buyFrom];
        buyFrom++;
        if (cand.ym.year * 12 + (cand.ym.month - 1) > sellAbs) {
          buy = cand;
          break;
        }
      }
      const sellYi = sell.year - startYear;
      const buyYi = buy === undefined ? -1 : buy.ym.year - startYear;
      if (
        buy === undefined ||
        sellYi < 0 ||
        sellYi >= horizonYears ||
        buyYi < 0 ||
        buyYi >= horizonYears
      ) {
        continue;
      }
      const buyAbs = buy.ym.year * 12 + (buy.ym.month - 1);
      lastBuyAbs = buyAbs;
      lastWindowSpannedYears = buy.ym.year > sell.year;
      betweenHomes.push({
        sellYi,
        buyYi,
        sellYear: sell.year,
        sellMonth: sell.month,
        buyYear: buy.ym.year,
        buyMonth: buy.ym.month,
        windowMonths: buyAbs - sellAbs,
      });
      // Derived-or-overridden values, deliberately: household.investingRealByYear
      // is built from this same rebuilt profile, and the in-window slice must be
      // a slice of exactly that stream. Windows are disjoint, so += per window
      // never double-counts a month.
      for (let yi = 0; yi < horizonYears; yi++) {
        const y0 = (startYear + yi) * 12;
        const inWindow = Math.max(0, Math.min(buyAbs, y0 + 12) - Math.max(sellAbs, y0));
        if (inWindow === 0) continue;
        betweenHomesMonthsByYear[yi] += inWindow;
        // Worked months are months 1..w of the year (retire and death both
        // truncate at a month), so the worked-in-window count is the overlap
        // of that prefix with the window span.
        const w = household.employerMonthsByYear[yi];
        const workedIn = Math.max(0, Math.min(buyAbs, y0 + w) - Math.max(sellAbs, y0));
        betweenHomesWorkedMonthsByYear[yi] += workedIn;
        // Worked months only: investing stops at retirement (household.ts's
        // rule), so the in-window slice has no retired term either.
        investingWindowRealByYear[yi] += profile.expenses.investingMonthly * workedIn;
      }
    }
  }
  /*
   * The renting living totals (note 23). Undefined — the blend skipped — when
   * no living line names the column, and ALSO when the scenario overrides
   * living wholesale: the solvers sweep spending by writing livingMonthly, and
   * a per-line dwelling discount applied to a swept scalar would bank a
   * "reduction" off a baseline the lines no longer set.
   */
  const expenseOverride = input.scenario.assumption_overrides?.expenses;
  const livingOverridden =
    expenseOverride?.livingMonthly !== undefined ||
    expenseOverride?.livingMonthlyRetired !== undefined;
  const livingRenting = livingOverridden
    ? undefined
    : (rentingLivingMonthly(profile.expenses) ?? undefined);
  const eventsFiredByYear: string[][] = [];
  for (let yi = 0; yi < horizonYears; yi++) {
    const fired = [...(parsed.firedByYear.get(startYear + yi) ?? [])];
    if (rolloversByYear[yi].length > 0) fired.push('rollover-401k');
    eventsFiredByYear.push(fired);
  }

  // The giving pair, resolved from the ORIGINAL profile and the RAW override —
  // not the merged `profile` above — because only the unmerged square can
  // apply the bundle rule: a legacy 'tithe_account' override replaced the
  // whole rule under the old model, so its pot half must supersede the
  // profile's pot, and after a naive merge nobody can tell whose pot won.
  // This is also the engine-boundary safety net: whatever a caller hands in
  // (old saved scenario, search axis level, unmigrated profile), the loop
  // below only ever sees an OngoingGivingRule and a resolved pot.
  const givingPair = resolveGivingPair({
    profileRule: input.profile.expenses.retirementGiving,
    profilePot: input.profile.expenses.untithedPot,
    overrideRule: input.scenario.assumption_overrides?.expenses?.retirementGiving,
    overridePot: input.scenario.assumption_overrides?.expenses?.untithedPot,
  });

  return {
    startYear,
    horizonYear,
    horizonYears,
    profile,
    market,
    settings,
    taxData,
    rmd: input.assumptions.rmd,
    household,
    residency: residencyByYear(profile.filing.state, parsed.stateChanges, startYear, horizonYears),
    livingMultiplier: living.multiplier,
    livingDeltaReal: living.deltaReal,
    charitableMultiplier: charitable.multiplier,
    charitableDeltaReal: charitable.deltaReal,
    retirementGiving: givingPair.ongoing ?? DEFAULT_RETIREMENT_GIVING,
    untithedPot: givingPair.pot,
    livingMonthlyRetired: profile.expenses.livingMonthlyRetired,
    livingRenting,
    betweenHomes,
    betweenHomesMonthsByYear,
    betweenHomesWorkedMonthsByYear,
    investingWindowRealByYear,
    retirementIncomeMonthly: profile.income.retirementMonthly ?? 0,
    mixByYear: alloc.global,
    targetedMixByYear: alloc.targeted,
    tdfMixByYear,
    rolloversByYear,
    policyByYear: withdrawalPolicyByYear(settings.withdrawalPolicy, parsed.withdrawalStrategies, startYear, horizonYears),
    oneTimeExpense: oneTimeExpenseByYear(parsed.oneTimeExpenses, startYear, horizonYears),
    oneTimeIncome: oneTimeIncomeByYear(parsed.oneTimeIncomes, startYear, horizonYears),
    rothConv: rothConversionByYear(parsed.rothConversions, startYear, horizonYears),
    seppStartsByYear,
    seppActiveByYear,
    autoSeppStartsByYear,
    hasAutoSepp,
    rents: parsed.rents.map((r) => ({
      startYear: r.start.year,
      monthlyCost: r.monthlyCost,
      monthsByYear: rentMonthsByYear(r, startYear, horizonYears),
    })),
    sellMonthByYear,
    buyByYear,
    homeGrowthRateOverride: planHomeGrowthRate(input.scenario.housing),
    eventsFiredByYear,
    accountsTemplate: initAccountStates(profile),
    housingTemplate: initHousingState(profile.home),
    scenarioName: input.scenario.name,
    birthYears: profile.people.map((p) => p.birthYear),
    taxBirthYearsByYear: household.taxPeopleByYear.map((idxs) =>
      idxs.map((i) => profile.people[i].birthYear),
    ),
  };
}

// ---------------------------------------------------------------------------
// simulatePath
// ---------------------------------------------------------------------------

export interface PathOutcome {
  /** Full year rows (with tax traces) — only when opts.trace. */
  yearRows: YearRow[] | null;
  /**
   * End-of-year SPENDABLE balances in real (start-year) dollars, per year:
   * every account except a LOCKED Tithe Account carve-out (note 21 — through
   * its soft window the pot is last-resort money and counts). This is the
   * series the fan, the terminal value and the success rate are built from,
   * and it equals the whole-portfolio total to the cent in any run without a
   * carve-out.
   */
  balancesRealByYear: number[];
  insolvencyYear: number | null;
  terminalReal: number;
  /**
   * BREAK GLASS: the Tithe Account balance in real dollars at the end of the
   * year this path first went insolvent. Typically ~0 when the path failed
   * during the soft window (the ordering drained the pot last, before the
   * year could fall short); the full escrow when it failed after the lock.
   * Null when the path never failed, or when it has no carve-out.
   */
  breakGlassReal: number | null;
  /** Every cash gift the path made, deflated to start-year dollars. */
  charitableCashReal: number;
  /** Terminal Tithe Account balance, deflated — the bequest to charity. */
  titheTerminalReal: number;
  /**
   * The sell → rent → buy cash story (note 24), recorded in the buy year.
   * Null whenever the run has no between-homes window. Only the reference
   * path's copy is reported (RunResult.purchaseFunding) — a Monte Carlo
   * median of funding stories would describe no future anyone simulated.
   */
  purchaseFunding: PurchaseFundingTrace | null;
  /**
   * This path's guardrails cut/raise record (note 22). Null under every other
   * spending policy — the same single null check that keeps the whole rule
   * out of the hot path keeps its bookkeeping out too.
   */
  guardrail: GuardrailPathStats | null;
}

/**
 * Land cash in savings (house-sale proceeds; fallbacks documented in the
 * module header). Sale proceeds are deliberately parked in cash: SPEC §9.3
 * then moves whatever a purchase does not consume into the brokerage.
 */
function addToSavings(accounts: AccountState[], amount: number, ownerFallback: string): void {
  if (amount <= 0) return;
  const savings = accounts.find((a) => a.type === 'savings');
  if (savings) {
    savings.balance += amount;
    return;
  }
  const brokerage = accounts.find((a) => a.type === 'taxable_brokerage');
  if (brokerage) {
    brokerage.balance += amount;
    brokerage.costBasis += amount; // cash in = basis
    return;
  }
  accounts.push({
    id: 'surplus_cash',
    name: 'Surplus cash',
    type: 'savings',
    owner: ownerFallback,
    balance: amount,
    costBasis: 0,
    rothContributions: 0,
    rothConversions: [],
    allocation: { stocks: 0, bonds: 0, bills: 1 },
  });
}

/**
 * REINVEST a RETIRED year's surplus: it goes into the first taxable brokerage —
 * balance AND costBasis rise by the swept amount, because it is after-tax
 * money that just bought shares — and only falls back to savings when the
 * household holds no brokerage account at all (then to a synthetic savings
 * account when it holds neither).
 *
 * Money the household did not need is INVESTED, not parked at the T-bill
 * rate. That is what actually happens with a forced distribution that exceeds
 * the year's spending: a 72(t) payment or an RMD arrives, the tax is paid, and
 * the rest is bought back in a brokerage account. Parking it in cash would
 * quietly understate every plan that produces surpluses — which, once the
 * automatic 72(t) bridge is running, is most of them.
 *
 * ONLY RETIRED YEARS CALL THIS (note 20). Once nobody earns, the withdrawal
 * solve takes only what the year needs, so a surplus can ONLY be a forced
 * distribution the year did not need — real money that genuinely gets
 * reinvested. While a salary is still coming in the leftover is something else
 * entirely (unbudgeted spending the baseline does not carry), and the caller
 * consumes it instead of sweeping it here.
 */
function sweepSurplus(accounts: AccountState[], amount: number, ownerFallback: string): void {
  if (amount <= 0) return;
  const brokerage = accounts.find((a) => a.type === 'taxable_brokerage');
  if (brokerage) {
    brokerage.balance += amount;
    brokerage.costBasis += amount; // cash in = basis
    return;
  }
  addToSavings(accounts, amount, ownerFallback);
}

/**
 * Materialise a 72(t) election in-path: size the payment off the CURRENT
 * balance (post-rollover, net of anything already committed this year), carve
 * out the SEPP IRA when the payment is below the whole-account formula maximum
 * (note 16 / seppSplit), and register the live series. Shared by the explicit
 * start_72t path and the automatic one — an automatic election differs only in
 * how its `requestedAnnual` was chosen.
 */
function electSepp(
  spec: PreparedSepp,
  accounts: AccountState[],
  drawn: Map<string, number>,
  seppState: Map<string, SeppRunState>,
): void {
  const src = accounts.find((x) => x.id === spec.accountId);
  const balance = src ? Math.max(0, src.balance - (drawn.get(spec.accountId) ?? 0)) : 0;
  const split = seppSplit(balance, spec.rate, spec.lifeExpectancy, spec.requestedAnnual);
  let lockedAccountId = spec.accountId;
  if (src && split.fraction < 1 && split.principal > 0) {
    lockedAccountId = spec.seppAccountId;
    // Lifetime contributions follow the money PRO RATA (note 21). Leaving the
    // whole figure on the remainder would strand the carve-out with a balance
    // and no contribution history, which the tithe seed reads as "unknown" —
    // understating the untithed base and flagging a data problem the user
    // does not have. Pro rata is the only neutral split: the two halves are
    // the same dollars, and nothing distinguishes contributed from earned
    // money within an account balance.
    const parentContrib = src.lifetimeContributions;
    const carvedContrib =
      parentContrib === undefined || src.balance <= 0
        ? undefined
        : parentContrib * (split.principal / src.balance);
    accounts.push({
      id: spec.seppAccountId,
      name: spec.seppAccountName,
      type: src.type,
      owner: src.owner,
      balance: split.principal,
      costBasis: 0,
      rothContributions: 0,
      rothConversions: [],
      allocation: { ...src.allocation },
      seppParentId: src.id,
      lifetimeContributions: carvedContrib,
    });
    src.balance -= split.principal;
    if (parentContrib !== undefined && carvedContrib !== undefined) {
      src.lifetimeContributions = parentContrib - carvedContrib;
    }
  }
  seppState.set(spec.seppAccountId, {
    spec,
    lockedAccountId,
    balanceAtElection: balance,
    seppPrincipal: split.principal,
    fraction: split.fraction,
    maxPayment: split.maxPayment,
    payment: split.payment,
    depleted: false,
    terminated: false,
    busted: false,
    paid: [],
  });
}

/**
 * A series that is neither depleted, nor ended by its owner's death, nor
 * busted by the household still pays — and, just as importantly, still LOCKS
 * its account. Deliberately a plain boolean rather than a type predicate: a
 * predicate would narrow the negative branch to `undefined` and hide the case
 * every caller actually cares about, a series that exists but has stopped.
 */
function seppIsLive(state: SeppRunState | undefined): boolean {
  return state !== undefined && !state.depleted && !state.terminated && !state.busted;
}

/**
 * ONE PERSON DIES: everything that happens to the BALANCE SHEET.
 *
 * The cash-flow and tax consequences of a death are all path-independent and
 * were settled in prepareHousehold; this is the part that cannot be, because
 * it depends on what the accounts hold on the day.
 *
 * 1. SPOUSAL ROLLOVER, NOT AN INHERITED IRA. A surviving spouse — and only a
 *    spouse — may treat the deceased's IRA as THEIR OWN. That is the single
 *    most valuable thing in this function: an inherited IRA would be emptied
 *    under the 10-year rule, forcing a decade of large distributions through
 *    the survivor's compressed single brackets. Treated as their own, it runs
 *    on the SURVIVOR's required-distribution schedule and their 59 1/2 date.
 *    The deceased's 401(k) rolls into an IRA of theirs the same way, so it is
 *    re-typed rather than left as a plan account they do not have.
 * 2. BASIS STEP-UP on taxable holdings (IRC 1014(a)(1) and (b)(9)): property
 *    included in the decedent's gross estate takes a basis of its fair market
 *    value at death. Solely-owned holdings step up in full; a JOINT account
 *    between spouses is a "qualified joint interest" of which IRC 2040(b)
 *    includes exactly one-half in the estate, so it steps up by half. None of
 *    the three states modeled here is a community-property state, so the
 *    community-property full step-up of IRC 1014(b)(6) is not applied — a
 *    household in one would get more than this models.
 * 3. THE DECEASED'S 72(t) SERIES ENDS. Death ends the obligation; the series
 *    stops paying and stops locking. The carve-out is left as a separate
 *    ordinary IRA the survivor owns rather than merged back — the two halves are the same money either
 *    way, and merging would have to reconcile two lifetime-contribution
 *    histories for no gain.
 *
 * A Tithe Account carve-out simply changes owner: a promise to charity is not
 * affected by which spouse holds the IRA it lives inside.
 */
function applyDeathToAccounts(
  accounts: AccountState[],
  seppState: Map<string, SeppRunState>,
  deceasedId: string,
  survivorId: string,
): void {
  for (const st of seppState.values()) {
    if (st.spec.owner === deceasedId) st.terminated = true;
  }
  for (const a of accounts) {
    const solelyDeceased = a.owner === deceasedId;
    const jointlyHeld = a.owner === 'joint';
    if (!solelyDeceased && !jointlyHeld) continue;
    if (a.type === 'taxable_brokerage') {
      const stepUpShare = solelyDeceased ? 1 : 0.5;
      a.costBasis = a.costBasis + Math.max(0, a.balance - a.costBasis) * stepUpShare;
    }
    if (!solelyDeceased) continue; // a joint account already belongs to the survivor
    a.owner = survivorId;
    // A spousal rollover puts the deceased's plan money in an IRA of the survivor's.
    if (a.type === '401k') a.type = 'traditional_ira';
  }
}

/** Top of the highest ordinary bracket whose rate <= maxRate (base-year $); null = unbounded. */
function bracketTopFor(
  brackets: TaxDataBundle['federal']['bracketsMfj'],
  maxRate: number,
): number | null {
  let top: number | null = null;
  for (const b of brackets) {
    if (b.rate <= maxRate) top = b.upTo; // brackets are ascending; last match wins
  }
  return top;
}

// ---------------------------------------------------------------------------
// Giving in retirement (note 18)
// ---------------------------------------------------------------------------

/**
 * Per-path Tithe Account history the 'tithe_account' rule reads (note 21).
 * Mutable, and deliberately so: `firstRetiredYi` is not known until the yearly
 * loop reaches the first year nobody works, and `baseRealByYear` is written at
 * each year end.
 */
export interface TitheHistory {
  /**
   * Set when a pot is paired with a percent_of_growth ongoing method, to the
   * pot's `ongoingDuringHold`. Its PRESENCE switches the ongoing growth
   * stream onto the HIGH-WATER-MARK base below (which is what the bundled
   * rule's trailing stream always was — required for the migrated pair to be
   * bit-identical); its VALUE decides the gate: 'accrue_to_pot' gives no cash
   * through the hold and the lock year (the accrual consumed those bases),
   * 'give_cash' pays from retirement day (no accrual ever touches a base, so
   * there is nothing to double-count). Absent = no pot: percent_of_growth
   * keeps its plain prior-year base and every non-pot plan is bit-for-bit
   * what it was.
   */
  growthStream?: 'accrue_to_pot' | 'give_cash';
  /**
   * Sim-year index of the first FULLY retired year — the carve-out's birthday
   * and the origin the defer window is counted from. Null until it arrives (so
   * a rule that never reaches retirement gives nothing, like every other rule).
   */
  firstRetiredYi: number | null;
  /**
   * Sim-year index of the FIRST LOCKED year — distribution start, when the
   * soft window closes. Set alongside `firstRetiredYi` to
   * firstRetiredYi + deferYears, and PULLED EARLIER by the safe-zone release
   * (a new real spendable high after the first retired year locks the NEXT
   * year). Null until retirement arrives. It may point past the horizon: a
   * long deferral simply never locks in-sim. The year `yi` is locked when
   * `lockYi !== null && yi >= lockYi`; accrual runs strictly before it, the
   * pot distributes from it, and trailing-growth cash starts strictly after
   * it (the lock year's own base was the last one accrued).
   */
  lockYi: number | null;
  /**
   * Growth base per year in REAL (start-year) dollars — the amount by which
   * the spendable portfolio exceeded its previous real high. Note the unit
   * difference from `realGrowthByYear`, which is nominal: a high-water mark is
   * only meaningful against a constant yardstick, so this one is deflated and
   * the caller re-inflates it at the year it is spent.
   */
  baseRealByYear: readonly number[];
}

/**
 * Shared empty series. Used as the tithe history's own empty base and as the
 * unread `realGrowthByYear` / `incomeByYear` arguments when the tithe rule
 * asks for its base — a rule reads exactly one history and the others are
 * inert, so allocating a throwaway array per year per path would be waste.
 */
const NO_HISTORY: readonly number[] = Object.freeze([]);

/** Shared empty history for the overwhelming majority of runs (no tithe rule). */
const NO_TITHE_HISTORY: TitheHistory = Object.freeze({
  firstRetiredYi: null,
  lockYi: null,
  baseRealByYear: NO_HISTORY,
});

/**
 * The figure a percentage rule applies its percentage to, always from
 * COMPLETED years (see the module header for why this year's base cannot be
 * used). `realGrowthByYear` and `incomeByYear` are the running per-path
 * histories; only entries strictly before `yi` have been written.
 *
 * - percent_of_growth WITHOUT a pot: the mean of the last `smoothingYears`
 *   (default 1) real growth figures. Early years average however many
 *   completed years exist, so a household that retires in sim year 2 with
 *   3-year smoothing gets the one year it has rather than a base diluted by
 *   two zeroes.
 * - percent_of_growth WITH a pot (`tithe.growthStream` set): last year's
 *   high-water-mark base, in REAL dollars (note 21; `tithe` carries it). The
 *   unit differs from the plain base on purpose — see
 *   TitheHistory.baseRealByYear — so the caller must re-inflate it.
 *   `smoothingYears` is deliberately NOT consulted here: each HWM base is a
 *   distinct never-tithed increment, and averaging a window of them would
 *   feed the same increment into several years' gifts — exactly the
 *   double-tithe the mark exists to prevent. (The mark already does the
 *   smoothing job: a down year gives 0 and the recovery is never re-tithed.)
 * - percent_of_income: last year's Social Security + gross withdrawals.
 *   DOCUMENTED SIMPLIFICATION: the retirement income stream
 *   (ProfileIncome.retirementMonthly) is NOT part of this base. The base is
 *   the definition this rule shipped with — what the PORTFOLIO and Social
 *   Security handed the household — and retirement income enters it only
 *   indirectly, by reducing the withdrawals it funds.
 * - 'continue' / 'none' / 'amount': no base at all (0) — their figure does not
 *   depend on a prior year.
 *
 * Returns 0 in the first simulated year — there is no completed year to look
 * back at, so a percentage rule that governs from year one gives nothing that
 * year (an 'amount' rule is unaffected: it has no base).
 */
export function retirementGivingBase(
  rule: OngoingGivingRule,
  yi: number,
  realGrowthByYear: readonly number[],
  incomeByYear: readonly number[],
  tithe: TitheHistory = NO_TITHE_HISTORY,
): number {
  if (yi <= 0) return 0;
  if (rule.type === 'percent_of_income') return incomeByYear[yi - 1];
  if (rule.type !== 'percent_of_growth') return 0;
  if (tithe.growthStream !== undefined) return tithe.baseRealByYear[yi - 1] ?? 0;
  const want = Math.max(1, Math.floor(rule.smoothingYears ?? 1));
  const n = Math.min(want, yi);
  let sum = 0;
  for (let k = yi - n; k < yi; k++) sum += realGrowthByYear[k];
  return sum / n;
}

/**
 * The FULL-YEAR giving a rule prescribes for sim year `yi`:
 * - 'amount': monthly x 12 x CPI — a plain figure in today's dollars,
 *   inflation-adjusted like every other monthly stream here;
 * - the percentage rules: percent x base, floored at 0 (a down year gives
 *   nothing; it never claws money back), then capped at capMonthly x 12 x CPI
 *   when the rule carries a cap;
 * - 'none': 0 by definition;
 * - 'continue': handled by the caller — it has no figure of its own, it IS the
 *   paycheck stream;
 * - percent_of_growth WITH a pot (`tithe.growthStream` set): THE GROWTH-TITHE
 *   STREAM ON THE HIGH-WATER-MARK BASE — percent x last year's REAL base,
 *   re-inflated to this year's dollars so the gift keeps its purchasing power
 *   like every other figure here. Under 'accrue_to_pot' it is additionally 0
 *   through the soft window and the lock year itself (see the gate below);
 *   under 'give_cash' it pays from retirement day. Either way it gives
 *   nothing before retirement, and nothing in the first retired year, which
 *   has no completed year under the mark to look back at. The pot's
 *   distribution instalments and the carve-out's forced RMD are NOT here:
 *   they are not this stream's prescription (one is the escrow paying out on
 *   its own schedule, the other is money the IRS pushed out), and the caller
 *   adds both separately.
 */
export function retirementGivingAnnual(
  rule: OngoingGivingRule,
  yi: number,
  idx: number,
  realGrowthByYear: readonly number[],
  incomeByYear: readonly number[],
  tithe: TitheHistory = NO_TITHE_HISTORY,
): number {
  if (rule.type === 'none' || rule.type === 'continue') return 0;
  if (rule.type === 'amount') return rule.monthly * 12 * idx;
  if (rule.type === 'percent_of_growth' && tithe.growthStream !== undefined) {
    if (tithe.firstRetiredYi === null || tithe.lockYi === null) return 0;
    /*
     * <=, NOT <, and the difference is a year of double-tithing — but ONLY
     * under 'accrue_to_pot', because only an accrual creates the hazard.
     *
     * The two phases read the base series at different offsets, because only
     * one of them is circular. The accrual is an internal transfer that
     * changes no cash flow, so it consumes THIS year's base at year end, in
     * every soft year: base[R] .. base[lockYi - 1]. Cash giving is an expense
     * that changes withdrawals that change growth, so like every other
     * percentage rule it can only consume a COMPLETED year — base[yi - 1].
     *
     * So under 'accrue_to_pot' the lock year itself (yi === lockYi) must give
     * no growth cash: it would read base[lockYi - 1], the very base the last
     * accrual year just moved into the carve-out — the same growth given
     * twice, once as a transfer and once as a gift. The trailing stream
     * therefore starts one year after the lock, on the first base no accrual
     * ever touched. That is not a gap but the arithmetic of "tithe the gross,
     * once" — and the lock year is not silent anyway: it is the pot's first
     * distribution year.
     *
     * Under 'give_cash' NO accrual ever touches a base, so cash simply reads
     * base[yi - 1] every year from retirement on — each base consumed exactly
     * once, with nothing to gate. lockYi === R (holdYears 0, no early release
     * possible) is unaffected in both modes: no accrual ever fires, so cash
     * starts at R + 1 on base[R], exactly like the other percentage rules.
     */
    if (tithe.growthStream === 'accrue_to_pot' && yi <= tithe.lockYi) return 0;
    let amount = Math.max(
      0,
      rule.percent * retirementGivingBase(rule, yi, NO_HISTORY, NO_HISTORY, tithe) * idx,
    );
    /*
     * The cap composes with the mark (a ceiling is a ceiling whatever the
     * base); the bundled rule had no cap field, so a migrated pair carries
     * none and the equivalence digests are unaffected. Smoothing is the one
     * knob that does NOT compose — see retirementGivingBase for why.
     */
    if (rule.capMonthly !== undefined) amount = Math.min(amount, rule.capMonthly * 12 * idx);
    return amount;
  }
  const base = retirementGivingBase(rule, yi, realGrowthByYear, incomeByYear);
  let amount = Math.max(0, rule.percent * base);
  if (rule.type === 'percent_of_growth' && rule.capMonthly !== undefined) {
    amount = Math.min(amount, rule.capMonthly * 12 * idx);
  }
  return amount;
}

/**
 * Plain-language name for the year's giving, used in the audit trace. A pot
 * paired with a growth tithe keeps the exact sentence the bundled rule wrote
 * (pinned by tests): the pair MEANS the same thing, so the trace must not
 * suddenly describe it differently. The 'give_cash' hold gets its own
 * sentence — that combination could not exist before the split.
 */
function givingRuleLabel(rule: OngoingGivingRule, pot: ResolvedUntithedPot | null): string {
  if (pot !== null && rule.type === 'percent_of_growth') {
    const pct = (rule.percent * 100).toFixed(2);
    const distribute = pot.distributeYears;
    const potTail =
      pot.holdYears > 0
        ? `, held for up to the first ${pot.holdYears} retired ${pot.holdYears === 1 ? 'year' : 'years'} (a last resort meanwhile), then locked and given in cash — the pot over ${distribute} ${distribute === 1 ? 'year' : 'years'}, plus the growth stream`
        : `, locked at retirement and given in cash — the pot over ${distribute} ${distribute === 1 ? 'year' : 'years'}, plus the growth stream`;
    if (pot.ongoingDuringHold === 'accrue_to_pot') {
      return `${pct}% of new real portfolio highs into a tithe account${potTail}`;
    }
    return `${pct}% of new real portfolio highs in cash from retirement day, alongside a tithe pot${potTail}`;
  }
  switch (rule.type) {
    case 'continue':
      return 'the working-years giving stream, inflation-adjusted';
    case 'none':
      return 'no giving once the salary stops';
    case 'amount':
      return `${rule.monthly.toLocaleString('en-US')}/month in 2026 dollars, inflation-adjusted`;
    case 'percent_of_growth':
      return `${(rule.percent * 100).toFixed(2)}% of real portfolio growth`;
    case 'percent_of_income':
      return `${(rule.percent * 100).toFixed(2)}% of Social Security + gross withdrawals`;
  }
}

/** Id suffix of a Tithe Account carve-out (note 21), mirroring `<id>-sepp`. */
const TITHE_ID_SUFFIX = '-tithe';

/** Gross-up passes when sizing an automatic 72(t): taxes/health depend on the answer. */
const AUTO_SEPP_ESTIMATE_PASSES = 4;

/** Year-local figures the automatic-72(t) sizing reads out of the yearly loop. */
interface BridgeNeedArgs {
  year: number;
  /** The year's TAX household: ages, birth years and status, already resolved. */
  ages: number[];
  birthYears: number[];
  filingStatus: FilingStatus;
  /** Cumulative CPI at the start of the election year. */
  idx: number;
  /** Person electing (the distribution is theirs for tax purposes). */
  owner: string;
  /** living + charitable + housing, already computed for this year (nominal). */
  expensesFullYear: number;
  charitable: number;
  mortgageInterest: number;
  propertyTax: number;
  ssGross: number;
  taxableInterest: number;
  dividends: number;
  oneTimeIncome: number;
  oneTimeTaxable: number;
  /**
   * A FULLY RETIRED year's retirement income (monthly x 12 x CPI), not this
   * year's prorated figure: the estimator prices a retired year, and the
   * payment it fixes runs for the whole bridge. Always ordinary income (the
   * app's standing rule, 2026-08-31).
   */
  retirementIncomeFullYear: number;
  /** Full-year ACA benchmark quote for this year (nominal). */
  acaBenchmarkAnnual: number;
  /** ACA months a FULLY RETIRED household would enroll for (12 minus Medicare). */
  acaMonths: number;
  medicare: TaxYearInputs['medicare'];
  /** Accessible cash/taxable balances spread evenly over the bridge years. */
  bridgeDrawPerYear: number;
  /**
   * Pre-tax income the household is ALREADY forced to take this year: RMDs,
   * and every 72(t) series already running — a spouse's, or one elected
   * moments earlier in the same year. It funds the same need and is taxed
   * alongside the new payment, so counting it is what stops two spouses from
   * each electing the whole household need.
   */
  forcedPretax: RetirementDistribution[];
}

/**
 * TARGET ANNUAL NEED for an automatic 72(t) election: the household's
 * projected FULL-YEAR cash requirement in the election year,
 *
 *   need = living + charitable + housing + health + taxes
 *          - (Social Security + interest + dividends + one-time income
 *             + retirement income)
 *          - accessible cash/taxable balances / bridgeYears
 *
 * This is what the series is sized to — NOT the IRS formula maximum. Taking
 * the maximum would force out far more pre-tax income than the household
 * spends, at a higher marginal rate and against the ACA subsidy cliff, and
 * would freeze a much larger slice of the IRA than the bridge requires.
 *
 * Wages are excluded by construction: the bridge years are retired years, and
 * the election year's partial salary is not a resource the series can count
 * on. RETIREMENT income is the opposite case — it is precisely what a retired
 * year brings in, so its full-year figure is counted, and a household with
 * part-time work therefore locks up less of its IRA. The cash/taxable balances
 * are spread over the WHOLE bridge rather than assumed spent in year one, so
 * the payment covers the recurring gap those balances cannot.
 *
 * Health and taxes are the only unknowns and both depend on the answer (more
 * SEPP income means more tax and a smaller ACA credit), so they are resolved
 * by a short gross-up loop: each pass is one computeYear on a trial retired
 * year, and the loop runs at most AUTO_SEPP_ESTIMATE_PASSES times, ONCE per
 * path — a rounding error next to the 41-year fixed-point solve.
 *
 * DOCUMENTED SIMPLIFICATIONS: it is a single-pass estimate of ONE year, held
 * fixed for the life of the series (which is the nature of a SEPP — the
 * payment is nominal and never re-sized). It reads this year's interest,
 * dividends and one-time income as if they recurred, ignores the LTCG the
 * taxable spend-down realizes, and assumes the household is on the ACA
 * benchmark plan for every month it is not on Medicare.
 */
function estimateBridgeAnnualNeed(ctx: PreparedSim, yi: number, a: BridgeNeedArgs): number {
  const aca: TaxYearInputs['aca'] =
    a.acaMonths > 0
      ? {
          enrolledMonths: a.acaMonths,
          benchmarkAnnualPremium: a.acaBenchmarkAnnual,
          grossAnnualPremium: a.acaBenchmarkAnnual,
        }
      : null;
  const nonIraIncome =
    a.ssGross + a.taxableInterest + a.dividends + a.oneTimeIncome + a.retirementIncomeFullYear;
  const retirementOrdinary = a.retirementIncomeFullYear;
  let forcedTotal = 0;
  for (const d of a.forcedPretax) forcedTotal += d.amount;
  let need = 0;
  for (let pass = 0; pass < AUTO_SEPP_ESTIMATE_PASSES; pass++) {
    const draw = Math.max(0, need);
    const taxes = computeYear(
      {
        year: a.year,
        filingStatus: a.filingStatus,
        state: ctx.residency[yi],
        birthYears: a.birthYears,
        agesAtYearEnd: a.ages,
        wages: 0, // the bridge is retired years by definition
        taxableInterest: a.taxableInterest,
        ordinaryDividends: a.dividends,
        qualifiedDividends: a.dividends,
        pretaxDistributions: draw + forcedTotal,
        rothConversionAmount: 0,
        ltcg: 0,
        socialSecurityGross: a.ssGross,
        distributions:
          draw > 0
            ? [
                ...a.forcedPretax,
                {
                  personId: a.owner,
                  accountType: 'traditional_ira',
                  amount: draw,
                  taxableAmount: draw,
                  penaltyException: 'sepp_72t',
                  penaltyBase: 0,
                },
              ]
            : a.forcedPretax,
        taxExemptInterest: 0,
        otherOrdinaryIncome: a.oneTimeTaxable + retirementOrdinary,
        charitableGiving: a.charitable,
        itemizable: { mortgageInterest: a.mortgageInterest, propertyTax: a.propertyTax },
        aca,
        medicare: a.medicare,
        inflationIndex: a.idx,
      },
      ctx.taxData,
    );
    const health = (taxes.aca?.netPremium ?? 0) + (taxes.medicare?.total ?? 0);
    const next =
      a.expensesFullYear +
      health +
      taxes.totalTax -
      nonIraIncome -
      a.bridgeDrawPerYear -
      forcedTotal;
    const done = Math.abs(next - need) < CONVERGE_TOLERANCE;
    need = next;
    if (done) break;
  }
  return need;
}

/**
 * Simulate one return path through the yearly loop. `ctx` is never mutated;
 * per-path state is cloned from the prepared templates. `returns` must cover
 * at least ctx.horizonYears entries.
 */
export function simulatePath(
  ctx: PreparedSim,
  returns: YearReturns[],
  opts: { trace: boolean },
): PathOutcome {
  const H = ctx.horizonYears;
  if (returns.length < H) {
    throw new Error(`simulatePath: need ${H} years of returns, got ${returns.length}`);
  }
  const accounts = cloneAccountStates(ctx.accountsTemplate);
  const housing = cloneHousingState(ctx.housingTemplate);
  const people = ctx.household.people;
  const divYield = ctx.market.stockDividendYield;
  const medSpread = ctx.market.medicalInflationRealSpread;
  const rentSpread = ctx.market.rentGrowthRealSpread;
  const homeSpread = ctx.market.homeAppreciationRealSpread;
  const magiLookback = ctx.taxData.medicare.magiLookbackYears;

  let idx = 1; // cumulative CPI at year start (1.0 in the first sim year)
  let cumMed = 1; // cumulative CPI + medicalInflationRealSpread (premium index)
  let cumRent = 1; // cumulative CPI + rentGrowthRealSpread
  const rentBases: number[] = ctx.rents.map(() => 1);
  const magiHist: number[] = new Array(H).fill(0);
  /**
   * Per-path history the giving rule reads (note 18). Written at the END of
   * each year, so year yi only ever sees entries < yi — which is exactly the
   * prior-year base the rule is defined on.
   * - realGrowthByYear: nominal investment gain minus CPI on the
   *   start-of-year total balance.
   * - givingIncomeByYear: Social Security + gross withdrawals (cash + taxable
   *   + pre-tax incl. RMDs and 72(t) + Roth; Roth conversions excluded — a
   *   conversion is not income to spend).
   */
  const realGrowthByYear: number[] = new Array(H).fill(0);
  const givingIncomeByYear: number[] = new Array(H).fill(0);
  let saleProceeds = 0;
  /*
   * --- Between-homes funding story (note 24) -------------------------------
   * Accumulated across the window years and recorded once, at the end of the
   * buy year. Null gates on `bh` keep all of it out of every run without a
   * window. Nominal dollars throughout: banked cash is a balance, and a
   * dollar parked in the sale year is still a dollar at the buy month.
   *
   * THE FIRST WINDOW ONLY. RunResult.purchaseFunding is the Housing card's
   * cash-at-purchase readout for the plan's own move, which is the first
   * cycle by construction; a later cycle (the widow's downsize) keeps every
   * mechanical behavior — banking, redirection, rent — via the per-year
   * arrays, but its funding story is not the one the card narrates.
   */
  const bh = ctx.betweenHomes[0] ?? null;
  let fundPreSavings = 0;
  let fundProceeds = 0;
  let fundBankedInvesting = 0;
  let fundBankedLiving = 0;
  let fundInterest = 0;
  let purchaseFunding: PurchaseFundingTrace | null = null;
  let insolvencyYear: number | null = null;
  const balancesRealByYear: number[] = new Array(H).fill(0);
  const yearRows: YearRow[] | null = opts.trace ? [] : null;

  /*
   * --- Guardrails state (note 22, SpendingPolicy 'guardrails') --------------
   *
   * Null under every other spending policy, which keeps the whole rule out of
   * the Monte Carlo hot path behind one null check — and, more importantly,
   * keeps `guardFactor` at exactly 1 there. Multiplying by 1.0 is exact in
   * IEEE-754, so `fixed_real` and `fixed_percent` runs do not move by a bit.
   */
  const guardrails =
    ctx.settings.spendingPolicy.type === 'guardrails'
      ? (ctx.settings.spendingPolicy.guardrails ?? DEFAULT_GUARDRAILS)
      : null;
  /**
   * A floor even when the band names none. The published Guyton-Klinger rule
   * has no floor, and without one a long bad sequence stacks cut on cut until
   * the plan "succeeds" on a standard of living nobody would accept — a success
   * rate that means nothing is worse than a lower one that means something.
   */
  const guardFloor = guardrails?.floorFraction ?? DEFAULT_GUARDRAILS.floorFraction;
  /** Cumulative multiplier on real living spending; 1 until a rail is breached. */
  let guardFactor = 1;
  /*
   * --- Per-path cut/raise record (RunResult.guardrailStats) ----------------
   * Five scalars, declared always but WRITTEN only inside the guardrails
   * blocks below — a non-guardrails path does no per-year work for them, the
   * same hot-path discipline as `guardrails` itself. `gMinFactor` starts at
   * the factor's own starting value (1), so a path the rails never touch
   * reports "never below plan" rather than a sentinel.
   */
  let gEverCut = false;
  let gMinFactor = 1;
  let gYearsBelow = 0;
  let gEverAbove = false;
  let gFloorTouched = false;
  /**
   * The withdrawal rate the band is measured against, captured in the plan's
   * FIRST FULLY RETIRED YEAR and never again — null until then.
   *
   * Not the simulation's first year, which is where "the rate the plan started
   * at" first reads like it should mean. While a salary is paying the bills the
   * household withdraws nothing, so spending-over-portfolio there is not a
   * withdrawal rate at all; anchoring on it would hand the household a raise
   * the day it retires purely because the portfolio grew while it was still
   * earning. A plan that never retires inside the horizon never anchors, and
   * guardrails then behaves exactly as fixed_real — which is the honest answer,
   * since it never withdraws either.
   */
  let guardInitialRate: number | null = null;

  // --- Un-tithed pot state (note 21) ---------------------------------------
  // Null in every run without a pot, which keeps the whole feature out of the
  // Monte Carlo hot path behind one null check.
  const pot = ctx.untithedPot;
  /**
   * The ongoing growth tithe, when the pot pairs with one — the combination
   * that runs the HIGH-WATER-MARK machinery (accrual and/or the trailing
   * stream read its base). Null for a pot beside any other ongoing method:
   * those pay their own cash and the hold has nothing growth-shaped to
   * accrue, so the mark never needs computing.
   */
  const potGrowthStream =
    pot !== null && ctx.retirementGiving.type === 'percent_of_growth'
      ? ctx.retirementGiving
      : null;
  /** Whether the hold accrues the growth tithe into the pot (the bundled behaviour). */
  const potAccrues = potGrowthStream !== null && pot !== null && pot.ongoingDuringHold === 'accrue_to_pot';
  /** The carve-out's account id once it exists, and the IRA it came out of. */
  let titheAccountId: string | null = null;
  let titheParentId: string | null = null;
  /**
   * The household's CUMULATIVE REAL INVESTMENT GAIN since retirement day, and
   * the high-water mark on it. A tithe is owed on whatever the running total
   * has climbed above the mark; a losing year lowers the total and nothing is
   * owed until it recovers, because "tithe the gross, once" means a recovery
   * re-earns ground already given on.
   *
   * GAIN, not balance — withdrawals must not enter this. See the year-end
   * block that advances them for why the balance version was wrong.
   */
  let cumRealGain = 0;
  let cumRealGainPeak = 0;
  /**
   * People whose automatic 72(t) has already fired on this path. The plan is
   * offered in every bridge year so it can wait for the year the household
   * actually needs pre-tax money; this is what stops it firing twice.
   */
  const autoElectedOwners = new Set<string>();
  // The base array exists only when the growth-tithe machinery runs; a pot
  // beside a non-growth ongoing method still needs the lock bookkeeping
  // (firstRetiredYi / lockYi) but never reads or writes a base.
  const titheHistory: TitheHistory & { baseRealByYear: number[]; lockYi: number | null } =
    potGrowthStream !== null && pot !== null
      ? {
          firstRetiredYi: null,
          lockYi: null,
          baseRealByYear: new Array<number>(H).fill(0),
          growthStream: pot.ongoingDuringHold,
        }
      : { firstRetiredYi: null, lockYi: null, baseRealByYear: [] };
  /** The pot's knobs, already resolved (resolveUntithedPot applied the defaults). */
  const titheDistributeYears = pot?.distributeYears ?? 0;
  const titheEarlyRelease = pot?.earlyRelease ?? false;
  /**
   * Pot instalments still owed once the lock engages; null until then. Counts
   * DOWN whether or not the pot has money left — a distribution schedule is a
   * calendar, not a balance, and stretching it whenever the pot ran low would
   * quietly turn "over ten years" into "forever".
   */
  let titheDistYearsLeft: number | null = null;
  /**
   * The safe-zone release's yardstick: the spendable REAL balance at the end
   * of the first fully-retired year. The trigger fires on the FIRST later
   * year that closes above it — before that first exceedance the running
   * maximum IS this figure, so one number suffices for the whole watch.
   */
  let titheReleaseMark: number | null = null;
  /** Cumulative deflated cash giving and the break-glass figure, for PathOutcome. */
  let charitableCashReal = 0;
  let breakGlassReal: number | null = null;

  // Per-owner penalty info is static now that the rule of 55 is gone.
  const owners = new Map<string, OwnerWithdrawalInfo>(
    people.map((p) => [p.id, { penaltyFreeFromYear: p.penaltyFreeFromYear }]),
  );
  /** 401(k) id -> IRA it was rolled into (retirement-year contributions follow the money). */
  const rolledTo = new Map<string, string>();
  /** Live 72(t) series by account id (payment fixed at election). */
  const seppState = new Map<string, SeppRunState>();
  /**
   * Automatic elections' lock windows, filled in-path when they fire (their
   * specs cannot be prepared: the account and the payment depend on this
   * path's balances). Empty and untouched when nothing can elect.
   */
  const autoActiveByYear: PreparedSepp[][] = ctx.hasAutoSepp
    ? Array.from({ length: H }, () => [])
    : new Array<PreparedSepp[]>(H).fill(NO_AUTO_SEPP as PreparedSepp[]);

  for (let yi = 0; yi < H; yi++) {
    const year = ctx.startYear + yi;
    const r = returns[yi];
    /** Ages of EVERY person in the profile — internal bookkeeping (RMD ages). */
    const ages = people.map((p) => year - p.birthYear);
    /*
     * THE YEAR'S TAX HOUSEHOLD. Identical to `ages` in any run without a
     * death; after one it drops the decedent from the first FULL year after he
     * died, because the year of death is still a joint return that counts them
     * (IRC 6013(a)(3)). The length of these arrays is what halves the standard
     * deduction's 65+ add-ons, Virginia's exemptions and age deduction, South
     * Carolina's per-person deductions, and Medicare's head-count.
     */
    const taxIdx = ctx.household.taxPeopleByYear[yi];
    const taxAges = taxIdx.length === people.length ? ages : taxIdx.map((i) => ages[i]);
    const taxBirthYears = ctx.taxBirthYearsByYear[yi];
    const filingStatus = ctx.household.filingByYear[yi];
    /** An automatic 72(t) elected this year (recorded in eventsFired). */
    let autoElectedThisYear = false;
    /**
     * Fix-A auditability: an automatic election DECLINED this year (honouring
     * the calendar cap left no payment) states so on the traced path. The cap
     * that merely shrank an election travels on the spec itself
     * (PreparedSepp.calendarCarveCap) so the payment's own trace block can
     * carry it; a decline elects nothing and so has no block to ride.
     */
    const autoSeppDeclineNotes: Array<{ label: string; note: string }> = [];

    // --- 1. Allocations for the year ---------------------------------------
    // Untargeted events first (every non-savings account), then per-account
    // events, then the automatic target-date glide — which prepareSim already
    // suppressed for years an allocation event governs, so the three passes
    // never fight over the same account.
    const mix = ctx.mixByYear[yi];
    if (mix) {
      for (const a of accounts) {
        if (a.type !== 'savings') a.allocation = { ...mix };
      }
    }
    // A targeted instruction names an account the user actually holds, so it
    // also reaches anything carved out of that account — a SEPP IRA (note 16's
    // split) or a Tithe Account (note 21). The user has one IRA at that
    // custodian and means all of it; the carve-outs are the engine's
    // bookkeeping, not accounts they can log into and re-allocate separately.
    for (const t of ctx.targetedMixByYear[yi]) {
      for (const a of accounts) {
        if (a.id === t.accountId || a.seppParentId === t.accountId || a.titheParentId === t.accountId) {
          a.allocation = { ...t.mix };
        }
      }
    }
    for (const t of ctx.tdfMixByYear[yi]) {
      for (const a of accounts) {
        if (a.id === t.accountId || a.seppParentId === t.accountId || a.titheParentId === t.accountId) {
          a.allocation = { ...t.mix };
        }
      }
    }

    // --- 1b. 401(k) -> IRA rollover at separation (note 7) -----------------
    // Runs before everything that reads balances (and before any 72(t)
    // election this year, whose payment must be sized off the merged IRA).
    for (const roll of ctx.rolloversByYear[yi]) {
      const from = accounts.find((a) => a.id === roll.fromId);
      if (!from) continue;
      let dest = accounts.find((a) => a.id === roll.to.id);
      const created = dest === undefined;
      if (!dest) {
        dest = {
          id: roll.to.id,
          name: roll.to.name,
          type: 'traditional_ira',
          owner: roll.to.owner,
          balance: 0,
          costBasis: 0,
          rothContributions: 0,
          rothConversions: [],
          // A synthetic destination has no allocation of its own, so it
          // inherits the 401(k)'s — an owner with no IRA effectively keeps
          // the same investments in the new account.
          allocation: { ...from.allocation },
        };
        accounts.push(dest);
      }
      // Rolled dollars adopt the DESTINATION IRA's allocation (note 8's open
      // question, decided: the rollover buys the IRA's investments).
      // Lifetime contributions travel with them (note 21): a rollover moves
      // the same dollars into a different wrapper and changes nothing about
      // how much of them was contributed. A merge in which EITHER side is
      // unknown makes the total unknown — adding a known figure to an unknown
      // one and reporting the sum would invent certainty the household does
      // not have, and the tithe seed's flag exists precisely to say so.
      if (created) {
        dest.lifetimeContributions = from.lifetimeContributions;
      } else if (
        dest.lifetimeContributions === undefined ||
        from.lifetimeContributions === undefined
      ) {
        dest.lifetimeContributions = undefined;
      } else {
        dest.lifetimeContributions += from.lifetimeContributions;
      }
      dest.balance += from.balance;
      from.balance = 0;
      rolledTo.set(from.id, dest.id);
    }

    // --- 1c. Death: the balance sheet passes to the survivor ---------------
    // Runs in the death YEAR, before anything reads balances or ages: from
    // here the accounts are the survivor's, on their RMD schedule and their
    // 59 1/2 date, and any 72(t) of the deceased has stopped. Everything else about the death — filing
    // status, Social Security, living costs, health coverage, the insurance
    // payout — was settled path-independently in prepareHousehold.
    const death = ctx.household.death;
    if (death !== null && death.year === year) {
      applyDeathToAccounts(accounts, seppState, death.personId, death.survivorId);
    }

    // --- Start-of-year snapshot -------------------------------------------
    // `totalStart` is the WHOLE portfolio (it is the base the giving rules'
    // real-growth figure nets inflation off, and that figure is measured on
    // the whole portfolio's nominal gain). `spendableStart` excludes a Tithe
    // Account carve-out ONLY once it is locked: through the soft window the
    // pot is the household's last-resort money and honestly counts, so the
    // fixed_percent policy and the guardrails price spending off it — which
    // is precisely the deferred drag the window exists for. The lock state
    // read here is last year's answer, and that is correct: `lockYi` for this
    // year was fixed no later than the END of the previous year (retirement
    // day sets the deferral's date; the release trigger locks the NEXT year),
    // except on retirement day itself — when the carve-out does not exist yet
    // and `titheStart` is 0 either way.
    let totalStart = 0;
    let titheStart = 0;
    for (const a of accounts) {
      totalStart += a.balance;
      if (a.id === titheAccountId) titheStart = a.balance;
    }
    const titheLockedAtStart = titheHistory.lockYi !== null && yi >= titheHistory.lockYi;
    const spendableStart = totalStart - (titheLockedAtStart ? titheStart : 0);
    // Note 24's "pre-existing savings": cash the household held BEFORE the
    // move created any — the start of the sale year, before proceeds, banking
    // or the year's interest. Captured once per path.
    if (bh !== null && yi === bh.sellYi) {
      for (const a of accounts) {
        if (a.type === 'savings') fundPreSavings += Math.max(0, a.balance);
      }
    }

    // --- 2. Income --------------------------------------------------------
    // Interest/dividend timing convention (documented on the methodology
    // page): START-of-year balances earn this year's interest and dividends.
    // Mid-year inflows — sale proceeds, surplus sweeps, invested purchase
    // remainders — earn nothing until the following year.
    // Wages arrive net of BOTH pre-tax payroll deductions: the 401(k)
    // deferral (already removed in prepareHousehold) and the employee share
    // of the employer health premium (Section 125; capped at wages so it can
    // never make them negative). The share never becomes household cash and
    // is NOT a health expense — see income.employerHealthPremiumShare.
    const wagesAfterDeferral = ctx.household.wagesNetByYear[yi];
    const premiumShare = Math.min(
      ctx.household.premiumShareRealByYear[yi] * idx,
      wagesAfterDeferral,
    );
    const wagesNet = wagesAfterDeferral - premiumShare;
    const ssGross = ctx.household.ssGrossRealByYear[yi] * idx; // COLA = simulated CPI
    // Retirement income (the retired counterpart of a salary): monthly x the
    // months nobody worked, x CPI. Spendable cash, and ALWAYS ordinary income
    // (the app's standing rule, 2026-08-31 — the profile's old
    // retirementIncomeTaxable flag is parsed but ignored).
    const retirementIncome = ctx.household.retirementIncomeRealByYear[yi] * idx;
    const retirementOrdinaryIncome = retirementIncome;
    let savingsInterest = 0;
    let bondBillInterest = 0;
    let dividends = 0;
    /*
     * Cash yields what the plan says it yields, defaulting to the year's bills
     * return. A household parking house-sale proceeds for a year or two does
     * not leave them at the T-bill rate by accident, and on a seven-figure
     * balance the difference is the size of a tax bracket. It applies to
     * SAVINGS ONLY — the bills sleeve of an investment allocation below keeps
     * the market's own return, because that is a market fact rather than a
     * choice about where to park cash.
     */
    const cashYield = ctx.market.cashYieldNominal ?? r.bills;
    for (const a of accounts) {
      if (a.balance <= 0) continue;
      if (a.type === 'savings') {
        savingsInterest += a.balance * cashYield;
      } else if (a.type === 'taxable_brokerage') {
        dividends += a.balance * a.allocation.stocks * divYield;
        bondBillInterest +=
          a.balance * a.allocation.bonds * r.bonds + a.balance * a.allocation.bills * r.bills;
      }
    }
    /*
     * `let`, because the house sale lands later in the year (step 4) and its
     * proceeds have to earn something for the months they are actually held —
     * see the credit after the housing block. Interest is otherwise charged on
     * START-OF-YEAR balances, which is why a June sale of $800,000 previously
     * produced $1,520 of interest for the whole year.
     */
    let taxableInterest = savingsInterest + bondBillInterest;
    const oti = ctx.oneTimeIncome[yi];

    // --- 3. Living + charitable + one-time expenses ------------------------
    // Living is the consumption stream (the fixed_percent policy still
    // overrides it wholesale); charitable is its own stream, feeding both
    // expenses.total and the year's charitable tax deductions. Both are pairs
    // now: a working-side value and a retired-side one (note 19).
    //
    // The investing stream's signal, and the switch for all three pairs: the
    // months anyone in the household worked. 12 = a working year (working-side
    // figures), 0 = a fully retired year (retired-side figures), anything
    // between = the retirement year, prorated between the two.
    const workedMonthsHh = ctx.household.employerMonthsByYear[yi];
    const retiredMonthsHh = 12 - workedMonthsHh;
    // RETIREMENT DAY for the un-tithed pot (note 21). Recorded here rather
    // than where the carve-out is actually created (step 5c, below) because
    // the giving figure two dozen lines down already needs to know how many
    // retired years have passed — a pot configured with holdYears: 0 locks
    // and distributes from this very year. The lock date is provisional: the
    // hold's own end, which the safe-zone release (year-end block) may pull
    // earlier — never later.
    if (pot !== null && workedMonthsHh === 0 && titheHistory.firstRetiredYi === null) {
      titheHistory.firstRetiredYi = yi;
      titheHistory.lockYi = yi + pot.holdYears;
    }
    /**
     * Whether the carve-out is IN ESCROW this year — out of spendable, out of
     * the metrics, distributing. Fixed for the whole year: the only writer
     * that could move `lockYi` after this line is the year-end release
     * trigger, and it only ever sets NEXT year's lock.
     */
    const titheLocked = titheHistory.lockYi !== null && yi >= titheHistory.lockYi;
    const pol = ctx.settings.spendingPolicy;
    // Living, working side. The fixed_percent policy still overrides living
    // spending wholesale (a share of the start-of-year portfolio), and there
    // is no working/retired distinction to make in that case.
    const livingWorking =
      pol.type === 'fixed_percent'
        ? (pol.percent ?? 0) * spendableStart
        : ctx.profile.expenses.livingMonthly * 12 * idx;
    // Living, retired side. UNDEFINED MEANS "the same as working" — living
    // costs do not fall the day the salary stops — and in that case the blend
    // below is skipped outright, so an untouched profile keeps producing
    // exactly the numbers it produced before this pair existed.
    const retiredLivingMonthly =
      pol.type === 'fixed_percent' ? undefined : ctx.livingMonthlyRetired;
    const hasRetiredLiving = retiredLivingMonthly !== undefined;
    const livingRetired = hasRetiredLiving ? retiredLivingMonthly * 12 * idx : livingWorking;
    /**
     * The living stream before 'living' expense_change events: the working
     * figure while anyone earns, the retired figure once nobody does, and the
     * retirement year prorated between them — the same shape the giving rule
     * has used since note 18. `let` only for the renting blend directly below;
     * every other run leaves it exactly this expression.
     */
    let livingBlendedCouple =
      hasRetiredLiving && workedMonthsHh < 12
        ? workedMonthsHh === 0
          ? livingRetired
          : livingWorking * (workedMonthsHh / 12) + livingRetired * (retiredMonthsHh / 12)
        : livingWorking;
    /*
     * --- THE RENTING COLUMN (note 23) -------------------------------------
     *
     * In-window months price at the renting totals, out-of-window months at
     * the ordinary blend above. Month-accurate because both partitions are
     * exact: worked months are a prefix of the year and the window is one
     * contiguous span, so the four counts below tile the twelve months with
     * no month counted twice — which is what keeps the 2027/2028 halves of a
     * June-to-June window summing to exactly twelve renting months.
     *
     * PRECEDENCE WITH A DEATH: from the death YEAR on, the SURVIVOR column
     * governs and the renting column is ignored — the gate below. WHY THAT
     * RULE: the survivor's living arrives as `livingFactorByYear`, a
     * household-level ratio derived from the budget's own un-discounted
     * columns; applying that ratio on top of renting totals would price the
     * survivor's months at a number no column states (the survivor figures
     * scaled by the couple's dwelling discount), and a per-month
     * survivor-x-renting lattice is complexity a one-year corner case does
     * not buy. Skipping the discount in the death year's pre-death months
     * overstates living there — the conservative direction — and it is the
     * rule a person can state in a sentence: once someone has died, the
     * survivor column is the only one that speaks.
     *
     * `livingRentingBankWant` is the raw month-prorated reduction (note 24b):
     * in-force living minus renting living, floored at 0 — a column that
     * costs MORE while renting (a storage unit) banks nothing, it just
     * spends. Deliberately measured BEFORE the guardrails factor and any
     * expense_change multiplier: those reshape the whole baseline, the
     * banking cap at the year's actual leftover already keeps an overstated
     * want from banking money that is not there, and the death gate means the
     * survivor factor here is exactly 1.
     */
    const windowMonths = ctx.betweenHomesMonthsByYear[yi];
    let livingRentingBankWant = 0;
    const renting = ctx.livingRenting;
    if (
      renting !== undefined &&
      windowMonths > 0 &&
      pol.type !== 'fixed_percent' &&
      (death === null || year < death.year)
    ) {
      const workedIn = ctx.betweenHomesWorkedMonthsByYear[yi];
      const retiredIn = windowMonths - workedIn;
      const rentingWorkingAnnual = renting.working * 12 * idx;
      const rentingRetiredAnnual = renting.retired * 12 * idx;
      const withRenting =
        (livingWorking * (workedMonthsHh - workedIn) +
          livingRetired * (retiredMonthsHh - retiredIn) +
          rentingWorkingAnnual * workedIn +
          rentingRetiredAnnual * retiredIn) /
        12;
      livingRentingBankWant = Math.max(0, livingBlendedCouple - withRenting);
      livingBlendedCouple = withRenting;
    }
    /*
     * ONE PERSON EATS LESS THAN TWO. `livingFactorByYear` is exactly 1 in every
     * year of every run without a death — so this multiplication is a no-op
     * rather than a second code path — and after one it is the event's
     * `livingFraction`, prorated in the death year by the months either side
     * of it. See DEFAULT_SURVIVOR_LIVING_FRACTION for why the default is 0.75
     * and why it is the number in this whole feature most worth arguing with.
     */
    const livingBlended = livingBlendedCouple * ctx.household.livingFactorByYear[yi];
    /*
     * --- GUARDRAILS (note 22) ---------------------------------------------
     *
     * Real spending HOLDS CONSTANT while the current withdrawal rate — this
     * year's living spend over this year's spendable portfolio — stays inside
     * the band around the rate the plan started at. Above the upper rail,
     * spending is cut by `adjustment`; below the lower rail it is raised by the
     * same; between them NOTHING HAPPENS, and that inaction is the entire
     * difference from `fixed_percent`, which re-prices spending every single
     * year and swings the standard of living with the market.
     *
     * The rate is measured on the living stream alone, which is also the only
     * thing the rule moves. Numerator and lever being the same quantity is what
     * makes the band and the floor mean the same thing as each other: since the
     * comparison is a RATIO against the plan's own opening rate, what the
     * numerator leaves out (housing, health, giving, tax) cancels rather than
     * distorting.
     *
     * A dead portfolio is skipped rather than divided by: `spendableStart` of 0
     * gives an infinite rate and a cut that changes nothing, on a path that has
     * already failed.
     */
    let guardrailMoved: 'cut' | 'raise' | null = null;
    /** The rate the rails were actually tested against — the trace reports this one. */
    let guardrailRate = 0;
    if (guardrails !== null && spendableStart > 0) {
      // The CURRENT spending level over the CURRENT portfolio: the factor from
      // previous years is part of the numerator, because what the household is
      // about to spend is what the rails have to judge.
      const rate = (livingBlended * guardFactor) / spendableStart;
      guardrailRate = rate;
      if (guardInitialRate === null) {
        if (workedMonthsHh === 0) guardInitialRate = rate;
      } else {
        const before = guardFactor;
        if (rate > guardInitialRate * guardrails.upper) {
          // The floor can absorb a cut entirely, and then nothing moved — say
          // so rather than flagging a cut the household never took.
          const uncapped = guardFactor * (1 - guardrails.adjustment);
          guardFactor = Math.max(guardFloor, uncapped);
          if (guardFactor !== before) {
            guardrailMoved = 'cut';
            gEverCut = true;
          }
          // "Touched the floor" means A CUT RAN INTO IT — clamped to it, or
          // absorbed by it entirely — not "the factor happened to equal it":
          // a floorFraction of 1 starts every path AT the floor, and counting
          // that would report 100% floor-touch on plans that never breached.
          if (uncapped <= guardFloor) gFloorTouched = true;
        } else if (rate < guardInitialRate * guardrails.lower) {
          /*
           * By default NO CEILING: Guyton-Klinger's prosperity rule has none,
           * and a household whose portfolio has run away from its spending is
           * not taking a risk by spending more of it. `raiseCeiling` is the
           * owner's OPT-IN cap on that prosperity (1.0 = never spend above
           * plan); absent, the else-branch below is the exact expression this
           * site has always computed, so every ceiling-less plan is
           * bit-identical. A raise the ceiling absorbs entirely reports no
           * raise — nothing about the household's spending moved — the same
           * ruling the floor makes for an absorbed cut a few lines up.
           */
          const raised = guardFactor * (1 + guardrails.adjustment);
          guardFactor =
            guardrails.raiseCeiling !== undefined
              ? Math.min(guardrails.raiseCeiling, raised)
              : raised;
          if (guardFactor !== before) guardrailMoved = 'raise';
        }
      }
    }
    if (guardrails !== null) {
      /*
       * Per-path record, at spend time — the factor the year actually ran at,
       * after this year's move (or non-move). Post-insolvency years still
       * count toward `gYearsBelow`: the factor is the standard the rule was
       * prescribing, and stopping the clock at failure would make a path that
       * cut and then died look briefer-below-plan than one that cut and
       * survived. Strict comparisons: a ceiling of 1.0 parks the factor at
       * exactly 1, which is AT plan, not above it.
       */
      if (guardFactor < gMinFactor) gMinFactor = guardFactor;
      if (guardFactor < 1) gYearsBelow += 1;
      else if (guardFactor > 1) gEverAbove = true;
    }
    /** Living after the guardrails band. Exactly `livingBlended` under any other policy. */
    const livingGoverned = livingBlended * guardFactor;
    // expense_change events multiply/offset whatever the pair produced, so a
    // "spend 10% less from 2030" what-if still means what it says on both sides.
    /*
     * LIFE INSURANCE PREMIUMS, summed across every policy in force this year.
     *
     * prepareHousehold owns the whole rule — which policies exist, whose life
     * each covers, which months each is charged for, and when each stops — and
     * hands down one figure in start-year dollars. It rides on top of the living
     * baseline rather than inside it precisely so it can stop on its own. Absent
     * means 0, and the user is expected to have taken it OUT of livingMonthly:
     * naming it here and leaving it in the baseline charges it twice, the same
     * trap property tax set earlier.
     *
     * A POLICY DOES NOT END WITH THE PAYCHECK UNLESS IT SAYS SO. That used to be
     * the rule — term life is income replacement, so with no salary left to
     * replace there was nothing for it to do — and it is still what the
     * single-policy fields with no term dates mean. But it is wrong whenever a
     * term outlasts the paycheck: a policy running to 2034 against a 2030
     * retirement means dropping it at retirement drops four years of premium
     * AND four years of $2,500,000 of cover, in exactly the pre-Social-Security
     * years where a death hurts most. `cancelAtRetirement` is now the explicit way to say
     * "cancel it", and it is FALSE by default.
     */
    const lifeInsurance = ctx.household.lifeInsurancePremiumRealByYear[yi] * idx;
    const baseline =
      livingGoverned * ctx.livingMultiplier[yi] + ctx.livingDeltaReal[yi] * idx + lifeInsurance;
    /**
     * A FULLY RETIRED year's living cost, for the automatic-72(t) estimator
     * below: it prices a retired year and fixes a payment for the whole bridge,
     * so it must see retired living, not the retirement year's blend. Identical
     * to `baseline` (bit for bit) whenever no retired figure is configured.
     *
     * It carries the guardrails factor for the same reason: the estimator fixes
     * a payment for the whole bridge, and it should price the spending the
     * household will actually do rather than the spending the rule has already
     * moved away from.
     */
    const livingRetiredFullYear =
      livingRetired * guardFactor * ctx.livingMultiplier[yi] + ctx.livingDeltaReal[yi] * idx;
    const charitablePaycheck = Math.max(
      0,
      ctx.profile.expenses.charitableMonthly * 12 * idx * ctx.charitableMultiplier[yi] +
        ctx.charitableDeltaReal[yi] * idx,
    );
    // Giving in retirement (note 18). The paycheck stream has a base only
    // while wages are coming in; from the first year nobody earns, the rule
    // takes over. `ruleFullYear` is computed even in a year the rule does not
    // govern, because the automatic-72(t) sizing below prices a FULLY RETIRED
    // year and must see the giving that year would actually carry.
    const givingRule = ctx.retirementGiving;
    const ruleFullYear =
      givingRule.type === 'continue'
        ? charitablePaycheck
        : retirementGivingAnnual(
            givingRule,
            yi,
            idx,
            realGrowthByYear,
            givingIncomeByYear,
            titheHistory,
          );
    /** Months of this year the rule governs (0 = the paycheck stream owns it). */
    let givingRuleMonths = 0;
    let charitable = charitablePaycheck;
    if (givingRule.type !== 'continue' && workedMonthsHh < 12) {
      givingRuleMonths = retiredMonthsHh;
      // A fully retired year is the rule outright; the retirement year itself
      // is prorated — paycheck giving for the months worked, the rule for the
      // rest. The `=== 0` branch is not just an optimization: it keeps a fully
      // retired year exactly equal to the rule's own figure.
      charitable =
        workedMonthsHh === 0
          ? ruleFullYear
          : charitablePaycheck * (workedMonthsHh / 12) + ruleFullYear * (givingRuleMonths / 12);
    }
    const oneTimeExp = ctx.oneTimeExpense[yi];

    // --- 4. Housing --------------------------------------------------------
    for (let i = 0; i < ctx.rents.length; i++) {
      if (ctx.rents[i].startYear === year) rentBases[i] = cumRent;
    }
    let rentNominal = 0;
    for (let i = 0; i < ctx.rents.length; i++) {
      const months = ctx.rents[i].monthsByYear[yi];
      if (months > 0) rentNominal += ctx.rents[i].monthlyCost * months * (cumRent / rentBases[i]);
    }
    const hres = runHousingYear(housing, {
      year,
      idx,
      sellMonth: ctx.sellMonthByYear[yi],
      buy: ctx.buyByYear[yi],
      saleProceedsAvailable: saleProceeds,
      /*
       * What is left in savings for a house, where the proceeds landed — so a
       * purchase priced at "the sale proceeds" cannot outspend the cash that
       * survived living on it, nor reach into investments held before the move.
       *
       * THIS YEAR'S OWN LIVING COSTS COME OUT FIRST. Handing the house every
       * dollar of savings and letting the year's spending fall through to the
       * brokerage and the IRA would put the house ahead of the household, which
       * is the opposite of the rule. Housing costs are excluded from the
       * reservation because they are what this call is about to compute;
       * living, giving and one-off spending are all known by now.
       */
      cashAvailable:
        accounts.reduce((sum, a) => (a.type === 'savings' ? sum + Math.max(0, a.balance) : sum), 0) -
        (baseline + charitable + oneTimeExp),
      rentNominal,
      /*
       * §121, and a rule that genuinely matters to any plan with a sale in it.
       * A single filer excludes $250,000 of gain — but §121(b)(4) preserves the
       * full $500,000 for a surviving spouse whose sale falls within TWO YEARS
       * of the death. A household planning to sell around retirement lives
       * inside that window, so pricing a survivor's sale at a flat $250,000 would
       * overstate their tax in exactly the scenario the widow score exists to
       * test. homeSaleExclusionFor applies the window.
       */
      homeSaleExclusion: homeSaleExclusionFor(
        ctx.taxData.federal,
        filingStatus,
        year,
        ctx.household.death?.year ?? null,
      ),
      /*
       * A housing plan's appreciation rate REPLACES the CPI-linked rate, it is
       * not added to it: this is the one place the home grows, so overriding
       * here is what makes the projected sale price equal the profile value
       * compounded at exactly the configured rate — and makes it identical on
       * every Monte Carlo path, where `r.cpi` is not.
       */
      homeGrowthRate: ctx.homeGrowthRateOverride ?? r.cpi + homeSpread,
    });
    saleProceeds = hres.saleProceedsRemaining;
    if (hres.saleNetCash > 0) {
      addToSavings(accounts, hres.saleNetCash, people[0].id);
      /*
       * The proceeds earn for the months they are actually held.
       *
       * Interest is charged on start-of-year balances, so money arriving in
       * June earned NOTHING for the rest of that year — on the repro plan an
       * $800,000 June sale produced $1,520 of interest, understating both the
       * sale year's income and its tax. Crediting the remaining months at the
       * cash yield is the smallest correction that is right in the direction
       * that matters; it is still a simple-interest approximation rather than
       * a monthly accrual, and deliberately so, because the balance is being
       * spent down over those same months.
       */
      const sellMonth = ctx.sellMonthByYear[yi];
      if (sellMonth !== null) {
        const monthsHeld = Math.max(0, 12 - sellMonth);
        const earned = hres.saleNetCash * cashYield * (monthsHeld / 12);
        savingsInterest += earned;
        taxableInterest += earned;
      }
    }
    /*
     * Note 24: the funding story's proceeds and interest lines. Interest is
     * the SAVINGS interest the window years actually credited — pre-existing
     * balances, the proceeds' partial-year credit above, and banked cash once
     * it starts compounding into the next year's start balance. The buy
     * year's credit is prorated to the months before the purchase: interest
     * is charged on start-of-year balances for the whole year, but only the
     * pre-buy share of it was money standing at the buy month. An
     * approximation in the small (the engine's own credit is annual, not
     * monthly), stated rather than hidden.
     */
    if (bh !== null && yi === bh.sellYi) fundProceeds = hres.saleNetCash;
    if (bh !== null && yi >= bh.sellYi && yi <= bh.buyYi) {
      fundInterest +=
        yi === bh.buyYi ? savingsInterest * ((bh.buyMonth - 1) / 12) : savingsInterest;
    }
    /*
     * DEATH-YEAR CASH: the life-insurance face amount and the Social Security
     * lump-sum death payment.
     *
     * Both land in SAVINGS, like house-sale proceeds, and deliberately NOT in
     * the income lines. Two reasons, and the first is not subtle: a death
     * benefit is not income at all. IRC 101(a)(1) excludes it from gross income
     * outright, with no dollar cap and no filing-status condition, so it must
     * raise neither AGI nor any MAGI variant — it cannot be allowed to push the
     * survivor over the ACA cliff, into an IRMAA tier, into NIIT, or to make more of their
     * Social Security taxable.
     *
     * The second reason is mechanical and would have been a disaster. Routing
     * it through `oneTimeIncome` would have put it in `incomeCash`, where a
     * WORKING year's leftover is CONSUMED as unbudgeted spending (note 20) — a
     * seven-figure benefit paid to the survivor of someone who died with a paycheck
     * would have evaporated in the year it arrived. Landing it in savings makes
     * it a balance, which is what a cheque from an insurer actually is.
     *
     * Both are zero in every year of every run without a death.
     */
    const lifeBenefit = ctx.household.lifeInsuranceBenefitByYear[yi];
    const ssLumpSum = ctx.household.ssLumpSumByYear[yi];
    if (lifeBenefit + ssLumpSum > 0) {
      addToSavings(accounts, lifeBenefit + ssLumpSum, ctx.household.death?.survivorId ?? people[0].id);
    }

    // SPEC §9.3: tracked sale proceeds a purchase did not consume (financed
    // buy, or any buy whose outflow is below the tracked cash) are invested
    // rather than left earning the bills rate: move them out of savings into
    // the first taxable brokerage — balance += X and costBasis += X (cash
    // entering a brokerage is basis) — capped at the savings balance. With
    // no brokerage account they stay in savings (documented limitation).
    if (hres.proceedsToInvest > 0) {
      const savings = accounts.find((a) => a.type === 'savings');
      const brokerage = accounts.find((a) => a.type === 'taxable_brokerage');
      if (savings && brokerage) {
        const invest = Math.min(hres.proceedsToInvest, Math.max(0, savings.balance));
        if (invest > 0) {
          savings.balance -= invest;
          brokerage.balance += invest;
          brokerage.costBasis += invest;
        }
      }
    }

    // --- 5. Forced distributions: RMDs, then 72(t)/SEPP payments -----------
    // Health inputs are resolved first: they are loop-invariant (nothing below
    // changes them), and the automatic-72(t) sizing needs them to price the
    // bridge year's premiums.
    const acaMonths = ctx.household.acaMonthsByYear[yi];
    // The owner's benchmark quote covers the whole household, so a survivor
    // pays for their share of it — the factor is 1 in every year of every run
    // without a death. The survivor's cliff, meanwhile, is computed against the ONE-person
    // federal poverty level in the tax module: the premium roughly halves while
    // the income that forfeits the credit falls by a quarter of its headroom,
    // which is why the ACA years are where a widow score usually breaks.
    const benchmark =
      ctx.profile.health.acaBenchmarkMonthly *
      12 *
      ctx.household.acaAgeFactorByYear[yi] *
      ctx.household.acaBenchmarkFactorByYear[yi] *
      cumMed;
    const acaInput: TaxYearInputs['aca'] =
      acaMonths > 0
        ? { enrolledMonths: acaMonths, benchmarkAnnualPremium: benchmark, grossAnnualPremium: benchmark }
        : null;
    // Aligned with the year's TAX household, so a survivor's Medicare is billed
    // for one person from the first full year after the death.
    const medMonths = taxIdx.map((i) => ctx.household.medicareMonthsByPersonYear[i][yi]);
    const lookbackYi = yi - magiLookback;
    const magiTwoYearsPrior = magiHist[Math.max(0, lookbackYi)];
    const medicareInput: TaxYearInputs['medicare'] = medMonths.some((m) => m > 0)
      ? {
          enrolledMonthsPerPerson: medMonths,
          magiTwoYearsPrior,
          partDPlanMonthly: ctx.profile.health.partDPlanMonthly * cumMed,
          premiumIndex: cumMed,
        }
      : null;

    const agesByOwner = new Map<string, number>();
    people.forEach((p, i) => agesByOwner.set(p.id, ages[i]));
    const rmds = computeRmds(accounts, agesByOwner, ctx.rmd);
    let rmdTotal = 0;
    const drawn = new Map<string, number>();
    for (const x of rmds) {
      rmdTotal += x.amount;
      drawn.set(x.accountId, (drawn.get(x.accountId) ?? 0) + x.amount);
    }
    const rmdSlices = rmdDistributions(rmds);

    /*
     * NOTE 21 — the carve-out's forced RMD is GIVEN AWAY, not spent.
     *
     * `locked` keeps the Tithe Account out of the withdrawal ordering and out
     * of Roth conversions, but it deliberately does NOT reach computeRmds
     * above: the internal earmark has no legal existence, the IRS sees one
     * IRA, and the required distribution runs off the whole balance. (Summed
     * across the split the household's RMD is exactly what it would have been
     * undivided — same owner, same age, same divisor.) So from the year RMDs
     * begin, some of the carve-out is forced out every year whether anyone
     * wants it or not.
     *
     * That money cannot go back in and it is not the household's to spend, so
     * it is given away in cash the same year, on top of whatever the rule
     * prescribes — which is exactly what the real instrument does (a qualified
     * charitable distribution satisfies the RMD, Notice 2007-7 A-42). Adding
     * it to `charitable` here, BEFORE the withdrawal solve reads
     * `outflowFixed`, is what keeps the cash identity closed: the dollar
     * arrives in incomeCash as part of rmdTotal and leaves as an expense.
     *
     * For a household retiring well before 75 the two phases never overlap —
     * RMDs start at 75, decades after the defer window — so the "no cash giving during the
     * defer years" promise is not actually broken by this. A plan that retires
     * near 75 would see it, and the honest answer there is that the IRS wins.
     */
    let titheForcedGift = 0;
    if (titheAccountId !== null) {
      for (const x of rmds) if (x.accountId === titheAccountId) titheForcedGift += x.amount;
      charitable += titheForcedGift;
    }

    // Elections starting this year fix their payment off the CURRENT balance
    // (post-rollover, net of anything already committed this year) and, when
    // the requested payment is below the formula maximum, SPLIT the account
    // (note 16 / seppSplit): a carved-out SEPP IRA whose own formula maximum
    // is exactly the requested payment, plus a remainder that stays an
    // ordinary, fully accessible traditional IRA. Only the carve-out is locked.
    for (const spec of ctx.seppStartsByYear[yi]) {
      electSepp(spec, accounts, drawn, seppState);
    }

    // --- 5b. Automatic 72(t) bridge (scenario.autoSepp, undefined = ON) ----
    // A person retiring before their own penalty-free year elects here, in the
    // retirement year, on the largest traditional IRA they own — which is the
    // account the 401(k) rolled into minutes ago (step 1b), so the payment is
    // sized off the merged balance. The payment is the household's projected
    // annual cash need over the bridge, capped at the whole-account formula
    // maximum, and the split-IRA technique carves out only the principal that
    // payment needs: the rest stays an ordinary, fully accessible IRA.
    for (const plan of ctx.autoSeppStartsByYear[yi]) {
      // Offered every bridge year, so it must fire at most once per person.
      if (autoElectedOwners.has(plan.owner)) continue;
      // A dead person elects nothing. Those accounts are the survivor's now, and a 72(t)
      // in the deceased's name would be an obligation on an owner who no longer
      // exists; if the SURVIVOR needs a bridge, their own plan offers one.
      if (death !== null && plan.owner === death.personId && year >= death.year) continue;
      // The series is sized on the age it actually starts at, and locks five
      // years from THAT year — not from the retirement it was scheduled off.
      const forYear = autoSeppForYear(plan, year, ctx.rmd);
      // Never elect on an account already under a series (a carve-out, or
      // another live election's account).
      const lockedNow = new Set<string>();
      for (const st of seppState.values()) if (seppIsLive(st)) lockedNow.add(st.lockedAccountId);
      let src: AccountState | undefined;
      let srcBalance = 0;
      for (const acc of accounts) {
        if (acc.type !== 'traditional_ira' || acc.owner !== plan.owner) continue;
        // Never elect on a carve-out of either kind: a SEPP IRA is already
        // under a series, and a Tithe Account is money the household has
        // promised away — putting it under a 72(t) would spend the gift.
        if (acc.seppParentId !== undefined || acc.titheParentId !== undefined) continue;
        if (lockedNow.has(acc.id)) continue;
        const avail = Math.max(0, acc.balance - (drawn.get(acc.id) ?? 0));
        // Strictly greater: ties keep the first account in profile order.
        if (src === undefined || avail > srcBalance) {
          src = acc;
          srcBalance = avail;
        }
      }
      if (src === undefined || srcBalance <= 0) continue; // nothing to elect on

      // Cash and taxable balances are the bridge's OTHER resource; spreading
      // them over the whole bridge (not spending them in year one) is what
      // keeps the payment down to the recurring gap.
      let accessible = 0;
      for (const acc of accounts) {
        if (acc.type === 'savings' || acc.type === 'taxable_brokerage') {
          accessible += Math.max(0, acc.balance - (drawn.get(acc.id) ?? 0));
        }
      }
      // The UN-NETTED figure, kept for Fix A below: the calendar cap asks how
      // much of the committed outflows the household's non-IRA money can cover
      // AT ALL, while the bridge sizing asks what is left over for living —
      // two different questions off the same balances.
      const accessibleRaw = accessible;
      /*
       * MONEY ALREADY PROMISED TO SOMETHING ELSE IS NOT BRIDGE MONEY.
       *
       * A household that sells a house the year it retires is holding the
       * proceeds when this runs, and counting them made the bridge look
       * self-funded — a $1.2M balance over four years is $300k a year, so the
       * estimator returned a NEGATIVE need and elected nothing. Then the plan
       * bought the next house with those same proceeds, went back to the IRA at
       * 57, and paid the early-withdrawal penalty the series existed to avoid:
       * measured on a representative plan, about $50,000 of penalties with the
       * toggle ON and the election silently skipped.
       *
       * So subtract what the bridge years have already spoken for. A purchase
       * in the ELECTION year is excluded — housing ran earlier this year, so
       * the balances above already reflect it — while one-time expenses are
       * not, because they are paid in the withdrawal solve further down.
       */
      const bridgeEndYi = Math.min(H, yi + forYear.bridgeYears);
      let committed = 0;
      for (let by = yi; by < bridgeEndYi; by++) {
        committed += ctx.oneTimeExpense[by];
        if (by === yi) continue; // this year's purchase already left the balances
        const buy = ctx.buyByYear[by];
        if (!buy) continue;
        /*
         * A `sale_proceeds` CASH purchase is a RESIDUAL claim, not a
         * commitment: the house is bought with whatever survived, so living
         * costs come out of the proceeds first and the price falls to match
         * (see housing.ts, liquidAvailable). Counting it here would reserve
         * cash that living is entitled to spend, and the bridge would elect a
         * series to cover a gap the proceeds already cover.
         *
         * A house at a FIXED price is a real commitment — that money has to be
         * there on the day — and a financed purchase commits its down payment.
         */
        if (buy.price === 'sale_proceeds' && buy.financing === 'cash') continue;
        const price = buy.price === 'sale_proceeds' ? saleProceeds : buy.price;
        committed += buy.financing === 'cash' ? price : price * buy.financing.downPct;
        // A financed buy's scheduled payoff (payoffAfterYears) is a SECOND
        // committed outflow of the same purchase, landing N years later —
        // priced off the same `price` the down payment just used.
        if (buy.financing !== 'cash' && buy.financing.payoffAfterYears !== undefined) {
          const lumpYi = by + buy.financing.payoffAfterYears;
          if (lumpYi < bridgeEndYi) {
            const lump = projectedPayoffLump(price, buy.financing);
            if (lump !== null) committed += lump;
          }
        }
      }
      /*
       * Scheduled mortgage payoffs from purchases that ALREADY happened. Two
       * sources, mirroring how the buys themselves are counted:
       *
       * - A lump firing THIS year (hres.mortgagePayoff). Unlike this year's
       *   purchase it has NOT left the balances — housing only schedules it,
       *   and the withdrawal solve pays it later this year — so it counts for
       *   the same reason this year's one-time expenses count.
       * - The HELD mortgage's payoff in a later bridge year, projected by
       *   running the actual loan state forward — the projection and the lump
       *   the engine will eventually charge are the same arithmetic
       *   (remainingBalanceAfterPayments wraps amortize's own loop).
       *
       * Future buys' payoffs were handled inside the loop above.
       */
      committed += hres.mortgagePayoff;
      const heldMort = housing.home?.mortgage ?? null;
      if (heldMort !== null && heldMort.payoffAfterMonths !== null) {
        const monthsToGo = heldMort.payoffAfterMonths - heldMort.monthsElapsed;
        // Housing already ran this year, so monthsElapsed is the end-of-year
        // count and the lump lands monthsToGo months into NEXT year.
        const lumpYi = yi + 1 + Math.floor(monthsToGo / 12);
        if (lumpYi < bridgeEndYi) {
          committed += remainingBalanceAfterPayments(
            heldMort.balance,
            heldMort.rate,
            heldMort.monthlyPayment,
            monthsToGo,
          );
        }
      }
      accessible = Math.max(0, accessible - committed);

      /*
       * FIX A — THE ELECTION RESPECTS THE CALENDAR (the 0.0% incident,
       * DECISIONS.md). The same committed-outflow arithmetic as the bridge
       * block above, but over the PROSPECTIVE LOCK WINDOW — the later of five
       * payments and 59 1/2, which can outlast the bridge — because a carve
       * sized only to the recurring need can swallow the principal a scheduled
       * house purchase was going to draw. Measured on the repro plan: a
       * $1.5M cash purchase in year 3 needed ~$950k from the IRA, the year-1
       * election had carved ~$1.3M of the $1.9M IRA into the locked series,
       * and the path was stamped insolvent holding $1.4M+ — the option that
       * exists to HELP scored the plan 0.0%.
       *
       * The rules the bridge block established are kept exactly: a
       * `sale_proceeds` CASH purchase is a residual claim, not a commitment,
       * and this year's own purchase already left the balances. One-off
       * expenses count for the same reason they count above — they are
       * scheduled, committed cash the remainder may have to produce.
       */
      const lockEndYi = Math.min(H - 1, forYear.lockThroughYear - ctx.startYear);
      let committedInLock = 0;
      /** Last committed PURCHASE year in the lock window (bounds the sale-projection walk). */
      let lastLockBuyYi: number | null = null;
      /** Last lock-window year carrying any committed outflow (drives the reserve's living term). */
      let lastCommitYi = yi;
      for (let by = yi; by <= lockEndYi; by++) {
        committedInLock += ctx.oneTimeExpense[by];
        if (ctx.oneTimeExpense[by] > 0) lastCommitYi = by;
        if (by === yi) continue; // this year's purchase already left the balances
        const buy = ctx.buyByYear[by];
        if (!buy) continue;
        if (buy.price === 'sale_proceeds' && buy.financing === 'cash') continue;
        const price = buy.price === 'sale_proceeds' ? saleProceeds : buy.price;
        committedInLock += buy.financing === 'cash' ? price : price * buy.financing.downPct;
        lastLockBuyYi = by;
        // Math.max, not plain assignment: a payoff counted below can already
        // have pushed the marker PAST this buy's year, and `by` only ascends
        // among the buys themselves. Identical arithmetic when no payoff
        // exists (ascending assignment IS the max).
        lastCommitYi = Math.max(lastCommitYi, by);
        // The buy's scheduled payoff inside the same lock window (Fix A must
        // see it: the lump is exactly the kind of committed draw the 0.0%
        // incident's carve swallowed the principal for).
        if (buy.financing !== 'cash' && buy.financing.payoffAfterYears !== undefined) {
          const lumpYi = by + buy.financing.payoffAfterYears;
          if (lumpYi <= lockEndYi) {
            const lump = projectedPayoffLump(price, buy.financing);
            if (lump !== null) {
              committedInLock += lump;
              lastCommitYi = Math.max(lastCommitYi, lumpYi);
            }
          }
        }
      }
      /*
       * Payoffs of mortgages already originated — this year's fired lump and
       * the held loan's scheduled one — mirror the bridge block above.
       *
       * Deliberately NOT extending `lastLockBuyYi`: that marker bounds the
       * sale-projection walk so a sale scheduled before a committed purchase
       * can fund it. A sale
       * before a scheduled PAYOFF does something different — it extinguishes
       * the loan at closing and the lump never fires at all. Modelling that
       * would SHRINK the reserve on a projection, and over-reserving is the
       * safe direction here (Fix B backstops a reserve that proves too small;
       * nothing backstops a carve that proves too large).
       */
      committedInLock += hres.mortgagePayoff;
      if (heldMort !== null && heldMort.payoffAfterMonths !== null) {
        const monthsToGo = heldMort.payoffAfterMonths - heldMort.monthsElapsed;
        const lumpYi = yi + 1 + Math.floor(monthsToGo / 12);
        if (lumpYi <= lockEndYi) {
          committedInLock += remainingBalanceAfterPayments(
            heldMort.balance,
            heldMort.rate,
            heldMort.monthlyPayment,
            monthsToGo,
          );
          lastCommitYi = Math.max(lastCommitYi, lumpYi);
        }
      }
      /*
       * A sale scheduled before a committed purchase funds it before the IRA
       * has to. Projected at TODAY's value net of selling costs and payoff —
       * no growth to the sale date, deliberately: the projection only ever
       * shrinks the reserve, and under-projecting is the safe direction
       * (Fix B backstops a reserve that proves too small; there is no
       * backstop for a carve that proves too large).
       *
       * THE WALK COVERS EVERY CYCLE UP TO THE LAST COMMITTED PURCHASE. With
       * one sell→buy cycle this is exactly the old single lookup: the first
       * scheduled sale of the CURRENT home, at its current value. With two —
       * the couple's move, then the widow's downsize — the second sale sells
       * the home the FIRST purchase bought, whose fixed price is known now,
       * so the walk carries a projected home state (value, payoff, selling
       * cost) through each sale and purchase in turn. Without that second
       * credit the reserve counts both purchases and only one sale, and the
       * election is declined for a gap the calendar itself pays. Sales after
       * the last committed purchase fund nothing the lock window still owes
       * and are not credited. A residual-priced ('sale_proceeds') purchase
       * has no stated price, so a home bought that way projects a $0 later
       * sale — under-projection, the safe direction again.
       */
      let projectedSaleNet = 0;
      if (lastLockBuyYi !== null && housing.home !== null) {
        let projValue: number = housing.home.value;
        let projPayoff: number = housing.home.mortgage?.balance ?? 0;
        let projSellPct: number = housing.home.sellingCostPct;
        for (let sy = yi + 1; sy <= lastLockBuyYi; sy++) {
          // Sale before purchase within a year — runHousingYear's own order.
          if (ctx.sellMonthByYear[sy] !== null && projValue > 0) {
            projectedSaleNet += Math.max(0, projValue * (1 - projSellPct) - projPayoff);
            projValue = 0;
            projPayoff = 0;
          }
          const buy = ctx.buyByYear[sy];
          if (buy && typeof buy.price === 'number') {
            projValue = buy.price;
            projPayoff = buy.financing === 'cash' ? 0 : buy.price * (1 - buy.financing.downPct);
            projSellPct = housing.defaultSellingCostPct;
          } else if (buy) {
            projValue = 0; // residual-priced: no stated value to project
            projPayoff = 0;
          }
        }
      }
      /*
       * What the committed outflows will need FROM THE IRA: whatever cash,
       * taxable and projected sale proceeds cannot cover. When this is
       * positive the cap block below reserves it — grossed up, and with the
       * living top-ups the cap itself creates — before sizing the payment.
       */
      const committedIraDraw = Math.max(0, committedInLock - accessibleRaw - projectedSaleNet);
      // A fully retired year: employer coverage is gone, so ACA fills every
      // month nobody is on Medicare.
      let retiredAcaMonths = 0;
      for (const m of medMonths) retiredAcaMonths = Math.max(retiredAcaMonths, 12 - m);
      // Pre-tax income already forced on the household this year: RMDs, plus
      // every series already paying — a spouse's, or one elected moments ago.
      // Without this, two spouses retiring together would each size their
      // series to the WHOLE household need and force out twice the cash.
      const forcedPretax: RetirementDistribution[] = [...rmdSlices];
      for (const st of seppState.values()) {
        if (!seppIsLive(st) || year < st.spec.eventYear || year > st.spec.lockThroughYear) continue;
        if (st.payment <= 0) continue;
        forcedPretax.push({
          personId: st.spec.owner,
          accountType:
            accounts.find((x) => x.id === st.lockedAccountId)?.type ?? 'traditional_ira',
          amount: st.payment,
          taxableAmount: st.payment,
          penaltyException: 'sepp_72t',
          penaltyBase: 0,
        });
      }
      const seppMaxForWholeAccount = seppAnnualPayment(
        srcBalance,
        plan.rate,
        plan.lifeExpectancy,
      );
      /*
       * What the household will actually give across the bridge.
       *
       * For every other rule that is ruleFullYear. A pot-paired growth tithe
       * is different: its base is the high-water mark, which starts empty on
       * retirement day, so in the election year ruleFullYear is structurally
       * 0 regardless of what the stream will actually pay later.
       *
       * Under an ACCRUING hold that 0 is correct for the hold itself: the
       * household genuinely gives nothing in cash then, and a series sized to
       * include giving would lock up more of the IRA than it needs. But a
       * short hold under a very early retirement leaves bridge years on the
       * far side of it, and pricing those at 0 under-sizes the payment for
       * the rest of the bridge — the payment is fixed once elected. Those
       * years are priced at the paycheck giving level, the household's own
       * revealed figure and the only one that exists before any growth
       * history does. Under a GIVE-CASH hold the stream pays from retirement
       * day, so ZERO zero-cash years — every bridge year is priced at the
       * paycheck level, for the same no-history-yet reason.
       */
      const bridgeCharitable =
        potGrowthStream !== null && pot !== null && forYear.bridgeYears > 0
          ? (charitablePaycheck *
              Math.max(0, plan.bridgeYears - (potAccrues ? pot.holdYears : 0))) /
            plan.bridgeYears
          : ruleFullYear;
      const target = estimateBridgeAnnualNeed(ctx, yi, {
        year,
        ages: taxAges,
        birthYears: taxBirthYears,
        filingStatus,
        idx,
        owner: plan.owner,
        // A FULLY RETIRED year's living and giving, not this year's prorated
        // figures: the estimator prices a full retired year (wages 0, ACA for
        // every non-Medicare month), and the payment it sizes is fixed for the
        // whole bridge. Using the prorated retirement-year numbers would hold
        // the series at the paycheck level of spending and giving for years
        // after the paychecks stopped — so a household that really does spend
        // or give less in retirement gets a smaller series, and less of its
        // IRA locked up.
        expensesFullYear: livingRetiredFullYear + bridgeCharitable + hres.totalCosts,
        charitable: bridgeCharitable,
        mortgageInterest: hres.mortgageInterest,
        propertyTax: hres.propertyTax,
        ssGross,
        taxableInterest,
        dividends,
        oneTimeIncome: oti.total,
        oneTimeTaxable: oti.taxable,
        // Likewise a full retired year's worth of retirement income.
        retirementIncomeFullYear: ctx.retirementIncomeMonthly * 12 * idx,
        acaBenchmarkAnnual: benchmark,
        acaMonths: retiredAcaMonths,
        medicare: medicareInput,
        bridgeDrawPerYear: accessible / forYear.bridgeYears,
        forcedPretax,
      });
      if (target <= 0) continue; // the bridge funds itself; elect nothing

      /*
       * Never put the whole IRA under the series. Sizing to the full projected
       * need drives the payment to the formula maximum, where fraction = 1 and
       * EVERY dollar is locked to a fixed annual payment — so any year the plan
       * needs more than that payment has nothing left to reach, and the path
       * goes insolvent holding a seven-figure IRA. Leaving a quarter of the
       * account outside the series is what makes the split technique worth
       * doing: the carve-out covers the recurring need, the remainder absorbs
       * the lumpy years (a new roof, a car, a bad market) at the ordinary 10%.
       * Measured on a representative profile: capping here scores ~42% versus
       * ~21% when the whole IRA is committed.
       */
      const cappedTarget = Math.min(target, seppMaxForWholeAccount * MAX_AUTO_SEPP_FRACTION);

      /*
       * FIX A, the cap itself. The un-carved remainder must be able to
       * PRODUCE the committed draws — as pre-59 1/2 IRA withdrawals, which do
       * not deliver face value — so the reserve has two terms, both grossed
       * up by 1 / (1 - penalty - marginal stand-in):
       *
       *   1. the net purchase gap `committedIraDraw`;
       *   2. the living top-ups the cap itself creates: a capped payment no
       *      longer covers the full-year need `target`, and while the cash is
       *      reserved for the purchase the difference comes out of the
       *      remainder too, for every year from the election through the last
       *      committed outflow (`n` years). Without this term the reserve was
       *      measured to run ~5% short on knife-edge fixtures — busting the
       *      very series the cap protected.
       *
       * The top-up depends on the payment and the payment on the principal,
       * but the amortization is LINEAR (payment = K x principal), so the
       * largest principal whose remainder still covers the reserve solves in
       * closed form:
       *
       *   B - P = g x gap + g x n x (target - K x P)
       *   P = (B - g x gap - g x n x target) / (1 - g x n x K)
       *
       * A non-positive P (or a degenerate denominator) means no series can
       * coexist with the calendar: the election is DECLINED this year and the
       * bridge re-offers it next year (the offer-every-bridge-year machinery
       * already exists) — by then the purchase may be behind, or the picture
       * may have changed.
       */
      let requestedAnnual = cappedTarget;
      let calendarCarveCap: PreparedSepp['calendarCarveCap'];
      if (committedIraDraw > 0) {
        const gross =
          1 / (1 - ctx.taxData.federal.earlyWithdrawalPenaltyRate - SEPP_RESERVE_MARGINAL_RATE);
        const n = lastCommitYi - yi + 1;
        const perDollar = seppAnnualPayment(1, plan.rate, forYear.lifeExpectancy);
        const denominator = 1 - gross * n * perDollar;
        const principalCap =
          denominator > 0
            ? (srcBalance - gross * committedIraDraw - gross * n * target) / denominator
            : 0;
        if (principalCap <= 0) {
          autoSeppDeclineNotes.push({
            label: 'Automatic 72(t) election DECLINED this year',
            note:
              `committed one-off outflows of ${committedInLock.toFixed(2)} inside the ` +
              `prospective lock window (through ${forYear.lockThroughYear}) exceed cash on ` +
              `hand plus projected sale proceeds (${(accessibleRaw + projectedSaleNet).toFixed(2)}), ` +
              'and the IRA draws producing the rest — grossed up for their own tax and penalty, ' +
              `plus the living the reserved cash can no longer carry — would take the whole ` +
              `${srcBalance.toFixed(2)} IRA. Any series elected now would lock money those ` +
              'outflows need; the election will be re-offered every remaining bridge year.',
          });
          continue;
        }
        const calendarMaxPayment = seppAnnualPayment(
          principalCap,
          plan.rate,
          forYear.lifeExpectancy,
        );
        if (calendarMaxPayment < requestedAnnual) {
          requestedAnnual = calendarMaxPayment;
          calendarCarveCap = {
            committedOutflows: committedInLock,
            nonIraFunding: accessibleRaw + projectedSaleNet,
            reservedRemainder: srcBalance - principalCap,
          };
        }
      }

      // Id for the carve-out, unique against every account this path holds and
      // every election already made.
      let seppAccountId = `${src.id}-sepp`;
      for (
        let n = 2;
        accounts.some((x) => x.id === seppAccountId) || seppState.has(seppAccountId);
        n++
      ) {
        seppAccountId = `${src.id}-sepp${n}`;
      }
      const spec: PreparedSepp = {
        automatic: true,
        accountId: src.id,
        accountName: src.name,
        seppAccountId,
        seppAccountName: `${src.name} (72(t) SEPP)`,
        owner: plan.owner,
        ownerAge: forYear.ownerAge,
        eventYear: year,
        rate: plan.rate,
        lifeExpectancy: forYear.lifeExpectancy,
        requestedAnnual,
        lockThroughYear: forYear.lockThroughYear,
        ...(calendarCarveCap !== undefined ? { calendarCarveCap } : {}),
      };
      electSepp(spec, accounts, drawn, seppState);
      for (let y = year; y <= forYear.lockThroughYear; y++) {
        const i = y - ctx.startYear;
        if (i >= 0 && i < H) autoActiveByYear[i].push(spec);
      }
      autoElectedOwners.add(plan.owner);
      autoElectedThisYear = true;
    }

    /*
     * --- 5c. Tithe Account carve-out (note 21) ---------------------------
     *
     * Retirement day. Split a second traditional IRA off the largest pre-tax
     * account the household can actually divide and open it with the one-time
     * catch-up on gains a tithe on gross pay never reached. Mechanically this
     * is electSepp's split (note 16) with a different reason: a balance moves
     * from one account to another, there is no cash leg, no distribution slice
     * and no tax input, which is precisely why a carve-out costs nothing while
     * funding a real giving account out of an IRA would cost tens of thousands
     * in tax and lost ACA credit.
     *
     * WHY HERE, after the 72(t) machinery and before `locked` is resolved: the
     * election must size itself against the undivided IRA (the tithe is not
     * the household's money and must not shrink the bridge that keeps the plan
     * solvent), and the carve-out must join `locked` in the very year it is
     * born or the withdrawal solve could spend it the same afternoon — spend,
     * not reach: through the soft window the solve gets it back deliberately,
     * as the account of last resort, never in the ordinary order. It also
     * lands after computeRmds, so the seed year's required distribution is
     * taken off the whole balance — no split to reason about at all.
     */
    let titheSeeded = 0;
    let titheBasisMissing = false;
    let titheSeedCapped = false;
    // A carve-out exists only when something can ever enter it: the seed, or
    // a hold that ACCRUES a growth tithe. A pot beside a non-growth ongoing
    // method (or a give-cash hold) with the seed off has nothing to hold —
    // opening an empty account would add tithe rows and flags to every year
    // for a balance that is structurally 0. For a migrated bundle this is the
    // old `seedFromExistingGains || deferYears > 0` exactly, because the
    // bundle always meant an accruing growth tithe.
    if (
      pot !== null &&
      titheHistory.firstRetiredYi === yi &&
      (pot.seedFromGains || (pot.holdYears > 0 && potAccrues))
    ) {
      // Anything under a 72(t) is untouchable: moving a dollar out of a SEPP
      // IRA is a distribution and retroactively penalizes the whole series.
      const seppLocked = new Set<string>();
      for (const st of seppState.values()) if (seppIsLive(st)) seppLocked.add(st.lockedAccountId);
      let parent: AccountState | undefined;
      let parentAvail = 0;
      for (const acc of accounts) {
        if (!isPretax(acc.type)) continue;
        if (acc.seppParentId !== undefined || seppLocked.has(acc.id)) continue;
        const avail = Math.max(0, acc.balance - (drawn.get(acc.id) ?? 0));
        // Strictly greater: ties keep the first account in profile order.
        if (parent === undefined || avail > parentAvail) {
          parent = acc;
          parentAvail = avail;
        }
      }
      // No divisible pre-tax account (every IRA locked under a full-account
      // 72(t), or none held at all) means no carve-out can exist. The rule
      // still gives cash in its disbursement phase; it simply never
      // accumulates. Documented limitation.
      if (parent !== undefined) {
        /*
         * THE UNTITHED BASE. Contributions arrived out of gross pay that was
         * already tithed the year it was earned, so only the excess over them
         * has never passed under a tithe. An account with no
         * `lifetimeContributions` is UNKNOWN, not zero: guessing would either
         * double-tithe a career of pay or leave decades of growth untithed, so
         * it contributes nothing and raises a flag instead.
         */
        let untithed = 0;
        if (pot.seedFromGains) {
          for (const acc of accounts) {
            if (!isRetirementWrapper(acc.type) || acc.balance <= 0) continue;
            // Never tithe the tithe. Only reachable if a future change lets a
            // second carve-out open; stated here so it can never be reached
            // by accident.
            if (acc.titheParentId !== undefined) continue;
            if (acc.lifetimeContributions === undefined) {
              titheBasisMissing = true;
              continue;
            }
            untithed += Math.max(0, acc.balance - acc.lifetimeContributions);
          }
        }
        // Capped at what the parent can actually give up net of this year's
        // forced distributions — the same `drawn` guard electSepp uses, so the
        // seed can never overdraw an account an RMD has already committed.
        //
        // The cap can BITE: the untithed base spans every retirement wrapper
        // including Roths, but the seed can only be carved out of this one
        // pre-tax parent, so a household whose gains sit mostly in a Roth asks
        // for more than the parent holds. That is a real answer (there is no
        // mechanism by which Roth dollars become traditional-IRA dollars), but
        // a SILENT one would report a tithe smaller than the rule promises with
        // nothing on screen to say why — so it is flagged like any other place
        // the engine could not do what was asked.
        // The pot's OWN percent sizes the seed — the split's whole point is
        // that the seed share and the ongoing growth tithe's share are now
        // independent knobs (a migrated bundle writes the same number into
        // both, which is what keeps the digests identical).
        const titheWanted = pot.percent * untithed;
        titheSeeded = Math.min(titheWanted, parentAvail);
        if (titheWanted - titheSeeded > 0.005) titheSeedCapped = true;
        // Id unique against every account this path holds, mirroring the
        // auto-72(t) `-sepp2`/`-sepp3` bump: two IRAs seeded in one year, or a
        // profile that already ships an account with this id, must not collide.
        let id = `${parent.id}${TITHE_ID_SUFFIX}`;
        for (let n = 2; accounts.some((x) => x.id === id); n++) {
          id = `${parent.id}${TITHE_ID_SUFFIX}${n}`;
        }
        accounts.push({
          id,
          name: `${parent.name} (Tithe Account)`,
          /*
           * Always a traditional IRA, never the parent's type. A 401(k) can be
           * the largest divisible pre-tax account (a spouse holding one who
           * never fires a `retire` event is counted as retired from year one
           * and so never rolls it over), but a 401(k) cannot be carved this way
           * and — the reason that matters here — a QCD may only be made from an
           * individual retirement plan under IRC 7701(a)(37), never from a
           * 401(k). Typing the carve-out as what it is documented to be keeps
           * the tax treatment of its eventual gift honest.
           */
          type: 'traditional_ira',
          owner: parent.owner,
          balance: titheSeeded,
          costBasis: 0,
          rothContributions: 0,
          rothConversions: [],
          // The pot's own mix when it names one, otherwise the parent's.
          allocation: { ...(pot.allocation ?? parent.allocation) },
          titheParentId: parent.id,
        });
        parent.balance -= titheSeeded;
        titheAccountId = id;
        titheParentId = parent.id;
      }
    }
    /*
     * The cumulative gain the mark rides starts at ZERO on retirement day, and
     * so does the mark — the seed has just settled every dollar earned before
     * this moment, so what the household owes from here is a share of what it
     * earns from here. Both counters simply begin at 0 and are only ever
     * advanced inside the year-end block below, which cannot run before this
     * year; there is nothing to initialise.
     *
     * (The balance-based mark this replaced DID need priming here, because a
     * peak left at 0 would have read the household's entire net worth as one
     * year's growth. A gain-based counter has no such failure mode.)
     */

    /*
     * --- 5d. Tithe Account: the pot's distribution instalment --------------
     *
     * From the lock year, the escrowed pot pays out over `distributeYears`:
     * this year's instalment is balance / years-remaining — the RMD's own
     * annuitisation, chosen over a flat pot/N because the pot keeps growing
     * while it distributes and a flat instalment would strand that growth in
     * the account forever. The instalment is a REAL IRA DISTRIBUTION: it
     * arrives as forced pre-tax income (taxable; penalized before the owner's
     * 59 1/2 year like any IRA draw, which an early release can genuinely
     * cause — conservative, and consistent with the documented no-QCD
     * simplification) and leaves the same year as a charitable gift, so the
     * cash identity closes exactly as it does for the carve-out's forced RMD.
     *
     * Net of `drawn`: the year's RMD already committed part of the carve-out
     * (and was itself given away above), so the instalment divides only what
     * is genuinely left — otherwise the same dollars would be distributed
     * twice. The schedule counts down on a calendar (see titheDistYearsLeft),
     * and after the final instalment the balance is exactly 0: only the
     * trailing-growth stream remains.
     *
     * Runs AFTER the seed block (5c) so a deferYears-0 rule can lock, seed
     * and pay its first instalment in the same retirement year, and BEFORE
     * the withdrawal solve so `charitable` is final when outflowFixed reads
     * it.
     */
    let titheDistributed = 0;
    let titheDistItems: RmdItem[] = [];
    if (titheLocked && titheAccountId !== null) {
      if (titheDistYearsLeft === null) titheDistYearsLeft = titheDistributeYears;
      if (titheDistYearsLeft > 0) {
        const pot = accounts.find((a) => a.id === titheAccountId);
        const avail = pot ? Math.max(0, pot.balance - (drawn.get(titheAccountId) ?? 0)) : 0;
        const instalment = avail / titheDistYearsLeft;
        if (pot && instalment > 0) {
          titheDistItems = [
            { accountId: titheAccountId, owner: pot.owner, accountType: pot.type, amount: instalment },
          ];
          drawn.set(titheAccountId, (drawn.get(titheAccountId) ?? 0) + instalment);
          titheDistributed = instalment;
          charitable += instalment;
        }
        titheDistYearsLeft -= 1;
      }
    }
    /** The instalment as a tax-input slice: ordinary income, owner's own penalty rules. */
    const titheDistSlices: RetirementDistribution[] = titheDistItems.map((item) => {
      const penaltyFree = year >= (owners.get(item.owner)?.penaltyFreeFromYear ?? -Infinity);
      return {
        personId: item.owner,
        accountType: item.accountType,
        amount: item.amount,
        taxableAmount: item.amount,
        penaltyException: penaltyFree ? 'age_59_5' : 'none',
        penaltyBase: penaltyFree ? 0 : item.amount,
      };
    });

    // Accounts under an active lock this year: resolved per path, because a
    // split moves the lock onto the carve-out (see PreparedSim.seppActiveByYear).
    // TWO DIFFERENT KINDS OF UNTOUCHABLE share this set, because the ordering
    // and Roth conversions treat them identically: a 72(t) SEPP IRA, where any
    // extra distribution busts the exception (Rev. Rul. 2002-62 §2.02(e)), and
    // a Tithe Account carve-out, which is a promise rather than a statute but
    // is just as firmly not FREELY available to pay for a retirement — through
    // the soft window the solve gets it back as the LAST-RESORT account (note
    // 21), and from the lock year not at all.
    const autoActive = autoActiveByYear[yi];
    const activeSepp =
      autoActive.length > 0 ? [...ctx.seppActiveByYear[yi], ...autoActive] : ctx.seppActiveByYear[yi];
    let locked: ReadonlySet<string> = NO_LOCKED_ACCOUNTS;
    if (activeSepp.length > 0 || titheAccountId !== null) {
      const ids = new Set<string>();
      for (const spec of activeSepp) {
        // A series ended by its owner's death locks nothing: the account is
        // the survivor's outright, and keeping them out of it for the rest of
        // an original five-year window would be a rule that no longer exists.
        // A BUSTED series locks nothing either, forever: the modification
        // ended the series (Rev. Rul. 2002-62 §2.02(e) — it does not resume),
        // the recapture was paid in the bust year, and the account is an
        // ordinary IRA from that day on.
        const st = seppState.get(spec.seppAccountId);
        if (st !== undefined && (st.terminated || st.busted)) continue;
        ids.add(st?.lockedAccountId ?? spec.accountId);
      }
      if (titheAccountId !== null) ids.add(titheAccountId);
      locked = ids;
    }
    // Every locked year draws the fixed payment whether or not it is needed —
    // exactly like an RMD (Rev. Rul. 2002-62: substantially equal periodic
    // payments). A series that runs its SEPP IRA dry simply stops.
    const seppItems: RmdItem[] = [];
    let seppTotal = 0;
    let seppDepletedThisYear = false;
    for (const spec of activeSepp) {
      const state = seppState.get(spec.seppAccountId);
      if (state === undefined || !seppIsLive(state)) {
        if (state?.depleted) seppDepletedThisYear = true;
        continue;
      }
      const accountId = state.lockedAccountId;
      const a = accounts.find((x) => x.id === accountId);
      const availableNow = a ? Math.max(0, a.balance - (drawn.get(accountId) ?? 0)) : 0;
      const amount = Math.min(state.payment, availableNow);
      if (amount + CONVERGE_TOLERANCE < state.payment) {
        state.depleted = true; // the SEPP IRA could not fund the full payment
        seppDepletedThisYear = true;
      }
      if (amount <= 0 || !a) continue;
      seppItems.push({ accountId, owner: a.owner, accountType: a.type, amount });
      seppTotal += amount;
      drawn.set(accountId, (drawn.get(accountId) ?? 0) + amount);
      // The recapture base a bust would read (Fix B): every payment the
      // series has actually made, year-stamped so interest can run from the
      // year each one left the account.
      state.paid.push({ year, amount });
    }
    const seppSlices = seppDistributions(seppItems);

    // --- 6. Withdrawal solve (fixed point) ---------------------------------
    const policy = ctx.policyByYear[yi];
    // `locked` (resolved above) is skipped by the ordering AND by Roth
    // conversions: any distribution beyond the fixed series busts the
    // exception. It covers only the SEPP IRA — a split election's remainder is
    // an ordinary IRA and stays available to both.
    const incomeCash =
      wagesNet +
      ssGross +
      retirementIncome +
      taxableInterest +
      dividends +
      oti.total +
      rmdTotal +
      seppTotal +
      // The pot's instalment is forced pre-tax cash exactly like an RMD; its
      // matching exit is already inside `charitable` (note 21, step 5d).
      titheDistributed;
    const outflowFixed =
      baseline +
      charitable +
      hres.totalCosts +
      oneTimeExp +
      hres.purchaseOutflow +
      // A scheduled mortgage payoff is a big cash need of THIS year, met the
      // same way the purchase itself was: the ordinary withdrawal order, taxed
      // draws, penalties where they apply — and, when even busting a 72(t)
      // cannot cover it, the ordinary shortfall path. Never a wall.
      hres.mortgagePayoff;

    /*
     * FIX B bookkeeping. A bust's recapture rides into the tax year as a
     * zero-amount distribution slice whose penaltyBase is the interest-grown
     * prior payments: the tax module's one early-withdrawal penalty rate
     * (data.earlyWithdrawalPenaltyRate, the same 10% the recapture statute
     * points back at) then charges exactly 10% x base inside taxes.penalties
     * and taxes.totalTax — so the recorded-cash identity picks the price up
     * through a term it already had, and no new YearRow field is needed.
     * Appended LAST in `distributions` so the SC per-person mapping's
     * first-appearance ordering is never disturbed (the busted owner already
     * appears via this year's own SEPP payment).
     */
    const bustRecaptureSlices: RetirementDistribution[] = [];
    const bustsThisYear: Array<{
      accountName: string;
      priorTotal: number;
      grownBase: number;
      recaptureTax: number;
      shortfallAtBust: number;
      lockedBalance: number;
    }> = [];

    const assemble = (planX: WithdrawalPlan, convSlicesX: ConversionSlice[]): TaxYearInputs => {
      let convTotal = 0;
      for (const c of convSlicesX) convTotal += c.amount;
      const distributions: RetirementDistribution[] = [
        ...rmdSlices,
        ...seppSlices,
        ...titheDistSlices,
      ];
      let rothTaxableEarnings = 0;
      for (const s of planX.slices) {
        if (s.bucket === 'pretax' || s.bucket === 'roth') {
          distributions.push({
            personId: s.owner,
            accountType: s.accountType,
            amount: s.amount,
            taxableAmount: s.taxableAmount,
            penaltyException: s.penaltyException,
            penaltyBase: s.penaltyBase,
          });
          if (s.bucket === 'roth') rothTaxableEarnings += s.taxableAmount;
        }
      }
      for (const d of conversionDistributions(convSlicesX)) distributions.push(d);
      for (const d of bustRecaptureSlices) distributions.push(d);
      return {
        year,
        filingStatus,
        state: ctx.residency[yi],
        birthYears: taxBirthYears,
        agesAtYearEnd: taxAges,
        wages: wagesNet,
        taxableInterest,
        ordinaryDividends: dividends,
        qualifiedDividends: dividends,
        pretaxDistributions:
          rmdTotal + seppTotal + titheDistributed + planX.byBucket.pretax + convTotal,
        rothConversionAmount: convTotal,
        ltcg: planX.realizedLtcg + hres.saleLtcg,
        socialSecurityGross: ssGross,
        distributions,
        taxExemptInterest: 0,
        // Taxable retirement income is plain ordinary income; when the profile
        // says it is not taxable it appears here as 0, so it raises neither AGI
        // nor any MAGI (ACA, IRMAA, NIIT) — it is only cash.
        otherOrdinaryIncome: oti.taxable + rothTaxableEarnings + retirementOrdinaryIncome,
        charitableGiving: charitable,
        itemizable: { mortgageInterest: hres.mortgageInterest, propertyTax: hres.propertyTax },
        aca: acaInput,
        medicare: medicareInput,
        inflationIndex: idx,
      };
    };

    /*
     * The soft window's one concession (note 21): the carve-out is handed to
     * the solve as the account of LAST RESORT — reachable only after every
     * bucket the policy names is dry, because a promise is the last money
     * touched. Null from the lock year on, when the escrow is absolute. It
     * stays inside `locked` too, so the ordinary pretax pass and Roth
     * conversions can never reach it mid-order in either phase.
     */
    const titheLastResort = titheAccountId !== null && !titheLocked ? titheAccountId : null;
    const convDirective = ctx.rothConv[yi];
    let plan = computeWithdrawalPlan(0, accounts, policy, year, owners, locked, drawn, titheLastResort);
    let convSlices: ConversionSlice[] = [];
    let prevConvTotal = 0;
    let converged = false;

    /*
     * FIX B — BUSTING THE SERIES IS A PRICE, NOT A WALL. The outer loop runs
     * the ordinary fixed point; only when the converged plan still cannot meet
     * the year's need (a shortfall after EVERY source the ordering may touch —
     * cash, taxable, unlocked pretax, Roth, and the tithe pot's last-resort
     * seat) while a live 72(t) series still locks real money does it bust that
     * series and re-solve. Ordering the bust dead last is deliberate: a
     * promise absorbed (the tithe seat) is cheaper than a recapture. A path
     * with no bustable series breaks out and fails honestly, exactly as
     * before — so a run that never busts walks a computation-for-computation
     * identical path and stays bit-identical.
     */
    for (;;) {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        // Roth conversion sizing (inside the loop's input assembly, SPEC §4.2).
        let convTotal = 0;
        if (convDirective) {
          const drawnNow = new Map(drawn);
          for (const s of plan.slices) {
            if (s.bucket === 'pretax') drawnNow.set(s.accountId, (drawnNow.get(s.accountId) ?? 0) + s.amount);
          }
          let requested = 0;
          if (convDirective.toBracketTop !== undefined) {
            const t0 = computeYear(assemble(plan, []), ctx.taxData);
            const top = bracketTopFor(
              bracketsFor(ctx.taxData.federal, filingStatus),
              convDirective.toBracketTop,
            );
            const headroom =
              top === null ? Infinity : top * idx - t0.federal.taxableOrdinaryIncome;
            requested = Math.max(0, headroom);
          } else {
            requested = convDirective.amount ?? 0;
          }
          convSlices = planRothConversion(accounts, drawnNow, requested, locked);
          for (const c of convSlices) convTotal += c.amount;
        }

        const taxes = computeYear(assemble(plan, convSlices), ctx.taxData);
        const health = (taxes.aca?.netPremium ?? 0) + (taxes.medicare?.total ?? 0);
        const cashNeed = outflowFixed + health + taxes.totalTax - incomeCash;
        const desired = Math.max(0, cashNeed);
        const newPlan = computeWithdrawalPlan(
          desired,
          accounts,
          policy,
          year,
          owners,
          locked,
          drawn,
          titheLastResort,
        );
        const done =
          Math.abs(newPlan.total - plan.total) < CONVERGE_TOLERANCE &&
          Math.abs(convTotal - prevConvTotal) < CONVERGE_TOLERANCE &&
          iter > 0;
        plan = newPlan;
        prevConvTotal = convTotal;
        if (done || (iter === 0 && newPlan.total === 0 && convTotal === 0 && desired === 0)) {
          converged = true;
          break;
        }
      }

      if (plan.shortfall <= CONVERGE_TOLERANCE) break; // the year is funded

      /*
       * Pick the series to bust: the live one whose locked account holds the
       * most reachable money. Most relief per recapture bill — one bust that
       * ends the shortfall beats two smaller ones, because every busted
       * series pays its own retroactive penalty. The loop comes back for a
       * second series only if the first was not enough.
       */
      let candidate: SeppRunState | null = null;
      let candidateAvail = 0;
      for (const st of seppState.values()) {
        if (!seppIsLive(st)) continue;
        const a = accounts.find((x) => x.id === st.lockedAccountId);
        const avail = a ? Math.max(0, a.balance - (drawn.get(st.lockedAccountId) ?? 0)) : 0;
        if (avail <= 0) continue;
        if (candidate === null || avail > candidateAvail) {
          candidate = st;
          candidateAvail = avail;
        }
      }
      if (candidate === null) break; // nothing left to bust: the path fails honestly
      // A const alias: `candidate` is a mutable binding, and TS will not carry
      // the null-narrowing into the account-lookup callback below without one.
      const busting = candidate;

      /*
       * THE RECAPTURE (IRC 72(t)(4)): busting retroactively applies the 10%
       * additional tax to every payment the series made BEFORE the owner's
       * penalty-free year — payments made at/after 59 1/2 were never
       * penalty-protected, so there is nothing to recapture on them — plus
       * interest. Interest is modelled simply and documented (ASSUMPTIONS.md):
       * each payment compounds at the path's own T-bill return from its
       * payment year to the bust year, the engine's one honest short rate.
       * The point is a real five-figure price, not an IRS §6601
       * reconstruction. The current-year busting draw itself is NOT special:
       * the lock lifts, the re-solve reaches the account as ordinary pretax,
       * and pretaxPenalty charges the ordinary 10% if the owner is still
       * under 59 1/2.
       */
      busting.busted = true;
      const pfYear =
        owners.get(busting.spec.owner)?.penaltyFreeFromYear ?? Number.POSITIVE_INFINITY;
      let priorTotal = 0;
      let grownBase = 0;
      for (const p of busting.paid) {
        priorTotal += p.amount;
        if (p.year >= pfYear) continue;
        let grown = p.amount;
        for (let y = p.year + 1; y <= year; y++) grown *= 1 + returns[y - ctx.startYear].bills;
        grownBase += grown;
      }
      const lockedAcct = accounts.find((x) => x.id === busting.lockedAccountId);
      bustRecaptureSlices.push({
        personId: busting.spec.owner,
        accountType: lockedAcct?.type ?? 'traditional_ira',
        amount: 0,
        taxableAmount: 0,
        penaltyException: 'none',
        penaltyBase: grownBase,
      });
      bustsThisYear.push({
        accountName: lockedAcct?.name ?? busting.spec.seppAccountName,
        priorTotal,
        grownBase,
        recaptureTax: ctx.taxData.federal.earlyWithdrawalPenaltyRate * grownBase,
        shortfallAtBust: plan.shortfall,
        lockedBalance: candidateAvail,
      });

      // The lock lifts NOW and forever: rebuild `locked` without the busted
      // series and run the whole fixed point again from a clean slate — the
      // recapture changed the tax bill, so every number downstream of it is
      // stale.
      const ids = new Set<string>();
      for (const spec of activeSepp) {
        const st = seppState.get(spec.seppAccountId);
        if (st !== undefined && (st.terminated || st.busted)) continue;
        ids.add(st?.lockedAccountId ?? spec.accountId);
      }
      if (titheAccountId !== null) ids.add(titheAccountId);
      locked = ids;
      plan = computeWithdrawalPlan(0, accounts, policy, year, owners, locked, drawn, titheLastResort);
      convSlices = [];
      prevConvTotal = 0;
      converged = false;
    }

    // --- 7. Final tax record (the converged iteration's computeYear) --------
    const taxes: TaxYearResult = computeYear(
      assemble(plan, convSlices),
      ctx.taxData,
      opts.trace ? { trace: true } : undefined,
    );
    // SPEC §7 auditability: on the traced (reference) path, a sale year's tax
    // trace carries the §121 home-sale walkthrough using the housing module's
    // actual numbers (the untraced Monte Carlo hot path allocates nothing).
    if (taxes.trace && hres.homeSold) {
      taxes.trace.push(
        { label: 'Home sale (§121 primary-residence exclusion)' },
        {
          label: 'Amount realized (sale price minus selling costs)',
          amount: hres.saleAmountRealized,
          indent: 1,
        },
        { label: 'Cost basis', amount: hres.saleCostBasis, indent: 1 },
        { label: 'Realized gain', amount: hres.saleGain, indent: 1 },
        {
          label: '§121 exclusion applied',
          amount: hres.saleExclusionUsed,
          indent: 1,
          // MFJ wording untouched: this fixture's digest is a before/after pin
          // on a path with no housing plan, and it must not move for a label.
          note:
            `up to ${homeSaleExclusionFor(
              ctx.taxData.federal,
              filingStatus,
              year,
              ctx.household.death?.year ?? null,
            ).toLocaleString('en-US')} ${filingStatus === 'single' ? 'single' : 'MFJ'}` +
            (filingStatus === 'single' &&
            ctx.household.death !== null &&
            year <= ctx.household.death.year + 2
              ? ' — but §121(b)(4) keeps the full joint exclusion for a surviving spouse selling within 2 years of the death, which this sale is'
              : ''),
        },
        {
          label: 'Taxable excess -> long-term capital gain',
          amount: hres.saleLtcg,
          indent: 1,
          note: 'included in the LTCG stacked on ordinary income above',
        },
      );
    }
    // Auditability for the payoff lump: the year a scheduled payoffAfterYears
    // fires, the traced path states the principal retired. The chip tooltip
    // reads the amount FROM THIS LINE (resultsData.mortgagePayoffInYear) — no
    // new YearRow field, the purchaseFunding convention, so every
    // absent-field row keeps its exact shape and the golden digests hold.
    if (taxes.trace && hres.mortgagePayoff > 0) {
      taxes.trace.push({
        label: 'Mortgage paid off early — remaining principal in one lump',
        amount: hres.mortgagePayoff,
        note:
          'scheduled N years after origination (payoffAfterYears); drawn through the ordinary ' +
          'withdrawal order — taxed, and penalized under 59 1/2 where a draw is penalizable. ' +
          'Interest, payments and any PMI stop from the payoff month; property tax, insurance ' +
          'and maintenance continue with the house',
      });
    }
    // SPEC §7 auditability, note 16: every year a 72(t) series pays, the trace
    // shows the payment and the amortization inputs behind it.
    if (taxes.trace && seppItems.length > 0) {
      const stateByLockedId = new Map<string, SeppRunState>();
      for (const st of seppState.values()) stateByLockedId.set(st.lockedAccountId, st);
      for (const item of seppItems) {
        const state = stateByLockedId.get(item.accountId);
        if (!state) continue;
        taxes.trace.push(
          {
            label: `72(t) SEPP distribution — ${state.spec.accountName}`,
            amount: item.amount,
            note:
              (state.spec.automatic
                ? `automatic bridge election, sized to the household's projected annual need at ${state.spec.eventYear} retirement: `
                : '') +
              'substantially equal periodic payment: forced whether or not the cash is needed, ' +
              `penalty exception sepp_72t, locked through ${state.spec.lockThroughYear}`,
          },
          {
            label: 'Method: fixed amortization, P = B x r / (1 - (1+r)^-N)',
            indent: 1,
          },
          {
            label: 'B — account balance at election',
            // With a split it is the CARVE-OUT that is amortized: its own
            // formula maximum is exactly the requested payment.
            amount: state.seppPrincipal,
            indent: 1,
            note:
              state.fraction < 1
                ? `SEPP IRA split out of ${state.balanceAtElection.toFixed(2)} in ` +
                  `${state.spec.accountName} at the ${state.spec.eventYear} election ` +
                  '(after any 401(k) rollover that year)'
                : `elected ${state.spec.eventYear} (after any 401(k) rollover that year)`,
          },
          {
            label: 'r — amortization interest rate',
            amount: state.spec.rate,
            indent: 1,
            note: 'Notice 2022-6 permits up to the greater of 5% or 120% of the federal mid-term AFR',
          },
          {
            label: `N — single life expectancy at age ${state.spec.ownerAge}`,
            amount: state.spec.lifeExpectancy,
            indent: 1,
            note: 'IRS Single Life Expectancy Table',
          },
          {
            label: 'Annual payment (fixed nominal for the whole term)',
            amount: state.payment,
            indent: 1,
            note:
              state.spec.requestedAnnual !== undefined
                ? `requested ${state.spec.requestedAnnual.toFixed(2)}, formula maximum ${state.maxPayment.toFixed(2)}`
                : `formula maximum ${state.maxPayment.toFixed(2)}`,
          },
        );
        if (state.fraction < 1) {
          taxes.trace.push({
            label: 'Split-IRA technique: remainder stays outside the series',
            amount: state.balanceAtElection - state.seppPrincipal,
            indent: 1,
            note:
              `${(state.fraction * 100).toFixed(2)}% of ${state.spec.accountName} was carved into ` +
              'the SEPP IRA; the rest remains an ordinary traditional IRA — freely withdrawable, ' +
              'and penalized before 59 1/2 like any other',
          });
        }
        // Fix-A auditability: the election year says when the carve was
        // capped by the calendar and why — otherwise a payment visibly below
        // the bridge need reads as a sizing bug rather than a decision.
        if (year === state.spec.eventYear && state.spec.calendarCarveCap !== undefined) {
          const cap = state.spec.calendarCarveCap;
          taxes.trace.push({
            label: 'Carve CAPPED by the calendar: committed outflows inside the lock window',
            amount: cap.reservedRemainder,
            indent: 1,
            note:
              `scheduled one-off outflows of ${cap.committedOutflows.toFixed(2)} fall inside ` +
              `the lock (through ${state.spec.lockThroughYear}); cash on hand plus projected ` +
              `sale proceeds cover ${cap.nonIraFunding.toFixed(2)}, so the un-carved remainder ` +
              `is reserved to produce the rest — grossed up for the tax and 10% penalty the ` +
              `draws will owe, plus the living the reserved cash can no longer carry. The ` +
              'payment above is the formula maximum of the smaller carve; locking more would ' +
              'leave the purchase facing a locked door',
          });
        }
      }
    }
    // Fix-A auditability, the other branch: an automatic election DECLINED
    // outright (honouring the cap left no positive payment) says so in the
    // year it happened; the bridge re-offers next year.
    if (taxes.trace && autoSeppDeclineNotes.length > 0) {
      for (const n of autoSeppDeclineNotes) taxes.trace.push(n);
    }
    /*
     * FIX B auditability: a busted series is the single most expensive thing
     * the engine can decide to do on the household's behalf, so the year it
     * happens must show what it cost and why it was still the right call —
     * the alternative the wall used to pick was failing the path while the
     * money sat there.
     */
    if (taxes.trace && bustsThisYear.length > 0) {
      for (const b of bustsThisYear) {
        taxes.trace.push(
          {
            label: `72(t) series BUSTED — ${b.accountName}`,
            amount: b.recaptureTax,
            note:
              `the year's need was ${b.shortfallAtBust.toFixed(2)} short after every account ` +
              `the ordering may touch (the tithe last-resort seat included) while this locked ` +
              `account held ${b.lockedBalance.toFixed(2)}. The lock lifts permanently — a ` +
              'modified series does not resume (Rev. Rul. 2002-62 §2.02(e)) — the draw ' +
              'proceeds as an ordinary IRA distribution (penalized before 59 1/2 like any ' +
              'other), and the recapture below is charged this year',
          },
          {
            label: 'Prior series distributions (all years, nominal)',
            amount: b.priorTotal,
            indent: 1,
            note: 'only pre-59 1/2 payments are recaptured — later ones were never penalty-protected',
          },
          {
            label: 'Recapture base: pre-59 1/2 payments + interest',
            amount: b.grownBase,
            indent: 1,
            note:
              'each payment compounded at the path’s own T-bill return from its payment year ' +
              'to this one (documented simplification of §6601 interest)',
          },
          {
            label: 'IRC 72(t)(4) recapture — 10% additional tax due this year',
            amount: b.recaptureTax,
            indent: 1,
            note: 'included in the early-withdrawal penalty line above',
          },
        );
      }
    }
    /*
     * Note 22 auditability. A guardrails year that cut spending looks, in the
     * baseline column alone, exactly like a year the user mis-typed a number.
     * The rate, the rail it crossed and the resulting factor are what turn it
     * back into a decision they can check — including in the years the rule
     * deliberately did nothing, which is the behaviour it exists for.
     */
    if (taxes.trace && guardrails !== null && guardInitialRate !== null) {
      taxes.trace.push({
        label: 'Spending policy — guardrails (Guyton-Klinger)',
        note:
          `withdrawal rate ${(guardrailRate * 100).toFixed(2)}% against an opening ` +
          `${(guardInitialRate * 100).toFixed(2)}%; rails at ` +
          `${(guardInitialRate * guardrails.lower * 100).toFixed(2)}%-` +
          `${(guardInitialRate * guardrails.upper * 100).toFixed(2)}%`,
      });
      taxes.trace.push({
        label:
          guardrailMoved === null
            ? 'Inside the band — real spending unchanged'
            : guardrailMoved === 'cut'
              ? `Upper rail breached — spending cut ${(guardrails.adjustment * 100).toFixed(0)}%`
              : `Lower rail breached — spending raised ${(guardrails.adjustment * 100).toFixed(0)}%`,
        amount: livingGoverned,
        indent: 1,
        note:
          `cumulative factor ${guardFactor.toFixed(4)} on the plan's original real spending` +
          (guardFactor <= guardFloor
            ? `, held at the ${(guardFloor * 100).toFixed(0)}% floor`
            : '') +
          // Ceiling clause only for a plan that HAS one: for everyone else the
          // guard is false on every year and the note is byte-identical.
          (guardrails.raiseCeiling !== undefined && guardFactor >= guardrails.raiseCeiling
            ? `, capped at the ${(guardrails.raiseCeiling * 100).toFixed(0)}% ceiling`
            : ''),
      });
    }
    // Note 18 auditability: any year the retirement giving rule governs (whole
    // or part) states the rule, the base it read, and the arithmetic — the
    // owner must be able to see why a year's giving was what it was.
    if (taxes.trace && givingRuleMonths > 0 && givingRule.type !== 'continue') {
      taxes.trace.push({
        label: `Charitable giving — retirement rule: ${givingRuleLabel(givingRule, pot)}`,
        amount: charitable,
        note:
          'the paycheck giving stream ends with the last salary; this rule replaces it ' +
          '(it still feeds the charitable deductions above)',
      });
      if (givingRule.type === 'amount') {
        // A plain figure needs no base: state the monthly amount in today's
        // dollars and what CPI made of it this year.
        taxes.trace.push({
          label: `Rule amount for a full year — ${givingRule.monthly.toLocaleString('en-US')}/month in 2026 dollars`,
          amount: ruleFullYear,
          indent: 1,
          note: `${givingRule.monthly.toFixed(2)} x 12 x ${idx.toFixed(6)} (cumulative CPI)`,
        });
      } else if (potGrowthStream !== null && pot !== null) {
        // Note 21: a pot-paired growth tithe's base is a high-water mark on
        // the REAL spendable portfolio, so the trace has to say both what the
        // mark was and why a year with plenty of growth can still give
        // nothing. Only an ACCRUING hold has silent years — a give-cash hold
        // pays on the mark's base from retirement day and traces like any
        // other percentage year.
        const retiredYears = yi - (titheHistory.firstRetiredYi ?? yi);
        if (potAccrues && !titheLocked) {
          taxes.trace.push({
            label: `Deferred — retired year ${retiredYears + 1} of up to ${pot.holdYears}`,
            amount: 0,
            indent: 1,
            note:
              'no cash giving through the soft window by design: the tithe accumulates inside ' +
              'the carve-out instead — which still counts as spendable, reachable after every ' +
              'other account — and cash starts when the window closes: after ' +
              `${pot.holdYears} retired ${pot.holdYears === 1 ? 'year' : 'years'}` +
              (pot.earlyRelease
                ? ', or the year after the plan first sets a new real spendable high'
                : ''),
          });
        } else {
          const base = retirementGivingBase(givingRule, yi, NO_HISTORY, NO_HISTORY, titheHistory);
          taxes.trace.push({
            label: `Base — ${year - 1} growth above the portfolio's previous real high`,
            amount: base * idx,
            indent: 1,
            note:
              'high-water mark on the SPENDABLE portfolio in real dollars (the carve-out is ' +
              'excluded — the tithe is never tithed): a portfolio that fell and recovered ' +
              're-earned ground already tithed on the way up, so it owes nothing until it is ' +
              `genuinely higher than it has ever been. ${base.toFixed(2)} in 2026 dollars`,
          });
          taxes.trace.push({
            // potGrowthStream IS givingRule here (the branch requires the
            // pairing), spelled this way because TS cannot narrow givingRule
            // off a condition about a different variable.
            label: `Rule amount for a full year — ${(potGrowthStream.percent * 100).toFixed(2)}% of the base`,
            amount: ruleFullYear,
            indent: 1,
            note: 'a year that set no new real high gives 0 — the rule never claws money back',
          });
        }
      } else if (givingRule.type !== 'none') {
        const smoothing =
          givingRule.type === 'percent_of_growth'
            ? Math.min(Math.max(1, Math.floor(givingRule.smoothingYears ?? 1)), yi)
            : Math.min(1, yi);
        const base = retirementGivingBase(givingRule, yi, realGrowthByYear, givingIncomeByYear);
        const growthBased = givingRule.type === 'percent_of_growth';
        const baseLabel =
          smoothing <= 0
            ? 'Base — none: no completed year precedes the first simulated year'
            : growthBased
              ? smoothing > 1
                ? `Base — mean real portfolio growth, ${year - smoothing}-${year - 1} (${smoothing} years)`
                : `Base — ${year - 1} real portfolio growth`
              : `Base — ${year - 1} Social Security + gross withdrawals`;
        taxes.trace.push({
          label: baseLabel,
          amount: base,
          indent: 1,
          note: growthBased
            ? 'nominal investment gain minus inflation on the start-of-year balance; ' +
              'the PRIOR year, because this year’s growth depends on this year’s giving'
            : 'the PRIOR year, because this year’s withdrawals depend on this year’s giving',
        });
        taxes.trace.push({
          label: `Rule amount for a full year — ${(givingRule.percent * 100).toFixed(2)}% of the base`,
          amount: ruleFullYear,
          indent: 1,
          note:
            givingRule.type === 'percent_of_growth' && givingRule.capMonthly !== undefined
              ? `capped at ${givingRule.capMonthly.toLocaleString('en-US')}/month in 2026 dollars ` +
                `(${(givingRule.capMonthly * 12 * idx).toFixed(2)} this year); a negative base gives 0`
              : 'a negative base gives 0 — the rule never produces a negative gift',
        });
      }
      if (givingRuleMonths < 12) {
        taxes.trace.push({
          label: `Retirement year — prorated ${12 - givingRuleMonths} months of paycheck giving + ${givingRuleMonths} months of the rule`,
          amount: charitable,
          indent: 1,
          note: `paycheck stream ${charitablePaycheck.toFixed(2)}/yr, rule ${ruleFullYear.toFixed(2)}/yr`,
        });
      }
    }
    // Note 21 auditability: the seed is the single largest number this feature
    // produces and it appears out of nowhere in one year, so the year it fires
    // has to show where it came from — including when it came to nothing
    // because the contribution history was missing.
    if (taxes.trace && titheAccountId !== null && titheHistory.firstRetiredYi === yi) {
      taxes.trace.push({
        label: `Tithe Account opened — carve-out inside ${titheParentId}`,
        amount: titheSeeded,
        note:
          pot?.seedFromGains === true
            ? `${((pot?.percent ?? 0) * 100).toFixed(2)}% of untithed gains ` +
              '(pre-tax + Roth balances above lifetime contributions). An INTERNAL SPLIT: no ' +
              'distribution, no tax, no cash — the balance is a label on money still inside the IRA'
            : 'opened empty: this plan tithes only what the portfolio earns from here on',
      });
      if (titheBasisMissing) {
        taxes.trace.push({
          label: 'Some accounts had no lifetime-contribution figure',
          indent: 1,
          note:
            'their untithed base was counted as 0 rather than guessed — contributed dollars came ' +
            'out of already-tithed gross pay, and without the figure the engine cannot tell ' +
            'tithed principal from untithed growth. The seed is understated until it is supplied',
        });
      }
      if (titheSeedCapped) {
        taxes.trace.push({
          label: 'Seed capped by the parent account balance',
          indent: 1,
          note:
            'the untithed base spans every retirement account including Roths, but the carve-out ' +
            'can only come out of one pre-tax IRA — and that IRA did not hold the whole amount. ' +
            'The rest stays untithed in the accounts it sits in; there is no way to move Roth ' +
            'money into a traditional IRA',
        });
      }
    }
    if (taxes.trace && titheForcedGift > 0) {
      taxes.trace.push({
        label: 'Tithe Account — required minimum distribution, given away',
        amount: titheForcedGift,
        note:
          'the IRS sees one IRA and the RMD runs off the whole balance, carve-out included. ' +
          'Those dollars cannot go back in and are not the household’s to spend, so they are ' +
          'given in cash this year (in practice, a qualified charitable distribution, which also ' +
          'satisfies the RMD). Included in the charitable giving above',
      });
    }
    /*
     * What the withdrawal ordering took out of the carve-out as a LAST RESORT
     * this year. Soft window only — `titheLastResort` is null once locked, so
     * this is structurally 0 from the lock year on. Computed here (the plan is
     * final) for the trace, the flag and the row's tithe block below.
     */
    let titheDrawn = 0;
    if (titheAccountId !== null) {
      for (const s of plan.slices) if (s.accountId === titheAccountId) titheDrawn += s.amount;
    }
    // Note 21 auditability: the three tithe events a reader cannot infer from
    // the totals — the window closing, an instalment of the pot, and the
    // promise absorbing an emergency — each say so in the year they happen.
    if (taxes.trace && pot !== null && titheHistory.lockYi === yi) {
      const early =
        titheHistory.firstRetiredYi !== null &&
        yi < titheHistory.firstRetiredYi + pot.holdYears;
      // The escrowed balance as of the lock: the account now, net of what
      // this year's forced distributions have already committed. (`titheEnd`
      // does not exist yet — growth has not been applied.)
      const escrowNow =
        titheAccountId === null
          ? 0
          : Math.max(
              0,
              (accounts.find((a) => a.id === titheAccountId)?.balance ?? 0) -
                (drawn.get(titheAccountId) ?? 0),
            );
      taxes.trace.push({
        label: 'Tithe Account — locked: distribution starts',
        amount: escrowNow,
        note:
          (early
            ? 'SAFE-ZONE RELEASE: the plan closed last year above the spendable real balance it ' +
              'held at the end of the first retired year, so the fragile window the deferral ' +
              'protects is over and the gift is released early. '
            : 'the defer window has run its course. ') +
          'From this year the carve-out is charity money in escrow — out of spendable assets, ' +
          `out of the success metric, untouchable — and pays out over ${titheDistributeYears} ` +
          `${titheDistributeYears === 1 ? 'year' : 'years'}`,
      });
    }
    if (taxes.trace && titheDistributed > 0 && titheDistYearsLeft !== null) {
      taxes.trace.push({
        label:
          `Tithe Account — pot distribution ${titheDistributeYears - titheDistYearsLeft} of ` +
          `${titheDistributeYears}, given away`,
        amount: titheDistributed,
        note:
          'balance over years remaining, so growth earned mid-distribution is given too and the ' +
          'pot is exactly empty on schedule. A real IRA distribution: ordinary income this year, ' +
          'and included in the charitable giving above',
      });
    }
    if (taxes.trace && titheDrawn > 0) {
      taxes.trace.push({
        label: 'Tithe Account — drawn as a LAST RESORT',
        amount: titheDrawn,
        note:
          'every other account the withdrawal order names ran dry first. The promise absorbed ' +
          'the emergency — this is the break-glass behaviour made automatic — and the pot is ' +
          'permanently smaller: nothing pays it back',
      });
    }
    // The widow score's own audit trail. A reader looking at a survivor year
    // needs to be told, in the year it happens, that the household changed —
    // otherwise the only visible symptom is a tax bill that does not match the
    // withdrawals, and there is nothing on the row to explain it.
    if (taxes.trace && death !== null && year >= death.year) {
      if (year === death.year) {
        taxes.trace.push(
          {
            label: `Death of ${death.personId} (${death.ym.year}-${String(death.ym.month).padStart(2, '0')}) — last joint return`,
            note:
              'The year of death is the LAST year a joint return is possible (IRC 6013(a)(3)); ' +
              'from next year she files SINGLE, with no qualifying-surviving-spouse grace period ' +
              '(IRC 2(a)(1)(B) requires a dependent child). His accounts pass to her by spousal ' +
              'rollover — his IRA becomes HER IRA on her own RMD schedule, not an inherited one ' +
              'on the 10-year rule — taxable holdings take a basis step-up (IRC 1014), and any ' +
              '72(t) series of his ends with him.',
          },
          {
            label: 'Life-insurance death benefit (not taxable income)',
            amount: lifeBenefit,
            indent: 1,
            note:
              lifeBenefit > 0
                ? 'IRC 101(a)(1) excludes it from gross income entirely — no cap, no filing-status ' +
                  'condition — so it raises neither AGI nor any MAGI: no ACA cliff, no IRMAA tier, ' +
                  'no NIIT, and no effect on how much of her Social Security is taxable. It lands ' +
                  'in savings as a balance, which is what a cheque from an insurer is'
                : 'none in force at the date of death',
          },
          {
            label: 'Social Security lump-sum death payment',
            amount: ssLumpSum,
            indent: 1,
            note: 'statutory $255, unindexed since the 1981 amendments',
          },
        );
      } else {
        taxes.trace.push({
          label: `Survivor year — filing SINGLE, ${taxIdx.length} in the household`,
          note:
            `${death.personId} died in ${death.year}. The same income is now taxed on roughly half ` +
            'the standard deduction, through brackets that compress far faster, with Social ' +
            'Security taxable from $25,000/$34,000 of provisional income instead of ' +
            '$32,000/$44,000, NIIT from $200,000 instead of $250,000, single-filer IRMAA tiers, ' +
            'and a one-person federal poverty level for the ACA credit. Practitioners call it the ' +
            'widow penalty; it is the reason this run is not the household run with one fewer ' +
            'mouth to feed.',
        });
      }
    }
    const health = (taxes.aca?.netPremium ?? 0) + (taxes.medicare?.total ?? 0);
    const cashNeed = outflowFixed + health + taxes.totalTax - incomeCash;
    const desired = Math.max(0, cashNeed);
    const finalShortfall = Math.max(plan.shortfall, desired - plan.total);
    magiHist[yi] = taxes.magi.irmaaMagi;

    // --- 8. Apply flows, invest, sweep surplus, grow -----------------------
    applyRmds(accounts, rmds);
    applyRmds(accounts, seppItems); // same shape: forced pre-tax distributions
    applyRmds(accounts, titheDistItems); // the pot's instalment (note 21, step 5d)
    applyWithdrawalPlan(accounts, plan);
    applyRothConversion(accounts, convSlices, year);
    let convTotal = 0;
    for (const c of convSlices) convTotal += c.amount;
    for (const c of ctx.household.contribByYear[yi]) {
      // In a rollover year the deferral/match follow the money into the IRA
      // (they were earned in the worked months before separation).
      const acct = accounts.find((a) => a.id === (rolledTo.get(c.accountId) ?? c.accountId));
      if (acct) {
        acct.balance += c.amount; // contributions added before growth
        /*
         * The contribution history has to keep up with the contributions, or
         * the tithe rule counts the household's own future paychecks as
         * untithed growth and asks it to give on them a second time. Only the
         * EMPLOYEE DEFERRAL joins: it came out of gross pay the household
         * already gave on. The employer match deliberately does not — it was
         * never in anyone's gross, so it belongs in the untithed remainder,
         * which is exactly where leaving it out of this number puts it.
         *
         * An ABSENT history is left absent. Adding to it would silently turn
         * "I do not know what I put in" into a confident small number, and the
         * seed would then treat a whole career as untithed gain.
         */
        if (acct.lifetimeContributions !== undefined && c.deferral > 0) {
          acct.lifetimeContributions += c.deferral;
        }
      }
    }
    // Insolvency = THIS YEAR'S cash need could not be met from the accessible
    // buckets. It is emphatically NOT "the portfolio evaporated": the plan
    // already drained everything the ordering could reach, and whatever it
    // could not reach (a locked 72(t) SEPP IRA, an illiquid balance) is real
    // money that keeps existing — in balances.byAccount, in the fan, and in the
    // terminal value. Only the success metric treats the path as failed, via
    // insolvencyYear.
    const insolventNow = finalShortfall > CONVERGE_TOLERANCE;
    if (insolventNow && insolvencyYear === null) insolvencyYear = year;
    let investing = 0;
    /** Leftover a WORKING year consumed rather than accumulated (note 20). */
    let unbudgeted = 0;
    /** Note 24a: the slice of `investing` that went to savings, not the brokerage. */
    let investingToSavings = 0;
    /** Note 24b: the renting column's living reduction, parked in savings. */
    let bankedLivingReduction = 0;
    // A shortfall makes this negative by construction, so a year that could not
    // meet its need never sweeps (or consumes) anything: the withdrawal
    // machinery already ran and covered what it could.
    const surplus = incomeCash + plan.total - (outflowFixed + health + taxes.totalTax);
    if (surplus > 0) {
      // Investing stream (notes 12 and 19): move up to
      // investingMonthly x worked months (investing stops at retirement —
      // the app's standing rule), x CPI, into the first taxable brokerage —
      // balance AND basis, since cash entering a brokerage is basis. Capped at
      // the surplus, so it can never force a withdrawal: the household
      // invests only what its income, forced
      // distributions and Social Security actually left over. With no
      // brokerage account it simply doesn't happen (documented limitation).
      //
      // While working this is now the ONLY thing that accumulates — the
      // household is taken at its word about what it invests.
      //
      // NOTE 24a — BETWEEN SALE AND PURCHASE the in-window share of the
      // stream is REDIRECTED TO SAVINGS: money for an imminent purchase must
      // not be in stocks, and a transfer the household keeps making while
      // between homes is purchase money by intent. Month-prorated via
      // investingWindowRealByYear (0 in every run without a window, which is
      // what keeps this whole branch float-inert there: cap = want,
      // toSavings = 0, toBrokerage = investing - 0 = investing exactly). The
      // savings-bound share also no longer needs a brokerage to exist — cash
      // can always be parked — while the out-of-window share keeps the old
      // brokerage-or-nothing rule.
      const want = ctx.household.investingRealByYear[yi] * idx;
      if (want > 0) {
        const wantInWindow = ctx.investingWindowRealByYear[yi] * idx;
        const brokerage = accounts.find((a) => a.type === 'taxable_brokerage');
        const cap = brokerage ? want : Math.min(want, wantInWindow);
        investing = Math.min(cap, surplus);
        investingToSavings = Math.min(investing, wantInWindow);
        const toBrokerage = investing - investingToSavings;
        if (investingToSavings > 0) addToSavings(accounts, investingToSavings, people[0].id);
        if (toBrokerage > 0 && brokerage) {
          brokerage.balance += toBrokerage;
          brokerage.costBasis += toBrokerage;
        }
      }
      let leftover = surplus - investing;
      // NOTE 24b — the living money the renting column freed is BANKED, not
      // left to the leftover rules below: without this, the reduction would be
      // consumed as unbudgeted spending in a working year (note 20) and the
      // whole point of typing a renting column — cash accumulating toward the
      // purchase — would never materialise. Capped at the leftover actually
      // in hand: taxes or a thin year can eat the reduction, and banking money
      // that is not there would manufacture cash. Applies in retired window
      // years too (a forced distribution's leftover is parked, not bought back
      // into stocks) — one rule for the whole window, purchase pending.
      if (livingRentingBankWant > 0 && leftover > 0) {
        bankedLivingReduction = Math.min(livingRentingBankWant, leftover);
        addToSavings(accounts, bankedLivingReduction, people[0].id);
        leftover -= bankedLivingReduction;
      }
      // NOTE 20 — the working/retired switch, on the SAME signal every paired
      // stream uses (household.employerMonthsByYear). See the module header for
      // the reasoning and for why the RETIREMENT YEAR (0 < worked < 12) follows
      // the WORKING rule in full instead of being prorated: a surplus is one
      // undifferentiated pool of year-end cash, not a per-month flow, so there
      // is nothing meaningful to prorate.
      if (workedMonthsHh > 0) {
        // Someone earned a salary this year. The leftover is CONSUMED — the
        // irregular costs livingMonthly's budget baseline does not carry. It
        // enters no account and appears in no balance; recording it here is
        // what keeps the cash identity exact.
        unbudgeted = leftover;
      } else {
        // Nobody earned. The solve took only what the year needed, so this can
        // only be a forced distribution (RMD / 72(t)) the year did not need:
        // REINVESTED in the brokerage, balance and basis — see sweepSurplus.
        sweepSurplus(accounts, leftover, people[0].id);
      }
    }
    // Note 24: the funding story's banked lines (both 0 outside the window).
    if (bh !== null && yi <= bh.buyYi) {
      fundBankedInvesting += investingToSavings;
      fundBankedLiving += bankedLivingReduction;
    }
    /*
     * Note 24: the funding story, closed at the end of the buy year — after
     * the year's banking above, whose in-window months all precede the buy
     * month by construction. `totalCash` is BY DEFINITION the sum of its five
     * components (the Housing card's readout and its summing test rely on
     * that); `cashOutflow` is the engine's actual closing figure, so the
     * surplus/shortfall line can never disagree with the simulation.
     */
    if (bh !== null && yi === bh.buyYi) {
      const buy = ctx.buyByYear[yi];
      const financing: 'cash' | 'mortgage' =
        buy !== null && buy.financing !== 'cash' ? 'mortgage' : 'cash';
      let price = 0;
      if (buy !== null) {
        if (typeof buy.price === 'number') price = buy.price;
        else if (buy.financing === 'cash') {
          // A residual cash purchase's resolved price IS its outflow.
          price = hres.purchaseOutflow;
        } else {
          // Residual + financed: the outflow is the down payment, so the
          // resolved price is outflow / downPct. A 0% down payment leaves the
          // price unrecoverable from the outflow; 0 is the honest "unknown".
          price = buy.financing.downPct > 0 ? hres.purchaseOutflow / buy.financing.downPct : 0;
        }
      }
      const totalCash =
        fundPreSavings + fundProceeds + fundBankedInvesting + fundBankedLiving + fundInterest;
      purchaseFunding = {
        sellDate: `${bh.sellYear}-${String(bh.sellMonth).padStart(2, '0')}`,
        buyDate: `${bh.buyYear}-${String(bh.buyMonth).padStart(2, '0')}`,
        windowMonths: bh.windowMonths,
        preExistingSavings: fundPreSavings,
        netSaleProceeds: fundProceeds,
        bankedInvesting: fundBankedInvesting,
        bankedLivingReduction: fundBankedLiving,
        interestEarned: fundInterest,
        totalCash,
        purchasePrice: price,
        cashOutflow: hres.purchaseOutflow,
        financing,
        surplus: totalCash - hres.purchaseOutflow,
      };
    }
    // The year's NOMINAL investment gain: everything the portfolio earned,
    // whether it was distributed as cash (savings interest, brokerage
    // dividends and bond/bill sleeve interest — all counted in income above)
    // or compounded into balances below. Contributions, withdrawals, surplus
    // sweeps and rollovers move money; they are not gains and never enter it.
    // It is the raw material for the giving rule's real-growth base (note 18).
    let nominalGain = taxableInterest + dividends;
    // The carve-out's own gain, kept apart: the tithe base must never include
    // growth on money already promised away, or the household tithes the tithe.
    let titheNominalGain = 0;
    for (const a of accounts) {
      if (a.balance <= 0) continue;
      if (a.type === 'savings') continue; // interest was distributed, not compounded
      let g: number;
      if (a.type === 'taxable_brokerage') {
        // Stocks grow at total return minus the distributed dividend yield;
        // bond/bill sleeves are price-flat (their return was distributed).
        g = a.allocation.stocks * (r.stocks - divYield);
      } else {
        g =
          a.allocation.stocks * r.stocks +
          a.allocation.bonds * r.bonds +
          a.allocation.bills * r.bills;
      }
      const gain = a.balance * g;
      a.balance += gain;
      nominalGain += gain;
      if (a.id === titheAccountId) titheNominalGain = gain;
    }
    // Histories the giving rule reads NEXT year (note 18): real growth is the
    // nominal gain net of this year's inflation on the START-OF-YEAR balance,
    // and the income base is Social Security + this year's gross withdrawals.
    realGrowthByYear[yi] = nominalGain - totalStart * r.cpi;
    /*
     * NEVER TITHE THE TITHE, income edition. The pot's own cash flows are
     * excluded from the percent_of_income base: the distribution instalment
     * is not added, and the carve-out's forced RMD (inside rmdTotal) is
     * backed out. Both are dollars that pass straight through to charity —
     * counting them as "income drawn" would tithe money that was already the
     * gift. Structurally a no-op for every pre-split plan: titheForcedGift is
     * non-zero only when a pot exists, and under the bundled rule a pot and
     * the income rule could never coexist, so no pinned digest can move.
     */
    givingIncomeByYear[yi] =
      ssGross +
      plan.byBucket.cash +
      plan.byBucket.taxable +
      plan.byBucket.pretax +
      rmdTotal -
      titheForcedGift +
      seppTotal +
      plan.byBucket.roth;

    /*
     * --- 8b. Tithe Account: high-water mark, then the year's accrual -------
     *
     * This is the only point in the year where both facts are known: the
     * year's growth has been applied and every cash flow has settled, so the
     * spendable portfolio is final. The transfer below is intra-portfolio and
     * so cannot disturb anything already recorded — one IRA balance falls, the
     * carve-out rises, `totalEnd` is untouched.
     */
    let totalEnd = 0;
    let titheEnd = 0;
    for (const a of accounts) {
      totalEnd += a.balance;
      if (a.id === titheAccountId) titheEnd = a.balance;
    }
    let titheAccrued = 0;
    // The mark runs only for the pot + growth-tithe pairing: it is the base
    // of the accrual and of the trailing/give-cash stream, and nothing else
    // reads it. A pot beside a non-growth ongoing method skips this whole
    // block — there is nothing growth-shaped to accrue or to pay on.
    if (potGrowthStream !== null && pot !== null && titheHistory.firstRetiredYi !== null) {
      /*
       * THE BASE IS CUMULATIVE REAL INVESTMENT GAIN, NOT THE BALANCE.
       *
       * This started life as a high-water mark on the spendable balance, and
       * that was wrong in a way that only shows up on a real plan: a retiree's
       * balance is growth MINUS withdrawals. A household drawing 4% while
       * earning 5% has a flat balance, never sets a new high, and is told it
       * owes nothing — for thirty years, while its investments earn money every
       * one of them. Spending your own money is not a loss to be made up before
       * giving resumes; it just is not growth.
       *
       * So the mark rides the household's cumulative REAL investment gain,
       * which withdrawals cannot touch. Each year adds this year's gain net of
       * inflation on the start-of-year balance — the same definition the
       * percent-of-growth rule uses — and the tithe is owed on whatever that
       * running total has climbed ABOVE its previous peak. A losing year lowers
       * the total and nothing is owed until it recovers, which is the
       * high-water mark doing its actual job: never tithing the same gain
       * twice, without ever mistaking a withdrawal for a loss.
       *
       * Real terms throughout: a mark in nominal dollars would ratchet up on
       * inflation alone and tithe money the household never gained.
       */
      /*
       * The inflation charge is levied on the EX-CARVE-OUT portfolio
       * (totalStart - titheStart), NOT on `spendableStart`: through the soft
       * window `spendableStart` includes the pot (it is last-resort money and
       * the spending policies price off it), but the tithe base must never
       * see the carve-out from either side — its gain is excluded above, so
       * charging its inflation here would penalise the base for money the
       * measurement excludes. In the SEED year the carve-out is cut out
       * partway through, so the portfolio that actually earned this year's
       * gain is smaller still: `titheSeeded` (0 in every other year) is the
       * seed-year-only correction.
       */
      const spendableRealGain =
        (nominalGain - titheNominalGain - (totalStart - titheStart - titheSeeded) * r.cpi) / idx;
      cumRealGain += spendableRealGain;
      const base = Math.max(0, cumRealGain - cumRealGainPeak);
      titheHistory.baseRealByYear[yi] = base;
      // The peak advances to the cumulative total this year's base was measured
      // from, so the same gain can never be swept a second time.
      if (cumRealGain > cumRealGainPeak) cumRealGainPeak = cumRealGain;

      // Accrual runs in SOFT years only — and only under 'accrue_to_pot': a
      // give-cash hold pays this same base out through the ordinary giving
      // machinery instead, and moving it into the pot AS WELL would give the
      // same growth twice. The lock ends the transfers whether it arrived by
      // the hold elapsing or by the safe-zone release.
      if (potAccrues && !titheLocked && titheAccountId !== null && base > 0) {
        const dest = accounts.find((a) => a.id === titheAccountId);
        if (dest) {
          /*
           * ONLY PRE-TAX DOLLARS CAN JOIN. The carve-out is an earmark inside a
           * traditional IRA; there is no mechanism by which brokerage or
           * savings money becomes an IRA balance, so sizing the transfer
           * against the whole portfolio but funding it from anywhere would be
           * fiction. The parent goes first (the transfer is a relabelling
           * inside the account the carve-out came out of) and other pre-tax
           * accounts make up any shortfall, because the tithe is owed by the
           * portfolio rather than by one account. 72(t) accounts are excluded:
           * money leaving one is a distribution and busts the series.
           */
          const seppLockedNow = new Set<string>();
          for (const st of seppState.values()) if (seppIsLive(st)) seppLockedNow.add(st.lockedAccountId);
          const sources = accounts.filter(
            (a) =>
              a.id !== titheAccountId &&
              isPretax(a.type) &&
              a.seppParentId === undefined &&
              !seppLockedNow.has(a.id),
          );
          // Stable sort: the parent first, everything else in account order.
          sources.sort((a, b) =>
            a.id === titheParentId ? -1 : b.id === titheParentId ? 1 : 0,
          );
          // The ONGOING stream's percent, not the pot's: what accrues is the
          // growth tithe the household would otherwise have paid in cash
          // (the pot's own percent sized the seed and nothing else). A
          // migrated bundle wrote the same number into both, so the pinned
          // digests cannot tell the difference.
          let remaining = potGrowthStream.percent * base * idx; // real base -> this year's dollars
          for (const src of sources) {
            if (remaining <= 0) break;
            const take = Math.min(remaining, Math.max(0, src.balance));
            if (take <= 0) continue;
            src.balance -= take;
            dest.balance += take;
            remaining -= take;
            titheAccrued += take;
          }
          titheEnd = dest.balance;
        }
      }
      // Transfer/lock lines belong to the ACCRUING pot only: a give-cash pot
      // never moves a dollar in, so "transferred in" would narrate a transfer
      // that cannot happen and "no further transfers" would end one that
      // never started. Its lock is still on the record — the 'tithe-locked'
      // event and the distribution trace carry it.
      if (taxes.trace && titheAccountId !== null && potAccrues) {
        taxes.trace.push({
          label: !titheLocked
            ? 'Tithe Account — transferred in from the IRA (internal, not a gift yet)'
            : 'Tithe Account — locked: no further transfers in',
          amount: titheAccrued,
          note: !titheLocked
            ? `${(potGrowthStream.percent * 100).toFixed(2)}% of ${(base * idx).toFixed(2)} of new real ` +
              `portfolio high; balance now ${titheEnd.toFixed(2)}. Moving it changes no cash, no ` +
              'income, no expense and no tax — it is one IRA balance down and another up. The ' +
              'balance still counts as spendable, reachable only after every other account is dry'
            : `balance now ${titheEnd.toFixed(2)} — charity money in escrow: out of spendable ` +
              'assets and the success metric, paying out on its distribution schedule',
        });
      }
    }

    // --- 9. Record ---------------------------------------------------------
    /*
     * THE METRICS SERIES EXCLUDES THE CARVE-OUT ONLY ONCE IT IS LOCKED
     * (note 21). This one line is where "escrow must not prop up success
     * probability" actually happens: it feeds the fan, terminalReal, and
     * through those the success rate and the median terminal value. Through
     * the SOFT window the pot is included — it is the household's last-resort
     * money and the solve genuinely reaches it, so excluding it would
     * front-load the very drag the deferral exists to postpone. `totalEnd` is
     * always the truth about the balance sheet and is recorded as such.
     */
    const titheRealEnd = titheEnd / idx;
    balancesRealByYear[yi] = (totalEnd - (titheLocked ? titheEnd : 0)) / idx;
    /*
     * Recorded for every failing path the rule governs, INCLUDING the ones that
     * failed before a carve-out ever opened — those contribute 0, not nothing.
     *
     * Guarding this on `titheAccountId !== null` silently dropped them, and the
     * paths it dropped are exactly the early failures: a pre-59.5 retirement
     * that cannot meet its cash need in the retirement year itself is insolvent
     * before the seed block ever runs. Averaging only the failures that lasted
     * long enough to accumulate a tithe reports a bigger cushion than the plan
     * actually has, which is the opposite of what a break-glass number is for.
     *
     * UNDER THE SOFT WINDOW the figure keeps its meaning — "what sat in the
     * account when the path first fell short" — and is now typically ~0 on a
     * soft-window failure, because the ordering drained the pot LAST before
     * the year could fall short at all. A large figure specifically means the
     * path failed after the lock, with the promise standing.
     */
    if (pot !== null && insolvencyYear === year && breakGlassReal === null) {
      breakGlassReal = titheRealEnd;
    }
    charitableCashReal += charitable / idx;
    /*
     * --- SAFE-ZONE EARLY RELEASE (note 21) --------------------------------
     *
     * Watched only while the window is still soft. The yardstick is the
     * SPENDABLE REAL series just recorded — through the soft window that
     * includes the pot, so an accrual (intra-portfolio) can never move the
     * measure, and REAL is what makes the trigger mean anything: a nominal
     * high arrives in almost every mildly-inflationary year. The mark is the
     * FIRST fully-retired year's close; the first LATER year to close above
     * it proves the fragile window is over, and the lock (and the pot's
     * distribution) start NEXT year — never this one, whose books are already
     * written. The trigger only ever pulls the lock EARLIER; with
     * earlyRelease false the deferral's own end date stands. It runs even
     * when no carve-out could open (no divisible pre-tax parent): the
     * trailing-growth cash stream keys off the same lock year, and the
     * household's giving should not stay deferred longer merely because the
     * pot could not exist.
     */
    if (
      pot !== null &&
      titheEarlyRelease &&
      !titheLocked &&
      titheHistory.firstRetiredYi !== null
    ) {
      if (yi === titheHistory.firstRetiredYi) {
        titheReleaseMark = balancesRealByYear[yi];
      } else if (
        titheReleaseMark !== null &&
        balancesRealByYear[yi] > titheReleaseMark &&
        titheHistory.lockYi !== null &&
        yi + 1 < titheHistory.lockYi
      ) {
        titheHistory.lockYi = yi + 1;
      }
    }

    if (yearRows) {
      const flags: string[] = [];
      if (!converged) flags.push('no-convergence');
      if (insolventNow) flags.push('insolvent');
      if (taxes.aca?.cliffApplied) flags.push('aca-cliff');
      if (taxes.penalties > 0) flags.push('penalty');
      if (seppTotal > 0) flags.push('sepp');
      if (seppDepletedThisYear) flags.push('sepp-depleted');
      // Note 21: the promise absorbed an emergency this year — the ordering
      // reached the carve-out after everything else ran dry, and the pot is
      // permanently smaller. Worth a flag for the same reason a guardrail cut
      // is: it is a real event in the household's story, not a rounding.
      if (titheDrawn > 0) flags.push('tithe-drawn');
      // Note 18: this year's giving came (wholly or partly) from the
      // retirement rule rather than the paycheck stream. 'continue' never
      // flags — it IS the paycheck stream, so nothing about the year changed.
      if (givingRuleMonths > 0) flags.push('giving-rule');
      // Note 22: the years a guardrail actually fired are the only years a
      // guardrails run differs from fixed_real, and a cut is a change to the
      // household's standard of living. Nobody should have to infer it by
      // comparing two rows of the baseline column.
      if (guardrailMoved !== null) flags.push(`guardrail-${guardrailMoved}`);
      // Note 21: the seed is a one-off worth pointing at, and a missing
      // contribution history is a data problem the user can fix — say so
      // rather than quietly seeding a smaller number.
      if (titheBasisMissing) flags.push('tithe-basis-missing');
      if (titheSeedCapped) flags.push('tithe-seed-capped');
      // The widow penalty is otherwise invisible in a row: same withdrawals,
      // same balance, a much larger tax bill. Flag the year it lands and every
      // year after, so nobody has to infer it from the arithmetic.
      if (death !== null && year >= death.year) {
        flags.push(year === death.year ? 'death' : 'survivor');
      }

      /** Engine-generated events for the year, alongside the scenario's own. */
      const inPathEvents: string[] = [];
      if (autoElectedThisYear) inPathEvents.push('auto-sepp');
      // Fix B: the household busted a 72(t) series this year — a permanent
      // state change with a five-figure price, on par with the election
      // itself. The chip's tooltip reads the cost from the trace.
      if (bustsThisYear.length > 0) inPathEvents.push('sepp-busted');
      // A six-figure planned outflow deserves the same visibility as the
      // election that funds it: the year the lump retires the loan gets a
      // chip, with the amount in the tooltip (read from the trace line above).
      if (hres.mortgagePayoff > 0) inPathEvents.push('mortgage-payoff');
      if (death !== null && death.year === year) inPathEvents.push('spousal-rollover');
      if (titheAccountId !== null && titheHistory.firstRetiredYi === yi) {
        inPathEvents.push('tithe-seeded');
      }
      // The soft window closing is a state change on par with the seed: from
      // this year the pot is escrow and the distribution clock is running. A
      // lock arriving BEFORE the full deferral elapsed can only be the
      // safe-zone release, and saying which door it came through is what lets
      // the user check the trigger did what they designed.
      if (pot !== null && titheHistory.lockYi === yi) {
        inPathEvents.push('tithe-locked');
        if (
          titheHistory.firstRetiredYi !== null &&
          yi < titheHistory.firstRetiredYi + pot.holdYears
        ) {
          inPathEvents.push('tithe-early-release');
        }
      }

      const byAccountW: Record<string, number> = {};
      for (const x of rmds) byAccountW[x.accountId] = (byAccountW[x.accountId] ?? 0) + x.amount;
      for (const x of seppItems) byAccountW[x.accountId] = (byAccountW[x.accountId] ?? 0) + x.amount;
      // The pot's instalment is a forced distribution like the two above, and
      // the per-account ledger must show every dollar that left the carve-out.
      for (const x of titheDistItems) byAccountW[x.accountId] = (byAccountW[x.accountId] ?? 0) + x.amount;
      for (const s of plan.slices) byAccountW[s.accountId] = (byAccountW[s.accountId] ?? 0) + s.amount;
      for (const c of convSlices) byAccountW[c.fromAccountId] = (byAccountW[c.fromAccountId] ?? 0) + c.amount;
      const byAccountB: Record<string, number> = {};
      for (const a of accounts) byAccountB[a.id] = a.balance;

      yearRows.push({
        year,
        agesAtYearEnd: ages,
        inflationIndex: idx,
        income: {
          wages: wagesNet,
          socialSecurity: ssGross,
          taxableInterest,
          dividends,
          other: oti.total,
          retirement: retirementIncome,
          employerHealthPremiumShare: premiumShare,
        },
        expenses: {
          baseline,
          charitable,
          housing: hres.totalCosts,
          health,
          oneTime: oneTimeExp,
          // Shared-types contract: total is EXACTLY the five component
          // fields; taxes are recorded separately in taxes.totalTax (the
          // withdrawal solve's internal cash need does include taxes, but
          // that number is not recorded here), and the investing stream is a
          // transfer, not consumption. Recorded-cash identity for a solvent
          // year:
          //   income.total + gross withdrawals (cash + taxable + pretax
          //   incl RMD and SEPP + roth)
          //     = expenses.total + taxes.totalTax + investing
          //       + surplus swept (a RETIRED year only: reinvested in the
          //         brokerage, or into savings when there is none)
          //       + banked.livingReduction (note 24b: parked in savings)
          //       + unbudgeted (a WORKING year only: consumed, note 20)
          //       + house-purchase outflows.
          //   banked.investing adds NO term: it is inside `investing`, which
          //   records the transfer whichever account received it.
          total: baseline + charitable + hres.totalCosts + health + oneTimeExp,
        },
        investing,
        unbudgeted,
        // Present only when the between-homes banking moved money (note 24),
        // so every other run's rows — including every pinned digest without a
        // window — keep their exact shape.
        ...(investingToSavings > 0 || bankedLivingReduction > 0
          ? { banked: { investing: investingToSavings, livingReduction: bankedLivingReduction } }
          : {}),
        housing: {
          rent: hres.rent,
          mortgagePayment: hres.mortgagePayment,
          mortgageInterest: hres.mortgageInterest,
          propertyTax: hres.propertyTax,
          insurance: hres.insurance,
          maintenance: hres.maintenance,
          homeValue: hres.homeValueEnd,
          saleProceeds: hres.saleNetCash,
        },
        withdrawals: {
          byAccount: byAccountW,
          cash: plan.byBucket.cash,
          taxable: plan.byBucket.taxable,
          // Gross pre-tax dollars distributed: on-demand draws + forced RMDs
          // + forced 72(t) payments + the tithe pot's instalment.
          pretax: plan.byBucket.pretax + rmdTotal + seppTotal + titheDistributed,
          roth: plan.byBucket.roth,
          rothConversion: convTotal,
          rmd: rmdTotal,
          penaltyBase: plan.penaltyBase,
          realizedLtcg: plan.realizedLtcg,
        },
        taxes,
        balances: {
          byAccount: byAccountB,
          total: totalEnd,
          totalReal: totalEnd / idx,
          // The carve-out is inside `total` — it is a real IRA balance the
          // household owns — and broken out because its reachability differs:
          // last-resort money through the soft window, escrow once locked.
          // `spendable` therefore drops it only from the lock year, and
          // `spendableReal` is what every success metric is built from; all
          // three agree to the cent in any plan without a Tithe Account.
          tithe: titheEnd,
          spendable: totalEnd - (titheLocked ? titheEnd : 0),
          spendableReal: balancesRealByYear[yi],
        },
        ...(titheAccountId !== null
          ? {
              tithe: {
                accountId: titheAccountId,
                balance: titheEnd,
                seeded: titheSeeded,
                accrued: titheAccrued,
                // The trailing-growth stream's own prescription only:
                // `charitable` also carries the paycheck stream in a prorated
                // retirement year, the pot's instalment and the carve-out's
                // forced RMD, and none of those is this stream speaking.
                given: givingRuleMonths > 0 ? ruleFullYear * (givingRuleMonths / 12) : 0,
                distributed: titheDistributed,
                drawn: titheDrawn,
                locked: titheLocked,
                forcedDistributionGiven: titheForcedGift,
                breakGlassReal: titheRealEnd,
              },
            }
          : {}),
        ...(death !== null && year >= death.year
          ? {
              survivor: {
                deceased: death.personId,
                deathYear: year === death.year,
                filingStatus,
                taxPeople: taxIdx.length,
                lifeInsuranceBenefit: lifeBenefit,
                ssLumpSum,
              },
            }
          : {}),
        returns: r,
        // The prepared list is shared across paths and must never be mutated;
        // an in-path election or carve-out appends to a copy. Both can fire in
        // the same year (the household retires, the bridge elects, the tithe
        // opens), so this composes rather than choosing.
        eventsFired: inPathEvents.length > 0
          ? [...ctx.eventsFiredByYear[yi], ...inPathEvents]
          : ctx.eventsFiredByYear[yi],
        flags,
      });
    }

    // --- Roll the cumulative indexes into next year ------------------------
    idx *= 1 + r.cpi;
    cumMed *= 1 + r.cpi + medSpread;
    cumRent *= 1 + r.cpi + rentSpread;
  }

  // The carve-out at the horizon is the bequest to charity (note 21): the
  // engine models no estate, so "100% of it is donated on death" is settled by
  // keeping it out of terminal wealth and reporting it here instead.
  let titheTerminalReal = 0;
  if (titheAccountId !== null) {
    const dest = accounts.find((a) => a.id === titheAccountId);
    // Deflated by the index of the FINAL year, matching balancesRealByYear:
    // the loop advanced `idx` once more on its way out, so step it back.
    if (dest) titheTerminalReal = dest.balance / (idx / (1 + returns[H - 1].cpi));
  }

  return {
    yearRows,
    balancesRealByYear,
    insolvencyYear,
    terminalReal: balancesRealByYear[H - 1],
    breakGlassReal,
    charitableCashReal,
    titheTerminalReal,
    purchaseFunding,
    guardrail:
      guardrails !== null
        ? {
            everCut: gEverCut,
            minFactor: gMinFactor,
            yearsBelow: gYearsBelow,
            everAbovePlan: gEverAbove,
            floorTouched: gFloorTouched,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// runSimulation
// ---------------------------------------------------------------------------

// The hashes stamped below compute through the vendored shared/sha256 — the
// engine's LAST Node dependency was the `node:crypto` import this replaced.
// tests/shared/engineVersion.test.ts proves the vendored digest byte-equal to
// node:crypto on real profile/assumptions shapes, so RunMeta.hashes and
// runKey are unchanged by the swap.

/**
 * Run a full simulation (SPEC §4.3 modes):
 * - deterministic: 1 fixed-return path, traced (doubles as the reference path)
 * - historical: every rolling horizon-length window (input.paths ignored)
 * - montecarlo: seeded block bootstrap of input.paths paths
 * A traced deterministic companion always provides referencePath for the
 * cashflow/tax/MAGI UIs (SPEC §9). onProgress fires every ~2% of paths.
 */
export function runSimulation(input: SimulationInput, onProgress?: ProgressFn): RunResult {
  const t0 = performance.now();
  const ctx = prepareSim(input);
  const H = ctx.horizonYears;
  const market = ctx.market;

  let pathsReturns: YearReturns[][];
  switch (input.mode) {
    case 'deterministic':
      pathsReturns = [deterministicPath(market, H)];
      break;
    case 'historical':
      pathsReturns = historicalPaths(input.assumptions.historical, H, market);
      break;
    case 'montecarlo':
      pathsReturns = bootstrapPaths(
        input.assumptions.historical,
        H,
        input.paths,
        market.bootstrapBlockYears,
        input.seed,
        market,
      );
      break;
  }

  const n = pathsReturns.length;
  const insolvencyYears: Array<number | null> = new Array(n).fill(null);
  const terminals: number[] = new Array(n).fill(0);
  const realByPath: number[][] = new Array(n);
  /** Note 21: carve-out balances left untapped in each FAILING path's first bad year. */
  const breakGlass: number[] = [];
  /**
   * Note 22: each path's cut/raise record. Non-empty exactly when the policy
   * is guardrails (every simulated path then reports one); the MC reference
   * companion is excluded below for the same reason it is excluded from
   * `terminals` — it is not one of the sampled futures, and a deterministic
   * path that never cuts would dilute the fractions by 1/n for nothing.
   */
  const guardPaths: GuardrailPathStats[] = [];
  let referencePath: YearRow[];
  let reference: PathOutcome;

  if (input.mode === 'deterministic') {
    const out = simulatePath(ctx, pathsReturns[0], { trace: true });
    insolvencyYears[0] = out.insolvencyYear;
    terminals[0] = out.terminalReal;
    realByPath[0] = out.balancesRealByYear;
    if (out.breakGlassReal !== null) breakGlass.push(out.breakGlassReal);
    if (out.guardrail !== null) guardPaths.push(out.guardrail);
    reference = out;
    referencePath = out.yearRows as YearRow[];
    onProgress?.(1);
  } else {
    const progressStep = Math.max(1, Math.round(n / 50)); // ~2% of paths
    for (let i = 0; i < n; i++) {
      const out = simulatePath(ctx, pathsReturns[i], { trace: false });
      insolvencyYears[i] = out.insolvencyYear;
      terminals[i] = out.terminalReal;
      realByPath[i] = out.balancesRealByYear;
      if (out.breakGlassReal !== null) breakGlass.push(out.breakGlassReal);
      if (out.guardrail !== null) guardPaths.push(out.guardrail);
      if ((i + 1) % progressStep === 0 || i === n - 1) onProgress?.((i + 1) / n);
    }
    reference = simulatePath(ctx, deterministicPath(market, H), { trace: true });
    referencePath = reference.yearRows as YearRow[];
  }

  const fan = buildFan(realByPath, ctx.startYear);
  const success = successRate(insolvencyYears, terminals, ctx.settings.terminalFloorReal);
  const sortedTerminals = [...terminals].sort((a, b) => a - b);
  const medianTerminalReal = percentileSorted(sortedTerminals, 0.5);
  const worst = worstDecileShortfallYears(insolvencyYears, terminals);
  /*
   * BREAK GLASS (note 21). The MEDIAN over failing paths, not the mean and not
   * the whole distribution: it answers "in a year this plan does not work, how
   * much have we promised away that we could take back?" — one number the
   * owner can weigh against the promise. Null when nothing failed, because
   * there is then no year in which the question arises. The reference path
   * contributes only in deterministic mode, where it IS the run.
   */
  const breakGlassReal =
    breakGlass.length > 0
      ? percentileSorted(
          [...breakGlass].sort((a, b) => a - b),
          0.5,
        )
      : null;

  /*
   * Note 22 aggregation. `guardPaths` is non-empty exactly when the policy is
   * guardrails, so the stats exist only then — the absent-field convention
   * purchaseFunding set. The band resolution repeats simulatePath's own
   * (absent band = DEFAULT_GUARDRAILS, absent floor = the default floor) so
   * the floor and ceiling the stats CARRY are the ones the paths ENFORCED.
   */
  const guardBand =
    ctx.settings.spendingPolicy.type === 'guardrails'
      ? (ctx.settings.spendingPolicy.guardrails ?? DEFAULT_GUARDRAILS)
      : null;
  const guardrailStats =
    guardPaths.length > 0 && guardBand !== null
      ? aggregateGuardrailStats(
          guardPaths,
          guardBand.floorFraction ?? DEFAULT_GUARDRAILS.floorFraction,
          guardBand.raiseCeiling,
        )
      : null;

  const profileHash = sha256Hex(stableStringify(input.profile));
  const assumptionsHash = sha256Hex(stableStringify(input.assumptions));
  const scenarioHash = sha256Hex(stableStringify(input.scenario));
  const runKey = sha256Hex(
    `${profileHash}:${assumptionsHash}:${scenarioHash}:${input.mode}:${n}:${input.seed}`,
  );

  return {
    meta: {
      engineVersion: ENGINE_VERSION,
      mode: input.mode,
      seed: input.seed,
      paths: n,
      createdAt: '', // server stamps it (engine stays deterministic)
      scenarioName: ctx.scenarioName,
      hashes: { profile: profileHash, assumptions: assumptionsHash, scenario: scenarioHash },
      runKey,
    },
    success,
    horizonYears: H,
    fan,
    medianTerminalReal,
    worstDecileShortfallYears: worst,
    breakGlassReal,
    // Lifetime giving from the REFERENCE path, for the same reason the
    // cashflow table comes from there: it is the one path with a year-by-year
    // story the user can read, and a median across Monte Carlo paths would
    // mix a run that gave generously for 30 years with one that went broke at
    // 70 into a number belonging to neither.
    charitableLegacy: {
      cashGivenReal: reference.charitableCashReal,
      terminalTitheReal: reference.titheTerminalReal,
      totalReal: reference.charitableCashReal + reference.titheTerminalReal,
    },
    referencePath,
    // The reference path's sell → rent → buy funding story (note 24). Spread
    // conditionally so a run without a window keeps its exact JSON shape —
    // the same convention YearRow uses for its optional blocks.
    ...(reference.purchaseFunding !== null ? { purchaseFunding: reference.purchaseFunding } : {}),
    // Cut/raise statistics across the simulated paths (note 22) — absent
    // under every other spending policy, so those runs keep their exact shape.
    ...(guardrailStats !== null ? { guardrailStats } : {}),
    elapsedMs: performance.now() - t0,
  };
}
