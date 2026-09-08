/**
 * THE PLAN-AWARE HALF OF THE WIDOW'S PLAYBOOK.
 *
 * The conventional half is data — a dated, sourced file of advice
 * (assumptions/widow-playbook-2026.json). This module is the other half: the
 * handful of facts about THIS household that turn a checklist anyone could
 * find into a document about her, computed from the profile and the plan.
 *
 * WHAT IT WILL AND WILL NOT SAY. Every fact here is derived from something
 * already on file and is stated as such — the accounts as recorded, the
 * survivor column of the budget as typed, the policy as the plan will price
 * it. Where the profile is silent the answer is null and the screen says the
 * field is empty, because a playbook that quietly substitutes a plausible
 * number for a missing one is worse than a blank: it will be believed.
 *
 * It computes NO probabilities and runs NO simulation. The survivor's odds
 * already have a home (the Widow tab's curve), and duplicating them here with
 * a different method would eventually disagree with it.
 */
import { deriveExpenseStreams, survivorLivingMonthly } from './expenses';
import type { Person, Profile } from './types';

/** One account, as the playbook lists it: what it is and what happens to it. */
export interface PlaybookAccount {
  id: string;
  name: string;
  /** The recorded balance — as recorded, not re-priced. */
  balance: number;
  /** Whose it is, by name; null when the owner id names nobody on file. */
  ownerName: string | null;
  /** True when the survivor inherits a decision, not just a balance. */
  inheritsChoice: boolean;
}

export interface PlaybookFacts {
  /** The person the playbook is written FOR; null when the profile has one person. */
  survivor: Person | null;
  /** The person whose death it assumes. */
  deceased: Person | null;
  /** Every account, in profile order, with the survivor's decision flagged. */
  accounts: PlaybookAccount[];
  /** Their recorded total. */
  accountsTotal: number;
  /**
   * What the budget says the survivor spends, $/month — the "if I die" column
   * summed. Null when the budget names no survivor figure anywhere, which
   * means the plan is assuming her costs are the household's unchanged.
   */
  survivorLivingMonthly: number | null;
  /** The same figure the household spends now, for the comparison. */
  householdLivingMonthly: number;
  /**
   * Her age in the year of a death THIS year — the fact the IRA decision
   * turns on, because before 59½ staying a beneficiary avoids the penalty.
   */
  survivorAgeNow: number | null;
  /** True when that age is under 59½ and the inherited-IRA choice is live. */
  under59Half: boolean;
  /** Recorded life cover on the deceased, face amount; 0 when none is on file. */
  lifeCoverTotal: number;
  /** Contacts and documents, or empty when nobody has filled them in. */
  hasContacts: boolean;
  hasDocuments: boolean;
}

/** Pre-tax money the survivor must choose how to inherit, rather than simply receive. */
const CHOICE_TYPES = new Set(['401k', 'traditional_ira', 'roth_ira']);

/**
 * Whose death the playbook assumes: the OTHER person, from the survivor's
 * point of view. The profile names no such thing, so the rule is the same one
 * the widow sweep already uses — the earner is the one whose death costs the
 * most, and the household of two has exactly one other member.
 */
export function playbookPeople(profile: Pick<Profile, 'people' | 'income'>): {
  deceased: Person | null;
  survivor: Person | null;
} {
  const people = profile.people;
  if (people.length < 2) return { deceased: people[0] ?? null, survivor: null };
  const salaries = profile.income.salaries;
  const earner =
    people.find((p) => (salaries[p.id] ?? 0) > 0) ?? people[0] ?? null;
  const other = people.find((p) => p.id !== earner?.id) ?? null;
  return { deceased: earner, survivor: other };
}

/** Age at a birthday already had this year — the conservative reading. */
function ageIn(person: Person, year: number): number {
  return year - person.birthYear;
}

export function playbookFacts(profile: Profile, thisYear: number): PlaybookFacts {
  const { deceased, survivor } = playbookPeople(profile);
  const byId = new Map(profile.people.map((p) => [p.id, p.name]));

  const accounts: PlaybookAccount[] = profile.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    balance: a.balance,
    ownerName: byId.get(a.owner) ?? null,
    // A joint taxable account or a savings account simply carries on; a
    // retirement account owned by the person who died is the one that puts a
    // choice in front of her, and the choice has a deadline.
    inheritsChoice: CHOICE_TYPES.has(a.type) && a.owner === deceased?.id,
  }));

  const streams = deriveExpenseStreams(profile.expenses);
  const survivorAge = survivor === null ? null : ageIn(survivor, thisYear);

  const lifeCoverTotal = (profile.expenses.lifeInsurancePolicies ?? []).reduce(
    (sum, p) => sum + (p.deathBenefit ?? 0),
    profile.expenses.lifeInsurancePolicies === undefined
      ? (profile.expenses.lifeInsuranceDeathBenefit ?? 0)
      : 0,
  );

  return {
    survivor,
    deceased,
    accounts,
    accountsTotal: accounts.reduce((s, a) => s + a.balance, 0),
    survivorLivingMonthly: survivorLivingMonthly(profile.expenses, false),
    householdLivingMonthly: streams.livingMonthly,
    survivorAgeNow: survivorAge,
    under59Half: survivorAge !== null && survivorAge < 60,
    lifeCoverTotal,
    hasContacts: (profile.contacts ?? []).length > 0,
    hasDocuments: (profile.documents ?? []).length > 0,
  };
}
