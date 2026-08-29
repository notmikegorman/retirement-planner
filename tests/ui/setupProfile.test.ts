/**
 * ZERO-START'S WRITER: the minimal profile the first-run setup step submits
 * (src/shared/setupProfile.ts), proven against the REAL profile schema — the
 * same parse api.putProfile runs — so the setup step can never build a shape
 * the store would refuse, and the empty-start invariants (no accounts, no
 * invented dollars, absent optionals keeping their absent meanings) are
 * pinned rather than hoped.
 */
import { describe, expect, it } from 'vitest';
import { profileSchema } from '../../src/shared/schemas';
import {
  DEFAULT_SEED,
  buildInitialProfile,
  validateSetupInput,
  type SetupInput,
} from '../../src/shared/setupProfile';

const one = (over: Partial<SetupInput> = {}): SetupInput => ({
  person1: { name: 'Riley', birthYear: 1980, birthMonth: 6 },
  person2: null,
  state: 'nc',
  year: 2026,
  ...over,
});

const two = (): SetupInput =>
  one({ person2: { name: 'Sam', birthYear: 1982, birthMonth: 11 } });

describe('buildInitialProfile', () => {
  it('builds a profile the real schema accepts, for one person and for two', () => {
    expect(() => profileSchema.parse(buildInitialProfile(one()))).not.toThrow();
    expect(() => profileSchema.parse(buildInitialProfile(two()))).not.toThrow();
  });

  it('starts genuinely empty: no accounts, no invented dollars anywhere', () => {
    const p = buildInitialProfile(two());
    expect(p.accounts).toEqual([]);
    expect(p.home.value).toBe(0);
    expect(p.home.mortgage).toBeNull();
    expect(p.income.salaries).toEqual({ p1: 0, p2: 0 });
    expect(p.income.contribution401k).toBe(0);
    expect(p.income.employerMatch401k).toBe(0);
    expect(p.expenses.livingMonthly).toBe(0);
    expect(p.expenses.charitableMonthly).toBe(0);
    expect(p.expenses.investingMonthly).toBe(0);
    expect(p.health.acaBenchmarkMonthly).toBe(0);
    for (const person of p.people) {
      expect(person.piaMonthlyAtFraIfWorkingTo62).toBe(0);
      expect(person.piaMonthlyAtFraIfStoppingNow).toBe(0);
    }
  });

  it('leaves every optional absent so each keeps its documented absent-meaning', () => {
    const p = buildInitialProfile(one());
    // lines absent = "the scalars are the truth"; an empty array would be a
    // budget that exists and derives zeros.
    expect('lines' in p.expenses).toBe(false);
    expect('lifeInsurancePolicies' in p.expenses).toBe(false);
    expect('lifeInsuranceMonthly' in p.expenses).toBe(false);
    expect('retirementGiving' in p.expenses).toBe(false); // absent = continue
    expect('untithedPot' in p.expenses).toBe(false); // absent = no pot
    expect('retirementMonthly' in p.income).toBe(false);
    expect('terminalFloorReal' in p.settings).toBe(false);
    for (const person of p.people) expect('notes' in person).toBe(false);
  });

  it('derives filing from the people: one files single, two file jointly', () => {
    expect(buildInitialProfile(one()).filing).toEqual({ status: 'single', state: 'nc' });
    expect(buildInitialProfile(two()).filing.status).toBe('mfj');
    expect(buildInitialProfile(one({ state: 'va' })).filing.state).toBe('va');
    // The home's state field follows the filing state — there is no separate
    // question to answer at setup.
    expect(buildInitialProfile(one({ state: 'sc' })).home.state).toBe('sc');
  });

  it('carries the typed people: ids p1/p2, trimmed names, integral birth fields', () => {
    const p = buildInitialProfile(
      one({
        person1: { name: '  Riley ', birthYear: 1980.4, birthMonth: 6 },
        person2: { name: 'Sam', birthYear: 1982, birthMonth: 11 },
      }),
    );
    expect(p.people.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(p.people[0].name).toBe('Riley');
    expect(p.people[0].birthYear).toBe(1980);
    expect(p.people[1].birthMonth).toBe(11);
    // hasOwnBenefit defaults true — with PIA 0 it claims nothing, and the
    // spousal-only configuration is the Household tab's deliberate statement.
    expect(p.people.every((x) => x.hasOwnBenefit)).toBe(true);
  });

  it('uses the documented settings defaults and the fixed reproducibility seed', () => {
    const s = buildInitialProfile(one()).settings;
    expect(s.horizonAge).toBe(95);
    expect(s.successTarget).toBe(0.85);
    expect(s.mcPathsInteractive).toBe(1000);
    expect(s.mcPathsFinal).toBe(10000);
    expect(s.seed).toBe(DEFAULT_SEED);
    expect(s.spendingPolicy).toEqual({ type: 'fixed_real' });
    expect(s.withdrawalPolicy).toEqual({
      order: ['cash', 'taxable', 'pretax', 'roth'],
      pretaxPreference: 'ira_first',
    });
  });

  it('clamps acaQuoteYear into the schema window whatever "today" is', () => {
    expect(buildInitialProfile(one({ year: 2026 })).health.acaQuoteYear).toBe(2026);
    expect(buildInitialProfile(one({ year: 1999 })).health.acaQuoteYear).toBe(2024);
    expect(buildInitialProfile(one({ year: 2150 })).health.acaQuoteYear).toBe(2100);
    expect(buildInitialProfile(one({ year: Number.NaN })).health.acaQuoteYear).toBe(2024);
  });

  it('is deterministic: same inputs, byte-identical profile', () => {
    expect(JSON.stringify(buildInitialProfile(two()))).toBe(
      JSON.stringify(buildInitialProfile(two())),
    );
  });
});

describe('validateSetupInput', () => {
  it('accepts a complete answer, for one person or two', () => {
    expect(validateSetupInput(one())).toEqual([]);
    expect(validateSetupInput(two())).toEqual([]);
  });

  it('names every missing fact instead of quoting a schema path', () => {
    const problems = validateSetupInput(
      one({ person1: { name: '  ', birthYear: 0, birthMonth: 0 } }),
    );
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('needs a name');
    expect(problems.join(' ')).toContain('birth year between 1900 and 2010');
    expect(problems.join(' ')).toContain('needs a birth month');
  });

  it('checks the second person only when there is one, under their own label', () => {
    const problems = validateSetupInput(
      one({ person2: { name: '', birthYear: 1982, birthMonth: 11 } }),
    );
    expect(problems).toEqual(['Person 2 needs a name.']);
    expect(validateSetupInput(one())).toEqual([]);
  });

  it('holds the schema’s own birth-year window', () => {
    expect(
      validateSetupInput(one({ person1: { name: 'R', birthYear: 1899, birthMonth: 1 } })),
    ).toHaveLength(1);
    expect(
      validateSetupInput(one({ person1: { name: 'R', birthYear: 2011, birthMonth: 1 } })),
    ).toHaveLength(1);
    expect(
      validateSetupInput(one({ person1: { name: 'R', birthYear: 1900, birthMonth: 1 } })),
    ).toEqual([]);
    expect(
      validateSetupInput(one({ person1: { name: 'R', birthYear: 2010, birthMonth: 12 } })),
    ).toEqual([]);
  });
});
