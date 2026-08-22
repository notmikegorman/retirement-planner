/**
 * The Housing form's survivor-price round-trip (withSurvivorPurchasePrice in
 * HousingCard.tsx).
 *
 * The form state IS the HousingPlan object — the card patches `scenario.housing`
 * directly — so the property worth a test is the SHAPE of the patched object:
 * a cleared field must come OUT of the plan rather than sit in it as
 * `undefined`. The plan is JSON on disk and its schema strips what it does not
 * know, so `survivorPurchasePrice: undefined` would be a draft that disagrees
 * with what a save/load hands back, and "did the user state a survivor
 * price?" — the exact question the Widow tab's copy answers — would depend on
 * which copy of the plan you asked.
 */
import { describe, expect, it } from 'vitest';
import type { Home, HousingPlan, ScenarioEvent } from '../../src/shared/types';
import { scenarioSchema } from '../../src/shared/schemas';
import {
  seedHousingPlan,
  withSurvivorDownsize,
  withSurvivorPurchasePrice,
} from '../../src/ui/components/workbench/HousingCard';

const plan = (): HousingPlan => ({
  sellDate: '2027-06',
  rentMonths: 12,
  rentMonthly: 3000,
  purchasePrice: 1_750_000,
  propertyTaxAnnual: 7500,
  financing: { type: 'cash' },
});

describe('withSurvivorPurchasePrice', () => {
  it('sets a number, a 0, and the sale_proceeds spelling', () => {
    expect(withSurvivorPurchasePrice(plan(), 900_000).survivorPurchasePrice).toBe(900_000);
    expect(withSurvivorPurchasePrice(plan(), 0).survivorPurchasePrice).toBe(0);
    expect(withSurvivorPurchasePrice(plan(), 'sale_proceeds').survivorPurchasePrice).toBe(
      'sale_proceeds',
    );
  });

  it('clearing REMOVES the key — absent, not undefined', () => {
    const cleared = withSurvivorPurchasePrice(
      withSurvivorPurchasePrice(plan(), 900_000),
      undefined,
    );
    expect('survivorPurchasePrice' in cleared).toBe(false);
  });

  it('never mutates the plan it was given — the draft is React state', () => {
    const before = plan();
    withSurvivorPurchasePrice(before, 900_000);
    expect('survivorPurchasePrice' in before).toBe(false);
    const withField = withSurvivorPurchasePrice(plan(), 900_000);
    withSurvivorPurchasePrice(withField, undefined);
    expect(withField.survivorPurchasePrice).toBe(900_000);
  });

  it('the mortgage payoff round-trips through the schema the same way', () => {
    // The card's MortgageFields writes payoffAfterYears into plan.financing;
    // what the schema hands back after a save/load must be the same statement
    // — present with its value when stated, ABSENT (not undefined) when not.
    const scenario = {
      name: 'x',
      events: [],
      housing: {
        ...plan(),
        financing: { type: 'mortgage' as const, downPct: 0.2, payoffAfterYears: 5 },
      },
    };
    const parsed = scenarioSchema.parse(scenario).housing!;
    expect(parsed.financing).toMatchObject({ type: 'mortgage', payoffAfterYears: 5 });
    const cleared = {
      name: 'x',
      events: [],
      housing: { ...plan(), financing: { type: 'mortgage' as const, downPct: 0.2 } },
    };
    const clearedFin = scenarioSchema.parse(cleared).housing!.financing as Record<string, unknown>;
    expect('payoffAfterYears' in clearedFin).toBe(false);
  });

  it('round-trips through the schema the store applies on save/load', () => {
    // Set, saved, loaded: the field survives with its value.
    const scenario = {
      name: 'x',
      events: [],
      housing: withSurvivorPurchasePrice(plan(), 'sale_proceeds'),
    };
    expect(scenarioSchema.parse(scenario).housing!.survivorPurchasePrice).toBe('sale_proceeds');
    // Cleared, saved, loaded: still absent — the shape this helper maintains
    // is exactly the shape the schema hands back, so draft and disk agree.
    const clearedScenario = {
      name: 'x',
      events: [],
      housing: withSurvivorPurchasePrice(scenario.housing, undefined),
    };
    const parsed = scenarioSchema.parse(clearedScenario).housing!;
    expect('survivorPurchasePrice' in parsed).toBe(false);
  });
});

describe('seedHousingPlan lifts the scheduled payoff from a hand-written event', () => {
  const home: Home = {
    value: 1_200_000,
    costBasis: 860_000,
    state: 'va',
    propertyTaxAnnual: 11_276,
    insuranceAnnual: 2_810,
    maintenancePctOfValue: 0.01,
    sellingCostPct: 0.06,
  };
  const events = (payoffAfterYears?: number): ScenarioEvent[] => [
    { type: 'sell_house', date: '2027-06' },
    {
      type: 'buy_house',
      date: '2028-06',
      price: 1_000_000,
      financing: {
        downPct: 0.2,
        rate: 0.06,
        termYears: 30,
        ...(payoffAfterYears !== undefined ? { payoffAfterYears } : {}),
      },
      propertyTaxAnnual: 7_500,
      insuranceAnnual: 2_200,
    },
  ];

  it('seeds a plan that schedules the same payoff — the button must not lengthen the loan', () => {
    const plan = seedHousingPlan(home, events(5), null);
    expect(plan.financing).toMatchObject({ type: 'mortgage', payoffAfterYears: 5 });
  });

  it('keeps the field absent when the event never stated one', () => {
    const plan = seedHousingPlan(home, events(), null);
    expect(plan.financing.type).toBe('mortgage');
    expect('payoffAfterYears' in plan.financing).toBe(false);
  });
});

describe('withSurvivorDownsize', () => {
  it('sets the price, the none spelling, and an explicit delay', () => {
    expect(withSurvivorDownsize(plan(), 1_450_000).survivorDownsizeTo).toBe(1_450_000);
    expect(withSurvivorDownsize(plan(), 'none').survivorDownsizeTo).toBe('none');
    const withDelay = withSurvivorDownsize(plan(), 1_450_000, 6);
    expect(withDelay.survivorDownsizeDelayMonths).toBe(6);
  });

  it('an absent delay stays ABSENT — blank means the engine default, not 0', () => {
    const noDelay = withSurvivorDownsize(plan(), 1_450_000);
    expect('survivorDownsizeDelayMonths' in noDelay).toBe(false);
  });

  it('clearing REMOVES both keys — a dangling delay is an inert field on disk', () => {
    const cleared = withSurvivorDownsize(withSurvivorDownsize(plan(), 1_450_000, 6), undefined);
    expect('survivorDownsizeTo' in cleared).toBe(false);
    expect('survivorDownsizeDelayMonths' in cleared).toBe(false);
  });

  it('never mutates the plan it was given — the draft is React state', () => {
    const before = plan();
    withSurvivorDownsize(before, 1_450_000, 6);
    expect('survivorDownsizeTo' in before).toBe(false);
    const withField = withSurvivorDownsize(plan(), 1_450_000, 6);
    withSurvivorDownsize(withField, undefined);
    expect(withField.survivorDownsizeTo).toBe(1_450_000);
    expect(withField.survivorDownsizeDelayMonths).toBe(6);
  });

  it('round-trips through the schema the store applies on save/load', () => {
    const scenario = {
      name: 'x',
      events: [],
      housing: withSurvivorDownsize(plan(), 'none', 3),
    };
    const parsed = scenarioSchema.parse(scenario).housing!;
    expect(parsed.survivorDownsizeTo).toBe('none');
    expect(parsed.survivorDownsizeDelayMonths).toBe(3);
    const clearedScenario = {
      name: 'x',
      events: [],
      housing: withSurvivorDownsize(scenario.housing, undefined),
    };
    const reparsed = scenarioSchema.parse(clearedScenario).housing!;
    expect('survivorDownsizeTo' in reparsed).toBe(false);
    expect('survivorDownsizeDelayMonths' in reparsed).toBe(false);
  });
});
