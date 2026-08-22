/**
 * Unit tests for src/engine/withdrawals.ts: the ordered withdrawal plan
 * (SPEC §4.2 golden case), penalty classification (59 1/2 with annual steps,
 * 72(t)/SEPP), the SEPP fixed-amortization math and lock window (including
 * who qualifies for the AUTOMATIC bridge election), Roth ordering rules, RMDs,
 * plan application, and the lifetime-contribution history the Tithe
 * Account's seed reads (note 21).
 * Every expected value is hand-computed with the arithmetic in a comment.
 */

import { describe, expect, it } from 'vitest';
import type { Person, Profile, WithdrawalPolicy } from '../../src/shared/types';
import {
  applyRothConversion,
  initAccountStates,
  isRetirementWrapper,
  applyWithdrawalPlan,
  computeRmds,
  computeWithdrawalPlan,
  planRothConversion,
  autoSeppForYear,
  prepareAutoSepp,
  prepareSepp,
  seppAnnualPayment,
  seppDistributions,
  seppSplit,
  singleLifeExpectancy,
  type AccountState,
  type OwnerWithdrawalInfo,
} from '../../src/engine/withdrawals';
import rmdJson from '../../data-defaults/assumptions/rmd-table.json';
import type { RmdTableData } from '../../src/shared/types';

const rmdData = rmdJson as unknown as RmdTableData;

function acct(
  partial: Partial<AccountState> & { id: string; type: AccountState['type']; balance: number },
): AccountState {
  return {
    name: partial.id,
    owner: 'p1',
    costBasis: 0,
    rothContributions: 0,
    rothConversions: [],
    allocation: { stocks: 1, bonds: 0, bills: 0 },
    ...partial,
  };
}

const defaultPolicy: WithdrawalPolicy = {
  order: ['cash', 'taxable', 'pretax', 'roth'],
  pretaxPreference: 'ira_first',
};

/** A June-1971 account owner: 59 1/2 in Dec 2030, so the first penalty-free year is 2031. */
function owners(overrides?: Partial<OwnerWithdrawalInfo>): Map<string, OwnerWithdrawalInfo> {
  return new Map([['p1', { penaltyFreeFromYear: 2031, ...overrides }]]);
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The SPEC §4.2 golden bridge-year profile, post-note-7: cash 10k / taxable
 * 30k (basis 15k) / 401k 12k / IRA 40k / roth 50k. The 401(k) no longer has a
 * rule-of-55 door — in a real scenario it would already have been rolled into
 * the IRA at separation — so pre-2031 pre-tax dollars are simply penalized.
 */
function goldenAccounts(): AccountState[] {
  return [
    acct({ id: 'savings', type: 'savings', balance: 10000, allocation: { stocks: 0, bonds: 0, bills: 1 } }),
    acct({ id: 'brokerage', type: 'taxable_brokerage', balance: 30000, costBasis: 15000 }),
    acct({ id: 'k401', type: '401k', balance: 12000 }),
    acct({ id: 'ira', type: 'traditional_ira', balance: 40000 }),
    acct({ id: 'roth', type: 'roth_ira', balance: 50000, rothContributions: 20000 }),
  ];
}

describe('computeWithdrawalPlan — the §4.2 withdrawal-order golden case', () => {
  it('draws cash -> taxable -> IRA -> 401k, all pre-tax penalized, for a $60k need in 2027', () => {
    const accounts = goldenAccounts();
    const plan = computeWithdrawalPlan(60000, accounts, defaultPolicy, 2027, owners());

    // Hand-computed: cash 10,000 (all of savings); taxable 30,000 (all of the
    // brokerage); still short 60,000 - 40,000 = 20,000 of pretax. With
    // 'ira_first' the IRA goes first (20,000 of its 40,000) and the 401(k) is
    // untouched. 2027 < 2031, and post-note-7 NOTHING excepts a pre-59 1/2
    // pre-tax draw except a 72(t) — so penaltyBase = the full 20,000.
    expect(plan.total).toBeCloseTo(60000, 10);
    expect(plan.byBucket.cash).toBeCloseTo(10000, 10);
    expect(plan.byBucket.taxable).toBeCloseTo(30000, 10);
    expect(plan.byBucket.pretax).toBeCloseTo(20000, 10);
    expect(plan.byBucket.roth).toBe(0);
    expect(plan.shortfall).toBe(0);

    // Realized LTCG = 30,000 x (1 - 15,000/30,000) = 30,000 x 0.5 = 15,000.
    expect(plan.realizedLtcg).toBeCloseTo(15000, 10);

    const ira = plan.slices.find((s) => s.accountId === 'ira');
    expect(ira).toMatchObject({ amount: 20000, penaltyException: 'none', penaltyBase: 20000 });
    expect(plan.slices.find((s) => s.accountId === 'k401')).toBeUndefined();
    expect(plan.penaltyBase).toBeCloseTo(20000, 10);
  });

  it('IRA slices become penalty-free (age_59_5) from 2031 — the year AFTER attaining 59 1/2', () => {
    const accounts = goldenAccounts();
    const plan = computeWithdrawalPlan(60000, accounts, defaultPolicy, 2031, owners());
    const ira = plan.slices.find((s) => s.accountId === 'ira');
    expect(ira).toMatchObject({ amount: 20000, penaltyException: 'age_59_5', penaltyBase: 0 });
    expect(plan.penaltyBase).toBe(0);
  });

  it('an account under an active 72(t) is skipped entirely by the ordering', () => {
    // The IRA is locked, so the 20,000 of remaining need falls through to the
    // NEXT pre-tax account (the 401k, 12,000 — penalized) and then to the
    // Roth's contribution basis (8,000, always tax/penalty-free). Drawing the
    // extra from the locked IRA would bust the SEPP.
    const accounts = goldenAccounts();
    const plan = computeWithdrawalPlan(
      60000,
      accounts,
      defaultPolicy,
      2027,
      owners(),
      new Set(['ira']),
    );
    expect(plan.slices.find((s) => s.accountId === 'ira')).toBeUndefined();
    expect(plan.byBucket.pretax).toBeCloseTo(12000, 10);
    expect(plan.byBucket.roth).toBeCloseTo(8000, 10);
    expect(plan.slices.find((s) => s.accountId === 'k401')).toMatchObject({
      amount: 12000,
      penaltyException: 'none',
      penaltyBase: 12000,
    });
    expect(plan.slices.find((s) => s.accountId === 'roth')).toMatchObject({
      amount: 8000,
      rothSubBucket: 'contributions',
      penaltyException: 'roth_basis',
      penaltyBase: 0,
    });
    expect(plan.total).toBeCloseTo(60000, 10);
  });

  it('proportional pretax preference splits pro-rata by available balance', () => {
    const accounts = [
      acct({ id: 'k401', type: '401k', balance: 30000 }),
      acct({ id: 'ira', type: 'traditional_ira', balance: 10000 }),
    ];
    const policy: WithdrawalPolicy = { order: ['pretax'], pretaxPreference: 'proportional' };
    const plan = computeWithdrawalPlan(20000, accounts, policy, 2031, owners());
    // 20,000 x 30/40 = 15,000 from the 401k; 20,000 x 10/40 = 5,000 from the IRA.
    expect(plan.slices.find((s) => s.accountId === 'k401')!.amount).toBeCloseTo(15000, 10);
    expect(plan.slices.find((s) => s.accountId === 'ira')!.amount).toBeCloseTo(5000, 10);
  });

  it('proportional preference also ignores a locked account', () => {
    // The IRA is locked, so the whole 20,000 comes from the 401k (the only
    // eligible pre-tax account) rather than 15,000 / 5,000 pro-rata.
    const accounts = [
      acct({ id: 'k401', type: '401k', balance: 30000 }),
      acct({ id: 'ira', type: 'traditional_ira', balance: 10000 }),
    ];
    const policy: WithdrawalPolicy = { order: ['pretax'], pretaxPreference: 'proportional' };
    const plan = computeWithdrawalPlan(20000, accounts, policy, 2031, owners(), new Set(['ira']));
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]).toMatchObject({ accountId: 'k401', amount: 20000 });
  });

  it('ira_first preference taps IRAs before 401(k)s', () => {
    const accounts = [
      acct({ id: 'k401', type: '401k', balance: 30000 }),
      acct({ id: 'ira', type: 'traditional_ira', balance: 10000 }),
    ];
    const policy: WithdrawalPolicy = { order: ['pretax'], pretaxPreference: 'ira_first' };
    const plan = computeWithdrawalPlan(15000, accounts, policy, 2031, owners());
    // IRA drained first (10,000), remainder (5,000) from the 401k.
    expect(plan.slices[0]).toMatchObject({ accountId: 'ira', amount: 10000 });
    expect(plan.slices[1]).toMatchObject({ accountId: 'k401', amount: 5000 });
  });

  it('reports a shortfall when every bucket is drained', () => {
    const accounts = [acct({ id: 'savings', type: 'savings', balance: 5000 })];
    const plan = computeWithdrawalPlan(8000, accounts, defaultPolicy, 2027, owners());
    // Only 5,000 available -> shortfall 8,000 - 5,000 = 3,000.
    expect(plan.total).toBeCloseTo(5000, 10);
    expect(plan.shortfall).toBeCloseTo(3000, 10);
  });

  it('respects amounts already committed (RMDs, 72(t) payments) via drawnByAccount', () => {
    const accounts = [acct({ id: 'ira', type: 'traditional_ira', balance: 10000 })];
    const policy: WithdrawalPolicy = { order: ['pretax'], pretaxPreference: 'ira_first' };
    const drawn = new Map([['ira', 6000]]);
    const plan = computeWithdrawalPlan(8000, accounts, policy, 2031, owners(), NONE, drawn);
    // Only 10,000 - 6,000 = 4,000 still available.
    expect(plan.total).toBeCloseTo(4000, 10);
    expect(plan.shortfall).toBeCloseTo(4000, 10);
  });
});

describe('computeWithdrawalPlan — the last-resort account (note 21, the tithe soft window)', () => {
  /**
   * The golden accounts plus a soft-window tithe carve-out. It rides in BOTH
   * seats the engine gives it: `lockedAccounts` (so the ordinary pretax pass
   * cannot reach it mid-order) and `lastResortAccountId` (so the plan reaches
   * it after the policy's whole order, Roth included, runs dry). A promise is
   * the last money touched.
   */
  const withTithe = (): AccountState[] => [
    ...goldenAccounts(),
    acct({ id: 'ira-tithe', type: 'traditional_ira', balance: 25000, titheParentId: 'ira' }),
  ];
  const locked = new Set(['ira-tithe']);

  it('is untouched while any bucket in the policy order can still pay', () => {
    // Everything else totals 142,000; a 120,000 need dips deep into Roth
    // earnings and still must not touch the pot.
    const plan = computeWithdrawalPlan(
      120000,
      withTithe(),
      defaultPolicy,
      2027,
      owners(),
      locked,
      new Map(),
      'ira-tithe',
    );
    expect(plan.slices.find((s) => s.accountId === 'ira-tithe')).toBeUndefined();
    expect(plan.total).toBeCloseTo(120000, 10);
    expect(plan.shortfall).toBe(0);
  });

  it('is drawn only for the remainder AFTER cash, taxable, pretax and Roth are all dry', () => {
    // 150,000 against 142,000 of everything else: the pot covers exactly the
    // 8,000 remainder — as an ordinary pre-tax slice, penalized in 2027 like
    // any other IRA draw (an emergency does not change the tax code).
    const plan = computeWithdrawalPlan(
      150000,
      withTithe(),
      defaultPolicy,
      2027,
      owners(),
      locked,
      new Map(),
      'ira-tithe',
    );
    const potSlice = plan.slices.find((s) => s.accountId === 'ira-tithe')!;
    expect(potSlice).toMatchObject({
      bucket: 'pretax',
      amount: 8000,
      taxableAmount: 8000,
      penaltyException: 'none',
      penaltyBase: 8000,
    });
    // It is the LAST slice: every other account was exhausted first.
    expect(plan.slices[plan.slices.length - 1].accountId).toBe('ira-tithe');
    expect(plan.shortfall).toBe(0);
    // ...and from the penalty-free year the same draw is exception age_59_5.
    const later = computeWithdrawalPlan(
      150000,
      withTithe(),
      defaultPolicy,
      2031,
      owners(),
      locked,
      new Map(),
      'ira-tithe',
    );
    expect(later.slices.find((s) => s.accountId === 'ira-tithe')).toMatchObject({
      penaltyException: 'age_59_5',
      penaltyBase: 0,
    });
  });

  it('caps at the pot and reports what even the pot could not cover as shortfall', () => {
    // 180,000 against 142,000 + 25,000 = 167,000 reachable: the pot is fully
    // drained and 13,000 remains unmet — insolvency happens only after the
    // promise has absorbed everything it can.
    const plan = computeWithdrawalPlan(
      180000,
      withTithe(),
      defaultPolicy,
      2027,
      owners(),
      locked,
      new Map(),
      'ira-tithe',
    );
    expect(plan.slices.find((s) => s.accountId === 'ira-tithe')!.amount).toBeCloseTo(25000, 10);
    expect(plan.shortfall).toBeCloseTo(13000, 10);
  });

  it('without the last-resort seat (the locked phase) the same need simply falls short', () => {
    // Same 150,000 need, `lockedAccounts` only: the escrow is absolute and
    // the plan reports the 8,000 the pot would have covered as shortfall.
    const plan = computeWithdrawalPlan(
      150000,
      withTithe(),
      defaultPolicy,
      2027,
      owners(),
      locked,
      new Map(),
      null,
    );
    expect(plan.slices.find((s) => s.accountId === 'ira-tithe')).toBeUndefined();
    expect(plan.shortfall).toBeCloseTo(8000, 10);
  });

  it('nets amounts already committed against the pot (an RMD share, an instalment)', () => {
    const drawn = new Map([['ira-tithe', 20000]]);
    const plan = computeWithdrawalPlan(
      180000,
      withTithe(),
      defaultPolicy,
      2027,
      owners(),
      locked,
      drawn,
      'ira-tithe',
    );
    // Only 25,000 - 20,000 = 5,000 of the pot is still reachable.
    expect(plan.slices.find((s) => s.accountId === 'ira-tithe')!.amount).toBeCloseTo(5000, 10);
    expect(plan.shortfall).toBeCloseTo(33000, 10);
  });
});

describe('72(t)/SEPP fixed amortization (note 16)', () => {
  it('P = B x r / (1 - (1+r)^-N): $300k at 5% over 31.6 years = $19,084.02', () => {
    // Hand-computed, the published fixed-amortization formula:
    //   1.05^31.6 = e^(31.6 x ln 1.05) = e^(31.6 x 0.0487901642)
    //             = e^1.5417691878 = 4.67285011
    //   (1.05)^-31.6 = 1 / 4.67285011      = 0.21400216
    //   1 - 0.21400216                      = 0.78599784
    //   P = 300,000 x 0.05 / 0.78599784 = 15,000 / 0.78599784
    //     = 19,084.0218
    expect(seppAnnualPayment(300000, 0.05, 31.6)).toBeCloseTo(19084.0218, 3);

    // A 0% rate degenerates to straight-line: 300,000 / 31.6 = 9,493.6709.
    expect(seppAnnualPayment(300000, 0, 31.6)).toBeCloseTo(300000 / 31.6, 8);
    // Nothing to amortize -> no payment.
    expect(seppAnnualPayment(0, 0.05, 31.6)).toBe(0);
  });

  it('seppSplit sizes the SEPP IRA to the requested payment (the split-IRA technique)', () => {
    // B = 1,000,000, r = 5%, N = 31.6 (single life at 55):
    //   maxPayment = 1,000,000 x 0.05 / (1 - 1.05^-31.6)
    //              = 1,000,000 x 0.05 / 0.78599784 = 63,613.4061
    // Asking for exactly half of that carves off exactly half the account:
    //   fraction  = 31,806.7030 / 63,613.4061 = 0.5
    //   principal = 0.5 x 1,000,000           = 500,000
    // and the carve-out's OWN formula maximum is the requested payment:
    //   500,000 x 0.05 / 0.78599784 = 31,806.7030.
    const half = seppSplit(1000000, 0.05, 31.6, 31806.703);
    expect(half.maxPayment).toBeCloseTo(63613.4061, 3);
    expect(half.payment).toBeCloseTo(31806.703, 6);
    expect(half.fraction).toBeCloseTo(0.5, 8);
    expect(half.principal).toBeCloseTo(500000, 2);
    expect(seppAnnualPayment(half.principal, 0.05, 31.6)).toBeCloseTo(half.payment, 6);

    // No requested amount -> the whole account is the SEPP IRA (no split).
    const full = seppSplit(1000000, 0.05, 31.6);
    expect(full.fraction).toBe(1);
    expect(full.principal).toBe(1000000);
    expect(full.payment).toBeCloseTo(63613.4061, 3);

    // A request ABOVE the maximum is capped, which again means no split: the
    // whole balance is needed to support even the capped payment.
    const capped = seppSplit(1000000, 0.05, 31.6, 200000);
    expect(capped.payment).toBeCloseTo(63613.4061, 3);
    expect(capped.fraction).toBe(1);
    expect(capped.principal).toBe(1000000);

    // Degenerate inputs: nothing to amortize -> nothing locked.
    expect(seppSplit(0, 0.05, 31.6, 10000)).toMatchObject({
      maxPayment: 0,
      payment: 0,
      fraction: 0,
      principal: 0,
    });
  });

  it('reads the single life expectancy table (age 55 -> 31.6) and clamps outside it', () => {
    expect(singleLifeExpectancy(rmdData, 55)).toBe(31.6);
    expect(singleLifeExpectancy(rmdData, 62)).toBe(25.4);
    // Table covers 50-70: below/above clamp to the ends.
    expect(singleLifeExpectancy(rmdData, 40)).toBe(36.2); // age 50 row
    expect(singleLifeExpectancy(rmdData, 99)).toBe(18.8); // age 70 row
  });
});

describe('prepareSepp', () => {
  const people: Person[] = [
    {
      id: 'p1',
      name: 'P1',
      birthYear: 1971,
      birthMonth: 6,
      piaMonthlyAtFraIfWorkingTo62: 0,
      piaMonthlyAtFraIfStoppingNow: 0,
      hasOwnBenefit: false,
    },
  ];
  const accounts = [{ id: 'ira', name: 'Traditional IRA', owner: 'p1' }];

  it('locks through the LATER of five payments and the 59 1/2 year', () => {
    // Election 2026 for a June-1971 account owner: 59 1/2 lands in Dec 2030, so the
    // first penalty-free year is 2031 — later than 2026 + 4 = 2030.
    const early = prepareSepp(
      [{ ym: { year: 2026, month: 6 }, account: 'ira' }],
      accounts,
      people,
      rmdData,
    );
    expect(early[0]).toMatchObject({
      accountId: 'ira',
      owner: 'p1',
      ownerAge: 2026 - 1971, // 55
      rate: 0.05, // Notice 2022-6 default
      lifeExpectancy: 31.6, // single life at 55
      lockThroughYear: 2031,
      // Ids reserved for the carve-out if the election splits the account.
      seppAccountId: 'ira-sepp',
      seppAccountName: 'Traditional IRA (72(t) SEPP)',
    });

    // Election 2030 (age 59): 2030 + 4 = 2034 is later than 2031.
    const late = prepareSepp(
      [{ ym: { year: 2030, month: 1 }, account: 'ira' }],
      accounts,
      people,
      rmdData,
    );
    expect(late[0]).toMatchObject({ ownerAge: 59, lifeExpectancy: 28.0, lockThroughYear: 2034 });
  });

  it('carries the requested amount and a custom rate, and rejects an unknown account', () => {
    const prepared = prepareSepp(
      [{ ym: { year: 2027, month: 3 }, account: 'ira', annualAmount: 10000, interestRate: 0.04 }],
      accounts,
      people,
      rmdData,
    );
    expect(prepared[0]).toMatchObject({ requestedAnnual: 10000, rate: 0.04, ownerAge: 56 });

    // Two elections on one account each reserve their own carve-out id.
    const twice = prepareSepp(
      [
        { ym: { year: 2027, month: 3 }, account: 'ira', annualAmount: 5000 },
        { ym: { year: 2028, month: 3 }, account: 'ira', annualAmount: 5000 },
      ],
      accounts,
      people,
      rmdData,
    );
    expect(twice.map((s) => s.seppAccountId)).toEqual(['ira-sepp', 'ira-sepp2']);

    expect(() =>
      prepareSepp([{ ym: { year: 2027, month: 3 }, account: 'nope' }], accounts, people, rmdData),
    ).toThrow(/unknown account "nope"/);
  });
});

describe('prepareAutoSepp (scenario.autoSepp)', () => {
  /** p1 born June 1971 (penalty-free 2031); p2 born June 1961 (penalty-free 2021). */
  const person = (id: string, birthYear: number): Person => ({
    id,
    name: id.toUpperCase(),
    birthYear,
    birthMonth: 6,
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    hasOwnBenefit: false,
  });
  const people = [person('p1', 1971), person('p2', 1961)];
  const retirements = new Map([
    ['p1', { year: 2026, month: 7 }],
    ['p2', { year: 2026, month: 7 }],
  ]);

  it('plans one election per person retiring before their own penalty-free year', () => {
    const plans = prepareAutoSepp(people, retirements, [], rmdData, true);
    // p1 retires 2026 with a penalty-free year of 2031 -> a 5-year bridge, and
    // a lock through the LATER of 2026 + 4 = 2030 and 2031.
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      owner: 'p1',
      retireYear: 2026,
      // Carried so an election in a LATER bridge year can re-derive its own
      // age, life expectancy, remaining bridge and lock — see autoSeppForYear.
      birthYear: 1971,
      penaltyFreeYear: 2031,
      ownerAge: 55, // 2026 - 1971
      rate: 0.05, // Notice 2022-6 default
      lifeExpectancy: 31.6, // single life at 55
      lockThroughYear: 2031,
      bridgeYears: 5, // 2031 - 2026
    });
    // Electing LATER re-derives everything from the year it actually starts:
    // older, so a shorter life expectancy and a shorter remaining bridge — and
    // a lock that now runs five years from the start rather than to 59 1/2.
    // That last one is the cost of waiting, and it is why the engine elects on
    // need rather than delaying as long as it can.
    const later = autoSeppForYear(plans[0], 2029, rmdData);
    expect(later.ownerAge).toBe(58);
    expect(later.bridgeYears).toBe(2); // 2031 - 2029
    expect(later.lockThroughYear).toBe(2033); // 2029 + 5 - 1, past the 2031 floor
    expect(later.lifeExpectancy).toBeLessThan(31.6);
    // Electing in the retirement year reproduces the scheduled figures exactly.
    const now = autoSeppForYear(plans[0], 2026, rmdData);
    expect(now.ownerAge).toBe(55);
    expect(now.bridgeYears).toBe(5);
    expect(now.lockThroughYear).toBe(2031);

    // p2 is already 65 in 2026: their penalty-free year (2021) is long past,
    // so there is no bridge to cross and nothing is planned.
    expect(plans.some((p) => p.owner === 'p2')).toBe(false);
  });

  it('skips a person who wrote their own start_72t, and everyone when disabled', () => {
    const manual = prepareSepp(
      [{ ym: { year: 2026, month: 7 }, account: 'ira' }],
      [{ id: 'ira', name: 'Traditional IRA', owner: 'p1' }],
      people,
      rmdData,
    );
    expect(prepareAutoSepp(people, retirements, manual, rmdData, true)).toEqual([]);
    // autoSepp: false — nobody gets one, explicit election or not.
    expect(prepareAutoSepp(people, retirements, [], rmdData, false)).toEqual([]);
  });

  it('skips a person who never retires in the scenario', () => {
    expect(prepareAutoSepp(people, new Map(), [], rmdData, true)).toEqual([]);
  });
});

describe('seppDistributions', () => {
  it('marks forced payments as ordinary income with the sepp_72t exception', () => {
    const slices = seppDistributions([
      { accountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 19084.0218 },
    ]);
    expect(slices).toEqual([
      {
        personId: 'p1',
        accountType: 'traditional_ira',
        amount: 19084.0218,
        taxableAmount: 19084.0218, // fully taxable ordinary income
        penaltyException: 'sepp_72t',
        penaltyBase: 0, // no 10% penalty while the series runs
      },
    ]);
  });
});

describe('computeWithdrawalPlan — Roth ordering rules', () => {
  function rothAccount(): AccountState {
    return acct({
      id: 'roth',
      type: 'roth_ira',
      balance: 100000,
      rothContributions: 30000,
      rothConversions: [{ year: 2026, amount: 20000 }],
    });
  }

  it('pre-59 1/2: contributions free, young conversion penalized, earnings taxed + penalized', () => {
    const plan = computeWithdrawalPlan(
      60000,
      [rothAccount()],
      { order: ['roth'], pretaxPreference: 'ira_first' },
      2029,
      owners(),
      new Set(),
    );
    // Ordering: contributions 30,000 (tax/penalty-free, roth_basis) ->
    // conversion 20,000 (2026 + 5 = 2031 > 2029: within the 5-year clock and
    // pre-59 1/2 -> 10% penalty base on it, tax-free since already taxed) ->
    // earnings 60,000 - 50,000 = 10,000 (non-qualified: taxable AND penalized).
    expect(plan.slices).toHaveLength(3);
    expect(plan.slices[0]).toMatchObject({
      rothSubBucket: 'contributions',
      amount: 30000,
      taxableAmount: 0,
      penaltyException: 'roth_basis',
      penaltyBase: 0,
    });
    expect(plan.slices[1]).toMatchObject({
      rothSubBucket: 'conversion',
      conversionYear: 2026,
      amount: 20000,
      taxableAmount: 0,
      penaltyBase: 20000,
    });
    expect(plan.slices[2]).toMatchObject({
      rothSubBucket: 'earnings',
      amount: 10000,
      taxableAmount: 10000,
      penaltyBase: 10000,
    });
    // penaltyBase total = 20,000 + 10,000 = 30,000.
    expect(plan.penaltyBase).toBeCloseTo(30000, 10);
  });

  it('from the penalty-free year everything is qualified (5-year account clock assumed met)', () => {
    const plan = computeWithdrawalPlan(
      60000,
      [rothAccount()],
      { order: ['roth'], pretaxPreference: 'ira_first' },
      2031,
      owners(),
      new Set(),
    );
    expect(plan.penaltyBase).toBe(0);
    for (const s of plan.slices) expect(s.taxableAmount).toBe(0);
  });
});

describe('computeRmds', () => {
  it('forces prior-year-end balance / Uniform Lifetime divisor at the attained age', () => {
    const accounts = [
      acct({ id: 'ira', type: 'traditional_ira', balance: 246000 }),
      acct({ id: 'roth', type: 'roth_ira', balance: 50000 }), // Roth IRAs have no RMD
    ];
    const rmds = computeRmds(accounts, new Map([['p1', 75]]), rmdData);
    // Age 75 divisor = 24.6 -> 246,000 / 24.6 = 10,000.
    expect(rmds).toHaveLength(1);
    expect(rmds[0].accountId).toBe('ira');
    expect(rmds[0].amount).toBeCloseTo(246000 / 24.6, 8);
  });

  it('no RMD before rmdStartAge (75)', () => {
    const accounts = [acct({ id: 'ira', type: 'traditional_ira', balance: 246000 })];
    expect(computeRmds(accounts, new Map([['p1', 74]]), rmdData)).toHaveLength(0);
  });

  it('ages beyond the table use the last divisor', () => {
    const accounts = [acct({ id: 'ira', type: 'traditional_ira', balance: 35000 })];
    const rmds = computeRmds(accounts, new Map([['p1', 120]]), rmdData);
    // Table tops out at age 110 (divisor 3.5): 35,000 / 3.5 = 10,000.
    expect(rmds[0].amount).toBeCloseTo(10000, 8);
  });
});

describe('applyWithdrawalPlan', () => {
  it('reduces taxable basis proportionally and roth sub-buckets exactly', () => {
    const accounts = [
      acct({ id: 'brokerage', type: 'taxable_brokerage', balance: 30000, costBasis: 15000 }),
      acct({
        id: 'roth',
        type: 'roth_ira',
        balance: 100000,
        rothContributions: 30000,
        rothConversions: [{ year: 2026, amount: 20000 }],
      }),
    ];
    const plan = computeWithdrawalPlan(
      10000,
      accounts,
      { order: ['taxable'], pretaxPreference: 'ira_first' },
      2027,
      owners(),
      new Set(),
    );
    applyWithdrawalPlan(accounts, plan);
    // Brokerage: sold 10,000 of 30,000; basis falls proportionally by
    // 10,000 x (15,000/30,000) = 5,000 -> basis 10,000, balance 20,000.
    expect(accounts[0].balance).toBeCloseTo(20000, 10);
    expect(accounts[0].costBasis).toBeCloseTo(10000, 10);

    const rothPlan = computeWithdrawalPlan(
      40000,
      accounts,
      { order: ['roth'], pretaxPreference: 'ira_first' },
      2027,
      owners(),
      new Set(),
    );
    applyWithdrawalPlan(accounts, rothPlan);
    // 30,000 contributions + 10,000 of the 2026 conversion consumed:
    // contributions 0, conversion bucket 20,000 - 10,000 = 10,000, balance 60,000.
    expect(accounts[1].rothContributions).toBe(0);
    expect(accounts[1].rothConversions).toEqual([{ year: 2026, amount: 10000 }]);
    expect(accounts[1].balance).toBeCloseTo(60000, 10);
  });
});

describe('roth conversions', () => {
  it('plans IRA-first, respects committed draws, and lands year-stamped in the user roth', () => {
    const accounts = [
      acct({ id: 'k401', type: '401k', balance: 50000 }),
      acct({ id: 'ira', type: 'traditional_ira', balance: 30000 }),
      acct({ id: 'roth', type: 'roth_ira', balance: 10000, rothContributions: 10000 }),
    ];
    // 20,000 of the IRA is already committed (RMD/plan): available IRA =
    // 10,000, so a 25,000 conversion takes 10,000 from the IRA then 15,000
    // from the 401k (IRA-first ordering).
    const slices = planRothConversion(accounts, new Map([['ira', 20000]]), 25000);
    expect(slices).toEqual([
      { fromAccountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 10000 },
      { fromAccountId: 'k401', owner: 'p1', accountType: '401k', amount: 15000 },
    ]);
    applyRothConversion(accounts, slices, 2027);
    expect(accounts[1].balance).toBeCloseTo(20000, 10); // 30,000 - 10,000
    expect(accounts[0].balance).toBeCloseTo(35000, 10); // 50,000 - 15,000
    expect(accounts[2].balance).toBeCloseTo(35000, 10); // 10,000 + 25,000
    expect(accounts[2].rothConversions).toEqual([{ year: 2027, amount: 25000 }]);
  });

  it('caps at the pretax balance', () => {
    const accounts = [acct({ id: 'ira', type: 'traditional_ira', balance: 5000 })];
    const slices = planRothConversion(accounts, new Map(), 50000);
    expect(slices).toEqual([
      { fromAccountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 5000 },
    ]);
  });
});

describe('lifetime contributions — the Tithe Account seed’s raw material (note 21)', () => {
  it('names the retirement wrappers, and only those', () => {
    // The carve-out lives inside an IRA and can only ever hold pre-tax
    // dollars, but the SEED measures untithed gains across pre-tax AND Roth:
    // both wrappers hold money that grew without ever passing under a tithe.
    // Savings and a taxable brokerage are excluded — their gains are outside
    // the seed's remit, and their basis is already tracked as costBasis.
    expect(isRetirementWrapper('401k')).toBe(true);
    expect(isRetirementWrapper('traditional_ira')).toBe(true);
    expect(isRetirementWrapper('roth_ira')).toBe(true);
    expect(isRetirementWrapper('savings')).toBe(false);
    expect(isRetirementWrapper('taxable_brokerage')).toBe(false);
  });

  it('initAccountStates carries the figure only where it means something', () => {
    // A figure left on a savings or brokerage account by an earlier edit is
    // dropped rather than silently widening the seed's base. UNDEFINED means
    // unknown, and a wrapper that genuinely carries 0 keeps its 0.
    // (initAccountStates reads profile.accounts and nothing else, hence the
    // cast — a whole Profile here would be noise.)
    const accounts = [
      { id: 'ira', name: 'IRA', type: 'traditional_ira', owner: 'p1', balance: 100000, lifetimeContributions: 40000, allocation: { stocks: 1, bonds: 0, bills: 0 } },
      { id: 'roth', name: 'Roth', type: 'roth_ira', owner: 'p1', balance: 50000, lifetimeContributions: 0, allocation: { stocks: 1, bonds: 0, bills: 0 } },
      { id: 'k401', name: '401k', type: '401k', owner: 'p1', balance: 20000, allocation: { stocks: 1, bonds: 0, bills: 0 } },
      { id: 'sav', name: 'Savings', type: 'savings', owner: 'p1', balance: 10000, lifetimeContributions: 9999, allocation: { stocks: 0, bonds: 0, bills: 1 } },
    ];
    const states = initAccountStates({ accounts } as unknown as Profile);
    expect(states.map((a) => a.lifetimeContributions)).toEqual([40000, 0, undefined, undefined]);
  });

  it('a Roth conversion moves the contribution history PRO RATA with the dollars', () => {
    // A conversion changes the wrapper, not the history: the same money is
    // still part contributed and part earned. The seed reads pre-tax and Roth
    // balances together, so the HOUSEHOLD total only stays right if the figure
    // travels with the balance.
    //   25,000 of a 100,000 IRA is a quarter of it, so a quarter of the
    //   40,000 contributed — 10,000 — moves across.
    const accounts = [
      acct({ id: 'ira', type: 'traditional_ira', balance: 100000, lifetimeContributions: 40000 }),
      acct({ id: 'roth', type: 'roth_ira', balance: 50000, lifetimeContributions: 20000 }),
    ];
    applyRothConversion(
      accounts,
      [{ fromAccountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 25000 }],
      2027,
    );
    expect(accounts[0].lifetimeContributions).toBeCloseTo(30000, 10);
    expect(accounts[1].lifetimeContributions).toBeCloseTo(30000, 10);
    // Nothing created, nothing destroyed: 40,000 + 20,000 either side.
    expect(
      (accounts[0].lifetimeContributions ?? 0) + (accounts[1].lifetimeContributions ?? 0),
    ).toBeCloseTo(60000, 10);
  });

  it('a conversion touching an UNKNOWN figure leaves the destination unknown', () => {
    // Adding a known figure to an unknown one and reporting the sum would
    // invent certainty the household does not have; the seed's
    // 'tithe-basis-missing' flag exists precisely to say so instead.
    const unknownSource = [
      acct({ id: 'ira', type: 'traditional_ira', balance: 100000 }),
      acct({ id: 'roth', type: 'roth_ira', balance: 50000, lifetimeContributions: 20000 }),
    ];
    applyRothConversion(
      unknownSource,
      [{ fromAccountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 25000 }],
      2027,
    );
    expect(unknownSource[0].lifetimeContributions).toBeUndefined();
    expect(unknownSource[1].lifetimeContributions).toBeUndefined();

    const unknownDest = [
      acct({ id: 'ira', type: 'traditional_ira', balance: 100000, lifetimeContributions: 40000 }),
      acct({ id: 'roth', type: 'roth_ira', balance: 50000 }),
    ];
    applyRothConversion(
      unknownDest,
      [{ fromAccountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 25000 }],
      2027,
    );
    expect(unknownDest[0].lifetimeContributions).toBeCloseTo(30000, 10); // the source still knows
    expect(unknownDest[1].lifetimeContributions).toBeUndefined();
  });

  it('a conversion with no Roth to land in carries the history into the synthetic one', () => {
    const accounts = [
      acct({ id: 'ira', type: 'traditional_ira', balance: 100000, lifetimeContributions: 40000 }),
    ];
    applyRothConversion(
      accounts,
      [{ fromAccountId: 'ira', owner: 'p1', accountType: 'traditional_ira', amount: 25000 }],
      2027,
    );
    const created = accounts.find((a) => a.type === 'roth_ira')!;
    expect(created.lifetimeContributions).toBeCloseTo(10000, 10);
    expect(accounts[0].lifetimeContributions).toBeCloseTo(30000, 10);
  });
});
