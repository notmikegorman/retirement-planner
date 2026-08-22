/**
 * THE TWO-KNOB DECOMPOSITION OF GIVING, AND THE ONE PLACE IT IS DEFINED.
 *
 * The legacy 'tithe_account' giving rule bundled two independent decisions —
 * the ongoing growth tithe and the un-tithed pot — into one variant, and the
 * other variants silently meant "no pot at all". Current files carry the pair
 * instead: `retirementGiving` is THE ONGOING METHOD (OngoingGivingRule) and
 * `untithedPot` is THE POT (UntithedPotPolicy). This module is the entire
 * bridge between the two representations, shared by:
 *
 *  - the server's load-time migrations (dataStore), which rewrite stored
 *    files once and print what they changed;
 *  - the engine's prepareSim (the boundary safety net: a bundled rule handed
 *    straight to the engine — old saved scenarios, tests, search axes — is
 *    normalised here so it can never govern a simulation year);
 *  - the UI, which needs the same resolved defaults the engine applies.
 *
 * One module, because the migration's whole contract is that the pair MEANS
 * what the bundle meant — bit-identical, pinned by digest tests — and two
 * copies of "what does deferYears become" would be two chances to disagree.
 */

import type {
  OngoingGivingRule,
  RetirementGivingRule,
  UntithedPotPolicy,
  UntithedPotSetting,
} from './types';
import {
  DEFAULT_POT_ONGOING_DURING_HOLD,
  DEFAULT_POT_PERCENT,
  DEFAULT_POT_SEED_FROM_GAINS,
  DEFAULT_TITHE_DISTRIBUTE_YEARS,
  DEFAULT_TITHE_EARLY_RELEASE,
} from './types';

/** The legacy bundled variant, extracted so call sites can name it. */
export type TitheAccountRule = Extract<RetirementGivingRule, { type: 'tithe_account' }>;

/** Type guard for the stored pot field: is a pot actually configured? */
export function potIsEnabled(
  setting: UntithedPotSetting | undefined,
): setting is UntithedPotPolicy {
  return setting !== undefined && setting.enabled !== false;
}

/**
 * The pot with every ABSENT-MEANS default written in — what the engine and any
 * summary text actually compute from. Kept separate from UntithedPotPolicy so
 * stored files keep expressing "on the default" by having no key (the same
 * convention distributeYears has followed since it was added).
 */
export interface ResolvedUntithedPot {
  percent: number;
  holdYears: number;
  distributeYears: number;
  earlyRelease: boolean;
  ongoingDuringHold: 'accrue_to_pot' | 'give_cash';
  seedFromGains: boolean;
  allocation: UntithedPotPolicy['allocation'];
}

/** Apply the documented defaults. Null when the setting is absent or disabled. */
export function resolveUntithedPot(
  setting: UntithedPotSetting | undefined,
): ResolvedUntithedPot | null {
  if (!potIsEnabled(setting)) return null;
  return {
    percent: setting.percent ?? DEFAULT_POT_PERCENT,
    holdYears: setting.holdYears,
    distributeYears: setting.distributeYears ?? DEFAULT_TITHE_DISTRIBUTE_YEARS,
    earlyRelease: setting.earlyRelease ?? DEFAULT_TITHE_EARLY_RELEASE,
    ongoingDuringHold: setting.ongoingDuringHold ?? DEFAULT_POT_ONGOING_DURING_HOLD,
    seedFromGains: setting.seedFromGains ?? DEFAULT_POT_SEED_FROM_GAINS,
    allocation: setting.allocation,
  };
}

/**
 * The bundled rule, split into the pair it always meant.
 *
 * Field mapping, chosen so the pair reproduces the bundle EXACTLY:
 * - ongoing = percent_of_growth at the bundle's percent (the bundle's
 *   trailing-growth stream IS a growth tithe — on the high-water-mark base,
 *   which the engine keeps using whenever a pot is present);
 * - pot.percent = the same percent (the bundle used one number for the seed
 *   and the stream; the split writes it into both knobs);
 * - pot.holdYears = deferYears, pot.seedFromGains = seedFromExistingGains;
 * - distributeYears / earlyRelease / allocation carry over ONLY WHEN PRESENT,
 *   so "on the default" survives as an absent key and a future default change
 *   still reaches migrated files;
 * - ongoingDuringHold is OMITTED: absent means 'accrue_to_pot', which is the
 *   bundled behaviour and the reason that default was chosen.
 *
 * `percent` and `seedFromGains` are written explicitly even when they equal
 * their defaults: they were REQUIRED fields of the bundle — the user's own
 * chosen numbers, not an untouched default — and a migration must not turn a
 * deliberate value into an inherited one.
 */
export function titheBundleToPair(rule: TitheAccountRule): {
  ongoing: OngoingGivingRule;
  pot: UntithedPotPolicy;
} {
  const pot: UntithedPotPolicy = {
    percent: rule.percent,
    holdYears: rule.deferYears,
    seedFromGains: rule.seedFromExistingGains,
  };
  if (rule.distributeYears !== undefined) pot.distributeYears = rule.distributeYears;
  if (rule.earlyRelease !== undefined) pot.earlyRelease = rule.earlyRelease;
  if (rule.allocation !== undefined) pot.allocation = { ...rule.allocation };
  return { ongoing: { type: 'percent_of_growth', percent: rule.percent }, pot };
}

/**
 * Resolve the (profile rule, profile pot, override rule, override pot) square
 * into the single pair a run consumes. This is the engine-boundary semantics,
 * in one place:
 *
 * - Each side's legacy bundled rule is split first, so a bundle can arrive
 *   from EITHER side (an unmigrated profile handed straight to prepareSim; an
 *   old saved scenario's override; a search axis level) and never leak past.
 * - An override BUNDLE supersedes the profile's pot: under the old model an
 *   override replaced the whole rule, pot and all, and a bundle is by
 *   definition old-model. An EXPLICIT override pot still outranks the bundle's
 *   own pot half — it is the newer, more deliberate spelling.
 * - Otherwise each half inherits independently: override, else profile. An
 *   absent override pot INHERITS (the new semantics); the explicit
 *   `{ enabled: false }` disable is how a run suppresses an inherited pot.
 */
export function resolveGivingPair(args: {
  profileRule: RetirementGivingRule | undefined;
  profilePot: UntithedPotSetting | undefined;
  overrideRule: RetirementGivingRule | undefined;
  overridePot: UntithedPotSetting | undefined;
}): { ongoing: OngoingGivingRule | undefined; pot: ResolvedUntithedPot | null } {
  const split = (
    rule: RetirementGivingRule | undefined,
  ): { ongoing: OngoingGivingRule | undefined; bundledPot: UntithedPotPolicy | undefined } => {
    if (rule === undefined) return { ongoing: undefined, bundledPot: undefined };
    if (rule.type !== 'tithe_account') return { ongoing: rule, bundledPot: undefined };
    const pair = titheBundleToPair(rule);
    return { ongoing: pair.ongoing, bundledPot: pair.pot };
  };
  const p = split(args.profileRule);
  const o = split(args.overrideRule);
  const ongoing = o.ongoing ?? p.ongoing;
  // Precedence, most deliberate spelling first: an explicit override pot, the
  // pot half of an override bundle, the profile's own pot, the pot half of an
  // unmigrated profile bundle. An override that says nothing about the pot —
  // no explicit setting, no bundle — therefore inherits the profile's.
  const potSetting = args.overridePot ?? o.bundledPot ?? args.profilePot ?? p.bundledPot;
  return { ongoing, pot: resolveUntithedPot(potSetting) };
}
