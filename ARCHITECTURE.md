# ARCHITECTURE

How the planner is built. See `DECISIONS.md` for *why*, `VERIFICATIONS.md` for tax-data
provenance, and `ASSUMPTIONS.md` for the user-editable placeholder values.

## Stack

TypeScript everywhere, single npm package.

- **UI**: Vite + React 18 + Recharts. No router — a small tab shell (`src/ui/App.tsx`).
- **Server**: Fastify on `127.0.0.1:5599` (`FPLAN_PORT` to change, `FPLAN_HOST` to move
  off loopback — don't; see README's security section), run via `tsx` (no compile step).
  Serves the built UI from `dist/ui` and the JSON API under `/api`. One server per data
  folder is enforced by a lock file (`src/server/singleWriter.ts`).
- **Simulations** run in a `worker_threads` worker (`src/server/simWorker.ts`) so the UI
  stays responsive; the worker is spawned with `execArgv: ['--import','tsx']` so it can
  load TypeScript directly.
- **Tests**: Vitest (`tests/`), property tests with fast-check.

```
npm start        # build UI + start server, opens the browser
npm run dev      # BOTH halves at once (scripts/dev.mjs): API :5599 + Vite :5174
npm run dev:api  # API alone (tsx watch, :5599)
npm run dev:ui   # Vite dev server on :5174 (proxies /api -> :5599)
npm test         # vitest run
npm run typecheck
```

Installed as a service (systemd user unit / launchd agent), it is `scripts/install.sh`,
`scripts/update.sh`, `scripts/uninstall.sh` and `scripts/service.sh` instead — see
INSTALL.md, and DEVELOPMENT.md for running a dev checkout alongside an installed copy.

## Module boundaries (SPEC §2 strict separation)

```
src/shared/    types.ts (the binding contract), schemas.ts (zod validation),
               expenses.ts (the itemised budget reduced to the streams the
               engine consumes — the only place a blank retired/survivor cell
               is interpreted, and the only place the display-only categories
               are excluded from a sum), util.ts (stableStringify, formatting)
src/tax/       PURE. computeYear(inputs, data, opts) -> TaxYearResult.
               federal.ts (brackets, SS worksheet, LTCG stacking, NIIT, penalties,
               deductions), states.ts (VA/SC/NC), acaMedicare.ts (PTC + IRMAA),
               socialSecurity.ts (claiming factors — benefit math, not taxation),
               index.ts (entry). No IO, no engine knowledge.
src/engine/    PURE, deterministic given input + seed. simulate.ts (yearly loop),
               withdrawals.ts (ordering + penalties + Roth buckets + fixed point),
               events.ts, housing.ts, returns.ts (3 return modes), rng.ts (mulberry32),
               metrics.ts (fan/success), solvers.ts, index.ts (execute()).
               The engine calls tax.computeYear(...) and nothing else from tax.
src/server/    File IO + API. dataStore.ts (data folder, zod-validated load/save),
               runManager.ts (worker orchestration + content-hash run cache),
               simWorker.ts, server.ts (routes mirroring src/ui/api.ts),
               planStore.ts (plan.json — the ONE door every plan write passes
               through, so the day's first change files the version it
               replaces), planHistoryStore.ts (plan-history.json — every
               version there has been; one serial writer),
               networthStore.ts (the append-only ledger; one serial writer, so
               a snapshot and a late-arriving score cannot lose each other),
               scoreRunner.ts (runs a plan at final quality and bisects what it
               could afford; the mode, paths and seed are decided here so a
               version's score and a snapshot's are on one scale),
               snapshotScorer.ts + planHistoryScorer.ts (score AFTER the row or
               the version is written, and attach the result or the reason
               there is none).
src/ui/        React pages (Workbench, Search, Dashboard, Profile, Methodology),
               api.ts (typed client), nav.ts (the URL: /page/tab paths, parsed
               and written against the History API — no router dependency),
               theme.ts (light/dark tokens + useChartTheme for Recharts),
               toast.tsx, styles.css.
               The Workbench is the primary page and the app's landing page: the
               inputs panel (components/workbench + the reused
               components/scenarios cards) and the results (components/results)
               sit side by side, and every committed input change re-runs the
               simulation on a fixed seed AND writes plan.json — one debounce,
               both effects, no Save button (see DECISIONS). The former
               Scenarios, Results and Compare pages are gone.
               The results' Summary tab states which run it is showing — a
               quick 1,000-path one or a final 10,000-path one — and carries
               RUN NOW, which refreshes every holdings price and re-runs on the
               conditions scoreRunner.ts records under, so the number can be set
               beside a History or net-worth score (see DECISIONS).
               It also states HOW PRECISELY that run counted: the binomial
               interval on the success rate (±1.3 pts at 1,000 paths, ±0.3 at
               10,000, both 95%), and no delta chip reports a difference
               smaller than the two runs can resolve (see DECISIONS).
               The panel's last tab is HISTORY (PlanHistoryCard +
               planHistoryLogic): every stored version newest first, each with
               what it scored and what it could afford, a two-step Restore, and
               a badge on whichever rows hold the plan on screen (matched by
               planIdentityKey, since the plan has no id and is renamed on
               every write). It replaced the deleted "Saved" tab — the cabinet
               and the frozen baseline both went with the collapse.
               The Net Worth page draws three stacked plots on one categorical
               axis: the stacked bars, the probability, and the sustainable
               spend in dollars (netWorthScoreChart.ts assembles the last two;
               one <TrendChart> draws both). Three scales, three plots — a
               crossing point between two series on two scales means nothing.
               THE ONE WORD FOR THE THING IS "the plan": tests/ui/vocabulary.test.ts
               scans every label, string and JSX text under src/ui and fails on
               a prose "scenario" (identifiers and module paths are exempt —
               `Scenario` is the engine's type and renaming it would touch the
               run-cache key).
```

Dependency direction: `ui -> server(api) -> engine -> tax`, everything importing types
from `shared/`. Tax logic never leaks into the simulation loop.

## Data folder (`~/finance-planner-data/`, override `FPLAN_DATA_DIR`)

Seeded on first boot from `data-defaults/` (copy-if-missing; user edits are never
overwritten): `profile.json`, `profile.starter.json` (pristine reference), `assumptions/`
(market.json, historical-returns.csv, tax/federal-2026.json, tax/{va,sc,nc}-2026.json,
social-security.json, medicare-2026.json, aca-2026.json, rmd-table.json), and `runs/`
(cache keyed by content hash).

Two more files are created by the server rather than seeded, and a backup of the folder
that omits them loses real history: `quotes.json` — the price cache the refresh route
writes and everything else reads (`src/server/quotes.ts`) — and `networth.json`, the
append-only net-worth ledger (`src/server/networthStore.ts`), which is the only record of
what the portfolio was worth on a past day and cannot be recomputed.

`plan.json` — **the one plan**, and the only thing the Workbench writes — is not seeded
from `data-defaults/`: `loadPlan()` creates it on first read from the profile's own people
(the three plan decisions at their defaults, no other events). All saves pretty-printed;
the server suggests `git init` in the folder. Zod validation on every load with
path-labeled, human-readable errors.

`plan-history.json` — **every version of the plan there has been**, oldest first — is not
seeded either. The first change of any local day files the plan AS THE DAY BEGAN
(`planStore.savePlan` is the only door, so the client cannot forget), and an entry can also
be filed explicitly ("keep this one", where a search finalist goes). An entry holds a whole
frozen copy of the Scenario plus `takenAt`, `kind` (`day-start` | `kept`), `planHash` — the
plan's identity, name and description excluded — an optional label, and an optional score.
Nothing ever edits a stored entry's plan: restoring copies it forward onto `plan.json` and
files what it replaced, so a restore is itself undoable.

`.writer.lock` is the only file here the app does not consider data. It names the pid,
host, port and checkout of the server currently holding the folder, and exists because
every file above is read whole and written whole: two servers discard each other's writes
with nothing logged, and the in-process serializers in `networthStore` / `planStore` /
`planHistoryStore` cannot see across processes. A lock whose pid is gone is cleared
automatically on the next start. Never back it up; deleting it while a server is running
is how you get the collision it prevents.

`baseline.json` and `scenarios/` are gone. They held the frozen baseline and the search
cabinet; both were versions of the plan, and `scripts/migrate-plan-history.ts` filed them
as such (backups alongside, nothing removed until its content was proved present in the
history). A recorded score names what it scored by `planHash` now; the older rows keep
their baseline fields, which the schema still reads and nothing writes again.

## The yearly loop (SPEC §4.1 order of operations)

For each simulated year:

1. **Ages** at year end (`year - birthYear`, with `birthMonth` deciding half-birthdays).
2. **Income**: wages while not retired (month-prorated; the 401(k) deferral and the
   employee health-premium share both reduce W-2 wages and take-home cash); Social Security
   per claiming state (effective PIA — interpolated between the two profile figures by
   retirement year — × simulated-CPI COLA × claiming factor; spousal gated by the worker's
   filing); the **retirement income stream** (see below); savings interest and
   taxable-brokerage dividends/interest distributed as cash.
   In a retirement year the 401(k) rolls into the traditional IRA before anything else.
3. **Expenses**: living × inflation × active `expense_change` multipliers, plus the
   charitable stream (which also feeds the tax engine), plus the housing module (property
   tax/insurance/maintenance, rent, mortgage amortization) and the health module (ACA
   benchmark scaled by the federal age curve and medical trend, with per-state Medicaid
   rules; Medicare + IRMAA from 2036 with the 6/6 transition-year proration). Investing is
   *not* an expense — it is a surplus-capped transfer into the brokerage, and while anyone
   still earns it is the *only* thing that accumulates (leftover pay beyond it is consumed
   and recorded as `YearRow.unbudgeted`; a retired year's surplus is still swept into the
   brokerage). Living, investing and charitable giving are **paired streams** (see below):
   each has a working value and an after-work value.
4. **Withdrawal solve** — fixed-point iteration: forced distributions first (RMDs from age
   75 per owner, plus any active 72(t) SEPP payment), then iterate gross withdrawals →
   `tax.computeYear` → after-tax shortfall → adjust, until |Δ| < $1. Withdrawals change
   taxes; taxes change required withdrawals.
5. **Ordering policy** (data, not code): default cash → taxable (proportional-basis LTCG)
   → pre-tax (IRAs; withdrawals before 59½ carry the 10% penalty unless a 72(t) SEPP
   covers the account) → Roth (contributions → conversions with 5-year clocks → earnings).
   The 401(k) rolls into the IRA at separation, so rule of 55 never applies; a SEPP
   account is locked to its fixed payment and skipped by ordinary ordering — but only
   the SEPP IRA itself is, since an `annualAmount` below the formula maximum splits the
   account (see DECISIONS) and the remainder stays ordinary and fully withdrawable.
   A SEPP no longer has to be asked for: `Scenario.autoSepp` (**absent means on**, and the
   Plan card's 72(t) checkbox is what writes the `false`) elects one in the retirement year
   for anyone stopping before their own penalty-free year, sized to the plan's projected
   annual need over the bridge and split to exactly that principal. An explicit `start_72t`
   for that person overrides it; the year fires `auto-sepp`.
6. **Taxes**: the converged `computeYear` result is the year's record (`detailTrace` on
   the reference path only).
7. **Growth**: per-account allocation × that year's class returns (net of expense ratios);
   glidepath/allocation events interpolate; distributed yields don't double-compound. The
   year's leftover cash is swept into the taxable brokerage first (balance *and* basis —
   after-tax money buying shares), savings only as a fallback: a forced 72(t) payment the
   household did not need is reinvested, not parked at the T-bill rate.
8. **Record** the full `YearRow` (income/expense/withdrawal/tax/balance breakdowns,
   MAGI variants, events fired, flags).

Insolvency: the accessible buckets could not cover the year's cash need → the year is
flagged and the path counts as a failure from then on. Balances are **not** zeroed: the
ordering already drew everything it could reach, and what it could not reach — a locked
72(t) SEPP IRA above all — is real money that keeps compounding and keeps showing up in
`balances.byAccount`, the fan, and the terminal value. Success = never insolvent through
the horizon (optional real terminal floor).

## Paired streams: while working / after you stop working

Living, investing and charitable giving each have **two** values — what is in play while
anyone in the household still earns a salary, and what is in play once nobody does. All
three switch on ONE signal, `PreparedHousehold.employerMonthsByYear` (the months anyone
earned): 12 = the working figure, 0 = the after-work figure, anything in between (the
retirement year itself) = prorated between them by worked months.

| Stream | Working | After work | An ABSENT after-work value means |
|---|---|---|---|
| Living | `expenses.livingMonthly` | `expenses.livingMonthlyRetired` | **the working figure** — groceries, utilities and insurance do not fall the day the salary stops |
| Investing | `expenses.investingMonthly` | `expenses.investingMonthlyRetired` | **0** — investing out of a paycheck ends with the paycheck |
| Giving | `expenses.charitableMonthly` | `expenses.retirementGiving` (a *rule*) | **`{ type: 'continue' }`** — the paycheck stream runs on for life |

Every absent case is bit-for-bit the engine before the pairs existed, which is why
`migrateProfile` deliberately writes none of them: absence already carries the right
meaning, and writing a wrong one (`livingMonthlyRetired: 0`) would silently rewrite the
household's plan.

Giving's after-work side is a rule rather than a number because "a tithe on what the
portfolio actually produced" cannot be written as a fixed figure:
`{type:'amount', monthly}` (a flat different figure), `continue`, `none`,
`percent_of_growth` (of the prior year's REAL portfolio growth, optionally smoothed over
N years and capped) and `percent_of_income` (of the prior year's Social Security + gross
withdrawals, conversions excluded). The percentage rules read the PRIOR year because this
year's base depends on this year's withdrawals, which depend on this year's giving — a
circle the withdrawal fixed point cannot resolve. Whatever a rule returns lands in exactly
the same places the paycheck stream did, tax deductions included.

Under the `fixed_percent` spending policy the policy sets living spending wholesale and
neither side of the living pair is consulted.

## The retirement income stream

`ProfileIncome.retirementMonthly` is the mirror image of a salary: recurring money the
household expects AFTER it stops working — part-time work, consulting, a rental, a pension
— in today's dollars per month. It starts in the first year no salary is drawn (the same
worked-months signal), is prorated in the retirement year by the months nobody worked,
inflates with CPI, and then runs for life. Absent means 0.

It is spendable cash: it reduces the withdrawal the year needs, it can fund the retired
investing stream, it shrinks any automatic 72(t) series (so less of the IRA is locked up),
and it is reported as `YearRow.income.retirement`. `retirementIncomeTaxable` (absent =
true) decides whether it is ordinary income — raising AGI and every MAGI test with it —
or spendable cash that raises neither.

**Documented simplification — the Social Security EARNINGS TEST is not modeled.** Claiming
before Full Retirement Age while earning above the annual exempt amount withholds benefits
($1 per $2 over the limit; $1 per $3 in the FRA year) and credits the withheld months back
at FRA. This household claims at 67 — its FRA — where the test never applies, so nothing
here is affected; a 62 claim combined with part-time earnings above the limit would
overstate benefits in those years. Taxable retirement income is also modeled as plain
ordinary income, not wages: no payroll tax, and it creates no earned income for
IRA-contribution purposes.

Both the paired streams and the retirement income are overridable per plan
(`assumption_overrides.expenses` / `assumption_overrides.income`), so a what-if never has
to rewrite `profile.json`. Salaries and 401(k) contributions deliberately are **not**
overridable — they are payroll facts the profile owns, and the plan already moves the only
thing that matters about them: the date they stop.

## Tax evaluation order inside `computeYear` (SPEC §7)

AGI + the SS-taxation worksheet run first; **every 2026 state starts from federal AGI**
(SC moved off federal taxable income with H.4216), so state tax computes second with no
circularity; the final federal pass then takes max(standard, itemized) where itemized =
mortgage interest + SALT-capped (property + state income tax); LTCG + qualified dividends
stack **on top of** ordinary income through the 0/15/20 breakpoints; then NIIT, the 10%
early-withdrawal penalty (with rule-of-55 / 72(t) / 59½ exceptions computed engine-side
per distribution), ACA PTC as a Form-8962-style true-up (cliff intact for 2026), and
Medicare premiums + IRMAA keyed to MAGI from two years prior. Statutory-unindexed items
(SS thresholds, NIIT threshold) never inflate; everything else indexes by simulated CPI
from the 2026 base.

## Return models (SPEC §4.3)

1. **Deterministic**: fixed real returns (`market.json`) compounded with fixed inflation.
2. **Historical sequences**: every rolling N-year window of `historical-returns.csv`
   (1928–2025, Damodaran; sanity-checked on load, refuses bad series).
3. **Monte Carlo**: block bootstrap (default 5-year blocks) sampling *joint*
   stock/bond/bill/CPI rows — cross-asset correlation and inflation linkage preserved.
   Seeded mulberry32; identical seed ⇒ bit-identical results.

Every run is stamped with engine version, seed, and content hashes of
profile/assumptions/plan; `runs/<runKey>.json` is the cache. Runs always send the plan
inline (`RunRequest.scenario`) — the server never resolves it from disk.

## Solvers (SPEC §9)

Solvers are not configured anywhere: they are what the Workbench's **Explore** buttons run,
against a copy of the plan with the matching sweep attached (`scenarioWithSolver`). A plain
run always has its solver stripped (`scenarioForPlainRun`), so a solver pasted into the Raw
JSON editor can never silently turn "run the plan" into a sweep. Each sweep clones the plan
and sweeps one dimension through repeated engine runs:
retirement-year sweep (+ per-year max-spend bisection), single-date SS claiming sweep
62→70 monthly (person 2 is spousal-gated so the household has one claim decision),
spending-vs-success SWR curve, max-spend bisection, earliest safe retirement year.

## Phase 6 readiness

Per-person fields everywhere (accounts have owners, SS is per person, ages are arrays);
nothing hardcodes "couple" except the MFJ filing status, which is a typed field ready to
grow `single` for survivor mechanics.
