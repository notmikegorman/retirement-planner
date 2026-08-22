/**
 * Unit tests for the plan-editor helpers (pure logic behind the workbench's
 * left panel): event sorting/summaries, form-field <-> event round trips,
 * override and solver builders, and raw-JSON parsing. Expected values are
 * hand-computed (arithmetic noted in comments).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account, Person, Scenario, ScenarioEvent } from '../src/shared/types';
import { stableStringify } from '../src/shared/util';
import {
  EVENT_TYPES,
  PLAN_ONLY_EVENT_TYPES,
  accountName,
  addYears,
  autoSeppPatch,
  autoSeppStatus,
  defaultPlan,
  describeSeppBridges,
  firstPenaltyFreeYear,
  planSeppBridges,
  isPlanOwnedEvent,
  monthsBetween,
  planEventTypes,
  planGlideFromMix,
  readPlan,
  writePlan,
  type PlanDecisions,
  buildEvent,
  buildMarketOverride,
  buildOverrides,
  buildSolver,
  defaultEventFields,
  defaultSolverForType,
  describeSolver,
  eventDate,
  eventFieldsFrom,
  formatMix,
  mixError,
  overrideFieldErrors,
  overrideFieldsFrom,
  parseInteger,
  parseNumber,
  parseScenarioText,
  scenarioToText,
  solverFieldsFrom,
  sortEvents,
  summarizeEvent,
  validateEvent,
  validateScenario,
  SS_CLAIM_AGES,
  ageAtDate,
  dateAtAge,
  formatAge,
} from '../src/ui/components/scenarios/scenarioHelpers';

const people: Person[] = [
  {
    id: 'p1',
    name: 'Alice',
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 2500,
    piaMonthlyAtFraIfStoppingNow: 2200,
    hasOwnBenefit: true,
  },
  {
    id: 'p2',
    name: 'Bob',
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
  },
];

/** Minimal account list for the account-targeted event summaries (note 8). */
const accounts: Array<Pick<Account, 'id' | 'name'>> = [
  { id: 'k401', name: "Alice's 401(k)" },
  { id: 'ira-1', name: 'Traditional IRA' },
];

describe('number parsing', () => {
  it('parseNumber handles blanks, numbers, junk', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber(' 42 ')).toBe(42);
    expect(parseNumber('0.85')).toBe(0.85);
    expect(parseNumber('-5000')).toBe(-5000);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
  });

  it('parseInteger truncates toward zero', () => {
    // 2026.9 -> trunc -> 2026
    expect(parseInteger('2026.9')).toBe(2026);
    expect(parseInteger('-3.7')).toBe(-3);
    expect(parseInteger('')).toBeNull();
  });

  it('addYears bumps the year and keeps the month', () => {
    // 2026 + 5 = 2031, month stays 07
    expect(addYears('2026-07', 5)).toBe('2031-07');
    expect(addYears('2027-01', 1)).toBe('2028-01');
  });
});

describe('event vocabulary', () => {
  it('covers exactly the 14 v1 event types', () => {
    expect(EVENT_TYPES.map((t) => t.type).sort()).toEqual(
      [
        'retire',
        'claim_social_security',
        'expense_change',
        'state_change',
        'sell_house',
        'rent',
        'buy_house',
        'allocation_change',
        'glidepath',
        'withdrawal_strategy',
        'one_time_expense',
        'one_time_income',
        'start_72t',
        'roth_conversion',
      ].sort(),
    );
  });
});

describe('eventDate + sortEvents', () => {
  it('reads date, start, or null for undated (yearly) events', () => {
    expect(eventDate({ type: 'retire', person: 'p1', date: '2026-07' })).toBe('2026-07');
    expect(eventDate({ type: 'rent', start: '2027-06', months: 12, monthlyCost: 2800 })).toBe(
      '2027-06',
    );
    expect(
      eventDate({
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: { stocks: 1, bonds: 0, bills: 0 },
        toMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
      }),
    ).toBe('2026-07');
    expect(eventDate({ type: 'roth_conversion', yearly: true, toBracketTop: 0.12 })).toBeNull();
    expect(eventDate({ type: 'roth_conversion', date: '2027-01', amount: 50000 })).toBe('2027-01');
  });

  it('sorts by date ascending with undated events last', () => {
    const events: ScenarioEvent[] = [
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'roth_conversion', yearly: true, toBracketTop: 0.12 },
      { type: 'retire', person: 'p1', date: '2026-07' },
      { type: 'sell_house', date: '2027-06' },
    ];
    // Expected: 2026-07, 2027-06, 2038-06, then the undated yearly conversion.
    expect(sortEvents(events).map((e) => e.type)).toEqual([
      'retire',
      'sell_house',
      'claim_social_security',
      'roth_conversion',
    ]);
  });

  it('is stable for equal dates (original order preserved)', () => {
    const events: ScenarioEvent[] = [
      { type: 'retire', person: 'p1', date: '2026-07' },
      { type: 'retire', person: 'p2', date: '2026-07' },
    ];
    const sorted = sortEvents(events);
    expect(sorted[0]).toEqual({ type: 'retire', person: 'p1', date: '2026-07' });
    expect(sorted[1]).toEqual({ type: 'retire', person: 'p2', date: '2026-07' });
  });
});

describe('summarizeEvent', () => {
  it('names people, falls back to the raw id', () => {
    expect(summarizeEvent({ type: 'retire', person: 'p1', date: '2026-07' }, people)).toBe(
      'Alice stops working',
    );
    expect(
      summarizeEvent({ type: 'claim_social_security', person: 'p2', date: '2038-06' }, people),
    ).toBe('Bob claims benefits');
    expect(summarizeEvent({ type: 'retire', person: 'px', date: '2026-07' }, people)).toBe(
      'px stops working',
    );
  });

  it('expense_change: multiplier / delta / category', () => {
    expect(summarizeEvent({ type: 'expense_change', date: '2027-06', multiplier: 0.85 })).toBe(
      '×0.85',
    );
    // |−5000| formatted as $5,000, sign prefixed manually
    expect(summarizeEvent({ type: 'expense_change', date: '2027-06', delta: -5000 })).toBe(
      '-$5,000/yr',
    );
    // Only 'living' and 'charitable' are valid streams now (note 12).
    expect(
      summarizeEvent({
        type: 'expense_change',
        date: '2027-06',
        delta: 5000,
        category: 'charitable',
      }),
    ).toBe('+$5,000/yr (charitable)');
    expect(
      summarizeEvent({ type: 'expense_change', date: '2027-06', multiplier: 0, category: 'living' }),
    ).toBe('×0 (living)');
  });

  it('housing events', () => {
    expect(summarizeEvent({ type: 'state_change', date: '2027-06', state: 'sc' })).toBe(
      'Residency → SC',
    );
    expect(summarizeEvent({ type: 'sell_house', date: '2027-06' })).toBe('Sell primary home');
    // $2,800/mo for 12 months
    expect(
      summarizeEvent({ type: 'rent', start: '2027-06', months: 12, monthlyCost: 2800 }),
    ).toBe('$2,800/mo × 12 months');
    expect(
      summarizeEvent({
        type: 'buy_house',
        date: '2028-06',
        price: 'sale_proceeds',
        financing: 'cash',
        propertyTaxAnnual: 3300,
        insuranceAnnual: 1700,
      }),
    ).toBe('price = sale proceeds, cash');
    // downPct 0.2 -> 20%; rate 0.065 -> 6.50% (2 decimals); 30yr term
    expect(
      summarizeEvent({
        type: 'buy_house',
        date: '2028-06',
        price: 425000,
        financing: { downPct: 0.2, rate: 0.065, termYears: 30 },
        propertyTaxAnnual: 3300,
        insuranceAnnual: 1700,
      }),
    ).toBe('price $425,000, 20% down @ 6.50%, 30yr');
  });

  it('allocation / glidepath use whole-percent mixes', () => {
    // 0.6/0.4/0 -> 60/40/0
    expect(formatMix({ stocks: 0.6, bonds: 0.4, bills: 0 })).toBe('60/40/0');
    expect(
      summarizeEvent({
        type: 'allocation_change',
        date: '2026-07',
        mix: { stocks: 0.6, bonds: 0.4, bills: 0 },
      }),
    ).toBe('Mix → 60/40/0 (stocks/bonds/bills)');
    // Targeted at one account -> the display name is appended (note 8).
    expect(
      summarizeEvent(
        {
          type: 'allocation_change',
          date: '2026-07',
          mix: { stocks: 0.6, bonds: 0.4, bills: 0 },
          account: 'k401',
        },
        people,
        accounts,
      ),
    ).toBe("Mix → 60/40/0 (stocks/bonds/bills) — Alice's 401(k) only");
    expect(
      summarizeEvent({
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: { stocks: 1, bonds: 0, bills: 0 },
        toMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
      }),
    ).toBe('100/0/0 → 60/40/0 by 2031-07');
    expect(
      summarizeEvent(
        {
          type: 'glidepath',
          start: '2026-07',
          end: '2031-07',
          fromMix: { stocks: 1, bonds: 0, bills: 0 },
          toMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
          account: 'unknown-id',
        },
        people,
        accounts,
      ),
      // Unknown ids fall back to the raw id rather than disappearing.
    ).toBe('100/0/0 → 60/40/0 by 2031-07 — unknown-id only');
  });

  it('withdrawal strategy, one-time flows, 72t, roth conversions', () => {
    expect(
      summarizeEvent({
        type: 'withdrawal_strategy',
        date: '2030-01',
        policy: {
          order: ['cash', 'taxable', 'pretax', 'roth'],
          pretaxPreference: 'ira_first',
        },
      }),
    ).toBe('cash → taxable → pretax → roth (ira first)');
    expect(summarizeEvent({ type: 'one_time_expense', date: '2029-05', amount: 10000 })).toBe(
      '$10,000 expense',
    );
    expect(
      summarizeEvent({ type: 'one_time_income', date: '2029-05', amount: 25000, taxable: false }),
    ).toBe('$25,000 income (tax-free)');
    expect(summarizeEvent({ type: 'one_time_income', date: '2029-05', amount: 25000 })).toBe(
      '$25,000 income',
    );
    // No annualAmount -> the engine takes the formula maximum; the account id
    // resolves to its display name when the account list is supplied.
    expect(summarizeEvent({ type: 'start_72t', date: '2027-01', account: 'ira-1' })).toBe(
      'SEPP from ira-1, maximum payment',
    );
    expect(
      summarizeEvent({ type: 'start_72t', date: '2027-01', account: 'ira-1' }, people, accounts),
    ).toBe('SEPP from Traditional IRA, maximum payment');
    // 0.045 -> "4.5%" (formatPct with 1 decimal)
    expect(
      summarizeEvent(
        {
          type: 'start_72t',
          date: '2027-01',
          account: 'ira-1',
          annualAmount: 24000,
          interestRate: 0.045,
        },
        people,
        accounts,
      ),
    ).toBe('SEPP from Traditional IRA, $24,000/yr, @ 4.5%');
    // 0.12 -> 12% bracket top
    expect(
      summarizeEvent({ type: 'roth_conversion', yearly: true, toBracketTop: 0.12 }),
    ).toBe('Yearly, to top of 12% bracket');
    expect(summarizeEvent({ type: 'roth_conversion', date: '2027-01', amount: 50000 })).toBe(
      '$50,000',
    );
  });
});

describe('mixError', () => {
  it('accepts weights summing to 1', () => {
    expect(mixError({ stocks: 1, bonds: 0, bills: 0 })).toBeNull();
    expect(mixError({ stocks: 0.6, bonds: 0.4, bills: 0 })).toBeNull();
  });

  it('rejects bad sums and out-of-range weights', () => {
    // 0.6 + 0.3 + 0 = 0.9 (displayed rounded to 4 decimals)
    expect(mixError({ stocks: 0.6, bonds: 0.3, bills: 0 })).toBe(
      'weights sum to 0.9, must sum to 1',
    );
    expect(mixError({ stocks: 1.2, bonds: -0.2, bills: 0 })).toBe(
      'stocks must be between 0 and 1',
    );
  });
});

describe('validateScenario', () => {
  // The autosave calls this before every PUT: an invalid plan must be reported
  // in the panel rather than round-tripped to the server for a 400.
  it('accepts a plan the editor could have written', () => {
    const plan: Scenario = {
      name: 'Plan',
      events: [{ type: 'retire', person: 'p1', date: '2033-06' }],
    };
    expect(validateScenario(plan)).toBeNull();
  });

  it('reports empty names', () => {
    const err = validateScenario({ name: '', events: [] });
    expect(err).not.toBeNull();
    expect(err).toContain('name');
  });

  it('reports a bad event, naming the field', () => {
    const err = validateScenario({
      name: 'Plan',
      events: [{ type: 'retire', person: 'p1', date: 'nope' }],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('date');
  });
});

describe('validateEvent', () => {
  it('passes valid events and strips the events.0 path prefix', () => {
    expect(validateEvent({ type: 'retire', person: 'p1', date: '2026-07' })).toBeNull();
    const err = validateEvent({ type: 'retire', person: 'p1', date: 'nope' });
    expect(err).not.toBeNull();
    expect(err).toContain('date');
    expect(err).not.toContain('events.0');
  });

  it('flags mixes that do not sum to 1', () => {
    const err = validateEvent({
      type: 'allocation_change',
      date: '2026-07',
      mix: { stocks: 0.5, bonds: 0.3, bills: 0 },
    });
    expect(err).not.toBeNull();
    expect(err).toContain('sum');
  });
});

describe('buildEvent', () => {
  it('produces a valid event from defaults for every one of the 14 types', () => {
    for (const t of EVENT_TYPES) {
      const fields = defaultEventFields('2026-07');
      fields.type = t.type;
      fields.person = 'p1';
      fields.account = '401k-1';
      const res = buildEvent(fields);
      expect(res.ok, `type ${t.type}: ${res.ok ? '' : res.error}`).toBe(true);
      if (res.ok) expect(res.event.type).toBe(t.type);
    }
  });

  it('round-trips every event shape through eventFieldsFrom -> buildEvent', () => {
    const samples: ScenarioEvent[] = [
      { type: 'retire', person: 'p1', date: '2026-07' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
      { type: 'expense_change', date: '2027-06', multiplier: 0.85 },
      { type: 'expense_change', date: '2027-06', delta: -6000, category: 'charitable' },
      { type: 'state_change', date: '2027-06', state: 'sc' },
      { type: 'sell_house', date: '2027-06' },
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 2800 },
      {
        type: 'buy_house',
        date: '2028-06',
        price: 'sale_proceeds',
        financing: 'cash',
        propertyTaxAnnual: 3300,
        insuranceAnnual: 1700,
      },
      {
        type: 'buy_house',
        date: '2028-06',
        price: 425000,
        financing: { downPct: 0.2, rate: 0.065, termYears: 30 },
        propertyTaxAnnual: 3300,
        insuranceAnnual: 1700,
      },
      {
        // The scheduled payoff must survive an open-and-save of the event —
        // a form that dropped it would silently lengthen the loan to full term.
        type: 'buy_house',
        date: '2028-06',
        price: 425000,
        financing: { downPct: 0.2, rate: 0.065, termYears: 30, payoffAfterYears: 5 },
        propertyTaxAnnual: 3300,
        insuranceAnnual: 1700,
      },
      { type: 'allocation_change', date: '2026-07', mix: { stocks: 0.6, bonds: 0.4, bills: 0 } },
      {
        type: 'allocation_change',
        date: '2026-07',
        mix: { stocks: 0.6, bonds: 0.4, bills: 0 },
        account: 'k401',
      },
      {
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: { stocks: 1, bonds: 0, bills: 0 },
        toMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
      },
      {
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: { stocks: 1, bonds: 0, bills: 0 },
        toMix: { stocks: 0.6, bonds: 0.4, bills: 0 },
        account: 'k401',
      },
      {
        type: 'withdrawal_strategy',
        date: '2030-01',
        policy: {
          order: ['cash', 'taxable', 'pretax', 'roth'],
          pretaxPreference: 'ira_first',
        },
      },
      { type: 'one_time_expense', date: '2029-05', amount: 30000 },
      { type: 'one_time_income', date: '2029-05', amount: 12000, taxable: false },
      { type: 'one_time_income', date: '2029-05', amount: 12000 },
      { type: 'start_72t', date: '2027-01', account: 'ira-1' },
      { type: 'start_72t', date: '2027-01', account: 'ira-1', annualAmount: 24000 },
      {
        type: 'start_72t',
        date: '2027-01',
        account: 'ira-1',
        annualAmount: 24000,
        interestRate: 0.05,
      },
      { type: 'roth_conversion', yearly: true, toBracketTop: 0.12 },
      { type: 'roth_conversion', date: '2027-01', amount: 50000 },
    ];
    for (const e of samples) {
      const res = buildEvent(eventFieldsFrom(e));
      expect(res.ok, `${e.type}: ${res.ok ? '' : res.error}`).toBe(true);
      if (res.ok) expect(res.event).toEqual(e);
    }
  });

  it('pay-off-after: blank stays absent, inside-the-term saves, at-the-term errors', () => {
    const mortgageFields = () => {
      const f = defaultEventFields('2028-06');
      f.type = 'buy_house';
      f.priceMode = 'amount';
      f.price = '425000';
      f.financingMode = 'mortgage';
      f.termYears = '30';
      return f;
    };
    // Blank = full term, and it must round-trip as ABSENT (no key), because
    // absent is the spelling that means "the engine amortizes to maturity".
    const blank = buildEvent(mortgageFields());
    expect(blank.ok).toBe(true);
    if (blank.ok && blank.event.type === 'buy_house' && blank.event.financing !== 'cash') {
      expect('payoffAfterYears' in blank.event.financing).toBe(false);
    }
    // A stated payoff inside the term is written as typed.
    const f = mortgageFields();
    f.payoffAfterYears = '5';
    const withPayoff = buildEvent(f);
    expect(withPayoff.ok).toBe(true);
    if (withPayoff.ok && withPayoff.event.type === 'buy_house' && withPayoff.event.financing !== 'cash') {
      expect(withPayoff.event.financing.payoffAfterYears).toBe(5);
    }
    // At/past the term the form itself says why, instead of letting the raw
    // schema error surface later on save.
    const atTerm = mortgageFields();
    atTerm.payoffAfterYears = '30';
    const bad = buildEvent(atTerm);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/inside the term/);
    // Junk text errors too.
    const junk = mortgageFields();
    junk.payoffAfterYears = 'soonish';
    expect(buildEvent(junk).ok).toBe(false);
    // Stale payoff text under CASH financing must not block the save — the
    // form no longer shows the field, so it cannot be the user's statement.
    const cash = mortgageFields();
    cash.financingMode = 'cash';
    cash.payoffAfterYears = '30';
    expect(buildEvent(cash).ok).toBe(true);
  });

  it("omits the category key for 'living' (the contract default) and writes 'charitable'", () => {
    const f = defaultEventFields('2027-06');
    f.type = 'expense_change';
    f.expenseMode = 'multiplier';
    f.multiplier = '0.85';
    expect(f.category).toBe('living'); // the form default
    const living = buildEvent(f);
    expect(living.ok).toBe(true);
    // Absent category means 'living' in the engine, so the key is not written.
    if (living.ok) {
      expect(living.event).toEqual({ type: 'expense_change', date: '2027-06', multiplier: 0.85 });
    }
    f.category = 'charitable';
    const giving = buildEvent(f);
    if (giving.ok) {
      expect(giving.event).toEqual({
        type: 'expense_change',
        date: '2027-06',
        multiplier: 0.85,
        category: 'charitable',
      });
    }
  });

  it('start_72t: blank amount/rate stay absent, junk is rejected', () => {
    const f = defaultEventFields('2027-01');
    f.type = 'start_72t';
    f.account = 'ira-1';
    const blank = buildEvent(f);
    expect(blank.ok).toBe(true);
    // Blank = "let the engine use the formula maximum / default 5% rate".
    if (blank.ok) {
      expect(blank.event).toEqual({ type: 'start_72t', date: '2027-01', account: 'ira-1' });
    }
    f.annualAmount = 'lots';
    const bad = buildEvent(f);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('annual amount must be a number');
    f.annualAmount = '24000';
    f.interestRate = 'five';
    const bad2 = buildEvent(f);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.error).toContain('interest rate must be a number');
    // The schema caps the rate at 6%; 0.09 must be rejected, not silently kept.
    f.interestRate = '0.09';
    const tooHigh = buildEvent(f);
    expect(tooHigh.ok).toBe(false);
  });

  it('allocation_change / glidepath: blank account means "all accounts"', () => {
    const f = defaultEventFields('2026-07');
    f.type = 'allocation_change';
    f.account = '';
    const all = buildEvent(f);
    expect(all.ok).toBe(true);
    if (all.ok) expect('account' in all.event).toBe(false);
    f.account = 'k401';
    const one = buildEvent(f);
    if (one.ok && one.event.type === 'allocation_change') {
      expect(one.event.account).toBe('k401');
    }
  });

  it('the pre-tax preference default is ira_first (rule_of_55_first is gone)', () => {
    expect(defaultEventFields('2026-07').pretaxPreference).toBe('ira_first');
  });

  it('accountName resolves display names, falling back to the id', () => {
    expect(accountName(accounts, 'k401')).toBe("Alice's 401(k)");
    expect(accountName(accounts, 'nope')).toBe('nope');
    expect(accountName([{ id: 'x', name: '  ' }], 'x')).toBe('x');
  });

  it('reports friendly errors for missing/unparseable fields', () => {
    const noPerson = defaultEventFields('2026-07');
    noPerson.type = 'retire';
    noPerson.person = '';
    const r1 = buildEvent(noPerson);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain('person');

    const badMonths = defaultEventFields('2026-07');
    badMonths.type = 'rent';
    badMonths.months = 'abc';
    const r2 = buildEvent(badMonths);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('months must be a number');

    const badMix = defaultEventFields('2026-07');
    badMix.type = 'allocation_change';
    badMix.mix = { stocks: 0.5, bonds: 0.3, bills: 0 };
    const r3 = buildEvent(badMix);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toContain('sum');

    // One-time roth conversion with a cleared date field fails the YYYY-MM check.
    const badDate = defaultEventFields('2026-07');
    badDate.type = 'roth_conversion';
    badDate.schedule = 'once';
    badDate.date = '';
    const r4 = buildEvent(badDate);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error).toContain('YYYY-MM');
  });
});

describe('market/assumption overrides', () => {
  const defaults = { stocks: 0.058, bonds: 0.019, bills: 0.005, inflation: 0.024 };

  it('buildMarketOverride writes nothing when all fields are blank', () => {
    expect(
      buildMarketOverride({ stocks: '', bonds: '', bills: '', inflation: '' }, defaults),
    ).toBeUndefined();
  });

  it('backfills unset return members from defaults (deterministicReal is a whole object)', () => {
    // Only stocks set -> bonds/bills come from defaults; no inflation key.
    expect(
      buildMarketOverride({ stocks: '0.05', bonds: '', bills: '', inflation: '' }, defaults),
    ).toEqual({ deterministicReal: { stocks: 0.05, bonds: 0.019, bills: 0.005 } });
  });

  it('inflation alone writes only deterministicInflation', () => {
    expect(
      buildMarketOverride({ stocks: '', bonds: '', bills: '', inflation: '0.03' }, defaults),
    ).toEqual({ deterministicInflation: 0.03 });
  });

  it('buildOverrides round-trips through overrideFieldsFrom', () => {
    const o1 = {
      aca: { enhancedCreditsExtended: true },
      settings: {
        horizonAge: 100,
        successTarget: 0.9,
        spendingPolicy: { type: 'fixed_percent' as const, percent: 0.04 },
      },
    };
    expect(buildOverrides(overrideFieldsFrom(o1), defaults)).toEqual(o1);

    const o2 = {
      market: {
        deterministicReal: { stocks: 0.05, bonds: 0.02, bills: 0.01 },
        deterministicInflation: 0.025,
      },
    };
    expect(buildOverrides(overrideFieldsFrom(o2), defaults)).toEqual(o2);

    // Nothing set -> undefined (no assumption_overrides key written).
    expect(buildOverrides(overrideFieldsFrom(undefined), defaults)).toBeUndefined();
  });

  it('round-trips bondComposition.corporateFraction through the percent field', () => {
    /*
     * The stored value is a 0..1 fraction; the field speaks percent. The
     * round-trip is where the x100/÷100 conversion would betray itself:
     * 0.07 * 100 is 7.000000000000001 in floats (0.3 * 100 happens to land
     * exactly on 30 — the dust is value-dependent), and without the
     * display-side precision trim the field would show the dusty tail and
     * every commit would dirty the draft.
     */
    for (const [corporateFraction, shown] of [
      [0.3, '30'],
      [0.07, '7'], // NOT '7.000000000000001' — the trim's actual witness
      [1, '100'],
      [0.125, '12.5'],
    ] as const) {
      const o = { market: { bondComposition: { corporateFraction } } };
      const f = overrideFieldsFrom(o);
      expect(f.market.corporateShare).toBe(shown);
      expect(buildOverrides(f, defaults)).toEqual(o);
    }
    // An EXPLICIT zero survives as an explicit zero — the user said
    // "Treasuries only", and stripping a stated value is how a later default
    // change silently rewrites saved plans.
    const zero = { market: { bondComposition: { corporateFraction: 0 } } };
    expect(overrideFieldsFrom(zero).market.corporateShare).toBe('0');
    expect(buildOverrides(overrideFieldsFrom(zero), defaults)).toEqual(zero);
    // And it stands alone: no deterministic trio is dragged in with it.
    const built = buildOverrides(overrideFieldsFrom(zero), defaults);
    expect(built?.market?.deterministicReal).toBeUndefined();
  });

  it('round-trips a guardrails band the override already carries — raiseCeiling included', () => {
    /*
     * The card never EDITS the band (the rails stay a profile decision), but
     * an override can legitimately carry one — raw-JSON edits, and now the
     * raiseCeiling knob. Before the passthrough, committing any field on the
     * card rebuilt the policy as a bare { type: 'guardrails' } and silently
     * stripped the band; a scenario testing "cuts only" would revert to
     * uncapped raises the first time the horizon box was touched.
     */
    const o = {
      settings: {
        spendingPolicy: {
          type: 'guardrails' as const,
          guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1, floorFraction: 0.7, raiseCeiling: 1 },
        },
      },
    };
    expect(buildOverrides(overrideFieldsFrom(o), defaults)).toEqual(o);
    // A band-less guardrails override still round-trips band-less: the form
    // must never invent rails the file does not carry.
    const bare = { settings: { spendingPolicy: { type: 'guardrails' as const } } };
    expect(buildOverrides(overrideFieldsFrom(bare), defaults)).toEqual(bare);
  });

  it('round-trips the expenses block the card never edits — the plan.json data-loss case', () => {
    /*
     * The card has no boxes for ANY expense override, but the live plan
     * carries assumption_overrides.expenses (lifeInsurancePolicyPlans and
     * untithedPot). Before the passthrough, committing any field on the card
     * rebuilt the override without the block — touching the horizon box
     * cancelled the life-insurance dispositions and the pot in one stroke.
     */
    const o = {
      settings: { horizonAge: 100 },
      expenses: {
        livingMonthly: 5500,
        lifeInsurancePolicyPlans: {
          termA: 'keep_to_term' as const,
          termB: 'cancel_now' as const,
        },
        untithedPot: { enabled: false as const },
      },
    };
    expect(buildOverrides(overrideFieldsFrom(o), defaults)).toEqual(o);
    // And it survives an actual edit of an unrelated field, which is the
    // real-world shape of the loss: the commit fires because something ELSE
    // on the card changed.
    const f = overrideFieldsFrom(o);
    f.horizonAge = '95';
    expect(buildOverrides(f, defaults)).toEqual({ ...o, settings: { horizonAge: 95 } });
    // An expenses-only override stands alone: nothing else is invented, and
    // the block by itself is enough to keep assumption_overrides existing.
    const alone = { expenses: { livingMonthly: 5000 } };
    expect(buildOverrides(overrideFieldsFrom(alone), defaults)).toEqual(alone);
  });

  it('round-trips income overrides and settings.terminalFloorReal', () => {
    // Same passthrough contract as expenses: no box edits either, so both
    // must come back verbatim from a rebuild.
    const o = {
      settings: { successTarget: 0.9, terminalFloorReal: 250000 },
      income: { retirementMonthly: 2000, retirementIncomeTaxable: false },
    };
    expect(buildOverrides(overrideFieldsFrom(o), defaults)).toEqual(o);
  });

  it('round-trips market keys the card has no boxes for, and keeps them when the trio is cleared', () => {
    const o = {
      market: {
        deterministicReal: { stocks: 0.05, bonds: 0.02, bills: 0.01 },
        homeAppreciationRealSpread: 0.005,
        expenseRatios: { stocks: 0.0003, bonds: 0.0003, bills: 0 },
        bootstrapBlockYears: 5,
      },
    };
    expect(buildOverrides(overrideFieldsFrom(o), defaults)).toEqual(o);
    // Blanking the deterministic trio removes the trio and ONLY the trio:
    // the passthrough keys survive on their own.
    const f = overrideFieldsFrom(o);
    f.market.stocks = '';
    f.market.bonds = '';
    f.market.bills = '';
    expect(buildOverrides(f, defaults)).toEqual({
      market: {
        homeAppreciationRealSpread: 0.005,
        expenseRatios: { stocks: 0.0003, bonds: 0.0003, bills: 0 },
        bootstrapBlockYears: 5,
      },
    });
  });

  it('fixed_real spending policy override needs no percent', () => {
    const f = overrideFieldsFrom(undefined);
    f.spendingPolicyType = 'fixed_real';
    expect(buildOverrides(f, defaults)).toEqual({
      settings: { spendingPolicy: { type: 'fixed_real' } },
    });
  });

  describe('overrideFieldErrors (bounds mirror the strict scenario schema)', () => {
    it('blank fields carry no error', () => {
      expect(overrideFieldErrors(overrideFieldsFrom(undefined))).toEqual({});
    });

    it('flags a success target outside 0-1 (85 instead of 0.85)', () => {
      const f = overrideFieldsFrom(undefined);
      f.successTarget = '85';
      const errs = overrideFieldErrors(f);
      expect(errs.successTarget).toContain('between 0 and 1');
      f.successTarget = '0.85';
      expect(overrideFieldErrors(f)).toEqual({});
      // Bounds are inclusive: 0 and 1 are both legal.
      f.successTarget = '1';
      expect(overrideFieldErrors(f)).toEqual({});
    });

    it('flags non-numeric input instead of writing NaN', () => {
      const f = overrideFieldsFrom(undefined);
      f.successTarget = 'abc';
      expect(overrideFieldErrors(f).successTarget).toBe('must be a number');
      f.successTarget = '';
      f.horizonAge = '12x';
      expect(overrideFieldErrors(f).horizonAge).toBe('must be a number');
    });

    it('flags horizonAge outside the schema range 70-110 or non-integer', () => {
      const f = overrideFieldsFrom(undefined);
      f.horizonAge = '150';
      expect(overrideFieldErrors(f).horizonAge).toContain('between 70 and 110');
      f.horizonAge = '95.5';
      expect(overrideFieldErrors(f).horizonAge).toBe('must be a whole number');
      f.horizonAge = '100';
      expect(overrideFieldErrors(f)).toEqual({});
    });

    it('flags a corporate share outside 0-100 (percent, not fraction)', () => {
      const f = overrideFieldsFrom(undefined);
      f.market.corporateShare = '150';
      expect(overrideFieldErrors(f).corporateShare).toContain('between 0 and 100');
      f.market.corporateShare = '-5';
      expect(overrideFieldErrors(f).corporateShare).toContain('between 0 and 100');
      // In-bounds percent values are clean — including the 0.3 that MEANS
      // 0.3% here (the hint text, not a bound, is what disambiguates units).
      for (const ok of ['0', '0.3', '30', '100']) {
        f.market.corporateShare = ok;
        expect(overrideFieldErrors(f)).toEqual({});
      }
      // And an out-of-range share is never written into the draft.
      f.market.corporateShare = '150';
      expect(buildOverrides(f, defaults)).toBeUndefined();
    });

    it('flags market returns outside +/-0.2 and inflation outside -0.05..0.15', () => {
      const f = overrideFieldsFrom(undefined);
      f.market.stocks = '0.5';
      f.market.inflation = '0.2';
      const errs = overrideFieldErrors(f);
      expect(errs.stocks).toContain('between -0.2 and 0.2');
      expect(errs.inflation).toContain('between -0.05 and 0.15');
    });

    it('checks the spending percent only for fixed_percent (0-0.25)', () => {
      const f = overrideFieldsFrom(undefined);
      f.spendingPercent = '0.5';
      // Not fixed_percent -> the field is ignored.
      expect(overrideFieldErrors(f)).toEqual({});
      f.spendingPolicyType = 'fixed_percent';
      expect(overrideFieldErrors(f).spendingPercent).toContain('between 0 and 0.25');
    });
  });

  describe('buildOverrides rejects out-of-bounds values (never writes them)', () => {
    it('skips an invalid success target so the draft stays schema-valid', () => {
      const f = overrideFieldsFrom(undefined);
      f.successTarget = '85'; // out of 0-1 -> rejected, not clamped
      expect(buildOverrides(f, defaults)).toBeUndefined();
      // Valid siblings still commit: horizonAge 100 passes, target is skipped.
      f.horizonAge = '100';
      expect(buildOverrides(f, defaults)).toEqual({ settings: { horizonAge: 100 } });
    });

    it('skips an out-of-range market return but keeps valid members', () => {
      const f = overrideFieldsFrom(undefined);
      f.market.stocks = '0.5'; // > 0.2 -> rejected
      f.market.bonds = '0.02'; // valid -> backfills stocks/bills from defaults
      expect(buildOverrides(f, defaults)).toEqual({
        market: {
          deterministicReal: { stocks: defaults.stocks, bonds: 0.02, bills: defaults.bills },
        },
      });
    });

    it('falls back to 0.04 for an invalid fixed_percent value', () => {
      const f = overrideFieldsFrom(undefined);
      f.spendingPolicyType = 'fixed_percent';
      f.spendingPercent = '0.5'; // > 0.25 -> rejected -> default 0.04
      expect(buildOverrides(f, defaults)).toEqual({
        settings: { spendingPolicy: { type: 'fixed_percent', percent: 0.04 } },
      });
    });
  });
});

describe('solver spec', () => {
  it('round-trips the defaults for all five solver types', () => {
    for (const type of [
      'retire_year_sweep',
      'ss_claim_sweep',
      'swr_curve',
      'max_spend',
      'earliest_retirement',
    ] as const) {
      const spec = defaultSolverForType(type);
      expect(buildSolver(solverFieldsFrom(spec)), type).toEqual(spec);
    }
  });

  it('none -> undefined; optional fields omitted when blank', () => {
    expect(buildSolver(solverFieldsFrom(undefined))).toBeUndefined();
    // ss_claim_sweep without stepMonths keeps the key absent
    expect(buildSolver(solverFieldsFrom({ type: 'ss_claim_sweep' }))).toEqual({
      type: 'ss_claim_sweep',
    });
    // alsoMaxSpend false is omitted, not written as false
    expect(
      buildSolver(solverFieldsFrom({ type: 'retire_year_sweep', from: 2027, to: 2030 })),
    ).toEqual({ type: 'retire_year_sweep', from: 2027, to: 2030 });
  });

  it('describeSolver renders human-readable summaries', () => {
    expect(describeSolver(undefined)).toBe('None');
    expect(
      describeSolver({ type: 'retire_year_sweep', from: 2026, to: 2033, alsoMaxSpend: true }),
    ).toBe('Retire-year sweep 2026–2033 + max spend');
    expect(describeSolver({ type: 'ss_claim_sweep' })).toBe('SS claim sweep, every 1 mo');
    expect(
      describeSolver({ type: 'swr_curve', spendFrom: 50000, spendTo: 120000, step: 5000 }),
    ).toBe('SWR curve $50,000–$120,000 step $5,000');
    // 0.85 -> 85%
    expect(describeSolver({ type: 'max_spend', targetSuccess: 0.85 })).toBe('Max spend @ 85%');
    expect(
      describeSolver({ type: 'earliest_retirement', targetSuccess: 0.9, from: 2026, to: 2035 }),
    ).toBe('Earliest retirement @ 90% (2026–2035)');
  });
});

describe('raw JSON parsing', () => {
  it('rejects invalid JSON with an Invalid JSON prefix', () => {
    const res = parseScenarioText('not json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith('Invalid JSON')).toBe(true);
  });

  it('rejects schema violations with a field path', () => {
    const res = parseScenarioText('{"name":"x","events":"nope"}');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('events');
  });

  it('surfaces the strict override-schema errors (Apply error termA path)', () => {
    // successTarget 85 violates the 0-1 bound in the strict settings override
    // schema; the Raw JSON Apply termA must show the field path.
    const res = parseScenarioText(
      '{"name":"x","events":[],"assumption_overrides":{"settings":{"successTarget":85}}}',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('successTarget');

    // Unknown keys in the strict override objects fail loudly too.
    const res2 = parseScenarioText(
      '{"name":"x","events":[],"assumption_overrides":{"settings":{"succesTarget":0.9}}}',
    );
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error).toContain('succesTarget');
  });

  it('round-trips a scenario through scenarioToText', () => {
    const s = {
      name: 'Base',
      description: 'd',
      events: [{ type: 'retire' as const, person: 'p1', date: '2026-07' }],
      solver: { type: 'max_spend' as const, targetSuccess: 0.85 },
    };
    const res = parseScenarioText(scenarioToText(s));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.scenario).toEqual(s);
  });

  it('parses every example plan file and round-trips all their events', () => {
    const dir = join(process.cwd(), 'data-defaults', 'scenarios');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const res = parseScenarioText(readFileSync(join(dir, file), 'utf8'));
      expect(res.ok, file).toBe(true);
      if (!res.ok) continue;
      for (const e of res.scenario.events) {
        const rt = buildEvent(eventFieldsFrom(e));
        expect(rt.ok, `${file}: ${e.type}`).toBe(true);
        if (rt.ok) expect(rt.event).toEqual(e);
      }
    }
  });
});

describe('age <-> date helpers (note 17)', () => {
  // Alex: born March 1975. Reaching age A happens in (1975 + A)-03.
  const alex: Person = {
    id: 'p1',
    name: 'Alex',
    birthYear: 1975,
    birthMonth: 3,
    piaMonthlyAtFraIfWorkingTo62: 3320,
    piaMonthlyAtFraIfStoppingNow: 3180,
    hasOwnBenefit: true,
  };
  // Someone born in December, to catch year-rollover arithmetic.
  const dec: Person = { ...alex, id: 'p3', birthMonth: 12 };

  it('maps a claiming age to the month that age is reached', () => {
    expect(dateAtAge(alex, 62)).toBe('2037-03');
    expect(dateAtAge(alex, 67)).toBe('2042-03');
    expect(dateAtAge(alex, 70)).toBe('2045-03');
  });

  it('handles extra months and rolls the year over', () => {
    // March + 7 months = October of the same year.
    expect(dateAtAge(alex, 62, 7)).toBe('2037-10');
    // December birthday: age 62 is 2037-12; +1 month crosses into 2038-01.
    expect(dateAtAge(dec, 62)).toBe('2037-12');
    expect(dateAtAge(dec, 62, 1)).toBe('2038-01');
  });

  it('round-trips a date back to an age', () => {
    expect(ageAtDate(alex, '2042-03')).toEqual({ years: 67, months: 0 });
    expect(ageAtDate(alex, '2037-10')).toEqual({ years: 62, months: 7 });
    expect(ageAtDate(dec, '2037-12')).toEqual({ years: 62, months: 0 });
  });

  it('rejects malformed or pre-birth dates', () => {
    expect(ageAtDate(alex, 'nonsense')).toBeNull();
    expect(ageAtDate(alex, '1970-01')).toBeNull();
  });

  it('formats ages for display', () => {
    expect(formatAge({ years: 67, months: 0 })).toBe('age 67');
    expect(formatAge({ years: 62, months: 7 })).toBe('age 62 + 7 mo');
    expect(formatAge(null)).toBe('');
  });

  it('offers exactly the legal claiming ages', () => {
    expect(SS_CLAIM_AGES).toEqual([62, 63, 64, 65, 66, 67, 68, 69, 70]);
  });
});

describe('the plan layer (readPlan / writePlan / defaultPlan)', () => {
  // `people` above: Alice (p1) and Bob (p2), both born June 1971. Ages land in
  // June of (1971 + age): 62 -> 2033-06, 65 -> 2036-06, 67 -> 2038-06.
  // A March 1965 birthday is used where per-person dates must differ:
  // age 62 -> 2027-03.
  const march1965: Person = { ...people[1], id: 'p3', name: 'Cara', birthYear: 1965, birthMonth: 3 };

  const sixtyForty = { stocks: 0.6, bonds: 0.4, bills: 0 };
  const allStocks = { stocks: 1, bonds: 0, bills: 0 };

  /** An event the plan never owns, used to prove the rest survives untouched. */
  const sellHouse: ScenarioEvent = { type: 'sell_house', date: '2027-06' };
  const move: ScenarioEvent = { type: 'state_change', date: '2027-06', state: 'sc' };

  it('planEventTypes names exactly the four types the plan owns', () => {
    expect(planEventTypes().sort()).toEqual(
      ['retire', 'claim_social_security', 'allocation_change', 'glidepath'].sort(),
    );
    // PLAN_ONLY is a different list from planEventTypes: it is what the "add
    // event" picker refuses to OFFER, not what the Plan card rewrites.
    //
    // Retiring and claiming are plan-only because the Plan card owns them. The
    // three housing types are plan-only because the HOUSING card does: housing
    // is first-class configuration now, and offering "Sell house" beside
    // "State change" invited a second way to say the same thing that the
    // compiled plan then silently discarded. An allocation event is NOT here —
    // one aimed at a single account is a detail, not the household decision, so
    // it stays addable.
    expect([...PLAN_ONLY_EVENT_TYPES].sort()).toEqual(
      ['buy_house', 'claim_social_security', 'rent', 'retire', 'sell_house'].sort(),
    );
    // The engine still understands them — they are what a housing plan
    // compiles INTO, and old files full of them keep running.
    expect(planEventTypes()).not.toContain('sell_house');
  });

  it('isPlanOwnedEvent claims whole-portfolio allocation events but not targeted ones', () => {
    expect(isPlanOwnedEvent({ type: 'retire', person: 'p1', date: '2033-06' })).toBe(true);
    expect(
      isPlanOwnedEvent({ type: 'claim_social_security', person: 'p2', date: '2038-06' }),
    ).toBe(true);
    expect(isPlanOwnedEvent({ type: 'allocation_change', date: '2033-06', mix: sixtyForty })).toBe(
      true,
    );
    expect(
      isPlanOwnedEvent({
        type: 'allocation_change',
        date: '2033-06',
        mix: sixtyForty,
        account: 'k401',
      }),
    ).toBe(false);
    expect(isPlanOwnedEvent(sellHouse)).toBe(false);
  });

  it('monthsBetween counts whole months in both directions', () => {
    // 2026-07 -> 2031-07 is 5 years = 60 months.
    expect(monthsBetween('2026-07', '2031-07')).toBe(60);
    // 2026-07 -> 2027-01 is 6 months; reversed it is -6.
    expect(monthsBetween('2026-07', '2027-01')).toBe(6);
    expect(monthsBetween('2027-01', '2026-07')).toBe(-6);
    expect(monthsBetween('nope', '2027-01')).toBe(0);
  });

  it('defaultPlan retires everyone at 62 and claims at full retirement age', () => {
    const plan = defaultPlan(people);
    // Both born June 1971: 1971 + 62 = 2033-06, 1971 + 67 = 2038-06.
    expect(plan).toEqual({
      retireByPerson: { p1: '2033-06', p2: '2033-06' },
      claimDate: '2038-06',
      allocation: null,
    });
  });

  it('defaultPlan uses each person’s own birthday', () => {
    // Cara born March 1965 reaches 62 in 1965 + 62 = 2027-03; the household
    // claim date is anchored on person 1 (Alice, June 1971 -> 2038-06).
    const plan = defaultPlan([people[0], march1965]);
    expect(plan.retireByPerson).toEqual({ p1: '2033-06', p3: '2027-03' });
    expect(plan.claimDate).toBe('2038-06');
  });

  it('defaultPlan on an empty household decides nothing', () => {
    expect(defaultPlan([])).toEqual({ retireByPerson: {}, claimDate: null, allocation: null });
  });

  it('a scenario with no plan events reads as all-null', () => {
    const plan = readPlan([sellHouse, move], people);
    expect(plan).toEqual({
      retireByPerson: { p1: null, p2: null },
      claimDate: null,
      allocation: null,
    });
  });

  it('reads retire, claim and an instant allocation change', () => {
    const events: ScenarioEvent[] = [
      { type: 'retire', person: 'p1', date: '2026-07' },
      { type: 'retire', person: 'p2', date: '2027-07' },
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
      { type: 'allocation_change', date: '2026-07', mix: sixtyForty },
      sellHouse,
    ];
    expect(readPlan(events, people)).toEqual({
      retireByPerson: { p1: '2026-07', p2: '2027-07' },
      claimDate: '2038-06',
      // An instant switch is a glide of zero years.
      allocation: { date: '2026-07', mix: sixtyForty, glideYears: 0 },
    });
  });

  it('reads a glidepath as start date + target mix + length in years', () => {
    const events: ScenarioEvent[] = [
      {
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: allStocks,
        toMix: sixtyForty,
      },
    ];
    const plan = readPlan(events, people);
    // 2026-07 -> 2031-07 is 60 months = 5 years.
    expect(plan.allocation).toEqual({ date: '2026-07', mix: sixtyForty, glideYears: 5 });
    // The starting mix is not part of the decision, but it is preserved.
    expect(planGlideFromMix(events)).toEqual(allStocks);
    // With no glidepath in the scenario, a new one starts from all stocks.
    expect(planGlideFromMix([])).toEqual({ stocks: 1, bonds: 0, bills: 0 });
  });

  it('a sub-year glidepath still reads as a glide, never as an instant switch', () => {
    // 2026-07 -> 2027-01 is 6 months; 6/12 rounds to 0, floored to 1 year so
    // rewriting it cannot silently turn a glide into a same-day switch.
    const plan = readPlan(
      [
        {
          type: 'glidepath',
          start: '2026-07',
          end: '2027-01',
          fromMix: allStocks,
          toMix: sixtyForty,
        },
      ],
      people,
    );
    expect(plan.allocation?.glideYears).toBe(1);
  });

  it('keeps person 1’s claim date when the two disagree', () => {
    const events: ScenarioEvent[] = [
      { type: 'claim_social_security', person: 'p2', date: '2033-06' },
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
    ];
    // Household claiming is one decision; person 1 (the worker) wins.
    expect(readPlan(events, people).claimDate).toBe('2038-06');
    // With only person 2's event present, that one is used.
    expect(readPlan([events[0]], people).claimDate).toBe('2033-06');
  });

  it('ignores an account-targeted allocation event', () => {
    const targeted: ScenarioEvent = {
      type: 'allocation_change',
      date: '2030-01',
      mix: sixtyForty,
      account: 'k401',
    };
    expect(readPlan([targeted], people).allocation).toBeNull();
    // ...and writing the plan leaves it alone.
    const plan = defaultPlan(people);
    expect(writePlan([targeted], plan, people)).toContain(targeted);
  });

  it('round-trips every decision through writePlan -> readPlan', () => {
    const cases: PlanDecisions[] = [
      defaultPlan(people),
      // Person 2 keeps working; instant allocation switch.
      {
        retireByPerson: { p1: '2026-07', p2: null },
        claimDate: '2036-06',
        allocation: { date: '2026-07', mix: sixtyForty, glideYears: 0 },
      },
      // Nobody retires, nobody claims, five-year glide.
      {
        retireByPerson: { p1: null, p2: null },
        claimDate: null,
        allocation: { date: '2030-01', mix: { stocks: 0.4, bonds: 0.5, bills: 0.1 }, glideYears: 5 },
      },
    ];
    for (const plan of cases) {
      const events = writePlan([], plan, people);
      expect(readPlan(events, people), JSON.stringify(plan)).toEqual(plan);
      // Everything written is schema-valid.
      for (const e of events) expect(validateEvent(e), e.type).toBeNull();
    }
  });

  it('writes the same claim date for every person', () => {
    const events = writePlan(
      [],
      { retireByPerson: { p1: null, p2: null }, claimDate: '2038-06', allocation: null },
      people,
    );
    expect(events).toEqual([
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
    ]);
  });

  it('replaces the old plan events and preserves everything else in order', () => {
    const before: ScenarioEvent[] = [
      { type: 'retire', person: 'p1', date: '2026-07' },
      sellHouse,
      { type: 'claim_social_security', person: 'p1', date: '2033-06' },
      move,
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 2800 },
    ];
    const after = writePlan(
      before,
      {
        retireByPerson: { p1: '2029-06', p2: '2029-06' },
        claimDate: '2038-06',
        allocation: null,
      },
      people,
    );
    // Plan events lead (retires in people order, then claims), then the three
    // untouched events in exactly their original relative order.
    expect(after).toEqual([
      { type: 'retire', person: 'p1', date: '2029-06' },
      { type: 'retire', person: 'p2', date: '2029-06' },
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
      sellHouse,
      move,
      { type: 'rent', start: '2027-06', months: 12, monthlyCost: 2800 },
    ]);
  });

  it('switching glideYears between 0 and 5 swaps allocation_change and glidepath', () => {
    const base: PlanDecisions = {
      retireByPerson: { p1: null, p2: null },
      claimDate: null,
      allocation: { date: '2026-07', mix: sixtyForty, glideYears: 0 },
    };
    const instant = writePlan([], base, people);
    expect(instant).toEqual([{ type: 'allocation_change', date: '2026-07', mix: sixtyForty }]);

    // 0 -> 5 years: same start date, end five years later (2026-07 + 5 = 2031-07).
    const glided = writePlan(instant, { ...base, allocation: { ...base.allocation!, glideYears: 5 } }, people);
    expect(glided).toEqual([
      {
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: allStocks,
        toMix: sixtyForty,
      },
    ]);

    // 5 -> 0 years: back to a single allocation_change, no leftover glidepath.
    const backToInstant = writePlan(
      glided,
      { ...base, allocation: { ...base.allocation!, glideYears: 0 } },
      people,
    );
    expect(backToInstant).toEqual(instant);
  });

  it('preserves an existing glidepath’s starting mix when the target changes', () => {
    const glided: ScenarioEvent[] = [
      {
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: { stocks: 0.8, bonds: 0.2, bills: 0 },
        toMix: sixtyForty,
      },
    ];
    const next = writePlan(
      glided,
      {
        retireByPerson: { p1: null, p2: null },
        claimDate: null,
        // Same glide, new target: 40/60.
        allocation: { date: '2026-07', mix: { stocks: 0.4, bonds: 0.6, bills: 0 }, glideYears: 5 },
      },
      people,
    );
    expect(next).toEqual([
      {
        type: 'glidepath',
        start: '2026-07',
        end: '2031-07',
        fromMix: { stocks: 0.8, bonds: 0.2, bills: 0 },
        toMix: { stocks: 0.4, bonds: 0.6, bills: 0 },
      },
    ]);
  });

  it('seeds a fresh plan with the three decisions and nothing else', () => {
    // Exactly what the server writes into a new plan.json
    // (dataStore.defaultPlanScenario calls these two helpers).
    const plan: Scenario = { name: 'Plan', events: writePlan([], defaultPlan(people), people) };
    expect(validateScenario(plan)).toBeNull();
    // Retire at 62 (2033-06) for both, claim at 67 (2038-06) for both, no
    // allocation change — and no other events: the user builds those himself.
    expect(plan.events).toEqual([
      { type: 'retire', person: 'p1', date: '2033-06' },
      { type: 'retire', person: 'p2', date: '2033-06' },
      { type: 'claim_social_security', person: 'p1', date: '2038-06' },
      { type: 'claim_social_security', person: 'p2', date: '2038-06' },
    ]);
    expect(readPlan(plan.events, people)).toEqual(defaultPlan(people));
  });

  it('reads a complete plan out of every example plan file', () => {
    // data-defaults/scenarios/*.json are no longer seeded anywhere — they are
    // kept as realistic fixtures for readPlan and the event round trips above.
    const dir = join(process.cwd(), 'data-defaults', 'scenarios');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const res = parseScenarioText(readFileSync(join(dir, file), 'utf8'));
      expect(res.ok, file).toBe(true);
      if (!res.ok) continue;
      // No solver specs in the fixtures — sweeps are Explore answers now.
      expect(res.scenario.solver, file).toBeUndefined();
      const plan = readPlan(res.scenario.events, people);
      expect(plan.retireByPerson.p1, file).not.toBeNull();
      expect(plan.retireByPerson.p2, file).not.toBeNull();
      expect(plan.claimDate, file).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The automatic 72(t)/SEPP bridge (scenario.autoSepp — absent means ON)
// ---------------------------------------------------------------------------
//
// Both fixture people were born 1971-06, so birthMonth <= 6 puts 59 1/2 in
// calendar 2030 and the first penalty-free year at 1971 + 59 + 1 = 2031
// (engine/household penaltyFreeFromYear). Every expectation below follows from
// that single number.

describe('automatic 72(t) bridge helpers', () => {
  /** Owners for the start_72t exclusion (the event names an account, not a person). */
  const ownedAccounts: Array<Pick<Account, 'id' | 'owner'>> = [
    { id: 'ira-1', owner: 'p1' },
    { id: 'ira-2', owner: 'p2' },
  ];
  const retireAt = (date: string): ScenarioEvent[] => [
    { type: 'retire', person: 'p1', date },
    { type: 'retire', person: 'p2', date },
  ];

  it('planSeppBridges finds the people who stop before their penalty-free year', () => {
    const plan: PlanDecisions = {
      retireByPerson: { p1: '2028-07', p2: '2028-07' },
      claimDate: null,
      allocation: null,
    };
    // 2031 - 2028 = 3 years of bridge for each.
    expect(planSeppBridges(plan, people)).toEqual([
      { personId: 'p1', name: 'Alice', retireYear: 2028, penaltyFreeYear: 2031, bridgeYears: 3 },
      { personId: 'p2', name: 'Bob', retireYear: 2028, penaltyFreeYear: 2031, bridgeYears: 3 },
    ]);
  });

  it('planSeppBridges ignores retirements at/after the penalty-free year, and non-retirees', () => {
    // 2031 IS the first penalty-free year: nothing to bridge.
    expect(
      planSeppBridges(
        { retireByPerson: { p1: '2031-06', p2: '2033-06' }, claimDate: null, allocation: null },
        people,
      ),
    ).toEqual([]);
    // One retires early, the other keeps working.
    const mixed = planSeppBridges(
      { retireByPerson: { p1: '2030-12', p2: null }, claimDate: null, allocation: null },
      people,
    );
    expect(mixed.map((b) => b.personId)).toEqual(['p1']);
    expect(mixed[0].bridgeYears).toBe(1); // 2031 - 2030
  });

  it('firstPenaltyFreeYear is the earliest 59 1/2 year in the household', () => {
    expect(firstPenaltyFreeYear(people)).toBe(2031);
    // Born 1965-03 (month > 6 is irrelevant here): 1965 + 59 + 1 = 2025.
    const older: Person = { ...people[0], id: 'p9', birthYear: 1965, birthMonth: 3 };
    expect(firstPenaltyFreeYear([...people, older])).toBe(2025);
    expect(firstPenaltyFreeYear([])).toBeNull();
  });

  it('describeSeppBridges names each span, one or many', () => {
    const plan: PlanDecisions = {
      retireByPerson: { p1: '2028-07', p2: '2029-07' },
      claimDate: null,
      allocation: null,
    };
    const bridges = planSeppBridges(plan, people);
    expect(describeSeppBridges(bridges)).toBe('Alice 2028 → 2031 and Bob 2029 → 2031');
    expect(describeSeppBridges([bridges[0]])).toBe('Alice 2028 → 2031');
    expect(describeSeppBridges([])).toBe('');
  });

  it('autoSeppStatus: applies and is ON when the plan retires early and says nothing', () => {
    const status = autoSeppStatus({ events: retireAt('2028-07') }, people, ownedAccounts);
    expect(status.applies).toBe(true);
    expect(status.on).toBe(true); // absent means ON
    expect(status.bridges.map((b) => b.personId)).toEqual(['p1', 'p2']);
    expect(status.explicit).toEqual([]);
    expect(status.inertReason).toBeNull();
  });

  it('autoSeppStatus: autoSepp false is off but still applies', () => {
    const status = autoSeppStatus(
      { autoSepp: false, events: retireAt('2028-07') },
      people,
      ownedAccounts,
    );
    expect(status.applies).toBe(true);
    expect(status.on).toBe(false);
  });

  it('autoSeppStatus: a hand-written start_72t speaks for its owner', () => {
    const events: ScenarioEvent[] = [
      ...retireAt('2028-07'),
      { type: 'start_72t', date: '2028-07', account: 'ira-1' }, // ira-1 is p1's
    ];
    const status = autoSeppStatus({ events }, people, ownedAccounts);
    // p1 keeps their own election; only p2 gets an automatic one.
    expect(status.bridges.map((b) => b.personId)).toEqual(['p2']);
    expect(status.explicit.map((b) => b.name)).toEqual(['Alice']);
    expect(status.applies).toBe(true);
  });

  it('autoSeppStatus: inert when every early retiree elected by hand', () => {
    const events: ScenarioEvent[] = [
      ...retireAt('2028-07'),
      { type: 'start_72t', date: '2028-07', account: 'ira-1' },
      { type: 'start_72t', date: '2028-07', account: 'ira-2' },
    ];
    const status = autoSeppStatus({ events }, people, ownedAccounts);
    expect(status.applies).toBe(false);
    expect(status.bridges).toEqual([]);
    expect(status.inertReason).toContain('by hand');
  });

  it('autoSeppStatus: inert, and says why, when nobody stops before 59 1/2', () => {
    const status = autoSeppStatus({ events: retireAt('2033-06') }, people, ownedAccounts);
    expect(status.applies).toBe(false);
    expect(status.inertReason).toContain('2031');
    // Still reports the stored setting so a scenario that turned it off shows it.
    expect(autoSeppStatus({ autoSepp: false, events: [] }, people).on).toBe(false);
    expect(autoSeppStatus({ events: [] }, []).inertReason).toBe('No people in this profile yet.');
  });

  it('autoSeppPatch: unchecking writes false, checking clears the field', () => {
    expect(autoSeppPatch(false)).toEqual({ autoSepp: false });
    const off: Scenario = { name: 'x', events: [], ...autoSeppPatch(false) };
    expect(off.autoSepp).toBe(false);
    // Checking it again must leave saved JSON with no autoSepp key at all —
    // undefined already means ON, and JSON.stringify drops undefined values.
    const back = { ...off, ...autoSeppPatch(true) };
    expect(JSON.stringify(back)).toBe('{"name":"x","events":[]}');
    expect(stableStringify(back)).toBe(stableStringify({ name: 'x', events: [] }));
    expect(validateScenario(back as Scenario)).toBeNull();
  });
});
