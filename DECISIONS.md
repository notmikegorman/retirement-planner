# DECISIONS

Why the planner is built the way it is. Companion to `ARCHITECTURE.md`.

## Process

- **Built without pause points.** SPEC §"How to work" asks for PLAN.md approval and
  per-phase check-ins; the standing instruction was: build everything end to end, no
  questions, encode unknowns as editable Profile inputs, summarize assumptions at the end
  (`ASSUMPTIONS.md`). PLAN.md still exists for the phase mapping.
- **VERIFY items** were checked against primary sources on 2026-08-12 by a parallel
  research pass (see `VERIFICATIONS.md`) instead of pausing to ask. This caught
  a real change model knowledge would have missed: SC's H.4216 (March 2026) restructuring.

## Stack choices

- **Fastify over Express**: first-class JSON, faster, cleaner async error handling.
- **`tsx` as the runtime** instead of a server compile step: one fewer build artifact and
  no ESM/extension friction; the worker thread is spawned with `execArgv: ['--import','tsx']`.
  UI is still built (Vite) so `npm start` serves static files.
- **Zod instead of hand-rolled JSON Schema**: SPEC asks for "JSON Schema validation on
  load" — the intent (validated loads, helpful errors, never crash) is met with zod,
  which also gives the TS types for free and runs identically in UI (raw-JSON editor
  validation) and server. Deviation noted deliberately.
- **No router library**: four pages, one shell, props-based navigation (and no route
  params — there is nothing left to preselect). Fewer deps.
- **Recharts** per SPEC. **mulberry32** for the seeded RNG: tiny, fast, well-known.
- **Content-hash run cache** (`runs/<sha256>.json`): reproducibility stamp and cache key
  are the same thing; `stableStringify` (sorted keys) keeps hashes platform-stable.

## Modeling decisions (beyond SPEC §5's listed simplifications)

- **Start year 2026**: tax data base year; runs starting later still index from 2026.
- **59½ with annual steps**: penalty-free status begins the year *after* attaining 59½
  unless attained in the first half of the year. A March-1975 birthday attains 59½ in
  Sep 2034 ⇒ 2034 distributions are still "early", 2035 is free — the conservative
  reading of the pre-59½ bridge in SPEC §4.2.
- **401(k) → IRA rollover at separation** (the modelled plan's shape): every scenario rolls the
  401(k) into the traditional IRA in the retirement year. Rule of 55 is therefore **not
  modeled at all** — the exception is lost on rollover, and it only ever applied to money
  left in the employer's plan. The consequence is deliberate and material: retiring before
  59½ has no penalty-free 401(k) door, so those scenarios depend on taxable/savings
  assets, Roth contribution basis, or a 72(t) SEPP.
- **72(t) / SEPP** (the key early-retirement mechanism): `start_72t` computes a real
  fixed-amortization payment — `P = B × r / (1 − (1+r)^−N)` on the post-rollover balance,
  `r` defaulting to 5% (Notice 2022-6 permits the greater of 5% or 120% of the federal
  mid-term rate), `N` from the IRS single-life table — then **forces** that fixed payment
  every year, like an RMD, through the later of five years or 59½, blocks any extra draw
  from that account during the lock (which would bust the exception), and releases it
  afterward. An optional `annualAmount` below the formula maximum triggers the standard
  **split-the-IRA technique**, and the engine models the split literally: it carves the
  account into a SEPP IRA (`<id>-sepp`, sized so that its *own* formula maximum is the
  requested payment) and a remainder that keeps the original id and stays an ordinary,
  fully accessible traditional IRA — penalized before 59½ like any other. Only the
  carve-out is locked, so sizing a SEPP *smaller* never strands the rest of the balance.
  With no `annualAmount` (or one at/above the maximum) there is no split and the whole
  account is the series. Interest-rate ceilings and the single-life table are verified
  data, not constants in code.
- **The 72(t) is automatic, and ON by default** (`Scenario.autoSepp`; **absent means on**):
  there is no early-retirement plan in which the household would decline penalty-free access
  to pre-tax money, so the engine elects the series itself rather than making it something
  you must remember to add. Anyone who stops working in a year before their own penalty-free
  year gets an election in that retirement year, on their largest traditional IRA — i.e. the
  account the 401(k) rolled into earlier the same year, so the payment is computed on the
  merged balance.
  - **Sized to the plan, not to the formula maximum**: the payment is the projected full-year
    cash need (living + charitable + housing + health + taxes − Social Security, interest,
    dividends, one-off income − cash/taxable balances spread across the years to 59½),
    resolved by a short gross-up loop because taxes and the ACA credit depend on the answer.
    The maximum would force out far more ordinary income than the household spends, at a
    higher marginal rate and against the ACA cliff.
  - **Split to that payment**: only the principal the payment requires is carved into the SEPP
    IRA; the rest stays ordinary and accessible. The payment is still capped at the whole
    account's formula maximum, so a need above that maximum takes the maximum and leaves
    nothing outside the series (a baseline spending level can do exactly this).
  - **An explicit `start_72t` wins**: a person who wrote their own election keeps exactly it,
    and gets no automatic one. The scenario field `autoSepp: false` turns the automatic
    election off entirely (and reproduces the pre-change engine bit for bit); the Plan card's
    "Use a 72(t) SEPP to reach 59½ penalty-free" checkbox is the only thing that writes it,
    and it writes only the `false` — checking it removes the key so the default stays implicit
    in saved JSON.
  - The retirement year fires `auto-sepp` (chip: "72(t) SEPP started automatically") and every
    paying year's tax trace shows the amortization inputs.
- **Surplus cash in a retired year is reinvested, not parked**: once nobody earns, the year's
  leftover cash sweeps into the taxable brokerage (balance *and* cost basis, since it is
  after-tax money buying shares), falling back to savings only when the household holds no
  brokerage account. This follows from the forced nature of a SEPP: a payment that exceeds the
  year's spending is, in real life, taxed and bought back in a brokerage account — parking it
  at the T-bill rate would understate every plan that produces surpluses, which once the
  automatic bridge runs is most of them. **This applies only after the last paycheck** — see
  the next entry.
- **Leftover cash WHILE WORKING is consumed, not accumulated** (owner request, note 20): in any
  year someone earns a salary, the only thing that accumulates is the explicit
  `investingMonthly` transfer. Whatever the paycheck leaves beyond it enters no account and
  appears in no balance; it is recorded on the YearRow as `unbudgeted` and shown in the
  cashflow breakdown as "Unbudgeted / not invested".
  - *Why*: `livingMonthly` is a **budget baseline**. It does not carry the irregular, lumpy
    costs a real year brings — replacing an air conditioner, a car repair, a trip, home
    maintenance above the modeled percentage — and those are precisely where the leftover of a
    paycheck goes. Treating income above the baseline as investable surplus assumes an
    accumulation that does not happen and flatters every result. The instruction was blunt: assume only the
    amount the profile says is invested.
  - *The retirement year takes the working rule whole*, not a proration. Living, giving,
    investing and retirement income are per-month flows, so splitting them by worked months
    means something; a surplus is one undifferentiated pool of year-end cash mixing part-year
    salary with any forced distribution, so prorating it would assign salary dollars to the
    retired rule in whatever ratio the calendar produced. The conservative reading is also the
    one that states in a sentence: in any year a paycheck arrives, leftover cash is consumed.
  - *Shortfalls are untouched*: when income cannot cover taxes + expenses + the explicit
    investing, the withdrawal machinery runs exactly as before, and the investing transfer
    stays capped by available cash so it can never itself create a withdrawal.
  - *Consequence worth knowing*: working an extra year no longer builds the portfolio by
    itself. It postpones the drawdown and adds 401(k) contributions and the investing stream —
    nothing more. Two solver calibrations in `tests/engine/solvers.test.ts` had to be re-based
    on that (they previously leaned on the swept salary surplus).
  - *Cash identity*: `income + gross withdrawals = expenses.total + taxes + investing + banked
    living reduction + swept + unbudgeted + purchase outflows`. At most one of `swept` /
    `unbudgeted` is non-zero in any year, and recording the consumed amount is what keeps the
    identity exact instead of letting the money disappear into a rounding gap.
  - **THE ONE EXCEPTION — between sale and purchase, cash is banked, not consumed** (owner
    request, note 24): while a sale has happened and a purchase is still PENDING (the compiled
    sale month through the month before the purchase — and only then: a plan that rents to the
    horizon has no "soon" and keeps the consumption rule everywhere), money needed for the
    imminent purchase must not be in stocks and must not evaporate as unbudgeted spending. So
    (a) the `investingMonthly` stream's in-window share is redirected into SAVINGS instead of
    the brokerage, and (b) the living reduction the budget's renting column frees — in-force
    living minus renting living, month-prorated, when positive — is banked into savings as
    well, capped at the year's actual leftover so it can never force a withdrawal. Sale
    proceeds already sit in savings earning the cash yield and are not touched (that would
    double-count). *Why the override*: the working-year consumption rule exists because a
    budget baseline does not carry a real year's lumpy costs; a household deliberately living
    lean in an apartment to buy its next house is doing the opposite of that — the reduction
    is a decision with a destination, and consuming it would silently defeat the reason the
    renting column was typed. The banked amounts are recorded on the YearRow (`banked`) and
    the whole funding story on `RunResult.purchaseFunding`, which the Housing card's
    cash-at-purchase readout shows.
- **Roth ordering**: contributions → conversions (per-conversion 5-year clocks pre-59½)
  → earnings; the account-level 5-year clock is assumed met (accounts long open).
- **Dividends/interest as cash**: taxable-account stock sleeves pay the dividend yield as
  qualified dividends, bond/bill sleeves pay their return as ordinary interest; both are
  spendable cash and excluded from compounding to avoid double counting. Retirement
  accounts compound fully.
- **Net capital losses**: capped at $3,000 against ordinary income, no carryforward
  (engine sells long-held VTI with big embedded gains; losses are edge-case noise).
- **ACA**: household buys the benchmark silver plan (credit = benchmark − expected
  contribution, net premium = gross − credit); the profile's quote is scaled by the federal
  age curve and CPI+medical-trend. Medicaid expansion is modeled per state: in VA/NC
  (expansion states) a household below 138% FPL is Medicaid-enrolled at $0 premium (and
  not PTC-eligible); in SC (never expanded) the below-100%-FPL coverage gap is real —
  full premium, no credit — each with an explanatory trace line. Under the
  enhanced-credits toggle the ARPA percentage schedule applies instead. The quote is
  location-fixed — move scenarios keep the origin-state benchmark (documented on the
  Methodology page). Employer coverage assumed $0 while either works.
- **Medicare premium growth** = CPI + `medicalInflationRealSpread` (default +2% real);
  IRMAA MAGI *thresholds* index by plain CPI per SPEC §7.
- **VA specifics**: personal exemptions ($930/+$800 65+) and the age-deduction AFAGI
  phaseout are modeled; VA's requirement to mirror the federal itemize/standard choice is
  not (VA standard deduction always) — documented simplification.
- **SALT**: OBBBA cap schedule (through 2029, $10k after) including the 30% phase-down
  above ~$505k MAGI, though the household rarely approaches it.
- **OBBBA senior deduction (2025–2028)**: not modeled — both owners turn 65 in 2036.
- **PMI**: buy-house financing below 20% down adds 0.5%/yr of loan balance (the shipped
  scenario uses 20% down precisely to avoid it, per SPEC §9.3).
- **Solver inner runs** cap at 2,000 MC paths per probe to keep sweeps interactive;
  the headline run of a scenario still uses the requested path count.
- **Three expense streams instead of one** (owner request): living, charitable, and
  investing are tracked separately because they behave differently in retirement. Living is
  consumption. Charitable is consumption that is *tax-relevant* (it feeds the OBBBA
  non-itemizer deduction and the 0.5%-of-AGI itemizer floor) and scenarios can change or
  zero it independently. Investing is **not an expense at all** — it is a transfer into the
  taxable brokerage (raising basis), capped by actual surplus, that stops when the paycheck
  does. The employee share of the employer health premium is likewise not budget spending:
  it is a pre-tax payroll deduction that reduces W-2 wages, exactly like the 401(k) deferral.
- **Giving after the last paycheck is a selectable rule** (owner request): the two
  salary-funded streams behave differently once nobody earns. **Investing self-terminates** —
  it is driven by the months anyone worked, so it has no base left — while **charitable giving
  does not**: left alone it runs for life. The profile therefore carries
  `expenses.retirementGiving` with four rules — keep giving the same amount (the default, and
  what an absent field means, so every profile and scenario written before the field existed
  is bit-for-bit unchanged), stop giving, a percent of real portfolio growth, or a percent of
  income drawn — and any scenario can override it
  (`assumption_overrides.expenses.retirementGiving`) so two rules can be compared side by
  side without editing the household's own answer. The rule takes over on the same
  worked-months signal that stops investing, and the retirement year is prorated between the
  paycheck stream and the rule. **The percentage rules read the PRIOR year** because this
  year's growth and withdrawals both depend on this year's spending, which would include the
  giving — a circular definition the withdrawal/tax fixed point cannot resolve; it is also the
  figure a person actually has in hand when deciding what to give. A down year gives $0 (never
  a negative gift); optional smoothing averages the last N years and an optional cap limits
  the monthly result. **Every rule keeps feeding the charitable tax deductions** — the giving
  lands in `expenses.charitable`, the expense total and `TaxYearInputs.charitableGiving`
  exactly as the paycheck stream did, so the OBBBA non-itemizer deduction and the
  0.5%-of-AGI itemizer floor are unaffected by the choice. Which rule is right is the user's
  call, not the model's; the app states the mechanics and prices them.
- **Two PIA figures per person**: SSA statements assume you keep working, which overstates
  early retirement. The profile holds both the statement figure (working to 62) and the
  $0-future-earnings figure, and the engine interpolates linearly by retirement year — so a
  retirement-year sweep no longer prices every year with the same benefit. Linear is a
  simplification; the real AIME is a concave 35-year average.
- **Target-date funds glide themselves**: an account marked `targetDateFund` follows an
  approximate target-date-fund path (current mix → 50/50 at the target year → 30/70 seven years
  later, then hold) rather than sitting frozen. Allocation events can target a single
  account, which also switches that account's auto-glide off.
- **Reference path**: every run (any mode) also computes a deterministic companion path
  with full tax traces — that is what the cashflow table, tax audit trail, and MAGI chart
  display; fans/success come from the stochastic paths.

## One plan, saved as you go

The app used to keep a *library* of scenarios: a folder of named files, a dropdown to pick
one, name and description fields, a dirty indicator, and Save / Save as new / Revert /
New / Delete. All of that is gone. The requirement that replaced it:

> The app does not need to support "scenarios". The only scenario that matters is the one
> being worked on right now, and there will only ever be one. What is wanted is knobs on
> the left, saved to a JSON file on every change, so that re-opening the app always picks
> up where the last session left off. Exploring a what-if means adding and removing
> events on that one plan, not filing a copy of it.

- **What-ifs are edits, not files.** Adding and removing events *is* the what-if. Naming,
  filing and re-opening a variant was overhead that bought nothing for a household of one
  planner who only ever looks at the current plan.
- **A before/after is a pinned baseline, not a second file.** The results column already
  measures every change against the previous run, or against a run you pin — which is the
  comparison the old Compare page was for, without leaving the page, re-running two
  scenarios, or keeping a stale file around to be the "before". **The Compare page is
  therefore deleted**: with one plan there is nothing to compare it against.
- **No Save button, because there is nothing to save *to*.** With one plan there is no
  "which file?" question, so a manual save is pure ceremony. The same debounced signal that
  re-runs the simulation also PUTs `plan.json` — one debounce, both effects. Run settings
  (mode, paths, seed) are *not* part of the plan and are not saved, so changing the seed
  re-runs without writing.
- **Autosave has to be loud when it fails.** With no manual save to fall back on, a
  swallowed error would mean turning knobs into a file that stopped being written. The
  status line where the Save button used to be turns into an error banner naming the
  server's own message, with a Retry, and it survives navigating away and back. Leaving the
  page inside the debounce window flushes the write on the way out, and the next load waits
  for that flush before reading the file back.
- **The plan starts empty.** A fresh `plan.json` carries the three plan decisions at their
  defaults (each person stops working at 62, the household claims at FRA, allocation
  unchanged) and nothing else. Pre-loading a demo plan would just be something to delete.
- **The plan is never named.** `Scenario.name` still exists because the engine's contract
  requires it, so the server pins it to `"Plan"` on every write. It is not shown or edited
  anywhere.
- **An existing `scenarios/` folder is left untouched** — not read, not written, not
  deleted. Events can still be lifted out of those files by hand through the Raw JSON
  editor, which is why that escape hatch survived the gutting.

### Amendment: the cabinet came back, for search output only
### — and went away again on 2026-08-20; see "One plan again, and its history" below

The reasoning above was right about **hand-editing** and is unchanged there: the workbench
still has exactly one plan, still autosaves it, still has no dropdown, no dirty flag and no
Save button. What it was wrong about is **generated** plans. The case it had not seen:

> The best-scoring version of a plan might turn on whether to elect a SEPP, whether to move
> the portfolio mix and in which year, whether to do it at once or glide it, and a hundred
> other decisions. Nobody is going to hand-run a hundred plans to find the best sequence of
> twelve decisions — but a machine can.

A search produces six finalists. They have to go somewhere, and comparing them is the entire
point of running one — which is the case the original decision did not have in front of it.
So `scenarios/` is a filing cabinet again (`src/server/scenarioStore.ts`, six routes under
`/api/scenarios`), with three constraints that keep it from drifting back into scenario
*management*:

- **It holds scored plans, not edits.** A record is a name, the plan, and the metrics it
  last scored. Nothing writes to it as a side effect of turning a knob.
- **Every stored metric carries its provenance** — engine version, mode, path count and the
  exact seed list. `ENGINE_VERSION` is part of the run-cache key precisely so a number from
  one engine is never compared against one from another; a cabinet of bare numbers next to
  names would reintroduce that bug one layer up, where no cache key can catch it. A record
  scored by an older engine is flagged stale rather than shown as comparable.
- **The old files are still the user's.** The ten of them are migrated *on read* into the
  current shape and never rewritten; a file that cannot be parsed comes back in the list
  response's `problems` array with its reason instead of taking the list down.

## Two cells per stream, and the prose behind a "?"

The Spending card used to be three single boxes stacked under three paragraphs of
explanation, with a separate "Giving after you stop working" block at the bottom. The
requirement that replaced it:

> Living expenses, investing and charitable giving should each be TWO values side by side —
> the left one the amount in play while working, the right one the amount in play after
> work stops. Then there is no need for a separate "Giving after you stop working" section
> at all. And the verbose per-field explanations should move into "?" icons beside the
> fields, with a CSS tooltip, so the card stays compact.

- **The pair IS the decision.** "We spend 8,000 now and expect to spend 7,000 then" is one
  thought, and splitting it across two places is what made the retired side forgettable.
  One row, two cells, the ×12 under each.
- **An empty right-hand cell states its default in words** — "same as working", "stops",
  "none" — because the defaults differ per stream and a blank box that silently means three
  different things is worse than no box at all.
- **Giving keeps its rule; it just loses its section.** The rule was never the problem — a
  tithe on real portfolio growth scored 53-57% success against 42% for a flat amount on
  a representative over-funded plan, and smoothing it over three years was nearly free. What was wrong was
  its *placement*: giving's after-work answer belongs in giving's after-work cell like
  everything else's. So the selector moved into that cell (**and gained an `Amount`
  variant**, which is what most people reach for first and previously had to be faked by
  editing the working-years figure), and whichever parameters the chosen rule needs appear
  under the row — only for the rule that uses them.
- **Income gets the same shape, with one honest asymmetry.** Left is read-only: salaries
  and the 401(k) are payroll facts the profile owns, and the only thing a plan decides
  about them is the date they stop (a retire event). Right is the knob the card exists for
  — "what if I picked up two days a week of consulting?" — which on a typical plan moves
  the verdict more than almost anything else on the page.
- **Verbose help moved behind a "?", short hints did not.** "Agent fees etc." and "Goes
  into the 401(k), not wages" stay inline, where hiding them behind a click would cost more
  than it saves. Paragraphs — what living expenses exclude, how the growth rule computes,
  what the earnings test does not model — moved into tips. The panel lost roughly a third
  of its height without losing a word.
- **The tooltip is CSS, and its positioning is the interesting part.** Reveal is `:hover`
  plus `:focus-within` on a real `<button>` (Tab reaches it, Escape closes it, and it is
  out of flow so showing it never moves the page). The bubble takes its VERTICAL position
  from the static position — directly under its "?" — and its HORIZONTAL extent from the
  card, because `.wb-panel` is a `position: sticky` scroll container and therefore both the
  containing block and the clipper: a 300px bubble hanging from a "?" halfway across a
  400px panel would simply be sliced off. `position: fixed` was tried first and rejected —
  a fixed box keeps the static position it was laid out at, so the bubble detaches from its
  "?" the moment the panel scrolls. Hidden state is `display: none`, not
  `visibility: hidden`, so a hidden bubble beside a right-hand field cannot give the
  document a horizontal scrollbar.

## The URL is the navigation state

Every view has a path — `/workbench/cashflow`, `/profile/expenses`, `/search/report` —
where the first segment is the page and the second is that page's tab. Before this, the
page was a `useState` and each tab strip was a localStorage key: refreshing on the
Profile's Expenses tab came back on the Workbench, nothing could be linked or bookmarked,
and the back button did nothing at all.

- **Hand-rolled against the History API** (`src/ui/nav.ts`, ~90 lines of logic plus one
  hook). react-router is a dependency, a bundle, and a mental model for what is five pages
  and three tab strips with no params, no loaders, and no nested layouts.
- **Read on load, `pushState` on navigation, re-read on `popstate`.** The route is only
  ever *read* on popstate — writing there would fight the history stack that is reporting
  the move.
- **Navigating to the URL you are already on replaces instead of pushing.** Clicking
  "Profile" three times while on Profile would otherwise cost three presses of Back to
  leave the page, which is the standard way a hand-rolled back button becomes useless. A
  view change the reader did not ask for — the Search page swapping to the report when a
  run it started finishes — replaces for the same reason.
- **The URL wins; localStorage is the fallback for a tab the URL does not name.** One
  function (`resolveTab`) owns the order, because two sources of truth for one piece of
  state is how this kind of code rots. A link to `/profile/expenses` opens on Expenses for
  whoever clicks it; a bare `/profile` restores the tab that browser was left on, so a
  session in flight does not lose its place. Storage is read **once per app load**, in
  `useRoute`, and handed down as a prop — every tab click writes storage, so any later read
  returns what this session just wrote. Reading it per render, or even at each *page's*
  mount, makes Back appear to do nothing: leaving `/workbench/cashflow` for the Profile and
  pressing Back twice remounts the Workbench, refreshes the read to `cashflow`, and the
  press that reaches the bare `/workbench` resolves straight back to the tab it was meant
  to leave. Pinning the snapshot to app load is what keeps every Back that changes the URL
  also change the screen.
- **One tab segment per page, which leaves the Workbench's LEFT panel out of the URL.**
  The right-hand strip names *which answer you are reading*, which is the thing worth
  sending someone; the left names where your hands are, which travels with the machine.
  Confirmed (2026-08-16): the left panel stays out of the URL — do not
  re-raise it.
- **Nav items stay `<button>`, not `<a href>`.** Middle-click / open-in-new-tab was offered on
  open-in-new-tab on the nav and tab strips and declined (2026-08-16). Every view still
  has a real path for refresh, Back and deep links; anchors would add only multi-tab
  opening, which is not used here. Do not re-raise it.
- **Unknown paths resolve rather than 404.** `/` and anything unrecognised is the
  workbench; a tab segment the page does not have falls back to that page's own memory. On
  load the address bar is rewritten (with `replaceState`) to the resolved path, so stale
  links clean themselves up instead of lingering as a URL that lies.
- **Deep links reach the app** because Fastify's `setNotFoundHandler` already sends
  `index.html` for non-`/api/` paths, and Vite's dev server does the SPA fallback by
  default. Both were verified against a running server, not assumed.

## Placeholder values

Every FILL_ME_IN became an editable Profile field with a plausible placeholder —
deliberately *plausible* rather than blank so the app produces a real answer on first
launch. Full list with rationale: `ASSUMPTIONS.md`.

## The tithe account's soft window (engine 1.13.0)

The defer window is designed to move the tithing DRAG past the fragile first years
of retirement. The first implementation moved only the DELIVERY: the seed removed spendable
money on retirement day — the worst possible moment — and only the cash flow was deferred,
so the drag was front-loaded to exactly the years the window existed to protect (measured:
97.7% household success with the hard lock). The rebuild makes the deferral mean what it was
designed to mean, in three defaults:

- **The soft window, and the pot as the account of LAST RESORT.** Through the deferral the
  carve-out counts in spendable assets and the success metric, and the withdrawal order may
  reach it — after *every* bucket the policy names, Roth included, because a promise is the
  last money touched (the decision is documented on `computeWithdrawalPlan`, where the order
  lives). A draw shrinks the pot permanently: the break-glass behaviour made automatic. The
  lock — out of spendable, out of the metrics, untouchable — engages only when cash giving
  starts. Consequence for the break-glass figure: it keeps meaning "what sat in the account
  when a failing path first fell short," which is now ~0 for soft-window failures (the path
  drained its last resort before falling short) and a real number only when the plan failed
  after the lock.
- **`distributeYears` defaults to 10, paying balance / years-remaining.** The accrued pot is
  a gift, not an endowment: once the window closes it reaches charity over a decade — long
  enough that each instalment (~a tenth of the pot) does not spike one year's AGI, which
  drives the ACA credit, IRMAA and Social Security taxability; short enough that the money is
  given in life rather than at the horizon. Balance-over-years-remaining (the RMD's own
  annuitisation) beats a flat pot/N because the pot keeps growing while it distributes, and
  a flat instalment would strand that growth in the account forever; this way the pot is
  exactly empty on schedule. Instalments run ON TOP of the trailing percent-of-new-highs
  stream, and both feed the charitable deduction.
- **`earlyRelease` defaults to TRUE, triggered by a new REAL spendable high.** The deferral
  exists to shield the fragile years, not to delay giving for its own sake — so once a path
  closes a year above the real spendable balance it held at the end of its first retired
  year, the fragile window is provably over and distribution (and the lock) start the next
  year. Real, not nominal: a nominal high is set in almost every mildly-inflationary year
  and would make the trigger meaningless. `false` opts into waiting out the full calendar.

Micro-decisions made in the build, each commented at its site in `src/engine/simulate.ts`:

- **Instalments are honest IRA distributions**: ordinary income, and penalized before the
  account owner's 59½ year (an early release can genuinely start the payout before 59½; pretending
  the tax code steps aside would understate the cost — conservative, and consistent with the
  documented no-QCD simplification).
- **The RMD keeps its priority**: a required distribution forced out of the carve-out is
  still given away in cash whatever the phase (soft or locked — promised money is promised
  money), and a distribution-year instalment divides only the balance net of that year's
  RMD share, so the same dollars are never distributed twice.
- **The distribution clock is a calendar, not a balance**: `distributeYears` counts down
  even through years the pot had nothing to pay, rather than stretching "over ten years"
  into "forever" whenever an emergency had already drained it.
- **The growth stream still starts the year AFTER the lock** (the lock year's own base was
  the last one accrued — paying cash on it would tithe the same growth twice), but the lock
  year is no longer silent: it pays the pot's first instalment, so cash giving genuinely
  begins when the deferral ends.
- **The release trigger measures the recorded spendable-real series** (pot included, since
  the soft window counts it): accruals are intra-portfolio and cannot move the measure, and
  the mark is the first retired year's close — comparing against it alone is exactly
  "a new high of the series," because any earlier exceedance would already have triggered.
- **A window still open at the horizon reports the pot in BOTH terminal wealth and the
  charitable legacy.** They answer different questions — "could the plan have reached it in
  life" (yes, it was the last resort) and "where does it go at death" (charity) — and
  suppressing either would misstate its answer. In practice a typical set of defaults locks
  and empty the pot decades before the horizon, so the overlap is a corner, not a headline.

## The two-knob giving split (engine 1.16.0)

**Design decision.** The bundled `tithe_account` rule fused two decisions a user thinks
about independently: (1) what to do with the **un-tithed pot** — 10% of
~$950k of never-tithed gains, seeded at retirement, held soft through the fragile years,
paid out over a window, remainder to charity at death; and (2) how to **tithe going
forward** — a percent of growth at new real highs, a percent of income drawn, a fixed
amount, or nothing. Bundled, choosing any ongoing method other than the tithe account
silently meant "no pot at all," and the pot could not be configured beside a different
ongoing method. The decomposition:

- `retirementGiving` keeps its non-pot variants as **the ongoing method**
  (`OngoingGivingRule`; the engine's `PreparedSim` carries only this, by type).
- `expenses.untithedPot` (`UntithedPotPolicy`) is **the pot**: `percent` (absent = 10%),
  `holdYears` (the old `deferYears`), `distributeYears` (absent = 10), `earlyRelease`
  (absent = true), `seedFromGains` (absent = true), and the one NEW capability —
  `ongoingDuringHold`: `accrue_to_pot` (absent = this, the bundled behaviour) or
  `give_cash`, which pays the ongoing method in cash from retirement day, fully
  independent of the pot. Absent `untithedPot` means no pot, exactly like every profile
  that never chose the bundled rule.
- The pot composes with ANY ongoing method. Only a growth tithe has anything growth-shaped
  to accrue, so under any other method the hold defers the POT alone and the method pays
  its own cash throughout (documented at the accrual site in `simulate.ts`).
- **With a pot present, the ongoing `percent_of_growth` runs on the high-water-mark
  new-real-highs base** — that is what the bundle's stream always was, and it is what the
  owner means by "percent of growth at new real highs." Without a pot it keeps its plain
  prior-year-growth base, so every existing non-pot plan is bit-for-bit unchanged (the
  golden digests held without a re-pin).

**Migration semantics** (`dataStore.migrateGivingSplitFiles`, run once at startup before
anything is served; migration lines print at startup as usual):

- Profile `tithe_account` → ongoing `percent_of_growth` (same percent) + `untithedPot`
  carrying `percent`/`holdYears`/`seedFromGains` explicitly (they were required fields of
  the bundle — owner-chosen values) and `distributeYears`/`earlyRelease`/`allocation` only
  when present, so "on the default" survives as an absent key. `ongoingDuringHold` is
  omitted: absent = `accrue_to_pot` = the bundled behaviour, which is why that default was
  chosen.
- A non-`tithe_account` profile rule migrates to itself + no pot.
- **Scenario overrides are the trap.** Under the old model an override REPLACED the whole
  bundled rule, pot and all; under the new semantics an absent override pot INHERITS the
  profile's. So the one-time pass rewrites every pre-split override: a bundled override
  becomes ongoing + an EXPLICIT pot (which supersedes the profile's, as replacement always
  did), and a non-tithe override gains the explicit `untithedPot: { "enabled": false }` —
  never left pot-absent, which would quietly resurrect the pot the override was
  suppressing. A real saved plan.json carried exactly this shape.
- **The trap rule is gated on proof the folder predates the split**: profile.json still
  carrying the bundled rule at pass time. The same pass then migrates the profile itself,
  erasing the gate — so a bare ongoing override written by the new UI afterwards (meaning
  "inherit the pot," legitimately) can never be re-clobbered by a later startup. The
  engine's `resolveGivingPair` in `prepareSim` is the boundary safety net for anything
  that never passed through the store (old cabinet files loaded raw, search axis levels,
  tests): a bundle normalises there and never governs a simulation year.

**Equivalence requirement, pinned.** A scenario using the old bundled rule and the same
scenario using its migrated pair are BIT-IDENTICAL — digest equalities in
`tests/engine/tithePair.test.ts` across deterministic and Monte Carlo modes, seed on/off ×
early-release on/off, plus the bundle-as-override case; and the entire pre-split note-21
suite (seed arithmetic, high-water mark, defer window, disbursement, trace labels, pinned
dollar values) passes unchanged with the bundle fed straight to the engine. The split moved
the knobs, not what they do.

Micro-decisions in the build, each commented at its site:

- **The seed is sized by the pot's own `percent`; the accrual and the trailing stream by
  the ongoing rule's.** The bundle used one number for all three; the split writes it into
  both knobs on migration (hence identical digests) and lets them diverge from here on.
- **A carve-out account opens only when something can enter it** — the seed, or an
  accruing growth-tithe hold. A give-cash pot with the seed off, or a seedless pot beside
  a non-growth method, opens nothing (structurally empty), while the cash streams run.
- **`percent_of_income` beside a pot excludes the pot's own flows from its base** — the
  distribution instalment is never added and the carve-out's forced-RMD gift is backed
  out. Never tithe the tithe, income edition; unreachable under the bundle, so no pinned
  digest could move.
- **The growth cap composes with the high-water-mark base; smoothing does not** (averaging
  a window of new-high increments would feed the same increment into several years'
  gifts). The Tithing tab hides the smoothing box when a pot is on, so no live-looking
  control is wired to nothing.
- **The auto-72(t) bridge prices giving under a give-cash hold at the paycheck level for
  every bridge year** (the high-water base has no history at election time), where an
  accruing hold keeps the old formula: zero for the hold years, paycheck level beyond.
- **The Workbench Tithing tab's pot toggle writes the explicit disable** — unticking on a
  profile WITH a pot must survive as an override, and absence would just inherit it back.

## The 72(t) wall becomes a price (engine 1.17.0)

**The incident that forced it.** A plan retiring 2026-10 with a scheduled $1,200,000 cash
house purchase in 2028-06 and `autoSepp` on scored **0.0%** — every path flagged insolvent
in 2028 while holding $1,142,880 of spendable assets. Mechanism: the 2026 automatic
election sized its payment to the bridge need (~$72k/yr) and carved the principal that
payment required (~$1.3M of the ~$1.9M IRA) into the locked SEPP IRA. The 2028 purchase
needed ~$950k from the IRA; the accessible remainder held ~$600k; the locked account held
$1.3M the engine refused to touch; the year booked an unmet need, the path was stamped
insolvent — and then continued for decades with $1.6M+. The identical plan with `autoSepp:
false` scored 69.6%. An option that exists to HELP can only sanely reduce the score by
roughly its penalty costs, never to zero. Two fixes, both required, each independently
load-bearing (`tests/engine/seppCalendarBust.test.ts` mutation-tests the pair).

**Fix A — the election respects the calendar.** At auto-election time the engine computes
the committed one-off outflows falling inside the prospective lock window (later of five
payments or 59½): numeric-price house purchases above all, plus one-time expenses;
`sale_proceeds` cash purchases stay excluded as residual claims, exactly as in the bridge
sizing. The un-carved remainder must be able to PRODUCE what cash on hand and projected
sale proceeds cannot cover — produce, not merely equal: a pre-59½ IRA draw delivers ~half
its face value at purchase size (top brackets + state + the 10% penalty), and the capped
payment no longer carries the full-year need, so the reserve grosses the gap up (flat 40%
marginal stand-in + the penalty rate) and adds the living top-ups through the purchase
year. Payment is linear in principal, so the largest safe principal solves in closed form.
A cap that zeroes the payment DECLINES the election that year; the existing
offer-every-bridge-year machinery re-tests it annually. Declines and caps are stated in
the election-year trace.

**Fix B — busting the series is a price.** When the withdrawal solve cannot meet the year
need after every unlocked source — including the tithe pot's last-resort seat, because a
promise absorbed is cheaper than a recapture — and a live SEPP still locks money, the
household BUSTS the series rather than failing: the lock lifts permanently (a modified
series does not resume, Rev. Rul. 2002-62 §2.02(e)), the draw proceeds under ordinary
penalty rules, and the year is charged the IRC 72(t)(4) recapture — 10% of every pre-59½
payment plus interest at the path's own T-bill return per elapsed year (a documented
simplification of §6601). Applies to hand-written `start_72t` series too: a series in an
impossible year busts with the price rather than failing beside its own money. The year
fires `sepp-busted`; the trace itemises prior payments, the interest-grown base, and the
tax. A path that fails even after busting fails honestly.

Micro-decisions in the build, each commented at its site:

- **The recapture rides the tax module's existing penalty machinery** — a zero-amount
  distribution slice whose `penaltyBase` is the interest-grown pre-59½ payments, so the
  one `earlyWithdrawalPenaltyRate` charges it inside `taxes.penalties` and the
  recorded-cash identity closes through a term it already had. No new YearRow field.
- **Payments made at/after 59½ are not recaptured** — they were never penalty-protected,
  so §72(t)(4) has nothing to claw back on them. The bust-year draw itself is penalized
  only under 59½, by the ordinary rules.
- **Among several live series, the one with the largest reachable balance busts first** —
  most relief per recapture bill; the loop returns for a second series only if the first
  was not enough.
- **The reserve projects a scheduled sale at TODAY's home value** (net of selling costs
  and payoff, no growth to the sale date): under-projecting proceeds can only over-reserve,
  and Fix B backstops a reserve that proves too small while nothing backstops a carve that
  proves too large.
- **A run that never busts walks a computation-for-computation identical path** — the bust
  loop wraps the existing fixed point without changing its no-bust arithmetic, which is
  what let every non-SEPP golden digest (mfjUnchanged, preExpenseLinesUnchanged,
  housingPlan, tithePair) hold without a re-pin.

## N sell→buy cycles, and the survivor's downsize (engine 1.19.0)

**The incident.** A plan with TWO hand-written sell/rent/buy cycles — the couple's own
move (sell 2027-06, rent a year, buy 2028-06 at $1.2M cash), a death the month after the
closing, then the widow's downsize written out by hand (sell 2029-07, rent 3 months, buy
2029-10 at $1.0M) — scored **0.0%**. `parseEvents` kept only the LAST `sell_house` (the
field was a single slot), so the first sale never ran; the household still owned the first
home when the $1.2M purchase arrived, and `buy_house` REPLACES a home still owned — so
~$1.05M of home-1 equity left the balance sheet without a sale, the year drained the IRA to
cover a purchase the sale was supposed to fund, and the auto-SEPP busted beside it. The
year's own fired-events list said "sell_house" while no sale ran, which is what made it
invisible by eye. Fixes, in dependency order:

- **Sales are a list.** `ParsedEvents.sellHouses` keeps every `sell_house` chronologically;
  the between-homes machinery becomes a LIST of disjoint windows (each sale claims the
  first unclaimed later purchase), and the renting blend, the note-24 banking and the
  investing redirect accumulate per window — the widow's window banks exactly like the
  couple's did. One sale parses to a one-entry list and one window, so every one-cycle
  plan is bit-for-bit unchanged (all pre-1.19 golden digests held without a re-pin).
- **A window only opens on a sale the engine will actually run.** The engine's granularity
  is one sale and one purchase per calendar year, sale step first. Three shapes therefore
  cannot execute — a second sale in an already-sold year, a sale in the year a spanning
  window's purchase lands (the home arrives after the year's sale step), a sale while
  between homes — and the pairing skips them, so the banking gates never open for months
  with no sale behind them. The events still appear in the fired list (they were written);
  they just move no money, which is the pre-existing rule for inert events.
- **The funding story narrates the FIRST window.** `RunResult.purchaseFunding` is the
  Housing card's cash-at-purchase readout for the plan's own move; a later cycle keeps
  every mechanical behavior but its story is not the one the card tells.
- **The 72(t) calendar reserve walks the cycles.** Fix A's sale projection used to credit
  one sale — the first scheduled before the first committed purchase. With two cycles the
  reserve counted BOTH purchases and one sale, grossed the phantom gap up for tax and
  penalty, and declined an election the calendar itself could fund. The walk now carries a
  projected home state (value, payoff, selling cost) through each scheduled sale and
  fixed-price purchase up to the LAST committed purchase: the second sale — of the house
  the first purchase buys, at its known price — is credited too. Sales after the last
  committed purchase fund nothing the lock window still owes; a residual-priced purchase
  projects a $0 later sale (under-projection stays the safe direction, and Fix B still
  backstops). Over a single cycle the walk visits exactly the years the old lookup did.

**The survivor's downsize** (`housing.survivorDownsizeTo`, `survivorDownsizeDelayMonths`)
is why N cycles had to work: it COMPILES a second cycle. `survivorPurchasePrice` answers a
death strictly BEFORE the purchase; this answers one at/after it — the two fields
partition the death timeline at the buy month, so no death can both re-price the purchase
and trigger a downsize. When a death lands at/after the buy month, the survivor sells
`survivorDownsizeDelayMonths` after the death (absent = 12: nobody lists a house from a
funeral) and rebuys at the stated price — cash, same month, because the sale of the larger
house is the funding — or, for `'none'` (and the 0-spelling trap, closed the same way as
the plan price's), rents to the horizon at the plan's `rentMonthly`. Conventions are the
survivor price's own: property tax NOT rescaled (the plan owns the figure), insurance from
`planInsuranceAnnual` at the downsize price (override wins, estimate otherwise). Because
it compiles to ordinary events, selling costs, the §121 exclusion (with the survivor's
two-year window), proceeds-to-savings and the withdrawal order all apply through machinery
that was already tested. A downsize sale landing in the purchase's own calendar year waits
for January — the compiler must not emit a shape the one-sale-one-buy-per-year engine
cannot execute (reachable: death in the buy month plus a 3-month delay). The Widow tab
states the assumption in BOTH directions — the downsize when the plan names one, and
"modelled KEEPING it for good; staying put is an assumption too" when it does not —
because a 93.0%-staying-put widow score with nothing on screen saying the survivor stayed put is
the 62.7% lesson all over again.

**Why now, in one sentence:** the term-insurance rule the feature exists for — hold both policies to the
2028 closing, cancel if the purchase is ≤ ~$1.3M — has an open branch above $1.3M whose
answer hinges on whether the survivor's downsize recovers their position, and a two-cycle plan
that mechanically breaks cannot price that branch at all.

## Holdings become the input, and the ledger beside them (2026-08-18)

**Requested on the day a real reallocation made the old shape untenable.** A holdings
account stopped being "a balance and a mix retyped after logging into the broker" and
became what it actually is — a list of positions: 1,838.501 VTI + 7,206 BND + $63.41 of
sweep cash. Three design rulings, each preventing a specific bug:

- **Derived values are REAL INPUT, resolved at one chokepoint.** An account with
  `holdings` gets its balance and allocation computed from `quotes.json` inside
  `dataStore.loadResolvedProfile()` — the single function the run manager, the search
  manager, the scenario cabinet's staleness hash and `GET /api/profile` all read. One
  chokepoint because the alternative is two surfaces disagreeing about what the IRA is
  worth; and the derived figures feed the run-cache key, so a price refresh correctly
  reprices the next run instead of hitting yesterday's cache entry. The stored
  balance/allocation on a holdings account stay REQUIRED as the last-resolved cache — the
  engine's arithmetic reads them unconditionally and src/engine is not editable land — and
  resolution simply overwrites them wherever the numbers matter.
- **Runs never fetch; a missing quote is a refusal, not a guess.** Prices enter only
  through POST /api/quotes/refresh (Yahoo's chart endpoint, one small injected-fetch
  function so a second source could slot in; 10s per symbol; per-symbol failures reported
  per symbol so one delisted ticker cannot take down the batch; non-USD rejected with the
  currency named — the model is USD-only). A run whose symbol has no stored quote fails
  naming the symbol and the fix. The one outcome worse than that error is a simulation
  quietly priced at last month's close, wearing today's timestamp.
- **An account with ANY unpriced symbol keeps its stored figures WHOLE.** Half-derived
  (two of three funds repriced) would be a balance that is neither yesterday's truth nor
  today's, with nothing on screen able to say which.

**The Net Worth page is a ledger, not a projection.** Append-only snapshots
(`networth.json`): the server refreshes quotes, prices every account through the same
resolver, adds the home value the user TYPED (no feed prices a house), and stores the
exact per-symbol prices and as-of moments the row used — so every total can carry its
condition forever ("prices as of the snapshot moment; home value as you entered it"). It
answers the one question the Workbench cannot: not "will this work" but "what did it add
up to on the days I looked".

**Its chart draws composition, not a total line.** A line through the totals answers "is
it going up", which is the least interesting thing the ledger knows: two rows can share a
total while the house rose and the portfolio fell, and the line cannot say so. One stacked
bar per snapshot carries both — height is the total, slices are where the money sat. The x
axis is categorical, one tick per record, because a snapshot is a deliberate act at an
irregular interval and spacing them to scale would draw a continuous series through days
nobody measured. Segments are the UNION of every account the ledger has ever recorded, and
an account absent from an older row contributes 0 — never a gap, and the slices still add
to the total that row stored.

**Colour carries identity; position carries size.** Two indexes, deliberately not the same
one. COLOUR is fixed by an account's first appearance and never moves again, because colour
is how the eye follows one account from bar to bar: the day the Brokerage overtakes the
401(k) it must change places without repainting anything. POSITION is size, descending,
biggest on the baseline, because a stack is read upward from the axis — the big slices
belong where a figure can still be read off the y axis, and the dust belongs at the top.
One order applies to every bar (the newest row's, that being the bar the page was opened to
read), and it is made TOTAL — ties and accounts the newest row has nothing in fall back to
their last non-zero figure, then to first appearance — so nothing reshuffles under a
re-render that changed no data. The home stacks by size like everything else: pinning it to
the top said "the house is its own category" in the one channel that here means "the
smallest thing here", while it is in fact second only to the IRA. What still sets it apart
is the palette's one un-hued grey. And because any two colours can now touch, every segment
is separated by a hairline in the card's own colour — the old first-appearance order was
what kept the deuteranopia-unsafe pair (series[0]/series[1], ΔE 0.4) off a shared edge, and
size ordering cannot promise that.

**The hover card describes one slice, not the whole bar.** Pointing at a band asks "what is
THAT", and the answer used to be all six segments plus a total: a legend the legend already
draws, and a figure the table already carries, with the slice actually under the cursor left
for the reader to find again. It now names that slice alone, its dollars, its share of the
day ("36% of $1,845,000" — the one fact about a piece its own figure cannot carry), and the
condition it was recorded under, which differs by who supplied it: prices as of the snapshot
moment, or the home value as the user entered it.

**Taking a snapshot is one button.** The home-value box, the note and the paragraph
explaining them held permanent floor space above the chart, for a number typed once every
few weeks. They moved into a modal on the native `<dialog>` (`showModal()`, so focus
trapping, Escape-to-close and the inert backdrop are the platform's and this app owns no
code for them). It stays open when the request fails — the snapshot route hits the network
to refresh quotes first, and the number just typed is the expensive part of that form.

**The allocation card retired the day the allocation stopped being a what-if.** The Plan
card's third section ("When the allocation changes") modeled a decision that was still open;
once it was acted on — the plan.json event came out with a backup
alongside. The EVENT TYPE survives end to end (old cabinet scenarios must keep parsing and
scoring), and a whole-portfolio allocation event in a loaded plan now renders as a
READ-ONLY row under Additional events — named, dated, uneditable except through the Raw
JSON editor — because the alternative was an invisible knob steering every simulated year.
The "Bonds are" dial outlived the section it was born inside: bond composition is a
market assumption the accounts carry every year of every plan, not a dated what-if, so it
kept its own section on the card.

**The baseline is a frozen artifact, not a plan that happens to be called
"Baseline".** *(Superseded 2026-08-20 — see "One plan again, and its history".
The problem it names is real; the plan's history solves it without a second
plan to designate.)* Tracking a score over time needs something fixed to score, and
this app has nothing fixed by design: `plan.json` is rewritten on every knob
turn (there is no Save button — see "One plan, saved as you go"), so a snapshot
taken mid-experiment would record "retire this year" at 63% and sit on the
trend beside the 94%s with nothing able to say the two answered different
questions. A pointer to `scenarios/<id>.json` fails the other way: edit that
file later and every score already recorded against it silently becomes a score
of a plan that did not exist when it was taken. So designating a baseline
FREEZES A COPY into `baseline.json` with a revision that starts at 1 and only
goes forward, the moment it was frozen, the user's own label, and a sha256 of
the stable stringification. Nothing seeds the file and nothing auto-designates:
a baseline is a statement of intent, and one that appeared on first boot
holding whatever `plan.json` contained would be a statement nobody made.
**Drift is reported, never corrected.** When the live plan no longer matches the
frozen one the Net Worth page and the Workbench both say so plainly and put
re-freezing one press away — but silently re-freezing would rewrite what every
future point on the chart means without the user deciding to. Drift compares
plan IDENTITY (name and description excluded), the same rule the filing cabinet
uses for "edited since", because `savePlan` pins the live plan's name to "Plan"
and a naive comparison would cry drift at a plan nobody had touched.

**A snapshot never waits for its score.** The two halves of a snapshot are not
equally recoverable: the balances and prices record a market moment that has
passed and cannot be reconstructed, while a score is a computation that can be
repeated at any time. A final-quality run is 10,000 paths and minutes of wall
clock, so blocking the response on it would put the irreplaceable half at the
mercy of the repeatable one — a timeout, a closed browser or a crashed worker
would take the whole snapshot with it. The route therefore writes the row and
answers immediately, and the score is attached when the run lands, through the
same run manager (and the same cache) a Workbench run uses. In-flight state is
memory-only: a restart leaves rows scoreless rather than carrying a persisted
"scoring…" that would be a lie for ever after. *(The clause that used to follow —
every scoreless row offers **Score it** — is superseded 2026-08-20; see "A
recorded number is not rewritten". The row stays scoreless, and says so.)*

**The score gets its own chart, under the bars, not a second axis on them.**
Net worth is millions of dollars and a score is a probability; an overlay needs
a second y scale, and two scales on one plot make the eye read the CROSSING as
an event when moving either axis moves it. A separate plot on the SAME
categorical x axis, same rows in the same order, keeps both readable and makes
the only true relationship — same day, same reading — a matter of looking
straight down. A snapshot with no score is a GAP in that line, never a zero: 0%
is "this plan fails in every simulated future", a catastrophe, and drawing one
for "nobody has scored this row" would put it on the chart. The y axis is
fitted to the plan's own range and never narrower than ten percentage points —
fixed at 0-100 a whole history spanning 88% to 97% is one flat line, and fitted
tightly a 0.3pp wobble inside the engine's own sampling noise fills the plot and
reads as a crash. **And the two things that break comparability are marked, not
smoothed:** a point scored against a different frozen plan (its `baselineHash`
— the revision NUMBER is only a label, and a deleted `baseline.json` restarts
it at 1), or by a different engine version, gets a hollow ring and a dashed
rule on the boundary,
and the tooltip names the conditions of every point — paths, seed, engine,
baseline revision and label — because a label that appeared only when something
changed would turn silence into a memory test. (The rule is addressed by a
per-row axis key rather than by the visible date: recharts scales a category
axis on serial numbers the moment two categories repeat, and two snapshots on
one day is enough — a reference line addressed by the date is then discarded
without a word, which is how the marks came to be missing entirely.) A line that hides those breaks
is exactly the one-golden-number trap the rest of this app is built against.

## One plan again, and its history (2026-08-20)

The cabinet and the baseline were both answers to the same question — *where does
a plan live once it is worth keeping?* — and having two answers meant the app had
three plans in the data folder and a page that had to explain which one a number
was about. The requirement:

> Get rid of plans and scenarios and just have "the plan", saved as you go. That means
> there is no "baseline" either. There is only one plan.

**The undo is a DAY, not a keystroke.** Saving as you go costs you the previous
version, so the day's first change files the plan as the day began. Per-edit
history would file dozens of near-identical copies an hour — the autosave fires
on every committed field — and a list nobody can read is not a history. A day is
the unit a user thinks in ("what did this look like before I started messing
with it on Tuesday"), and it makes every entry a decision rather than a
keystroke.

**The guard is behind the route, not in front of it.** `planStore.savePlan` is
the single door: the autosave, a finalist opened into the workbench, and a
restore all pass through it. A guard the client could forget is not a guard.
plan.json's IO moved out of `dataStore` for exactly this reason — a file with a
guard needs one door, not a general-purpose IO module's.

**What counts as a change is wider than plan identity.** `planIdentityKey`
excludes `description` because two plans differing only in prose are one plan to
the engine — but the description on this plan is a paragraph of the user's own
insurance analysis, and overwriting it is exactly the kind of edit history exists
to undo. So the guard fires on any difference in what would be stored, while
`planHash` on the entry keeps answering the narrower question about
comparability. A write that changes nothing files nothing.

**A restore is an ordinary save.** It writes the stored plan through the same
door, so the version it replaces is filed first and restoring the wrong one costs
nothing. Nothing is consumed, removed or reordered; history only grows.

**The baseline's problem did not go away — it moved onto the score.** A recorded
score still has to say what it was a score OF, or a trend of probabilities is a
trend of half-finished what-ifs. It now carries `planHash` (and, when the plan
matches one, the id of the version in the history), so the chart marks the point
where the plan changed and a point can offer to restore the plan it was scored
under. That is what the frozen baseline was for, with nothing left to designate,
drift from, or re-freeze.

**The old scores keep their own words.** Rows recorded under the baseline carry
`baselineRevision`, `baselineHash`, `baselineLabel` and
`planDriftedFromBaseline`, and those four stay readable in the schema for ever
while nothing writes them again. Dropping them would not have deleted the number
they describe — it would have stopped `networth.json` parsing and taken the whole
ledger down with the score. The chart marks the seam between the two vocabularies
too: the two hashes cover different things, so nothing can claim the numbers
either side of it were on one scale.

**Search keeps its finalists without a cabinet.** "Keep this plan" files a
finalist in the history under a name, and it does NOT carry the search's own
numbers: a search score is a mean over a SEED LIST at the search's own path
count, and a recorded score carries one seed because that is what makes two of
them comparable. A kept version scores in one press, under the same conditions as
everything else in the list.

**Every score now also asks what the plan could afford.** This household's
probability of success saturates — every version reads 96-point-something — so
the number that actually separates two plans is dollars a year, and the engine
already knows how to find it (`max_spend`, the same bisection the Explore card
runs). It is attached SECOND, to a row that already carries its probability,
because it costs a dozen runs where that one cost one: a wedged sweep must not
take down the number the chart is drawn from. Two non-answers are recorded as
reasons rather than numbers — when even $400,000/yr clears the target the solver
returns its own ceiling after two probes, and recording that would put a figure
on the row that nothing measured ("more than this", not "this"); when nothing
down to $20,000/yr reaches the target there is no sustainable level at all.

**Scoring a stored version is on demand.** Filing happens mid-edit, on the first
change of the day, and a final-quality run fired automatically at that moment
would compete with the workbench's own live run while the user is mid-thought. A
version scored when the user asks is worth more than one scored while they were typing.
On demand turned out to mean ONCE — see "A recorded number is not rewritten".

## The Saved tab becomes History, and one word for the thing (2026-08-20)

The server half of the collapse left the UI deliberately half-done. This is the
other half, and it started with what the user actually saw:

> The "Saved" tab is a mess. Pressing "Make this the baseline" put a message at the top
> reading "The plan on screen is not this plan", which means nothing to a reader. And the
> same object is called the plan in one place and the scenario in another.

**The mess was structural, not cosmetic.** One tab carried two concepts — a
cabinet of named copies, and a separately frozen baseline the Net Worth page
scored instead of the live plan — so the amber sentence was the second concept
trying to explain itself in the first one's space. With one plan there is
nothing to designate, drift from or re-freeze, and the only relationship a row
can have to the plan on screen is whether it IS it.

**A row's job is recognising a version worth going back to**, which is the
user's own stated purpose, so the probability, the median terminal assets and
the sustainable spend are all ON the row rather than behind a click — each with
the conditions that make it mean something. The spend figure carries its OWN
path count, which is not the one beside it: the solver caps its inner sweeps, so
two numbers on one line at two precisions with only one of them labelled is how
the cheaper one comes to be trusted like the dearer one.

**The match indicator is by content, and more than one row can carry it.**
`planIdentityKey`, not the id (there is none) and not the name (pinned to "Plan"
on every write). Two entries holding one plan both say so; picking one would
claim a choice nobody made, and a real history contains exactly that
pair.

**Restore asks in the row and answers afterwards from the list.** The button's
promise — "the plan being replaced is filed first" — is true of the day's FIRST
change and only that; restore twice in an afternoon and the second files
nothing. So the sentence shown afterwards is computed from the ids before and
after rather than repeated from the button, and when nothing was filed it names
the entry today's restore point really holds (this morning's plan, not the one
from a moment ago). Saying "your last plan was kept" there would point the user at
the wrong version at the exact moment they wanted it.

**Two of the cabinet's six warnings survived, and one of them had to be
rewritten to survive.** The old 72(t) warning fired on "no `autoSepp` field and
somebody retires early" — but `autoSeppPatch(true)` deliberately CLEARS the
field, because absent already means on, so every plan this app writes with the
bridge switched on is indistinguishable from a 2024 file that never heard of it.
Run against a real history it warned on three rows out of three, about a default
the user had chosen. It is now a COMPARISON with the plan on screen: silent when
they agree, and when they differ it says which way restoring flips the bridge.
The other four were about a metrics block, a file format and a sweep UI that no
longer exist.

**A restored plan is deliberately NOT marked as saved.** An autosave fired inside
the 400ms debounce can still be in flight carrying the pre-restore draft; letting
the next PUT fire queues the restored plan behind it on `saveChain`, so the
restored plan is what lands on disk however the two raced. Marking it saved would
skip that PUT and leave the file and the screen disagreeing with nothing left to
correct it.

**Sustainable spend gets a plot, not a footnote.** This household's success rate
saturates near the ceiling, so the probability trend can be flat while the plan
gets materially better or worse — the dollars are what say which. It is a third
stacked plot on the bars' own categorical axis rather than a second series or a
second y axis: millions of dollars, a probability and an annual spend need three
scales, and two series sharing a plot on two scales invite the eye to read a
crossing point that means nothing at all. Both trend plots are drawn by ONE
`<TrendChart>`, because a second copy would be a second copy of the
pointer-following tooltip positioning that took a day to get right, and the copy
is the one that silently stops being fixed.

**The spend axis states the target it clears**, because "the most you could
spend" is a different number at 85% than at 95%. It names the profile's target
as TODAY'S and says each recorded figure was solved against whatever target that
plan carried at the time — the honest form, since a row does not store it. The
axis snaps to the solver's own $500 bracket and never shows a window narrower
than $5,000: a tick reading "$64,200" would claim a precision twelve probes at a
capped path count do not have.

**A row scored before the spend existed can ask for one.** *(Superseded the same
day — see "A recorded number is not rewritten". The chart's empty state is a
true thing to render; the number that button produced was not.)* The table's
re-score button now also appears on a row that carries a probability and no
dollars — which is every score recorded before the solve, including the only
scored row in a real ledger. Without it the new chart would render its
empty state for ever with nothing on the page offering to fill it.

**One word for the thing, enforced by a scan.** Every user-facing "scenario" is
now "the plan", or is reworded into the concrete thing it meant — a rollover
"modeled in every run", a sweep that ignores the retirement date "in this plan",
cover made invisible "in exactly the death you bought it for".
`tests/ui/vocabulary.test.ts` reads the prose (string literals and JSX text) and
fails when one comes back. Identifiers are exempt on purpose: `Scenario` is the
engine's type, `RunRequest.scenario` is a wire field, and renaming them would
touch the run-cache key and the search executor to fix a spelling nobody sees.
Comments are exempt too — that is where the reasoning about the deleted cabinet
has to keep living. The exception list is empty.

## A recorded number is not rewritten (2026-08-20)

> "Score it again" — a button nobody asked for — undermines the "take a snapshot"
> feature it sits next to.

**He is right, and the rule is one sentence: filling a blank is allowed;
overwriting a fact is not.** A snapshot's whole value is that it is a RECORD of
a moment — these prices, these balances, this score, on this date. A button that
rewrites a recorded number contradicts the only guarantee the record makes, and
it does not matter that the new number is computed the same way: it is computed
against a *different day*.

**The net-worth re-score was the worst case, and it is gone entirely** — the
per-row button, `POST /api/networth/:id/score`, and `rescoreSnapshot` behind it.
It scored TODAY's plan against TODAY's profile and filed the answer on a row
recorded weeks earlier under a plan that had since moved. The figure it produced
was never true of the row it landed on, and the chart drew a trend through it.
The automatic run the snapshot button starts STAYS: that one is the record being
formed, not rewritten, which is the whole difference.

**The History tab keeps a button only where there is a blank.** A version nobody
has scored gets **Score it** — the tab exists to be recognised from, and writing
into an empty field destroys nothing. A version whose run *failed* gets **Try
scoring again**, because a failure records no measurement; the two are worded
apart, since "nobody measured this" and "we tried and it died" invite different
presses. A version that carries a score gets nothing.

**Including a version with a score and no spend figure**, which is the case that
most tempts an exception. "Baseline — saved Aug 18" holds 93.8% at 1,000 paths
and no dollars, because the solve did not exist when it was scored. Solving it
today and filing it on that row would put a figure measured against today's
balances beside a probability measured against August 18th's, and one row would
report two moments as if they were one. The row says why the figure is absent
instead.

**The guard is on the server, not in the button.** A guard the UI can forget is
not a guard: a stale tab, a replayed request or the next page that wants to score
something all walk straight past a missing button. `POST
/api/plan/history/:id/score` answers **409** on a version that already carries a
score, with a sentence naming the version, the day it was measured, and the thing
to do instead (restore it — the workbench runs the plan on screen live). 409
rather than 400, because nothing is wrong with the request; the state of the
record is the whole answer. Refusing beats succeeding silently, which would swap
a number under a reader who had no way to know, and it beats doing nothing
quietly, which reads as a bug and gets pressed again. The stores refuse too
(`attachScore`, `attachPlanHistoryScore`), so the rule is true at the point of
writing rather than at the point of asking.

**What it costs, and why the cost is the honest side.** A snapshot whose
simulation dies — a restart mid-run — is scoreless for ever. The ledger says
"not measured" and means it permanently, rather than offering a retry that would
fill the gap with a measurement of a different day. An unmeasured moment is a
true thing to record. A fabricated one is not, and it is worse for being
plausible.

## One bar across the screen, and the number that says how it was made (2026-08-20)

After a fortnight of daily use the Workbench drew four complaints, three about
chrome and one about arithmetic. The arithmetic one is the reason this section
is long.

**"The plan says 93.1%, the History tab says 94.2% for the same plan today, and
a version frozen this morning shows 97.3%."** Three numbers, one plan, one day.
Nothing had changed. The live loop runs at `mcPathsInteractive` (1,000 paths) because a
10,000-path run per keystroke is not a live loop; every RECORDED score — the
History tab's, the net-worth ledger's — is measured by `scoreRunner.ts` at
`mcPathsFinal` (10,000) on the profile seed. A point between two Monte Carlo
runs at different path counts is a fact about Monte Carlo. Two of the three
numbers were also priced from different quote snapshots, since holdings balances
are derived from `quotes.json` and nothing on the Workbench refreshes it.

So the page now does three things it did not do.

**The headline number states its own conditions, where the eye lands.** A chip
above the verdict reads *Quick run · 1,000 paths* or *Final quality · 10,000
paths*, with a sentence saying whether the number can be set beside a recorded
one. It sits above the verdict rather than in the provenance line at the foot of
the card, because the foot of the card is where it already was and nobody read
it. The chip refuses to say "final" for a run that drew a non-profile seed or a
mode other than Monte Carlo, both of which are just as incomparable and far less
visible.

**Run now refreshes every holdings price, then runs the recorded conditions.**
In that order, and the order is the point: a run started before the refresh is a
run priced at whatever the market was doing when the app was opened. The button
sits with the number it recomputes — pressing it from the Cashflow tab would be
pressing it away from the only figure that visibly changes. A per-symbol price
failure is reported and survived rather than thrown, because the previous quote
is still on file and abandoning a run the user is waiting on costs more than one
holding priced at yesterday's close. A failed run leaves the previous result
standing and says why underneath: a failed Run now costs the wait, never the
answer already on screen.

*It is often instantaneous, and that is correct.* The run key includes the fully
resolved profile, so if the History tab already scored this plan today at these
prices, the cache answers with the identical number — which is the comparability
being demonstrated rather than a shortcut around it.

**The delta chips refuse to subtract across path counts.** `comparableRun` drops
a comparison whose path count differs from the current run's, so pressing Run now
does not draw "+1.0 pts" over a change that never happened — the exact chip that
would restate the confusion the button exists to end. The chips then read *not
comparable* rather than *first run*, because there IS a run before this one and
claiming otherwise teaches the user that the app forgets.

**What was NOT built: a "prices have moved since this run" hint.** Quotes are
written by three things — the Profile page's refresh button, the net-worth
snapshot, and Run now. The first two require leaving the Workbench, which
unmounts it, and returning re-runs against the new prices; the third refreshes
and re-runs in one press. Inside one browser tab there is no path to a displayed
run that is older than the quotes it was priced from, so the hint would have
needed a poll of `/api/quotes` to catch a case only a second tab can produce.
More plumbing than the answer is worth. The path-count label is what the user's
confusion actually needed.

**The chrome.** The inputs panel lost its ⌘B collapse toggle, the 40px rail
behind it and the `fplan-workbench-panel` flag that could restore the app into
that rail on a load nobody asked for it on; it lost the "Inputs" heading; and it
lost the quiet line reading *Saved — every change writes itself to plan.json*,
which spent a row of the panel on every render restating a promise the app keeps
anyway. **The failure did not go with it.** There is no Save button anywhere in
this app, so an unreported write failure means the user keeps turning knobs into
a file that stopped being written — the banner and its Retry stay, now directly
under the panel's tab strip.

*Corrected on review.* Clearing that chrome also deleted `.wb-status`, `.wb-dot`
and its modifiers from the stylesheet, on the reading that the status line was
their only caller. It was not: the **Search** page draws `wb-dot dirty` beside
*a search is running* in its header, and with the rule gone that span computed to
an inline box of no width, no height and no colour — the marker stopped being
drawn at all, on a page this work never opened. `.wb-dot` and `.wb-dot.dirty` are
back (`.wb-dot.bad` stayed dead; the rail was its only caller). The lesson is the
test, not the rule: a class is dead when **nothing renders it**, so
`workbenchChrome.test.ts` now walks every `.tsx` under `src/ui` and fails if any
rendered `wb-` class has no rule left — rather than pinning each deletion by
name, which is what let the reading be wrong in the first place.

**The two tab strips line up because each is the first child of its column.** No
offset, no derived pixel: `.wb-layout` is a grid with `align-items: start`, so
two strips with nothing above them sit on one line. That is why the save-failure
banner moved below the panel's strip and why the run progress bar moved below the
results' — a banner above either strip would push half the bar down on exactly
the day something went wrong. The progress bar also keeps its 3px row when idle,
because a bar that appears and vanishes under the strip moves every card below
it once per keystroke.

Measured on review: both strips report `top = 82` at 1440px, and the two tops
stay equal at browser zoom from 0.8× to 1.5× and at every width tried — the
offset really is nowhere. But the *scans* proving it only checked DOM order and
the grid, and a `margin-top: 8px` on either column would have parted the strips
at every width with all of them still green. So the pair is now asserted equal
directly: neither `.wb-panel` nor `.wb-results` may carry vertical leading the
other does not. (Equal, not empty — insetting both sides is still allowed.)

**And they are printed at one size.** `.wb-panel .tab` carried `font-size: 13px`
against the results strip's 14px, which is the mismatch actually seen on screen: one bar
across the screen, set in two sizes. The rule is now stronger than fixing that
one — nothing scoped to `.wb-panel` may set a font-size at all, and
`tests/ui/workbenchChrome.test.ts` fails on the next "just this one a notch
smaller". The panel still runs tighter in PADDING, which is a width problem and
not a type problem: card padding stays at 12px/14px against the page's 16px/20px,
and the tab strip buys the room its eighth tab needs from horizontal padding and
the gap (4px and 0, measured against the 455px the strip gets on a typical
1440px window). Its VERTICAL padding is inherited rather than restated, because a
restated one is how the two strips end up 2px apart and the one bar becomes two.

The audit found three other drifts and closed them: a History row's note at 12.5px
where its three neighbours were 12, a MixEditor validation line at 12.5px where
the other two inline validation lines were 12, and the survivor warning on the
results side drawn as unboxed `.field-help warn` at 12px while every other
warning in the app is a boxed `.lib-warning warn` at 12.5px — that one was fixed
by giving it the same class rather than by picking a number. Two groups differ on
purpose and are listed in the test so an unexplained third cannot join them: the
results side's headline numbers (27px, 26px, 18px, 40px — a figure that IS the
answer is not body text) and the panel's dense-editor micro-labels (11px and
11.5px — column headings and per-cell annotations, furniture on a control rather
than a smaller body text). Neither group has a counterpart on the other side.

## The quick run says how precisely it counted (2026-08-21)

Filed as a bug, and worth restating precisely because the report was precise:
press Run now and get 94.2%; change the tithing hold period from 2 to 0 and it
reads 93.0 (fine, and correct); change it back to 2 and it reads 92.9, not 94.2;
press Run now again and 94.2 returns. Deterministically, every time — which is
what made it look like corruption rather than noise.

Nothing was wrong with the plan. Run against the live server at both path counts
— same scenario hash `7ff9a75c12f24aa1`, same profile hash, same seed — the plan
gives **0.931 at 1,000 paths and 0.942 at 10,000**. The toggle
round-trips exactly: hold period 2 is 92.9% before the edit and 92.9% after it.
94.2 against 92.9 is the final run against the quick one, which df1a13f had
already labelled. The remaining 0.1 points, 93.0 against 92.9, is the toggle's
real effect on those 1,000 futures — and 1,000 futures cannot resolve 0.1 points.
At p = 0.931 the binomial standard error is sqrt(p(1-p)/n) = **0.80 points**, so
the 95% interval on the quick number alone is ±1.6 points. The entire reported
swing is inside the error bar of the run that displayed it.

So the defect is not arithmetic, it is **presentation**: the screen printed a
1,000-path estimate with the same authority as a 10,000-path one, and drew
differences it could not see.

**A FIXED SEED IS WHAT MAKES THE ESTIMATE FEEL LIKE A MEASUREMENT.** The live
loop locks the seed on purpose — a resampled Monte Carlo per keystroke would move
the numbers on its own and every edit would look significant — but the price is
that the quick run's error is *deterministic* for a given plan. Ask twice, get
the same wrong-by-1.3-points answer twice. A number that never wobbles reads as a
fact. The seed stays locked; the number now admits what the lock costs.

**The run states its precision beside its conditions.** A second chip sits next
to *Quick run · 1,000 paths* reading **±1.6 pts (95%)**, with its meaning printed
under it rather than hidden in a hover — "±1.6" alone is one more unlabelled
number, which is the disease and not the cure. 95% because the Search page
already reports every effect it measures at 95% (`SeedStat.ci95`, built on
`tCritical(0.05, n-1)`); two confidence levels in one app would be two claims
wearing one symbol. The multiplier is the normal quantile 1.959964 rather than a
t: the smallest run this app takes seriously has 999 degrees of freedom, where
the two agree four decimal places below anything printed.

**The final run gets one too — ±0.5 pts.** It would have been tempting to mark
only the poor number, and it would have been wrong: a run that states its
precision only when the precision is bad teaches the reader that a missing chip
means exact. Nothing here is exact.

**p = 1 is the case that needed the most care, and it is an over-funded plan's
ordinary case.** The plan is over-funded and the success rate saturates, and
sqrt(p(1-p)/n) is exactly zero at p = 1 — so the naive formula would print
"±0.0 pts (95%)" beside "100%", the most confident lie on the page. Zero failures
in n paths does not mean the failure rate is zero. The **rule of three** covers
it: if the true rate were x, the chance of seeing none in n draws is (1-x)^n, and
setting that to 0.05 gives x ≈ 3/n — 0.3 points at 1,000 paths, 0.03 at 10,000.
It is a ONE-SIDED bound, because a run in which nothing failed can only be wrong
downward, so the chip reads `-0.3 / +0 pts (95%)` and never a "±" that would
claim futures above 100%.

**No chip reports a difference its runs cannot resolve.** `comparableRun` already
refused to subtract across two path counts. The same principle now applies within
one path count: a success-rate difference smaller than
z × sqrt(se₁² + se₂²) — 1.8 points between two 1,000-path runs on this plan — is
reported as **not resolved** rather than as a movement, with no arrow and no
colour, because an arrow is a claim about which way the plan moved and that is
the one claim the two runs cannot support. The word is the Search page's own:
`verdictWord` already distinguishes "same plan" from "not resolved", one being a
finding and the other a confession, and the strip now has both states too. `no
change` still means the two runs produced the identical fraction.

**The difference is still printed — in the sentence that disowns it.** Hiding it
would be the opposite failure: the user asked what the toggle did, and "no measurable
change: -0.2 pts is inside what these two runs resolve (±1.8 pts at 95%)" answers
them where a blank does not. What must not happen is the number appearing in the
chip. And the note names the way to a real answer, because a dead end would just
teach the user to squint at the chip again: **Run now** re-runs at the recorded
conditions, and the **Search page** measures effects this small properly, paired
across seeds.

**THE BOUND IS THE UNPAIRED ONE, AND IT IS CONSERVATIVE ON PURPOSE.**
`returns.ts` draws market futures from (historical rows, horizon, path count,
block years, seed, expense ratios) and nothing scenario-dependent, so two plans
run at one seed face bit-identical futures and their difference is *paired* — the
common random numbers `stats.ts` is built on, measured at 1.3x to 6.4x variance
reduction there. A paired interval on the tithing toggle would be narrower,
possibly much narrower. It is not computed here because **the run does not return
it**: the paired quantity needs the count of paths that flipped between the two
plans, and `RunResult` carries the success fraction with nothing per-path behind
it. Narrowing an interval using a number we do not have would be the same sin as
printing 92.9% with no interval at all, one decimal place further down. The cost
is real — the strip declines to resolve some differences a paired test could have
resolved — and the note says where the paired test lives.

**Two quantities that must never merge.** The within-run binomial error (over
PATHS, inside one draw of futures) and the across-seed spread the Search page
reports (over SEEDS, i.e. what happens when the futures are redrawn) would both
render as "± something pts". They answer different questions and a plan can have
a small one and a large other at the same time. Each names its own divisor
wherever it appears, and a test sets the two renderings side by side to keep them
distinguishable.

**Which tiles carry the guard, and why the others do not.** Three of the strip's
metrics are fractions of paths — success, and both guardrails rows, since
`aggregateGuardrailStats` divides its counts by the same n `successRate` uses —
so the binomial error applies to all three exactly, and all three carry it. The
guardrails rows are the *wider* case (a fraction near 0.23 has more variance than
one near 0.96, giving 3.7 points between two 1,000-path runs), which is why they
needed the guard rather than being spared it. The rest are deliberately left
alone, because an error bar invented for a statistic whose sampling distribution
nobody has worked out is the same lie in a lab coat:

- **Median terminal** is a sample median, whose standard error is
  1/(2·f(m)·√n) and needs the density of terminal wealth at the median.
  `RunResult` carries a five-point fan and no density; estimating one off two
  quartiles 25 points apart would be a guess wearing an interval.
- **The shortfall year** is a median over the worst-decile histogram — about a
  tenth of the paths, and on this plan only ~45 of 1,000 fail at all. It is
  reported in whole years, which is its own admission of coarseness.
- **The withdrawal rate** is read off the single deterministic reference path. It
  does not move with the path count at all, so there is no sampling error to
  state — a different fact from having a small one.
- **The tithe escrow** is a median over the failing paths only, so it inherits
  the median problem *and* a denominator that shrinks as the plan improves.
- **Sustainable spend** is a solver's answer rather than a sample statistic, and
  is reported on the History tab at the path count printed beside it.

**WHAT WAS NOT DONE: raising `mcPathsInteractive`.** Making the quick run less
wrong by making it slower would trade the live loop — the whole reason the quick
run exists — for a smaller version of the same unstated error. The number is not
hidden either, for the same reason in reverse: a 1,000-path estimate is useful
while a knob is moving, as long as it says what it is. The fix is that it tells
the truth about itself.

## The final run the refresh used to throw away (2026-08-21)

The sequel to the section above, filed the same way: run at final quality and
get a 10,000-path score, then refresh the browser and the number reverts to the
1,000-path one, which is different.

That was right, and the app was doing exactly what it was built to do. Run now
produces 94.2% at 10,000 paths; a browser refresh starts the live loop from
nothing, the loop runs at `mcPathsInteractive`, and 92.9% lands on the screen.
Both numbers are correct about what they measured. Neither is what the user
wanted to be looking at after a refresh, and nothing had changed to justify the
change.

**Nothing was lost. Nothing was ever looked for.** Both runs were on disk the
whole time — `c9879174` at 10,000 paths and `c6ddaaf2` at 1,000, 479 cached runs
between them and 228MB — because `finishRun` has written every result the app
has ever computed to `runs/<runKey>.json` since the first commit. The defect was
that no part of the app ever asked the cache a question it had not already
decided to pay for.

**HIS PROPOSED KEY WAS THE PLAN HASH, AND THAT IS THE ONE PART TO GET RIGHT.**
A run is not identified by its plan. It is identified by its whole input, and
the piece that moves fastest is not the plan at all: holdings-mode balances are
derived from quote prices, so the same plan at Friday's close and at Monday's
open are two different runs with two different answers. Reusing one for the
other would put a stale number on screen wearing the current plan's name, which
is the precise failure `loadResolvedProfile` exists to prevent everywhere else in
this app. The rule is *the same inputs entirely* — which is what `runKeyFor`
already hashes: engine version, resolved profile, assumptions, plan, mode, paths,
seed. So the feature needed no new notion of identity. It needed a way to ask
the one that was already there.

**Asking must not start anything, and that is why it is a route of its own.**
`POST /api/run` answers a cache hit instantly — `startRun` checks the cache
before it spawns — so using it for the question was the obvious shortcut and
would have been the actual bug: on a MISS it spawns the simulation, so every page
load without a cached answer would have quietly begun a 10,000-path run nobody
clicked for. `POST /api/run/cached` resolves the request through the same
`resolveRunInput` and reads the file: 3-4ms on a miss, 8ms on a hit, and a `null`
that costs one file stat. The two callers share the resolution function rather
than each having their own, for the same reason the search executor imports
`runKeyFor` instead of copying it — a lookup that resolved the profile slightly
differently would miss all 479 runs, silently, while looking perfectly healthy.

**The substitution is only offered when it is honest.** `finalStandInParams`
refuses three cases, each one a way the page could otherwise show a number the
owner asked the opposite of: a deterministic or historical panel mode (a
different question, not a coarser answer), an unlocked seed (a different sample,
not a finer one — the same trap `runQualityLabel` refuses to call "final"), and
a path count above `mcPathsFinal` (typing 25,000 asks for *more* precision, and
serving 10,000 would be a downgrade dressed as a saving).

**The run now says when it was computed.** The conditions chip already read
*Final quality · 10,000 paths*; what it could not say was that the number was
made at 6:51 PM rather than a second ago. A third chip states the moment — and
states it on every run, including one computed a second ago, because a chip that
appeared only for an old run would teach the reader that its absence means "just
now", and its absence would then have to keep meaning that forever. Same rule as
the precision chip beside it, which prints ±0.3 as readily as ±1.3. The moment is
absolute rather than "22 minutes ago": nothing on this page ticks, so a relative
phrase rendered once would still read "just now" an hour later.

**Run now is unchanged in intent and cheaper in practice.** It still refreshes
prices first and then runs at final quality, which means its input changes
exactly when the prices actually move. Pressed in a quiet market it is now a
cache hit — measured against the live data folder at 8ms, `done`, progress 1, no
new run file — instead of a second 10,000-path simulation of a question already
answered.

**WHAT WAS NOT DONE: raising `mcPathsInteractive`,** for the second time and the
same reason. The quick run exists to keep the screen alive while knobs move, and
the fix here costs it 3-4ms on the miss that follows every edit. The loop after
an edit is exactly what it was.

## One UI, two backends (browser-port Phase 4, 2026-08-29)

The app's single client (`src/ui/api.ts`) became the backend seam: its surface
is now the `Api` contract with two implementations — the HTTP client,
unchanged and still the default, and a LOCAL backend whose 27 methods call the
in-browser services directly. The environment-neutral halves of the run
manager, the score runner and both scorers moved from `src/server` to
`src/store` as factories (the same extraction pattern Phase 3 set for the
stores); the node faces re-export one composed instance, so every existing
import path and all ~300 server tests kept their meaning. The decisions worth
recording:

- **Selection is explicit and remembered.** `?backend=local` at boot, kept in
  localStorage because the router rewrites URLs on navigation — without
  memory, a reload from `/workbench` would silently fall back to HTTP
  mid-session, which is the one thing a mode switch must never do.
  `?backend=http` selects AND forgets, so the escape hatch stays one query
  parameter. HTTP remains the shipped default until Phase 7.

- **`src/ui` is the browser runtime's home, settling the plan doc's
  `src/app`.** Phase 1 put the sim worker at `src/ui/workers`, Phase 3 put the
  driver and guard at `src/ui/io`; Phase 4 followed with `src/ui/local` rather
  than renaming two shipped directories to match a name on paper. The plan's
  `src/app/*` should be read as `src/ui/*`.

- **The lease heartbeat lives in a dedicated worker**
  (`src/ui/workers/guardWorker.ts`), which also holds the Web Lock: browsers
  throttle page timers in hidden tabs — to once a minute, then to nothing —
  so a main-thread heartbeat would go stale under every backgrounded live
  writer, and worker timers are exempt. The plan's end-state (one IO worker
  owning all file access) is deferred to Phase 5/7: the guard is the piece
  timer throttling can silently corrupt, the stores' serialized chains
  already protect the single tab that owns the folder, and moving all IO now
  would have rebuilt Phase 3's tested layer mid-phase for no additional
  safety.

- **One reusable sim worker, runs serialized** (`browserRunExecutor.ts`). The
  browser worker was built for one-message-per-run reuse; serializing run
  hand-offs keeps progress attribution structural instead of inferred. The
  run manager reports 'queued' exactly as it always did, and the UI's
  requestId guard already handles overlap.

- **Quotes fail honestly until Phase 6.** The local backend's default fetcher
  fails every symbol with a message naming the proxy as the missing piece —
  per-symbol failure is data, the store's own rule — and the injection seam
  (`globalThis.__fplanLocalOptions.quoteFetcher`) is what the dual-stack gate
  fills with fixtures and Phase 6 fills with the proxy. Search is Phase 5 and
  the Search page says so via a declared capability
  (`api.searchAvailability`), never by sniffing the backend.

- **Interruption semantics are unchanged by design.** A killed tab leaves a
  scoreless row exactly as a killed server did; the write-ahead intent file
  and unload guard are Phase 6's work, deliberately not smuggled in early.

## Search in the browser (browser-port Phase 5, 2026-08-29)

The search system followed the Phase-4 extraction pattern to its end: the
executor, the cached evaluator, the compiler/sampler/statistics and the
search manager moved whole to `src/store/search/` + `src/store/searchManager.ts`
(environment-neutral, pinned Node-free), with `src/server/search/*` reduced to
node faces that keep every historical import path and test meaning. The pool
became an interface with two implementations honouring one contract — the
worker_threads pool byte-for-byte as it was, and a persistent Web Worker pool
sized `min(8, max(2, hardwareConcurrency - 2))`, the node formula on the
browser's honest core count. The decisions worth recording:

- **The coordinator is a worker, and it owns its pool.** Browsers throttle
  main-thread timers in hidden tabs; a twenty-minute search coordinated from
  the page would crawl the moment the user tabbed away. The executor runs in
  a dedicated coordinator worker (`src/ui/workers/searchWorker.ts`) which
  spawns its own score workers — workers-in-workers is exactly what keeps
  every computing and scheduling part of the search off the main thread.

- **The write boundary is absolute: the coordinator performs no folder IO.**
  Every readScore/writeScore/readCachedResult crosses back to the guarded
  main context as a message and goes through the same composed stores as
  every other write in local mode, so the single-writer discipline and the
  serialized chains hold with zero new writers. The cost is a message
  round-trip per cache probe — noise against a ~second of simulation per
  evaluation; the alternative costs the invariant protecting irreplaceable
  records.

- **D5 stands at its default: no round-checkpointing.** A killed tab loses a
  running search's progress, honestly: a beforeunload confirmation is armed
  exactly while one is in flight (and observed arming/disarming in the
  gate), a cancelled search still writes its truncated partial report, and a
  killed one leaves no file and no registry entry — the reopened page's
  bookmark 404s and is forgotten, the same sequence a restarted server
  produces. Nothing pretends the search survived.

- **The dual-stack gate grew the search legs and immediately caught a real
  fork.** The persisted reports were byte-identical for 4,041 characters and
  then one ULP apart inside a ci95: the ES spec lets engines approximate
  Math.log/Math.exp, and node's V8 disagrees with Chromium's by one ULP on
  some inputs. Fixed on the Phase-0 sha256 pattern — vendored fdlibm log/exp
  (`src/store/search/ieee754.ts`, correctly-rounded arithmetic and integer
  bit ops only, bit-identical on every engine) swapped into the statistics'
  five transcendental call sites, faithfulness pinned by a 200k-case ULP
  sweep. The ENGINE keeps native Math on purpose: its cross-environment
  fidelity is proven directly by the parity gate, and swapping proven math
  on suspicion would risk the numbers the gate pins.

- **Cancellation crosses as a message, not a poll.** The manager's runner
  seam hands back `{report, cancel()}`; under node cancel flips the same
  closure boolean it always did, in the browser it posts into the
  coordinator, whose event loop is idle between chunks while the pool
  computes — so a cancel lands at the next chunk boundary in both worlds and
  the truncated-report wording is shared code, compared verbatim by the gate.

## Quote proxy + interruption-proofing (browser-port Phase 6, 2026-08-29)

Two deliverables with one theme — the app stops depending on luck. The only
network step gets its missing piece (the CORS proxy the browser cannot live
without), and the only unprotected loss window left in scoring — the one that
cost a real record its sustainable-spend figure on Aug 20 — gets a write-ahead
intent that makes every interruption resolve explicitly. The decisions worth
recording:

- **The proxy is a dumb pipe, built and tested with no Cloudflare account.**
  `workers/quote-proxy/handler.ts` is a plain `(Request, env) → Response`
  fetch handler: symbol validated with the app's own SYMBOL_RE discipline
  (400 before a byte goes upstream; encodeURIComponent regardless), Yahoo's
  body relayed VERBATIM with Yahoo's status (parsing stays client-side in
  parseYahooChart, so a Yahoo shape change is an app fix), a 10s upstream
  timeout, and a CORS allowlist that echoes the matched origin — the D6 app
  origin plus localhost dev origins — never `*`. The upstream base is an env
  parameter with the Yahoo default, which is what keeps every test offline:
  unit tests drive the handler with Request objects against a local fixture
  server; the browser lane mounts the same module in a ~10-line node http
  adapter. wrangler is not a dependency — it enters once, at deploy time
  (`npx wrangler deploy`, README.md), which the owner runs himself.

- **No logging is a pinned structural property, not a habit (D3).** The
  handler contains no log statement, no storage binding, no metrics;
  wrangler.toml keeps observability off; and a source-scan test holds all of
  it, the same way the repo pins node-imports out of portable code. A symbol
  list is a portfolio fingerprint — the Worker must be unable to remember one.

- **Deploy-then-point runs through localStorage, not a URL parameter.** The
  local backend reads the proxy URL from `VITE_FPLAN_QUOTE_PROXY` at build
  time with a runtime override in `localStorage['fplan-quote-proxy']`
  (proxyQuoteFetcher.ts owns the rule), so pointing the deployed app at a
  freshly deployed Worker is one console line and a reload — no rebuild. A
  `?quoteProxy=` parameter was rejected on purpose: a link someone hands the
  owner must not be able to re-route his symbol traffic, and localStorage is
  writable only by the user or same-origin code. Either layer must be
  https:// (or http:// on localhost, for dev and the offline lane); anything
  else is ignored with the reason logged. Until a URL is configured, every
  refresh fails per-symbol with a message naming exactly what to deploy and
  where the instructions live.

- **The write-ahead intent lives in the SHARED core, so both backends heal
  identically.** `src/store/scoringIntent.ts` + wiring in scoreRunner and
  both scorers: before each phase's run starts the runner records
  {record, phase, runKey} through the guarded store path — the runKey from
  THE run manager's own resolver, never a copy — updates it at the
  probability/spend boundary, and clears it when both attaches land (or a
  failure is recorded, which is also an outcome). On boot, both server.ts and
  the local backend call the same healer before serving anything: intents
  whose record is gone or complete clear; a runKey that still resolves
  identically from today's inputs stays, and the row shows Interrupted with a
  one-click Finish-scoring button (D4's default — the button, never a silent
  auto-complete); a runKey that no longer matches stamps the missing half
  with the shared reason sentence — a figure computed now would belong to
  now — and clears. Finishing re-verifies at the press, so a world that moved
  between boot and click still gets the honest refusal, and a completed
  finish is provably the SAME measurement: the interruption gate asserts the
  healed networth.json byte-equal to an uninterrupted session's under masked
  wall-clock stamps.

- **Finish is not the removed re-score button back.** Every deleted scoring
  button measured a different day and filed it on an old row. Finish appears
  only behind a still-verifying intent, completes only the run that was
  already in flight, and fills only blanks — `finishOffer` in
  planHistoryLogic holds the rule for the History tab, the Net Worth page
  keys off the same intent list, and the attach guards underneath never
  loosened (the spend-slot immutability comments in both stores now name the
  finisher as their second reachable caller, guarded by runKey identity).

- **The intent file is transient, and the gate asserts ABSENCE.** The
  dual-stack drive now checks `.scoring-intent.json` is NOT in either
  finished tree — deliberately not added to the excluded-artifacts set, which
  would only have masked a leak. A finished session that still carries an
  intent means a terminal path forgot to clear it, and every later boot would
  claim an interruption that never happened.

- **A torn intent file reads as empty and is deleted.** The node driver's
  writeText is not atomic, so a crash mid-write can leave torn JSON; a torn
  intent cannot name what was in flight, and the rows it named stay scoreless
  with the standard permanent wording — exactly the pre-Phase-6 behaviour,
  never worse. Failing the boot on it would brick the app over a file whose
  whole job is to be discardable.

- **The scoring unload guard mirrors the search guard's discipline.** armed
  exactly while either scorer's registry is non-empty (the services layer
  reports the SUM through one hook; `src/ui/local/scoringGuard.ts` holds the
  listener), observed arming and disarming in the interruption gate. Browser
  only: the node server outlives its tabs, so its services pass no hook.

- **The Phase-4 wording quirk is fixed at its root.** A row whose probability
  had landed while its bisection still ran used to show the permanent
  "none can be added" sentence — finality claimed about a figure a dozen runs
  from landing. The readings now carry the live half (`spendSolving` off the
  in-flight registry, `spendInterrupted` off the intent list) and the
  permanent sentence renders only when both are false, on the Net Worth
  spend tooltip and the History tab alike.

## The chooser loses its second answer (2026-08-29)

The owner's first real test-drive of the live page opened, as designed, on
the storage chooser — and his first reaction was that the "Browser-private
storage" card should not be there. He is right in the way only a first
impression can be: on a browser that ships the folder picker, the page was
asking one question and offering two answers, and the second answer's only
honest selling point was "you don't have to answer the real question yet."
So the card is gone. A picker-capable browser now sees exactly one storage
action — pick a folder — and the walkthrough lane pins it structurally: one
button on the chooser page, no "Browser-private" text, no visible UI path
that writes the `opfs` choice.

What did NOT change is everything underneath the offer:

- **Safari/Firefox are untouched (D8).** No picker means the demo fallback
  was never a second choice — it is those browsers' only door, warning
  banner, demo-scoped boot, standing banner and all. The fallback card, its
  wording, and its button are byte-for-byte what they were.
- **Nobody is stranded.** Anyone who chose browser-private storage while it
  was offered still carries `opfs` in localStorage, and the boot gate still
  answers `ready-opfs` for it, demo-flag false, no re-asking — the cut
  removed the OFFER, never the storage. Pinned in node
  (`tests/ui/storageGate.test.ts`) and in a real browser (the walkthrough's
  seeded-OPFS leg).
- **The lanes keep OPFS alive through the seam that already existed.**
  Headless Chromium ships `showDirectoryPicker` but cannot complete the
  native dialog, so no lane can click through the one remaining action.
  Every browser lane therefore boots OPFS the Phase-7 returning-user way:
  pre-seed `localStorage['fplan-storage'] = 'opfs'` (documented at
  `STORAGE_CHOICE_KEY` in storageChoice.ts). The walkthrough — previously
  the one lane that clicked the visible OPFS button — now seeds the same
  key after asserting the chooser, which is deliberate double duty: the
  write is byte-identical to a pre-cut user's remembered choice, so the
  test-lane mechanism and the never-strand proof are the same test. No
  second mechanism was invented; the seam is test-only in spirit on picker
  browsers because no visible UI writes that value any more.
- **Switch storage still means what it says.** Dashboard → Switch storage
  returns to the chooser; on a picker browser that now reads as "pick a
  different folder," which is what the affordance was for.

## Zero-start: a new user's first screen is their own data (2026-08-29)

The owner, about to hand the URL to a friend: "I would rather it start from
zero so that, from the beginning, everything they see is THEIR data." So an
empty picked folder no longer seeds the fictional starter household. The boot
gate grew a second stage (`profileSetupNeeded`, storageChoice.ts): after the
folder grant and the backend boot, a folder holding no profile renders ONE
setup page collecting only what the tax/SS engine cannot run without —
person 1's name and birth month/year, an optional second person, the filing
state. Filing status is derived (one files single, two file MFJ), the submit
writes one minimal schema-valid profile through the ordinary store path
(`shared/setupProfile.ts` → `api.putProfile`), and nothing is written until
submit — abandon and reload lands back on setup.

**Honest gates instead of fabricated numbers.** The predicate lives in
`src/ui/firstRun.ts` and is two-tier by design:

- **Zero accounts GATES.** Accounts are the substrate of the simulation;
  with none, "94% of futures succeed" describes a household that does not
  exist. The Workbench renders a first-run state (what is missing, where to
  add it) and starts nothing — no live loop, no Run now, no cached-run
  restore, and no figure computed earlier against since-deleted accounts.
  Net Worth's snapshot button, the History tab's scoring offers, and the
  Search page all degrade to the same honest words.
- **Zero recorded spending ANNOTATES.** With accounts but a $0/mo budget the
  score is a true statement about the inputs — its futures spend only what
  the law charges anyway (taxes; Medicare premiums from 65), which usually
  flatters, though those statutory charges can still sink a small balance,
  so the caption states the condition without claiming the plan cannot
  fail — and the house rule for true-but-conditional numbers is that
  the number carries its condition — a standing caption beside the verdict,
  not a withheld result. Gating it would also break the first feedback
  moment: add one account, watch the first simulation appear, read what it
  still assumes.

**The fictional household survives only where a filled example is the
point:** the D8 demo fallback (Safari/Firefox) seeds it exactly as before,
and the parked legacy Node server keeps seeding it too — it has no setup
step, and porting one to HTTP mode is not worth building for a parked
service; the browser path is the product. Both are declarations at the call
site now (`initDataDir({ seedStarterProfile })`, default true for those two
callers, false on the browser product path). The pristine
`profile.starter.json` reference copy stopped being planted in every folder
along the way: the starter is no longer the seed of anyone's data, its bytes
live in the repo, and a copy in the data folder made the fiction look like a
record.

Pinned end to end by the pages walkthrough (setup as a stranger → gated
workbench with no percentage anywhere → first account through the seam → the
first number carrying both its run chip and its zero-spend caption → the D8
leg asserting Alex and Jordan still seed the demo), in node by
`tests/ui/{setupProfile,firstRun,storageGate}.test.ts`, and at the store
level by the zero-start cases in `tests/store/storeSuite.ts` (both drivers).

## The housing toggle keeps its configuration (2026-08-29)

The owner lost a real point of probability today: "Turn off" on the Housing
tab deleted the block (correctly — the engine's absent-means-unmodeled
contract is untouchable, and no engine code changed), and re-enabling gave
a seeded blank form refilled from memory, missing an insurance quote that
had been entered. Absent, the engine estimated 0.22% of the price — roughly double the quote
on his house — and the plan quietly paid the difference every simulated
year. The engine was right both times; the UI threw away his work.

The fix is a UI-side stash (`src/ui/planBlockStash.ts`, the documented
pattern; `housingStash.ts`, the one wired consumer): turning housing off
still removes `housing` from the plan, but the removed block is stashed in
localStorage KEYED PER DATA FOLDER — the same identity the writer guard
already mints and scopes its Web Lock by (the picked folder's SavedFolder.id,
OPFS's fixed id, the server dataDir in parked HTTP mode), so two plans in
two folders never inherit each other's stash. Turning it back on restores,
in order: the stash; failing that, the newest plan-history version whose
plan carries a housing block (folder-resident, so it survives what
localStorage does not); failing both, the seeded blank form — because then
blank is the truth. Whichever source restores, a provenance line states
where the values came from and when ("your housing configuration as it was
when you turned it off — Aug 29, 5:42 PM — review before running" /
"Restored from history: the housing configuration of the Aug 29 day-start
version…"), and the OFF state says the button will restore BEFORE it is
pressed. A restored number carries its condition, like every other
conditional figure in the app.

**Wired only for housing, by the owner's scoping.** The SEPP, insurance and
tithe toggles delete their blocks the same way and are candidates for the
same treatment — the pattern is three calls (stash on removal, read-or-fall-
back on re-enable, provenance line) against `planBlockStash.ts`.

Pinned in node by `tests/ui/planBlockStash.test.ts` (key shape, garbage
tolerance, folder-identity rules) and the housing cases in
`tests/ui/housingCard.test.ts` (stash-before-removal, the three-source
order, the provenance wordings).

## The strip slims to three, and the Profile wears the smplkit chrome (2026-08-30)

Three owner calls in one pass, all about the app finally being used like a
product rather than toured like a build.

**The name is Retirement Planner.** "Finance Planner" was the working title;
every user-facing surface now says Retirement Planner (topbar brand, tab
title, PWA manifest, the server banner, the writer-guard refusals, the
service descriptions, the docs). Internal identifiers deliberately keep
their old names — the `finance-planner` package/service labels, the
`~/finance-planner-data` default, the `FPLAN_*` env prefix, `fplan-*`
storage keys — because renaming those breaks installed services and parked
folders to make a string prettier, and nobody reads them.

**The top strip is Workbench · Profile · Net Worth.** Dashboard and
Methodology left the URL vocabulary entirely (stale paths resolve to the
Workbench like any unknown path); Search keeps its page, its machinery and
its /search paths but draws no button — `NAV_HIDDEN` in App.tsx is the whole
parking mechanism, and deleting the entry un-parks it. The Dashboard was a
read-only echo of Profile and Net Worth except for one card that mattered:
the data-folder card (folder path, D7's run-cache size, engine version,
storage persistence, Switch storage). That card moved whole to Profile →
Settings (`DataFolderCard.tsx`), and every sentence that pointed at
"Dashboard → Switch storage" — including the folder menu's OPFS note and
the 2026-08-29 chooser decision above — now reads Profile → Settings.
The Methodology page's content lives on in git history and DECISIONS;
nothing deep-linked to it.

**The Profile adopts the smplkit detail-page standard** (the app repo's
docs/frontend-standards.md), because the owner went looking for Save inside
the tab — where Add account and Delete live — and found it in a detached
bar at the top of the page. The page now renders the standard's chrome: a
detail header (title + save-state pill), one `.detailsTabHeader` row with
underline tabs left and the tab-scoped actions — Discard changes / Save —
right, field-level `required` markers and on-field validation errors
(`fields.tsx` grew `required`/`error` props; the inverted guardrail band is
the first wired error), and the standard's dirty-form blocker: leaving the
page with unsaved edits raises the Discard-unsaved-changes prompt
(`dirtyFormBlocker.tsx`, wired through a navigation-guard seam in nav.ts,
since this app navigates by buttons rather than anchors). The class names
are the standard's own (camelCase in a kebab-case sheet, on purpose) so the
standards doc reads onto this code verbatim; the palette stays this app's.
The Workbench strips deliberately keep the old `.tabs` treatment — their
two-strips-one-bar alignment is its own design, and restyling it is a
separate decision.

**A completed welcome form resets the remembered tabs.** The zero-start
setup's submit now clears the four per-page tab keys and returns the URL to
the app root (main.tsx `resetRememberedViews`): the keys are per-browser,
not per-folder, so File > New into an empty folder used to open the fresh
plan on whatever input tab the OLD plan was last touching — the owner hit
exactly that, landing on Housing where Plan belonged.

## The app becomes a shell of modules (2026-08-30, second pass)

The owner's verdict on the first chrome pass: "didn't quite hit the mark."
The detailed instruction replaced it wholesale, and this entry records the
standard as shipped, because it is now the app's UI constitution.

**THE SHELL.** Two panels: a narrow left sidebar for navigating between
modules, and a wide right panel showing the selected module, with a banner
across the top of the content where titles, breadcrumbs and the module's
actions live (ModuleBanner.tsx — every module wears it). Every tab the old
Profile page carried became a module, joined by Workbench and Net worth,
ALPHABETIZED: Accounts, Expenses, Health, Home, Household, Income,
Insurance, Investing, Net worth, Settings, Tithing, Workbench. '/' still
opens the Workbench; Search stays parked (URL works, no sidebar item); the
folder control and the theme toggle live in the sidebar footer. Old
/profile/<tab> links map onto the module the tab became and the address bar
cleans itself up.

**THE RULE.** One thing → show the one thing. Zero-or-more things → show a
table. The Workbench is explicitly scoped OUT of the overhaul.

**THE TABLE STANDARD** (ManagedTable.tsx enforces it): Add button top right
inside the banner; every row a trashcan at far right behind a confirm
modal; the first column is the primary one and looks clickable; clicking a
row opens the detail, adds a breadcrumb for the row, and turns the main
title into the way back; every column sortable, default first-column
ascending; URLs carry it all (/accounts, /accounts/k401 — nav.ts's
ENTITY_PAGES, whose second segment is a record id held to shape, not a
vocabulary).

**THE DETAIL STANDARD.** A detail opens in VIEW mode with Edit and Delete
in the banner; Edit swaps them for Cancel and Save; Save writes (one
get-mutate-put of the whole profile) and returns to view mode. View and
edit are THE SAME LAYOUT: the body sits in one <fieldset>, disabled outside
edit mode, and the stylesheet dresses disabled controls as plain values —
transparent chrome, identical box — so nothing jumps. Edit-mode furniture
(add row, remove, move) hides by visibility, keeping its space. The
single-thing modules wear the same view/edit chrome (ProfileFormModule.tsx)
so every module edits one way. Leaving with unsaved edits raises the shared
discard prompt (useProfileDoc wires the blocker); adding a record is a
DRAFT — the new row opens in edit mode and Save is what makes it real, so
Cancel leaves no junk; deleting is an immediate confirmed write.

**DELIBERATE DEVIATIONS, recorded here rather than discovered later:** the
itemised budget lines (Expenses / Tithing / Investing) stay in-place
editable grids inside their modules' one form — they are an ordered
worksheet with a totals footer and hand-arranged row order, and sorting or
click-through details would fight both (ExpensesModule.tsx carries the
note). Net worth and Search keep their existing pages inside the shell,
un-overhauled for now. Insurance keeps its legacy single-policy shape as a
single-thing form (that IS the rule) with the convert offer beside it.

Pinned by the reworked tests/ui/nav.test.ts (module vocabulary, entity
segments, legacy mapping), tests/ui/accountsCard.test.ts (table wiring, the
managed-table machinery, the nothing-was-lost field inventory, the
view-mode CSS rules), and the pagesWalkthrough browser lane (Settings' data
card, the /expenses deep link, the legacy /profile/expenses redirect).

**Review-hardened before landing.** A 28-agent adversarial review of the
diff confirmed and fixed, pre-commit: entity segments now KEEP THEIR CASE
and accept `._` (record ids are user data matched exactly — lowercasing
'K401' opened the wrong record, and 'My_401k' had no deep link at all); the
navigation guard skips a move that resolves to the URL already on screen
(clicking the active sidebar item while dirty used to raise a discard
prompt for a departure that was never going to happen); mutateAndSave
builds each write on a synchronously-advanced draft ref (two quick trashcan
deletes used to resurrect the first row) and its completion no longer
touches the edit state (a slow delete used to eject a newer edit session on
another record); the legacy single-policy Insurance form is editable again
(the return-to-table cancelEdit effect was firing in the branch that LIVES
at the table's address); deleting the last policy clears the legacy scalars
its conversion left behind, so the confirmed delete cannot resurrect a
premium; both confirm modals take focus (Cancel/Keep first) and close on
Escape; the InfoTip "?" became a focusable span so help stays reachable
inside view mode's disabled fieldset; the double-counting premium warning
returned to the policy table; a slow delete's completion only steers the
URL if the user is still looking at the deleted record; and the view-mode
itemise pitch grew the "Press Edit" line its hidden buttons owed it.
Accepted, knowingly: browser Back bypasses the dirty guard (the smplkit
original has the same gap, documented in dirtyFormBlocker.tsx), a
cancelled add leaves one inert Back press in history, and the edit-session
machinery still has no DOM-level test — the node suites pin sources, the
browser lanes drive flows.

## The polish pass: quiet tables, stacked forms, Plan on top (2026-08-30, third pass)

Owner feedback on the shell, applied:

**Tables wear the smplmark look and run full width.** Uppercase, letter-
spaced, muted column headers on their own band; roomy separated rows; the
whole table in a rounded bordered wrap; and the module bodies lost their
max-widths entirely — tables and forms stretch all the way across.

**Unnecessary commentary is gone, as a principle.** The accounts table's
"names are yours to choose…" intro, the "sum of the N balances above…"
sentence under the total, the insurance table's units preamble and its
totals footnote — all deleted. The owner's reasoning, recorded because it
is the standard now: a label like "All accounts" over an obvious sum needs
no explanation, and the explanation is NOT harmless — it makes the reader
pause and suspect the thing is more complicated than it is. Copy that
merely narrates what the screen already shows is a cost, not a courtesy.
(What the words guarded lives on in quieter places: the total's hover
title, the per-row unpriced flags, the field-level tips.)

**Forms are one field per row.** The packed flex rows — seven money boxes
across the Home card, the Health card's scattered labels — read as text
placed randomly once labels and help wrapped at different heights. Module
forms now stack: label, control, help, top-down, with a uniform width
floor. Genuinely horizontal repeating groups (a holding's symbol × shares ×
class, Roth conversion rows, the withdrawal order's ↑↓ buttons, the
allocation weights) opt out via .inlineRow.

**Plan on top; Settings at the bottom; theme inside Settings.** The
Workbench is LABELLED Plan now (the id, URLs and storage keys stay
'workbench' — /plan would orphan every link for a word) and sits first in
the sidebar above a separator, with the working modules alphabetical below.
Settings moved to the sidebar footer, where the theme toggle used to live —
and the theme itself became an Appearance card inside Settings (applied on
change, outside the view/edit form), so the footer is Settings + the folder
control and nothing else.

## The banner speaks once, and the ledger runs itself (2026-08-30, fourth pass)

Owner feedback, applied:

**A heading that repeats the banner is noise.** The banner names the module,
so the content stops saying it again: the Expenses/Investing tables and the
Health, Home, Income, Settings and Tithing forms lost their echo headings
("Household & filing" tightened to "Filing"). The budget tables dropped
their cards too and wear the managed-table treatment — header band,
bordered wrap, full width — like the Accounts table; the Net worth
snapshots table wears it as well.

**Tithing is two tabs** — While working (the charitable budget lines) and
Going forward (the pot and the ongoing rule). The tab is LOCAL state, not a
URL segment: two halves of one editing surface, one Save, the same
where-your-hands-are reasoning as the Workbench's input panel.
ProfileFormModule grew a `tabs` slot for exactly this — rendered OUTSIDE
the view-mode fieldset, because tabs are navigation and a disabled fieldset
would switch them off.

**Net worth reorganised around its four panels** — Trend (né "Total over
time, piece by piece"), Score, Spend, Snapshots — as URL tabs
(/networth/trend; nav.ts NETWORTH_TAB_IDS, remembered under
fplan-networth-tab), with Take snapshot in the banner and the header card
deleted along with its explanations (the scores-are-of-that-day and
records-every-account paragraphs — the row titles and the table footer
still carry the conditions).

**The ledger takes today's snapshot itself.** Arriving at Net worth records
a snapshot automatically when none exists for the current day — behind a
self-closing "Taking a snapshot…" overlay — using the same home value the
dialog would offer (the last snapshot's figure, the profile's for the very
first). Never while the zero-start gate is up; once per visit; a failure
reports in a banner and does not retry until the next arrival. The manual
button remains for a second snapshot or a changed home value. The one new
invariant worth naming: api.takeNetWorthSnapshot now has exactly two call
sites — the dialog's confirm and this effect — and the tests pin the count.

## Tabs everywhere they earn their keep, and the file stops recording the scheduler (2026-08-30, fifth pass)

The owner's fifth round, plus a root-caused flake that turned out to be a
real store bug.

**Four more modules grew tabs**, all through a new shared pair
(modules/TabStrip.tsx + TabPanel) that Tithing's hand-rolled strip was
refactored onto: Income = Current | After Retirement; Household = Filing |
People; Home = Details | Mortgage; Settings = General | Spending |
Withdrawals | Health | Advanced. Same rule as Tithing: the tab is LOCAL
state, one draft, one Save across tabs. Settings' Advanced tab holds the
two always-active cards (Appearance, Data folder), rendered through the
module's `after` slot so they stay live in view mode; the fieldset renders
nothing on that tab.

**Health stopped being a module.** Its fields moved whole into
HealthFields.tsx and render as Settings' Health tab; 'health' left PAGES
(twelve modules now) and joined the tombstones — parseRoute sends /health
and /profile/health to Settings.

**Investing became the two numbers it is** — "While working ($/mo)" and
"After the last paycheck ($/mo)" — instead of a lines table.
InvestingFields (BudgetCard.tsx) binds the pair to the scalars before
itemisation and to the budget's investing line after it (per line, in the
rare budget holding several; committing into an itemised budget with no
investing row creates the row with an explicit retired 0, because on a
line absence means "same as now"). The add-row affordance is gone from
this page on purpose: a second investing line was never a decision anyone
made here.

**The Expenses preamble became a first-visit modal.** The today's-dollars
and inherited-blank rules left the page (they were the last preamble
standing) and now show once, as a modal over the itemised table, with a
default-ticked "Do not show this again" (fplan-expenses-intro-seen,
browser-local like the remembered tabs, deliberately NOT cleared by File >
New). ProfileFormModule's `after` learned to take a render function for
exactly this: the modal needs the draft (itemised or not) but must live
outside the disabled fieldset or its own button would be switched off in
view mode.

**The account detail dropped its `id:` line** — the id is the URL segment,
so the address bar already shows it to anyone who needs it for a
hand-written plan event.

**The store bug: the file's bytes recorded write scheduling.** The
dual-stack gate forked on networth.json under CPU load — same rows, same
values, different KEY ORDER per stack. Root cause: reads normalize key
order (zod rebuilds objects in schema-declaration order), so every
read-modify-write re-serialized older rows into schema shape, while the
session's LAST spend-attach kept its appended-at-the-end keys. With two
rows scoring concurrently (the auto-snapshot made that the normal case),
which attach lands last is a scheduling race — and the two backends
disagreed. Fix: networthStore.writeLedger and planHistoryStore.writeHistory
now write THROUGH the schema, so the bytes are always the shape the schema
reads; behavioral pins in snapshotScore.test.ts and
planVersionScore.test.ts assert the spend pair lands in schema position.
The lesson worth keeping: when a byte-equality gate flakes only under
load, reproduce under load (a looping node-suite made it 1-in-3) and read
the full artifacts — the 90-char diff excerpt supported three wrong
theories before the dumped files settled it in one glance.

## The gap closes, the panel folds, and the strips stop diverging (2026-08-30, sixth pass)

Three owner asks and one bug the redesign itself exposed.

**The Expenses table's top margin** was the add-row toolbar holding 32px of
empty space in view mode (buttons hide by visibility so nothing jumps, but
the row keeps its height). Gone: "+ Add row" now lives in the banner — the
owner's own table standard — through a new `extraActions` slot on
ProfileFormModule (a render function over draft+doc; Expenses shows it
only while editing an itemised budget, since a first line created from
outside the streams view would quietly zero the other streams). The gap is
now the standard 20px body padding, same as Accounts.

**The Plan page's input panel is expand/collapse sections** — the panel's
third era (folds → tabs → folds; ScenarioPanel's header carries the whole
arc). Eight headers in a flat stack, each an aria-expanded disclosure
button; exactly ONE opens by default (Plan) so the column starts short,
and all eight stay visible so nothing collapsed is out of sight — the two
failures that killed the first fold era. Sections toggle independently;
the open SET persists ('fplan-inputs-open', seeded once from the tab era's
'fplan-inputs-tab'; an empty stored array is a real all-closed state;
File > New clears both keys). The save-failure banner moved ABOVE the
sections — the one-line-across-the-screen alignment it used to protect
died with the strip.

**The results strip wears .modalTabBar** — the underline dress every other
tabbed view uses — instead of its own .tabs/.tab style; the tab-era
.wb-panel width overrides died with the input strip.

**The bugs independent mounting exposed** (an adversarial review panel over
the diff found what one reading missed — the same discipline that caught
the round-2 batch). The tab era enforced an invariant nobody had written
down: exactly one input card mounted at a time, so a card could copy draft
state at mount and never watch for other writers. Sections broke it three
ways, each with its own guard, pinned in workbenchChrome.test.ts:

- OverridesCard re-emits the WHOLE overrides on every commit
  (buildOverrides), with expenses/income passthroughs captured at mount —
  a blur would revert edits Spending/Tithing/Income made while it sat
  open. Fix in the card: commit re-reads the passthrough branches from the
  live draft. Deliberately NOT a whole-value remount key — that version
  threw keyboard focus away on every committing blur.
- The corporate-share dial has two doors (OverridesCard's field, the Plan
  card's Custom box), each holding a typing buffer seeded at mount; either
  could blur a stale figure over the other's newer write. Both doors are
  keyed by the STORED fraction now, so a write through one reseeds the
  other; typing never commits, so no remount interrupts it.
- EventsCard's open editor saves by the index captured at Edit-click, and
  the Plan card (writePlan reorders the whole array) or the Housing card
  (clears superseded events) could move the rows under it — the save would
  land on the wrong event. EventsCard is keyed by the events VALUE: any
  outside rewrite closes the editor, exactly what leaving the tab used to
  do.

RawJsonCard needed nothing: it mirrors the live draft until touched (a
frozen-then-applied JSON reverting other sections' interim edits is the
Apply button doing what it says). A stored open-set whose every id is
stale falls back to the default instead of reading as all-closed.

The review also caught a round-5 ripple: the Investing form's line writes
(and the new banner Add) skipped applyDerivedStreams, leaving
profile.json's cached scalars stale against the lines — invisible to the
engine, wrong for the delete-all-rows collapse. Every line write now runs
it, pinned. And the open-set storage moved into workbenchLogic.ts so its
four behaviors are EXECUTED (tests/ui/inputSections.test.ts) instead of
string-pinned; the extraActions slot renders in both banner modes, as its
own docstring promised.

## Giving becomes its numbers, and the checkboxes lose their scaffolding (2026-08-30, seventh pass)

**The while-working giving table retired** (the owner's call, with the
right observation behind it: the model reads exactly ONE number off the
giving rows — their monthly total — so they never needed a table).
GivingFields renders one plain field per charitable line, labeled by the
line itself, no add-row — the same shape as InvestingFields, for the same
reasons: pre-itemisation it edits the scalar directly, an itemised budget
with no giving row gets create-on-commit, and multiple lines each keep
their own field with a small Total note (the split is the owner's data —
collapsing it to one box would merge his named rows). Writes go through a
shared editLineById carrying the applyDerivedStreams discipline.

**The preamble became the second first-visit modal.** The
today's-dollars/only-a-Now-column paragraph left the page; a shared
IntroModal component (extracted from the Expenses one — overlay rules,
Escape, default-ticked do-not-show-again, the not-cleared-by-File-New
flag) now serves both, Tithing's under 'fplan-tithing-intro-seen' with
one sentence. The only-a-Now-column half of the old paragraph is not in
the modal: with no columns left there is no asymmetry to explain.

**The strange pot-tab spacing** the owner screenshotted was CheckboxField's
alignment scaffolding: a reserved EMPTY label track plus an input-height
control floor, both built so a checkbox lines up beside labeled inputs in
a horizontal row. In the module's stacked one-per-row layout that is ~50px
of dead air above and between every checkbox. The .moduleFieldset rules
now collapse the track, the label and the height floor — and restore all
three inside .row.inlineRow, where the horizontal alignment they exist
for is real. Same family as the earlier .field-note shim, now with the
checkboxes covered.

The pass's own review panel (13 agents, 3 dimensions) then caught what the
conversion had dropped: the old table's MoneyCell reverted NEGATIVE input
at the field, and NumberField committed it — a Save-time zod banner where
an instant revert used to be. NumberField grew an opt-in `min` floor
(below-min reverts like unparseable text) and every money field on the two
fields-not-tables surfaces declares min 0 — including InvestingFields,
whose identical round-5 gap the panel flagged as pre-existing. The
create-on-commit branches also gained a no-litter guard (a blur with
nothing or zero typed manufactures no line — NumberField commits on every
blur, and tabbing through edit mode must not append $0 rows), the
applyDerivedStreams count pin tightened to exactly five, and the modal
keys, giving branch order, and checkbox CSS all got the coverage the
panel showed they lacked (tests/ui/introModal.test.ts and the fieldSpacing
inverse-pair pins, which compare the inlineRow restore against the base
field rules so the copied values cannot drift).

## The root is Plan's address, the folds go exclusive, and Summary splits (2026-08-30, eighth pass)

**The site root stopped redirecting.** routePath writes '/' for a bare
Plan — the root shows the Plan page under its own address, and the
sidebar's Plan item lands there. '/workbench' still parses (the tab paths
keep their /workbench/<tab> form — the tab is the part worth sending) and
canonicalizes to '/'.

**The results strip split Summary three ways and sent Widow to the end.**
Summary keeps the verdict card; the run-comparison metrics (delta chips,
baseline pin, the provenance run key) moved under DETAILS; the
withdrawal-rate view under WITHDRAWALS. Widow — long defended in nav.ts as
"directly after the answer it qualifies" — moved last at the owner's call.
The browser drives' "a new run landed" signal was the provenance line,
which the split moved out of Summary's sight: the results wrapper now
stamps data-run-key with the on-screen run, and the drives wait on that —
pinned, because a dropped stamp would strand them on a timeout.

**The folds went mutually exclusive** — opening one closes whichever was
open, so the column never grows past one section's content: the accordion
behaves like the tab era did, with all eight labels showing. The storage
keeps its set shape (a multi-id set stored by the few hours of independent
toggling collapses to its first-in-strip-order member). The co-mount
guards from the sixth pass stay with their comments made honest: the
hazards they close are unreachable today, the guards cost nothing, and
this panel has flipped fold semantics once already.

**The double titles died and the chevron grew up.** Each card's inner h2
merely repeated the fold's label; the titles are gone (PlanCard also lost
its "Will this work?" caption — the verdict opposite is that question's
answer), and their InfoTips moved onto the fold headers, which became a
BAR (toggle button + tip beside it, since interactive content may not
nest inside a button). The text-glyph chevron that rendered at a few
pixels became a 14px stroke SVG that rotates on aria-expanded. Settings'
three cards keep their sub-titles: they name different things than the
fold does.

The eighth pass's review panel measured one more thing worth its cost:
the History fold's rehomed header tip opened DOWNWARD into the panel's
clipped bottom edge — ~6px of a 199px bubble visible, nothing signalling
the rest. The section bar became its bubble's containing block, and the
last two folds' tips open UPWARD (the top folds keep the downward default,
which would clip the same way in reverse). Verified live in both
directions; pinned in workbenchChrome.

## History finds the Settings module, the bonds find Investing, and the question marks go (2026-08-30, ninth pass)

**Plan History left the Plan page** for the Settings module's LAST tab —
every tab before it edits the profile; this one looks at what the PLAN
used to be. There is no live draft on that page, so the tab fetches the
plan itself; a restore updates its local copy (the store wrote plan.json
during it), and the Plan page loads the restored file fresh on its next
mount — which retired the workbench's whole in-place restore hand-off
(restoredPlan/onPlanRestored and its save-queue choreography). The Plan
page's remaining Settings fold was renamed ADVANCED — its id stays
'settings' because the id is the stored open-set vocabulary.

**The bonds dial has one home: Investing.** BondsAreSelect moved whole
out of PlanCard into its own file and renders as an always-active card
under the Investing module, editing the PLAN by get-mutate-put with the
Plan page's own save-on-change semantics. Both workbench doors closed —
the Plan card's section and the overrides card's corporate-share field —
which also retired the cross-door staleness keys the review panels had
added; the overrides card now passes the stored value through untouched,
via the same commit-time fresh-passthrough as the other branches.

**The phantom title over the Plan fold** was the first decision section's
top border: every section draws a divider, and with the card's own title
gone the first divider read as an empty heading. The sections wear a
class now and the first one drops its divider in CSS.

**Every "?" icon is gone** — the owner's "sometimes less is more". All of
them flowed through the one InfoTip component, which now renders null;
the call sites and their curated help text deliberately stay (they
document each field where it lives, and re-enabling help is one function
again). Inline `help=` one-liners under fields are not icons and still
render. The fold-header hint machinery and the bubble-flip CSS stay
wired-but-inert for the same reason.

The pass's review panel (32 agents) found the seam the relocations had to
cross: WorkbenchPage flushes an in-window autosave on unmount into a
module-private `session.pendingSave`, and every OTHER consumer of
plan.json had always waited it out (load(), loadPlanIntoWorkbench) — the
two new cards did not. A restore or a bonds get-mutate-put racing that
flush could let the stale PUT land last and silently resurrect the
pre-edit plan, affirmed as success on screen. WorkbenchPage now exports
the gate (awaitPendingPlanSave), a write-chainer that also REGISTERS
itself as the pending write (chainPlanWrite — the bonds card's PUTs ride
it, so the Plan page's next load waits for them too), and
forgetPlanComparisons (the restored plan must not inherit the replaced
plan's pinned baseline — the old restore path's rule, carried across the
move). The restore-flow copy stopped speaking workbench ("it becomes the
current plan; the Plan page runs it the next time you open it"), the
drive's restore receipt waits on BOTH button labels (Restore it renames
to Restoring… while busy — a wait on one label resolves at the rename,
not the completion), and three load-bearing orphaned tips got one-line
`help=` rescues: the ACA how-to, and the survivor-fraction scope note at
both of its doors. The search page's probe/saturation tips stay orphaned
with the page parked.
