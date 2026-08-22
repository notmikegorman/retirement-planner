/**
 * Unit tests for src/shared/schemas.ts —
 * - scenario assumption_overrides validation: the overrides used to be
 *   unvalidated z.record(...unknown) stubs; these tests pin the bounded strict
 *   schemas that replaced them (garbage values and unknown keys rejected with
 *   helpful errors);
 * - profile validation: joint-account ownership rules and the three monthly
 *   expense streams;
 * - the survivor: the `death` event (its bounded livingFraction and optional
 *   survivorClaim, and the fact that BOTH must stay absent when absent so the
 *   engine's own defaults survive parsing), the widow_score solver (which
 *   carries no target of its own), the life-insurance policy on the profile
 *   AND as a scenario-level override — the override being a real hole this
 *   schema had, since the premium field was declared and read but never
 *   accepted — and the widened profile filing status.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatZodError,
  netWorthFileSchema,
  profileSchema,
  planHistoryFileSchema,
  planKeepSchema,
  scenarioSchema,
} from '../../src/shared/schemas';

/** Minimal valid scenario; overrides merged in per test. */
function scenario(overrides?: unknown): unknown {
  return {
    name: 'Test scenario',
    events: [],
    ...(overrides === undefined ? {} : { assumption_overrides: overrides }),
  };
}

function errorFor(value: unknown): string | null {
  const res = scenarioSchema.safeParse(value);
  return res.success ? null : formatZodError(res.error);
}

describe('scenario assumption_overrides: valid inputs pass', () => {
  it('accepts a scenario with no overrides at all', () => {
    expect(errorFor(scenario())).toBeNull();
    expect(errorFor(scenario({}))).toBeNull();
  });

  it('accepts a fully-populated, in-bounds market override', () => {
    expect(
      errorFor(
        scenario({
          market: {
            deterministicReal: { stocks: 0.065, bonds: 0.018, bills: 0.005 },
            deterministicInflation: 0.025,
            expenseRatios: { stocks: 0.0003, bonds: 0.0005, bills: 0 },
            stockDividendYield: 0.014,
            bootstrapBlockYears: 5,
            homeAppreciationRealSpread: 0,
            medicalInflationRealSpread: 0.02,
            rentGrowthRealSpread: 0.005,
          },
        }),
      ),
    ).toBeNull();
  });

  it('accepts partial market overrides (each field optional)', () => {
    expect(errorFor(scenario({ market: { deterministicInflation: 0.03 } }))).toBeNull();
    expect(errorFor(scenario({ market: { bootstrapBlockYears: 1 } }))).toBeNull();
    expect(errorFor(scenario({ market: {} }))).toBeNull();
  });

  it('accepts bondComposition.corporateFraction across its whole range', () => {
    // 0 (explicit Treasuries-only), 0.3 (a BND-like sleeve), 1 (pure Baa —
    // the visible extreme). Both endpoints are legal: the bound is inclusive.
    for (const corporateFraction of [0, 0.3, 1]) {
      expect(
        errorFor(scenario({ market: { bondComposition: { corporateFraction } } })),
      ).toBeNull();
    }
  });

  it('accepts in-bounds settings overrides (profile-schema shapes)', () => {
    expect(
      errorFor(
        scenario({
          settings: {
            horizonAge: 100,
            successTarget: 0.9,
            terminalFloorReal: 250_000,
            spendingPolicy: { type: 'fixed_percent', percent: 0.04 },
          },
        }),
      ),
    ).toBeNull();
    expect(
      errorFor(scenario({ settings: { spendingPolicy: { type: 'fixed_real' } } })),
    ).toBeNull();
  });

  it('accepts a guardrails band with and without the optional ceiling', () => {
    const band = { upper: 1.2, lower: 0.8, adjustment: 0.1, floorFraction: 0.7 };
    expect(
      errorFor(scenario({ settings: { spendingPolicy: { type: 'guardrails', guardrails: band } } })),
    ).toBeNull();
    // 1.0 is the user's "never spend above plan" variant; 3 is the top of the
    // legal range (mirroring the upper rail's own ceiling).
    for (const raiseCeiling of [1, 1.5, 3]) {
      expect(
        errorFor(
          scenario({
            settings: { spendingPolicy: { type: 'guardrails', guardrails: { ...band, raiseCeiling } } },
          }),
        ),
      ).toBeNull();
    }
  });

  it('accepts the aca toggle', () => {
    expect(errorFor(scenario({ aca: { enhancedCreditsExtended: true } }))).toBeNull();
  });

  it('accepts expense-stream overrides (whole, partial, and zero)', () => {
    expect(
      errorFor(
        scenario({
          expenses: { livingMonthly: 6000, charitableMonthly: 250, investingMonthly: 1500 },
        }),
      ),
    ).toBeNull();
    // Each field independently optional — a workbench slider touches one.
    expect(errorFor(scenario({ expenses: { livingMonthly: 5500 } }))).toBeNull();
    expect(errorFor(scenario({ expenses: { charitableMonthly: 0 } }))).toBeNull();
    expect(errorFor(scenario({ expenses: { investingMonthly: 0 } }))).toBeNull();
    expect(errorFor(scenario({ expenses: {} }))).toBeNull();
    // Both sides of every pair (note 19): the retired cell is its own override.
    expect(
      errorFor(
        scenario({
          expenses: {
            livingMonthly: 8200,
            livingMonthlyRetired: 7000,
            investingMonthly: 1250,
            investingMonthlyRetired: 0,
          },
        }),
      ),
    ).toBeNull();
    expect(errorFor(scenario({ expenses: { livingMonthlyRetired: 0 } }))).toBeNull();
    expect(errorFor(scenario({ expenses: { investingMonthlyRetired: 500 } }))).toBeNull();
    // Ceiling is inclusive at 1,000,000/mo.
    expect(errorFor(scenario({ expenses: { livingMonthly: 1_000_000 } }))).toBeNull();
    // Coexists with the other override groups.
    expect(
      errorFor(
        scenario({ settings: { horizonAge: 95 }, expenses: { livingMonthly: 4000 } }),
      ),
    ).toBeNull();
  });

  it('accepts every retirementGiving rule as a scenario-level override (note 18)', () => {
    const ok = (rule: unknown) => errorFor(scenario({ expenses: { retirementGiving: rule } }));
    expect(ok({ type: 'continue' })).toBeNull();
    expect(ok({ type: 'none' })).toBeNull();
    expect(ok({ type: 'percent_of_growth', percent: 0.1 })).toBeNull();
    expect(ok({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 3 })).toBeNull();
    expect(ok({ type: 'percent_of_growth', percent: 0, capMonthly: 0 })).toBeNull();
    expect(
      ok({ type: 'percent_of_growth', percent: 1, smoothingYears: 10, capMonthly: 5000 }),
    ).toBeNull();
    expect(ok({ type: 'percent_of_income', percent: 0.05 })).toBeNull();
    // The Tithe Account (note 21): percent + a defer window + the seed switch,
    // with an optional starting mix for the carve-out.
    expect(
      ok({ type: 'tithe_account', percent: 0.1, deferYears: 8, seedFromExistingGains: true }),
    ).toBeNull();
    expect(
      ok({ type: 'tithe_account', percent: 0, deferYears: 0, seedFromExistingGains: false }),
    ).toBeNull();
    expect(
      ok({
        type: 'tithe_account',
        percent: 1,
        deferYears: 30,
        seedFromExistingGains: true,
        allocation: { stocks: 0.8, bonds: 0.2, bills: 0 },
      }),
    ).toBeNull();
    // The payout window and the safe-zone release are OPTIONAL — absence is
    // the shared default (10 years; release on) — and both bounds are legal.
    expect(
      ok({
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 8,
        seedFromExistingGains: true,
        distributeYears: 1,
        earlyRelease: false,
      }),
    ).toBeNull();
    expect(
      ok({
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 8,
        seedFromExistingGains: true,
        distributeYears: 30,
        earlyRelease: true,
      }),
    ).toBeNull();
    // The plain "a different amount" rule (note 19), including 0 and the
    // shared 1,000,000/mo ceiling.
    expect(ok({ type: 'amount', monthly: 750 })).toBeNull();
    expect(ok({ type: 'amount', monthly: 0 })).toBeNull();
    expect(ok({ type: 'amount', monthly: 1_000_000 })).toBeNull();
    // Alongside the monthly streams — a what-if comparing rules at a new
    // spending level in one shot.
    expect(
      errorFor(
        scenario({
          expenses: { charitableMonthly: 1250, retirementGiving: { type: 'none' } },
        }),
      ),
    ).toBeNull();
  });

  it('accepts the un-tithed pot as a scenario-level override (the two-knob split)', () => {
    const ok = (pot: unknown) => errorFor(scenario({ expenses: { untithedPot: pot } }));
    // The one required field, everything else on its absent-means default.
    expect(ok({ holdYears: 11 })).toBeNull();
    // Every knob at both legal bounds.
    expect(
      ok({
        percent: 0,
        holdYears: 0,
        distributeYears: 1,
        earlyRelease: false,
        ongoingDuringHold: 'accrue_to_pot',
        seedFromGains: false,
      }),
    ).toBeNull();
    expect(
      ok({
        enabled: true,
        percent: 1,
        holdYears: 30,
        distributeYears: 30,
        earlyRelease: true,
        ongoingDuringHold: 'give_cash',
        seedFromGains: true,
        allocation: { stocks: 0.8, bonds: 0.2, bills: 0 },
      }),
    ).toBeNull();
    // The EXPLICIT disable — how an override suppresses an inherited pot,
    // and what the migration writes into every pre-split override.
    expect(ok({ enabled: false })).toBeNull();
    // Each half of the pair overrides independently, and together.
    expect(
      errorFor(
        scenario({
          expenses: { retirementGiving: { type: 'none' }, untithedPot: { holdYears: 3 } },
        }),
      ),
    ).toBeNull();
  });
});

describe('scenario assumption_overrides: garbage is rejected', () => {
  it('rejects 85 as a successTarget (fractions, not percent)', () => {
    const err = errorFor(scenario({ settings: { successTarget: 85 } }));
    expect(err).not.toBeNull();
    expect(err).toContain('successTarget');
  });

  it('rejects a junk string in a market field', () => {
    const err = errorFor(scenario({ market: { deterministicInflation: 'lots' } }));
    expect(err).not.toBeNull();
    expect(err).toContain('deterministicInflation');
  });

  it('rejects out-of-bounds market numbers', () => {
    // deterministicReal components bounded to [-0.2, 0.2].
    expect(
      errorFor(scenario({ market: { deterministicReal: { stocks: 0.5, bonds: 0.02, bills: 0 } } })),
    ).not.toBeNull();
    // deterministicInflation bounded to [-0.05, 0.15].
    expect(errorFor(scenario({ market: { deterministicInflation: 0.5 } }))).not.toBeNull();
    // expenseRatios bounded to [0, 0.05].
    expect(
      errorFor(scenario({ market: { expenseRatios: { stocks: 0.2, bonds: 0, bills: 0 } } })),
    ).not.toBeNull();
    // stockDividendYield bounded to [0, 0.1].
    expect(errorFor(scenario({ market: { stockDividendYield: 0.5 } }))).not.toBeNull();
    // spreads bounded to [-0.05, 0.1].
    expect(errorFor(scenario({ market: { medicalInflationRealSpread: 0.5 } }))).not.toBeNull();
    expect(errorFor(scenario({ market: { rentGrowthRealSpread: -0.5 } }))).not.toBeNull();
  });

  it('rejects non-integer or out-of-range bootstrapBlockYears (int 1-10)', () => {
    expect(errorFor(scenario({ market: { bootstrapBlockYears: 0 } }))).not.toBeNull();
    expect(errorFor(scenario({ market: { bootstrapBlockYears: 11 } }))).not.toBeNull();
    expect(errorFor(scenario({ market: { bootstrapBlockYears: 2.5 } }))).not.toBeNull();
  });

  it('rejects an out-of-range or misspelled bondComposition', () => {
    // 30 is percent typed where the 0..1 fraction belongs — the single most
    // likely bad input for this field, and the engine's own guard should
    // never be the first line of defense.
    expect(
      errorFor(scenario({ market: { bondComposition: { corporateFraction: 30 } } })),
    ).toContain('corporateFraction');
    expect(
      errorFor(scenario({ market: { bondComposition: { corporateFraction: -0.1 } } })),
    ).toContain('corporateFraction');
    // Strict inner object: a typo'd key must fail loudly, not silently leave
    // the sleeve in Treasuries.
    expect(
      errorFor(scenario({ market: { bondComposition: { corporateFrac: 0.3 } } })),
    ).not.toBeNull();
    // An empty bondComposition names no share at all — also refused (the
    // field is required inside the object).
    expect(errorFor(scenario({ market: { bondComposition: {} } }))).not.toBeNull();
  });

  it('rejects out-of-bounds settings values', () => {
    expect(errorFor(scenario({ settings: { horizonAge: 60 } }))).not.toBeNull(); // < 70
    expect(errorFor(scenario({ settings: { horizonAge: 120 } }))).not.toBeNull(); // > 110
    expect(errorFor(scenario({ settings: { horizonAge: 95.5 } }))).not.toBeNull(); // not int
    expect(errorFor(scenario({ settings: { terminalFloorReal: -1 } }))).not.toBeNull(); // < 0
    expect(
      errorFor(scenario({ settings: { spendingPolicy: { type: 'guyton_klinger' } } })),
    ).not.toBeNull(); // not a v1 policy
    expect(
      errorFor(scenario({ settings: { spendingPolicy: { type: 'fixed_percent', percent: 0.5 } } })),
    ).not.toBeNull(); // percent > 0.25
  });

  it('rejects an out-of-bounds raiseCeiling, in the scenario override AND the profile', () => {
    const withCeiling = (raiseCeiling: number) =>
      scenario({
        settings: {
          spendingPolicy: {
            type: 'guardrails',
            guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1, raiseCeiling },
          },
        },
      });
    // Below 1 the "prosperity cap" would sit under plan spending and fight the
    // floor — the schema refuses to let that band exist at all.
    expect(errorFor(withCeiling(0.9))).toContain('raiseCeiling');
    expect(errorFor(withCeiling(3.5))).toContain('raiseCeiling');
    // The profile schema carries the identical bounds (two sites, one shape).
    const p = starterProfile();
    p.settings.spendingPolicy = {
      type: 'guardrails',
      guardrails: { upper: 1.2, lower: 0.8, adjustment: 0.1, raiseCeiling: 0.5 },
    };
    expect(profileErrorFor(p)).toContain('raiseCeiling');
    p.settings.spendingPolicy.guardrails.raiseCeiling = 1;
    expect(profileErrorFor(p)).toBeNull();
  });

  it('rejects unknown keys in market and settings (strict objects)', () => {
    const marketErr = errorFor(scenario({ market: { vibes: 1 } }));
    expect(marketErr).not.toBeNull();
    expect(marketErr).toContain('market');
    const settingsErr = errorFor(scenario({ settings: { horizonAge: 95, extra: true } }));
    expect(settingsErr).not.toBeNull();
    expect(settingsErr).toContain('settings');
  });

  it('rejects negative, out-of-range, non-numeric, and unknown expense overrides', () => {
    for (const field of [
      'livingMonthly',
      'livingMonthlyRetired',
      'charitableMonthly',
      'investingMonthly',
      'investingMonthlyRetired',
    ]) {
      const negative = errorFor(scenario({ expenses: { [field]: -1 } }));
      expect(negative, field).not.toBeNull();
      expect(negative, field).toContain(field);
      // Ceiling 1,000,000/mo: one dollar over is out of range.
      const tooBig = errorFor(scenario({ expenses: { [field]: 1_000_001 } }));
      expect(tooBig, field).not.toBeNull();
      expect(tooBig, field).toContain(field);
    }
    expect(errorFor(scenario({ expenses: { livingMonthly: 'lots' } }))).not.toBeNull();
    // Strict object: a typo'd key must fail loudly, not silently do nothing.
    const unknownErr = errorFor(scenario({ expenses: { livingMontly: 6000 } }));
    expect(unknownErr).not.toBeNull();
    expect(unknownErr).toContain('expenses');
    // Annual figures don't belong here either — but only absurd ones trip the
    // ceiling, which is exactly what the bound is for.
    expect(errorFor(scenario({ expenses: { livingMonthly: 72_000 } }))).toBeNull();
  });

  it('rejects out-of-bounds and malformed retirementGiving rules (note 18)', () => {
    const bad = (rule: unknown) => errorFor(scenario({ expenses: { retirementGiving: rule } }));
    // percent is a fraction, 0..1 — 10 means "1,000%", not "10%".
    expect(bad({ type: 'percent_of_growth', percent: 10 })).not.toBeNull();
    expect(bad({ type: 'percent_of_growth', percent: -0.1 })).not.toBeNull();
    expect(bad({ type: 'percent_of_income', percent: 10 })).not.toBeNull();
    // smoothingYears: integer 1..10.
    expect(bad({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 0 })).not.toBeNull();
    expect(bad({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 11 })).not.toBeNull();
    expect(bad({ type: 'percent_of_growth', percent: 0.1, smoothingYears: 2.5 })).not.toBeNull();
    // capMonthly: non-negative.
    expect(bad({ type: 'percent_of_growth', percent: 0.1, capMonthly: -1 })).not.toBeNull();
    // percent is required on both percentage rules.
    expect(bad({ type: 'percent_of_growth' })).not.toBeNull();
    expect(bad({ type: 'percent_of_income' })).not.toBeNull();
    // Unknown rule type, and parameters attached to a rule that has none.
    expect(bad({ type: 'percent_of_terminal_value', percent: 0.1 })).not.toBeNull();
    expect(bad({ type: 'none', percent: 0.1 })).not.toBeNull();
    expect(bad({ type: 'continue', smoothingYears: 3 })).not.toBeNull();
    // Strict: a typo'd key must fail loudly rather than silently do nothing.
    expect(bad({ type: 'percent_of_growth', percent: 0.1, smoothingYrs: 3 })).not.toBeNull();
    expect(bad({ type: 'percent_of_income', percent: 0.05, capMonthly: 500 })).not.toBeNull();
    // 'amount' (note 19): monthly is required, non-negative, and capped; and
    // it takes no other parameters.
    expect(bad({ type: 'amount' })).not.toBeNull();
    expect(bad({ type: 'amount', monthly: -1 })).not.toBeNull();
    expect(bad({ type: 'amount', monthly: 1_000_001 })).not.toBeNull();
    expect(bad({ type: 'amount', monthly: '750' })).not.toBeNull();
    // 'tithe_account' (note 21): all three of percent, deferYears and
    // seedFromExistingGains are required — a rule missing the seed switch has
    // no defensible default, since the two answers differ by a lifetime of
    // gains.
    expect(bad({ type: 'tithe_account', percent: 0.1, deferYears: 8 })).not.toBeNull();
    expect(bad({ type: 'tithe_account', deferYears: 8, seedFromExistingGains: true })).not.toBeNull();
    expect(bad({ type: 'tithe_account', percent: 0.1, seedFromExistingGains: true })).not.toBeNull();
    // deferYears: a whole number of years, 0..30. 2035 is a year pasted in
    // where a COUNT of years belongs — the ceiling is there to catch it.
    const tithe = (over: Record<string, unknown>) =>
      bad({ type: 'tithe_account', percent: 0.1, deferYears: 8, seedFromExistingGains: true, ...over });
    expect(tithe({ deferYears: -1 })).not.toBeNull();
    expect(tithe({ deferYears: 31 })).not.toBeNull();
    expect(tithe({ deferYears: 2035 })).not.toBeNull();
    expect(tithe({ deferYears: 2.5 })).not.toBeNull();
    // percent is a fraction here too, and the mix must be a real allocation.
    expect(tithe({ percent: 10 })).not.toBeNull();
    expect(tithe({ allocation: { stocks: 0.5, bonds: 0.2, bills: 0.1 } })).not.toBeNull();
    // distributeYears: a COUNT of years, 1..30. 0 is refused outright — "over
    // no years" reads as instantly to one person and never to another — and
    // 2035 is a calendar year pasted where a count belongs.
    expect(tithe({ distributeYears: 0 })).not.toBeNull();
    expect(tithe({ distributeYears: 31 })).not.toBeNull();
    expect(tithe({ distributeYears: 2035 })).not.toBeNull();
    expect(tithe({ distributeYears: 2.5 })).not.toBeNull();
    // earlyRelease is a boolean, not a date or a year count.
    expect(tithe({ earlyRelease: 2031 })).not.toBeNull();
    expect(tithe({ earlyRelease: 'yes' })).not.toBeNull();
    // Strict: the parameters of the OTHER percentage rules are not smuggled in.
    expect(tithe({ smoothingYears: 3 })).not.toBeNull();
    expect(tithe({ capMonthly: 500 })).not.toBeNull();
    expect(tithe({ deferYrs: 8 })).not.toBeNull();
    expect(bad({ type: 'amount', monthly: 750, percent: 0.1 })).not.toBeNull();
    // A percentage typed into the amount rule's box is not a rule at all.
    expect(bad({ type: 'amount', percent: 0.1 })).not.toBeNull();
  });

  it('rejects out-of-bounds and malformed un-tithed pots', () => {
    const bad = (pot: unknown) => errorFor(scenario({ expenses: { untithedPot: pot } }));
    // holdYears is the one required field — the old deferYears, same bounds:
    // a whole number of years, 0..30. 2035 is a calendar year pasted where a
    // COUNT belongs, and the ceiling is there to catch it.
    expect(bad({})).not.toBeNull();
    expect(bad({ holdYears: -1 })).not.toBeNull();
    expect(bad({ holdYears: 31 })).not.toBeNull();
    expect(bad({ holdYears: 2035 })).not.toBeNull();
    expect(bad({ holdYears: 2.5 })).not.toBeNull();
    const pot = (over: Record<string, unknown>) => bad({ holdYears: 8, ...over });
    // percent is a fraction, not a percentage.
    expect(pot({ percent: 10 })).not.toBeNull();
    expect(pot({ percent: -0.1 })).not.toBeNull();
    // distributeYears keeps the bundle's 1..30 (0 is refused outright — "over
    // no years" reads as instantly to one person and never to another).
    expect(pot({ distributeYears: 0 })).not.toBeNull();
    expect(pot({ distributeYears: 31 })).not.toBeNull();
    expect(pot({ distributeYears: 2.5 })).not.toBeNull();
    // The hold switch is a closed enum; a typo'd verb must fail loudly rather
    // than silently leave the hold accruing.
    expect(pot({ ongoingDuringHold: 'give_case' })).not.toBeNull();
    expect(pot({ ongoingDuringHold: true })).not.toBeNull();
    // Booleans are booleans, the mix is a real allocation, and STRICT means
    // the bundle's old field names cannot ride along half-migrated.
    expect(pot({ earlyRelease: 2031 })).not.toBeNull();
    expect(pot({ seedFromGains: 'yes' })).not.toBeNull();
    expect(pot({ allocation: { stocks: 0.5, bonds: 0.2, bills: 0.1 } })).not.toBeNull();
    expect(pot({ deferYears: 8 })).not.toBeNull();
    expect(pot({ seedFromExistingGains: true })).not.toBeNull();
    // The disable form is exactly { enabled: false } — nothing rides with it,
    // and enabled must be a literal boolean.
    expect(bad({ enabled: false, holdYears: 8 })).not.toBeNull();
    expect(bad({ enabled: 'no' })).not.toBeNull();
  });

  it('accepts the retirement-income override and rejects anything else there (note 19)', () => {
    expect(errorFor(scenario({ income: { retirementMonthly: 2000 } }))).toBeNull();
    expect(errorFor(scenario({ income: { retirementMonthly: 0 } }))).toBeNull();
    expect(errorFor(scenario({ income: { retirementIncomeTaxable: false } }))).toBeNull();
    expect(
      errorFor(scenario({ income: { retirementMonthly: 2000, retirementIncomeTaxable: true } })),
    ).toBeNull();
    expect(errorFor(scenario({ income: {} }))).toBeNull();
    // Coexists with the expense override — one plan, both sides of the sheet.
    expect(
      errorFor(
        scenario({
          expenses: { livingMonthlyRetired: 7000 },
          income: { retirementMonthly: 2000 },
        }),
      ),
    ).toBeNull();

    // Bounds and types.
    expect(errorFor(scenario({ income: { retirementMonthly: -1 } }))).toContain(
      'retirementMonthly',
    );
    expect(errorFor(scenario({ income: { retirementMonthly: 1_000_001 } }))).toContain(
      'retirementMonthly',
    );
    expect(errorFor(scenario({ income: { retirementIncomeTaxable: 'yes' } }))).toContain(
      'retirementIncomeTaxable',
    );
    // Strict, and deliberately narrow: salaries and 401(k) contributions are
    // profile facts, not plan knobs.
    expect(errorFor(scenario({ income: { salaries: { p1: 150000 } } }))).not.toBeNull();
    expect(errorFor(scenario({ income: { contribution401k: 24000 } }))).not.toBeNull();
    expect(errorFor(scenario({ income: { retirementMontly: 2000 } }))).not.toBeNull();
  });

  it('rejects unknown keys nested inside deterministicReal / expenseRatios', () => {
    expect(
      errorFor(
        scenario({
          market: { deterministicReal: { stocks: 0.05, bonds: 0.02, bills: 0, gold: 0.1 } },
        }),
      ),
    ).not.toBeNull();
    expect(
      errorFor(
        scenario({ market: { expenseRatios: { stocks: 0.001, bonds: 0.001, bills: 0, crypto: 0 } } }),
      ),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Profile schema: joint ownership + expense streams
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Deep-cloned new-shape starter profile as the base for mutations. */
function starterProfile(): Record<string, any> {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'data-defaults', 'profile.starter.json'), 'utf8'),
  ) as Record<string, any>;
}

function profileErrorFor(value: unknown): string | null {
  const res = profileSchema.safeParse(value);
  return res.success ? null : formatZodError(res.error);
}

describe('scenario autoSepp (absent means ON)', () => {
  it('accepts true, false, and absent — and absent parses to undefined, not false', () => {
    expect(errorFor({ name: 'x', events: [], autoSepp: true })).toBeNull();
    expect(errorFor({ name: 'x', events: [], autoSepp: false })).toBeNull();
    expect(errorFor({ name: 'x', events: [] })).toBeNull();
    // The engine reads `autoSepp !== false`, so an absent field MUST stay
    // undefined: a scenario saved before the field existed is opted IN.
    const parsed = scenarioSchema.parse({ name: 'x', events: [] });
    expect(parsed.autoSepp).toBeUndefined();
    expect(parsed.autoSepp !== false).toBe(true);
    expect(scenarioSchema.parse({ name: 'x', events: [], autoSepp: false }).autoSepp).toBe(false);
  });

  it('rejects a non-boolean', () => {
    expect(errorFor({ name: 'x', events: [], autoSepp: 'yes' })).toMatch(/autoSepp/);
    expect(errorFor({ name: 'x', events: [], autoSepp: 1 })).toMatch(/autoSepp/);
  });
});

describe('scenario housing plan (the move as configuration)', () => {
  /** A complete, in-bounds plan; individual tests drop or corrupt one field. */
  const plan = (over?: Record<string, unknown>) => ({
    name: 'x',
    events: [],
    housing: {
      sellDate: '2027-06',
      rentMonths: 12,
      rentMonthly: 3000,
      purchasePrice: 900000,
      propertyTaxAnnual: 7500,
      financing: { type: 'cash' },
      ...over,
    },
  });

  it('accepts a minimal plan, both financings, and no plan at all', () => {
    expect(errorFor({ name: 'x', events: [] })).toBeNull();
    expect(errorFor(plan())).toBeNull();
    expect(errorFor(plan({ financing: { type: 'mortgage' } }))).toBeNull();
    expect(
      errorFor(plan({ financing: { type: 'mortgage', downPct: 0.1, rate: 0.055, termYears: 15 } })),
    ).toBeNull();
    // rentMonths 0 (sell and buy the same month) is a plan, not a mistake.
    expect(errorFor(plan({ rentMonths: 0, rentMonthly: 0 }))).toBeNull();
    expect(errorFor(plan({ appreciationRate: 0.03, insuranceAnnual: 3125 }))).toBeNull();
  });

  it('leaves the engine defaults ABSENT after parsing — the mortgage rate stays live', () => {
    /*
     * The single most important property of this schema. If the down payment,
     * the note rate, the term or the insurance premium were `.default()`ed
     * here, the first save would freeze today's 6.67% PMMS rate into the file
     * and a later correction to DEFAULT_MORTGAGE_RATE would silently miss every
     * scenario the user had already written.
     */
    const parsed = scenarioSchema.parse(plan({ financing: { type: 'mortgage' } }));
    const financing = parsed.housing!.financing as { type: string; [k: string]: unknown };
    expect(financing.type).toBe('mortgage');
    expect(financing.downPct).toBeUndefined();
    expect(financing.rate).toBeUndefined();
    expect(financing.termYears).toBeUndefined();
    expect(parsed.housing!.insuranceAnnual).toBeUndefined();
    expect(parsed.housing!.appreciationRate).toBeUndefined();
  });

  it('requires the fields that have no honest default', () => {
    // A sale date, a rental length, a rent, a price, a property-tax bill and a
    // financing choice: the engine cannot guess any of these.
    for (const field of [
      'sellDate',
      'rentMonths',
      'rentMonthly',
      'purchasePrice',
      'propertyTaxAnnual',
      'financing',
    ]) {
      const p = plan();
      delete (p.housing as Record<string, unknown>)[field];
      expect(errorFor(p), `housing.${field} should be required`).toMatch(new RegExp(field));
    }
  });

  it('round-trips the survivor purchase price, and keeps ABSENT meaning "the plan price"', () => {
    // Both spellings survive a parse — the field is what the widow sweep reads,
    // so a save/load that stripped it would silently restore the 62.7%-style
    // "she executes his purchase" modelling the field exists to correct.
    expect(errorFor(plan({ survivorPurchasePrice: 900000 }))).toBeNull();
    expect(errorFor(plan({ survivorPurchasePrice: 'sale_proceeds' }))).toBeNull();
    expect(
      scenarioSchema.parse(plan({ survivorPurchasePrice: 900000 })).housing!.survivorPurchasePrice,
    ).toBe(900000);
    // 0 is in bounds, same as purchasePrice (the engine folds it into the
    // "0 is the same statement as 'none'" rule).
    expect(errorFor(plan({ survivorPurchasePrice: 0 }))).toBeNull();
    // Absent stays absent — no .default() may ever write the plan price into
    // the file, or "did the user state a survivor price?" becomes unanswerable.
    expect(scenarioSchema.parse(plan()).housing!.survivorPurchasePrice).toBeUndefined();
  });

  it('rejects a survivor price that is negative, "none", or junk', () => {
    expect(errorFor(plan({ survivorPurchasePrice: -1 }))).toMatch(/survivorPurchasePrice/);
    // 'none' is a different plan (sell and never buy), not a survivor price.
    expect(errorFor(plan({ survivorPurchasePrice: 'none' }))).toMatch(/survivorPurchasePrice/);
    expect(errorFor(plan({ survivorPurchasePrice: 'proceeds' }))).toMatch(/survivorPurchasePrice/);
  });

  it('round-trips the survivor downsize pair, and keeps ABSENT meaning "she keeps the house"', () => {
    // Both spellings survive a parse — the pair is what the widow sweep reads
    // for a POST-purchase death, so a save/load that stripped it would
    // silently restore the staying-put widow the field exists to correct.
    expect(errorFor(plan({ survivorDownsizeTo: 1450000 }))).toBeNull();
    expect(errorFor(plan({ survivorDownsizeTo: 'none' }))).toBeNull();
    expect(errorFor(plan({ survivorDownsizeTo: 1450000, survivorDownsizeDelayMonths: 0 }))).toBeNull();
    const parsed = scenarioSchema.parse(
      plan({ survivorDownsizeTo: 1450000, survivorDownsizeDelayMonths: 3 }),
    ).housing!;
    expect(parsed.survivorDownsizeTo).toBe(1450000);
    expect(parsed.survivorDownsizeDelayMonths).toBe(3);
    // 0 is in bounds (the engine folds it into the "0 is the same statement
    // as 'none'" rule), and unlike the survivor PRICE, 'none' is legitimate
    // here: selling and never rebuying is a real answer for a house she
    // already owns.
    expect(errorFor(plan({ survivorDownsizeTo: 0 }))).toBeNull();
    // Absent stays absent, delay included — no .default() may ever write 12
    // into the file, or a later correction to the engine default would
    // silently miss every plan already saved.
    const bare = scenarioSchema.parse(plan()).housing!;
    expect(bare.survivorDownsizeTo).toBeUndefined();
    expect(bare.survivorDownsizeDelayMonths).toBeUndefined();
  });

  it('rejects a downsize that is negative, junk, or on a fractional/negative delay', () => {
    expect(errorFor(plan({ survivorDownsizeTo: -1 }))).toMatch(/survivorDownsizeTo/);
    // 'sale_proceeds' is the survivor PRICE's spelling; a downsize is either
    // a number or 'none'.
    expect(errorFor(plan({ survivorDownsizeTo: 'sale_proceeds' }))).toMatch(/survivorDownsizeTo/);
    expect(errorFor(plan({ survivorDownsizeTo: 1450000, survivorDownsizeDelayMonths: -1 }))).toMatch(
      /survivorDownsizeDelayMonths/,
    );
    expect(errorFor(plan({ survivorDownsizeTo: 1450000, survivorDownsizeDelayMonths: 2.5 }))).toMatch(
      /survivorDownsizeDelayMonths/,
    );
  });

  it('rejects out-of-band numbers and malformed dates', () => {
    expect(errorFor(plan({ sellDate: 'June 2027' }))).toMatch(/sellDate/);
    expect(errorFor(plan({ rentMonths: 12.5 }))).toMatch(/rentMonths/);
    expect(errorFor(plan({ rentMonths: -1 }))).toMatch(/rentMonths/);
    expect(errorFor(plan({ rentMonthly: -100 }))).toMatch(/rentMonthly/);
    expect(errorFor(plan({ purchasePrice: -1 }))).toMatch(/purchasePrice/);
    expect(errorFor(plan({ insuranceAnnual: -1 }))).toMatch(/insuranceAnnual/);
    // 40%/yr home appreciation is a typo, not a plan.
    expect(errorFor(plan({ appreciationRate: 0.4 }))).toMatch(/appreciationRate/);
    expect(errorFor(plan({ appreciationRate: -0.5 }))).toMatch(/appreciationRate/);
    expect(errorFor(plan({ financing: { type: 'mortgage', downPct: 1.5 } }))).toMatch(/downPct/);
    expect(errorFor(plan({ financing: { type: 'mortgage', rate: 0.4 } }))).toMatch(/rate/);
    expect(errorFor(plan({ financing: { type: 'mortgage', termYears: 0 } }))).toMatch(/termYears/);
    expect(errorFor(plan({ financing: { type: 'lease_to_own' } }))).toMatch(/financing/);
  });

  it('accepts a scheduled payoff strictly inside the term, and keeps ABSENT meaning "full term"', () => {
    expect(errorFor(plan({ financing: { type: 'mortgage', payoffAfterYears: 5 } }))).toBeNull();
    // 29 against the DEFAULT term: the widest value the 1..29 bounds allow,
    // and it sits inside the engine's 30-year default by construction.
    expect(errorFor(plan({ financing: { type: 'mortgage', payoffAfterYears: 29 } }))).toBeNull();
    expect(
      errorFor(plan({ financing: { type: 'mortgage', termYears: 15, payoffAfterYears: 14 } })),
    ).toBeNull();
    // Absent stays absent after a parse — same live-default rule as the rate.
    const parsed = scenarioSchema.parse(plan({ financing: { type: 'mortgage' } }));
    expect(
      (parsed.housing!.financing as { payoffAfterYears?: number }).payoffAfterYears,
    ).toBeUndefined();
  });

  it('rejects a payoff at/past a STATED term, and out-of-band values', () => {
    // At maturity there is no principal left to pay off — the schema says so
    // whenever the term is stated (a violation against the absent-term default
    // is unstatable: 29 < 30 by the bounds alone).
    expect(
      errorFor(plan({ financing: { type: 'mortgage', termYears: 15, payoffAfterYears: 15 } })),
    ).toMatch(/payoffAfterYears/);
    expect(
      errorFor(plan({ financing: { type: 'mortgage', termYears: 10, payoffAfterYears: 20 } })),
    ).toMatch(/payoffAfterYears/);
    expect(errorFor(plan({ financing: { type: 'mortgage', payoffAfterYears: 0 } }))).toMatch(
      /payoffAfterYears/,
    );
    expect(errorFor(plan({ financing: { type: 'mortgage', payoffAfterYears: 30 } }))).toMatch(
      /payoffAfterYears/,
    );
    expect(errorFor(plan({ financing: { type: 'mortgage', payoffAfterYears: 2.5 } }))).toMatch(
      /payoffAfterYears/,
    );
  });

  it('applies the same payoff rules to a hand-written buy_house event', () => {
    const withFinancing = (financing: unknown) => ({
      name: 'x',
      events: [
        {
          type: 'buy_house',
          date: '2028-06',
          price: 500000,
          financing,
          propertyTaxAnnual: 0,
          insuranceAnnual: 0,
        },
      ],
    });
    expect(
      errorFor(withFinancing({ downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 5 })),
    ).toBeNull();
    // The event's term is REQUIRED, so "strictly inside the term" is always
    // expressible — and enforced — at the schema level here.
    expect(
      errorFor(withFinancing({ downPct: 0.2, rate: 0.06, termYears: 15, payoffAfterYears: 15 })),
    ).toMatch(/payoffAfterYears/);
    expect(
      errorFor(withFinancing({ downPct: 0.2, rate: 0.06, termYears: 30, payoffAfterYears: 0 })),
    ).toMatch(/payoffAfterYears/);
  });
});

describe('profile schema: starter profile and joint ownership', () => {
  it('accepts the shipped starter profile (joint brokerage + savings included)', () => {
    const p = starterProfile();
    expect(profileErrorFor(p)).toBeNull();
    // Sanity: the starter really exercises the joint path.
    const owners = p.accounts.map((a: { id: string; owner: string }) => [a.id, a.owner]);
    expect(owners).toContainEqual(['brokerage', 'joint']);
    expect(owners).toContainEqual(['savings', 'joint']);
  });

  it("rejects owner 'joint' on retirement accounts with the individually-owned-by-law message", () => {
    for (const id of ['k401', 'ira1', 'roth1']) {
      const p = starterProfile();
      const account = p.accounts.find((a: { id: string }) => a.id === id);
      account.owner = 'joint';
      const err = profileErrorFor(p);
      expect(err, id).not.toBeNull();
      expect(err, id).toContain('individually owned by law');
    }
  });

  it('keeps lifetimeContributions on the account, and validates it (note 21)', () => {
    /*
     * accountSchema is a plain z.object, so it STRIPS keys it does not know
     * rather than rejecting them. A field the UI writes but the schema has
     * never heard of therefore vanishes on save, silently and without an
     * error — which is exactly how the Tithe Account's seed would end up
     * reading "unknown" forever. This test is the guard against that.
     */
    const p = starterProfile();
    const ira = p.accounts.find((a: { id: string }) => a.id === 'ira1');
    ira.lifetimeContributions = 812_345;
    expect(profileErrorFor(p)).toBeNull();
    const parsed = profileSchema.parse(p);
    const round = parsed.accounts.find((a) => a.id === 'ira1')!;
    expect(round.lifetimeContributions).toBe(812_345);

    // Absent is legal and means UNKNOWN — it must not be defaulted to 0, or
    // the seed would read a career of contributions as pure gain.
    const q = starterProfile();
    expect(profileErrorFor(q)).toBeNull();
    const noneParsed = profileSchema.parse(q);
    expect(noneParsed.accounts.every((a) => a.lifetimeContributions === undefined)).toBe(true);

    // Not capped at the balance — a lifetime of contributions can legitimately
    // exceed a balance that a bad decade shrank — but never negative, and
    // never a string.
    const r = starterProfile();
    r.accounts.find((a: { id: string }) => a.id === 'ira1').lifetimeContributions = 10_000_000;
    expect(profileErrorFor(r)).toBeNull();
    const bad = starterProfile();
    bad.accounts.find((a: { id: string }) => a.id === 'ira1').lifetimeContributions = -1;
    expect(profileErrorFor(bad)).toContain('lifetimeContributions');
    const worse = starterProfile();
    worse.accounts.find((a: { id: string }) => a.id === 'ira1').lifetimeContributions = '400000';
    expect(profileErrorFor(worse)).toContain('lifetimeContributions');
  });

  it('requires an account name', () => {
    const p = starterProfile();
    delete p.accounts[0].name;
    expect(profileErrorFor(p)).toContain('name');
    p.accounts[0].name = '';
    expect(profileErrorFor(p)).toContain('name');
  });

  it('requires both PIA fields on a person', () => {
    const p = starterProfile();
    delete p.people[0].piaMonthlyAtFraIfStoppingNow;
    expect(profileErrorFor(p)).toContain('piaMonthlyAtFraIfStoppingNow');
    const q = starterProfile();
    q.people[0].piaMonthlyAtFraIfWorkingTo62 = -1;
    expect(profileErrorFor(q)).toContain('piaMonthlyAtFraIfWorkingTo62');
  });
});

describe('profile schema: expense streams', () => {
  it('accepts the three monthly streams at 0 and positive values', () => {
    const p = starterProfile();
    p.expenses = { livingMonthly: 0, charitableMonthly: 0, investingMonthly: 0 };
    expect(profileErrorFor(p)).toBeNull();
    p.expenses = { livingMonthly: 6000, charitableMonthly: 250, investingMonthly: 1500 };
    expect(profileErrorFor(p)).toBeNull();
  });

  it('rejects negative stream values, naming the field', () => {
    for (const field of [
      'livingMonthly',
      'livingMonthlyRetired',
      'charitableMonthly',
      'investingMonthly',
      'investingMonthlyRetired',
    ]) {
      const p = starterProfile();
      p.expenses[field] = -1;
      const err = profileErrorFor(p);
      expect(err, field).not.toBeNull();
      expect(err, field).toContain(field);
    }
  });

  it('accepts the retired half of each pair, and none at all (note 19)', () => {
    // Absent is the shipped shape: living defaults to the working figure,
    // investing to 0.
    const p = starterProfile();
    expect(p.expenses.livingMonthlyRetired).toBeUndefined();
    expect(p.expenses.investingMonthlyRetired).toBeUndefined();
    expect(profileErrorFor(p)).toBeNull();

    const q = starterProfile();
    q.expenses = {
      livingMonthly: 8200,
      livingMonthlyRetired: 7200,
      charitableMonthly: 2300,
      investingMonthly: 1250,
      investingMonthlyRetired: 0,
    };
    expect(profileErrorFor(q)).toBeNull();
    // A retired figure ABOVE the working one is legal — retirement can cost
    // more (travel, health, a second home), and the schema must not moralize.
    const r = starterProfile();
    r.expenses.livingMonthlyRetired = r.expenses.livingMonthly + 2000;
    expect(profileErrorFor(r)).toBeNull();
  });

  it('accepts the retirement income stream, and none at all (note 19)', () => {
    const p = starterProfile();
    expect(p.income.retirementMonthly).toBeUndefined(); // absent = 0
    expect(p.income.retirementIncomeTaxable).toBeUndefined(); // absent = taxable
    expect(profileErrorFor(p)).toBeNull();

    for (const income of [
      { retirementMonthly: 0 },
      { retirementMonthly: 2500 },
      { retirementMonthly: 2500, retirementIncomeTaxable: false },
      { retirementIncomeTaxable: true },
    ]) {
      const q = starterProfile();
      Object.assign(q.income, income);
      expect(profileErrorFor(q), JSON.stringify(income)).toBeNull();
    }

    const bad = starterProfile();
    bad.income.retirementMonthly = -1;
    expect(profileErrorFor(bad)).toContain('retirementMonthly');
    const worse = starterProfile();
    worse.income.retirementIncomeTaxable = 'sometimes';
    expect(profileErrorFor(worse)).toContain('retirementIncomeTaxable');
  });

  it('accepts every retirementGiving rule on the profile, and none at all (note 18)', () => {
    const p = starterProfile();
    expect(p.expenses.retirementGiving).toBeUndefined(); // absent = 'continue'
    expect(profileErrorFor(p)).toBeNull();
    for (const rule of [
      { type: 'continue' },
      { type: 'none' },
      { type: 'percent_of_growth', percent: 0.1 },
      { type: 'percent_of_growth', percent: 0.1, smoothingYears: 3, capMonthly: 2000 },
      { type: 'percent_of_income', percent: 0.05 },
      { type: 'amount', monthly: 750 },
      { type: 'amount', monthly: 0 },
      { type: 'tithe_account', percent: 0.1, deferYears: 8, seedFromExistingGains: true },
      {
        type: 'tithe_account',
        percent: 0.1,
        deferYears: 0,
        seedFromExistingGains: false,
        allocation: { stocks: 0.6, bonds: 0.4, bills: 0 },
      },
    ]) {
      const q = starterProfile();
      q.expenses.retirementGiving = rule;
      expect(profileErrorFor(q), JSON.stringify(rule)).toBeNull();
    }
  });

  it('rejects a malformed retirementGiving rule on the profile, naming the field', () => {
    const p = starterProfile();
    p.expenses.retirementGiving = { type: 'percent_of_growth', percent: 5 };
    const err = profileErrorFor(p);
    expect(err).not.toBeNull();
    expect(err).toContain('retirementGiving');
    const q = starterProfile();
    q.expenses.retirementGiving = { type: 'tithe_on_vibes' };
    expect(profileErrorFor(q)).toContain('retirementGiving');
    // 'amount' with no amount is the likeliest typo of all (note 19).
    const r = starterProfile();
    r.expenses.retirementGiving = { type: 'amount' };
    expect(profileErrorFor(r)).toContain('retirementGiving');
    // A tithe rule that forgot to say whether it seeds (note 21).
    const t = starterProfile();
    t.expenses.retirementGiving = { type: 'tithe_account', percent: 0.1, deferYears: 8 };
    expect(profileErrorFor(t)).toContain('retirementGiving');
  });

  it('rejects the old annualBaseline shape (missing streams)', () => {
    const p = starterProfile();
    p.expenses = { annualBaseline: 72000 };
    const err = profileErrorFor(p);
    expect(err).not.toBeNull();
    expect(err).toContain('livingMonthly');
  });

  it('bounds the renting cell like every other monthly cell, and keeps absent absent (note 23)', () => {
    const withLine = (line: Record<string, unknown>): Record<string, any> => {
      const p = starterProfile();
      p.expenses.lines = [{ id: 'oil', label: 'Heating oil', category: 'living', ...line }];
      return p;
    };
    // 0 is a decision ("zero in an apartment") and must parse; so must a
    // plain positive figure, and a line that says nothing.
    expect(profileErrorFor(withLine({ monthlyNow: 200, monthlyRenting: 0 }))).toBeNull();
    expect(profileErrorFor(withLine({ monthlyNow: 200, monthlyRenting: 95 }))).toBeNull();
    expect(profileErrorFor(withLine({ monthlyNow: 200 }))).toBeNull();
    // Same bounds as monthlyNow / monthlyRetired: no negatives, no
    // million-a-month typos, no strings.
    expect(profileErrorFor(withLine({ monthlyNow: 200, monthlyRenting: -1 }))).toContain(
      'monthlyRenting',
    );
    expect(profileErrorFor(withLine({ monthlyNow: 200, monthlyRenting: 2_000_000 }))).toContain(
      'monthlyRenting',
    );
    expect(profileErrorFor(withLine({ monthlyNow: 200, monthlyRenting: 'none' }))).toContain(
      'monthlyRenting',
    );
    // Absent stays ABSENT after parsing — absence is the inherit signal, and a
    // schema that filled it in would turn every line into a typed decision.
    const parsed = profileSchema.parse(withLine({ monthlyNow: 200 })) as any;
    expect('monthlyRenting' in parsed.expenses.lines[0]).toBe(false);
  });
});

describe('profile schema: health', () => {
  it('requires a non-negative employerPremiumShareMonthly', () => {
    const p = starterProfile();
    delete p.health.employerPremiumShareMonthly;
    expect(profileErrorFor(p)).toContain('employerPremiumShareMonthly');
    p.health.employerPremiumShareMonthly = -5;
    expect(profileErrorFor(p)).toContain('employerPremiumShareMonthly');
  });

  it("limits pretaxPreference to 'ira_first' | 'proportional'", () => {
    const p = starterProfile();
    p.settings.withdrawalPolicy.pretaxPreference = 'rule_of_55_first';
    expect(profileErrorFor(p)).toContain('pretaxPreference');
  });
});

// ---------------------------------------------------------------------------
// The survivor: the `death` event, the widow_score solver, and the policy
// fields on both the profile and a scenario override
// ---------------------------------------------------------------------------

describe('the death event', () => {
  const death = (over?: Record<string, unknown>) => ({
    name: 'x',
    events: [{ type: 'death', person: 'p1', date: '2035-07', ...over }],
  });

  it('accepts the minimal form, and both optional knobs', () => {
    expect(errorFor(death())).toBeNull();
    expect(errorFor(death({ livingFraction: 0.6 }))).toBeNull();
    expect(errorFor(death({ survivorClaim: '2031-06' }))).toBeNull();
    expect(errorFor(death({ livingFraction: 1, survivorClaim: '2040-01' }))).toBeNull();
    // Absent knobs must stay ABSENT, not become 0 or a date: the engine reads
    // an absent livingFraction as DEFAULT_SURVIVOR_LIVING_FRACTION and an
    // absent survivorClaim as "the plan's own claim date", and a schema that
    // helpfully filled either in would silently overrule both defaults.
    const parsed = scenarioSchema.parse(death()) as any;
    expect(parsed.events[0].livingFraction).toBeUndefined();
    expect(parsed.events[0].survivorClaim).toBeUndefined();
  });

  it('bounds livingFraction to 0..1', () => {
    /*
     * A survivor who spends MORE than the couple did is a real situation —
     * paid care — but it is an EXPENSE, not a change in household size, and it
     * belongs in a one_time_expense or expense_change where it can be dated
     * and sized honestly rather than smeared across every remaining year.
     */
    expect(errorFor(death({ livingFraction: 1.2 }))).toMatch(/livingFraction/);
    expect(errorFor(death({ livingFraction: -0.1 }))).toMatch(/livingFraction/);
    expect(errorFor(death({ livingFraction: 'most' }))).toMatch(/livingFraction/);
  });

  it('requires a person and a well-formed month', () => {
    expect(errorFor({ name: 'x', events: [{ type: 'death', date: '2035-07' }] })).toMatch(/person/);
    expect(errorFor(death({ person: '' }))).toMatch(/person/);
    expect(errorFor({ name: 'x', events: [{ type: 'death', person: 'p1', date: '2035' }] })).toMatch(
      /date/,
    );
    expect(errorFor(death({ survivorClaim: 'soon' }))).toMatch(/survivorClaim/);
  });
});

describe('the widow_score solver', () => {
  const solver = (spec: Record<string, unknown>) => ({ name: 'x', events: [], solver: spec });

  it('accepts the bare form and every optional field', () => {
    expect(errorFor(solver({ type: 'widow_score' }))).toBeNull();
    expect(
      errorFor(
        solver({ type: 'widow_score', person: 'p1', from: 2027, to: 2045, step: 2, livingFraction: 0.7 }),
      ),
    ).toBeNull();
  });

  it('carries NO targetSuccess — the survivor is held to the household’s own bar', () => {
    /*
     * The whole point of the number is comparability: a plan at 95% household
     * and 64% widow is only alarming because both are read against one bar.
     * A widow-score run that could quietly lower its own target would erase
     * exactly the comparison the feature exists to make, so the field is not
     * merely unused — it is refused.
     */
    const parsed = scenarioSchema.parse(
      solver({ type: 'widow_score', targetSuccess: 0.5 }),
    ) as any;
    // The solver schemas are non-strict objects (as every other solver in the
    // union is), so a stray field is STRIPPED rather than rejected. What
    // matters is that it cannot survive parsing and therefore cannot reach
    // targetFor: the widow score always runs against the scenario's or the
    // profile's own success target.
    expect(parsed.solver).toEqual({ type: 'widow_score' });
    expect(parsed.solver.targetSuccess).toBeUndefined();
  });

  it('bounds the sweep step and rejects fractional years', () => {
    expect(errorFor(solver({ type: 'widow_score', step: 0 }))).toMatch(/step/);
    expect(errorFor(solver({ type: 'widow_score', step: 11 }))).toMatch(/step/);
    expect(errorFor(solver({ type: 'widow_score', from: 2027.5 }))).toMatch(/from/);
    expect(errorFor(solver({ type: 'widow_score', livingFraction: 2 }))).toMatch(/livingFraction/);
  });
});

describe('the life-insurance policy', () => {
  it('profile: face amount, term end and insured are all optional and bounded', () => {
    const p = starterProfile();
    p.expenses.lifeInsuranceMonthly = 320;
    p.expenses.lifeInsuranceDeathBenefit = 1_000_000;
    p.expenses.lifeInsuranceTermEnd = '2032-06';
    p.expenses.lifeInsuranceInsured = 'p1';
    expect(profileErrorFor(p)).toBeNull();

    // The ceiling exists to catch a premium pasted into the benefit box or a
    // stray zero on the policy that is the difference between a 64% widow
    // score and a 91% one.
    p.expenses.lifeInsuranceDeathBenefit = 100_000_001;
    expect(profileErrorFor(p)).toContain('lifeInsuranceDeathBenefit');
    p.expenses.lifeInsuranceDeathBenefit = -1;
    expect(profileErrorFor(p)).toContain('lifeInsuranceDeathBenefit');
    p.expenses.lifeInsuranceDeathBenefit = 1_000_000;
    p.expenses.lifeInsuranceTermEnd = '2032';
    expect(profileErrorFor(p)).toContain('lifeInsuranceTermEnd');
  });

  it('scenario override: the whole policy is a plan-level what-if', () => {
    /*
     * REGRESSION TEST FOR A REAL HOLE. AssumptionOverrides has declared
     * `lifeInsuranceMonthly` since the premium was added and simulate.ts has
     * always read it — but this strict schema never accepted it, so a plan
     * that tried to override the premium was rejected outright. "Five years of
     * term at retirement" is a question about a PLAN, not a fact about the
     * household: two scenarios must be able to disagree about the policy at
     * the same time, which is the entire mechanism behind "does the premium
     * buy enough widow score to be worth paying?".
     */
    expect(
      errorFor(
        scenario({
          expenses: {
            lifeInsuranceMonthly: 320,
            lifeInsuranceDeathBenefit: 1_000_000,
            lifeInsuranceTermEnd: '2032-06',
            lifeInsuranceInsured: 'p1',
          },
        }),
      ),
    ).toBeNull();
    // Still strict about the values themselves.
    expect(errorFor(scenario({ expenses: { lifeInsuranceDeathBenefit: -1 } }))).toMatch(
      /lifeInsuranceDeathBenefit/,
    );
    expect(errorFor(scenario({ expenses: { lifeInsuranceTermEnd: 'next June' } }))).toMatch(
      /lifeInsuranceTermEnd/,
    );
    // And still strict about unknown keys, which is what made the hole
    // detectable in the first place.
    expect(errorFor(scenario({ expenses: { lifeInsurancePremium: 320 } }))).not.toBeNull();
  });
});

describe('per-policy dispositions (lifeInsurancePolicyPlans)', () => {
  it('accepts each disposition, keyed by policy id', () => {
    expect(
      errorFor(
        scenario({
          expenses: {
            lifeInsurancePolicyPlans: {
              'term-a-2500k': 'keep_to_term',
              'term-b-1000k': 'cancel_at_retirement',
              other: 'cancel_now',
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it('accepts an id the profile does not list — renaming a policy must not invalidate saved plans', () => {
    // The schema cannot see the profile, and must not pretend to: an unknown
    // id is an engine no-op and a scenario-store WARNING, never a parse error.
    expect(
      errorFor(scenario({ expenses: { lifeInsurancePolicyPlans: { ghost: 'cancel_now' } } })),
    ).toBeNull();
  });

  it('rejects a disposition that is not one of the three verbs', () => {
    // A typo'd verb silently kept as "whatever" would be the inert-input bug
    // again — the plan would claim a cancellation the engine never applies.
    expect(
      errorFor(scenario({ expenses: { lifeInsurancePolicyPlans: { termA: 'cancel' } } })),
    ).toMatch(/lifeInsurancePolicyPlans/);
    expect(
      errorFor(scenario({ expenses: { lifeInsurancePolicyPlans: { termA: true } } })),
    ).toMatch(/lifeInsurancePolicyPlans/);
  });

  it('rejects a map that is not a map', () => {
    expect(
      errorFor(scenario({ expenses: { lifeInsurancePolicyPlans: ['cancel_now'] } })),
    ).not.toBeNull();
    expect(
      errorFor(scenario({ expenses: { lifeInsurancePolicyPlans: 'cancel_now' } })),
    ).not.toBeNull();
  });
});

describe('profile filing status', () => {
  it("accepts 'single' for a genuinely single household — a widow does NOT get here", () => {
    /*
     * A survivor's single status comes from a `death` event and is resolved
     * per YEAR by the engine (the year of death is still a joint return), not
     * by editing this field. The enum is widened so a one-person household can
     * use the planner at all, and for no other reason.
     */
    const p = starterProfile();
    p.filing.status = 'single';
    expect(profileErrorFor(p)).toBeNull();
    p.filing.status = 'mfs';
    expect(profileErrorFor(p)).toContain('status');
  });
});

describe('profile schema: holdings mode', () => {
  const withHoldings = (
    holdings: unknown,
    cash?: unknown,
  ): Record<string, any> => {
    const p = starterProfile();
    const ira = p.accounts.find((a: { id: string }) => a.id === 'ira1');
    ira.holdings = holdings;
    if (cash !== undefined) ira.cash = cash;
    return p;
  };

  it('accepts a holdings account with fractional shares and cash', () => {
    const p = withHoldings(
      [
        { symbol: 'VTI', quantity: 1838.501, assetClass: 'stocks' },
        { symbol: 'BND', quantity: 7206, assetClass: 'bonds' },
      ],
      63.41,
    );
    expect(profileErrorFor(p)).toBeNull();
    // Round-trip: a plain z.object STRIPS unknown keys, so a field the schema
    // has never heard of vanishes on save — the lifetimeContributions lesson.
    const parsed = profileSchema.parse(p);
    const ira = parsed.accounts.find((a) => a.id === 'ira1')!;
    expect(ira.holdings).toHaveLength(2);
    expect(ira.holdings![0].quantity).toBe(1838.501);
    expect(ira.cash).toBe(63.41);
  });

  it('accepts the separators real tickers use, and only those', () => {
    for (const symbol of ['VTI', 'BRK.B', '^GSPC', 'BF-B', 'VTTHX', 'A1B2C3D4E5']) {
      const p = withHoldings([{ symbol, quantity: 1, assetClass: 'stocks' }]);
      expect(profileErrorFor(p), symbol).toBeNull();
    }
    for (const symbol of ['vti', 'VTI ', 'TOOLONGSYMBOL', 'V TI', 'VTI$', '']) {
      const p = withHoldings([{ symbol, quantity: 1, assetClass: 'stocks' }]);
      expect(profileErrorFor(p), JSON.stringify(symbol)).toContain('symbol');
    }
  });

  it('rejects zero, negative and non-finite quantities — fractional is fine', () => {
    for (const quantity of [0, -1, -0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = withHoldings([{ symbol: 'VTI', quantity, assetClass: 'stocks' }]);
      expect(profileErrorFor(p), String(quantity)).toContain('quantity');
    }
    expect(
      profileErrorFor(withHoldings([{ symbol: 'VTI', quantity: 0.001, assetClass: 'stocks' }])),
    ).toBeNull();
  });

  it('rejects negative cash, and cash on a manual account', () => {
    expect(profileErrorFor(withHoldings([], -1))).toContain('cash');
    // cash without holdings: on a manual account the balance already includes
    // any cash — a second figure would be a number nothing reads.
    const p = starterProfile();
    p.accounts.find((a: { id: string }) => a.id === 'savings').cash = 500;
    expect(profileErrorFor(p)).toContain('cash');
  });

  it('rejects an unknown asset class and a typo’d holding key', () => {
    expect(
      profileErrorFor(withHoldings([{ symbol: 'VTI', quantity: 1, assetClass: 'crypto' }])),
    ).toContain('assetClass');
    expect(
      profileErrorFor(
        withHoldings([{ symbol: 'VTI', quantity: 1, assetClass: 'stocks', shares: 2 }]),
      ),
    ).not.toBeNull();
  });

  it('keeps balance and allocation REQUIRED on a holdings account', () => {
    /*
     * They are the resolved cache the engine reads unconditionally — the
     * resolution chokepoint overwrites them, but a file without them would
     * make every unresolved read (a folder with no quotes yet) crash the
     * arithmetic instead of running on last-known values.
     */
    const p = withHoldings([{ symbol: 'VTI', quantity: 1, assetClass: 'stocks' }]);
    delete p.accounts.find((a: { id: string }) => a.id === 'ira1').balance;
    expect(profileErrorFor(p)).toContain('balance');
  });
});

describe('the recorded score on a net-worth row', () => {
  /**
   * The score block is OPTIONAL and the conditions inside it are REQUIRED: a
   * stored number without the conditions it was computed under has no scale,
   * and this one is plotted on a line that claims all its points share one.
   *
   * What it points AT is a different matter. `planHash` is optional and always
   * will be, because rows recorded while a separate frozen "baseline plan"
   * existed name that instead — those numbers are historical facts already on
   * the chart, and a schema that refused them would not delete them, it would
   * take the whole ledger down with them.
   */
  const row = (over: Record<string, unknown> = {}): unknown => ({
    id: 'nw-1',
    takenAt: '2026-08-19T09:43:20.873Z',
    total: 1_845_704.45,
    homeValue: 550_000,
    accounts: [{ id: 'savings', name: 'Savings', balance: 31_400.18 }],
    prices: { VTI: { price: 379.04, asOf: '2026-08-18T20:00:00.000Z' } },
    ...over,
  });

  const score = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    success: 0.941,
    mode: 'montecarlo',
    paths: 10_000,
    seed: 12_345,
    engineVersion: '1.21.0',
    planHash: 'a'.repeat(64),
    scoredAt: '2026-08-19T09:45:00.000Z',
    ...over,
  });

  /** Exactly the shape of a representative recorded score, field for field. */
  const baselineEraScore = (): Record<string, unknown> => ({
    success: 0.942,
    medianTerminalReal: 1_318_402.556133024,
    mode: 'montecarlo',
    paths: 10_000,
    seed: 20260812,
    engineVersion: '1.21.0',
    baselineRevision: 1,
    baselineHash: '7ff9a75c12f24aa17af4d8fc64dc89d9ce8b7ba62e202a6baa0132fe26b5687e',
    baselineLabel: 'Verifier r1 — live plan 2026-08-19',
    planDriftedFromBaseline: false,
    scoredAt: '2026-08-19T12:51:53.390Z',
  });

  const ledgerErrorFor = (value: unknown): string | null => {
    const res = netWorthFileSchema.safeParse(value);
    return res.success ? null : formatZodError(res.error);
  };

  it('parses a row written before scoring existed — as NOT SCORED, not as broken', () => {
    // The user's first real snapshot has exactly this shape.
    expect(ledgerErrorFor([row()])).toBeNull();
    const [parsed] = netWorthFileSchema.parse([row()]);
    expect(parsed.score).toBeUndefined();
    expect(parsed.scoreError).toBeUndefined();
  });

  it('accepts a score of the plan and keeps what it points at', () => {
    const [parsed] = netWorthFileSchema.parse([
      row({ score: score({ planHistoryId: 'ph-abc123' }) }),
    ]);
    expect(parsed.score?.planHash).toBe('a'.repeat(64));
    expect(parsed.score?.planHistoryId).toBe('ph-abc123');
    expect(parsed.score?.engineVersion).toBe('1.21.0');
  });

  it('still parses the baseline-era score already in the ledger, whole', () => {
    // A number recorded against a frozen baseline is a historical fact about a
    // point already on the chart. It keeps its own words: the revision, the
    // hash and the label it was scored under, and whether the plan being
    // edited had drifted at the time.
    expect(ledgerErrorFor([row({ score: baselineEraScore() })])).toBeNull();
    const [parsed] = netWorthFileSchema.parse([row({ score: baselineEraScore() })]);
    expect(parsed.score?.baselineRevision).toBe(1);
    expect(parsed.score?.baselineLabel).toBe('Verifier r1 — live plan 2026-08-19');
    expect(parsed.score?.planDriftedFromBaseline).toBe(false);
    // And it does not gain a plan identity it never had.
    expect(parsed.score?.planHash).toBeUndefined();
  });

  it('rejects a score missing any condition that decides comparability', () => {
    for (const key of ['mode', 'paths', 'seed', 'engineVersion', 'scoredAt']) {
      const partial = score();
      delete partial[key];
      expect(ledgerErrorFor([row({ score: partial })]), key).toContain(key);
    }
  });

  it('bounds success to the engine’s own units — 0..1, never a percentage', () => {
    // 94.1 typed where 0.941 belongs would draw a point 100x off the axis.
    expect(ledgerErrorFor([row({ score: score({ success: 94.1 }) })])).toContain('success');
    expect(ledgerErrorFor([row({ score: score({ success: -0.1 }) })])).toContain('success');
    expect(ledgerErrorFor([row({ score: score({ success: 0 }) })])).toBeNull();
    expect(ledgerErrorFor([row({ score: score({ success: 1 }) })])).toBeNull();
  });

  it('refuses a baseline revision below 1 — revisions started at 1 and only went forward', () => {
    expect(ledgerErrorFor([row({ score: score({ baselineRevision: 0 }) })])).toContain(
      'baselineRevision',
    );
    expect(ledgerErrorFor([row({ score: score({ baselineRevision: 1.5 }) })])).toContain(
      'baselineRevision',
    );
  });

  it('keeps a failure reason as text, and bounds it — the ledger is not a log', () => {
    expect(ledgerErrorFor([row({ scoreError: 'The simulation failed: code 3' })])).toBeNull();
    expect(ledgerErrorFor([row({ scoreError: 'x'.repeat(1001) })])).toContain('scoreError');
  });
});

describe('the plan’s history file', () => {
  const entry = (over: Record<string, unknown> = {}): unknown => ({
    id: 'ph-abc123',
    takenAt: '2026-08-20T09:00:00.000Z',
    kind: 'day-start',
    plan: { name: 'Plan', events: [] },
    planHash: 'b'.repeat(64),
    ...over,
  });

  const errorForFile = (value: unknown): string | null => {
    const res = planHistoryFileSchema.safeParse(value);
    return res.success ? null : formatZodError(res.error);
  };

  it('accepts a filed version with its moment, its kind and its fingerprint', () => {
    expect(errorForFile([entry()])).toBeNull();
    expect(errorForFile([entry({ label: 'Baseline — frozen Aug 20' })])).toBeNull();
  });

  it('insists the fingerprint is a sha256 — anything else points at nothing', () => {
    // A recorded score carries this hash to say WHICH version it scored; a
    // truncated or hand-typed value would resolve to no version at all.
    expect(errorForFile([entry({ planHash: 'abc' })])).toContain('planHash');
    expect(errorForFile([entry({ planHash: 'B'.repeat(64) })])).toContain('planHash');
  });

  it('knows only two kinds, because only one of them satisfies the day', () => {
    expect(errorForFile([entry({ kind: 'kept' })])).toBeNull();
    expect(errorForFile([entry({ kind: 'whenever' })])).toContain('kind');
  });

  it('takes a score, or none at all — and never a zero standing in for none', () => {
    expect(
      errorForFile([
        entry({
          score: {
            success: 0.938,
            medianTerminalReal: 1_284_510.4471935,
            mode: 'montecarlo',
            paths: 1000,
            seed: 20260812,
            engineVersion: '1.21.0',
            scoredAt: '2026-08-18T21:41:17.203Z',
          },
        }),
      ]),
    ).toBeNull();
    const [parsed] = planHistoryFileSchema.parse([entry()]);
    expect(parsed.score).toBeUndefined();
    expect(errorForFile([entry({ score: { success: 0.9 } })])).toContain('mode');
  });

  it('validates the plan it holds — a restore must never hand back an unrunnable one', () => {
    expect(errorForFile([entry({ plan: { name: 'Plan' } })])).toContain('events');
  });

  it('lets the client send only WHAT to keep and what to call it', () => {
    // The id, the moment and the hash are the server's to stamp, exactly as
    // with a snapshot: a record whose writer chooses its own timestamp cannot
    // be trusted to order a history.
    expect(planKeepSchema.safeParse({ plan: { name: 'Plan', events: [] } }).success).toBe(true);
    expect(
      planKeepSchema.safeParse({
        plan: { name: 'Plan', events: [] },
        label: 'Search winner',
      }).success,
    ).toBe(true);
    expect(
      planKeepSchema.safeParse({
        plan: { name: 'Plan', events: [] },
        takenAt: '1999-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
