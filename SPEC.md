# Retirement Planner — Build Specification

> ## ⚠️ This is the ORIGINAL BRIEF, preserved as history — not current documentation.
>
> It is what the app was asked to be before it existed. Parts of it were superseded
> during the build and are now simply wrong about the code:
>
> - **The scenario library and the Compare page are gone.** §2 and §9 describe a
>   `scenarios/*.json` library and a side-by-side Compare view; the app has ONE plan
>   (`plan.json`) plus a version history, and what-ifs are made by editing it. The
>   acceptance files `retire-sweep.json`, `ss-claim-sweep.json` and `swr-curve.json`
>   were never shipped — those sweeps became the Explore buttons on the Workbench.
> - **The UI pages listed in §9 are not the pages that exist.** The real ones are
>   Workbench, Search, Dashboard, Profile, Net Worth and Methodology.
> - **§10's P6 backlog is mostly built** — see `PLAN.md`.
> - **"No runtime network calls" was never quite true** — see the correction in §1.
>
> For what is actually built, read `ARCHITECTURE.md`; for why it diverged, `DECISIONS.md`.

**Audience:** Claude Code. This document was the complete brief for building a
local-first financial planning application. Read it fully before writing any code.

**How to work:**
1. Read this entire spec. Produce a short `PLAN.md` mapping the phases in §10 to concrete
   work items, plus any open questions. Get approval before Phase 0.
2. Build phase by phase. Every phase ends with something runnable. Pause for the user to
   try it before the next phase.
3. Maintain `ARCHITECTURE.md` (how it's built) and `DECISIONS.md` (why) as you go.
4. Every item marked **VERIFY** in this spec must be checked against the primary sources
   listed in §8 before it is encoded. Record each verification (value, source URL, date
   checked) in `VERIFICATIONS.md`. If you cannot reach the network, ask for the values to
   be pasted in. Never silently guess a tax number.
5. Write tests as you build, especially for the tax engine (§7). The tax module must never
   be edited without its tests passing.

---

## 1. Product brief (the only section a reader needs)

A **local-first web app** for a single household to run retirement what-if scenarios:
deterministic projections, historical-sequence analysis, and Monte Carlo simulation, with
real US federal and state tax math underneath.

- Runs entirely on the user's machine. One command to start; opens in the browser.
  **No cloud services, no accounts, no telemetry.**
  *(Corrected after the build: there is exactly ONE outbound request, and only when the
  user asks for it — a price refresh sends the holdings' ticker symbols to Yahoo
  Finance's public chart endpoint. Simulations never touch the network. See README.)*
- All data lives as human-readable JSON in a plain folder the user can back up
  (default `~/finance-planner-data/`, configurable). Suggest `git init` in that folder.
- The modelled household: a married couple filing jointly, both pre-retirement, resident
  in one of the three supported states (VA, SC or NC) and possibly moving between them.
- Core loop: edit **Profile** (current balances, income, spending) → compose **Scenarios**
  (a named set of assumption overrides + timeline events) → **Run** (see success
  probability, portfolio fan chart, year-by-year cashflow and tax detail) → **Compare**
  scenarios side by side → use **Solvers** ("max sustainable spending," "earliest safe
  retirement year," "best Social Security claiming age").
- v1 is DONE when the six acceptance scenarios in §9 run end to end with credible output.

---

## 2. Architecture

- **Stack:** TypeScript throughout. Vite + React frontend. Small local server
  (Fastify or Express) responsible for (a) reading/writing the data folder and
  (b) running simulations (in a worker thread so the UI stays responsive).
  Charts: Recharts. Keep styling clean and simple; desktop browser is the target.
- **Strict separation:** `engine/` (pure, no IO, fully deterministic given inputs + seed),
  `tax/` (pure; see §7), `server/` (file IO + API), `ui/`. Tax logic must never leak into
  the simulation loop — the engine calls `tax.computeYear(...)` and nothing else.
- **Determinism:** every run is reproducible. RNG is seeded; the seed, engine version,
  and content hashes of profile/assumptions/scenario are stamped on every saved run.
- **Performance target:** 10,000 Monte Carlo paths × 40 years in under ~10 seconds on a
  typical laptop. Annual time steps (see §5 simplifications).

### Data folder layout
```
~/finance-planner-data/
  profile.json                  # current household truth (starter provided)
  assumptions/
    market.json                 # expected-return overrides, bootstrap settings
    historical-returns.csv      # annual: US stocks, 10yr bonds, T-bills, CPI (see §6)
    tax/federal-2026.json       # brackets, deductions, LTCG, NIIT, penalty rules
    tax/va-2026.json            # + sc-2026.json, nc-2026.json
    social-security.json        # claiming adjustment factors, taxation thresholds
    medicare-2026.json          # Part B/D base premiums + IRMAA tiers
    aca-2026.json               # FPL table, applicable-percentage table, cliff flag
    rmd-table.json              # Uniform Lifetime Table
  scenarios/*.json
  runs/                         # cached results keyed by content hash
```
All files carry `{ "year": ..., "source": ..., "verified_on": ... }` metadata. JSON Schema
validation on load; helpful errors, never crashes, on malformed input.

---

## 3. Profile schema (starter file provided as `profile.starter.json`)

- `people[]`: id, name, birth year + month, `pia_monthly_at_fra` (from the SSA
  statement), notes on earnings record. A person with under 40 credits has no benefit of
  their own, so only the spousal benefit applies — the starter profile models one person
  that way to exercise the path.
- `filing`: status `mfj`, `state` (va | sc | nc), residency simplification per §5.
- `accounts[]`: id, type (`traditional_ira` | `roth_ira` | `taxable_brokerage` |
  `savings` | `401k`), **owner** (person id), balance, `cost_basis` (taxable only),
  allocation (asset-class weights, or explicit holdings priced from `quotes.json`), and
  for the 401(k): `current_employer`, `rule_of_55_eligible`, `allows_partial_withdrawals: VERIFY with plan` (flag in
  UI if unknown — some plans force lump sums, which changes the bridge strategy).
- `home`: value, `cost_basis` (purchase price + improvements — needed for the §121
  exclusion when they sell), state, property tax, insurance, maintenance % of value.
- `income`: per-person salary, 401(k) employee contribution + employer match while
  working.
- `expenses`: `annual_baseline` (FILL_ME_IN — excludes health insurance premiums and
  housing items the engine models separately), optional category breakdown.
- `settings`: horizon age (default 95, configurable to 100), default success target
  (85%), MC paths (1,000 interactive / 10,000 final), seed.

---

## 4. The engine

### 4.1 Yearly loop (document this order of operations in ARCHITECTURE.md)
For each simulated year: update ages → income (wages if not yet retired; Social Security
per claiming state; interest) → expenses (baseline × inflation × location multiplier +
housing module + health-insurance module) → **solve required gross withdrawals** so that
after-tax cash covers net spending (fixed-point iteration: withdrawals change taxes,
taxes change required withdrawals; iterate to convergence) → apply withdrawal-ordering
policy → compute taxes via `tax.computeYear` (§7) → forced RMDs from the RMD start year →
grow balances per allocation and that year's returns → record everything.

### 4.2 Withdrawal ordering
Default policy: cash → taxable brokerage (track basis; gains are LTCG) → pre-tax
(within pre-tax: the current-employer 401(k) first while under 59½ **if** rule-of-55
applies, because IRA withdrawals before 59½ incur the 10% penalty unless a 72(t)/SEPP
is active) → Roth last. Policies are data, not code: user-selectable order plus a
`72t_active` toggle per scenario. Model the 10% early-withdrawal penalty explicitly
whenever an early distribution has no exception.
Why this matters: a household retiring before 59½ typically holds far less outside its
retirement accounts than the bridge costs, so early-retirement scenarios are funded
mainly through the pre-tax door. This must work correctly in v1.

### 4.3 Return models (three modes, same engine)
1. **Deterministic:** fixed real returns per asset class (user-set; defaults in
   `market.json`) — for quick sanity checks.
2. **Historical sequences:** replay every rolling N-year window from the historical
   series (the cFIREsim-style method). Cheap, powerful, zero distributional assumptions.
3. **Monte Carlo (block bootstrap):** sample contiguous blocks (default 5 years,
   configurable 1–10) of *joint* stock/bond/bill/CPI rows from the historical series —
   never sample asset classes independently; preserving their correlation and inflation
   linkage is the entire point. Seeded and reproducible.

### 4.4 Spending policies
v1: `fixed_real` (baseline spending, inflation-adjusted) and `fixed_percent`
(withdraw X% of portfolio each year). Backlog: Guyton-Klinger guardrails.

### 4.5 Success metrics
Success = portfolio never insolvent through the horizon (optional terminal-value floor).
Report success %, percentile fan (10/25/50/75/90), median terminal value, and the
worst-decile shortfall year distribution.

---

## 5. Documented simplifications (encode these; note them in the UI's methodology page)
- Annual time steps. Ages evaluated at year end. The Medicare transition year (2036)
  prorates premiums 6 months ACA / 6 months Medicare on the expense side only.
- State residency for a whole tax year = residence on Dec 31 of that year (no part-year
  returns in v1).
- Social Security COLA = simulated CPI. Benefit taxation thresholds stay unindexed
  (that's the law, not a simplification — it's why SS taxation creeps upward in real terms).
- No estate/inheritance modeling in v1. `death` events and survivor mechanics
  (filing-status switch, survivor benefit, spousal IRA rollover, compressed brackets)
  are the flagship Phase 6 feature — architect the engine so nothing blocks it (per-person
  fields everywhere; never hardcode "couple").
- A total-market equity ETF is modeled as the US total-market equity class using the
  long historical series as proxy (the funds themselves are too young); expense ratios are a per-class drag field.

---

## 6. Historical data
Build `historical-returns.csv` (annual, 1928→latest available) with columns:
US stocks total return, 10-yr Treasury total return, 3-mo T-bill return, CPI inflation.
Preferred source: Aswath Damodaran's annual returns dataset (NYU Stern); alternative:
Robert Shiller's online data for stocks/CPI. Record source + retrieval date in the file
header and in `VERIFICATIONS.md`. Sanity checks in tests: long-run real equity return
falls in ~6–7%/yr; bond real return ~1.5–2.5%; refuse to load a series failing checks.

---

## 7. Tax engine (the hard part — build it like it's the product)

`tax.computeYear(year, filingStatus, state, inputs) → { federal, state, penalties,
acaPTC, medicarePremiums, magiVariants, detailTrace }` — pure, deterministic, and unit
tested. `detailTrace` is a human-readable calculation walkthrough surfaced in the UI
(the user must be able to audit any year's tax line).

Federal, in evaluation order:
- Ordinary income (wages, interest, traditional 401(k)/IRA withdrawals, taxable portion
  of Social Security) through the MFJ brackets; **VERIFY** TY2026 brackets and standard
  deduction (including the additional 65+ amounts for later years) from the current IRS
  revenue procedure.
- LTCG + qualified dividends **stacked on top of** ordinary income through the 0/15/20%
  brackets (**VERIFY** 2026 breakpoints). Getting the stacking interaction right is a
  named test case.
- Social Security taxation via provisional income: MFJ thresholds $32,000/$44,000
  (statutory, unindexed), up to 85% taxable. Implement the worksheet exactly.
- NIIT: 3.8% on net investment income above $250,000 MAGI (MFJ, unindexed).
- 10% early-withdrawal penalty with exceptions: rule of 55 (separation from service in
  or after the calendar year of turning 55; applies **only** to that employer's plan,
  never to IRAs; lost if rolled over), 72(t)/SEPP (payments must continue until the
  later of 5 years or 59½), age 59½+.
- Roth ordering rules: contributions anytime tax/penalty-free; earnings need 59½ + 5-year
  clock; conversions have per-conversion 5-year clocks pre-59½. Track basis buckets.
- RMDs: anyone born 1960 or later → RMDs begin at age 75, Uniform Lifetime
  Table (**VERIFY** table values). RMD income is forced ordinary income.
- Home sale: §121 exclusion, $500K of gain MFJ on a primary residence; gain above that
  is LTCG. Needs `home.cost_basis`.
- ACA Premium Tax Credit **computed inside the tax engine as a tax-return true-up**
  (that is how the law works — credits advance monthly but reconcile on Form 8962):
  household MAGI vs FPL, applicable-percentage table, benchmark silver premium (owner
  supplies a quote for their ages/location in `aca-2026.json`; **VERIFY** the 2026
  applicable-percentage schedule). 2026 law: enhanced credits expired 2025-12-31; the
  400%-FPL cliff is back — for a 2-person household the 2026 cliff is $84,600 MAGI, and
  $1 over forfeits the entire credit. Include an `enhanced_credits_extended` boolean in
  `aca-*.json` so scenarios can toggle the policy (Congress keeps fighting about it).
- Medicare from age 65 (June 2036): Part B + D premiums plus IRMAA surcharges keyed to
  **MAGI from two years prior** (so 2034 income sets 2036 premiums). **VERIFY** 2026 base
  premiums and IRMAA tiers; model future tiers as inflation-indexed.
- MAGI variants: ACA MAGI, IRMAA MAGI, and NIIT MAGI differ slightly — compute each
  correctly and expose all of them per year (the UI charts them; §9).

State modules (data-driven; **VERIFY every number** against each revenue department):
- **VA:** age deduction for 65+ (income-limited), SS not taxed, standard brackets.
- **SC:** SS not taxed; retirement-income deduction; 65+ deduction; current bracket/rate.
- **NC:** flat rate on a declining statutory schedule; SS not taxed; minimal deductions.
Mortgage interest + SALT-capped property tax feed an itemize-vs-standard choice
(engine takes the max).

Social Security benefit math (inputs are each person's PIA from their SSA statement):
- FRA 67 for both. Worker benefit: 70% of PIA at 62 rising to 100% at 67; delayed
  retirement credits 8%/yr to 124% at 70.
- Spousal: up to 50% of the worker's PIA at the spouse's FRA; reduced to 32.5% at 62;
  **no increase for delaying past FRA**; cannot start before the worker files; deemed
  filing applies. Survivor receives the larger of the two benefits, including the
  deceased's delayed credits (Phase 6, but encode the factors now).

---

## 8. Primary sources for VERIFY items
IRS revenue procedures + form instructions (irs.gov) · ssa.gov (claiming factors, owner
statements) · cms.gov (Medicare premiums, IRMAA) · healthcare.gov + KFF calculators (ACA
percentages, FPL, benchmark premiums) · tax.virginia.gov · dor.sc.gov · ncdor.gov ·
federalregister.gov (FPL guidelines). Record everything in `VERIFICATIONS.md`.

## Acceptance tests (write before the corresponding code)
- **Tax fixtures:** ≥12 frozen cases spanning: ordinary-only; LTCG stacking straddling a
  breakpoint; SS taxation at 0%/50%/85% tiers; ACA credit just under vs $1 over the
  cliff; IRMAA tier boundary; early 401(k) withdrawal with and without rule of 55; RMD
  year. Expected values filled during VERIFY against official calculators, then frozen
  as regression tests.
- **Property tests:** more income never yields less after-tax income (within a bracket
  system, check no cliff is *accidental*); tax is continuous at bracket edges; ACA cliff
  is the only intended discontinuity and is flagged in `detailTrace`.
- **Engine tests:** MC with fixed seed is bit-identical across runs; historical mode
  reproduces a hand-computed 3-year toy series; withdrawal-order golden files.

---

## 9. v1 acceptance scenarios (the definition of done) and UI

Ship these as example files in `scenarios/`:
1. `retire-sweep.json` — solver sweep of retirement year 2026–2033, everything else
   constant. Output: success % and max sustainable spending per retirement year (table +
   chart). This is the headline question the app exists for.
2. `move-2027.json` — retire; sell the home (§121 applies), rent 12 months ($/mo input),
   buy in another state at a price equal to net sale proceeds; expense multiplier
   (e.g., 0.85×) and a state change on the sale date.
3. `move-2027-mortgage.json` — same, but 20% down, 30-yr mortgage at an input rate, PMI
   avoided at ≥20%, remaining proceeds invested per allocation. Compare vs #2 side by side.
4. `allocation-glidepath.json` — 100%-equity baseline vs static 60/40 vs a glidepath
   primitive (e.g., 100%→60% equity ending at retirement+5 years, optional re-rise).
   Output must make the sequence-of-returns question empirically answerable.
5. `ss-claim-sweep.json` — when one person's benefit is purely spousal it is gated by
   the worker's filing, so household claiming reduces to **one date**; sweep 62→70 monthly,
   report expected lifetime benefits and plan success % per date.
6. `swr-curve.json` — spending-rate vs success-% curve for a given retirement year;
   the "what must our cost of living stay within" table.

**UI pages:** Dashboard (profile snapshot) · Profile editor (the "update my IRA balance"
screen — edits write back to `profile.json`) · Scenarios (list, edit via forms composed
from the event vocabulary, raw-JSON toggle, duplicate) · Results (success gauge,
percentile fan chart, year-by-year cashflow + expandable tax `detailTrace`, and a
**MAGI chart**: each year's MAGI variants plotted against that year's applicable
thresholds — ACA cliff through 2035, IRMAA from 2034, SS taxation from claiming) ·
Compare (2+ scenarios, key metrics + overlaid fans) · Solvers.

### Event vocabulary (v1)
`retire(person, date)` · `claim_social_security(person, date)` ·
`expense_change(date, multiplier | delta, category?)` · `state_change(date, state)` ·
`sell_house(date)` · `rent(start, months, monthly_cost)` ·
`buy_house(date, price | "sale_proceeds", financing: cash | {down_pct, rate, term_yrs},
property_tax, insurance)` · `allocation_change(date, mix)` ·
`glidepath(start, end, from_mix, to_mix)` · `withdrawal_strategy(date, policy)` ·
`one_time_expense(date, amount)` · `one_time_income(date, amount)` ·
`start_72t(date, account)` · `roth_conversion(date | yearly, amount | to_bracket_top)`
(conversion solver itself is backlog; the event is cheap now).
A scenario = `{ name, description, assumption_overrides{}, events[] }`.

---

## 10. Build phases (each ends runnable)
- **P0** Scaffold, schemas + validation, profile editor, deterministic projection with
  federal ordinary-income tax only, single portfolio chart.
- **P1** Full tax stack: LTCG stacking, penalties + rule of 55/72(t), state modules
  (VA/SC/NC), §121, ACA PTC, Medicare/IRMAA, RMDs — with the §8 test suite green.
- **P2** Historical-sequence mode + block-bootstrap MC, success metrics, fan chart,
  seeded reproducibility, run cache.
- **P3** Housing/move/allocation/glidepath events + Compare view (scenarios 2–4 pass).
- **P4** Social Security module + claiming sweep + max-spend and SWR solvers + MAGI
  chart (scenarios 1, 5, 6 pass) → **v1 done**.
- **P5** Polish: solver UX, methodology page, docs.
- **P6 (backlog, do not block v1):** `death(person, date)` + survivor mechanics and
  widow's-tax stress test · Roth conversion optimizer · guardrails spending ·
  stochastic mortality from period life tables.
