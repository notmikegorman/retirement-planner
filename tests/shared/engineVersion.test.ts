/**
 * ENGINE_VERSION must move whenever the engine's numbers can.
 *
 * The run cache is keyed on sha256(engineVersion + input) and persists to
 * `runs/<key>.json` in the data folder. So an engine whose behaviour changed
 * while the constant stood still does not merely miss the cache — it HITS it,
 * and the app serves a result computed by the previous engine for a plan the
 * new one would answer differently. Nothing on screen says so; the numbers just
 * quietly belong to a version that no longer exists.
 *
 * That is not hypothetical. The tithe rule's base moved from the portfolio
 * balance to cumulative real gain — a fix that turned an always-empty giving
 * column into real money — and the user's saved cache went on serving the
 * empty one, because the key had not changed.
 *
 * So this test pins a hash of the engine's own source. Editing anything under
 * src/engine (or the shared contracts it writes through) fails it, and the fix
 * is two lines: bump ENGINE_VERSION, paste the new hash. That is deliberately a
 * small, mechanical chore — the alternative is trusting everyone to remember a
 * cache-invalidation step that has no visible symptom when skipped.
 *
 * A pure refactor with no behaviour change still trips it. Bump anyway: a
 * needless cache miss costs one re-run, while a missed bump costs correctness.
 */
import { createHash } from 'node:crypto';
import { promises as fsp, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../src/shared/types';
import type { Scenario, SimulationInput } from '../../src/shared/types';
import { stableStringify } from '../../src/shared/util';
import { runSimulation } from '../../src/engine/simulate';
import { initDataDir, loadAssumptions, loadProfile } from '../../src/server/dataStore';

/** Every file whose contents can change a number the engine reports. */
function engineSourceFiles(): string[] {
  const dir = fileURLToPath(new URL('../../src/engine', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `${dir}/${f}`);
}

function engineSourceHash(): string {
  const h = createHash('sha256');
  for (const file of engineSourceFiles()) {
    // The name goes in too, so adding or renaming a module counts as a change.
    h.update(file.slice(file.lastIndexOf('/') + 1));
    h.update(readFileSync(file));
  }
  return h.digest('hex');
}

/**
 * The hash of src/engine as of the ENGINE_VERSION below it. BOTH lines move
 * together, always.
 */
const PINNED = {
  // 1.23.0: ONE HASH EVERYWHERE — the engine's last Node import is gone.
  // simulate.ts's private `sha256Hex` (createHash from node:crypto) is
  // replaced by the vendored, dependency-free shared/sha256, the single
  // implementation now behind every digest and cache key in the app. NO
  // ARITHMETIC MOVED: the swap touches only which function turns a string
  // into hex, and that function is proven byte-identical to node:crypto by
  // the FIPS vectors, a 100,000-case seeded property test
  // (tests/shared/sha256.test.ts), and this file's own RunMeta.hashes
  // assertion, whose reference side still calls createHash directly.
  //
  // The proof that behaviour did not move is that every golden digest held
  // WITHOUT a re-pin across this change: mfjUnchanged, both
  // preExpenseLinesUnchanged digests, housingPlan's pins, housingCycles,
  // rentingWindow, guardrails' §7 pins, tithePair's equivalence digests,
  // mortgagePayoff, seppCalendarBust, survivorDownsize and bondComposition
  // all passed untouched. The bump is here because the pin hashes source
  // BYTES and the import line moved — and it is honest anyway: new runKeys
  // mean every cached run recomputes once rather than being trusted across
  // a hash-implementation change.
  //
  // 1.22.0: COMMENTS ONLY — the de-personalisation pass. Every comment in
  // src/engine that cited a real household (names, birth dates, carrier names,
  // actual account balances, actual premiums) was rewritten to cite an
  // invented but equivalent figure, and the gendered survivor narration was
  // rewritten to "the survivor" / "the deceased". NOT ONE LINE OF CODE MOVED:
  // no expression, no constant, no control flow. The bump is here only because
  // the pin hashes the source BYTES, and this file's own doc is explicit that
  // a pure refactor with no behaviour change still bumps — a needless cache
  // miss costs one re-run, a missed bump costs correctness.
  //
  // The proof that behaviour did not move is that every golden digest held
  // WITHOUT a re-pin across this change: mfjUnchanged, both
  // preExpenseLinesUnchanged digests, housingPlan's pins, housingCycles,
  // rentingWindow, guardrails' §7 pins, tithePair's equivalence digests,
  // mortgagePayoff, survivorDownsize and bondComposition all passed untouched.
  //
  // 1.21.0: THE BOND SLEEVE LEARNS WHAT IT IS MADE OF (bondComposition).
  // The historical series gains the Baa corporate column (Damodaran, same
  // page/vintage as the other four; verified against FRED BAA/DBAA yield
  // recomputation — exact to the bp 1928-1985), and market assumptions gain
  // optional bondComposition.corporateFraction (0..1). Each sampled year's
  // bond return becomes (1-f)*bonds10 + f*baa ON THE SAME ROW — one blend
  // site, rowToReturns — so credit-crash behavior stays historical (2008:
  // Treasuries +20.10%, Baa -3.44%). Deterministic mode blends the REAL
  // anchors the same way: (1-f)*deterministicReal.bonds +
  // f*BAA_DETERMINISTIC_REAL (0.035, the series' geometric-mean real,
  // summarised the way the market.json anchors were). Any cached answer for
  // a plan NAMING corporateFraction is wrong under the old engine (the field
  // did not exist), which is what the bump invalidates.
  //
  // Plans WITHOUT the field are bit-for-bit unchanged BY CONSTRUCTION: the
  // f === 0 branch returns row.bonds10 / real.bonds themselves, never the
  // blend evaluated at zero, so no float identity is being trusted.
  // mfjUnchanged, both preExpenseLinesUnchanged digests, housingPlan's pins,
  // guardrails' §7 pins, tithePair's equivalence digests, mortgagePayoff and
  // survivorDownsize all held WITHOUT a re-pin; bondComposition.test.ts
  // additionally pins absent-vs-zero as digest-equal on both the Monte Carlo
  // fan and the deterministic reference path.
  //
  // 1.20.0: the MERGE of two independently-built 1.19.0 engines — the
  // scheduled mortgage payoff and the N-cycle housing/widow-downsizing
  // features below were developed concurrently in separate sessions and
  // each claimed 1.19.0; the combined engine is a third thing neither
  // session tested alone, so it gets its own version and a fresh pin.
  // 1.19.0: THE SCHEDULED MORTGAGE PAYOFF (financing.payoffAfterYears). A
  // financed purchase can now retire its remaining principal in ONE lump N
  // years after origination — same calendar month, N years later. The lump is
  // a capital outflow of that year fed to the ordinary withdrawal solve
  // (outflowFixed), exactly like the purchase's own down payment: taxed
  // draws, penalties under 59 1/2, and the ordinary shortfall path when the
  // year cannot be met — never a wall. The automatic 72(t)'s calendar-aware
  // carve (Fix A) counts scheduled payoffs — this year's fired lump, the held
  // loan's projected one, and future buys' — as committed outflows in both
  // the bridge and lock windows, projected by remainingBalanceAfterPayments
  // (the same amortize loop, so projection and charge are one float). From
  // the payoff month interest, payments and PMI stop; property tax,
  // insurance and maintenance continue. Any cached answer for a plan NAMING
  // the field is wrong under the old engine (it did not exist), which is
  // what the bump invalidates.
  //
  // Plans WITHOUT the field are bit-for-bit unchanged: payoffAfterMonths is
  // null on every loan they originate, the payoff slot degrades to the
  // pre-field arithmetic (payMonths = activeMonths), and the committed-
  // outflow loops add only zero terms (lastCommitYi's Math.max equals the
  // old ascending assignment when no payoff exists). mfjUnchanged, both
  // preExpenseLinesUnchanged digests, housingPlan's pins, tithePair's
  // equivalence digests and guardrails' §7 pins all held WITHOUT a re-pin;
  // mortgagePayoff.test.ts additionally pins at/past-term payoffs as
  // digest-equal to the absent field (the engine-clamp ruling).
  // 1.19.0: N SELL→BUY CYCLES, AND THE SURVIVOR'S DOWNSIZE. Two changes, one
  // dependency between them. FIRST, the housing pipeline learns that sales
  // are a LIST: parseEvents keeps every sell_house (it kept only the LAST —
  // a plan with two sell/rent/buy cycles silently dropped its first sale, the
  // later buy_house REPLACED the still-owned home, and the home's entire
  // equity vanished unsold; measured on the user's shape, a hand-written
  // widow-downsize cycle scored 0.0% while ~$1.3M of home-1 equity
  // evaporated in the first buy year). The between-homes machinery becomes a
  // list of disjoint windows (each sale claims the first unclaimed later
  // purchase), the renting blend / banking arrays accumulate across windows,
  // and the 72(t) calendar reserve's sale projection WALKS the cycles —
  // crediting each scheduled sale up to the last committed purchase, at the
  // projected home state of that moment — so a two-cycle plan's election is
  // capped for the gap the calendar actually leaves, not declined for one it
  // pays itself. SECOND, HousingPlan gains survivorDownsizeTo /
  // survivorDownsizeDelayMonths (absent = 12): a death IN OR AFTER the
  // purchase month compiles a second sell(+delay)→rebuy-cash (or
  // rent-to-horizon) cycle for the survivor — the post-purchase counterpart
  // of survivorPurchasePrice, partitioning the death timeline at the buy
  // month — with property tax NOT rescaled and insurance re-estimated from
  // the downsize price, exactly the survivor-price conventions. Any cached
  // answer for a plan with two cycles or a named downsize is wrong under the
  // old engine (the first could not run them; the second's field did not
  // exist), which is what the bump invalidates.
  //
  // One-cycle plans without the field are bit-for-bit unchanged: one sale
  // parses to a one-entry list, one window drives identical per-year arrays,
  // the funding story still narrates the first (only) window, and the
  // reserve walk over a single cycle visits exactly the years the old lookup
  // did. mfjUnchanged, both preExpenseLinesUnchanged digests, housingPlan's
  // pins, rentingWindow's inert-case equalities, seppCalendarBust and
  // tithePair's equivalence digests all held WITHOUT a re-pin.
  //
  // 1.18.0: THE GUARDRAILS TELL ON THEMSELVES (raiseCeiling + guardrailStats).
  // Two changes, both note 22. FIRST, every path now records its cut/raise
  // history — ever cut, deepest factor, years below plan, ever above plan,
  // floor touched — and runSimulation aggregates them into the ADDITIVE
  // optional RunResult.guardrailStats (present only under the guardrails
  // policy; the depth/duration medians are conditional on cutting). SECOND,
  // the band gains `raiseCeiling`, an opt-in cap on the prosperity raises
  // (min(factor × (1+adj), ceiling)); a raise the ceiling absorbs entirely
  // reports no raise, mirroring the floor's absorbed-cut ruling. Any cached
  // answer for a guardrails plan NAMING a ceiling is wrong under the old
  // engine (the field did not exist), which is what the bump invalidates.
  //
  // Ceiling-less guardrails plans are bit-for-bit unchanged (absent ceiling
  // skips the min() by its undefined check, and the stats are bookkeeping
  // beside the arithmetic, not inside it): guardrails.test.ts §7 pins four
  // ceiling-absent digests — three deterministic flats and a 300-path MC —
  // captured under the 1.17.0 engine, and all held. Non-guardrails plans walk
  // an identical computation path behind the existing null check:
  // mfjUnchanged, both preExpenseLinesUnchanged digests, housingPlan's pins
  // and tithePair's equivalence digests all held WITHOUT a re-pin. The digest
  // suites do not hash guardrailStats (fixed field lists — the
  // purchaseFunding convention), so the additive field moves nothing.
  //
  // 1.17.0: THE 72(t) WALL BECOMES A PRICE (the 0.0% incident, DECISIONS.md).
  // Two changes, both to how a plan meets a year it otherwise could not:
  // FIX A — the automatic election respects the calendar: committed one-off
  // outflows inside the prospective lock window (numeric-price house
  // purchases above all) cap the carve via a closed-form reserve (gap +
  // living top-ups, grossed up for the draws' own tax and penalty), and a cap
  // that zeroes the payment DECLINES the election for re-offer next bridge
  // year. FIX B — a year that cannot be met after every source the ordering
  // may touch (tithe last-resort seat included) BUSTS a live series instead
  // of failing: the lock lifts permanently, the draw proceeds under ordinary
  // penalty rules, and the year is charged the IRC 72(t)(4) recapture (10% of
  // pre-59 1/2 payments + T-bill interest) through the existing penalty
  // machinery. Any cached answer for a plan with a 72(t) beside committed
  // purchases — or one that ever hit the old wall — is wrong under this
  // engine, which is what the bump invalidates.
  //
  // Plans with NO 72(t) involvement are bit-for-bit unchanged (a run that
  // never caps, declines, or busts walks an identical computation path):
  // mfjUnchanged, both preExpenseLinesUnchanged digests, housingPlan's pins
  // and tithePair's equivalence digests all held WITHOUT a re-pin.
  //
  // 1.16.0: THE TWO-KNOB GIVING SPLIT. The bundled 'tithe_account' rule is
  // decomposed into the ONGOING METHOD (retirementGiving, non-pot variants
  // only — PreparedSim.retirementGiving is now OngoingGivingRule) plus THE
  // UN-TITHED POT (ProfileExpenses.untithedPot / the expenses override), with
  // prepareSim's resolveGivingPair as the engine-boundary normaliser. A pot
  // now composes with ANY ongoing method, and its new `ongoingDuringHold:
  // 'give_cash'` pays the ongoing growth tithe in cash from retirement day
  // while the pot holds — configurations the old engine could not express, so
  // no cached answer can exist for them; a legacy bundled rule normalises to
  // its migrated pair and is BIT-IDENTICAL (the tithePair equivalence digests
  // pin old-vs-pair across MC/deterministic, seed on/off, release on/off, and
  // the whole pre-split note-21 suite still passes feeding the bundle through
  // the new path). Percent_of_income beside a pot excludes the pot's own cash
  // flows from its income base (never tithe the tithe) — unreachable under
  // the bundle, so nothing cached moves. Plans without a pot are bit-for-bit
  // unchanged: mfjUnchanged, both preExpenseLinesUnchanged digests and
  // housingPlan's pins all held WITHOUT a re-pin.
  //
  // 1.15.0: THE SURVIVOR'S OWN PURCHASE (housing.survivorPurchasePrice). When
  // any death event lands strictly before the compiled buy month, the housing
  // plan's purchase compiles at the survivor price (or at 'sale_proceeds')
  // instead of the plan price — switched once, in survivorHousingPlan, before
  // the buy_house event is emitted, so the insurance estimate, the cash
  // arithmetic, the 72(t) reservation and the purchaseFunding trace all agree.
  // Any cached widow-style answer for a plan naming the field is wrong under
  // this engine, which is what the bump invalidates.
  //
  // Plans WITHOUT the field are bit-for-bit unchanged — survivorHousingPlan
  // returns the same reference — and the golden digests held WITHOUT a re-pin:
  // housingPlan's pre-plan pin, mfjUnchanged and both preExpenseLinesUnchanged
  // digests, plus the new absent-field digest equalities in
  // housingPlan.test.ts §10.
  //
  // 1.14.0: THE RENTING COLUMN AND BETWEEN-HOMES CASH BANKING (notes 23-24).
  // A living line can carry `monthlyRenting` — its cost while the household
  // is between homes (sold, renting, purchase pending) — and the yearly loop
  // blends those months in month-accurately over the sale→purchase window.
  // While that window is open, the investingMonthly stream's in-window share
  // is redirected to SAVINGS instead of the brokerage and the living
  // reduction the column frees is banked to savings as well (money for an
  // imminent purchase must not be in stocks); the reference path records the
  // whole funding story in RunResult.purchaseFunding for the Housing card's
  // cash-at-purchase readout. Any cached answer for a plan whose budget names
  // renting values — or whose sell→buy window carries an investing stream —
  // is wrong under this engine, which is what the bump invalidates.
  //
  // Plans WITHOUT a sale→purchase window, and windowed plans whose banking is
  // arithmetically zero (no renting column, no in-window investing), are
  // bit-for-bit unchanged: mfjUnchanged (whose four fixtures all carry the
  // sell→rent→buy window), housingPlan's pre-plan pin and both
  // preExpenseLinesUnchanged digests all held WITHOUT a re-pin, and
  // rentingWindow.test.ts pins the inert cases (rent-to-horizon, same-month
  // sale-and-buy, fixed_percent, wholesale living override) as digest
  // equalities.
  //
  // 1.13.0 was the tithe account's soft window; 1.12.0 per-policy
  // life-insurance dispositions; 1.11.0 the itemised budget.
  version: '1.23.0',
  engineSourceSha256: '9ad278391b8be059980b11814245a69b40c5d32532f6d5320a70fe793dfdbff7',
};

describe('ENGINE_VERSION and the run cache', () => {
  it('has been bumped to match the current engine source', () => {
    const actual = engineSourceHash();
    expect(
      actual,
      'src/engine changed. Bump ENGINE_VERSION in src/shared/types.ts and set ' +
        `engineSourceSha256 in this file to:\n  ${actual}\n` +
        'Skipping the bump makes the run cache serve results from the previous engine.',
    ).toBe(PINNED.engineSourceSha256);
    expect(ENGINE_VERSION).toBe(PINNED.version);
  });

  it('reads a version shaped like one, so the cache key can never collapse', () => {
    // A blank or undefined constant would hash identically across every engine
    // and silently disable the invalidation this whole file exists to enforce.
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(engineSourceFiles().length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// The input hash vs node:crypto
// ---------------------------------------------------------------------------

/**
 * The engine hashes through the vendored shared/sha256 (its former private
 * `sha256Hex` copy — once duplicated into the search executor to stay out of
 * the pin's way — is unified there). This test's reference side deliberately
 * KEEPS `createHash` from node:crypto: computing the expectation with a
 * different implementation is exactly what makes the assertion the standing
 * proof that the vendored hash is byte-identical to node's on real
 * profile/assumptions shapes — not just on test vectors. Were both sides ever
 * switched to shared/sha256, the test would compare the function to itself
 * and a divergence from node:crypto (every runKey silently missing the
 * ~hundreds of cached runs on disk) would sail through green.
 */
describe('the input hash matches node:crypto, so cached runs stay reachable', () => {
  /*
   * A FRESH TEMP FOLDER SEEDED FROM data-defaults, exactly like every server
   * test — and NOT the default `~/finance-planner-data`.
   *
   * loadProfile() is a read, but the folder it reads is not read-only:
   * initDataDir backfills assumption defaults and migrateGivingSplitFiles
   * rewrites plan.json in place. Left unset, FPLAN_DATA_DIR resolves to the
   * user's own data folder, so `vitest run` — on a laptop, in CI, in a
   * contributor's clone — would open and potentially migrate real financial
   * records as a side effect of checking a hash. The assertion only needs A
   * profile, never THAT profile: it compares two hashes of whatever it loaded.
   */
  let tmpDir: string;
  let prevEnv: string | undefined;

  beforeAll(async () => {
    prevEnv = process.env.FPLAN_DATA_DIR;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fplan-enginever-'));
    process.env.FPLAN_DATA_DIR = tmpDir;
    await initDataDir();
  });

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
    else process.env.FPLAN_DATA_DIR = prevEnv;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('matches RunMeta.hashes byte for byte', async () => {
    const copy = (v: unknown): string =>
      createHash('sha256').update(stableStringify(v)).digest('hex');

    const profile = await loadProfile();
    const assumptions = await loadAssumptions();
    const result = await runSimulation({
      profile,
      assumptions,
      scenario: { name: 'hash probe', events: [] } as Scenario,
      mode: 'montecarlo',
      seed: 12345,
      paths: 50,
    } as SimulationInput);

    expect(copy(profile)).toBe(result.meta.hashes.profile);
    expect(copy(assumptions)).toBe(result.meta.hashes.assumptions);
  });
});
