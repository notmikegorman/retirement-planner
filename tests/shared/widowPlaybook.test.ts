/**
 * THE PLAN-AWARE HALF OF THE WIDOW'S PLAYBOOK (src/shared/widowPlaybook.ts).
 *
 * The property that matters is not arithmetic — the sums are trivial — it is
 * HONESTY. This page is read under stress by somebody who cannot check it, so
 * a figure it invents will be believed. Every case below is therefore about
 * the same thing: when the profile is silent, does the module say so, or does
 * it hand back a plausible default wearing the same clothes as a real answer?
 */
import { describe, expect, it } from 'vitest';
import { playbookFacts, playbookPeople } from '../../src/shared/widowPlaybook';
import type { Profile } from '../../src/shared/types';

function household(over: Partial<Profile> = {}): Profile {
  return {
    people: [
      { id: 'p1', name: 'Alex', birthYear: 1975, birthMonth: 3, piaMonthlyAtFraIfWorkingTo62: 2900, piaMonthlyAtFraIfStoppingNow: 2600, hasOwnBenefit: true },
      { id: 'p2', name: 'Jordan', birthYear: 1977, birthMonth: 9, piaMonthlyAtFraIfWorkingTo62: 0, piaMonthlyAtFraIfStoppingNow: 0, hasOwnBenefit: false },
    ],
    filing: { status: 'mfj', state: 'va' },
    accounts: [
      { id: 'k401', name: '401(k)', type: '401k', owner: 'p1', balance: 800_000, allocation: { stocks: 1, bonds: 0, bills: 0 } },
      { id: 'joint', name: 'Brokerage', type: 'taxable_brokerage', owner: 'p2', balance: 100_000, allocation: { stocks: 1, bonds: 0, bills: 0 } },
    ],
    home: { value: 500_000, costBasis: 400_000, state: 'va', propertyTaxAnnual: 4_000, insuranceAnnual: 1_500, maintenancePctOfValue: 0.01, sellingCostPct: 0.06 },
    income: { salaries: { p1: 150_000, p2: 0 }, contribution401k: 0, employerMatch401k: 0 },
    expenses: { livingMonthly: 6_000, charitableMonthly: 0, investingMonthly: 0 },
    health: { acaBenchmarkMonthly: 1_400, acaQuoteYear: 2026, partDPlanMonthly: 45, employerPremiumShareMonthly: 0 },
    settings: {
      horizonAge: 95, successTarget: 0.85, mcPathsInteractive: 100, mcPathsFinal: 200, seed: 1,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: { order: ['cash', 'taxable', 'pretax', 'roth'], pretaxPreference: 'ira_first' },
    },
    ...over,
  } as Profile;
}

describe('who the playbook is written for', () => {
  it('assumes the EARNER dies and the other survives — the costly direction', () => {
    const { deceased, survivor } = playbookPeople(household());
    expect(deceased?.name).toBe('Alex');
    expect(survivor?.name).toBe('Jordan');
  });

  it('has no survivor to write for in a household of one, and says so with null', () => {
    const solo = household({ people: [household().people[0]!] });
    const { deceased, survivor } = playbookPeople(solo);
    expect(deceased?.name).toBe('Alex');
    expect(survivor).toBeNull();
  });
});

describe('the accounts it lists', () => {
  it('flags only the retirement accounts the DECEASED owned — those carry a decision', () => {
    const facts = playbookFacts(household(), 2026);
    expect(facts.accounts.map((a) => [a.name, a.inheritsChoice])).toEqual([
      ['401(k)', true],
      // The survivor's own taxable account simply carries on: no election, no
      // deadline, nothing to raise with anyone.
      ['Brokerage', false],
    ]);
    expect(facts.accountsTotal).toBe(900_000);
  });

  it('names the owner from the people list, and null when the id names nobody', () => {
    const orphaned = household();
    orphaned.accounts[0]!.owner = 'ghost';
    const facts = playbookFacts(orphaned, 2026);
    expect(facts.accounts[0]!.ownerName).toBeNull();
    // And an account owned by nobody is not the deceased's, so it raises no
    // inherited-account decision.
    expect(facts.accounts[0]!.inheritsChoice).toBe(false);
  });
});

describe('the survivor spending figure — the one most likely to be missing', () => {
  it('reports null when the budget names no survivor column at all', () => {
    // The scalar-only shape: the plan is assuming her costs are the
    // household's, unchanged. The module must not quietly report the
    // household figure as though it were hers.
    const facts = playbookFacts(household(), 2026);
    expect(facts.survivorLivingMonthly).toBeNull();
    expect(facts.householdLivingMonthly).toBe(6_000);
  });

  it('sums the survivor column when the budget names one', () => {
    const itemised = household({
      expenses: {
        livingMonthly: 6_000,
        charitableMonthly: 0,
        investingMonthly: 0,
        lines: [
          { id: 'l1', label: 'Groceries', category: 'living', monthlyNow: 1_000, monthlySurvivor: 600 },
          { id: 'l2', label: 'Car payment', category: 'living', monthlyNow: 500 },
        ],
      },
    } as Partial<Profile>);
    const facts = playbookFacts(itemised, 2026);
    // 600 named + 500 inherited: the car payment does not fall, which is the
    // whole reason the column exists.
    expect(facts.survivorLivingMonthly).toBe(1_100);
    expect(facts.householdLivingMonthly).toBe(1_500);
  });
});

describe('the age branch the inherited-IRA decision turns on', () => {
  it('is live below 59½ and quiet above it', () => {
    expect(playbookFacts(household(), 2026).survivorAgeNow).toBe(49);
    expect(playbookFacts(household(), 2026).under59Half).toBe(true);
    // Jordan at 61: past the penalty question entirely.
    expect(playbookFacts(household(), 2038).under59Half).toBe(false);
  });
});

describe('life cover and the blanks', () => {
  it('is zero when nothing is on file — never a guess', () => {
    expect(playbookFacts(household(), 2026).lifeCoverTotal).toBe(0);
  });

  it('sums the policy list when there is one', () => {
    const covered = household({
      expenses: {
        livingMonthly: 6_000,
        charitableMonthly: 0,
        investingMonthly: 0,
        lifeInsurancePolicies: [
          { id: 'a', label: 'Term', deathBenefit: 500_000, premiumMonthly: 40 },
          { id: 'b', label: 'Group', deathBenefit: 150_000, premiumMonthly: 0 },
        ],
      },
    } as Partial<Profile>);
    expect(playbookFacts(covered, 2026).lifeCoverTotal).toBe(650_000);
  });

  it('reports contacts and documents as absent rather than empty-but-fine', () => {
    const bare = playbookFacts(household(), 2026);
    expect(bare.hasContacts).toBe(false);
    expect(bare.hasDocuments).toBe(false);
    const filled = playbookFacts(
      household({
        contacts: [{ id: 'c-1', role: 'estate attorney', name: 'A. Lawyer' }],
        documents: [{ id: 'd-1', label: 'Will', location: 'the safe' }],
      }),
      2026,
    );
    expect(filled.hasContacts).toBe(true);
    expect(filled.hasDocuments).toBe(true);
  });
});
