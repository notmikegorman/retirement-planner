# ASSUMPTIONS — placeholder values you should review

Every unknown is an **editable Profile field** (Profile page in the app, or edit
`~/finance-planner-data/profile.json` directly) with a plausible placeholder. The
projections are only as good as these numbers — replace them and the plan recomputes.

> **These are invented starting values, not anybody's real ones.** Every figure in the
> table below ships in `data-defaults/profile.starter.json` so the app has something to
> run on first boot. Replace them. Expenses are **three monthly streams** (living,
> charitable, investing) rather than one annual number, so re-enter yours as three.

## Money placeholders (all marked `PLACEHOLDER` in profile notes)

| Field | Placeholder | Where it came from |
|---|---|---|
| Person 1 salary | **$150,000/yr** | Round invented number, consistent with the account sizes |
| Person 1 PIA at FRA — working to 62 | **$2,900/mo** | The SSA-statement figure (assumes continued earnings) |
| Person 1 PIA at FRA — stopping now | **$2,600/mo** | ⚠️ Placeholder. Get the real one: ssa.gov estimator with *average future annual salary = $0*. The engine blends the two by retirement year |
| Person 2 PIA | **$0** (`hasOwnBenefit: false`) | The starter models a person with under 40 credits → spousal benefit only. Set `hasOwnBenefit: true` and both PIA figures if this person has a work record |
| 401(k) balance | **$850,000** | Chosen so pre-tax assets dominate, which is what makes the pre-59½ bridge the interesting problem |
| Traditional IRA | **$250,000** | — |
| Roth IRA (P1 / P2) | **$120,000 / $30,000** (contribution basis $60k / $20k) | Basis matters for pre-59½ Roth access — set your real contribution history |
| Taxable brokerage | **$70,000** (basis $45,000) | Liquid-outside-retirement is ~$105K in the starter, split $70k/$35k |
| Savings | **$35,000** | ditto |
| Home value / basis | **$550,000 / $350,000** | Basis (purchase + improvements) drives the §121 math when you sell |
| Property tax / insurance / maintenance | **$4,400 / $1,800 / 1%** of value | Typical figures for the starter's home value; look up the real rate for your own county — at these prices it is the largest ownership cost by a wide margin |
| Living expenses | **$6,000/mo** | ⚠️ Re-enter: this is now *living only* — carve out charitable giving and investing, which are their own streams, and it still excludes health premiums and housing items |
| Charitable giving | **$0/mo** | Enter yours; it feeds the charitable tax deductions. This is the *while working* stream — it does **not** stop by itself when the paychecks do |
| Giving after you stop working | **Keep giving the same amount, no pot** | The defaults (an absent `expenses.retirementGiving` means "same as working"; an absent `expenses.untithedPot` means no pot). Both are set on the Profile's Tithing tab, or overridden per plan on the Workbench's Tithing tab — see the behavioral defaults below |
| Investing / savings | **$0/mo** | Enter yours; while working it transfers into the taxable brokerage and stops at retirement |
| 401(k) contribution + match | **$24,000 + $6,000/yr** | Under the 2026 $24,500 limit; set to your real deferral |
| ACA benchmark quote | **$1,480/mo** household | ⚠️ **Illustrative, and the single most valuable field to replace.** It is roughly what a second-lowest-cost Silver plan costs at full price for two people in their early fifties in a low-cost inland county — the right order of magnitude and nothing more. It drives both the premium tax credit and the 400%-FPL cliff, so get the real one from healthcare.gov (or your state marketplace) for your own ages and ZIP, and set `acaQuoteYear` to the year you priced it |
| Employer premium share | **$200/mo** | ⚠️ Placeholder — your actual payroll deduction; modeled as a pre-tax deduction while working |
| Part D plan premium | **$45/mo/person** | Near the 2026 average; IRMAA add-ons come from the CMS table |

## Behavioral defaults you can change

- Withdrawal order: cash → taxable → pre-tax (IRA) → Roth. The 401(k) rolls into the IRA at
  separation in every run, so rule of 55 is not used; a 72(t) SEPP is the penalty-free
  route to pre-tax money before 59½.
- **72(t) SEPP: on by default for any retirement before 59½.** Stopping work before your
  penalty-free year elects a series in the retirement year, on your largest traditional IRA
  (post-rollover). The payment is sized to what the plan actually needs each year over the
  bridge — not the IRS formula maximum — and the IRA is split so only the principal that
  payment requires is under the series; the rest stays an ordinary, fully accessible IRA.
  A `start_72t` event you add yourself overrides it for that person. Turn it off with the
  Plan card's "Use a 72(t) SEPP to reach 59½ penalty-free" checkbox, which writes
  `autoSepp: false` into the plan; an absent field means on.
  - **The automatic election respects the calendar.** Committed one-off outflows scheduled
    inside the prospective lock window — a house purchase at a stated price above all (cash
    price, or the down payment when financed), plus one-time expenses — cap the carve: the
    un-carved remainder is reserved to produce whatever cash on hand and projected sale
    proceeds cannot cover, grossed up for the tax and 10% penalty the producing draws will
    themselves owe (flat marginal stand-in: 40% + the penalty, deliberately high because a
    purchase-sized draw lands in the top brackets), plus the living the reserved cash can no
    longer carry through the purchase. A cap that leaves no positive payment DECLINES the
    election that year — the offer stands and is re-tested every remaining bridge year. A
    purchase priced at `sale_proceeds` with cash financing is a residual claim, not a
    commitment, and reserves nothing. The election-year tax trace states the cap (or the
    decline) and its arithmetic.
  - **Busting the series is a price, not a wall.** A year that cannot meet its cash need
    from every account the withdrawal order may touch — the tithe pot's last-resort seat
    included — while a live series still locks money BUSTS the series rather than failing:
    the lock lifts permanently (a modified series does not resume), the draw proceeds under
    ordinary penalty rules (10% if still under 59½), and the year is charged the IRC
    72(t)(4) recapture — 10% of every payment the series made before your penalty-free year,
    plus interest, modeled simply as each payment compounding at the path's own T-bill
    return from its payment year to the bust year (a documented stand-in for §6601
    interest, not an IRS reconstruction). Payments made at/after 59½ were never
    penalty-protected and are not recaptured. This applies to hand-written `start_72t`
    series exactly as to automatic ones; the year fires a `sepp-busted` event and the tax
    trace itemises the price. A path that fails even after busting fails honestly.
- **The streams switch on one signal: while working / after you stop working.** Everything
  flips on the first year no salary is drawn, and the retirement year itself is prorated by
  the months worked. What happens after work stops differs per stream:
  - **Living** (`livingMonthlyRetired`) — an empty after-work box means **the same as
    working**. Groceries, utilities and insurance do not fall the day the salary stops.
    (Under the `fixed_percent` spending policy the policy sets living spending outright and
    neither side is consulted.)
  - **Investing** — **stops at retirement, always** (a standing rule since 2026-08-31;
    engine 1.24.0). Investing out of a paycheck ends with the paycheck; there is no
    after-work box, and an `investingMonthlyRetired` left in an older file is parsed and
    ignored. While anyone is still earning, this transfer is the **only** accumulation the model
    assumes: leftover pay beyond it is treated as spent, because `livingMonthly` is a budget
    baseline and does not carry the irregular costs (a new air conditioner, a car repair, a
    trip) that the leftover of a paycheck actually pays for. The cashflow breakdown shows it
    as "Unbudgeted / not invested". Once nobody earns, the rule flips: a surplus can then
    only be a forced RMD or 72(t) payment the year did not need, and that IS reinvested in
    the brokerage. The retirement year follows the working (no-sweep) rule for the whole
    year.
  - **Giving** (`retirementGiving`) — a *rule* rather than a number; see below.

  The Workbench's Spending card shows living and investing as one row each, two cells wide,
  and can override either cell for one plan without touching `profile.json`. Giving's
  after-work half lives on the **Tithing tab** (Workbench and Profile alike), because it is
  **two decisions**, not one cell:
- **Giving after the last paycheck is TWO independent knobs** (they used to be bundled into
  a single "tithe account" rule; old files are migrated to the pair on load, with identical
  behaviour — the equivalence is pinned bit-for-bit in `tests/engine/tithePair.test.ts`):

  **Knob 1 — the ongoing method** (`expenses.retirementGiving`) picks what replaces the
  paycheck stream from the first year nobody works, with the retirement year itself prorated
  (paycheck stream for the months worked, rule for the rest):
  - *Same as working* — the default, and what an absent field means.
  - *Amount* — a flat different figure in today's dollars, inflation-adjusted in the sim.
    Unlike the working stream it is not retargeted by `charitable` expense-change events.
  - *Stops* — $0 from the first fully retired year.
  - *A percent of investment growth* — without a pot, a percentage of **last year's real
    portfolio growth** (the year's investment gain across all accounts minus inflation on
    the start-of-year balance; contributions, withdrawals and sweeps are not gains). A down
    year gives $0. Optional smoothing averages the last N years; an optional cap limits the
    monthly result in today's dollars. **With a pot present** the base becomes a
    **high-water mark on new real highs** (below) — the bundle's own stream, unchanged;
    smoothing does not apply on that base (averaging new-high increments would tithe the
    same increment twice), the cap still does.
  - *A percent of income drawn* — a percentage of **last year's** Social Security plus gross
    withdrawals (Roth conversions excluded — and, beside a pot, the pot's own flows are
    excluded too: the distribution instalment and the carve-out's forced RMD are money that
    passes straight through to charity, and counting them would tithe the tithe).

  **Knob 2 — the un-tithed pot** (`expenses.untithedPot`; absent = no pot) — a **balance
  carved out inside your largest pre-tax IRA** (an accounting label; no tax, no cash moves
  to create it), seeded on retirement day with `percent` (absent = 10%) of every retirement
  account's **never-tithed gains** (balance minus career contributions — see item 9 below).
  Then, in order:
    - **The soft hold** (up to `holdYears` — the old `deferYears`): the held balance **still
      counts as yours**. It sits in your spendable assets and your success rate, and if
      every other account runs dry the plan spends it, **last of all and permanently** (the
      withdrawal order treats it as the account of last resort; a draw is never paid back).
      The hold exists to carry the promise past the fragile first years of retirement, not
      to starve them — a hard lock on day one would remove spendable money at the worst
      possible moment. What the **ongoing method** does meanwhile is the pot's
      `ongoingDuringHold` switch: *accrue into the pot* (absent = this, the old bundled
      behaviour) moves a percent-of-growth tithe into the carve-out at each year-end — no
      cash giving, no deduction, those years — while *give in cash* pays the ongoing method
      from retirement day, fully independent of the pot. Only a growth tithe has anything
      growth-shaped to accrue: beside any other ongoing method the hold defers the POT
      alone and the method simply pays its own cash throughout.
    - **Safe-zone early release** (`earlyRelease`, **on unless switched off**): the first
      year to close above the plan's **real** (inflation-adjusted) spendable balance at the
      end of its first retired year proves the fragile window over, and the lock starts the
      next year instead of waiting out the calendar. Real, not nominal — a nominal high
      arrives in almost every mildly-inflationary year.
    - **The lock** (when the hold closes either way): from that year the account is
      charity money in escrow — out of spendable assets, out of the success rate, the
      terminal value and the fan, untouchable by the withdrawal order.
    - **Distribution** (`distributeYears`, absent = 10): the held pot pays out in cash over
      that many years — each year gives the balance over the years remaining, so growth
      earned along the way is given too and the pot is exactly empty on schedule — **on top
      of** whatever the ongoing method pays. Both feed the charitable deduction; each
      instalment is a real IRA distribution (ordinary income, and penalized before 59½ like
      any other early IRA dollar — see item 10 on the unmodeled QCD).
    - **At death** whatever remains goes to charity, not the survivor — including a death
      during the hold. The break-glass figure keeps meaning "what sat in the account
      when a failing path first fell short": under the soft hold that is typically ~$0
      (the path spent its last resort before failing), and a large figure now specifically
      means the plan failed **after** the lock, with the promise standing.
  The percentage rules read the prior year because this year's growth and withdrawals depend
  on this year's spending, which would include the giving — the fixed point cannot resolve a
  circular definition, and the prior year is what you would actually know when deciding.
  Under every rule the giving still feeds the charitable tax deductions. The plan can
  override **each knob independently** on the Workbench's Tithing tab without touching the
  profile — in an override, an absent pot **inherits** the profile's and the explicit
  `{ "enabled": false }` suppresses it (the load-time migration writes that disable into
  every pre-split override, which used to suppress the pot by replacing the whole bundled
  rule).
- **Income after you stop working** (`income.retirementMonthly`, empty = none). Recurring
  money you expect once the salaries stop — part-time work, consulting, a rental, a pension
  — in today's dollars per month. It is the mirror image of a salary: it starts in the first
  year nobody draws one, is prorated in the retirement year, inflates with CPI and then runs
  for life. It is spendable cash, so it directly reduces what the portfolio has to produce,
  and it shrinks any automatic 72(t) series (less of the IRA gets locked up). It is
  **always ordinary income** (a standing rule since 2026-08-31; engine 1.24.0) — it raises
  AGI and every MAGI test with it: the ACA cliff, IRMAA, the taxability of Social Security.
  The old `retirementIncomeTaxable` toggle is gone; the flag is parsed and ignored in older
  files. The Plan page's Income card is where "what if I consulted two days a week?"
  belongs — it is a plan override, so clearing the box undoes it.
  - ⚠️ **The Social Security earnings test is NOT modeled.** Claiming before Full Retirement
    Age while earning above the annual exempt amount withholds benefits ($1 for every $2
    over the limit; $1 for every $3 in the FRA year), credited back as a permanently higher
    benefit at FRA. Your plan claims at 67 — your FRA — where the test does not apply at
    all, so nothing here is affected. A plan that claims at 62 **and** carries part-time
    earnings above the limit would overstate benefits in those years.
  - Retirement income is modeled as plain ordinary income, not wages: no payroll
    tax, and it creates no earned income for IRA-contribution purposes.
- Surplus cash is reinvested in the taxable brokerage (raising balance and cost basis), not
  held as cash — including a 72(t) payment larger than the year's spending. Households with
  no brokerage account fall back to savings.
- Spending policy `fixed_real`; success target 85%; horizon age 95; seed 20260812;
  1,000 MC paths interactive / 10,000 final.
- Figures used while developing the move/rent/mortgage events, if you build them: rent
  $2,800/mo, expense multiplier 0.85× after a move, mortgage 6.5% 30-yr with 20% down. All
  placeholders — replace them with real quotes. (Your plan starts with no such events: the
  three plan decisions and nothing else.)
- Market assumptions (`assumptions/market.json`): deterministic real returns 6.5%/1.8%/0.5%
  (stocks/bonds/bills), 2.5% inflation, 5-yr bootstrap blocks, medical trend CPI+2%,
  home appreciation = CPI, rent growth CPI+0.5%. The deterministic real returns are
  round-number summaries of the bundled series' long-run geometric-mean REAL returns
  (1928–2025: stocks 6.78%, 10-yr Treasuries 1.45%, bills 0.33%), set as sanity-check
  values rather than forecasts.
- **Bond composition** (`market.bondComposition.corporateFraction`, 0–1, absent = 0):
  what the bond sleeve is made of. 0 (the default) is pure 10-yr Treasuries — exactly
  what the engine always modeled, bit-identical. A fraction f prices every sampled
  historical year's bond return as `(1-f)·bonds10 + f·baa` on the **same row**, so the
  crash-year trade is historical, not assumed: in 2008 Treasuries returned **+20.10%**
  while Baa corporates returned **−3.44%** — the flight-to-quality hedge is precisely
  what a corporate sleeve gives up in exchange for ~1–2pp more yield. ~0.30
  approximates a total-bond fund like BND; 1.0 is the visible extreme. Deterministic
  mode blends the REAL anchors the same way: `(1-f)·deterministicReal.bonds + f·3.5%`,
  where 3.5% is the Baa series' geometric-mean real return (3.49%) summarised by the
  same round-number convention as the other anchors. It is an assumption dial, not a
  plan decision — deliberately **not** a search axis.
  - The Baa column (`assumptions/historical-returns.csv`) is Damodaran's Baa corporate
    bond total-return series, same page and vintage as the other four columns, verified
    against an independent FRED yield recomputation (exact to the basis point
    1928–1985; 0–25 bp in recent decades; 1987–1998 within ~2.5 pp on a differing
    year-end yield convention). ⚠️ **Caveat carried from verification:** it is a
    *yield-derived* series — a constant-maturity 10-yr par bond priced off Moody's Baa
    yields — not a market total-return index, so it ignores defaults and downgrades
    within the Baa bucket and therefore **slightly flatters corporates**. The same
    construction is used for the `bonds10` column, which is what makes the two
    comparable year by year. Long-run stats: mean 6.90%, sd 7.65%, worst 1931 −15.68%,
    best 1982 +29.05%; correlation 0.40 with stocks, 0.66 with Treasuries.

## Market quotes and the Net Worth ledger

- **Holdings-mode accounts are priced from stored quotes, never live ones.** An account can
  list what it actually holds (symbol × shares × asset class, plus uninvested cash) instead
  of a typed balance; its balance and mix are then DERIVED — shares × the stored price +
  cash, with the mix from per-class market values (cash counts as bills). The prices come
  from **Yahoo Finance's public chart endpoint**, fetched only when you press **Refresh
  prices** (Accounts tab) or take a net-worth snapshot, and stored in `quotes.json` with
  each quote's own as-of moment. Quotes are **delayed** exchange prices, **USD-only** (a
  non-USD listing is rejected with the currency named — use the US listing), and they are
  **inputs, not forecasts**: a price says what the account is worth today, and the
  simulation's return models take it from there.
- **Runs never fetch.** A simulation prices holdings from `quotes.json` as it stands; a
  symbol with no stored quote fails the run loudly, naming the symbol and the fix, rather
  than quietly pricing from a stale cache. The derived balances are real input — they feed
  the run-cache key — so refreshing prices correctly reprices the next run instead of
  hitting yesterday's cache entry.
- **Net-worth snapshots are records, not projections.** The Net Worth page's one button
  refreshes every holdings symbol, prices all accounts through the same resolver runs use,
  adds the **home value you typed** (no feed prices a house; the box defaults to the last
  snapshot's figure), and appends the row to `networth.json` with the exact per-symbol
  prices and as-of times it used. Share counts are yours to maintain — the app never
  infers a trade from a price change. Every displayed total carries its condition: prices
  as of the snapshot moment; home value as you entered it.

## Open questions for you (answer by editing the Profile — nothing blocks on them)

1. **Your $0-future-earnings PIA**: ssa.gov's estimator with *average future annual salary*
   set to $0. This is now the figure that prices every early-retirement what-if; the
   statement number you entered assumes you keep working.
2. **Three expense streams**: re-enter living / charitable / investing as monthly numbers
   (the old single figure bundled them together).
3. **Employer premium share**: your actual monthly payroll deduction for health coverage.
4. **Roth funding history**: was the original lump sum a *contribution*, a *conversion*, or
   a Roth-401(k) rollover — and what year? The Profile page records conversions with their
   years. It often barely moves the math — a conversion older than five years is as
   accessible as a contribution — but it should be recorded truthfully, because the
   five-year clocks are what the pre-59½ Roth ordering runs on.
5. **The non-earning spouse's SS record**: actually under 40 credits? If that person
   qualifies for any worker benefit at all, set `hasOwnBenefit: true` and their PIA — it
   beats the spousal floor in some claim orders.
6. **Home cost basis**: include improvements; it directly moves the §121 outcome.
7. **Giving after you stop working**: the app defaults to keeping the paycheck stream running
   for life, because that is what it did before the rule existed — not because it is the right
   answer. The alternatives (stop, a percent of real portfolio growth, a percent of income
   drawn) are one dropdown apart on the Profile's Tithing tab, and the un-tithed pot is its
   own switch beside them; the plan can override each independently on the Workbench's
   Tithing tab. To weigh two configurations, pin the current run as the baseline and switch a
   knob — the results then report the difference. Every method feeds the charitable
   deductions identically, so the choice moves the plan's spending, not its tax treatment.
8. **Target-date allocation**: the starter's 401(k) is set to ~68/32 with an automatic 2035
   glide, which is roughly the shape of a 2035 target-date fund. Check the current mix on
   your own fund's page if you want it exact — and decide what happens after a rollover:
   today the rolled money adopts the destination IRA's allocation, so if you would actually
   keep a target-date fund there, say so on the account.

9. **Career contribution history** (drives the un-tithed pot's opening balance). Each
   retirement account carries a "Contributed over your career" figure — the lifetime dollars
   you PUT IN, never the growth on them — and it is an ESTIMATE you should revise if you can
   do better. A worked example of how to build one:

   | Account | Balance | Contributed | Basis for the estimate |
   |---|---|---|---|
   | IRA | $1,285,000 | $430,000 | the share of career deferrals now sitting here |
   | 401(k) | $162,400 | $80,000 | current employer, a few years of deferrals |
   | Roth | $96,200 | $49,500 | balance minus the broker's reported unrealized gain |

   The $510,000 across the two pre-tax accounts is the sum of 402(g) elective deferrals for a
   32-year career at "maxed out most years": maxing every single year, including the age-50
   catch-up, would total about $564,000, and this discounts that to roughly 90%.
   **Employer match is deliberately excluded** — it never passed through your gross, so it
   was never tithed, and leaving it out of this figure is exactly what leaves it inside the
   untithed base.

   **Do not use your broker's "unrealized gain" for this.** It is a different quantity: it
   measures what you paid for the shares you *currently hold*, so every rollover, every sale
   and every reinvested dividend resets it. On a long-held IRA it can imply a contribution
   history several times larger than any career of 402(g) deferrals could produce — which is
   the tell that it is answering a different question.

   The seed is insensitive to the estimate: swinging the assumed deferrals from $350k to
   $650k moves it by about ±10%. A better figure would come from old plan statements showing
   lifetime contributions.

10. **QCDs are not modeled.** From the month you turn 70½ (a date test, not a tax year —
    IRC 408(d)(8)(B)(ii)) you could give directly from an IRA to charity, excluded from
    income entirely rather than merely deductible, up to $111,000 per person in 2026 (IRS
    Notice 2025-67, indexed) and counting toward RMDs from age 75. The engine gives cash the
    ordinary taxable way, so every projection here **understates** what a giving plan
    actually delivers after 70½. Worth building next — it is the largest remaining tax lever
    in the giving design.

## Modeling assumptions worth knowing (full list: DECISIONS.md)

2026 tax law frozen and CPI-indexed forward (statutory-unindexed items stay fixed:
SS taxation thresholds, NIIT); ACA enhanced credits assumed **not** extended (toggle per
plan override `enhancedCreditsExtended`); **Medicaid expansion is modeled per state**: VA and
NC expanded (below 138% FPL → Medicaid at $0 premium), SC never did (below 100% FPL →
the coverage gap: full premium, no credit — a real cost of moving to SC before 65 with
low MAGI); the ACA benchmark quote is location-fixed (a modeled move keeps the
origin-state quote — edit the Profile quote to price the destination); NC 3.99% held flat
(2027 trigger cuts not assumed); VA standard deduction follows the enacted schedule
($17,500 → $18,400 → $18,600 → statutory $6,000 from 2030; fallback editable in
`va-2026.json` if you believe VA keeps extending it); **the 401(k) rolls into the IRA at
separation in every run, so rule of 55 is never used** — pre-59½ access runs through
taxable/savings, Roth contribution basis, a 72(t) SEPP, or the 10% penalty; **charitable
giving** feeds the OBBBA non-itemizer deduction ($2,000 MFJ, never indexed) and the
0.5%-of-AGI itemizer floor, but never reduces AGI or any MAGI (so giving cannot duck the
ACA cliff or an IRMAA tier) — and it does so under every giving-after-work rule, including
the growth-based ones; SC's new 2026 two-bracket system
verified and modeled; annual time steps; residency by Dec-31 domicile.

## The widow score (a `death` event) — what is verified, and what is judgment

Add a `death` event and the plan runs as a SURVIVOR's plan from that month. The
same engine, the same success metric; only the household changed. Read the
result against the household score — the gap is the widow penalty priced in
probability.

**Verified against primary sources** (see the notes in each data file for the
citation): the year of death is the last joint return and every year after is
single with no qualifying-surviving-spouse grace period (no dependent child);
the single brackets, standard deduction, $2,050 unmarried 65+ add-on, LTCG
breakpoints, $200k NIIT threshold and $25k/$34k Social Security thresholds; VA,
SC and NC single deductions (and VA's age-deduction threshold falling to
$50,000, not $37,500); single IRMAA tiers (top tier $500k, **not** half of
$750k); the one-person FPL of $15,650 and its $62,600 cliff; the survivor
benefit at 100% of the deceased's PIA, claimable from 60 on a 28.5%-maximum
reduction spread evenly to survivor FRA, never stacking with the survivor's own;
the $255 lump sum; the life-insurance death benefit being outside gross income
(IRC 101(a)(1)); the §121 two-year window that keeps a survivor's $500,000
home-sale exclusion; the basis step-up at death (full when solely owned, half on
a spousal joint account — none of the three modelled states is a
community-property state, so the full IRC 1014(b)(6) step-up is not applied).

**Judgment calls you should argue with.**

- **Living costs fall to 75% of the couple's baseline.** No source exists for
  this and none can — it is a judgment about one household, not a statute.
  Equivalence scales suggest 0.67–0.71 for total spending, but this baseline
  already excludes housing and health (modelled separately), which are the
  costs that fall least. Set `livingFraction` on the event to argue, or fill in
  the per-line survivor column on the budget, which outranks it.
- **The survivor's Social Security starts on the date the plan already says
  they claim** (never before 60), rather than the engine choosing between 71.5%
  at 60 and 100% at survivor FRA on their behalf. Set `survivorClaim` on the
  event to model the choice.
- **The deceased's IRA becomes the survivor's immediately.** That is right for
  RMDs and it avoids the 10-year rule. It is not automatically right before the
  survivor is 59½: a real survivor under 59½ often keeps the account INHERITED
  first, because death is a penalty exception, and rolls it over later. The
  engine instead bridges them with a 72(t), which is more restrictive than
  reality — conservative, but worth knowing if the death lands early.
- **What the survivor does about the HOUSE is two knobs on the Housing card,
  split at the purchase month.** A death strictly before the purchase buys at
  `survivorPurchasePrice` (absent = the survivor executes the plan price as
  written). A death in or after the buy month reads `survivorDownsizeTo`
  (absent = the survivor KEEPS the house as bought, for good — staying put is
  an assumption exactly as much as selling is): a number sells the home
  `survivorDownsizeDelayMonths` after the death (absent = 12 — nobody lists a
  house from a funeral) and rebuys at that price for cash the same month; `'none'` sells on the same
  schedule and rents to the horizon at the plan's rent. The sale runs through
  the ordinary machinery — the 6%-convention selling costs, the §121
  exclusion with its two-year survivor window, proceeds landing in savings —
  and the Widow tab states whichever assumption is in force, in both
  directions.
- **NOT modelled at all:** probate and estate costs (the unlimited marital
  deduction makes federal estate tax moot for a spouse), final medical or
  funeral expenses, any change in the survivor's own earnings, and the
  "windexing" alternative PIA computation available when the worker dies before
  62 — which can only *raise* the survivor's benefit, so omitting it is
  conservative.

## The score recorded on a net-worth snapshot — and when two of them compare

Taking a snapshot records two things: what the money added up to, and what your
**plan** scored around that moment. The first is a market record and cannot be
recreated later; the second is a simulation, and everything below is about the
conditions that make one comparable with the next.

**It is a score OF A PLAN, and the row says which one.** The Workbench has no
save button — `plan.json` is rewritten on every knob turn — so a trend of
"whatever the plan was at the time" would be a trend of half-finished what-ifs
unless every point could say what it measured. Every score therefore carries
`planHash`, the plan's own identity (name and description excluded), and, when
that plan is one of the versions in your plan history, the id of that version —
so a point can offer back the plan it was scored under. There is nothing to
designate: there is one plan, and the history remembers the rest.

**Two runs, not one.** The probability lands first, from a single
final-quality run. Then the same plan goes through the `max_spend` bisection —
a dozen more runs — for **what it could afford**, because for an over-funded
household the probability saturates and the dollars are what separate two
plans. The second half can fail on its own without disturbing the first, and
when the answer is off the end of the solver's bracket the row says so in words
rather than recording the bracket's own edge as if it had been measured.

**The conditions every recorded score carries**, because each of them can move
the number by more than the decisions you are trying to see:

| Condition | What it is | Why it is stamped on the row |
|---|---|---|
| `paths` | `settings.mcPathsFinal` — 10,000 | Final quality, not the interactive 1,000. At 10,000 the sampling noise is roughly ±0.3pp; at 1,000 it is around ±1pp, which is larger than most real year-over-year movement |
| `seed` | `settings.seed` | The same stream of futures every time, so two snapshots differ because the world moved, not because the dice did |
| `mode` | Monte Carlo | The only mode that answers "in what fraction of futures does this work" — deterministic reports 0 or 1 |
| `engineVersion` | `ENGINE_VERSION` at scoring time | Part of the run-cache key precisely because two engines do not agree |
| `planHash` (+ `planHistoryId`) | Which plan this scored, and the version in your history that holds it | A score is a score OF a plan; change the plan and you are measuring something else |
| `sustainableSpendPaths` | The paths behind the spend figure — the solver caps its inner sweeps at 2,000 | It is measured at lower precision than the probability beside it, and a label carries its own condition |
| `scoredAt` | When it was computed | Distinct from `takenAt`. A net-worth row is scored by the run its own snapshot starts, so the two are minutes apart; a stored plan version is scored when you press **Score it**, against the profile as it stands THEN |

**Two scores are only comparable when the plan and the engine version match.**
The chart marks every point where either changed — a hollow ring on the point
and a dashed rule on the boundary — and the tooltip says which. Read across such
a mark as "the question changed here", not as a change in your odds.

Scores recorded before 2026-08-20 name a separately frozen "baseline plan"
instead (`baselineRevision`, `baselineHash`, `baselineLabel`, and whether the
plan you were editing had already drifted from it). Those are historical facts
about numbers already on your chart and they still read exactly as they were
recorded; nothing writes them again. The seam between the two is marked like any
other break, because the two hashes cover different things and nothing can claim
the numbers either side of it were on one scale.

**Absent means not scored, and it never means 0%.** A row taken before scoring
existed, a row whose simulation failed, and a row still being scored all carry
no `score` at all. The chart leaves a gap and the table shows "not measured",
"no score" with the reason, or "scoring…" — because 0% would say this plan fails
in every simulated future, which is a very different claim from "nobody has
scored this row".

**And absent is permanent.** A number is written once, into a blank, and nothing
writes over it: the net-worth row is scored by the run its own snapshot starts
and never again, and a stored plan version that already carries a score is
refused (HTTP 409) rather than re-measured. What that costs is a row whose
simulation died staying scoreless for good — and that is the honest side of the
trade. "Nobody measured this moment" is true; a figure measured against a
different day and filed here would not be. The one exception is not an
exception: a version whose scoring FAILED can be scored, because a failure
records no measurement, so writing there fills a blank rather than replacing a
fact. Why, and what it replaced: DECISIONS.md, "A recorded number is not
rewritten".

**What a score does NOT re-derive.** It uses today's *resolved* profile
(holdings priced from the quotes the snapshot just refreshed) and today's
assumptions. The run cache is deliberately allowed to answer: an unchanged
world returns the identical number, and a changed one — a price moved, an
expense edited, the engine bumped — misses the cache and re-runs. "Fresh" here
means "reflects today's inputs", not "recompute what cannot have changed".

**`sustainableSpend` is what the plan could afford, and it is LIVING expenses
only.** The solver sweeps `expenses.livingMonthly` (moving the retired figure in
proportion) and leaves the charitable and investing streams alone, so it is not
total household spend. It is bisected at the solver's own inner path cap —
2,000, recorded beside it as `sustainableSpendPaths` — rather than the 10,000
behind the probability, because a bisection is a dozen runs and a dozen
final-quality runs is minutes. When it is absent, the row says why: the answer
was off one end of the solver's $20,000–$400,000 bracket, or the sweep itself
failed. It is never filled in with the bracket's own edge.
