/**
 * The space: which points get tried, in what order, and what a point compiles
 * into.
 *
 * Two failure modes are pinned here because both look like "this decision does
 * not matter" from the outside and neither leaves a mark in the report:
 *
 *   AN AXIS THAT ADDS INSTEAD OF REPLACING. A retireYear level that appends a
 *   retire event without stripping the plan's own leaves two retirement dates
 *   in the scenario; the engine honours whichever it meets first and the search
 *   reports the axis as inert.
 *
 *   A CANONICAL FORM THAT IS NOT CANONICAL. Two byte-different scenarios that
 *   mean the same thing hash to different run keys, so the cache cannot dedupe
 *   them, the engine runs the same simulation twice, and the report shows two
 *   "different" plans that are one plan.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Assumptions,
  Profile,
  Scenario,
  ScenarioEvent,
  SearchAxis,
  SearchBudget,
} from '../../src/shared/types';
import { DEFAULT_GUARDRAILS } from '../../src/shared/types';
import { initDataDir, loadAssumptions, loadProfile } from '../../src/server/dataStore';
import {
  assignmentValues,
  canonicalise,
  compileCandidate,
  describeAssignment,
  dimLabel,
  levelLabel,
  planHash,
  planSpendAnnual,
  sortEvents,
  spaceHash,
  withSpend,
} from '../../src/server/search/compile';
import {
  BASELINE_ASSIGNMENT,
  balancedSample,
  enumerateAll,
  oneKnobNeighbours,
  spaceSize,
} from '../../src/server/search/sample';
import { DEFAULT_BUDGET, buildSchedule } from '../../src/server/search/execute';

let tmpDir: string;
let prevEnv: string | undefined;
let profile: Profile;
let assumptions: Assumptions;

beforeAll(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-space-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();
  profile = await loadProfile();
  assumptions = await loadAssumptions();
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The user's plan as it stands: retire 2033, claim at FRA, nothing else. */
function basePlan(): Scenario {
  return {
    name: 'Plan',
    events: [
      { type: 'retire', person: 'p1', date: '2033-06' },
      { type: 'retire', person: 'p2', date: '2033-06' },
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
    ],
  } as Scenario;
}

function count(events: readonly ScenarioEvent[], type: ScenarioEvent['type']): number {
  return events.filter((e) => e.type === type).length;
}

// ---------------------------------------------------------------------------
// Which points get tried
// ---------------------------------------------------------------------------

describe('the sample', () => {
  const axes: SearchAxis[] = [
    { dim: 'retireYear', levels: [2028, 2030, 2032, 2034] },
    { dim: 'stockShare', levels: [0.4, 0.6, 0.8] },
    { dim: 'claimAge', levels: [62, 67, 70] },
  ];

  it('counts the cartesian product', () => {
    expect(spaceSize(axes)).toBe(36);
    expect(spaceSize([])).toBe(1);
  });

  it('always includes the incumbent, written as the empty assignment', () => {
    // Absent means "leave the plan's own setting", which is what makes the
    // revert-one-knob attribution honest — no guessing which level it is on.
    expect(BASELINE_ASSIGNMENT).toEqual({});
    expect(Object.keys(BASELINE_ASSIGNMENT)).toHaveLength(0);
  });

  it('offers every level of every dimension alone, and nothing else', () => {
    const neighbours = oneKnobNeighbours(axes);
    expect(neighbours).toHaveLength(4 + 3 + 3);
    for (const n of neighbours) expect(Object.keys(n)).toHaveLength(1);
    // Every (dim, level) pair appears exactly once.
    const seen = neighbours.map((n) => JSON.stringify(n));
    expect(new Set(seen).size).toBe(seen.length);
    for (const axis of axes) {
      for (let i = 0; i < axis.levels.length; i++) {
        expect(seen).toContain(JSON.stringify({ [axis.dim]: i }));
      }
    }
  });

  it('balances: every level of every dimension gets the same number of draws', () => {
    const rows = balancedSample(axes, 120, 99);
    expect(rows).toHaveLength(120);
    for (const axis of axes) {
      const tally = new Map<number, number>();
      for (const row of rows) {
        const idx = row[axis.dim] as number;
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(axis.levels.length);
        tally.set(idx, (tally.get(idx) ?? 0) + 1);
      }
      // Uniform sampling would leave one level with 140 observations and
      // another with 200; the marginal effects would then carry different
      // precision per level for no reason.
      expect([...tally.values()]).toEqual(
        new Array(axis.levels.length).fill(120 / axis.levels.length),
      );
    }
  });

  it('balances even when the draw count does not divide the level count', () => {
    const rows = balancedSample([{ dim: 'claimAge', levels: [62, 67, 70] }], 10, 5);
    expect(rows).toHaveLength(10);
    const tally = new Map<number, number>();
    for (const row of rows) tally.set(row.claimAge as number, (tally.get(row.claimAge as number) ?? 0) + 1);
    expect([...tally.values()].sort()).toEqual([3, 3, 4]);
  });

  it('is reproducible from its seed, and a different seed shuffles differently', () => {
    expect(balancedSample(axes, 40, 7)).toEqual(balancedSample(axes, 40, 7));
    expect(balancedSample(axes, 40, 8)).not.toEqual(balancedSample(axes, 40, 7));
  });

  it('enumerates the whole product when it fits, with no duplicates', () => {
    const all = enumerateAll(axes, 10_000);
    expect(all).toHaveLength(36);
    expect(new Set(all.map((a) => JSON.stringify(a))).size).toBe(36);
    for (const a of all) expect(Object.keys(a).sort()).toEqual(['claimAge', 'retireYear', 'stockShare']);
  });

  it('stops exactly at the cap, taking the first cells in axis order', () => {
    // The cap is a visible truncation, not a silent one: the caller gets
    // exactly `cap` cells and the executor turns that into a caveat saying the
    // remainder was never tried and that this prefix is NOT a representative
    // sample.
    const capped = enumerateAll(axes, 10);
    expect(capped).toHaveLength(10);
    expect(capped).toEqual(enumerateAll(axes, 10_000).slice(0, 10));
    expect(enumerateAll(axes, 0)).toHaveLength(0);
  });
});

describe('the successive-halving schedule', () => {
  const budget = (o: Partial<SearchBudget> = {}): SearchBudget => ({ ...DEFAULT_BUDGET, ...o });

  it('cuts to a quarter each round and lands exactly on the finalist count', () => {
    const rounds = buildSchedule(512, budget(), 16);
    expect(rounds[0].candidates).toBe(512);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i].candidates).toBe(rounds[i - 1].keep);
      expect(rounds[i].candidates).toBeLessThan(rounds[i - 1].candidates);
    }
    expect(rounds[rounds.length - 1].keep).toBe(DEFAULT_BUDGET.finalists);
    // Every round's survivors are a subset of its entrants — never a superset.
    for (const r of rounds) expect(r.keep).toBeLessThanOrEqual(r.candidates);
  });

  it('replicates seeds and paths as the field narrows, never beyond what exists', () => {
    const rounds = buildSchedule(512, budget(), 16);
    expect(rounds[0].seeds).toBe(1);
    expect(rounds[0].paths).toBe(DEFAULT_BUDGET.screenPaths);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i].seeds).toBeGreaterThanOrEqual(rounds[i - 1].seeds);
      expect(rounds[i].paths).toBeGreaterThanOrEqual(rounds[i - 1].paths);
    }
    for (const r of rounds) {
      expect(r.seeds).toBeLessThanOrEqual(16);
      expect(r.paths).toBeLessThanOrEqual(DEFAULT_BUDGET.racePaths);
    }
    // A short selection-seed budget clamps every round rather than indexing off
    // the end of the seed list.
    for (const r of buildSchedule(512, budget(), 2)) expect(r.seeds).toBeLessThanOrEqual(2);
  });

  it('degenerates safely on a field no bigger than the finalist count', () => {
    for (const n of [1, 2, 6]) {
      const rounds = buildSchedule(n, budget(), 16);
      expect(rounds).toHaveLength(1);
      expect(rounds[0].candidates).toBe(n);
      expect(rounds[0].keep).toBe(Math.min(n, DEFAULT_BUDGET.finalists));
    }
  });

  it('lands on the finalist count at every field size the default cut reaches', () => {
    for (const n of [64, 512, 1024, 4096, 8192]) {
      const rounds = buildSchedule(n, budget(), 16);
      expect(rounds[rounds.length - 1].keep).toBe(DEFAULT_BUDGET.finalists);
      expect(rounds.map((r) => r.index)).toEqual(rounds.map((_, i) => i + 1));
    }
  });

  /**
   * KNOWN DEFECT — pinned so it cannot get quietly worse, and so the fix has a
   * failing test waiting for it. DELETE THIS TEST WHEN THE CAP IS FIXED.
   *
   * The loop stops after nine rounds ("if (i > 8) break") and returns whatever
   * `keep` that round happened to compute. With a gentle cut factor the field
   * has not reached `budget.finalists` by then, so the last round's keep — 107
   * plans below, 16 at eta = 2 with a full 8,192-candidate field — becomes the
   * finalist set. Nothing anywhere says the requested finalist count was
   * overridden, and each extra finalist costs a full held-out report pass
   * (~180 simulations at 4,000 paths). A request for 6 finalists that quietly
   * runs 107 turns a 20-minute search into a multi-hour one.
   *
   * Both settings below are inside what the API advertises: the request schema
   * allows eta down to 1.5 and candidates up to 8,192.
   */
  it('KNOWN DEFECT: a gentle cut factor hits the round cap and keeps far more than the finalists asked for', () => {
    const gentle = buildSchedule(4096, budget({ eta: 1.5 }), 16);
    expect(gentle).toHaveLength(9);
    expect(gentle[gentle.length - 1].keep).toBe(107);
    // What it SHOULD be:
    // expect(gentle[gentle.length - 1].keep).toBe(DEFAULT_BUDGET.finalists);

    const wide = buildSchedule(8192, budget({ eta: 2 }), 16);
    expect(wide).toHaveLength(9);
    expect(wide[wide.length - 1].keep).toBe(16);

    // It still terminates, and the rounds it does run are internally coherent.
    for (const rounds of [gentle, wide]) {
      expect(rounds.map((r) => r.index)).toEqual(rounds.map((_, i) => i + 1));
      for (const r of rounds) expect(r.keep).toBeLessThanOrEqual(r.candidates);
    }
  });
});

// ---------------------------------------------------------------------------
// What a point compiles into
// ---------------------------------------------------------------------------

describe('compiling one point in the space', () => {
  it('REPLACES the plan\'s own decision rather than adding a second one', () => {
    const axes: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029] },
      { dim: 'claimAge', levels: [70] },
    ];
    const out = compileCandidate(profile, basePlan(), axes, { retireYear: 0, claimAge: 0 });
    // Two people, one retire event each — not four, which is what appending
    // would leave, and which would look exactly like "this axis is inert".
    expect(count(out.events, 'retire')).toBe(2);
    expect(count(out.events, 'claim_social_security')).toBe(2);
    for (const e of out.events) {
      // June, because the BASE PLAN retires in June. A hardcoded month here
      // would hand every candidate a slice of salary the incumbent never had.
      if (e.type === 'retire') expect(e.date).toBe('2029-06');
      // p1 is born 1975-03, so claiming at 70 is 2045-03 for the household.
      if (e.type === 'claim_social_security') expect(e.date).toBe('2045-03');
    }
  });

  it('inherits the retirement MONTH from the plan being searched', () => {
    // The bug this pins: a hardcoded RETIRE_MONTH made a retireYear level equal
    // to the plan's own year compile to a DIFFERENT plan. When the plan retires
    // in June, a July default gave every candidate one extra month of a
    // $180k salary that the baseline lacked — roughly $15k of gross, against a
    // $500/yr practical floor. Every comparison in the report was biased by it,
    // and the bias pointed the same way for all of them, so nothing looked odd.
    for (const month of [1, 3, 6, 9, 12]) {
      const base = basePlan();
      base.events = base.events.map((e) =>
        e.type === 'retire' ? { ...e, date: `2033-${String(month).padStart(2, '0')}` } : e,
      );
      const out = compileCandidate(profile, base, [{ dim: 'retireYear', levels: [2029] }], {
        retireYear: 0,
      });
      for (const e of out.events) {
        if (e.type === 'retire') expect(e.date).toBe(`2029-${String(month).padStart(2, '0')}`);
      }
    }
  });

  it('compiles the plan\'s OWN retirement year back to the plan itself', () => {
    // The no-op property that makes the incumbent a fair baseline: searching a
    // year you already retire in must not quietly move you.
    const base = basePlan();
    const out = compileCandidate(profile, base, [{ dim: 'retireYear', levels: [2033] }], {
      retireYear: 0,
    });
    const dates = (s: Scenario): string[] =>
      s.events.filter((e) => e.type === 'retire').map((e) => e.date).sort();
    expect(dates(out)).toEqual(dates(base));
  });

  it('leaves an axis alone when the assignment does not mention it', () => {
    const axes: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029] },
      { dim: 'claimAge', levels: [70] },
    ];
    const out = compileCandidate(profile, basePlan(), axes, { retireYear: 0 });
    const claims = out.events.filter((e) => e.type === 'claim_social_security');
    expect(claims).toHaveLength(2);
    for (const c of claims) expect((c as { date: string }).date).toBe('2038-06');
  });

  it('writes stock share and glide shape as ONE allocation decision', () => {
    const axes: SearchAxis[] = [
      { dim: 'stockShare', levels: [0.6] },
      { dim: 'glideShape', levels: ['step_now', 'step_at_retirement', 'glide_to_target'] },
    ];
    const now = compileCandidate(profile, basePlan(), axes, { stockShare: 0, glideShape: 0 });
    expect(count(now.events, 'allocation_change')).toBe(1);
    expect(count(now.events, 'glidepath')).toBe(0);

    const atRetirement = compileCandidate(profile, basePlan(), axes, { stockShare: 0, glideShape: 1 });
    const change = atRetirement.events.find((e) => e.type === 'allocation_change');
    expect(change && 'date' in change ? change.date : '').toBe('2033-06');

    const glide = compileCandidate(profile, basePlan(), axes, { stockShare: 0, glideShape: 2 });
    expect(count(glide.events, 'glidepath')).toBe(1);
    expect(count(glide.events, 'allocation_change')).toBe(0);
    const path = glide.events.find((e) => e.type === 'glidepath');
    if (path && path.type === 'glidepath') {
      expect(path.start).toBe('2033-06');
      expect(path.end).toBe('2038-06');
      expect(path.toMix.stocks).toBeCloseTo(0.6, 12);
      expect(path.toMix.bonds).toBeCloseTo(0.4, 12);
    }
  });

  it('scales property tax with the house, so the decision is not priced into a constant', () => {
    const axes: SearchAxis[] = [{ dim: 'housePrice', levels: [900_000, 1_500_000, 'none'] }];
    const cheap = compileCandidate(profile, basePlan(), axes, { housePrice: 0 });
    const dear = compileCandidate(profile, basePlan(), axes, { housePrice: 1 });
    expect(cheap.housing?.propertyTaxAnnual).toBeGreaterThan(0);
    expect(dear.housing?.propertyTaxAnnual).toBeGreaterThan(
      cheap.housing?.propertyTaxAnnual as number,
    );
    expect((dear.housing?.propertyTaxAnnual as number) / (cheap.housing?.propertyTaxAnnual as number))
      .toBeCloseTo(1_500_000 / 900_000, 2);

    // Renting to the horizon owns no house and therefore owes no property tax.
    const renting = compileCandidate(profile, basePlan(), axes, { housePrice: 2 });
    expect(renting.housing?.purchasePrice).toBe('none');
    expect(renting.housing?.propertyTaxAnnual).toBe(0);
  });

  it('does NOT re-date the move when only the price is being searched', () => {
    // A fully-streamed shape: sell June 2027, retire June 2028 — a sale a year
    // BEFORE retirement, which is ordinary and which the old inference could
    // not represent. It computed offset = 2027 - 2028 = -1, clamped it to 0,
    // and rebuilt the sale at retireYear + 0 = 2028-06. Searching PRICE alone
    // therefore shifted every candidate's sale a year later while the baseline
    // stayed put, charging a year of housing timing to the price decision.
    const base = basePlan();
    base.events = base.events.map((e) =>
      e.type === 'retire' ? { ...e, date: '2028-06' } : e,
    );
    base.housing = {
      sellDate: '2027-06',
      rentMonths: 12,
      rentMonthly: 4000,
      purchasePrice: 900_000,
      propertyTaxAnnual: 9_100,
      insuranceAnnual: 4_200,
      financing: { type: 'cash' },
    } as NonNullable<Scenario['housing']>;

    const axes: SearchAxis[] = [{ dim: 'housePrice', levels: [1_200_000, 1_600_000] }];
    for (const i of [0, 1]) {
      const out = compileCandidate(profile, base, axes, { housePrice: i });
      expect(out.housing?.sellDate).toBe('2027-06');
      expect(out.housing?.rentMonths).toBe(12);
    }

    // With the offset axis actually in play, the date moves — that is its job.
    const withOffset = compileCandidate(
      profile,
      base,
      [{ dim: 'moveOffsetYears', levels: [0, 2] }],
      { moveOffsetYears: 1 },
    );
    expect(withOffset.housing?.sellDate).toBe('2030-06');
  });

  it('puts every price level on ONE insurance basis', () => {
    // Dropping the override only for numeric levels left the plan's own
    // hand-entered premium standing on 'sale_proceeds', so a single axis
    // compared an estimated premium against a typed-in one and billed the
    // difference to the price decision.
    const base = basePlan();
    base.housing = {
      sellDate: '2033-06',
      rentMonths: 6,
      rentMonthly: 4000,
      purchasePrice: 900_000,
      propertyTaxAnnual: 9_100,
      insuranceAnnual: 4_200,
      financing: { type: 'cash' },
    } as NonNullable<Scenario['housing']>;

    const axes: SearchAxis[] = [
      { dim: 'housePrice', levels: [1_200_000, 'sale_proceeds', 'none'] },
    ];
    for (const i of [0, 1, 2]) {
      const out = compileCandidate(profile, base, axes, { housePrice: i });
      expect(out.housing?.insuranceAnnual).toBeUndefined();
    }
  });

  it('carries the survivor price through every housing level, and drops it only on none', () => {
    // survivorPurchasePrice is a statement about what SHE would do, not about
    // which candidate house the axis is pricing — so it must ride through every
    // level like appreciationRate does. A compiler that dropped it would make
    // the search's widow probe model her executing each candidate's FULL price,
    // silently restoring the exact assumption the field exists to correct,
    // while every headline number still looked plausible.
    const base = basePlan();
    base.housing = {
      sellDate: '2033-06',
      rentMonths: 6,
      rentMonthly: 4000,
      purchasePrice: 900_000,
      survivorPurchasePrice: 'sale_proceeds',
      propertyTaxAnnual: 9_100,
      financing: { type: 'cash' },
    } as NonNullable<Scenario['housing']>;

    const axes: SearchAxis[] = [
      { dim: 'housePrice', levels: [1_200_000, 'sale_proceeds', 'none'] },
    ];
    for (const i of [0, 1]) {
      const out = compileCandidate(profile, base, axes, { housePrice: i });
      expect(out.housing?.survivorPurchasePrice).toBe('sale_proceeds');
    }

    // 'none' buys nothing, so there is nothing for a survivor to re-price:
    // canonicalisation must delete the inert field, or two rent-for-good
    // candidates differing only in it would hash to two run keys and the
    // cache would run one plan twice.
    const renting = compileCandidate(profile, base, axes, { housePrice: 2 });
    expect('survivorPurchasePrice' in (renting.housing ?? {})).toBe(false);
    const noField = structuredClone(base);
    delete noField.housing!.survivorPurchasePrice;
    expect(planHash(compileCandidate(profile, noField, axes, { housePrice: 2 }))).toBe(
      planHash(renting),
    );
  });

  it('carries payoffAfterYears through the financing axis mortgage level, and drops it on cash', () => {
    // The scheduled payoff is a statement about how the household retires the
    // loan, not about which financing level is being priced — it rides
    // through the axis the way survivorPurchasePrice rides through the price
    // levels above. Dropping it would make the axis's "mortgage" a different
    // loan from the incumbent's and charge the difference to the financing
    // decision.
    const base = basePlan();
    base.housing = {
      sellDate: '2033-06',
      rentMonths: 6,
      rentMonthly: 4000,
      purchasePrice: 900_000,
      propertyTaxAnnual: 9_100,
      financing: { type: 'mortgage', downPct: 0.24, payoffAfterYears: 7 },
    } as NonNullable<Scenario['housing']>;

    const axes: SearchAxis[] = [{ dim: 'financing', levels: ['cash', 'mortgage'] }];
    const mort = compileCandidate(profile, base, axes, { financing: 1 });
    expect(mort.housing?.financing).toMatchObject({ type: 'mortgage', payoffAfterYears: 7 });

    // The cash level carries no inert copy: a cash purchase has no loan to
    // pay off, and a leftover field would fragment the cache key — a
    // cash-level candidate from this base must be ONE plan with a cash-level
    // candidate from a payoff-less base.
    const cash = compileCandidate(profile, base, axes, { financing: 0 });
    expect(cash.housing?.financing).toEqual({ type: 'cash' });
    const noField = structuredClone(base);
    delete (noField.housing!.financing as { payoffAfterYears?: number }).payoffAfterYears;
    expect(planHash(compileCandidate(profile, noField, axes, { financing: 0 }))).toBe(
      planHash(cash),
    );
  });

  it("a 'none' purchase drops the whole mortgage, scheduled payoff included, from the cache key", () => {
    const base = basePlan();
    base.housing = {
      sellDate: '2033-06',
      rentMonths: 6,
      rentMonthly: 4000,
      purchasePrice: 900_000,
      propertyTaxAnnual: 9_100,
      financing: { type: 'mortgage', downPct: 0.24, payoffAfterYears: 7 },
    } as NonNullable<Scenario['housing']>;

    const axes: SearchAxis[] = [{ dim: 'housePrice', levels: [1_200_000, 'none'] }];
    const renting = compileCandidate(profile, base, axes, { housePrice: 1 });
    // canonicalise() rewrites a 'none' plan's financing to plain cash, which
    // is what deletes the payoff along with the rest of the loan nobody takes.
    expect(renting.housing?.financing).toEqual({ type: 'cash' });
    const noField = structuredClone(base);
    delete (noField.housing!.financing as { payoffAfterYears?: number }).payoffAfterYears;
    expect(planHash(compileCandidate(profile, noField, axes, { housePrice: 1 }))).toBe(
      planHash(renting),
    );
  });

  it('describes the point in English and reports level VALUES, not indices', () => {
    const axes: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029, 2033] },
      { dim: 'autoSepp', levels: [true, false] },
      { dim: 'stockShare', levels: [0.7] },
      { dim: 'housePrice', levels: [1_350_000, 'sale_proceeds', 'none'] },
    ];
    const assignment = { retireYear: 0, autoSepp: 0, stockShare: 0, housePrice: 0 };
    expect(describeAssignment(axes, assignment)).toBe(
      'retire 2029 - 72(t) on - 70/30 - $1,350,000 house',
    );
    expect(assignmentValues(axes, assignment)).toEqual({
      retireYear: 2029,
      autoSepp: true,
      stockShare: 0.7,
      housePrice: 1_350_000,
    });
    expect(describeAssignment(axes, {})).toBe('your plan as it stands');
    expect(levelLabel(axes[3], 1)).toBe('buy with whatever the sale leaves');
    expect(levelLabel(axes[3], 2)).toBe('rent for good');
    expect(dimLabel('moveOffsetYears')).toBe('move timing');
    // Honest level names: the old label called a percent level "guardrails".
    const policyAxis: SearchAxis = {
      dim: 'spendingPolicy',
      levels: [{ type: 'fixed_real' }, { type: 'guardrails' }],
    };
    expect(levelLabel(policyAxis, 0)).toBe('fixed real spending');
    expect(levelLabel(policyAxis, 1)).toBe('guardrails spending');
  });
});

describe('the spendingPolicy axis', () => {
  const axes: SearchAxis[] = [
    { dim: 'spendingPolicy', levels: [{ type: 'fixed_real' }, { type: 'guardrails' }] },
  ];
  /** Deliberately NOT the Guyton-Klinger defaults, so a swap would show. */
  const BAND = { upper: 1.4, lower: 0.6, adjustment: 0.2, floorFraction: 0.9 };

  it("carries the user's configured band onto a guardrails level", () => {
    // The level itself carries no parameters, so the compiler must write the
    // owner's rails into the override itself — a candidate that leaned on the
    // engine's merge to find its band would not say which rails it ran. The
    // band must ride along even when the profile is not currently ON
    // guardrails — configured is configured.
    const p = structuredClone(profile);
    p.settings.spendingPolicy = { type: 'fixed_real', guardrails: structuredClone(BAND) };
    const out = compileCandidate(p, basePlan(), axes, { spendingPolicy: 1 });
    expect(out.assumption_overrides?.settings?.spendingPolicy).toEqual({
      type: 'guardrails',
      guardrails: BAND,
    });
  });

  it('falls back to DEFAULT_GUARDRAILS only when the profile has no band', () => {
    const p = structuredClone(profile);
    p.settings.spendingPolicy = { type: 'fixed_real' };
    const out = compileCandidate(p, basePlan(), axes, { spendingPolicy: 1 });
    expect(out.assumption_overrides?.settings?.spendingPolicy).toEqual({
      type: 'guardrails',
      guardrails: DEFAULT_GUARDRAILS,
    });
  });

  it('compiles a level the profile already lives by to the incumbent itself', () => {
    // The incumbent-duplicate trap the autoSepp axis had: an override that
    // says what the plan would do anyway is byte-different but numerically
    // identical, so the incumbent would carry two runKeys, be evaluated
    // twice, and beat itself by exactly zero.
    const p = structuredClone(profile);
    p.settings.spendingPolicy = { type: 'guardrails', guardrails: structuredClone(BAND) };
    const withLevel = compileCandidate(p, basePlan(), axes, { spendingPolicy: 1 });
    expect(withLevel.assumption_overrides).toBeUndefined();
    expect(planHash(withLevel)).toBe(planHash(compileCandidate(p, basePlan(), axes, {})));

    // Same trap, other level: fixed_real on the default fixed_real profile.
    const real = compileCandidate(profile, basePlan(), axes, { spendingPolicy: 0 });
    expect(planHash(real)).toBe(planHash(compileCandidate(profile, basePlan(), axes, {})));
  });

  it('keeps the override when the rails are a real change', () => {
    // The default profile runs fixed_real, so guardrails is a genuine decision
    // and must stay a distinct plan.
    const withLevel = compileCandidate(profile, basePlan(), axes, { spendingPolicy: 1 });
    expect(withLevel.assumption_overrides?.settings?.spendingPolicy?.type).toBe('guardrails');
    expect(planHash(withLevel)).not.toBe(
      planHash(compileCandidate(profile, basePlan(), axes, {})),
    );
  });

  it('drops a hand-written override that only spells out the engine defaults', () => {
    // The engine reads a missing floorFraction as DEFAULT_GUARDRAILS's, so a
    // base override that writes 0.7 explicitly onto a band without one is the
    // same simulation — equality is judged through the engine's eyes, not by
    // bytes.
    const p = structuredClone(profile);
    p.settings.spendingPolicy = {
      type: 'guardrails',
      guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1 },
    };
    const spelled = {
      ...basePlan(),
      assumption_overrides: {
        settings: {
          spendingPolicy: {
            type: 'guardrails',
            guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1, floorFraction: 0.7 },
          },
        },
      },
    } as Scenario;
    expect(planHash(canonicalise(p, spelled))).toBe(planHash(canonicalise(p, basePlan())));
  });

  it('keeps an override that only adds a spending ceiling — the engine reads it', () => {
    /*
     * raiseCeiling has NO engine default: simulate.ts reads an absent ceiling
     * as "uncapped" via its own undefined check, so absent and 1.0 are
     * different simulations. Before the key carried the field, this override
     * compared equal to the uncapped incumbent and canonicalise() deleted it
     * — the search would score the "cuts-only" candidate by silently running
     * the uncapped plan.
     */
    const p = structuredClone(profile);
    p.settings.spendingPolicy = { type: 'guardrails', guardrails: structuredClone(BAND) };
    const capped = () =>
      ({
        ...basePlan(),
        assumption_overrides: {
          settings: {
            spendingPolicy: {
              type: 'guardrails',
              guardrails: { ...BAND, raiseCeiling: 1 },
            },
          },
        },
      }) as Scenario;
    const out = canonicalise(p, capped());
    expect(out.assumption_overrides?.settings?.spendingPolicy?.guardrails?.raiseCeiling).toBe(1);
    expect(planHash(out)).not.toBe(planHash(canonicalise(p, basePlan())));

    // When the profile band already names the same ceiling, the override says
    // what the plan would do anyway and folds into the incumbent as before.
    p.settings.spendingPolicy = {
      type: 'guardrails',
      guardrails: { ...BAND, raiseCeiling: 1 },
    };
    expect(planHash(canonicalise(p, capped()))).toBe(planHash(canonicalise(p, basePlan())));
  });

  it('cleans only the spending policy, leaving other setting overrides standing', () => {
    const redundant = {
      ...basePlan(),
      assumption_overrides: {
        settings: { successTarget: 0.8, spendingPolicy: { type: 'fixed_real' } },
      },
    } as Scenario;
    const out = canonicalise(profile, redundant);
    expect(out.assumption_overrides?.settings?.spendingPolicy).toBeUndefined();
    expect(out.assumption_overrides?.settings?.successTarget).toBe(0.8);
  });
});

describe('canonicalisation: byte-different plans that are one plan', () => {
  it('drops a 72(t) flag that cannot act, so on and off become the same plan', () => {
    const axes: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029, 2038] },
      { dim: 'autoSepp', levels: [true, false] },
    ];
    // Retiring 2038 is past the penalty-free year of BOTH people, which is the
    // one that matters: p1 (born 1975-03, month <= 6) attains 59 1/2 in 2034
    // and is penalty-free from 2035, but p2 (born 1977-09, month > 6) attains
    // it in 2037 and is penalty-free only from 2038. A level that clears p1 but
    // not p2 leaves the bridge live for p2 — which is exactly what this pin
    // caught. Past both, the bridge is a disconnected knob.
    const late = [0, 1].map((i) =>
      planHash(compileCandidate(profile, basePlan(), axes, { retireYear: 1, autoSepp: i })),
    );
    expect(late[0]).toBe(late[1]);

    // Retiring 2029 is early, so the very same knob is a real decision.
    const early = [0, 1].map((i) =>
      planHash(compileCandidate(profile, basePlan(), axes, { retireYear: 0, autoSepp: i })),
    );
    expect(early[0]).not.toBe(early[1]);
  });

  it('drops a glidepath that goes nowhere', () => {
    const mix = { stocks: 0.6, bonds: 0.4, bills: 0 };
    const nowhere = canonicalise(profile, {
      ...basePlan(),
      events: [
        ...basePlan().events,
        { type: 'glidepath', start: '2033-06', end: '2038-06', fromMix: mix, toMix: { ...mix } },
      ],
    } as Scenario);
    expect(count(nowhere.events, 'glidepath')).toBe(0);
  });

  it('is insensitive to the order events were emitted in', () => {
    const forwards = basePlan();
    const backwards = { ...basePlan(), events: [...basePlan().events].reverse() } as Scenario;
    expect(planHash(canonicalise(profile, forwards))).toBe(
      planHash(canonicalise(profile, backwards)),
    );
    expect(sortEvents(backwards.events)).toEqual(sortEvents(forwards.events));
  });

  it('strips the display name, the description and any solver', () => {
    const showy = {
      ...basePlan(),
      name: 'A very memorable name',
      description: 'notes to self',
      solver: { type: 'max_spend' },
    } as Scenario;
    const out = canonicalise(profile, showy);
    expect(out.name).toBe('candidate');
    expect(out.description).toBeUndefined();
    // A solver would make the search recurse into a sweep per candidate.
    expect(out.solver).toBeUndefined();
    expect(planHash(out)).toBe(planHash(canonicalise(profile, basePlan())));
  });

  it('hashes the space itself the same however the axes are ordered', () => {
    const a: SearchAxis[] = [
      { dim: 'retireYear', levels: [2029, 2033] },
      { dim: 'claimAge', levels: [67, 70] },
    ];
    const b: SearchAxis[] = [a[1], a[0]];
    expect(spaceHash(basePlan(), a)).toBe(spaceHash(basePlan(), b));
    expect(spaceHash(basePlan(), a)).not.toBe(
      spaceHash(basePlan(), [{ dim: 'retireYear', levels: [2029, 2034] }, a[1]]),
    );
  });
});

describe('the spending probe', () => {
  it('reads the plan\'s own annual spend, override first', () => {
    expect(planSpendAnnual(profile, basePlan())).toBe(profile.expenses.livingMonthly * 12);
    const overridden = {
      ...basePlan(),
      assumption_overrides: { expenses: { livingMonthly: 9000 } },
    } as Scenario;
    expect(planSpendAnnual(profile, overridden)).toBe(108_000);
  });

  it('moves the retired side with the working side, keeping their ratio', () => {
    // engine/solvers.ts sets only livingMonthly, which is right for a household
    // with no separate retired figure and silently wrong for one that has it:
    // a spend probe would leave retirement spending untouched and flatten the
    // entire success-vs-spending curve the search calibrates on.
    const withRetired: Profile = {
      ...profile,
      expenses: { ...profile.expenses, livingMonthly: 6000, livingMonthlyRetired: 5400 },
    };
    const probed = withSpend(withRetired, basePlan(), 120_000);
    expect(probed.assumption_overrides?.expenses?.livingMonthly).toBe(10_000);
    expect(probed.assumption_overrides?.expenses?.livingMonthlyRetired).toBeCloseTo(9000, 9);
  });

  /**
   * The state scripts/transcribe-budget.ts leaves behind: rows written, the
   * scalar cache never refreshed. prepareSim derives from the rows, so anything
   * here still reading the scalar screens a different plan from the one it runs.
   */
  const staleScalars = (): Profile => ({
    ...profile,
    expenses: {
      ...profile.expenses,
      livingMonthly: 6500,
      lines: [
        { id: 'l1', label: 'household', category: 'living', monthlyNow: 6390, monthlyRetired: 4790 },
        // The one car: its payment does not fall when they retire either.
        { id: 'l2', label: 'car payment', category: 'living', monthlyNow: 610 },
      ],
    },
  });

  it('screens the spend the budget says, not the stale scalar beside it', () => {
    // 7,000/mo of rows against a 6,500 cache: reading the cache reported
    // $78,000/yr for a plan the engine ran at $84,000.
    expect(planSpendAnnual(staleScalars(), basePlan())).toBe(84_000);
  });

  it('moves the retired side a budget names, which no scalar on the profile does', () => {
    // The failure the ratio branch exists to prevent, reached THROUGH that
    // branch: the profile has no `livingMonthlyRetired`, so reading the scalar
    // skipped the write entirely and prepareSim then pinned every probe to the
    // budget's own 5,400/mo.
    const probed = withSpend(staleScalars(), basePlan(), 120_000);
    expect(probed.assumption_overrides?.expenses?.livingMonthly).toBe(10_000);
    expect(probed.assumption_overrides?.expenses?.livingMonthlyRetired).toBeCloseTo(
      10_000 * (5400 / 7000),
      9,
    );
  });

  it('does not mutate the scenario it was handed', () => {
    const original = basePlan();
    const snapshot = JSON.stringify(original);
    withSpend(profile, original, 150_000);
    compileCandidate(profile, original, [{ dim: 'retireYear', levels: [2028] }], { retireYear: 0 });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('keeps assumptions out of the plan: only the scenario varies', () => {
    // Every axis is expressible on the Scenario. That is a hard constraint, not
    // a coincidence — the server resolves profile and assumptions from disk on
    // every run, so a search that needed to vary them could not be cached.
    expect(assumptions).toBeDefined();
    const out = compileCandidate(profile, basePlan(), [{ dim: 'state', levels: ['sc'] }], {
      state: 0,
    });
    expect(count(out.events, 'state_change')).toBe(1);
    // ... and choosing the state the household already lives in writes nothing.
    const stay = compileCandidate(
      profile,
      basePlan(),
      [{ dim: 'state', levels: [profile.filing.state] }],
      { state: 0 },
    );
    expect(count(stay.events, 'state_change')).toBe(0);
  });
});
