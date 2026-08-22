/**
 * The budget editor's pure half (src/ui/components/profile/expensesLogic.ts),
 * plus two invariants read straight out of the sources.
 *
 * Four things here are load-bearing, and each has already been a bug in this
 * codebase or is one line of code away from being one:
 *
 * 1. INHERITED IS NOT CHOSEN. A blank retired/survivor cell must stay absent in
 *    profile.json, and must still show the reader the number it inherits.
 *    Storing the inherited figure would make a default indistinguishable from a
 *    decision — and, for living spending, would walk a bit-identical profile
 *    through an arithmetic path it used to skip.
 * 2. A TAB'S TOTALS ARE ITS OWN CATEGORY'S AND NOTHING ELSE'S. Property tax
 *    inside the living baseline while the housing plan also charged it cost
 *    this plan $820/mo for thirty years. The tabless categories ('insurance',
 *    'modeled_elsewhere', 'excluded') no longer exist in the user's data, but
 *    one hand-edited into profile.json must stay out of every figure on
 *    screen; these tests are where the filters have to believe that.
 * 3. EACH TAB RENDERS ONLY THE CELLS THE ENGINE READS. A charitable line's
 *    after-work half is the Tithing RULE and no survivor giving or investing
 *    stream exists, so those cells would commit numbers nothing consumes —
 *    LINE_TAB_COLUMNS is the contract, and the dead-cell proofs below are why
 *    each `false` in it is false.
 * 4. THE TAB SPLITS LOST NOTHING. Expenses became Expenses/Tithing/Insurance,
 *    then the budget itself split into Expenses/Tithing/Investing, and a
 *    control that quietly failed to make either move would be a number the
 *    owner can no longer edit and would never notice was gone.
 *
 * Every expected figure is hand-computed in a comment, never pasted from a run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ExpenseLine,
  HousingPlan,
  LifeInsurancePolicy,
  ProfileExpenses,
  ScenarioEvent,
} from '../../src/shared/types';
import {
  deriveExpenseStreams,
  rentingLivingMonthly,
  survivorLivingMonthly,
} from '../../src/shared/expenses';
import { PROFILE_TAB_IDS } from '../../src/ui/nav';
import { DEFAULT_GUARDRAILS } from '../../src/shared/types';
import {
  SPENDING_TYPE_OPTIONS,
  guardrailsOk,
  normalizeSpendingPolicy,
  setGuardrail,
  spendingPolicySummary,
} from '../../src/ui/components/profile/profileLogic';
import {
  LINE_TAB_COLUMNS,
  applyDerivedStreams,
  categoryTotals,
  formatGap,
  formatMonth,
  makeExpenseLine,
  moveLineWithinCategory,
  policyTermNote,
  policyTotals,
  rentingInheritanceSplits,
  rentingMonthly,
  rentingWindowFromPlan,
  retiredMonthly,
  seedLinesFromStreams,
  seedPoliciesFromFields,
  survivorInheritanceSplits,
  survivorMonthly,
  uniqueExpenseLineId,
  uniquePolicyId,
  workStopsMonth,
} from '../../src/ui/components/profile/expensesLogic';

// ---------------------------------------------------------------------------
// Fixtures — one representative household's budget rows
// ---------------------------------------------------------------------------

function line(over: Partial<ExpenseLine> & Pick<ExpenseLine, 'id' | 'monthlyNow'>): ExpenseLine {
  return { label: over.id, category: 'living', ...over };
}

/**
 * A transcribed budget with one row of every kind that matters: a per-person
 * line that halves for a survivor, the ONE car that does not, giving, investing
 * that stops, and three rows the engine must never sum.
 */
function budget(): ExpenseLine[] {
  return [
    line({ id: 'groceries', monthlyNow: 800, monthlySurvivor: 500 }),
    line({ id: 'car', monthlyNow: 610 }),
    line({ id: 'giving', monthlyNow: 2300, category: 'charitable' }),
    line({ id: 'investing', monthlyNow: 1250, category: 'investing', monthlyRetired: 0 }),
    line({ id: 'premium', monthlyNow: 300, category: 'insurance' }),
    line({ id: 'property-tax', monthlyNow: 500, category: 'modeled_elsewhere' }),
    line({ id: 'card', monthlyNow: 1000, category: 'excluded' }),
  ];
}

function expenses(over: Partial<ProfileExpenses> = {}): ProfileExpenses {
  return { livingMonthly: 7100, charitableMonthly: 2300, investingMonthly: 1250, ...over };
}

// ---------------------------------------------------------------------------
// What a blank cell means
// ---------------------------------------------------------------------------

describe('a blank cell is inherited, and a typed one is a decision', () => {
  it('reads the after-work figure as the Now figure until something is typed', () => {
    expect(retiredMonthly(line({ id: 'car', monthlyNow: 610 }))).toBe(610);
    expect(retiredMonthly(line({ id: 'car', monthlyNow: 610, monthlyRetired: 400 }))).toBe(400);
  });

  it('treats a typed ZERO as a decision, not as an empty cell', () => {
    // "We stop investing" is an answer; it must not fall back to 1,250.
    const stops = line({ id: 'investing', monthlyNow: 1250, monthlyRetired: 0 });
    expect(retiredMonthly(stops)).toBe(0);
    expect(survivorMonthly(stops, 'retired')).toBe(0);
  });

  it('inherits the survivor figure from whichever state is in force', () => {
    // The one car: nothing typed anywhere, so it costs $610 in every state —
    // which is the fact no global survivor percentage can express.
    const car = line({ id: 'car', monthlyNow: 610 });
    expect(survivorMonthly(car, 'working')).toBe(610);
    expect(survivorMonthly(car, 'retired')).toBe(610);

    // A line that changes after work stops inherits THAT figure once retired.
    const utilities = line({ id: 'utilities', monthlyNow: 300, monthlyRetired: 250 });
    expect(survivorMonthly(utilities, 'working')).toBe(300);
    expect(survivorMonthly(utilities, 'retired')).toBe(250);

    // A typed survivor figure wins in both states.
    const groceries = line({ id: 'groceries', monthlyNow: 800, monthlySurvivor: 500 });
    expect(survivorMonthly(groceries, 'working')).toBe(500);
    expect(survivorMonthly(groceries, 'retired')).toBe(500);
  });

  it('flags the one case a single inherited number cannot state', () => {
    // Blank survivor + a retired figure that differs = two different inherited
    // numbers, so the cell has to say what a death while working would cost.
    expect(survivorInheritanceSplits(line({ id: 'u', monthlyNow: 300, monthlyRetired: 250 }))).toBe(
      true,
    );
    // Nothing typed at all: both states inherit 610, nothing to explain.
    expect(survivorInheritanceSplits(line({ id: 'car', monthlyNow: 610 }))).toBe(false);
    // A typed survivor figure is not inherited from anything.
    expect(
      survivorInheritanceSplits(
        line({ id: 'u', monthlyNow: 300, monthlyRetired: 250, monthlySurvivor: 250 }),
      ),
    ).toBe(false);
  });

  it('inherits the renting figure from whichever state is in force', () => {
    // Blank renting cell: an apartment month costs whatever that month would
    // have cost anyway — Now while salaried, the retired figure after.
    const utilities = line({ id: 'utilities', monthlyNow: 300, monthlyRetired: 250 });
    expect(rentingMonthly(utilities, 'working')).toBe(300);
    expect(rentingMonthly(utilities, 'retired')).toBe(250);
    // A typed figure governs both states — heating oil is zero in an
    // apartment whether or not anyone still works.
    const oil = line({ id: 'oil', monthlyNow: 200, monthlyRetired: 210, monthlyRenting: 0 });
    expect(rentingMonthly(oil, 'working')).toBe(0);
    expect(rentingMonthly(oil, 'retired')).toBe(0);
    // And a typed ZERO is a decision, exactly like the retired column's.
    expect(rentingMonthly(line({ id: 'sec', monthlyNow: 45, monthlyRenting: 0 }), 'working')).toBe(
      0,
    );
  });

  it('flags a renting cell whose two states inherit different numbers', () => {
    expect(rentingInheritanceSplits(line({ id: 'u', monthlyNow: 300, monthlyRetired: 250 }))).toBe(
      true,
    );
    expect(rentingInheritanceSplits(line({ id: 'car', monthlyNow: 610 }))).toBe(false);
    expect(
      rentingInheritanceSplits(
        line({ id: 'u', monthlyNow: 300, monthlyRetired: 250, monthlyRenting: 275 }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe('categoryTotals — one homogeneous tab at a time', () => {
  it("sums only the tab's own category", () => {
    // Living now: 800 + 610 = 1,410. Giving now: 2,300. Investing now: 1,250.
    // The three tabs together account for the counted 4,960 — and nothing else.
    expect(categoryTotals(budget(), 'living').now).toBe(1_410);
    expect(categoryTotals(budget(), 'charitable').now).toBe(2_300);
    expect(categoryTotals(budget(), 'investing').now).toBe(1_250);
  });

  it("keeps a hand-edited tabless line out of every tab's totals", () => {
    // budget() carries 300 (insurance) + 500 (modeled_elsewhere) + 1,000
    // (excluded) = 1,800/mo of lines no tab shows. If any of it leaked into a
    // tab's total, the tabs would sum past 4,960 — the double-count that cost
    // this plan $820/mo of housing for thirty years, wearing a new door.
    const tabs = (['living', 'charitable', 'investing'] as const).map(
      (category) => categoryTotals(budget(), category).now,
    );
    expect(tabs.reduce((a, b) => a + b, 0)).toBe(4_960);
  });

  it('reads blank cells through the same inheritance as the engine', () => {
    // Living retired: groceries and the car both inherit their Now figures, and
    // utilities names 250 — 800 + 610 + 250 = 1,660.
    const lines = [...budget(), line({ id: 'utilities', monthlyNow: 300, monthlyRetired: 250 })];
    expect(categoryTotals(lines, 'living').retired).toBe(1_660);
    // Survivor after retiring: groceries' typed 500, the car's inherited 610,
    // utilities' inherited retired 250 = 1,360. While working, utilities
    // inherits its 300 instead: 1,410.
    expect(categoryTotals(lines, 'living').survivorAfterRetiring).toBe(1_360);
    expect(categoryTotals(lines, 'living').survivorWhileWorking).toBe(1_410);
  });

  it('reads a blank investing retired cell as "same as now", and a 0 as stopped', () => {
    // Line semantics, not scalar semantics: on a ROW absence inherits. The
    // imported budget types the 0 out loud (the brokerage-transfer line), and the total
    // must keep the two cases apart.
    const lines = [
      line({ id: 'brokerage-transfer', monthlyNow: 1_250, category: 'investing', monthlyRetired: 0 }),
      line({ id: 'espp', monthlyNow: 400, category: 'investing' }),
    ];
    expect(categoryTotals(lines, 'investing').now).toBe(1_650);
    expect(categoryTotals(lines, 'investing').retired).toBe(400); // 0 + inherited 400
  });

  it('reads the renting total through the same inheritance as the engine', () => {
    // Groceries and the car inherit their working figures (an apartment does
    // not change either), oil's typed 0 governs: 800 + 610 + 0 = 1,410.
    const lines = [
      ...budget(),
      line({ id: 'oil', monthlyNow: 200, monthlyRetired: 210, monthlyRenting: 0 }),
    ];
    expect(categoryTotals(lines, 'living').renting).toBe(1_410);
    // And it is the WORKING-state renting stream the engine derives — the
    // total on screen must be a figure the run actually prices.
    const e = expenses({ lines });
    expect(categoryTotals(lines, 'living').renting).toBe(rentingLivingMonthly(e)!.working);
  });

  it('agrees with the engine derivation to the last bit', () => {
    // The totals row IS the stream the run will spend, or it is a lie: both
    // sides sum the same lines in the same array order, so the equality is
    // exact, not approximate.
    const e = expenses({ lines: budget() });
    const streams = deriveExpenseStreams(e);
    expect(categoryTotals(budget(), 'living').now).toBe(streams.livingMonthly);
    expect(categoryTotals(budget(), 'charitable').now).toBe(streams.charitableMonthly);
    expect(categoryTotals(budget(), 'investing').now).toBe(streams.investingMonthly);
    expect(categoryTotals(budget(), 'investing').retired).toBe(streams.investingMonthlyRetired);
    expect(categoryTotals(budget(), 'living').survivorAfterRetiring).toBe(
      survivorLivingMonthly(e, true),
    );
    expect(categoryTotals(budget(), 'living').survivorWhileWorking).toBe(
      survivorLivingMonthly(e, false),
    );
  });

  it('totals an empty budget at zero rather than throwing', () => {
    expect(categoryTotals([], 'living')).toEqual({
      now: 0,
      renting: 0,
      retired: 0,
      survivorWhileWorking: 0,
      survivorAfterRetiring: 0,
    });
  });
});

describe('the tab column contract (LINE_TAB_COLUMNS)', () => {
  it('renders a cell only where the engine reads the field', () => {
    // Hand-listed on both sides deliberately: adding a column is a statement
    // about what the engine consumes, and has to be made here on purpose.
    expect(LINE_TAB_COLUMNS).toEqual({
      living: { renting: true, retired: true, survivor: true },
      charitable: { renting: false, retired: false, survivor: false },
      investing: { renting: false, retired: true, survivor: false },
    });
  });

  it('proves the charitable after-work and survivor cells would be dead', () => {
    // The Tithing rule owns giving after the last paycheck, so figures typed
    // into these fields change NOTHING the engine derives — which is exactly
    // why the tab offers no cell to type them into.
    const bare = expenses({
      lines: [line({ id: 'give', monthlyNow: 2_300, category: 'charitable' })],
    });
    const decorated = expenses({
      lines: [
        line({
          id: 'give',
          monthlyNow: 2_300,
          category: 'charitable',
          monthlyRetired: 1,
          monthlySurvivor: 2,
        }),
      ],
    });
    expect(deriveExpenseStreams(decorated)).toEqual(deriveExpenseStreams(bare));
    expect(survivorLivingMonthly(decorated, true)).toBe(survivorLivingMonthly(bare, true));
  });

  it('proves an investing survivor cell would be dead too', () => {
    // No survivor investing stream exists: the streams derive from
    // survivor-false states, and survivorLivingMonthly sums living lines only.
    const bare = expenses({
      lines: [line({ id: 'brokerage-transfer', monthlyNow: 1_250, category: 'investing', monthlyRetired: 0 })],
    });
    const decorated = expenses({
      lines: [
        line({
          id: 'brokerage-transfer',
          monthlyNow: 1_250,
          category: 'investing',
          monthlyRetired: 0,
          monthlySurvivor: 999,
        }),
      ],
    });
    expect(deriveExpenseStreams(decorated)).toEqual(deriveExpenseStreams(bare));
    expect(survivorLivingMonthly(decorated, true)).toBe(survivorLivingMonthly(bare, true));
  });

  it('proves a renting cell on a giving or investing line would be dead', () => {
    // The renting column is LIVING ONLY: giving and investing do not change by
    // dwelling (the engine's between-homes rule for investing is a DESTINATION
    // decision, not a per-line amount), so rentingLivingMonthly must not even
    // notice a monthlyRenting hand-edited onto those categories.
    const bare = expenses({
      lines: [
        line({ id: 'give', monthlyNow: 2_300, category: 'charitable' }),
        line({ id: 'brokerage-transfer', monthlyNow: 1_250, category: 'investing', monthlyRetired: 0 }),
      ],
    });
    const decorated = expenses({
      lines: [
        line({ id: 'give', monthlyNow: 2_300, category: 'charitable', monthlyRenting: 1 }),
        line({
          id: 'brokerage-transfer',
          monthlyNow: 1_250,
          category: 'investing',
          monthlyRetired: 0,
          monthlyRenting: 2,
        }),
      ],
    });
    // No LIVING line names the column, so there is no renting stream AT ALL —
    // null, not a total quietly assembled from dead cells.
    expect(rentingLivingMonthly(decorated)).toBeNull();
    expect(rentingLivingMonthly(bare)).toBeNull();
    expect(deriveExpenseStreams(decorated)).toEqual(deriveExpenseStreams(bare));
  });

  it('proves the renting column never reaches the derived streams themselves', () => {
    // deriveExpenseStreams prices the working and retired states; the renting
    // state is a separate stream the engine blends per window month. A living
    // line's renting figure must therefore move rentingLivingMonthly and
    // NOTHING else.
    const bare = expenses({
      lines: [line({ id: 'oil', monthlyNow: 200, monthlyRetired: 210 })],
    });
    const decorated = expenses({
      lines: [line({ id: 'oil', monthlyNow: 200, monthlyRetired: 210, monthlyRenting: 0 })],
    });
    expect(deriveExpenseStreams(decorated)).toEqual(deriveExpenseStreams(bare));
    expect(survivorLivingMonthly(decorated, true)).toBe(survivorLivingMonthly(bare, true));
    expect(rentingLivingMonthly(bare)).toBeNull();
    // Both states, because a blank renting cell inherits the in-force figure:
    // the typed 0 governs the line in both, and any OTHER line would fall back
    // to its own working/retired number.
    expect(rentingLivingMonthly(decorated)).toEqual({ working: 0, retired: 0 });
  });
});

// ---------------------------------------------------------------------------
// The window the renting column prices
// ---------------------------------------------------------------------------

describe('rentingWindowFromPlan — the tooltip’s dates come from the plan', () => {
  const plan = (over: Partial<HousingPlan> = {}): HousingPlan => ({
    sellDate: '2027-06',
    rentMonths: 12,
    rentMonthly: 3000,
    purchasePrice: 1_350_000,
    propertyTaxAnnual: 7500,
    financing: { type: 'cash' },
    ...over,
  });

  it('reads a housing plan: sale month to the derived purchase month', () => {
    // A representative window: sold June 2027, 12 months renting, bought June
    // 2028 — the purchase date is DERIVED, exactly as the engine derives it.
    expect(rentingWindowFromPlan(plan(), [])).toEqual({
      from: '2027-06',
      to: '2028-06',
      months: 12,
    });
  });

  it('reports no window when nothing is pending between homes', () => {
    // Rent to the horizon: nothing is "soon", so nothing prices the column.
    expect(rentingWindowFromPlan(plan({ purchasePrice: 'none' }), [])).toBeNull();
    // A 0 price is the same statement (the compiler's own equivalence rule).
    expect(rentingWindowFromPlan(plan({ purchasePrice: 0 }), [])).toBeNull();
    // Same-month sale and buy: no months between homes at all.
    expect(rentingWindowFromPlan(plan({ rentMonths: 0 }), [])).toBeNull();
    // No move anywhere: no plan, no events.
    expect(rentingWindowFromPlan(undefined, [])).toBeNull();
  });

  it('falls back to hand-written events the way the engine reads them', () => {
    // The user's plan.json still writes the three events by hand; the window
    // is the sale to the FIRST later purchase.
    const events: ScenarioEvent[] = [
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 3000 },
      {
        type: 'buy_house',
        date: '2028-06',
        price: 'sale_proceeds',
        financing: 'cash',
        propertyTaxAnnual: 7500,
        insuranceAnnual: 1850,
      },
    ];
    expect(rentingWindowFromPlan(undefined, events)).toEqual({
      from: '2027-06',
      to: '2028-06',
      months: 12,
    });
    // A buy with no sale (or a sale with no buy) implies no between-homes gap.
    expect(rentingWindowFromPlan(undefined, events.slice(0, 2))).toBeNull();
    expect(rentingWindowFromPlan(undefined, [events[2]])).toBeNull();
  });

  it('lets a present housing plan supersede the events, like the engine does', () => {
    const events: ScenarioEvent[] = [{ type: 'sell_house', date: '2030-01' }];
    expect(rentingWindowFromPlan(plan(), events)).toEqual({
      from: '2027-06',
      to: '2028-06',
      months: 12,
    });
  });
});

// ---------------------------------------------------------------------------
// The scalar cache
// ---------------------------------------------------------------------------

describe('applyDerivedStreams', () => {
  it('rewrites the three streams from the rows', () => {
    // living 800 + 610 = 1,410; giving 2,300; investing 1,250.
    const e = expenses({ lines: budget() });
    applyDerivedStreams(e);
    expect(e.livingMonthly).toBe(1_410);
    expect(e.charitableMonthly).toBe(2_300);
    expect(e.investingMonthly).toBe(1_250);
  });

  it('leaves the retired living stream ABSENT when every row inherits', () => {
    // Not tidiness: absent skips the engine's working/retired blend outright,
    // and a present-but-equal figure walks through x*(5/12) + x*(7/12), which
    // is not x in floating point.
    const e = expenses({ lines: budget(), livingMonthlyRetired: 9_999 });
    applyDerivedStreams(e);
    expect('livingMonthlyRetired' in e).toBe(false);

    // One row naming a retired figure is what brings the stream back: 400 + 610.
    const withRetired = expenses({
      lines: [
        line({ id: 'groceries', monthlyNow: 800, monthlyRetired: 400 }),
        line({ id: 'car', monthlyNow: 610 }),
      ],
    });
    applyDerivedStreams(withRetired);
    expect(withRetired.livingMonthlyRetired).toBe(1_010);
  });

  it('writes investing’s after-work figure even when it is zero', () => {
    // A row's blank means "same as now" while the scalar's absence means 0, so
    // the two representations genuinely disagree — where there is a budget, the
    // budget wins, and the 0 the user typed is stored where he can see it.
    const e = expenses({ lines: budget() });
    applyDerivedStreams(e);
    expect(e.investingMonthlyRetired).toBe(0);
  });

  it('does not touch a profile that has no rows', () => {
    // Every profile written before the table existed must come back BYTE for
    // byte: the scalars are the truth there, and nothing may rewrite them.
    const before = expenses({ livingMonthlyRetired: 5_000 });
    const after = expenses({ livingMonthlyRetired: 5_000 });
    applyDerivedStreams(after);
    expect(after).toEqual(before);
    // An empty array means the same thing as no array at all.
    const emptied = expenses({ lines: [] });
    applyDerivedStreams(emptied);
    expect(emptied.livingMonthly).toBe(7_100);
  });
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe('seedLinesFromStreams', () => {
  it('itemises the three streams without changing what the plan spends', () => {
    const e = expenses({ livingMonthlyRetired: 5_000, lifeInsuranceMonthly: 300 });
    const seeded = seedLinesFromStreams(e);
    const derived = deriveExpenseStreams({ ...e, lines: seeded });
    expect(derived.livingMonthly).toBe(7_100);
    expect(derived.livingMonthlyRetired).toBe(5_000);
    expect(derived.charitableMonthly).toBe(2_300);
    expect(derived.investingMonthly).toBe(1_250);
  });

  it('seeds NO insurance row, even for a household paying a premium', () => {
    // The 'insurance' category has no tab, so a seeded row would be a line in
    // profile.json no screen shows and no control can delete — and the premium
    // is already charged, visibly, from the Insurance tab.
    const seeded = seedLinesFromStreams(expenses({ lifeInsuranceMonthly: 300 }));
    expect(seeded.map((l) => l.category)).toEqual(['living', 'charitable', 'investing']);
  });

  it('writes investing’s zero explicitly, because a row inherits where a scalar stops', () => {
    // Absent `investingMonthlyRetired` means 0. As a blank ROW cell it would
    // mean "same as now" and carry $1,250/mo of saving thirty years into
    // retirement, so the seed states the 0.
    const seeded = seedLinesFromStreams(expenses());
    const investing = seeded.find((l) => l.category === 'investing');
    expect(investing?.monthlyRetired).toBe(0);
    expect(deriveExpenseStreams({ ...expenses(), lines: seeded }).investingMonthlyRetired).toBe(0);
  });

  it('leaves living’s retired cell absent when the profile never named one', () => {
    const seeded = seedLinesFromStreams(expenses());
    expect('monthlyRetired' in (seeded.find((l) => l.category === 'living') as ExpenseLine)).toBe(
      false,
    );
    expect(deriveExpenseStreams({ ...expenses(), lines: seeded }).livingMonthlyRetired).toBe(
      undefined,
    );
  });

  it('gives the charitable row no retired figure — the Tithing rule owns it', () => {
    const giving = seedLinesFromStreams(expenses()).find((l) => l.category === 'charitable');
    expect('monthlyRetired' in (giving as ExpenseLine)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Row identity
// ---------------------------------------------------------------------------

describe('row ids', () => {
  it('never reuses an id that is taken', () => {
    expect(uniqueExpenseLineId([])).toBe('line-1');
    expect(uniqueExpenseLineId([line({ id: 'line-1', monthlyNow: 0 })])).toBe('line-2');
    // The seeded rows carry names, not line-N, so they never collide.
    expect(uniqueExpenseLineId(seedLinesFromStreams(expenses()))).toBe('line-1');
  });

  it('survives a reorder, so an edited row is never re-keyed', () => {
    const rows = budget();
    const moved = moveLineWithinCategory(rows, 'groceries', 1);
    expect(moved.map((l) => l.id)).toEqual([
      'car',
      'groceries',
      'giving',
      'investing',
      'premium',
      'property-tax',
      'card',
    ]);
    // Same objects, same ids — a reorder moves rows, it does not rewrite them.
    expect(moved[1]).toBe(rows[0]);
  });

  it('starts a new row at zero, stamped with the CALLING tab’s category', () => {
    // No category selector exists any more: the stamp is the only way a row
    // gets a category, so a tab passing the wrong one would file every new
    // row where its own filter can never show it again.
    expect(makeExpenseLine(budget(), 'living')).toEqual({
      id: 'line-1',
      label: 'New line',
      category: 'living',
      monthlyNow: 0,
    });
    expect(makeExpenseLine([], 'charitable').category).toBe('charitable');
    expect(makeExpenseLine([], 'investing').category).toBe('investing');
  });
});

describe('moveLineWithinCategory', () => {
  /**
   * Interleaved on purpose: each tab shows a filtered view, so "up" must mean
   * "past the previous line of MY category", never "past whatever happens to
   * sit above me in the file".
   */
  const interleaved = (): ExpenseLine[] => [
    line({ id: 'a', monthlyNow: 1 }),
    line({ id: 'g1', monthlyNow: 2, category: 'charitable' }),
    line({ id: 'b', monthlyNow: 3 }),
    line({ id: 'g2', monthlyNow: 4, category: 'charitable' }),
  ];

  it('swaps with the neighbour of the same category, across other categories', () => {
    // 'b' up jumps over 'g1' to trade slots with 'a'; 'g1' itself never moves.
    expect(moveLineWithinCategory(interleaved(), 'b', -1).map((l) => l.id)).toEqual([
      'b',
      'g1',
      'a',
      'g2',
    ]);
    expect(moveLineWithinCategory(interleaved(), 'g2', -1).map((l) => l.id)).toEqual([
      'a',
      'g2',
      'b',
      'g1',
    ]);
  });

  it('leaves lines whose category has no tab exactly where they were', () => {
    // A hand-edited 'excluded' line sits between two living lines; moving one
    // living line past the other must not disturb its slot (or crash on it).
    const rows = [
      line({ id: 'a', monthlyNow: 1 }),
      line({ id: 'x', monthlyNow: 2, category: 'excluded' }),
      line({ id: 'b', monthlyNow: 3 }),
    ];
    expect(moveLineWithinCategory(rows, 'a', 1).map((l) => l.id)).toEqual(['b', 'x', 'a']);
  });

  it('is a no-op at the edges of the tab, and for an unknown id', () => {
    expect(moveLineWithinCategory(interleaved(), 'a', -1).map((l) => l.id)).toEqual([
      'a',
      'g1',
      'b',
      'g2',
    ]);
    expect(moveLineWithinCategory(interleaved(), 'g2', 1).map((l) => l.id)).toEqual([
      'a',
      'g1',
      'b',
      'g2',
    ]);
    expect(moveLineWithinCategory(interleaved(), 'ghost', 1).map((l) => l.id)).toEqual([
      'a',
      'g1',
      'b',
      'g2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function policy(over: Partial<LifeInsurancePolicy> = {}): LifeInsurancePolicy {
  return {
    id: 'policy-1',
    label: 'Term life',
    insured: 'p1',
    premiumMonthly: 158,
    deathBenefit: 1_500_000,
    ...over,
  };
}

describe('policy list', () => {
  it('totals the premiums and the cover', () => {
    // 158 + 142 = 300/mo; 1,500,000 + 1,000,000 = 2,500,000 of cover.
    const totals = policyTotals([
      policy(),
      policy({ id: 'policy-2', premiumMonthly: 142, deathBenefit: 1_000_000 }),
    ]);
    expect(totals).toEqual({ premiumMonthly: 300, deathBenefit: 2_500_000 });
    expect(policyTotals([])).toEqual({ premiumMonthly: 0, deathBenefit: 0 });
  });

  it('never reuses a policy id', () => {
    expect(uniquePolicyId([])).toBe('policy-1');
    expect(uniquePolicyId([policy()])).toBe('policy-2');
  });

  it('carries the single-policy fields into the list without changing cover', () => {
    const [converted] = seedPoliciesFromFields(
      expenses({
        lifeInsuranceMonthly: 300,
        lifeInsuranceDeathBenefit: 3_000_000,
        lifeInsuranceInsured: 'p1',
      }),
      'p2',
    );
    expect(converted.premiumMonthly).toBe(300);
    expect(converted.deathBenefit).toBe(3_000_000);
    expect(converted.insured).toBe('p1');
    // No term end MEANT "cover ends with the paycheck"; dropping that would
    // silently extend three million dollars of cover to the horizon.
    expect(converted.cancelAtRetirement).toBe(true);
    expect('termEnd' in converted).toBe(false);
  });

  it('keeps a term end as a term end, with no cancel-at-retirement invented', () => {
    const [converted] = seedPoliciesFromFields(
      expenses({ lifeInsuranceMonthly: 170, lifeInsuranceTermEnd: '2038-06' }),
      'p1',
    );
    expect(converted.termEnd).toBe('2038-06');
    expect('cancelAtRetirement' in converted).toBe(false);
    // An unnamed insured falls back to the earner the caller names.
    expect(converted.insured).toBe('p1');
  });

  it('does not cancel a policy the old fields dated only at its START', () => {
    // The engine reads the single-policy fields as cancel-at-retirement only
    // when NEITHER date is named (resolvePolicies: termStart === null &&
    // termEnd === null). A start with no end is "five years of term bought at
    // retirement" — a policy standing on its own dates and running to the
    // horizon — so ticking the flag on the way into the list would throw the
    // whole term away, cover and premium both, with nothing on screen changing.
    const [converted] = seedPoliciesFromFields(
      expenses({
        lifeInsuranceMonthly: 170,
        lifeInsuranceDeathBenefit: 3_000_000,
        lifeInsuranceTermStart: '2028-01',
      }),
      'p1',
    );
    expect(converted.termStart).toBe('2028-01');
    expect('cancelAtRetirement' in converted).toBe(false);
  });
});

describe('workStopsMonth', () => {
  const people = [{ id: 'p1' }, { id: 'p2' }];

  it('ignores a person who draws no salary', () => {
    // Jordan has no salary and no retire event; that must not read as "this
    // household works forever", which taking the latest date over everybody
    // would do.
    expect(workStopsMonth(people, { p1: 300_000, p2: 0 }, { p1: '2033-06', p2: null })).toBe(
      '2033-06',
    );
  });

  it('takes the LAST earner to stop', () => {
    expect(
      workStopsMonth(people, { p1: 300_000, p2: 40_000 }, { p1: '2033-06', p2: '2035-01' }),
    ).toBe('2035-01');
  });

  it('says nothing when an earner never stops, or when nobody earns', () => {
    expect(workStopsMonth(people, { p1: 300_000, p2: 40_000 }, { p1: '2033-06', p2: null })).toBe(
      null,
    );
    expect(workStopsMonth(people, { p1: 0, p2: 0 }, { p1: '2033-06', p2: '2033-06' })).toBe(null);
  });
});

describe('policyTermNote', () => {
  it('measures the term end against the month the paychecks stop', () => {
    // June 2033 to June 2038 = 60 months = 5 yr.
    const after = policyTermNote(policy({ termEnd: '2038-06' }), '2033-06');
    expect(after.text).toBe('Ends June 2038 — 5 yr after work stops.');
    expect(after.tone).toBe('muted');
  });

  it('shouts when the cover lapses BEFORE the last paycheck', () => {
    // Term life is income replacement, so a policy that ends while a salary is
    // still being earned is missing in exactly the years it was bought for.
    // Work stops June 2033, so MAY 2033 holds the last paycheck; a term ending
    // October 2032 leaves November 2032..May 2033 uncovered = 7 months.
    const before = policyTermNote(policy({ termEnd: '2032-10' }), '2033-06');
    expect(before.tone).toBe('warn');
    expect(before.text).toContain('7 months BEFORE the last paycheck');
  });

  it('does not invent a gap for a term that runs to the last paycheck', () => {
    // A retire event's month is the month the salary STOPS (retiring 2033-06
    // means months 1..5 are worked), so a term ending May 2033 covers every
    // earning month there is. Measuring against June instead warned that a
    // death in a one-month gap paid nothing, about the most natural way there
    // is to write "my term runs to my last day at work".
    const aligned = policyTermNote(policy({ termEnd: '2033-05' }), '2033-06');
    expect(aligned.tone).toBe('muted');
    expect(aligned.text).toBe('Ends May 2033, the last month a salary is drawn.');
  });

  it('names the month when the two land together', () => {
    expect(policyTermNote(policy({ termEnd: '2033-06' }), '2033-06').text).toBe(
      'Ends June 2033, the month work stops.',
    );
  });

  it('says how much cover a cancel-at-retirement throws away', () => {
    // The last paycheck is May 2033, so cancelling throws away June 2033
    // through June 2037 INCLUSIVE = 49 months. Counting the distance to the
    // retire month instead reported 48 and lost the boundary month entirely.
    const cancelled = policyTermNote(
      policy({ termEnd: '2037-06', cancelAtRetirement: true }),
      '2033-06',
    );
    expect(cancelled.tone).toBe('warn');
    expect(cancelled.text).toContain('4 yr 1 mo of cover the term still had');
  });

  it('counts the boundary month a cancel throws away rather than calling it none', () => {
    // Term to June 2033, work stops June 2033: the cancel cuts the cover after
    // May's paycheck, so it drops exactly the one month the term still had.
    const one = policyTermNote(policy({ termEnd: '2033-06', cancelAtRetirement: true }), '2033-06');
    expect(one.tone).toBe('warn');
    expect(one.text).toContain('dropping 1 month of cover');
    // Term to May 2033 — the last paid month — and the cancel throws away
    // nothing, because there was nothing left to throw.
    const none = policyTermNote(policy({ termEnd: '2033-05', cancelAtRetirement: true }), '2033-06');
    expect(none.tone).toBe('muted');
    expect(none.text).toContain('after the term ends May 2033');
  });

  it('states the term start, and the horizon when there is no end at all', () => {
    const note = policyTermNote(policy({ termStart: '2027-01' }), '2033-06');
    expect(note.text).toBe(
      'Starts January 2027. No end date: the cover and the premium both run to the horizon.',
    );
  });

  it('admits it when the plan has no retirement date to measure against', () => {
    expect(policyTermNote(policy({ termEnd: '2038-06' }), null).text).toContain(
      'no retirement date yet',
    );
    expect(policyTermNote(policy({ cancelAtRetirement: true }), null).text).toContain(
      'no retirement date yet',
    );
  });
});

describe('formatMonth / formatGap', () => {
  it('reads a YYYY-MM as a month, and a half-typed one as itself', () => {
    expect(formatMonth('2038-06')).toBe('June 2038');
    expect(formatMonth('2038-')).toBe('2038-');
    expect(formatMonth('2038-13')).toBe('2038-13');
  });

  it('states a gap the way a reader weighs one', () => {
    expect(formatGap(1)).toBe('1 month');
    expect(formatGap(8)).toBe('8 months');
    expect(formatGap(-8)).toBe('8 months'); // direction is the caller's word
    expect(formatGap(60)).toBe('5 yr');
    expect(formatGap(51)).toBe('4 yr 3 mo');
  });
});

// ---------------------------------------------------------------------------
// Spending policy (Settings tab)
// ---------------------------------------------------------------------------

describe('the guardrails spending policy', () => {
  it('is offered beside the two policies that were already there', () => {
    expect(SPENDING_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      'fixed_real',
      'fixed_percent',
      'guardrails',
    ]);
  });

  it('arrives with Guyton-Klinger’s own band rather than no rails at all', () => {
    // A guardrails policy with no band is a rule the engine would have to
    // invent numbers for, and invented numbers that move spending are exactly
    // what this app refuses to hide.
    expect(normalizeSpendingPolicy({ type: 'fixed_real' }, 'guardrails')).toEqual({
      type: 'guardrails',
      guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1, floorFraction: 0.7 },
    });
    expect(DEFAULT_GUARDRAILS.upper).toBe(1.2);
  });

  it('keeps a band the user has edited, and drops it on the way out', () => {
    const edited = {
      type: 'guardrails' as const,
      guardrails: { upper: 1.3, lower: 0.75, adjustment: 0.05 },
    };
    expect(normalizeSpendingPolicy(edited, 'guardrails')).toEqual(edited);
    const real = normalizeSpendingPolicy(edited, 'fixed_real');
    expect(real).toEqual({ type: 'fixed_real' });
    expect('guardrails' in real).toBe(false);
  });

  it('clamps a rail into the schema’s range instead of failing the save', () => {
    // The bounds are upper 1..3, lower 0.2..1, adjustment 0.01..0.5, floor
    // 0.1..1. A typo three tabs away from the Save button is a miserable way to
    // learn the profile is invalid.
    const policy = normalizeSpendingPolicy({ type: 'fixed_real' }, 'guardrails');
    setGuardrail(policy, 'upper', 12);
    setGuardrail(policy, 'lower', 0.05);
    setGuardrail(policy, 'adjustment', 0.9);
    expect(policy.guardrails).toEqual({
      upper: 3,
      lower: 0.2,
      adjustment: 0.5,
      floorFraction: 0.7,
    });
  });

  it('reads an empty floor box as NO floor, and never as a zero', () => {
    // The published rule has no floor; ours is optional and absent says so.
    const policy = normalizeSpendingPolicy({ type: 'fixed_real' }, 'guardrails');
    setGuardrail(policy, 'floorFraction', undefined);
    expect('floorFraction' in (policy.guardrails ?? {})).toBe(false);
    setGuardrail(policy, 'floorFraction', 0.6);
    expect(policy.guardrails?.floorFraction).toBe(0.6);
  });

  it('holds a rail rather than blanking half a band', () => {
    const policy = normalizeSpendingPolicy({ type: 'fixed_real' }, 'guardrails');
    setGuardrail(policy, 'upper', undefined);
    expect(policy.guardrails?.upper).toBe(1.2);
  });

  it('spots an inverted band, which breaches both rails every year', () => {
    expect(guardrailsOk({ upper: 1.2, lower: 0.8, adjustment: 0.1 })).toBe(true);
    expect(guardrailsOk({ upper: 0.8, lower: 1.2, adjustment: 0.1 })).toBe(false);
    expect(guardrailsOk({ upper: 1, lower: 1, adjustment: 0.1 })).toBe(false);
    expect(guardrailsOk(undefined)).toBe(true);
  });

  it('summarizes the band as multiples of the starting rate', () => {
    // formatPct(0.1, 0) = "10%". Quoting the rails as percentages would read as
    // a spending rate, which is not what 1.2 and 0.8 are.
    expect(
      spendingPolicySummary({
        type: 'guardrails',
        guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1 },
      }),
    ).toBe('Guardrails: 0.8–1.2× the starting rate, 10% steps');
    // A policy saved without a band still summarizes as the defaults it runs on.
    expect(spendingPolicySummary({ type: 'guardrails' })).toContain('0.8–1.2×');
  });
});

// ---------------------------------------------------------------------------
// Read out of the sources: the split, and the look of an inherited cell
// ---------------------------------------------------------------------------

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const profilePage = read('../../src/ui/pages/ProfilePage.tsx');
const budgetCard = read('../../src/ui/components/profile/BudgetCard.tsx');
const insuranceCard = read('../../src/ui/components/profile/InsuranceCard.tsx');
const css = read('../../src/ui/styles.css');

/**
 * The three surfaces that QUOTE the household's spending baseline rather than
 * edit it. BudgetCard is deliberately absent: its StreamsCard half is the
 * no-rows editor, where the scalars are the truth and must be read directly.
 */
const QUOTING_SOURCES: ReadonlyArray<{ name: string; src: string }> = [
  { name: 'DashboardPage.tsx', src: read('../../src/ui/pages/DashboardPage.tsx') },
  {
    name: 'SpendingCard.tsx',
    src: read('../../src/ui/components/workbench/SpendingCard.tsx'),
  },
  {
    name: 'LiveResults.tsx',
    src: read('../../src/ui/components/workbench/LiveResults.tsx'),
  },
];

/** The five fields deriveExpenseStreams owns — the ones the rows recompute. */
const DERIVED_STREAM_FIELDS =
  'livingMonthly|livingMonthlyRetired|charitableMonthly|investingMonthly|investingMonthlyRetired';

describe('the Expenses / Tithing / Investing / Insurance split', () => {
  it('offers all the tabs and keeps the id a stored preference may hold', () => {
    // The ids live in nav.ts now, because they are also URL segments
    // (/profile/tithing, /profile/investing). 'expenses' has to keep its id
    // there: localStorage may hold it from before the split — and by now a
    // link may too — and an unrecognised value would drop the reader on
    // Household.
    expect([...PROFILE_TAB_IDS]).toEqual([
      'household',
      'accounts',
      'home',
      'income',
      'expenses',
      'tithing',
      'investing',
      'insurance',
      'health',
      'settings',
    ]);
    // The strip maps over those ids and takes its words from this record, so
    // every tab is named here or it is a nameless button on screen.
    const start = profilePage.indexOf('const PROFILE_TAB_LABELS');
    const block = profilePage.slice(start, profilePage.indexOf('};', start));
    const labels = Object.fromEntries(
      [...block.matchAll(/^ {2}([a-z]+): '([^']+)',$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(labels)).toEqual([...PROFILE_TAB_IDS]);
    expect(labels.tithing).toBe('Tithing');
    expect(labels.investing).toBe('Investing');
    expect(labels.insurance).toBe('Insurance');
  });

  it('still reaches every control the one Expenses tab used to carry', () => {
    // The budget's five money fields moved to the Expenses tab's empty state,
    // where a profile with no itemised rows still edits its three streams.
    for (const label of [
      'Living expenses ($/mo)',
      'Living after you stop working ($/mo)',
      'Charitable giving ($/mo)',
      'Investing / savings ($/mo)',
      'Investing after you stop working ($/mo)',
    ]) {
      expect(budgetCard, `budget control "${label}" went missing in the split`).toContain(label);
    }
    // The four policy fields moved to Insurance, unchanged.
    for (const label of [
      'Life insurance ($/mo)',
      'Death benefit ($)',
      'Coverage ends',
      'Whose life it covers',
    ]) {
      expect(insuranceCard, `policy control "${label}" went missing in the split`).toContain(label);
    }
    // And the Tithing tab still carries both halves of the giving pair, each
    // bound to its own profile field: the ongoing method through the shared
    // editor, and the un-tithed pot through the shared pot fields.
    expect(profilePage).toContain('<OngoingGivingEditor');
    expect(profilePage).toContain('p.expenses.retirementGiving');
    expect(profilePage).toContain('<PotFields');
    expect(profilePage).toContain('p.expenses.untithedPot');
  });

  it('prices the giving rule off the stream the run will use', () => {
    // With rows present the scalar is a cache; pricing "same as working" off it
    // would quote a figure the rows have already replaced.
    expect(profilePage).toContain('deriveExpenseStreams(draft.expenses).charitableMonthly');
  });

  it('offers guardrails wherever the spending policy is chosen', () => {
    expect(profilePage).toContain("spending.type === 'guardrails'");
    expect(profilePage).toContain('Upper rail (× starting rate)');
    expect(profilePage).toContain('Spending floor (% of plan)');
  });
});

describe('the budget tabs are homogeneous', () => {
  it('offers no category selector anywhere', () => {
    // Each tab filters by its own category and stamps new rows with it, so a
    // selector would be the one control able to file a row where no tab shows
    // it. The grouped SelectCell existed only for this table and left with it.
    expect(budgetCard).not.toContain('SelectCell');
    expect(read('../../src/ui/components/profile/fields.tsx')).not.toContain('SelectCell');
  });

  it('stamps each tab’s own category on the rows it creates', () => {
    expect(budgetCard).toContain("makeExpenseLine(ls, 'living')");
    expect(budgetCard).toContain("makeExpenseLine(ls, 'charitable')");
    expect(budgetCard).toContain("makeExpenseLine(ls, 'investing')");
  });

  it('renders every money column from the single column contract', () => {
    // One table renders all three tabs, and its optional columns come from
    // LINE_TAB_COLUMNS — the contract the pure tests above tie to the engine.
    // A second hand-rolled column list is how a charitable row would grow back
    // the after-work editor the rule already owns.
    expect(budgetCard).toContain('LINE_TAB_COLUMNS[category]');
    expect(budgetCard).toContain('{columns.renting ? (');
    expect(budgetCard).toContain('{columns.retired ? (');
    expect(budgetCard).toContain('{columns.survivor ? (');
  });

  it('orders the money columns Now | While renting | If I stop working | If I die', () => {
    // The renting window sits between the working years and (usually) the
    // retired ones, so the columns read left to right in the order the plan
    // lives them — pinned on the header markup itself.
    const order = ['the Now column', 'While renting', 'If I stop working', 'If I die'].map((h) =>
      budgetCard.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('names the current plan’s window in the renting tooltip, and only then', () => {
    // The window is PLAN data surfacing on a PROFILE tab, so the header has to
    // say where it comes from — and must not invent dates when the plan
    // implies no move.
    expect(budgetCard).toContain('rentingTip(rentingWindow)');
    expect(budgetCard).toContain('no such window');
  });

  it('renders no note editor — the transcribed note survives as a hover title', () => {
    // The textfield under every row doubled the table's height to hold prose
    // that matters once. The data model keeps `note` (the transcribe script
    // writes it); the label cell's title is where it surfaces.
    expect(budgetCard).not.toContain('note (optional)');
    expect(budgetCard).not.toContain('Note for');
    expect(budgetCard).toContain('title={line.note}');
  });

  it('says on the Tithing tab why giving has only a Now column', () => {
    // One money column beside two three-column siblings must read as designed,
    // not unfinished — the muted sentence is that statement.
    expect(budgetCard).toContain('giving after');
    expect(budgetCard).toContain('the plan never reads an after-work or');
  });
});

describe('no screen quotes the scalar cache the budget rows replaced', () => {
  /*
   * The bug this pins, found by looking at the running app: the Dashboard's
   * "Living expenses" read profile.expenses.livingMonthly and announced
   * $7,100/mo · $85,200/yr for a household whose budget rows sum to
   * $7,340/mo — the exact figure every run it launched actually spent. The
   * Workbench's Spending card quoted the same $7,100 as the baseline its
   * overrides are typed against, and Explore centred its spending sweep there.
   *
   * The scalar is a CACHE: applyDerivedStreams refreshes it on every table
   * edit, but scripts/transcribe-budget.ts writes `lines` and never touches it,
   * so it is stale for exactly the profiles that have a budget to be stale
   * about. prepareSim and planSpendAnnual already derive; these three were the
   * last readers, and a screen that disagrees with the simulation behind it is
   * the failure this codebase keeps paying for.
   */
  it.each(QUOTING_SOURCES)('$name reads the rows, not the cache', ({ src }) => {
    expect(src).toContain('deriveExpenseStreams');
  });

  it.each(QUOTING_SOURCES)('$name never dots a derived stream off the profile', ({ src }) => {
    // `profileExpenses.lifeInsuranceMonthly` and `.retirementGiving` stay legal:
    // deriveExpenseStreams does not own them, so the profile is their only home.
    const direct = new RegExp(
      `(?:profile\\.expenses|profileExpenses)\\.(?:${DERIVED_STREAM_FIELDS})\\b`,
      'g',
    );
    expect(src.match(direct)).toBeNull();
  });

  it.each(QUOTING_SOURCES)('$name never indexes a derived stream off the profile', ({ src }) => {
    // The subscript form is how two of the three read it: `profileExpenses[row.key]`
    // and `profile.expenses[key]` are the same bug wearing brackets.
    expect(src).not.toMatch(/(?:profile\.expenses|profileExpenses)\[/);
  });
});

describe('an inherited cell does not look like a typed one', () => {
  it('renders the inherited figure as the input’s placeholder, not as its value', () => {
    // The distinction the whole editor turns on: a placeholder is what an EMPTY
    // box shows, so the cell stays absent in profile.json while the reader
    // still sees the number it inherits.
    expect(budgetCard).toContain('placeholder={String(line.monthlyNow)}');
    expect(budgetCard).toContain("placeholder={String(survivorMonthly(line, 'retired'))}");
  });

  it('styles that placeholder as dim and italic, so it cannot be misread', () => {
    const rule = /\.budget-table input::placeholder\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'no placeholder rule for the budget table').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*var\(--text-dim\)/);
    expect(rule![1]).toMatch(/font-style:\s*italic/);
  });

  it('never scrolls a tall budget inside its own box', () => {
    // A tall table is simply tall (see .table-scroll): capping its height put a
    // second scrollbar inside the page's own.
    const rule = /\.table-scroll\s*\{([^}]*)\}/.exec(css);
    expect(rule![1]).toMatch(/overflow-x:\s*auto/);
    expect(rule![1]).not.toMatch(/overflow-y/);
    expect(rule![1]).not.toMatch(/max-height/);
  });
});
