/**
 * Methodology page (SPEC §5): static documentation of how the model works,
 * every deliberate simplification, data sources, and how to read the MAGI
 * chart. The spec requires this page to list the simplifications.
 */
import type { PageProps } from '../nav';

export function MethodologyPage(_props: PageProps) {
  return (
    <div>
      <h1>Methodology</h1>
      <p className="muted">
        How the simulator works, what it deliberately simplifies, and where every tax number comes
        from.
      </p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>How simulations work</h2>
        <p>
          The engine simulates the household one calendar year at a time, from the current year
          through the year both people reach the horizon age (default 95). Ages are evaluated at
          year end: age = year − birth year, with the birth month deciding half-birthdays
          (59½, 70½).
        </p>

        <h3>Order of operations within each simulated year</h3>
        <ol>
          <li>
            <strong>Income</strong> — wages while working, Social Security per the claiming state
            (COLA = simulated CPI), plus interest and dividends from taxable holdings.
          </li>
          <li>
            <strong>Expenses</strong> — living spending × inflation × location multiplier, the
            charitable-giving stream (the working-years stream while anyone earns, the giving rule
            afterwards), the housing module (property tax, insurance, maintenance, rent, mortgage)
            and the health-insurance module (employer coverage → ACA → Medicare). The investing
            stream is handled separately: it is a transfer into the brokerage, not consumption.
          </li>
          <li>
            <strong>Withdrawal solve</strong> — required gross withdrawals are found by fixed-point
            iteration with the tax engine: withdrawals change taxes, taxes change the cash needed,
            iterate to convergence. Withdrawals then follow the ordering policy (default cash →
            taxable → pre-tax → Roth; within pre-tax, IRA first or proportional). Forced
            distributions — RMDs and any live 72(t) stream — are taken before the discretionary
            solve.
          </li>
          <li>
            <strong>Taxes</strong> — the tax engine computes federal tax (ordinary brackets, LTCG
            stacked on top, NIIT, early-withdrawal penalties), state tax (VA/SC/NC), the ACA
            premium tax credit as a tax-return true-up, and Medicare premiums including IRMAA.
          </li>
          <li>
            <strong>RMDs</strong> — forced minimum distributions from the RMD start year (age 75,
            year 2046 — both owners were born after 1960), Uniform Lifetime Table.
          </li>
          <li>
            <strong>Growth</strong> — balances grow per each account&apos;s allocation and that
            year&apos;s asset-class returns, less expense-ratio drag.
          </li>
        </ol>

        <h3>Three return modes</h3>
        <ul>
          <li>
            <strong>Deterministic</strong> — fixed real returns per asset class (user-set defaults
            in market.json). One path; quick sanity checks.
          </li>
          <li>
            <strong>Historical sequences</strong> — replay every rolling N-year window from the
            annual historical series (1928 → latest), the cFIREsim-style method. No distributional
            assumptions.
          </li>
          <li>
            <strong>Monte Carlo (block bootstrap)</strong> — sample contiguous blocks (default 5
            years, configurable 1–10) of <em>joint</em> stock / bond / T-bill / CPI rows from the
            historical series. Asset classes are never sampled independently — preserving their
            correlation and the inflation linkage is the entire point. Seeded and reproducible.
          </li>
        </ul>

        <h3>Success, reporting, and determinism</h3>
        <ul>
          <li>
            <strong>Success</strong> = the portfolio is never insolvent through the horizon (an
            optional terminal-value floor in real dollars can also be required). Success % is the
            fraction of simulated paths that succeed.
          </li>
          <li>
            <strong>Real dollars</strong> — fan charts, terminal values, and Explore answers are
            reported in real (start-year) dollars so results are comparable across years.
          </li>
          <li>
            <strong>Determinism</strong> — the RNG is seeded, so identical inputs always produce
            identical results. Every saved run is stamped with the engine version, seed, and
            content hashes of the profile, assumptions, and plan, and results are cached under
            a content-hash run key.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>One question, and the Explore answers</h2>
        <p>
          Your plan — when each person stops working, when Social Security starts, whether the
          allocation changes, plus whatever else you add — answers exactly one question:{' '}
          <strong>will this work?</strong> The verdict in the Workbench is the share of simulated
          futures in which the money lasts to the horizon, measured against your success target,
          plus the year the money typically runs out in the futures that fail. Nothing has to be
          configured to get that answer, and the plan is always run exactly as written. To weigh
          a change, pin the current run as a baseline and edit: every number then reports how far
          it moved from the pinned run.
        </p>
        <p>
          <strong>Explore</strong> answers the follow-up questions by re-running that same plan
          many times over — one full simulation per year, claiming age or spending level:
        </p>
        <ul>
          <li>
            <strong>The earliest year we could stop working</strong> — replaces the retirement
            dates with each of the next ten years in turn, and also solves the most you could
            spend in each of them.
          </li>
          <li>
            <strong>How much we could spend</strong> — searches for the highest annual living
            expense that still meets the success target, by bisection.
          </li>
          <li>
            <strong>When to claim Social Security</strong> — replaces both claiming dates with each
            age from 62 to 70. Household claiming is a single decision because the second benefit
            is purely spousal and cannot start before the first person files.
          </li>
          <li>
            <strong>How spending changes the odds</strong> — charts success against spending levels
            from roughly 60% to 160% of today&apos;s living plus charitable giving.
          </li>
        </ul>
        <p className="muted">
          Each answer necessarily <em>ignores</em> the part of the plan it is sweeping — a
          claiming sweep cannot honour the claiming date it is varying — so every answer states
          what it overrode. Because they run dozens of simulations, they are much slower than a
          single run; the inner runs are capped at 2,000 paths.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Documented simplifications</h2>
        <p className="muted">
          These are deliberate modeling choices (SPEC §5), not bugs. Each one is encoded in the
          engine exactly as described here.
        </p>
        <ul>
          <li>
            <strong>Annual time steps; ages at year end.</strong> Everything happens once per year;
            a person&apos;s age for a year is their age on December 31.
          </li>
          <li>
            <strong>Medicare transition year (2036) prorated 6/6.</strong> The year both people
            turn 65, premiums are prorated 6 months ACA / 6 months Medicare on the expense side
            only.
          </li>
          <li>
            <strong>Full-year state residency by December 31 domicile.</strong> State residency for
            a whole tax year is wherever the household lives on Dec 31 of that year — no part-year
            returns in v1.
          </li>
          <li>
            <strong>Social Security COLA = simulated CPI, while taxation thresholds stay
            unindexed.</strong> The $32,000/$44,000 provisional-income thresholds are statutory and
            not inflation-indexed (that is the law, not a simplification) — which is why Social
            Security taxation creeps upward in real terms over a long retirement.
          </li>
          <li>
            <strong>No estate or inheritance modeling in v1.</strong> Death events and survivor
            mechanics (filing-status switch, survivor benefit, spousal IRA rollover, compressed
            brackets) are the flagship backlog feature.
          </li>
          <li>
            <strong>VTI is modeled as the US total-market equity class</strong> using the long
            historical series as proxy (VTI itself is too young), with expense ratios applied as a
            per-class drag on returns.
          </li>
          <li>
            <strong>Virginia standard deduction assumed.</strong> The VA return always takes the
            state standard deduction; the federal itemize-vs-standard choice is not linked to the
            state return.
          </li>
          <li>
            <strong>Virginia standard deduction follows the enacted schedule.</strong> $17,500
            for 2026, $18,400 for 2027, $18,600 for 2028–29, then the statutory $6,000 from 2030.
            Virginia has repeatedly extended the elevated amounts, so the post-2029 reversion is
            a deliberately conservative assumption — the fallback is editable in va-2026.json.
          </li>
          <li>
            <strong>Interest and dividends accrue on start-of-year balances.</strong> Cash that
            arrives mid-year (sale proceeds, the investing transfer, a retired year&apos;s swept
            surplus) starts earning interest and dividends the following year.
          </li>
          <li>
            <strong>Medicaid expansion is modeled per state; South Carolina&apos;s coverage gap
            is real.</strong> Virginia (expanded 2019) and North Carolina (expanded 2023) are
            Medicaid-expansion states: a household there with MAGI under 138% of the federal
            poverty level is modeled as Medicaid-enrolled at a $0 premium (no marketplace
            premium tax credit — the tax trace marks such years with a &quot;Medicaid&quot;
            line). South Carolina never expanded Medicaid, so under 2026 law (enhanced credits
            expired) an SC household under 100% of FPL gets no premium tax credit and no
            Medicaid — the full gross premium hits the expense side (traced as &quot;below 100%
            FPL&quot;). Above those lines (138% in VA/NC, 100% in SC), marketplace premiums and
            credits resume per the applicable-percentage table.
          </li>
          <li>
            <strong>The ACA benchmark quote is location-fixed.</strong> The premium tax credit is
            computed from the owner-supplied benchmark silver quote in the Profile, which is
            priced for the origin state; a modeled move keeps that quote after a state change.
            Edit the Profile&apos;s ACA benchmark premium to explore destination pricing.
          </li>
          <li>
            <strong>Financed home purchases sweep leftover sale proceeds into the taxable
            brokerage.</strong> When a purchase is mortgage-financed, sale proceeds remaining
            after the down payment are invested in the taxable brokerage account rather than held
            as cash.
          </li>
          <li>
            <strong>The 72(t) amortization rate is a constant.</strong> It defaults to 5% (the
            Notice 2022-6 floor) rather than tracking the monthly 120%-of-mid-term-AFR figure. The
            split-IRA technique itself is modeled literally — the engine really does carve out a
            second account. See the 72(t) section below for what IS enforced.
          </li>
          <li>
            <strong>An automatic 72(t) is sized off one year, once.</strong> The payment is set
            from the retirement year&apos;s projected need and then held fixed for the life of the
            series, which is what a SEPP is — but the estimate reads that year&apos;s interest,
            dividends and one-off income as if they recurred, and assumes benchmark ACA coverage
            for every non-Medicare month.
          </li>
          <li>
            <strong>Taxable dividends and interest are distributed as cash</strong> rather than
            reinvested inside the taxable account.
          </li>
          <li>
            <strong>Health coverage sequence is fixed:</strong> employer coverage until retirement,
            then ACA marketplace coverage, then Medicare from 65.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>The 401(k) rollover, and why the rule of 55 is not modeled</h2>
        <p>
          When the 401(k) owner retires, the engine rolls the entire 401(k) balance into their
          traditional IRA in that same year (the cashflow row is tagged{' '}
          <span className="badge">401(k) → IRA rollover</span>). Contributions and the employer
          match stop at the same moment. This is the household&apos;s actual plan, so it is
          modeled as fixed behavior rather than a toggle.
        </p>
        <p>
          <strong>Consequence:</strong> the &quot;rule of 55&quot; — which lets you take
          penalty-free distributions from the plan of the employer you separated from at 55 or
          later — is <em>lost</em> the moment the money moves to an IRA. So the app does not model
          it at all, and there is no rule-of-55 withdrawal preference. The bridge to 59½ is
          therefore savings + taxable brokerage + Roth contribution basis + either a 72(t) stream
          or penalized IRA withdrawals — which is why the 72(t) series below is elected
          automatically for any retirement that lands before 59½, rather than being something you
          have to remember to add.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>72(t) / SEPP — automatic, and what the engine enforces</h2>
        <p>
          A 72(t) series is a stream of substantially equal periodic payments from one pre-tax
          account under IRC §72(t)(2)(A)(iv) — the only penalty-free door into IRA money before
          59½ once the 401(k) has been rolled over.
        </p>
        <p>
          <strong>It is on by default.</strong> Any person who stops working in a year before
          their own first penalty-free year gets a series elected for them in that retirement
          year, on their largest traditional IRA — which is the account the 401(k) rolled into
          moments earlier the same year, so the payment is computed on the merged balance. The
          Plan card&apos;s <em>&quot;Use a 72(t) SEPP to reach 59½ penalty-free&quot;</em>{' '}
          checkbox turns it off (<code>autoSepp: false</code> in <code>plan.json</code>); an
          absent field means on, so a file written before the toggle existed gets the bridge too.
          The
          retirement year is tagged{' '}
          <span className="badge">72(t) SEPP started automatically</span>, and the tax trace for
          every paying year shows the amortization inputs behind the payment.
        </p>
        <ul>
          <li>
            <strong>Sized to the plan, not to the maximum.</strong> The payment is the
            household&apos;s projected full-year cash need in the retirement year — living,
            charitable, housing, health and taxes, less Social Security, interest, dividends and
            one-off income, less the cash and taxable balances spread evenly across the years to
            59½. Taxes and ACA premiums depend on the payment itself, so the estimate is resolved
            by a short gross-up loop. Taking the formula maximum instead would force out far more
            ordinary income than the household spends, at a higher marginal rate and against the
            ACA subsidy cliff.
          </li>
          <li>
            <strong>The IRA is split to that payment.</strong> Only the principal the payment
            actually requires is carved into the SEPP IRA (<code>&lt;id&gt;-sepp</code>); the
            remainder keeps the original account id and stays an ordinary, fully accessible
            traditional IRA. The payment is still capped at the formula maximum for the whole
            account, so a plan whose annual need exceeds that maximum takes the payment as the
            maximum and leaves nothing outside the series.
          </li>
          <li>
            <strong>A hand-written election wins.</strong> A person with their own{' '}
            <code>start_72t</code> event keeps exactly the election that event wrote — no
            automatic series is added on top of it.
          </li>
          <li>
            <strong>Payments the year does not need are reinvested.</strong> The series is forced,
            so some years distribute more than the household spends. That surplus buys shares in
            the taxable brokerage (balance and cost basis both rise) rather than sitting in cash.
            This is the one case where leftover cash accumulates: it applies from the first year
            nobody earns a salary, not while a paycheck is still arriving.
          </li>
        </ul>
        <p>The mechanics below apply to every series, automatic or hand-written:</p>
        <ul>
          <li>
            <strong>Fixed amortization method.</strong> Payment ={' '}
            <code>B × r / (1 − (1 + r)^−N)</code>, where B is the account balance in the election
            year (measured <em>after</em> any same-year 401(k) rollover), r is the amortization
            rate and N is the owner&apos;s single life expectancy.
          </li>
          <li>
            <strong>Rate:</strong> the event may supply one (schema-capped at 6%); the default
            is <strong>5%</strong>, the floor set by Notice 2022-6 (greater of 5% or 120% of the
            mid-term AFR).
          </li>
          <li>
            <strong>Life expectancy:</strong> the IRS <strong>single life table</strong> at the
            owner&apos;s attained age in the election year (rmd-table.json, ages 50–70).
          </li>
          <li>
            <strong>The stream is forced, not optional.</strong> Like an RMD, the payment is taken
            every year of the lock whether or not the household needs the cash, taxed as ordinary
            income with penalty exception <code>sepp_72t</code>. Years carrying a payment are
            flagged <span className="badge">SEPP payment</span>.
          </li>
          <li>
            <strong>Lock window:</strong> the later of five payments and age 59½ — so for
            someone already past 59½ a stream started in 2027 runs through 2031, and for
            someone younger it runs to their own 59½ instead. While the lock is
            active the account is skipped by the ordinary withdrawal waterfall — no extra draws,
            which is what would bust the SEPP in real life.
          </li>
          <li>
            <strong>Sizing / the split-IRA technique.</strong> On a hand-written{' '}
            <code>start_72t</code>, leave the annual amount blank for the formula maximum; a
            smaller amount carves a slice of the IRA into a separate account (sized so its own
            formula maximum is that amount) and runs the series on just that slice, leaving the
            remainder ordinary and accessible. Whatever is asked for is capped at the formula
            maximum for the whole account. The automatic election uses the same machinery with
            the amount chosen for you.
          </li>
          <li>
            <strong>After the lock</strong> the account returns to normal treatment: penalized
            before 59½, free afterwards. If the account cannot fund a full payment the stream dies
            and the year is flagged{' '}
            <span className="flag">SEPP account depleted</span> — in reality a busted SEPP
            retroactively penalizes every prior payment, which the app does not attempt to model.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Three spending streams (and the investing transfer)</h2>
        <ul>
          <li>
            <strong>Living expenses</strong> — everyday consumption, inflated every year and
            adjusted by the location multiplier. Excludes health premiums and housing costs, which
            the engine models separately from their own inputs.
          </li>
          <li>
            <strong>Charitable giving</strong> — its own stream, inflated the same way, for as
            long as anyone is earning. It is a real expense AND a tax input: it drives the
            charitable deductions below. You can change it independently with an
            expense-change event on the charitable category. What happens to it once the paychecks
            stop is the giving rule described in the next card — and unlike investing, it does not
            self-terminate.
          </li>
          <li>
            <strong>Investing</strong> — <em>not</em> an expense. While working, this monthly
            amount is transferred into the taxable brokerage (raising both balance and cost basis).
            It is capped by the surplus actually available after taxes, expenses and the 401(k)
            deferral, stops automatically at retirement (the engine drives it off the months
            anyone worked, so there is nothing to switch off), and is excluded from the expense
            total in the cashflow table.{' '}
            <strong>
              While anyone is still earning, this is the only thing that accumulates.
            </strong>{' '}
            Whatever is left after it is <em>consumed</em>, not banked: the living figure you
            entered is a budget baseline, and it does not carry the irregular costs a real year
            brings — replacing an air conditioner, a car repair, a trip, maintenance beyond the
            modeled percentage. Assuming the leftover of a paycheck accumulates would credit the
            plan with saving that does not happen, so the model takes you at your word about what
            you invest and shows the rest on the &quot;Unbudgeted / not invested&quot; line of the
            cashflow breakdown.
          </li>
          <li>
            <strong>Surplus once nobody earns is a different thing, and it IS reinvested.</strong>{' '}
            In retirement the withdrawal solver takes only what the year needs, so a surplus can
            only arise when a <em>forced</em> distribution — an RMD or a 72(t) payment — exceeds
            it. That money arrives whether it is wanted or not, so it is swept into the taxable
            brokerage (cash in = cost basis) rather than parked at the T-bill rate. Households
            with no brokerage account fall back to savings. The retirement year itself follows the
            working rule for the whole year: a surplus is one pool of year-end cash rather than a
            per-month flow, so there is nothing meaningful to prorate, and consuming it is the
            conservative reading.
          </li>
          <li>
            <strong>Employee share of the employer health premium</strong> — a §125 pre-tax
            payroll deduction while working. It reduces W-2 wages exactly like the 401(k) deferral
            (so it never appears as an expense line), and ends at retirement when ACA coverage
            takes over. Its purpose is to make the retire-versus-keep-working health cost
            comparison honest.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Giving after the last paycheck</h2>
        <p>
          The two streams that depend on a salary do not behave the same way when it stops. The
          investing transfer <strong>self-terminates</strong>: it is driven by the months anyone
          in the household worked, so it simply has no base once nobody does. Charitable giving
          has no such cutoff — left alone it runs for life — so the profile carries a{' '}
          <strong>giving rule</strong> (
          <code>expenses.retirementGiving</code>) that says what replaces the paycheck stream, and
          the plan can override it (<code>assumption_overrides.expenses.retirementGiving</code>
          ) so you can weigh a rule without editing the profile. An absent rule means{' '}
          <em>keep giving the same amount</em>, which is exactly what the engine did before the
          rule existed.
        </p>
        <ul>
          <li>
            <strong>Keep giving the same amount</strong> — the working-years stream keeps running
            for life, inflation-adjusted, still subject to charitable expense-change events.
          </li>
          <li>
            <strong>Stop giving</strong> — $0 from the first fully retired year.
          </li>
          <li>
            <strong>A percent of investment growth</strong> — the percentage applies to{' '}
            <em>real portfolio growth</em>: the year&apos;s nominal investment gain across every
            account (distributed interest and dividends plus the growth applied to balances) minus
            that year&apos;s inflation on the start-of-year balance. Contributions, withdrawals,
            sweeps and rollovers are not gains and never count. A down year gives $0 — the rule
            never claws money back. Optional smoothing averages the last N years of growth;
            an optional cap limits the monthly result in today&apos;s dollars.
          </li>
          <li>
            <strong>A percent of income drawn</strong> — the percentage applies to Social Security
            plus gross withdrawals (cash, taxable, pre-tax including RMDs and 72(t) payments, and
            Roth). Roth conversions are excluded: a conversion moves money between accounts and is
            not income to spend.
          </li>
        </ul>
        <p>
          <strong>The un-tithed pot</strong> — a second, independent decision beside the ongoing
          method above (<code>untithedPot</code>; it used to be bundled into a single
          &ldquo;tithe account&rdquo; rule, and old files are migrated to the pair on load).
          Giving stops being only a cheque and gains a <em>balance</em>:
        </p>
        <ul>
          <li>
            On the day the last paycheck stops, a carve-out is opened inside the
            largest pre-tax IRA (id <code>&lt;parent&gt;-tithe</code>, the same split-IRA device
            the 72(t) machinery uses) and seeded with the percentage applied to every retirement
            account&apos;s gains that have <em>never been tithed</em> — its balance minus what the
            owner contributed to it over a career, since those contributions came out of pay that
            was already given on. Because it is an accounting label on money that never leaves the
            IRA, neither the seed nor any later transfer is a distribution and neither costs a
            cent of tax. Through the hold — at most the first N retired years — a
            percent-of-growth ongoing tithe <strong>accrues into the carve-out</strong> instead
            of being paid (the default; the pot&apos;s &ldquo;give in cash&rdquo; switch pays it
            from retirement day instead, and any non-growth ongoing method simply pays its own
            cash throughout — the hold defers the pot, and only a growth tithe has anything
            growth-shaped to accrue). The held balance still <em>counts</em>: it sits in spendable assets and the
            success metric, and the withdrawal ordering may spend it as the{' '}
            <strong>account of last resort</strong> — only after every other bucket is dry, and
            what an emergency takes is gone for good. The hold exists to carry the promise past
            the fragile first years of retirement, so by default it also{' '}
            <strong>releases early</strong>: the first year to close above the real spendable
            balance the plan held at the end of its first retired year proves the fragile window
            over, and the lock starts the next year. From the lock, the carve-out is charity
            money in escrow — out of spendable assets, the success rate, the terminal value and
            the fan chart — and it pays out in cash over M years (balance over years remaining,
            so growth is given too), on top of the ongoing stream. With a pot present, a
            percent-of-growth ongoing tithe runs on a <strong>high-water mark</strong> on the
            real value of the rest of the portfolio: nothing accrues until the portfolio is worth
            more, after inflation, than it has ever been, so climbing back out of a downturn is
            not tithed a second time. Whatever
            remains at the horizon goes to charity, which is also the right tax answer: a
            traditional IRA left to a 501(c)(3) is income in respect of a decedent received by a
            tax-exempt entity, with an uncapped estate deduction.
          </li>
        </ul>
        <p>
          <strong>Two things the pot does not model.</strong> Its share of a required
          minimum distribution cannot be held back — the IRS sees one IRA — so the engine gives
          that money away in cash the year it is forced out rather than letting it fund living
          expenses. And the cash phase is modelled as an ordinary taxable withdrawal plus a §170
          deduction, not as a{' '}
          <strong>qualified charitable distribution</strong>, which would keep the gift out of AGI
          entirely. Both choices are the conservative direction: the QCD simplification overstates
          AGI in disbursement years, and therefore overstates ACA, IRMAA, Social Security
          taxability and NIIT exposure.
        </p>
        <p>
          <strong>Why the percentage rules read the PRIOR year.</strong> This year&apos;s growth
          and this year&apos;s withdrawals both depend on this year&apos;s spending, which would
          include the giving — a circular definition the withdrawal/tax fixed point cannot
          resolve. The prior year is also the number a person would actually have in hand when
          deciding what to give. A rule that governs the very first simulated year therefore has
          no completed year to read and gives $0 that year.
        </p>
        <p>
          The rule takes over on the same signal that stops the investing transfer — the first
          year in which nobody worked a month — and the retirement year itself is prorated: the
          paycheck stream for the months worked, the rule for the rest. Years the rule governs
          carry the <span className="flag">giving-after-work rule</span> flag in the cashflow
          table, whose tax trace names the rule, the base it read and the arithmetic.{' '}
          <strong>
            Whatever a rule gives in CASH lands in expenses, in the expense total, and in the
            year&apos;s charitable tax deductions below
          </strong>{' '}
          — nothing about the deduction machinery changes with the rule. The one deliberate
          exception is a pot still accruing the growth tithe through its hold: those years give
          nothing in cash, so there is nothing to deduct, and the transfer sits below the expense
          total next to the investing transfer for the same reason — it moves money between
          accounts rather than spending it.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Charitable deductions (2026 OBBBA rules)</h2>
        <p>
          The giving stream flows into the federal return two different ways, using the verified
          values in <code>data-defaults/assumptions/tax/federal-2026.json</code>:
        </p>
        <ul>
          <li>
            <strong>Itemizers: a 0.5%-of-AGI floor.</strong> Only cash gifts above 0.5% of AGI
            count as an itemized deduction (<code>charitable.itemizerAgiFloor = 0.005</code>). The
            long-standing 60%-of-AGI ceiling on cash gifts still applies on top, so the itemized
            amount is <code>max(0, min(gifts, 0.60 × AGI) − 0.005 × AGI)</code>.
          </li>
          <li>
            <strong>Non-itemizers: $2,000 above the line, MFJ.</strong> When the standard deduction
            wins, cash gifts up to $2,000 (
            <code>charitable.nonItemizerDeductionMfj = 2000</code>) additionally reduce taxable
            income. The amount is statutory and NOT inflation-indexed in the sim.
          </li>
          <li>
            <strong>Both reduce taxable income, never AGI.</strong> Giving therefore does not move
            the ACA, IRMAA or NIIT MAGI variants — it cannot buy you back under the ACA cliff.
          </li>
          <li>
            <strong>Federal only.</strong> The state modules start from federal AGI (VA, NC) or
            federal taxable income computed on the standard-deduction basis (SC), so charitable
            giving does not change the state return.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Social Security PIA by retirement date</h2>
        <p>
          The SSA statement&apos;s full-retirement-age estimate assumes you keep earning your
          current salary through age 62, so it overstates the benefit of anyone who stops earlier.
          The Profile therefore asks for two figures — the statement number (work to 62) and the
          ssa.gov estimate with future earnings set to $0 (stop now) — and the engine interpolates
          between them from the plan&apos;s retirement date:
        </p>
        <ul>
          <li>No retirement event, or retiring at/after age 62: the work-to-62 figure.</li>
          <li>Retiring in the first simulated year: the stop-now figure.</li>
          <li>
            In between: linear by years worked,{' '}
            <code>(retireYear − 2026) / (age62Year − 2026)</code>.
          </li>
        </ul>
        <p className="muted">
          Documented simplification: the real AIME is an average of the 35 highest earning years,
          so the true curve is slightly concave — the last years before 62 add a little less than
          linear interpolation implies. Linear is within a few percent over the seven-year window
          and needs only the two figures SSA actually publishes. Month granularity is ignored: the
          retirement YEAR drives the blend. The 62-through-70 claiming amounts are always derived
          from this effective PIA by the statutory factors; the spousal benefit uses the same
          effective PIA, so retiring early shrinks it too.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Target-date funds</h2>
        <p>
          An account marked as a target-date fund (e.g. Vanguard Target Retirement 2035) de-risks
          on its own. The engine glides that account&apos;s allocation from the mix you entered
          today, to <strong>50/50 stocks/bonds at the target year</strong>, to{' '}
          <strong>30/70 seven years later</strong>, and holds there — Vanguard&apos;s series keeps
          de-risking for about seven years past the target date before merging into the Income
          fund. Interpolation is linear by year, matching the glidepath event.
        </p>
        <ul>
          <li>
            The allocation you enter is <em>today&apos;s</em> mix, not a fixed one — a 2035 fund is
            roughly 68/32 today.
          </li>
          <li>
            An explicit allocation_change or glidepath event <em>targeted at that account</em>{' '}
            switches the automatic glide off from the date it takes effect: your instruction wins.
            Untargeted events still apply to every non-savings account.
          </li>
          <li>
            The fund&apos;s international equity and bond sleeves are proxied by the US stock and
            bond historical series, and the short-TIPS sleeve near the landing point is folded into
            bonds. The waypoints approximate the published glide, not the prospectus table.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Data sources &amp; verification</h2>
        <ul>
          <li>
            <strong>IRS Rev. Proc. 2025-32</strong> — TY2026 federal brackets, standard deduction,
            and LTCG breakpoints.
          </li>
          <li>
            <strong>IRS Rev. Proc. 2025-25</strong> — 2026 ACA applicable-percentage schedule.
          </li>
          <li>
            <strong>CMS (2026)</strong> — Medicare Part B/D base premiums and IRMAA tiers.
          </li>
          <li>
            <strong>State revenue departments</strong> — tax.virginia.gov, dor.sc.gov, ncdor.gov.
          </li>
          <li>
            <strong>Damodaran (NYU Stern) annual returns dataset, 1928–2025</strong> — US stocks,
            10-year Treasuries, 3-month T-bills, CPI, and Baa corporate bonds (the corporate
            column cross-checked against a FRED yield recomputation).
          </li>
        </ul>
        <p className="muted">
          Every verified number is recorded with its value, source URL, and date checked — see
          VERIFICATIONS.md in the repository.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Reading the MAGI chart</h2>
        <p>
          The Workbench plots each year&apos;s MAGI variants (ACA, IRMAA, and NIIT MAGI differ
          slightly and are computed separately) against the thresholds that actually apply to that
          year:
        </p>
        <ul>
          <li>
            <strong>ACA cliff — through 2035.</strong> While the household is on marketplace
            coverage (retirement until Medicare at 65), MAGI $1 over 400% of the federal poverty
            level forfeits the entire premium tax credit under 2026 law. The chart draws the cliff
            line for every ACA year so near-misses are visible.
          </li>
          <li>
            <strong>IRMAA — from 2034.</strong> Medicare premiums are keyed to MAGI from two years
            prior, so 2034 income sets 2036 premiums. From 2034 onward the chart shows the IRMAA
            tier thresholds: crossing one raises Part B and Part D premiums two years later.
          </li>
          <li>
            <strong>Social Security taxation — after claiming.</strong> Once benefits start, the
            provisional-income thresholds ($32,000/$44,000 MFJ, statutory and unindexed) determine
            how much of the benefit is taxable (up to 85%). Because they never index, simulated
            inflation pushes more of the benefit into taxability over time.
          </li>
        </ul>
      </div>
    </div>
  );
}
