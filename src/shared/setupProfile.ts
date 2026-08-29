/**
 * THE MINIMAL VALID PROFILE — what the first-run setup step writes.
 *
 * ZERO-START (2026-08-29, DECISIONS.md "Zero-start"): a new user's folder no
 * longer opens on the fictional starter household. The boot flow asks for the
 * few facts the tax and Social Security engine cannot run without — person 1's
 * name and birth month/year, an optional second person, and the filing state —
 * and this module turns that answer into a profile the schema accepts and the
 * app can boot on. Everything else starts EMPTY or at zero, because from the
 * first screen everything the user sees should be THEIR data:
 *
 *   - accounts: []               — nothing invented; the Workbench gates on
 *                                  this (src/ui/firstRun.ts) rather than
 *                                  simulating a household that does not exist;
 *   - every dollar field: 0      — the honest "not entered" for min(0) fields.
 *     PIA especially: the SSA figures live on ssa.gov, and a 0 here reads as
 *     "get the real one" (the Household tab says where), never as a benefit;
 *   - expenses: the three scalar streams at 0, NO `lines` key — absent is the
 *     schema's own spelling of "no itemised budget yet";
 *   - no insurance, no giving rule, no pot — every optional field absent, so
 *     each keeps its documented absent-meaning;
 *   - settings: exactly the defaults the types document (ProfileSettings:
 *     horizonAge 95, successTarget 0.85, paths 1000/10000) plus the app's
 *     standard spending/withdrawal policies. The seed is a fixed constant —
 *     a reproducibility knob, not household data: successive runs must differ
 *     because an input moved, never because the dice did.
 *
 * Filing status is DERIVED, not asked: one person files single, two file
 * jointly — the same rule the schema documents on `profileSchema.filing`
 * (a survivor's 'single' comes from a death event per simulated year, never
 * from this field).
 *
 * The write itself goes through the ordinary store path (api.putProfile →
 * profileSchema.parse → saveProfile), so this builder cannot smuggle an
 * invalid shape past the validation every other write faces. Pinned by
 * tests/ui/setupProfile.test.ts, which parses the output with the real schema.
 */
import type { Profile, StateCode } from './types';

export interface SetupPerson {
  name: string;
  birthYear: number;
  birthMonth: number;
}

export interface SetupInput {
  person1: SetupPerson;
  /** Optional — one-person households are real households. */
  person2: SetupPerson | null;
  state: StateCode;
  /**
   * The calendar year "today", for the required `health.acaQuoteYear` field
   * (a year outside the schema's 2024..2100 window is clamped). A parameter
   * rather than `new Date()` so the builder is pure and the tests are
   * deterministic; callers pass `new Date().getFullYear()`.
   */
  year: number;
}

/**
 * The fixed simulation seed a fresh profile starts with — the same constant
 * the starter carried, kept ON PURPOSE while everything fictional went:
 * a seed is not data about anyone, and a stable default means two fresh
 * installs given identical inputs print identical numbers.
 */
export const DEFAULT_SEED = 20260812;

const clampQuoteYear = (year: number): number =>
  Math.min(2100, Math.max(2024, Math.trunc(Number.isFinite(year) ? year : 2024)));

export function buildInitialProfile(input: SetupInput): Profile {
  const people = [
    { id: 'p1', ...personFields(input.person1) },
    ...(input.person2 === null ? [] : [{ id: 'p2', ...personFields(input.person2) }]),
  ];
  return {
    people,
    filing: { status: people.length === 2 ? 'mfj' : 'single', state: input.state },
    accounts: [],
    home: {
      // All zeros: "no home recorded yet" has no spelling of its own in the
      // schema (home is required), and a $0 house with $0 costs is the one
      // shape that adds nothing to any simulated year.
      value: 0,
      costBasis: 0,
      state: input.state,
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      maintenancePctOfValue: 0,
      sellingCostPct: 0,
      mortgage: null,
    },
    income: {
      // One entry per person, at the honest zero — the Income tab is where the
      // real figures land.
      salaries: Object.fromEntries(people.map((p) => [p.id, 0])),
      contribution401k: 0,
      employerMatch401k: 0,
    },
    expenses: {
      livingMonthly: 0,
      charitableMonthly: 0,
      investingMonthly: 0,
      // No `lines`: absent means "the scalars are the truth" (shared/schemas),
      // which is exactly the state of a budget nobody has entered.
    },
    health: {
      acaBenchmarkMonthly: 0,
      acaQuoteYear: clampQuoteYear(input.year),
      partDPlanMonthly: 0,
      employerPremiumShareMonthly: 0,
    },
    settings: {
      horizonAge: 95,
      successTarget: 0.85,
      mcPathsInteractive: 1000,
      mcPathsFinal: 10000,
      seed: DEFAULT_SEED,
      spendingPolicy: { type: 'fixed_real' },
      withdrawalPolicy: {
        order: ['cash', 'taxable', 'pretax', 'roth'],
        pretaxPreference: 'ira_first',
      },
    },
  };
}

function personFields(person: SetupPerson) {
  return {
    name: person.name.trim(),
    birthYear: Math.trunc(person.birthYear),
    birthMonth: Math.trunc(person.birthMonth),
    // 0 on both PIA figures is "not entered", never a claim about benefits —
    // the schema's min(0) has no absent state, and the Household tab labels
    // where the real SSA figures come from.
    piaMonthlyAtFraIfWorkingTo62: 0,
    piaMonthlyAtFraIfStoppingNow: 0,
    // TRUE by default: most people have their 40 credits, and a 0 PIA keeps
    // the benefit at 0 either way until real figures are entered. The
    // spousal-only configuration is a deliberate statement about a specific
    // work history — the Household tab's checkbox, not a setup default.
    hasOwnBenefit: true,
  };
}

/**
 * What the setup form refuses to submit, as one sentence per problem — kept
 * beside the builder so the form's floor and the schema's floor cannot drift.
 * (The schema would reject these anyway; saying it before the write names the
 * field instead of quoting a zod path at a brand-new user.)
 */
export function validateSetupInput(input: SetupInput): string[] {
  const problems: string[] = [];
  const check = (person: SetupPerson, label: string): void => {
    if (person.name.trim().length === 0) problems.push(`${label} needs a name.`);
    const year = Math.trunc(person.birthYear);
    if (!Number.isFinite(person.birthYear) || year < 1900 || year > 2010) {
      problems.push(`${label} needs a birth year between 1900 and 2010.`);
    }
    const month = Math.trunc(person.birthMonth);
    if (!Number.isFinite(person.birthMonth) || month < 1 || month > 12) {
      problems.push(`${label} needs a birth month.`);
    }
  };
  check(input.person1, input.person2 === null ? 'The person this plan is for' : 'Person 1');
  if (input.person2 !== null) check(input.person2, 'Person 2');
  return problems;
}
