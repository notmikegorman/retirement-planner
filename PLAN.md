# PLAN — Retirement Planner

Maps SPEC.md §10 phases to concrete work items.

> **This is a historical build plan, kept for the record.** It describes the original
> phasing, not the current codebase. Where the two disagree the code wins; the
> divergences known at the time of writing are called out inline. `ARCHITECTURE.md`
> describes what is actually built.

The standing instruction for the build was: work through all phases without pausing for
approval; encode every unknown as an editable Profile/assumption input with a placeholder
value; summarize assumptions and open questions at the end (see `ASSUMPTIONS.md`).

## Phase mapping

- **P0 — Scaffold** ✅ planned
  - Vite + React + TS frontend, Fastify server (tsx runtime), Vitest, single npm package.
  - `src/shared` contract types + Zod validation; data folder seeding (`~/finance-planner-data/`).
  - Profile editor; deterministic projection w/ federal ordinary tax; portfolio chart.
- **P1 — Full tax stack**
  - `src/tax`: federal (brackets, std/itemized, LTCG stacking, SS taxation worksheet, NIIT,
    penalties incl. rule of 55 / 72(t) / 59½), states (VA/SC/NC), §121, ACA PTC + cliff,
    Medicare/IRMAA (2-year MAGI lookback), RMDs (age 75, Uniform Lifetime Table),
    MAGI variants, `detailTrace`.
  - §8 fixture + property tests (fast-check).
- **P2 — Stochastic modes**
  - Historical rolling windows; block-bootstrap MC (joint rows, seeded); success metrics,
    percentile fans, run cache keyed by content hash; worker thread.
- **P3 — Events + Compare**
  - Housing (sell/rent/buy/mortgage), state moves, allocation/glidepath, withdrawal
    strategy, one-time items, 72(t) start, Roth conversion event; Compare view.
- **P4 — SS + solvers**
  - SS benefit math (worker + spousal factors, deemed filing), claim sweep, max-spend,
    earliest-retirement, SWR curve solvers; MAGI chart. Six acceptance scenarios pass.
- **P5 — Polish**: methodology page, docs (ARCHITECTURE.md, DECISIONS.md, VERIFICATIONS.md).
- **P6 — originally backlog, MOSTLY BUILT SINCE.** This line used to read "not built".
  Survivor mechanics and guardrails are now flagship features — the widow score
  (`src/ui/components/results/WidowCard.tsx`), per-line survivor spending, multi-policy
  life insurance, the survivor's own purchase and downsize, and the guardrails spending
  policy, all covered by `tests/engine/survivor*.test.ts` and
  `tests/engine/guardrails.test.ts`. Still genuinely not built: a Roth-conversion
  optimizer and stochastic mortality.

## Verification strategy (SPEC §8)

A background research workflow checks every VERIFY number against primary sources
(irs.gov, cms.gov, state DORs, KFF) and fetches Damodaran's historical series. Values I
encoded from model knowledge that could not be confirmed online are flagged
`needs_verification` in `VERIFICATIONS.md` — none are silently guessed without a flag.

## Decisions taken unilaterally (per instruction)

Every unknown became an editable Profile field with a plausible invented placeholder
rather than a blocking question — salary, PIA, baseline expenses and the liquid split
among them. The shipped starter profile carries those placeholders today; full list in
`ASSUMPTIONS.md`.
