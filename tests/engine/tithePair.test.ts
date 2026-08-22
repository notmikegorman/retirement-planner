/**
 * The two-knob giving split (note 21, ENGINE 1.16.0): the un-tithed pot
 * (ProfileExpenses.untithedPot) paired with an ongoing method
 * (retirementGiving), replacing the bundled 'tithe_account' rule.
 *
 * THE HEART OF THIS FILE IS THE EQUIVALENCE REQUIREMENT: a scenario using the
 * OLD bundled rule and the same scenario using its migrated pair must produce
 * BIT-IDENTICAL results — the split moved the knobs, not what they do. That
 * is pinned as digest equalities across deterministic and Monte Carlo modes,
 * with the safe-zone release on and off and the seed on and off (the four
 * combinations that exercise every phase boundary). The rest of the file
 * covers what the split newly makes expressible: a pot beside ANY ongoing
 * method, and 'give_cash' during the hold.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSimulation } from '../../src/engine/simulate';
import { titheBundleToPair } from '../../src/shared/giving';
import type {
  AcaData,
  Account,
  Assumptions,
  FederalTaxData,
  MarketAssumptions,
  MedicareData,
  Person,
  Profile,
  RetirementGivingRule,
  RmdTableData,
  RunResult,
  Scenario,
  SimulationInput,
  SocialSecurityData,
  StateTaxData,
  UntithedPotSetting,
} from '../../src/shared/types';
import { loadHistoricalCsv } from '../../src/engine/returns';
import marketJson from '../../data-defaults/assumptions/market.json';
import federalJson from '../../data-defaults/assumptions/tax/federal-2026.json';
import vaJson from '../../data-defaults/assumptions/tax/va-2026.json';
import scJson from '../../data-defaults/assumptions/tax/sc-2026.json';
import ncJson from '../../data-defaults/assumptions/tax/nc-2026.json';
import ssJson from '../../data-defaults/assumptions/social-security.json';
import medicareJson from '../../data-defaults/assumptions/medicare-2026.json';
import acaJson from '../../data-defaults/assumptions/aca-2026.json';
import rmdJson from '../../data-defaults/assumptions/rmd-table.json';

const historical = loadHistoricalCsv(
  readFileSync(new URL('../../data-defaults/assumptions/historical-returns.csv', import.meta.url), 'utf8'),
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

function person(id: string, over?: Partial<Person>): Person {
  return {
    id,
    name: id.toUpperCase(),
    birthYear: 1971,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
    ...over,
  };
}

const IRA: Account = {
  id: 'ira',
  name: 'Traditional IRA',
  type: 'traditional_ira',
  owner: 'p1',
  balance: 1_000_000,
  lifetimeContributions: 400_000,
  allocation: { stocks: 0.5, bonds: 0.3, bills: 0.2 },
};

const ROTH: Account = {
  id: 'roth',
  name: 'Roth IRA',
  type: 'roth_ira',
  owner: 'p2',
  balance: 100_000,
  lifetimeContributions: 60_000,
  allocation: { stocks: 0.5, bonds: 0.3, bills: 0.2 },
};

/**
 * A fully-retired-from-2026 household with real spending, so paths genuinely
 * diverge under Monte Carlo and the pot's last-resort machinery has cash
 * flows to disturb — a no-spending fixture would make half the equivalence
 * vacuous. A mixed allocation keeps the high-water mark non-trivial: down
 * years happen on historical blocks.
 */
function household(over?: {
  retirementGiving?: RetirementGivingRule;
  untithedPot?: UntithedPotSetting;
  annualLiving?: number;
  horizonAge?: number;
}): Profile {
  const p: Profile = {
    people: [person('p1'), person('p2')],
    filing: { status: 'mfj', state: 'va' },
    accounts: [structuredClone(IRA), structuredClone(ROTH)],
    home: {
      value: 0,
      costBasis: 0,
      state: 'va',
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0.06,
    },
    income: { salaries: { p1: 0, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: {
      livingMonthly: (over?.annualLiving ?? 36_000) / 12,
      charitableMonthly: 0,
      investingMonthly: 0,
    },
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: 2026,
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: over?.horizonAge ?? 70, // 2026..2041
      successTarget: 0.9,
      mcPathsInteractive: 200,
      mcPathsFinal: 200,
      seed: 42,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: { order: ['cash', 'taxable', 'pretax', 'roth'], pretaxPreference: 'ira_first' },
    },
  };
  if (over?.retirementGiving !== undefined) p.expenses.retirementGiving = over.retirementGiving;
  if (over?.untithedPot !== undefined) p.expenses.untithedPot = over.untithedPot;
  return p;
}

function input(profile: Profile, over?: Partial<SimulationInput>): SimulationInput {
  return {
    profile,
    assumptions: assumptions(),
    scenario: { name: 'pair', events: [] },
    mode: 'deterministic',
    paths: 1,
    seed: 42,
    ...over,
  };
}

/**
 * Everything a run computes, minus the two fields that cannot be equal across
 * two invocations (meta carries hashes of the INPUT objects — which differ by
 * construction here — and elapsedMs is wall time). Key order is identical on
 * both sides because the same code built both results, so JSON.stringify is a
 * faithful bit-level comparison.
 */
function resultDigest(r: RunResult): string {
  const { meta: _meta, elapsedMs: _t, ...rest } = r;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/**
 * The bundled rule and its migrated pair, side by side. Spending is set HIGH
 * relative to the portfolio ($96k against $1.1M) so Monte Carlo paths
 * genuinely fail: the equivalence then covers the last-resort draw, the
 * break-glass figure and insolvency ordering, not just the happy path.
 */
function bundleAndPair(bundle: Extract<RetirementGivingRule, { type: 'tithe_account' }>): {
  legacy: Profile;
  pair: Profile;
} {
  const { ongoing, pot } = titheBundleToPair(bundle);
  return {
    legacy: household({ retirementGiving: bundle, annualLiving: 96_000 }),
    pair: household({ retirementGiving: ongoing, untithedPot: pot, annualLiving: 96_000 }),
  };
}

describe('EQUIVALENCE: the old bundled rule and its migrated pair are bit-identical', () => {
  const combos: Array<{ label: string; seed: boolean; release: boolean }> = [
    { label: 'seed on, early release on (the user default)', seed: true, release: true },
    { label: 'seed on, early release off', seed: true, release: false },
    { label: 'seed off, early release on', seed: false, release: true },
    { label: 'seed off, early release off', seed: false, release: false },
  ];

  for (const combo of combos) {
    const bundle: Extract<RetirementGivingRule, { type: 'tithe_account' }> = {
      type: 'tithe_account',
      percent: 0.1,
      deferYears: 4,
      seedFromExistingGains: combo.seed,
      // earlyRelease absent means true; write only the opt-out, exactly as a
      // stored file would.
      ...(combo.release ? {} : { earlyRelease: false }),
    };

    it(`deterministic — ${combo.label}`, () => {
      const { legacy, pair } = bundleAndPair(bundle);
      const a = runSimulation(input(legacy));
      const b = runSimulation(input(pair));
      // The runs genuinely exercised the pot (an account exists whenever the
      // seed or an accruing hold can fill one), so the equality is not two
      // empty feature paths agreeing about nothing.
      expect(a.referencePath.some((r) => r.tithe !== undefined)).toBe(true);
      expect(resultDigest(a)).toBe(resultDigest(b));
    });

    it(`monte carlo — ${combo.label}`, () => {
      const { legacy, pair } = bundleAndPair(bundle);
      const a = runSimulation(input(legacy, { mode: 'montecarlo', paths: 200 }));
      const b = runSimulation(input(pair, { mode: 'montecarlo', paths: 200 }));
      expect(a.success).toBeLessThan(1); // paths diverge: the comparison has teeth
      expect(resultDigest(a)).toBe(resultDigest(b));
    });
  }

  it('a bundled rule arriving as a SCENARIO OVERRIDE normalises the same way', () => {
    // Old saved scenarios and search axis levels hand the engine a bundle in
    // assumption_overrides.expenses; it must mean exactly what the pair means
    // — and its pot half must supersede the profile's own pot, because under
    // the old model an override replaced the whole rule.
    const bundle: Extract<RetirementGivingRule, { type: 'tithe_account' }> = {
      type: 'tithe_account',
      percent: 0.08,
      deferYears: 2,
      seedFromExistingGains: true,
    };
    const { ongoing, pot } = titheBundleToPair(bundle);
    const profileWithOtherPot = household({
      retirementGiving: { type: 'percent_of_income', percent: 0.05 },
      untithedPot: { percent: 0.2, holdYears: 9, earlyRelease: false },
    });
    const viaBundle = runSimulation(
      input(profileWithOtherPot, {
        scenario: {
          name: 'bundle-override',
          events: [],
          assumption_overrides: { expenses: { retirementGiving: bundle } },
        },
      }),
    );
    const viaPair = runSimulation(
      input(profileWithOtherPot, {
        scenario: {
          name: 'bundle-override',
          events: [],
          assumption_overrides: { expenses: { retirementGiving: ongoing, untithedPot: pot } },
        },
      }),
    );
    expect(resultDigest(viaBundle)).toBe(resultDigest(viaPair));
    // And it really did switch pots: an 8% seed, not the profile's 20%.
    const seedRow = viaBundle.referencePath.find((r) => (r.tithe?.seeded ?? 0) > 0)!;
    expect(seedRow.tithe!.seeded).toBeCloseTo(0.08 * 640_000, 6);
  });

  it("an explicit override pot outranks the pot half of an override bundle", () => {
    // The precedence resolveGivingPair documents: a bundle override is the
    // OLD spelling, an explicit pot override the newer, more deliberate one —
    // written, e.g., by the new Tithing tab onto a saved scenario that still
    // carries a legacy bundle. If the bundle's pot half won instead, the
    // explicit disable below would be ignored and an 8% pot would seed anyway.
    const bundle: Extract<RetirementGivingRule, { type: 'tithe_account' }> = {
      type: 'tithe_account',
      percent: 0.08,
      deferYears: 2,
      seedFromExistingGains: true,
    };
    const profile = () =>
      household({
        retirementGiving: { type: 'percent_of_income', percent: 0.05 },
        untithedPot: { percent: 0.2, holdYears: 9, earlyRelease: false },
      });
    const disabled = runSimulation(
      input(profile(), {
        scenario: {
          name: 'bundle+disable',
          events: [],
          assumption_overrides: {
            expenses: { retirementGiving: bundle, untithedPot: { enabled: false } },
          },
        },
      }),
    );
    // The explicit disable wins over BOTH the bundle's pot half and the
    // profile's pot: no pot anywhere in the run.
    expect(disabled.referencePath.every((r) => r.tithe === undefined)).toBe(true);
    expect(resultDigest(disabled)).toBe(
      resultDigest(
        runSimulation(
          input(profile(), {
            scenario: {
              name: 'bundle+disable',
              events: [],
              assumption_overrides: {
                expenses: {
                  retirementGiving: { type: 'percent_of_growth', percent: 0.08 },
                  untithedPot: { enabled: false },
                },
              },
            },
          }),
        ),
      ),
    );
    // And an explicit ENABLED pot wins the same way: the seed takes the
    // explicit pot's 20%, not the bundle's 8%.
    const enabled = runSimulation(
      input(profile(), {
        scenario: {
          name: 'bundle+explicit-pot',
          events: [],
          assumption_overrides: {
            expenses: {
              retirementGiving: bundle,
              untithedPot: { percent: 0.2, holdYears: 0, seedFromGains: true },
            },
          },
        },
      }),
    );
    const seedRow = enabled.referencePath.find((r) => (r.tithe?.seeded ?? 0) > 0)!;
    expect(seedRow.tithe!.seeded).toBeCloseTo(0.2 * 640_000, 6);
  });

  it('the pot defaults mean what the schema says they mean', () => {
    // percent absent = 0.10; ongoingDuringHold absent = accrue_to_pot;
    // seedFromGains absent = true. Digest equalities, so a default drifting
    // away from its documentation fails loudly.
    const explicit = household({
      retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
      untithedPot: {
        percent: 0.1,
        holdYears: 4,
        seedFromGains: true,
        ongoingDuringHold: 'accrue_to_pot',
      },
    });
    const defaulted = household({
      retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
      untithedPot: { holdYears: 4 },
    });
    expect(resultDigest(runSimulation(input(explicit)))).toBe(
      resultDigest(runSimulation(input(defaulted))),
    );
  });
});

describe('the owner-plan trap: an old override must keep meaning "no pot"', () => {
  // The profile the trap bites on: a pot the household configured...
  const profileWithPot = () =>
    household({
      retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
      untithedPot: { holdYears: 11 },
    });

  it('an override with the EXPLICIT disable suppresses the profile pot', () => {
    // ...and the migrated form of the user's old experiment: a non-tithe
    // rule plus the explicit disable the migration writes in.
    const result = runSimulation(
      input(profileWithPot(), {
        scenario: {
          name: 'no-pot',
          events: [],
          assumption_overrides: {
            expenses: {
              retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
              untithedPot: { enabled: false },
            },
          },
        },
      }),
    );
    expect(result.referencePath.every((r) => r.tithe === undefined)).toBe(true);
    expect(result.referencePath.every((r) => r.balances.tithe === 0)).toBe(true);
    expect(result.charitableLegacy.terminalTitheReal).toBe(0);
    // No pot also means the PLAIN growth base — bit-identical to a household
    // that never had a pot at all, which is what the old override meant.
    const never = runSimulation(
      input(household({ retirementGiving: { type: 'percent_of_growth', percent: 0.1 } })),
    );
    expect(resultDigest(result)).toBe(resultDigest(never));
  });

  it('an override WITHOUT the disable inherits the pot — the resurrection the migration exists to prevent', () => {
    // The same override minus the explicit disable: under the new inherit
    // semantics the profile pot comes back. This is the hazard, demonstrated
    // — dataStore's one-time pass writes the disable into every pre-split
    // override precisely so stored files never hit this branch.
    const result = runSimulation(
      input(profileWithPot(), {
        scenario: {
          name: 'inherit',
          events: [],
          assumption_overrides: {
            expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } },
          },
        },
      }),
    );
    expect(result.referencePath.some((r) => r.tithe !== undefined)).toBe(true);
  });

  it('a pot-only override reaches a run whose ongoing method it does not touch', () => {
    // The other half of "override each half independently": untithedPot alone
    // changes the pot and inherits the profile's ongoing method.
    const result = runSimulation(
      input(profileWithPot(), {
        scenario: {
          name: 'pot-only',
          events: [],
          assumption_overrides: {
            expenses: { untithedPot: { holdYears: 0, distributeYears: 3 } },
          },
        },
      }),
    );
    // holdYears 0: locked on retirement day — the first row already carries a
    // locked pot distributing over 3 years.
    const first = result.referencePath[0];
    expect(first.tithe?.locked).toBe(true);
    expect(first.tithe?.distributed).toBeGreaterThan(0);
  });
});

describe('independence: the pot composes with any ongoing method', () => {
  it("'none' + pot: the pot alone seeds, holds, distributes, and leaves the remainder to charity", () => {
    const result = runSimulation(
      input(
        household({
          retirementGiving: { type: 'none' },
          untithedPot: { holdYears: 3, earlyRelease: false, distributeYears: 30 },
        }),
      ),
    );
    const rows = result.referencePath;
    // Seeded on retirement day (2026): 10% of 640,000 untithed gains.
    expect(rows[0].tithe?.seeded).toBeCloseTo(64_000, 6);
    // The hold: soft, nothing given, nothing accrued (there is no growth
    // tithe to accrue — the ongoing method is 'none').
    for (const r of rows.slice(0, 3)) {
      expect(r.tithe?.locked).toBe(false);
      expect(r.tithe?.accrued).toBe(0);
      expect(r.expenses.charitable).toBe(0);
    }
    // Locked when the hold elapses; the pot pays out on its schedule, and the
    // instalments are the ONLY giving the run has.
    const lockRow = rows[3];
    expect(lockRow.tithe?.locked).toBe(true);
    expect(lockRow.tithe?.distributed).toBeGreaterThan(0);
    for (const r of rows.slice(3)) {
      expect(r.expenses.charitable).toBeCloseTo(
        (r.tithe?.distributed ?? 0) + (r.tithe?.forcedDistributionGiven ?? 0),
        8,
      );
      expect(r.tithe?.given).toBe(0); // the ongoing method never speaks
    }
    // A 30-year payout against a 16-year horizon: the remainder reaches
    // charity at death rather than evaporating.
    expect(result.charitableLegacy.terminalTitheReal).toBeGreaterThan(0);
    expect(result.charitableLegacy.totalReal).toBeCloseTo(
      result.charitableLegacy.cashGivenReal + result.charitableLegacy.terminalTitheReal,
      8,
    );
  });

  it("'amount' + pot: the amount pays cash from retirement day while the pot holds and then distributes", () => {
    const monthly = 500;
    const result = runSimulation(
      input(
        household({
          retirementGiving: { type: 'amount', monthly },
          untithedPot: { holdYears: 3, earlyRelease: false },
        }),
      ),
    );
    const rows = result.referencePath;
    // During the hold the amount rule pays exactly its own figure — the hold
    // defers the POT, and an amount has nothing growth-shaped to accrue.
    for (const r of rows.slice(0, 3)) {
      expect(r.expenses.charitable).toBeCloseTo(monthly * 12 * r.inflationIndex, 6);
      expect(r.tithe?.accrued).toBe(0);
    }
    // After the lock both streams pay: the amount plus the pot instalment.
    const locked = rows[3];
    expect(locked.tithe?.distributed).toBeGreaterThan(0);
    expect(locked.expenses.charitable).toBeCloseTo(
      monthly * 12 * locked.inflationIndex + locked.tithe!.distributed,
      6,
    );
  });

  it("'percent_of_income' + pot: never tithe the tithe — the pot's own flows are outside the income base", () => {
    /*
     * The income rule's base is what the household DREW FOR ITSELF: Social
     * Security plus gross withdrawals, MINUS the pot's own cash (the
     * distribution instalment is never added; the carve-out's forced RMD is
     * backed out). If the pot's flows leaked in, the household would pay a
     * tithe ON the pot's gifts. The base is reconstructable from each row —
     * withdrawals.pretax already includes RMDs, 72(t) payments and the
     * instalment, so the pot flows come back off — which lets every year's
     * income-rule cash be checked against the prior year's actual base.
     */
    const result = runSimulation(
      input(
        household({
          retirementGiving: { type: 'percent_of_income', percent: 0.1 },
          untithedPot: { holdYears: 2, earlyRelease: false },
        }),
      ),
    );
    const rows = result.referencePath;
    expect(rows.some((r) => (r.tithe?.distributed ?? 0) > 0)).toBe(true);
    const incomeBase = (r: (typeof rows)[number]): number =>
      r.income.socialSecurity +
      r.withdrawals.cash +
      r.withdrawals.taxable +
      r.withdrawals.roth +
      (r.withdrawals.pretax - (r.tithe?.distributed ?? 0)) -
      (r.tithe?.forcedDistributionGiven ?? 0);
    for (let i = 1; i < rows.length; i++) {
      const ruleCash =
        rows[i].expenses.charitable -
        (rows[i].tithe?.distributed ?? 0) -
        (rows[i].tithe?.forcedDistributionGiven ?? 0);
      expect(ruleCash).toBeCloseTo(0.1 * incomeBase(rows[i - 1]), 6);
    }
    // And the two streams genuinely compose: years exist where BOTH the
    // income rule and the pot pay.
    const both = rows.filter(
      (r) =>
        (r.tithe?.distributed ?? 0) > 0 &&
        r.expenses.charitable >
          (r.tithe?.distributed ?? 0) + (r.tithe?.forcedDistributionGiven ?? 0) + 1e-6,
    );
    expect(both.length).toBeGreaterThan(0);
  });
});

describe('the two percents are genuinely independent knobs', () => {
  it("with the seed off, the pot's own percent has no other lever — the accrual belongs to the ongoing stream", () => {
    // The split's whole point: pot.percent sizes the SEED and nothing else,
    // while the accrual (and the trailing stream) run on the ongoing method's
    // percent. A migrated bundle writes the same number into both, so the
    // equivalence digests alone could never catch an engine that accrued
    // pot.percent instead — a household setting pot 15% / ongoing 10% would
    // silently accrue half again too much every held year.
    const build = (potPercent: number, ongoingPercent: number) =>
      household({
        retirementGiving: { type: 'percent_of_growth', percent: ongoingPercent },
        untithedPot: {
          percent: potPercent,
          holdYears: 4,
          earlyRelease: false,
          seedFromGains: false,
        },
      });
    const low = runSimulation(input(build(0.05, 0.1)));
    // The comparison has teeth only if the hold genuinely accrued something.
    expect(low.referencePath.some((r) => (r.tithe?.accrued ?? 0) > 0)).toBe(true);
    // Seedless: pot.percent is inert, so tripling it changes nothing at all.
    expect(resultDigest(runSimulation(input(build(0.15, 0.1))))).toBe(resultDigest(low));
    // The ongoing percent is the live knob: doubling it moves the run.
    expect(resultDigest(runSimulation(input(build(0.05, 0.2))))).not.toBe(resultDigest(low));
  });
});

describe("ongoingDuringHold: 'give_cash' against the bundled 'accrue_to_pot'", () => {
  const build = (mode: 'accrue_to_pot' | 'give_cash') =>
    household({
      retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
      untithedPot: {
        holdYears: 5,
        earlyRelease: false,
        ongoingDuringHold: mode,
      },
    });

  it('give_cash pays the growth tithe in cash from retirement day and never accrues', () => {
    const result = runSimulation(input(build('give_cash')));
    const rows = result.referencePath;
    // No transfer ever: the pot is the seed compounding, nothing more.
    expect(rows.every((r) => (r.tithe?.accrued ?? 0) === 0)).toBe(true);
    // Cash flows DURING the hold (from the second retired year — the first
    // has no completed year under the mark to read).
    const holdRows = rows.slice(1, 5);
    expect(holdRows.some((r) => (r.tithe?.given ?? 0) > 0)).toBe(true);
    for (const r of holdRows) expect(r.tithe?.locked).toBe(false);
    // The gift IS the stream's prescription: charitable = given during the
    // hold (no instalments yet).
    for (const r of rows.slice(0, 5)) {
      expect(r.expenses.charitable).toBeCloseTo(r.tithe?.given ?? 0, 8);
    }
  });

  it('accrue_to_pot is the bundled behaviour: silent hold, transfers in, cash after the lock', () => {
    const result = runSimulation(input(build('accrue_to_pot')));
    const rows = result.referencePath;
    // The hold gives nothing in cash and moves the tithe into the pot.
    for (const r of rows.slice(0, 5)) {
      expect(r.expenses.charitable).toBe(0);
      expect(r.tithe?.locked).toBe(false);
    }
    expect(rows.slice(0, 5).some((r) => (r.tithe?.accrued ?? 0) > 0)).toBe(true);
    // Both modes accounted for every dollar of the same growth exactly once:
    // accrue moves base[R..lock-1] into the pot and pays cash on base[lock..];
    // give_cash pays cash on every base. So (cash given by the stream +
    // dollars accrued) agree in TODAY's-dollar terms year by year is not a
    // simple identity (accrual is nominal at year end, cash re-inflates a
    // year later) — but both must have consumed the identical base series,
    // which the give_cash run's first cash year proves: it pays on base[R],
    // the exact base the accrue run transferred at the end of year R.
    const giveCash = runSimulation(input(build('give_cash'))).referencePath;
    // accrue's first transfer (end of retired year 1, nominal)…
    const firstAccrued = rows[0].tithe!.accrued;
    // …and give_cash's first cheque (retired year 2, re-inflated by that
    // year's CPI): same base, one year of CPI apart.
    const firstCash = giveCash[1].tithe!.given;
    const cpi = giveCash[1].inflationIndex / giveCash[0].inflationIndex;
    expect(firstCash).toBeCloseTo(firstAccrued * cpi, 6);
  });

  it('give_cash with the seed off never opens an account at all — nothing could ever enter it', () => {
    const result = runSimulation(
      input(
        household({
          retirementGiving: { type: 'percent_of_growth', percent: 0.1 },
          untithedPot: {
            holdYears: 5,
            earlyRelease: false,
            ongoingDuringHold: 'give_cash',
            seedFromGains: false,
          },
        }),
      ),
    );
    const rows = result.referencePath;
    expect(rows.every((r) => r.tithe === undefined)).toBe(true);
    expect(rows.every((r) => r.balances.tithe === 0)).toBe(true);
    // The cash stream still runs on the high-water-mark base.
    expect(rows.some((r) => r.expenses.charitable > 0)).toBe(true);
  });
});
