/**
 * Unit tests for the pure helpers behind DashboardPage and ProfilePage
 * (src/ui/components/profile/profileLogic.ts). All expected values are
 * hand-computed; the arithmetic is spelled out in comments.
 */
import { describe, expect, it } from 'vitest';
import type { Profile, WithdrawalBucket } from '../src/shared/types';
import {
  DEFAULT_TDF_TARGET_YEAR,
  JOINT_OWNER,
  PRETAX_PREFERENCE_LABELS,
  accountDisplayName,
  accountNameById,
  accountTypeLabel,
  addConversion,
  ageAt,
  allocationOk,
  allocationSum,
  annualFromMonthly,
  canBeTargetDateFund,
  canOwnJointly,
  emptyRothBasis,
  formatBirth,
  isPlaceholder,
  makeDefaultMortgage,
  makeNewAccount,
  moveItem,
  netWorth,
  normalizeAccountForType,
  normalizeOwnerForType,
  normalizeSpendingPolicy,
  ownerLabel,
  ownerOptions,
  parseNumberInput,
  pctDisplayValue,
  personName,
  removeConversion,
  rothBasisTotal,
  setTargetDateFund,
  spendingPolicySummary,
  uniqueAccountId,
  updateConversion,
  withdrawalPolicySummary,
} from '../src/ui/components/profile/profileLogic';

/** Fixture mirroring the starter profile (data-defaults/profile.starter.json). */
function makeProfile(): Profile {
  return {
    people: [
      {
        id: 'p1',
        name: 'Person 1',
        birthYear: 1971,
        birthMonth: 6,
        piaMonthlyAtFraIfWorkingTo62: 2900,
        piaMonthlyAtFraIfStoppingNow: 2600,
        hasOwnBenefit: true,
        notes: 'PLACEHOLDER pia',
      },
      {
        id: 'p2',
        name: 'Person 2',
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
        id: 'k401',
        name: '401(k) — current employer',
        type: '401k',
        owner: 'p1',
        balance: 850000,
        allocation: { stocks: 0.68, bonds: 0.32, bills: 0 },
        currentEmployer: true,
        targetDateFund: { targetYear: 2035 },
      },
      {
        id: 'ira1',
        name: 'Traditional IRA',
        type: 'traditional_ira',
        owner: 'p1',
        balance: 250000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'roth1',
        name: 'Roth IRA (person 1)',
        type: 'roth_ira',
        owner: 'p1',
        balance: 120000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
        rothBasis: { contributions: 60000, conversions: [] },
      },
      {
        id: 'roth2',
        name: 'Roth IRA (person 2)',
        type: 'roth_ira',
        owner: 'p2',
        balance: 30000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
        rothBasis: { contributions: 20000, conversions: [] },
      },
      {
        id: 'brokerage',
        name: 'Taxable brokerage',
        type: 'taxable_brokerage',
        owner: 'joint',
        balance: 70000,
        costBasis: 45000,
        allocation: { stocks: 1, bonds: 0, bills: 0 },
      },
      {
        id: 'savings',
        name: 'Savings',
        type: 'savings',
        owner: 'joint',
        balance: 35000,
        allocation: { stocks: 0, bonds: 0, bills: 1 },
      },
    ],
    home: {
      value: 550000,
      costBasis: 350000,
      state: 'va',
      propertyTaxAnnual: 4400,
      insuranceAnnual: 1800,
      maintenancePctOfValue: 0.01,
      sellingCostPct: 0.06,
      mortgage: null,
    },
    income: { salaries: { p1: 150000, p2: 0 }, contribution401k: 24000, employerMatch401k: 6000 },
    expenses: { livingMonthly: 6000, charitableMonthly: 0, investingMonthly: 0 },
    health: {
      acaBenchmarkMonthly: 1572,
      acaQuoteYear: 2026,
      partDPlanMonthly: 45,
      employerPremiumShareMonthly: 200,
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

describe('netWorth', () => {
  it('sums account balances plus home value with no mortgage', () => {
    // Accounts: 850,000 + 250,000 + 120,000 + 30,000 + 70,000 + 35,000 = 1,355,000
    // + home 550,000 - mortgage 0 = 1,905,000
    expect(netWorth(makeProfile())).toBe(1905000);
  });

  it('subtracts the mortgage balance when present', () => {
    const p = makeProfile();
    p.home.mortgage = {
      originalPrincipal: 300000,
      balance: 200000,
      rate: 0.05,
      termYears: 30,
      startYear: 2020,
      startMonth: 1,
    };
    // 1,355,000 + 550,000 - 200,000 = 1,705,000
    expect(netWorth(p)).toBe(1705000);
  });
});

describe('ageAt', () => {
  it('is full years attained: born June 1971, as of Aug 2026 -> 55', () => {
    // 2026 - 1971 = 55; month 8 >= birth month 6, so no subtraction.
    expect(ageAt(2026, 8, 1971, 6)).toBe(55);
  });

  it('subtracts one before the birthday month: as of May 2026 -> 54', () => {
    // 2026 - 1971 = 55; month 5 < 6, so 55 - 1 = 54.
    expect(ageAt(2026, 5, 1971, 6)).toBe(54);
  });

  it('counts the birthday month itself: as of June 2026 -> 55', () => {
    expect(ageAt(2026, 6, 1971, 6)).toBe(55);
  });
});

describe('labels', () => {
  it('formats birth as "June 1971"', () => {
    expect(formatBirth(1971, 6)).toBe('June 1971');
    expect(formatBirth(1971, 12)).toBe('December 1971');
  });

  it('labels account types', () => {
    expect(accountTypeLabel('401k')).toBe('401(k)');
    expect(accountTypeLabel('traditional_ira')).toBe('Traditional IRA');
    expect(accountTypeLabel('roth_ira')).toBe('Roth IRA');
    expect(accountTypeLabel('taxable_brokerage')).toBe('Taxable brokerage');
    expect(accountTypeLabel('savings')).toBe('Savings');
  });

  it('resolves owner names, falling back to the id', () => {
    const p = makeProfile();
    expect(personName(p, 'p2')).toBe('Person 2');
    expect(personName(p, 'nobody')).toBe('nobody');
  });

  it('offers exactly two pre-tax preferences (rule_of_55_first is gone)', () => {
    // The 401(k) is rolled into the IRA at separation, so a rule-of-55
    // preference has nothing to prefer — the contract dropped the option.
    expect(Object.keys(PRETAX_PREFERENCE_LABELS).sort()).toEqual(['ira_first', 'proportional']);
  });
});

describe('placeholder marker', () => {
  it('detects PLACEHOLDER in notes', () => {
    expect(isPlaceholder('PLACEHOLDER balance.')).toBe(true);
    expect(isPlaceholder('all real data')).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });
});

describe('account display names (note 6)', () => {
  it('uses the name, falling back to the id when blank', () => {
    expect(accountDisplayName({ id: 'k401', name: "Alex's 401(k)" })).toBe("Alex's 401(k)");
    expect(accountDisplayName({ id: 'k401', name: '' })).toBe('k401');
    expect(accountDisplayName({ id: 'k401', name: '   ' })).toBe('k401');
  });

  it('resolves a name by id, falling back to the id for unknown accounts', () => {
    const accounts = makeProfile().accounts;
    expect(accountNameById(accounts, 'ira1')).toBe('Traditional IRA');
    expect(accountNameById(accounts, 'nope')).toBe('nope');
  });
});

describe('joint ownership (note 10)', () => {
  it('allows joint only on taxable brokerage and savings', () => {
    expect(canOwnJointly('taxable_brokerage')).toBe(true);
    expect(canOwnJointly('savings')).toBe(true);
    expect(canOwnJointly('401k')).toBe(false);
    expect(canOwnJointly('traditional_ira')).toBe(false);
    expect(canOwnJointly('roth_ira')).toBe(false);
  });

  it('adds a Joint option to the user select only where it is legal', () => {
    const people = makeProfile().people;
    expect(ownerOptions(people, 'savings')).toEqual([
      { value: 'p1', label: 'Person 1' },
      { value: 'p2', label: 'Person 2' },
      { value: JOINT_OWNER, label: 'Joint' },
    ]);
    expect(ownerOptions(people, 'roth_ira')).toEqual([
      { value: 'p1', label: 'Person 1' },
      { value: 'p2', label: 'Person 2' },
    ]);
  });

  it('labels the user column, rendering the literal "joint" as "Joint"', () => {
    const p = makeProfile();
    expect(ownerLabel(p, 'joint')).toBe('Joint');
    expect(ownerLabel(p, 'p1')).toBe('Person 1');
  });

  it('repairs an illegal joint owner when the type changes', () => {
    expect(normalizeOwnerForType('joint', 'traditional_ira', 'p1')).toBe('p1');
    // Still legal -> untouched.
    expect(normalizeOwnerForType('joint', 'savings', 'p1')).toBe('joint');
    // Person-owned accounts are never rewritten.
    expect(normalizeOwnerForType('p2', 'traditional_ira', 'p1')).toBe('p2');
  });
});

describe('target-date funds (note 8)', () => {
  it('is offered on every investment type but savings', () => {
    expect(canBeTargetDateFund('401k')).toBe(true);
    expect(canBeTargetDateFund('traditional_ira')).toBe(true);
    expect(canBeTargetDateFund('taxable_brokerage')).toBe(true);
    expect(canBeTargetDateFund('savings')).toBe(false);
  });

  it('ticking the box seeds the default target year; unticking clears it', () => {
    const ira = makeProfile().accounts.find((a) => a.id === 'ira1')!;
    const on = setTargetDateFund(ira, true);
    expect(on.targetDateFund).toEqual({ targetYear: DEFAULT_TDF_TARGET_YEAR });
    expect(DEFAULT_TDF_TARGET_YEAR).toBe(2035);
    const off = setTargetDateFund(on, false);
    expect(off.targetDateFund).toBeUndefined();
    expect(ira.targetDateFund).toBeUndefined(); // input untouched
  });

  it('keeps an existing target year and refuses to mark savings', () => {
    const k401 = makeProfile().accounts.find((a) => a.id === 'k401')!;
    expect(setTargetDateFund(k401, true).targetDateFund).toEqual({ targetYear: 2035 });
    const savings = makeProfile().accounts.find((a) => a.id === 'savings')!;
    expect(setTargetDateFund(savings, true).targetDateFund).toBeUndefined();
  });
});

describe('Roth funding editor (note 9)', () => {
  it('starts empty', () => {
    expect(emptyRothBasis()).toEqual({ contributions: 0, conversions: [] });
  });

  it('adds, patches and removes conversion buckets without mutating the input', () => {
    const start = { contributions: 60_000, conversions: [] };
    const one = addConversion(start, 2014, 50_000);
    expect(one).toEqual({ contributions: 60_000, conversions: [{ year: 2014, amount: 50_000 }] });
    expect(start.conversions).toEqual([]); // untouched

    const two = addConversion(one, 2019, 25_000);
    const patched = updateConversion(two, 1, { amount: 30_000 });
    expect(patched.conversions).toEqual([
      { year: 2014, amount: 50_000 },
      { year: 2019, amount: 30_000 },
    ]);

    expect(removeConversion(patched, 0).conversions).toEqual([{ year: 2019, amount: 30_000 }]);
    // Out-of-range operations are no-op copies.
    expect(updateConversion(patched, 9, { amount: 1 })).toEqual(patched);
    expect(removeConversion(patched, 9)).toEqual(patched);
  });

  it('defaults a missing basis and sums the total basis', () => {
    expect(addConversion(undefined, 2014, 50_000)).toEqual({
      contributions: 0,
      conversions: [{ year: 2014, amount: 50_000 }],
    });
    // 60,000 direct + 50,000 + 25,000 converted = 135,000
    const basis = addConversion(addConversion({ contributions: 60_000, conversions: [] }, 2014, 50_000), 2019, 25_000);
    expect(rothBasisTotal(basis)).toBe(135_000);
    expect(rothBasisTotal(undefined)).toBe(0);
  });
});

describe('monthly expense streams (note 12)', () => {
  it('shows the x12 annual equivalent', () => {
    // 6,000/mo x 12 = 72,000/yr (the old single annualBaseline number).
    expect(annualFromMonthly(6_000)).toBe(72_000);
    // 250/mo x 12 = 3,000/yr
    expect(annualFromMonthly(250)).toBe(3_000);
    expect(annualFromMonthly(0)).toBe(0);
  });
});

describe('parseNumberInput', () => {
  it('parses plain and formatted numbers', () => {
    expect(parseNumberInput('85')).toBe(85);
    expect(parseNumberInput(' $1,234,567 ')).toBe(1234567);
    expect(parseNumberInput('6.5')).toBe(6.5);
    expect(parseNumberInput('12%')).toBe(12);
    expect(parseNumberInput('-2000')).toBe(-2000);
  });

  it('returns null for empty or unparseable input', () => {
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('   ')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1.2.3')).toBeNull();
  });
});

describe('pctDisplayValue', () => {
  it('scrubs float noise from rate*100', () => {
    // 0.85 * 100 = 85.00000000000001 in IEEE 754; display must be exactly 85.
    expect(pctDisplayValue(0.85)).toBe(85);
    // 0.065 * 100 = 6.500000000000001 -> 6.5
    expect(pctDisplayValue(0.065)).toBe(6.5);
    expect(pctDisplayValue(0.01)).toBe(1);
    expect(pctDisplayValue(0.04)).toBe(4);
    expect(pctDisplayValue(0)).toBe(0);
  });
});

describe('allocation sum', () => {
  it('accepts weights summing to 1 within 1e-6', () => {
    expect(allocationSum({ stocks: 1, bonds: 0, bills: 0 })).toBe(1);
    expect(allocationOk({ stocks: 1, bonds: 0, bills: 0 })).toBe(true);
    // A 2035 target-date fund's current mix: 0.68 + 0.32 + 0 = 1
    expect(allocationOk({ stocks: 0.68, bonds: 0.32, bills: 0 })).toBe(true);
    // 0.6 + 0.3 + 0.1 = 0.9999999999999999 in floats -> still ok within 1e-6
    expect(allocationOk({ stocks: 0.6, bonds: 0.3, bills: 0.1 })).toBe(true);
  });

  it('rejects weights that are off', () => {
    // 0.6 + 0.3 + 0 = 0.9 -> |0.9 - 1| = 0.1 > 1e-6
    expect(allocationOk({ stocks: 0.6, bonds: 0.3, bills: 0 })).toBe(false);
    expect(allocationOk({ stocks: 0.7, bonds: 0.4, bills: 0 })).toBe(false); // sum 1.1
  });
});

describe('moveItem (withdrawal-order up/down)', () => {
  const order: WithdrawalBucket[] = ['cash', 'taxable', 'pretax', 'roth'];

  it('moves an item up one slot', () => {
    // index 1 up: swap positions 1 and 0.
    expect(moveItem(order, 1, -1)).toEqual(['taxable', 'cash', 'pretax', 'roth']);
  });

  it('moves an item down one slot', () => {
    // index 2 down: swap positions 2 and 3.
    expect(moveItem(order, 2, 1)).toEqual(['cash', 'taxable', 'roth', 'pretax']);
  });

  it('is a no-op copy at the edges and does not mutate the input', () => {
    expect(moveItem(order, 0, -1)).toEqual(order);
    expect(moveItem(order, 3, 1)).toEqual(order);
    const copy = moveItem(order, 0, -1);
    expect(copy).not.toBe(order);
    expect(order).toEqual(['cash', 'taxable', 'pretax', 'roth']); // untouched
  });
});

describe('account creation + type normalization', () => {
  it('generates unique account ids', () => {
    expect(uniqueAccountId([])).toBe('account-1');
    const p = makeProfile();
    p.accounts.push({ ...p.accounts[0], id: 'account-1' });
    expect(uniqueAccountId(p.accounts)).toBe('account-2');
  });

  it('makeNewAccount defaults to a named taxable brokerage owned by person 1', () => {
    const acct = makeNewAccount(makeProfile());
    expect(acct.id).toBe('account-1');
    expect(acct.name).toBe('New account');
    expect(acct.type).toBe('taxable_brokerage');
    expect(acct.owner).toBe('p1');
    expect(acct.balance).toBe(0);
    expect(acct.costBasis).toBe(0);
    expect(acct.allocation).toEqual({ stocks: 1, bonds: 0, bills: 0 });
  });

  it('taxable -> roth swaps costBasis for a fresh rothBasis and repairs joint ownership', () => {
    const brokerage = makeProfile().accounts.find((a) => a.id === 'brokerage')!;
    const roth = normalizeAccountForType(brokerage, 'roth_ira', 'p1');
    expect(roth.type).toBe('roth_ira');
    expect(roth.costBasis).toBeUndefined();
    expect(roth.rothBasis).toEqual({ contributions: 0, conversions: [] });
    // Joint is illegal on a Roth, so the user falls back to the given person.
    expect(roth.owner).toBe('p1');
    // Core fields survive the change.
    expect(roth.id).toBe('brokerage');
    expect(roth.name).toBe('Taxable brokerage');
    expect(roth.balance).toBe(70000);
  });

  it('leaves the user alone when no fallback person is supplied', () => {
    const brokerage = makeProfile().accounts.find((a) => a.id === 'brokerage')!;
    expect(normalizeAccountForType(brokerage, 'roth_ira').owner).toBe('joint');
  });

  it('-> 401k keeps only currentEmployer (the deprecated flags are never written)', () => {
    const savings = makeProfile().accounts.find((a) => a.id === 'savings')!;
    const k = normalizeAccountForType(savings, '401k', 'p1');
    expect(k.currentEmployer).toBe(false);
    expect(k.ruleOf55Eligible).toBeUndefined();
    expect(k.allowsPartialWithdrawals).toBeUndefined();
    expect(k.costBasis).toBeUndefined();
    expect(k.rothBasis).toBeUndefined();
    // Savings can't be joint-owned once it is a 401(k).
    expect(k.owner).toBe('p1');
  });

  it('401k -> savings drops the 401k-only fields and the target-date marker', () => {
    const k401 = makeProfile().accounts.find((a) => a.id === 'k401')!;
    const plain = normalizeAccountForType(k401, 'savings', 'p1');
    expect(plain.currentEmployer).toBeUndefined();
    expect(plain.targetDateFund).toBeUndefined(); // savings is cash, not a fund
    expect(plain.balance).toBe(850000);
  });

  it('keeps an existing value when re-normalizing to the same type', () => {
    const brokerage = makeProfile().accounts.find((a) => a.id === 'brokerage')!;
    const same = normalizeAccountForType(brokerage, 'taxable_brokerage', 'p1');
    expect(same.costBasis).toBe(45000);
    expect(same.owner).toBe('joint'); // still legal
  });
});

describe('makeDefaultMortgage', () => {
  it('builds a schema-valid starter mortgage for the given start year', () => {
    // Bounds from profileSchema.home.mortgage: rate <= 0.25, termYears 1-50,
    // startMonth 1-12 — the starter must always validate as-is.
    expect(makeDefaultMortgage(2026)).toEqual({
      originalPrincipal: 0,
      balance: 0,
      rate: 0.06,
      termYears: 30,
      startYear: 2026,
      startMonth: 1,
    });
    // The caller's "now" year is passed through untouched.
    expect(makeDefaultMortgage(2031).startYear).toBe(2031);
  });
});

describe('spending policy normalization + summaries', () => {
  it('fixed_real -> fixed_percent gets the 4% default', () => {
    expect(normalizeSpendingPolicy({ type: 'fixed_real' }, 'fixed_percent')).toEqual({
      type: 'fixed_percent',
      percent: 0.04,
    });
  });

  it('keeps an existing percent and drops it when returning to fixed_real', () => {
    expect(
      normalizeSpendingPolicy({ type: 'fixed_percent', percent: 0.035 }, 'fixed_percent'),
    ).toEqual({ type: 'fixed_percent', percent: 0.035 });
    const real = normalizeSpendingPolicy({ type: 'fixed_percent', percent: 0.035 }, 'fixed_real');
    expect(real).toEqual({ type: 'fixed_real' });
    expect('percent' in real).toBe(false);
  });

  it('summarizes both policy types', () => {
    expect(spendingPolicySummary({ type: 'fixed_real' })).toBe(
      'Fixed real (inflation-adjusted baseline)',
    );
    // formatPct(0.04) = "4.0%"
    expect(spendingPolicySummary({ type: 'fixed_percent', percent: 0.04 })).toBe(
      'Fixed percent: 4.0% of portfolio/yr',
    );
  });

  it('summarizes the withdrawal policy order and pretax preference', () => {
    expect(
      withdrawalPolicySummary({
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      }),
    ).toBe('Cash → Taxable brokerage → Pre-tax (401k/IRA) → Roth · IRA first');
    expect(
      withdrawalPolicySummary({ order: ['pretax', 'roth'], pretaxPreference: 'proportional' }),
    ).toBe('Pre-tax (401k/IRA) → Roth · Proportional');
  });
});
