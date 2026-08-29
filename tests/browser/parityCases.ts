/**
 * The parity fixtures: the SimulationInputs run through BOTH engines — the
 * Node engine in-process and the browser worker in real Chromium — whose
 * results the gate (parity.test.ts) byte-compares.
 *
 * Built ENTIRELY from data-defaults, never from ~/finance-planner-data: this
 * repo is public and a parity fixture is committed forever, so the inputs are
 * the seeded fictional household and the bundled example scenarios — the same
 * rule every golden-digest suite already follows ("a golden hash must be
 * reproducible from the repo alone, on any machine, forever").
 *
 * The builder takes the RAW defaults as an argument instead of importing them,
 * because each side of the gate acquires bytes its own way — Node reads files,
 * the browser harness bundles them via Vite imports — and this module must run
 * unchanged in both. Handing both sides the same bytes and building the input
 * with the SAME code is what makes "identical inputs" a construction rather
 * than a hope. The historical table arrives as CSV TEXT and is parsed here
 * with the engine's own loadHistoricalCsv, so the parse itself runs (and is
 * therefore proven) in each environment.
 *
 * Case selection: each case exists to drag a distinct slice of the engine
 * through the browser bundle — see each entry's `why`. Everything is seeded
 * and deterministic; nothing reads a clock or the network.
 */
import { loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  RmdTableData,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
} from '../../src/shared/types';

/** The bundled defaults, as parsed JSON values plus the historical CSV text. */
export interface ParityRawDefaults {
  historicalCsv: string;
  market: unknown;
  federal: unknown;
  va: unknown;
  sc: unknown;
  nc: unknown;
  socialSecurity: unknown;
  medicare: unknown;
  aca: unknown;
  rmd: unknown;
  starterProfile: unknown;
  scenarios: {
    baseCase: unknown;
    downsizeCash: unknown;
    retireSepp: unknown;
  };
}

export interface ParityCase {
  id: string;
  /** What this case drags through the browser bundle that the others do not. */
  why: string;
  input: SimulationInput;
}

/**
 * One seed for every case (the starter profile's own). Parity does not need
 * seed variety — byte-equality at ONE seed proves the arithmetic; the seed's
 * own determinism is the rng module's contract, pinned by its tests.
 */
const SEED = 20260812;

export function buildParityCases(raw: ParityRawDefaults): ParityCase[] {
  const historical = loadHistoricalCsv(raw.historicalCsv);
  const assumptions = (): Assumptions => ({
    market: raw.market as MarketAssumptions,
    historical,
    federal: raw.federal as FederalTaxData,
    states: {
      va: raw.va as StateTaxData,
      sc: raw.sc as StateTaxData,
      nc: raw.nc as StateTaxData,
    },
    socialSecurity: raw.socialSecurity as SocialSecurityData,
    medicare: raw.medicare as MedicareData,
    aca: raw.aca as AcaData,
    rmd: raw.rmd as RmdTableData,
  });

  const starter = raw.starterProfile as Profile;
  const baseCase = raw.scenarios.baseCase as Scenario;
  const downsizeCash = raw.scenarios.downsizeCash as Scenario;
  const retireSepp = raw.scenarios.retireSepp as Scenario;

  // Fresh objects per case: execute() is pure, but a shared mutable input
  // would let one case's hypothetical mutation contaminate another's bytes in
  // BOTH environments at once — invisible to a comparison between them.
  const clone = <T>(v: T): T => structuredClone(v);

  /**
   * The tithe-pot + guardrails household: the starter profile giving
   * $1,000/month with the untithed-gains pot enabled beside it, spending under
   * the Guyton-Klinger rails (the explicit published band + the floor).
   */
  const givingGuardrailsProfile = (): Profile => {
    const p = clone(starter);
    p.expenses = {
      ...p.expenses,
      charitableMonthly: 1000,
      retirementGiving: { type: 'continue' },
      // holdYears 5: a real hold window, so the lock/early-release machinery
      // runs instead of degenerating to lock-on-retirement-day.
      untithedPot: { enabled: true, holdYears: 5 },
    };
    p.settings = {
      ...p.settings,
      spendingPolicy: {
        type: 'guardrails',
        guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1, floorFraction: 0.7 },
      },
    };
    return p;
  };

  return [
    {
      id: 'starter-base-deterministic',
      why:
        'The baseline: the untouched starter profile through the bundled base-case ' +
        'scenario, deterministic mode — the full tax/ACA/Medicare/SS/RMD reference ' +
        'path with traces, where a one-byte label divergence (toLocaleString, ' +
        'rounding) has nowhere to hide. The scenario name carries an em-dash, so ' +
        'every hash in meta.hashes covers multi-byte UTF-8 in both environments.',
      input: {
        profile: clone(starter),
        assumptions: assumptions(),
        scenario: clone(baseCase),
        mode: 'deterministic',
        paths: 1,
        seed: SEED,
      },
    },
    {
      id: 'housing-cycle-mc500',
      why:
        'The housing cycle: sell 2031, rent 12 months, buy 2032 for sale_proceeds ' +
        'cash — the between-homes window, banked-cash machinery and ' +
        'purchaseFunding trace, under Monte Carlo so the fan aggregation runs too.',
      input: {
        profile: clone(starter),
        assumptions: assumptions(),
        scenario: clone(downsizeCash),
        mode: 'montecarlo',
        paths: 500,
        seed: SEED,
      },
    },
    {
      id: 'tithe-pot-guardrails-mc400',
      why:
        'The giving split + spending policy: untithed pot beside an ongoing rule, ' +
        'under guardrails — exercises guardrailStats (present only under the ' +
        'rails), the pot arithmetic, and the break-glass figure.',
      input: {
        profile: givingGuardrailsProfile(),
        assumptions: assumptions(),
        // An em-dash here BY CONSTRUCTION (not inherited from a data file): the
        // scenario name flows into meta.hashes.scenario and runKey, so this
        // pins multi-byte hashing even if the bundled scenario names change.
        scenario: { ...clone(baseCase), name: 'Tithe pot + guardrails — parity fixture' },
        mode: 'montecarlo',
        paths: 400,
        seed: SEED,
      },
    },
    {
      id: 'sepp-bridge-mc10000',
      why:
        'The SEPP / early-retirement bridge at final-run scale: an explicit 72(t) ' +
        'election from 2030 and 10,000 Monte Carlo paths — the real final-run ' +
        'shape, where a per-path drift too small to move 400 paths would surface.',
      input: {
        profile: clone(starter),
        assumptions: assumptions(),
        scenario: clone(retireSepp),
        mode: 'montecarlo',
        paths: 10000,
        seed: SEED,
      },
    },
    {
      id: 'base-historical-windows',
      why:
        'Historical mode: every rolling window of the 1928+ table (paths ignored ' +
        'by design) — the one mode whose path count is the DATA, so it proves the ' +
        'CSV text parsed byte-identically in each environment.',
      input: {
        profile: clone(starter),
        assumptions: assumptions(),
        scenario: clone(baseCase),
        mode: 'historical',
        paths: 1,
        seed: SEED,
      },
    },
    {
      id: 'solver-max-spend-mc400',
      why:
        'The solver loop: max_spend bisection (up to 12 inner runs) through ' +
        "execute()'s solver dispatch — solverOutput points, labels and answer, " +
        'none of which the plain cases produce.',
      input: {
        profile: clone(starter),
        assumptions: assumptions(),
        scenario: {
          ...clone(baseCase),
          name: 'Max spend — solver bisection parity fixture',
          solver: { type: 'max_spend' },
        },
        mode: 'montecarlo',
        paths: 400,
        seed: SEED,
      },
    },
  ];
}
