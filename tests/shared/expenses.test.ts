/**
 * The derivation layer — src/shared/expenses.ts — and the promise that made it
 * safe to add: A PROFILE WITHOUT LINES IS UNTOUCHED.
 *
 * Three properties are worth more than the rest here.
 *
 * 1. DISPLAY-ONLY CATEGORIES NEVER REACH A STREAM. A budget carries rows the
 *    engine already models from its own inputs (property tax, home insurance,
 *    health premiums) and rows that are not consumption at all (a credit-card
 *    payment, when everything is run through a card for the cash back). Summing
 *    those is the bug the categories exist to prevent: $820/mo of housing once
 *    sat inside the living baseline while the housing plan charged it too,
 *    costing 7.8 points of success rate.
 *
 * 2. BLANK MEANS INHERIT, NOT ZERO. A blank retired cell is "the same as
 *    today"; a blank survivor cell is "the same as whichever state is in
 *    force". Read as zeroes they would delete most of a household's spending
 *    and hand back a 100% success rate for a household that had stopped eating.
 *
 * 3. THE PRE-BUDGET PROFILE IS BIT-FOR-BIT UNCHANGED. Not "close" — the same
 *    digest of the same run, including the reference path's tax traces. That is
 *    the migration promise, and the last section runs real simulations to
 *    prove it rather than asserting it about the five scalars in isolation.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deriveExpenseStreams,
  effectiveLineMonthly,
  rentingLivingMonthly,
  survivorLivingMonthly,
} from '../../src/shared/expenses';
import { runSimulation } from '../../src/engine/simulate';
import { loadHistoricalCsv } from '../../src/engine/returns';
import type {
  AcaData,
  Assumptions,
  ExpenseLine,
  ExpenseLineCategory,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Profile,
  ProfileExpenses,
  RmdTableData,
  RunResult,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
} from '../../src/shared/types';
import marketJson from '../../data-defaults/assumptions/market.json';
import federalJson from '../../data-defaults/assumptions/tax/federal-2026.json';
import vaJson from '../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../data-defaults/assumptions/tax/nc-2026.json';
import ssJson from '../../data-defaults/assumptions/social-security.json';
import medicareJson from '../../data-defaults/assumptions/medicare-2026.json';
import acaJson from '../../data-defaults/assumptions/aca-2026.json';
import rmdJson from '../../data-defaults/assumptions/rmd-table.json';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextId = 0;

/** One budget line. Only what a test is actually asserting about is named. */
function line(
  category: ExpenseLineCategory,
  monthlyNow: number,
  rest?: Partial<
    Pick<ExpenseLine, 'monthlyRetired' | 'monthlyRenting' | 'monthlySurvivor' | 'label'>
  >,
): ExpenseLine {
  return {
    id: `l${++nextId}`,
    label: rest?.label ?? `${category} line`,
    category,
    monthlyNow,
    ...(rest?.monthlyRetired === undefined ? {} : { monthlyRetired: rest.monthlyRetired }),
    ...(rest?.monthlyRenting === undefined ? {} : { monthlyRenting: rest.monthlyRenting }),
    ...(rest?.monthlySurvivor === undefined ? {} : { monthlySurvivor: rest.monthlySurvivor }),
  };
}

/** A representative set of streams: living 7,100, giving 2,300, investing 1,250. */
function expenses(over?: Partial<ProfileExpenses>): ProfileExpenses {
  return {
    livingMonthly: 7100,
    charitableMonthly: 2300,
    investingMonthly: 1250,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Only the summed categories feed a stream
// ---------------------------------------------------------------------------

describe('display-only categories never reach a modeled stream', () => {
  it('leaves housing the engine already models out of the living stream', () => {
    /*
     * The $768 of housing that caused the original double-count, transcribed
     * the way the budget actually reads it: property tax, home insurance and
     * maintenance are 'modeled_elsewhere' because the housing plan charges
     * them from the home's own value. Summing them here charges them twice.
     */
    const derived = deriveExpenseStreams(
      expenses({
        lines: [
          line('living', 7100),
          line('modeled_elsewhere', 520, { label: 'property tax' }),
          line('modeled_elsewhere', 248, { label: 'home insurance' }),
        ],
      }),
    );
    expect(derived.livingMonthly).toBe(7100);
  });

  it('leaves the life-insurance premium to the policies, which own the end date', () => {
    const derived = deriveExpenseStreams(
      expenses({ lines: [line('living', 7100), line('insurance', 300, { label: 'term life' })] }),
    );
    expect(derived.livingMonthly).toBe(7100);
  });

  it('leaves an excluded row out of every stream, in every column', () => {
    // A credit-card payment is a transfer, not consumption. Ten thousand a
    // month of it must move nothing — including the retired and survivor
    // columns, which is where a category check applied in only one place fails.
    const withCard = expenses({
      lines: [
        line('living', 7100, { monthlyRetired: 5400, monthlySurvivor: 4600 }),
        line('excluded', 10_000, { monthlyRetired: 10_000, monthlySurvivor: 10_000 }),
      ],
    });
    const derived = deriveExpenseStreams(withCard);
    expect(derived.livingMonthly).toBe(7100);
    expect(derived.livingMonthlyRetired).toBe(5400);
    expect(survivorLivingMonthly(withCard, true)).toBe(4600);
  });

  it('sums the three streams separately — giving and investing are not living', () => {
    const derived = deriveExpenseStreams(
      expenses({
        lines: [
          line('living', 4000),
          line('living', 3100),
          line('charitable', 2300),
          line('investing', 1250),
          line('modeled_elsewhere', 999),
          line('insurance', 300),
          line('excluded', 5000),
        ],
      }),
    );
    expect(derived.livingMonthly).toBe(7100);
    expect(derived.charitableMonthly).toBe(2300);
    expect(derived.investingMonthly).toBe(1250);
  });
});

// ---------------------------------------------------------------------------
// 2. Absent means inherit — the two optional columns
// ---------------------------------------------------------------------------

describe('a blank cell inherits rather than zeroing', () => {
  it('reads a blank retired cell as this month’s figure', () => {
    expect(effectiveLineMonthly(line('living', 610), { retired: true, survivor: false })).toBe(610);
  });

  it('reads a blank survivor cell as the WORKING figure while somebody works', () => {
    const l = line('living', 900, { monthlyRetired: 700 });
    expect(effectiveLineMonthly(l, { retired: false, survivor: true })).toBe(900);
  });

  it('reads a blank survivor cell as the RETIRED figure once nobody does', () => {
    // The chain is survivor -> retired -> now. Inheriting `monthlyNow` here
    // instead would walk a widow's spending back up to the couple's working
    // baseline in the middle of retirement.
    const l = line('living', 900, { monthlyRetired: 700 });
    expect(effectiveLineMonthly(l, { retired: true, survivor: true })).toBe(700);
  });

  it('lets a named survivor figure win over both, in either state', () => {
    const l = line('living', 900, { monthlyRetired: 700, monthlySurvivor: 500 });
    expect(effectiveLineMonthly(l, { retired: false, survivor: true })).toBe(500);
    expect(effectiveLineMonthly(l, { retired: true, survivor: true })).toBe(500);
  });

  it('reads a blank renting cell as whichever figure is in force', () => {
    // "Between homes" changes nothing about a line that did not name it:
    // groceries cost the same in an apartment.
    const l = line('living', 900, { monthlyRetired: 700 });
    expect(effectiveLineMonthly(l, { retired: false, survivor: false, renting: true })).toBe(900);
    expect(effectiveLineMonthly(l, { retired: true, survivor: false, renting: true })).toBe(700);
  });

  it('lets a named renting figure override the in-force figure in both states', () => {
    // Heating oil is zero in an apartment whether or not anyone still works —
    // and a typed 0 is a decision, exactly like the retired column's.
    const l = line('living', 200, { monthlyRetired: 210, monthlyRenting: 0 });
    expect(effectiveLineMonthly(l, { retired: false, survivor: false, renting: true })).toBe(0);
    expect(effectiveLineMonthly(l, { retired: true, survivor: false, renting: true })).toBe(0);
  });

  it('never lets the renting figure reach a survivor month, even as a fallback', () => {
    // The chain places renting BELOW survivor: after a death the survivor
    // column governs outright (the engine ignores the renting column from the
    // death year), so a blank survivor cell inherits the working/retired
    // figure — not the couple's apartment discount.
    const l = line('living', 900, { monthlyRetired: 700, monthlyRenting: 100 });
    expect(effectiveLineMonthly(l, { retired: false, survivor: true, renting: true })).toBe(900);
    expect(effectiveLineMonthly(l, { retired: true, survivor: true, renting: true })).toBe(700);
    const named = line('living', 900, { monthlyRenting: 100, monthlySurvivor: 500 });
    expect(effectiveLineMonthly(named, { retired: true, survivor: true, renting: true })).toBe(500);
  });

  it('treats an absent `renting` flag exactly as false', () => {
    // Every caller written before the flag existed passes two-field states;
    // they must keep meaning what they meant.
    const l = line('living', 900, { monthlyRenting: 100 });
    expect(effectiveLineMonthly(l, { retired: false, survivor: false })).toBe(900);
    expect(effectiveLineMonthly(l, { retired: false, survivor: false, renting: false })).toBe(900);
  });

  it('keeps a zero a zero — the one figure that is not "inherit"', () => {
    // 0 and absent are different inputs and must stay different: this is how a
    // household says "we stop investing when the paychecks stop".
    const l = line('investing', 1250, { monthlyRetired: 0 });
    expect(effectiveLineMonthly(l, { retired: true, survivor: false })).toBe(0);
    expect(deriveExpenseStreams(expenses({ lines: [l] })).investingMonthlyRetired).toBe(0);
  });

  it('inherits per line, so one named retired figure does not zero its neighbours', () => {
    const derived = deriveExpenseStreams(
      expenses({
        lines: [
          line('living', 3000, { monthlyRetired: 2000 }),
          line('living', 610), // the car: unchanged by retirement
          line('living', 500),
        ],
      }),
    );
    expect(derived.livingMonthlyRetired).toBe(2000 + 610 + 500);
  });

  it('reports NO retired figure when not one living line names one', () => {
    /*
     * Arithmetically the retired total would equal the working total, so this
     * could return the number — and it must not. `undefined` skips the
     * retirement year's worked-months blend entirely, while an equal-but-
     * present figure walks through `x * (5/12) + x * (7/12)`, which is not x
     * in floating point. Only `undefined` is bit-identical to a budget-free
     * profile whose lines all inherit.
     */
    const derived = deriveExpenseStreams(
      expenses({ lines: [line('living', 4000), line('living', 3100)] }),
    );
    expect(derived.livingMonthly).toBe(7100);
    expect(derived.livingMonthlyRetired).toBeUndefined();
  });

  it('reports the retired INVESTING figure as a number, because absent means 0 there', () => {
    // The asymmetry with living above is deliberate: an absent scalar
    // `investingMonthlyRetired` means 0, while a blank retired CELL means "the
    // same as now". Where there is a budget the budget wins, so a line left
    // blank keeps investing $1,250/mo in retirement and says so out loud.
    const derived = deriveExpenseStreams(expenses({ lines: [line('investing', 1250)] }));
    expect(derived.investingMonthlyRetired).toBe(1250);
  });
});

// ---------------------------------------------------------------------------
// 3. No lines: the scalars are the truth, field for field
// ---------------------------------------------------------------------------

describe('no budget means the scalars are returned unchanged', () => {
  it('returns the scalars when `lines` is absent, absent columns staying absent', () => {
    const e = expenses();
    expect(deriveExpenseStreams(e)).toEqual({
      livingMonthly: 7100,
      charitableMonthly: 2300,
      investingMonthly: 1250,
      livingMonthlyRetired: undefined,
      investingMonthlyRetired: undefined,
    });
  });

  it('returns the scalars when `lines` is empty — [] is not a budget', () => {
    const e = expenses({ lines: [], livingMonthlyRetired: 5400, investingMonthlyRetired: 0 });
    expect(deriveExpenseStreams(e)).toEqual({
      livingMonthly: 7100,
      charitableMonthly: 2300,
      investingMonthly: 1250,
      livingMonthlyRetired: 5400,
      investingMonthlyRetired: 0,
    });
  });

  it('does not invent a retired figure equal to the working one', () => {
    // The trap this whole module has to avoid: `{ ...expenses }` with a
    // computed retired column would turn "absent" into "7100", which the
    // engine treats as a different input (see the blend above).
    expect(deriveExpenseStreams(expenses()).livingMonthlyRetired).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3b. The renting living stream
// ---------------------------------------------------------------------------

describe('rentingLivingMonthly', () => {
  it('returns null with no budget, and null when no living line names the column', () => {
    // Null is what lets the engine skip the renting blend outright — the
    // bit-identity gate for every profile written before the column existed.
    expect(rentingLivingMonthly(expenses())).toBeNull();
    expect(rentingLivingMonthly(expenses({ lines: [] }))).toBeNull();
    expect(rentingLivingMonthly(expenses({ lines: [line('living', 900)] }))).toBeNull();
  });

  it('sums living lines per state, blanks inheriting their in-force figures', () => {
    // oil 0 (typed), utilities 300/250 (inherited), car 610 (inherited both):
    // working 0 + 300 + 610 = 910; retired 0 + 250 + 610 = 860.
    const e = expenses({
      lines: [
        line('living', 200, { monthlyRetired: 210, monthlyRenting: 0 }),
        line('living', 300, { monthlyRetired: 250 }),
        line('living', 610),
      ],
    });
    expect(rentingLivingMonthly(e)).toEqual({ working: 910, retired: 860 });
  });

  it('ignores a renting figure on any non-living line — those cells are dead', () => {
    const e = expenses({
      lines: [
        line('living', 900),
        line('charitable', 2300, { monthlyRenting: 1 }),
        line('investing', 1250, { monthlyRenting: 2 }),
        line('modeled_elsewhere', 500, { monthlyRenting: 3 }),
      ],
    });
    expect(rentingLivingMonthly(e)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The survivor's living stream
// ---------------------------------------------------------------------------

describe('survivorLivingMonthly', () => {
  it('returns null with no budget, so the caller keeps the global fraction', () => {
    // Null, never 0: a 0 would zero a widow's groceries and report the plan as
    // a 100% success. Null is the signal that this household has said nothing
    // per line and DEFAULT_SURVIVOR_LIVING_FRACTION still governs.
    expect(survivorLivingMonthly(expenses(), false)).toBeNull();
    expect(survivorLivingMonthly(expenses({ lines: [] }), true)).toBeNull();
  });

  it('holds a one-car household’s payment flat, which no global fraction can', () => {
    /*
     * THE FACT THAT JUSTIFIES PER-LINE SURVIVOR AMOUNTS. They own ONE car, so
     * the $610 payment does not fall by a quarter when one of them dies — it
     * does not fall at all. Groceries do. A 0.75 fraction on the couple's
     * $2,264 baseline says $1,698; the lines say $1,914, and the lines are
     * right.
     */
    const e = expenses({
      lines: [
        line('living', 610, { label: 'car payment' }),
        line('living', 1200, { label: 'groceries', monthlySurvivor: 850 }),
        line('living', 300, { label: 'phones', monthlySurvivor: 200 }),
      ],
    });
    expect(survivorLivingMonthly(e, false)).toBe(610 + 850 + 200);
    expect(survivorLivingMonthly(e, false)).not.toBe(2264 * 0.75);
  });

  it('reads the retired column when the survivor is retired and named no figure', () => {
    const e = expenses({
      lines: [
        line('living', 1200, { monthlyRetired: 1000, monthlySurvivor: 850 }),
        line('living', 500, { monthlyRetired: 300 }),
      ],
    });
    expect(survivorLivingMonthly(e, false)).toBe(850 + 500);
    expect(survivorLivingMonthly(e, true)).toBe(850 + 300);
  });

  it('is the LIVING stream only — giving and investing are their own decisions', () => {
    // A survivor's giving is governed by the retirement-giving rule and her
    // investing by the surplus cap. Folding either into the living figure
    // would double-charge her exactly the way housing once was.
    const e = expenses({
      lines: [
        line('living', 1000, { monthlySurvivor: 800 }),
        line('charitable', 2300, { monthlySurvivor: 2300 }),
        line('investing', 1250, { monthlySurvivor: 1250 }),
      ],
    });
    expect(survivorLivingMonthly(e, false)).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// 5. Round-trip: a budget built out of a scalar profile derives back to it
// ---------------------------------------------------------------------------

/**
 * The two documented absences resolved to their meanings, so a round-trip can
 * be compared on what the household actually spends rather than on which of
 * two equivalent encodings it happens to use.
 */
function resolved(e: {
  livingMonthly: number;
  charitableMonthly: number;
  investingMonthly: number;
  livingMonthlyRetired?: number | undefined;
  investingMonthlyRetired?: number | undefined;
}): Record<string, number> {
  return {
    livingMonthly: e.livingMonthly,
    charitableMonthly: e.charitableMonthly,
    investingMonthly: e.investingMonthly,
    // Absent retired living = the same as working; absent retired investing = 0.
    livingMonthlyRetired: e.livingMonthlyRetired ?? e.livingMonthly,
    investingMonthlyRetired: e.investingMonthlyRetired ?? 0,
  };
}

/** The migration the UI performs: one line per stream, every column explicit. */
function linesFromScalars(e: ProfileExpenses): ExpenseLine[] {
  return [
    line('living', e.livingMonthly, {
      label: 'living',
      ...(e.livingMonthlyRetired === undefined ? {} : { monthlyRetired: e.livingMonthlyRetired }),
    }),
    line('charitable', e.charitableMonthly, { label: 'giving' }),
    // Explicit, because a BLANK retired cell means "the same as now" while the
    // scalar's absence means 0 — the one place the two encodings disagree.
    line('investing', e.investingMonthly, {
      label: 'investing',
      monthlyRetired: e.investingMonthlyRetired ?? 0,
    }),
  ];
}

describe('a budget built out of the scalars costs exactly what the scalars did', () => {
  const cases: Array<[string, ProfileExpenses]> = [
    ['the household’s own, no retired figures', expenses()],
    ['a retired living figure', expenses({ livingMonthlyRetired: 5400 })],
    ['investing that continues in retirement', expenses({ investingMonthlyRetired: 900 })],
    ['both sides named', expenses({ livingMonthlyRetired: 5400, investingMonthlyRetired: 900 })],
    ['zeros throughout', { livingMonthly: 0, charitableMonthly: 0, investingMonthly: 0 }],
    [
      'awkward cents, where an order-dependent sum would show up',
      expenses({ livingMonthly: 7100.37, charitableMonthly: 2300.01, investingMonthly: 1250.99 }),
    ],
  ];

  for (const [name, scalars] of cases) {
    it(`round-trips: ${name}`, () => {
      const derived = deriveExpenseStreams({ ...scalars, lines: linesFromScalars(scalars) });
      expect(resolved(derived)).toEqual(resolved(scalars));
    });
  }

  it('round-trips a budget of many lines, not just one per stream', () => {
    // Splitting a stream across rows must not change its total: this is the
    // real transcription's shape, where living is thirty rows.
    const parts = [1200.55, 610, 318.19, 2400.26, 1499];
    const derived = deriveExpenseStreams(
      expenses({ lines: parts.map((p) => line('living', p)) }),
    );
    expect(derived.livingMonthly).toBe(parts.reduce((a, b) => a + b, 0));
  });

  const money = fc.double({ min: 0, max: 40_000, noNaN: true, noDefaultInfinity: true });
  const maybeMoney = fc.option(money, { nil: undefined });

  it('round-trips ANY scalar profile, generated (fast-check)', () => {
    fc.assert(
      fc.property(money, money, money, maybeMoney, maybeMoney, (l, c, i, lr, ir) => {
        const scalars: ProfileExpenses = {
          livingMonthly: l,
          charitableMonthly: c,
          investingMonthly: i,
          ...(lr === undefined ? {} : { livingMonthlyRetired: lr }),
          ...(ir === undefined ? {} : { investingMonthlyRetired: ir }),
        };
        const derived = deriveExpenseStreams({ ...scalars, lines: linesFromScalars(scalars) });
        expect(resolved(derived)).toEqual(resolved(scalars));
      }),
      { numRuns: 500, seed: 20260812 },
    );
  });

  it('is indifferent to display-only lines, whatever they say (fast-check)', () => {
    /*
     * The exclusion, stated as a property rather than three examples: take any
     * budget, add any number of 'insurance' / 'modeled_elsewhere' / 'excluded'
     * rows carrying any amounts in any column, and every derived stream — and
     * the survivor's figure, in both states — must be identical. This is the
     * $768 double-count as an invariant.
     */
    const summed = fc.constantFrom<ExpenseLineCategory>('living', 'charitable', 'investing');
    const display = fc.constantFrom<ExpenseLineCategory>(
      'insurance',
      'modeled_elsewhere',
      'excluded',
    );
    const lineOf = (cat: fc.Arbitrary<ExpenseLineCategory>): fc.Arbitrary<ExpenseLine> =>
      fc
        .tuple(cat, money, maybeMoney, maybeMoney)
        .map(([category, now, retired, survivor]) =>
          line(category, now, { monthlyRetired: retired, monthlySurvivor: survivor }),
        );

    fc.assert(
      fc.property(
        fc.array(lineOf(summed), { minLength: 1, maxLength: 12 }),
        fc.array(lineOf(display), { minLength: 1, maxLength: 12 }),
        (real, noise) => {
          const without = expenses({ lines: real });
          // Interleaved, not appended: a filter applied to only part of the
          // list would survive appending and die here.
          const with_ = expenses({ lines: real.flatMap((l, k) => [l, noise[k % noise.length]]) });
          expect(deriveExpenseStreams(with_)).toEqual(deriveExpenseStreams(without));
          expect(survivorLivingMonthly(with_, false)).toBe(survivorLivingMonthly(without, false));
          expect(survivorLivingMonthly(with_, true)).toBe(survivorLivingMonthly(without, true));
        },
      ),
      { numRuns: 300, seed: 20260812 },
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Migration: a real simulation, before and after
// ---------------------------------------------------------------------------

const historical = loadHistoricalCsv(
  readFileSync(
    new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url),
    'utf8',
  ),
);

function assumptions(): Assumptions {
  return {
    market: marketJson as unknown as MarketAssumptions,
    historical,
    federal: federalJson as unknown as FederalTaxData,
    states: {
      va: vaJson as unknown as StateTaxData,
      sc: scJson as unknown as StateTaxData,
      nc: ncJson as unknown as StateTaxData,
    },
    socialSecurity: ssJson as unknown as SocialSecurityData,
    medicare: medicareJson as unknown as MedicareData,
    aca: acaJson as unknown as AcaData,
    rmd: rmdJson as unknown as RmdTableData,
  };
}

/**
 * The user's household in miniature: a salary, a mid-year retirement (so the
 * worked-months blend of the living pair is actually exercised — that is where
 * an "equal" retired figure stops being equal), and enough portfolio to run the
 * full horizon.
 */
function household(e: ProfileExpenses): Profile {
  return {
    people: [
      {
        id: 'alex',
        name: 'Alex',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 3800,
        piaMonthlyAtFraIfStoppingNow: 3600,
        hasOwnBenefit: true,
      },
      {
        id: 'jordan',
        name: 'Jordan',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 0,
        piaMonthlyAtFraIfStoppingNow: 0,
        hasOwnBenefit: false,
      },
    ],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      {
        id: 'savings',
        name: 'savings',
        type: 'savings',
        owner: 'joint',
        balance: 150_000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
      {
        id: 'brokerage',
        name: 'brokerage',
        type: 'taxable_brokerage',
        owner: 'joint',
        balance: 900_000,
        costBasis: 600_000,
        allocation: { stocks: 0.7, bonds: 0.25, bills: 0.05 },
      },
      {
        id: 'ira',
        name: 'ira',
        type: 'traditional_ira',
        owner: 'alex',
        balance: 1_400_000,
        allocation: { stocks: 0.6, bonds: 0.35, bills: 0.05 },
      },
    ],
    home: {
      value: 850_000,
      costBasis: 500_000,
      state: 'va',
      propertyTaxAnnual: 6200,
      insuranceAnnual: 2900,
      maintenancePctOfValue: 0.01,
      sellingCostPct: 0.06,
      mortgage: null,
    },
    income: {
      salaries: { alex: 265_000, jordan: 0 },
      contribution401k: 23_500,
      employerMatch401k: 10_000,
    },
    expenses: e,
    health: {
      acaBenchmarkMonthly: 1450,
      acaQuoteYear: 2026,
      partDPlanMonthly: 45,
      employerPremiumShareMonthly: 320,
    },
    settings: {
      horizonAge: 95,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: 20260812,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

/** Mid-year retirement: 2027 is 6 worked months, which is the blended year. */
const plan: Scenario = {
  name: 'retire mid-2027',
  events: [
    { type: 'retire', person: 'alex', date: '2027-07' },
    { type: 'claim_social_security', person: 'alex', date: '2038-06' },
  ],
};

function run(profile: Profile, scenario: Scenario = plan): RunResult {
  return runSimulation({
    profile,
    assumptions: assumptions(),
    scenario,
    mode: 'deterministic',
    paths: 1,
    seed: 20260812,
  } as SimulationInput);
}

/** Everything arithmetic about a run. `meta` and `elapsedMs` are excluded. */
function digest(res: RunResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        success: res.success,
        horizonYears: res.horizonYears,
        fan: res.fan,
        medianTerminalReal: res.medianTerminalReal,
        worstDecileShortfallYears: res.worstDecileShortfallYears,
        breakGlassReal: res.breakGlassReal,
        charitableLegacy: res.charitableLegacy,
        referencePath: res.referencePath,
      }),
    )
    .digest('hex');
}

const UNCHANGED =
  'A PRE-BUDGET PROFILE MOVED. Deriving the streams from lines was supposed to ' +
  'leave every profile without lines bit-for-bit alone. Find out what changed ' +
  'before touching this test.';

describe('migration: a profile with no budget simulates exactly as it did', () => {
  const scalarsOnly = expenses();
  // Memoised rather than computed in the describe body: a full deterministic
  // run at collection time makes an unrelated engine failure look like a
  // failure of this file, and the pure-derivation suites above stop running
  // at all.
  let cached: string | undefined;
  const baseline = (): string => (cached ??= digest(run(household(scalarsOnly))));

  it('is unchanged by an empty `lines` array', () => {
    expect(digest(run(household({ ...scalarsOnly, lines: [] }))), UNCHANGED).toBe(baseline());
  });

  it('is unchanged when the same spending is expressed as lines', () => {
    // The strong form of the migration promise: transcribing the budget must
    // not move a single number, right down to the reference path's tax traces.
    // The mid-2027 retirement means the living pair's worked-months blend is on
    // the path, so an "equal" retired figure would show up here as a mismatch.
    const asLines = { ...scalarsOnly, lines: linesFromScalars(scalarsOnly) };
    expect(digest(run(household(asLines))), UNCHANGED).toBe(baseline());
  });

  it('is unchanged by display-only lines, however large', () => {
    /*
     * The double-count, end to end. Property tax and home insurance are ALSO
     * charged by the housing module from the home's own value; a budget that
     * lists them for reconciliation must not move the answer by a cent.
     */
    const withDisplayOnly = {
      ...scalarsOnly,
      lines: [
        ...linesFromScalars(scalarsOnly),
        line('modeled_elsewhere', 517, { label: 'property tax' }),
        line('modeled_elsewhere', 242, { label: 'home insurance' }),
        line('insurance', 300, { label: 'term life' }),
        line('excluded', 9000, { label: 'credit card payment' }),
      ],
    };
    expect(digest(run(household(withDisplayOnly))), UNCHANGED).toBe(baseline());
  });

  it('is unchanged when a scenario override sits on top of a budget-free profile', () => {
    // The override rebuild in simulate.ts is a field-by-field literal, and it
    // has already dropped a field once (the term-life policy, silently). An
    // override of one stream must still leave the others exactly as they were.
    const overridden: Scenario = {
      ...plan,
      assumption_overrides: { expenses: { charitableMonthly: 2300 } },
    };
    expect(digest(run(household(scalarsOnly), overridden)), UNCHANGED).toBe(baseline());
  });

  /*
   * THE FIELD-DROP TRAP, guarded rather than commented at.
   *
   * `profileWithOverrides` rebuilds ProfileExpenses field by field, so any
   * field the literal forgets is silently deleted for every scenario that
   * overrides anything. The comment above it says so; the comment has now
   * failed twice. First the death benefit and term end went missing and the
   * widow score came back identical with and without a million dollars of
   * cover. Then `lifeInsuranceTermStart` — added to AssumptionOverrides and to
   * household.ts, left out of both the rebuild and the has-override test, so a
   * what-if that named only a start date did nothing at all.
   *
   * Both were invisible because a dropped field looks exactly like an absent
   * one. These two tests make it visible: an override that sets a field to the
   * value the profile already holds is arithmetically a no-op, so the run must
   * be bit-identical to the run with no override — and it stops being so the
   * moment the rebuild loses anything the digest can see.
   */
  const noOp: Scenario = {
    ...plan,
    events: [...plan.events, { type: 'death', person: 'alex', date: '2034-07' }],
    // Exactly what the profile already says. Its only job is to make hasExpense
    // true, so the rebuild runs.
    assumption_overrides: { expenses: { charitableMonthly: 2300 } },
  };
  const noOverride: Scenario = { ...noOp, assumption_overrides: undefined };

  it('carries every legacy expense field through the override rebuild', () => {
    /*
     * Each of these has to CHANGE THE ANSWER, or the guard guards nothing —
     * a field whose fixture value equals its own default is dropped invisibly.
     * So the term starts in 2029, not 2026: dropped, the premium is charged
     * from the simulation's first month instead, which is the seventy-eight-
     * months-instead-of-sixty bug the field was added to fix. Likewise the
     * death is inside the term (the benefit is paid), and both retired figures
     * land on the far side of the 2027 retirement.
     */
    const everything = expenses({
      livingMonthlyRetired: 5400,
      investingMonthlyRetired: 300,
      lifeInsuranceMonthly: 300,
      lifeInsuranceDeathBenefit: 1_000_000,
      lifeInsuranceTermStart: '2029-01',
      lifeInsuranceTermEnd: '2036-06',
      lifeInsuranceInsured: 'alex',
      retirementGiving: { type: 'amount', monthly: 1500 },
    });
    expect(digest(run(household(everything), noOp)), UNCHANGED).toBe(
      digest(run(household(everything), noOverride)),
    );
  });

  it('acts on an override that names only a term start', () => {
    /*
     * The other half of the same trap, and the half a rebuild test cannot see:
     * `lifeInsuranceTermStart` was missing from the has-override TEST as well
     * as from the literal, so a scenario whose only expenses override was a
     * term start took the `return profile` early exit and was discarded whole.
     * Nothing failed — the run just answered the question that had not been
     * asked.
     *
     * Cover starting in 2029 instead of at the simulation's first month is 36
     * fewer months of premium, so ignoring it cannot be a silent no-op here.
     */
    const insured = expenses({
      lifeInsuranceMonthly: 300,
      lifeInsuranceDeathBenefit: 1_000_000,
      lifeInsuranceTermEnd: '2036-06',
      lifeInsuranceInsured: 'alex',
    });
    const laterStart: Scenario = {
      ...noOverride,
      assumption_overrides: { expenses: { lifeInsuranceTermStart: '2029-01' } },
    };
    expect(digest(run(household(insured), laterStart))).not.toBe(
      digest(run(household(insured), noOverride)),
    );
  });

  /*
   * The two list fields need a different shape of test. A budget forces the
   * rebuild whether or not a scenario overrides anything, so the no-op
   * comparison above would drop the field on BOTH sides and agree with itself.
   * These ask instead whether the field still DOES something with an override
   * in play — which is the question, and the one a dropped field answers no to.
   */
  const withOverride: Scenario = {
    ...noOp,
    assumption_overrides: { expenses: { livingMonthly: 7100 } },
  };

  it('keeps the budget’s survivor detail alive under an expenses override', () => {
    const budget = (survivorGroceries: number): ProfileExpenses =>
      expenses({
        lines: [
          ...linesFromScalars(scalarsOnly),
          line('living', 610, { label: 'the one car' }),
          line('living', 1200, { label: 'groceries', monthlySurvivor: survivorGroceries }),
        ],
      });
    // Two budgets that differ ONLY in what the widow spends on groceries must
    // still answer differently with an override on top. Drop `lines` in the
    // rebuild and both fall back to DEFAULT_SURVIVOR_LIVING_FRACTION, the two
    // digests collapse into one, and the whole per-line survivor feature is
    // dead for every plan the user actually runs — his carries an override.
    expect(digest(run(household(budget(700)), withOverride))).not.toBe(
      digest(run(household(budget(1150)), withOverride)),
    );
  });

  it('still pays the policies under an expenses override', () => {
    const budget = expenses({
      lines: linesFromScalars(scalarsOnly),
      lifeInsurancePolicies: [
        {
          id: 'banner',
          label: 'Northbridge Term',
          insured: 'alex',
          premiumMonthly: 170,
          deathBenefit: 3_000_000,
          termEnd: '2036-06',
        },
      ],
    });
    // Stated as the benefit itself rather than a digest: this is the failure
    // that already shipped once — a widow score identical with and without a
    // million dollars of cover, because the rebuild had quietly deleted it.
    const res = run(household(budget), withOverride);
    expect(res.referencePath.find((r) => r.year === 2034)?.survivor?.lifeInsuranceBenefit).toBe(
      3_000_000,
    );
  });

  it('DOES move when the budget says something different — the wiring is live', () => {
    /*
     * The guard on every assertion above. If prepareSim ignored the lines
     * outright, each of those tests would pass for the wrong reason and the
     * whole derivation would be dead code the UI merely displays.
     */
    const cheaper = {
      ...scalarsOnly,
      lines: [line('living', 4000), line('charitable', 2300), line('investing', 1250, {
        monthlyRetired: 0,
      })],
    };
    expect(digest(run(household(cheaper)))).not.toBe(baseline());
  });

  it('lets a scenario override outrank the budget, or the solvers flatten', () => {
    // The spend sweep works by writing `livingMonthly` into
    // assumption_overrides. If a budget beat it, every probe would simulate the
    // same spending and the max-spend curve would be a flat line.
    const budget = { ...scalarsOnly, lines: linesFromScalars(scalarsOnly) };
    const swept: Scenario = {
      ...plan,
      assumption_overrides: { expenses: { livingMonthly: 4000 } },
    };
    expect(digest(run(household(budget), swept))).toBe(
      digest(run(household({ ...scalarsOnly, livingMonthly: 4000 }), swept)),
    );
  });
});
