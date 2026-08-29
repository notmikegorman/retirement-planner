/**
 * File-system data store for the planner's data folder (SPEC §2) —
 * ENVIRONMENT-NEUTRAL since Phase 3 of the browser port.
 *
 * This is the same module that lived at src/server/dataStore.ts, with one
 * structural change and no behavioural ones: everything that used to bind to
 * THE data folder (the module-level `dataFiles` singleton) or THE bundled
 * defaults (a node path under the repo root) now arrives as a parameter —
 * `createDataStore({ files, defaults })` — because the same seeding,
 * migration, validation and load/save logic runs against two different
 * worlds:
 *
 *   - under node: files = the FPLAN_DATA_DIR folder on disk, defaults =
 *     <repoRoot>/data-defaults (src/server/stores.ts does that wiring);
 *   - in the browser: files = the picked folder / OPFS through the
 *     FileSystemDirectoryHandle driver, defaults = an in-memory store built
 *     from the bundled data-defaults (Vite `?raw` imports).
 *
 * One copy of every guard and migration, two drivers under it — that is the
 * entire point of the seam, and it is why this directory (src/store) is
 * pinned Node-free forever by tests/shared/noNodeImports.test.ts. Anything
 * environment-specific (process.env, repo-root resolution, network defaults)
 * belongs in the wiring modules, never here.
 *
 * Everything below the factory boundary is the Phase-2 code moved as-is:
 * - Seeding copies from the defaults store (copy-if-missing; user files are
 *   never overwritten).
 * - Every load validates: profile/plan via zod schemas; assumption data files
 *   via a light structural check (required top-level keys present). Malformed
 *   JSON produces a helpful error that names the file — never a crash.
 * - Saves are pretty-printed (2-space) JSON so the folder stays human-readable
 *   and git-diffable.
 *
 * THE WORKBENCH HAS ONE PLAN, and this module does not own it. plan.json and
 * its history live in planStore.ts, because every write to the plan has to
 * pass a guard (the day's first change files the version it replaces) and a
 * file with a guard needs one door, not a general-purpose IO module's.
 *
 * The ONE exception is migrateGivingSplitFiles below, which rewrites
 * plan.json raw at boot: the file it is fixing is by definition in a shape
 * the current schema rejects, so it cannot go through the validating door —
 * see the note on planStore's header.
 */
import type { z } from 'zod';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  HistoricalRow,
  MarketAssumptions,
  MedicareData,
  Profile,
  QuotesFile,
  RmdTableData,
  SocialSecurityData,
  StateCode,
  StateTaxData,
} from '../shared/types';
import { parseOrThrow, profileSchema, quotesFileSchema } from '../shared/schemas';
import { resolveAccounts, type HoldingsResolution } from '../shared/holdings';
import { titheBundleToPair, type TitheAccountRule } from '../shared/giving';
import { FileNotFoundError, parentDirOf, type FileStore } from '../shared/fileStore';

/** Requested resource does not exist (the server maps this to HTTP 404). */
export class NotFoundError extends Error {}
/** Input failed validation or a file is malformed (server maps to HTTP 400). */
export class ValidationError extends Error {}
/**
 * The request was well formed and is refused by what is already on disk
 * (server maps to HTTP 409).
 *
 * 409 rather than 400: nothing is wrong with the request, and rather than 403:
 * nothing is being withheld. The state of the record is the whole answer — a
 * number has already been written where this one would go — and 409 is the
 * only code that says so.
 */
export class ConflictError extends Error {}

// ---------------------------------------------------------------------------
// Module-level helpers (pure, or parameterized on the store they touch)
// ---------------------------------------------------------------------------

/** readJsonFile against an arbitrary store (the defaults, in backfill). */
async function readJsonFrom(store: FileStore, relPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await store.readText(relPath);
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      throw new NotFoundError(`File not found: ${store.describe(relPath)}`);
    }
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ValidationError(
      `Malformed JSON in ${store.describe(relPath)}: ${(err as Error).message}`,
    );
  }
}

/** parseOrThrow, rethrown as ValidationError so the server can map it to 400. */
function validate<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  try {
    return parseOrThrow(schema, data, label);
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
}

/** Light structural check for assumption data files: required keys present. */
function requireKeys(value: unknown, keys: readonly string[], label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`Invalid ${label}: expected a JSON object`);
  }
  const missing = keys.filter((k) => !(k in (value as Record<string, unknown>)));
  if (missing.length > 0) {
    throw new ValidationError(`Invalid ${label}: missing required key(s): ${missing.join(', ')}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Additive deep-merge: every key present in `defaults` but MISSING in `user`
 * is added (recursing into plain objects on both sides). Existing user values
 * are NEVER overwritten — scalars, arrays, and any key the user already has
 * are left exactly as-is. Dotted paths of added keys are appended to `added`.
 */
function backfillMissingKeys(
  user: Record<string, unknown>,
  defaults: Record<string, unknown>,
  prefix: string,
  added: string[],
): void {
  for (const [key, defVal] of Object.entries(defaults)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in user)) {
      user[key] = structuredClone(defVal);
      added.push(keyPath);
    } else if (isPlainObject(user[key]) && isPlainObject(defVal)) {
      backfillMissingKeys(user[key], defVal, keyPath, added);
    }
  }
}

// ---------------------------------------------------------------------------
// Profile migration (pure — raw JSON in, raw JSON out)
// ---------------------------------------------------------------------------

/**
 * Migrate an old-shape profile (raw JSON, pre-validation) to the current
 * contract. Every rule is additive and idempotent: a new-shape file passes
 * through untouched (changed = []), and user-entered values are NEVER
 * overwritten — the only value rewrite is the exact old ACA placeholder
 * (1750 → the researched 2026 benchmark that replaced it).
 *
 * Rules:
 * - person.piaMonthlyAtFra → both piaMonthlyAtFraIfWorkingTo62 and
 *   piaMonthlyAtFraIfStoppingNow = old value; old key deleted.
 * - account missing name → name = id.
 * - withdrawalPolicy.pretaxPreference 'rule_of_55_first' → 'ira_first'.
 * - expenses.annualBaseline → livingMonthly = round(annualBaseline / 12),
 *   charitableMonthly = 0, investingMonthly = 0; annualBaseline/categories deleted.
 * - health.employerPremiumShareMonthly missing → 0.
 * - health.acaBenchmarkMonthly === 1750 (the old placeholder, only that exact
 *   value) → 1480 (the starter's illustrative 2026 SLCSP benchmark).
 * - Deprecated account fields (ruleOf55Eligible, allowsPartialWithdrawals) are
 *   left in place; the schema tolerates them.
 *
 * DELIBERATELY NOT MIGRATED — the paired working/retired values and the
 * retirement income stream (note 19: expenses.livingMonthlyRetired,
 * expenses.investingMonthlyRetired, income.retirementMonthly,
 * income.retirementIncomeTaxable). Nothing here writes them, because every one
 * is OPTIONAL and its absence already carries the right meaning: living stays
 * at the working figure, investing stops with the paycheck, giving keeps its
 * 'continue' rule, retirement income is 0 — which is exactly what the engine
 * did before the fields existed. Writing them in would add noise to the
 * user's file, and writing a WRONG one (livingMonthlyRetired: 0, say) would
 * silently rewrite their plan. A field whose default is correct needs no
 * migration; adding one would be the bug.
 */
export function migrateProfile(raw: unknown): { profile: unknown; changed: string[] } {
  if (!isPlainObject(raw)) return { profile: raw, changed: [] };
  const profile = structuredClone(raw) as Record<string, unknown>;
  const changed: string[] = [];

  if (Array.isArray(profile.people)) {
    for (const person of profile.people) {
      if (!isPlainObject(person)) continue;
      if ('piaMonthlyAtFra' in person) {
        const old = person.piaMonthlyAtFra;
        person.piaMonthlyAtFraIfWorkingTo62 = old;
        person.piaMonthlyAtFraIfStoppingNow = old;
        delete person.piaMonthlyAtFra;
        changed.push(
          `person ${String(person.id ?? '?')}: piaMonthlyAtFra ${String(old)} → piaMonthlyAtFraIfWorkingTo62 + piaMonthlyAtFraIfStoppingNow`,
        );
      }
    }
  }

  if (Array.isArray(profile.accounts)) {
    for (const account of profile.accounts) {
      if (!isPlainObject(account)) continue;
      const hasName = typeof account.name === 'string' && account.name.length > 0;
      if (!hasName && typeof account.id === 'string') {
        account.name = account.id;
        changed.push(`account ${account.id}: name defaulted to id`);
      }
    }
  }

  const settings = profile.settings;
  if (isPlainObject(settings) && isPlainObject(settings.withdrawalPolicy)) {
    const policy = settings.withdrawalPolicy;
    if (policy.pretaxPreference === 'rule_of_55_first') {
      policy.pretaxPreference = 'ira_first';
      changed.push(
        "withdrawalPolicy.pretaxPreference 'rule_of_55_first' → 'ira_first' (401(k)→IRA rollover at separation is now modeled)",
      );
    }
  }

  const expenses = profile.expenses;
  if (isPlainObject(expenses) && 'annualBaseline' in expenses) {
    const old = expenses.annualBaseline;
    if (typeof expenses.livingMonthly !== 'number' && typeof old === 'number') {
      expenses.livingMonthly = Math.round(old / 12);
    }
    if (typeof expenses.charitableMonthly !== 'number') expenses.charitableMonthly = 0;
    if (typeof expenses.investingMonthly !== 'number') expenses.investingMonthly = 0;
    delete expenses.annualBaseline;
    delete expenses.categories;
    changed.push(
      `expenses.annualBaseline ${String(old)} → livingMonthly ${String(expenses.livingMonthly)}/mo + charitableMonthly/investingMonthly 0`,
    );
  }

  const health = profile.health;
  if (isPlainObject(health)) {
    if (typeof health.employerPremiumShareMonthly !== 'number') {
      health.employerPremiumShareMonthly = 0;
      changed.push('health.employerPremiumShareMonthly defaulted to 0');
    }
    if (health.acaBenchmarkMonthly === 1750) {
      health.acaBenchmarkMonthly = 1480;
      changed.push('acaBenchmarkMonthly 1750→1480 (starter SLCSP benchmark)');
    }
  }

  // The two-knob giving split: the bundled 'tithe_account' rule becomes the
  // ongoing method + the un-tithed pot it always meant (shared/giving.ts owns
  // the field mapping; the equivalence digests pin it bit-identical). An
  // existing `untithedPot` key is never overwritten — it can only mean the
  // file is already (partly) new-shaped, and user values always win here.
  if (isPlainObject(expenses) && isTitheBundle(expenses.retirementGiving)) {
    const { ongoing, pot } = titheBundleToPair(expenses.retirementGiving);
    expenses.retirementGiving = ongoing;
    if (!('untithedPot' in expenses)) expenses.untithedPot = pot;
    changed.push(
      "expenses.retirementGiving 'tithe_account' → ongoing percent_of_growth + untithedPot (the two-knob split; same behaviour)",
    );
  }

  return { profile, changed };
}

/**
 * Does a raw JSON value look like the legacy bundled tithe rule? Checked field
 * by field rather than by `type` alone: migration runs BEFORE validation, and
 * a malformed bundle must fall through to the schema's helpful error rather
 * than crash the migration or produce a half-built pair.
 */
function isTitheBundle(v: unknown): v is TitheAccountRule {
  return (
    isPlainObject(v) &&
    v.type === 'tithe_account' &&
    typeof v.percent === 'number' &&
    typeof v.deferYears === 'number' &&
    typeof v.seedFromExistingGains === 'boolean'
  );
}

/**
 * Normalise ONE scenario's giving override (raw JSON, mutated in place) to the
 * two-knob shape. Two rules:
 *
 * 1. A bundled 'tithe_account' override becomes ongoing + an EXPLICIT pot.
 *    Explicit, not inherited: under the old model an override replaced the
 *    whole rule, so the bundle's own pot must beat whatever the profile has.
 *    Unambiguous from shape alone, so it is safe to apply at any time.
 *
 * 2. THE TRAP — a pre-split override with a NON-tithe rule. Under the old
 *    model it replaced the bundled rule POT AND ALL; under the new semantics
 *    an absent `untithedPot` inherits the profile's pot, which would quietly
 *    resurrect the pot that override was suppressing (the user's own
 *    plan.json carried exactly this shape). So it gets an explicit
 *    `{ enabled: false }`. Applied ONLY when `disableInheritedPot` — i.e.
 *    during the one-time startup pass, while profile.json still carries the
 *    bundle, which is the proof the data folder predates the split. A file
 *    written by the new UI can then never be re-clobbered: by the time the
 *    new UI can write anything the profile has been migrated, and the gate is
 *    false forever after.
 */
export function migrateScenarioGivingInPlace(
  scenario: Record<string, unknown>,
  opts: { disableInheritedPot: boolean },
): string[] {
  const changed: string[] = [];
  const overrides = scenario.assumption_overrides;
  if (!isPlainObject(overrides)) return changed;
  const expenses = overrides.expenses;
  if (!isPlainObject(expenses)) return changed;
  const rule = expenses.retirementGiving;
  if (isTitheBundle(rule)) {
    const { ongoing, pot } = titheBundleToPair(rule);
    expenses.retirementGiving = ongoing;
    if (!('untithedPot' in expenses)) expenses.untithedPot = pot;
    changed.push(
      "override retirementGiving 'tithe_account' → ongoing percent_of_growth + explicit untithedPot (an old override replaced the whole bundle, so its pot must not inherit)",
    );
  } else if (
    isPlainObject(rule) &&
    opts.disableInheritedPot &&
    !('untithedPot' in expenses)
  ) {
    expenses.untithedPot = { enabled: false };
    changed.push(
      'pre-split override with a non-tithe retirementGiving → untithedPot { enabled: false } (it used to suppress the pot by replacing the bundled rule; absent now inherits)',
    );
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Required-key lists for assumption data files
// ---------------------------------------------------------------------------

const MARKET_KEYS = [
  'deterministicReal',
  'deterministicInflation',
  'expenseRatios',
  'stockDividendYield',
  'bootstrapBlockYears',
  'homeAppreciationRealSpread',
  'medicalInflationRealSpread',
  'rentGrowthRealSpread',
] as const;

const FEDERAL_KEYS = [
  'baseYear',
  'bracketsMfj',
  'standardDeductionMfj',
  'additionalStdDeduction65',
  'ltcgBreakpointsMfj',
  'niitThresholdMfj',
  'niitRate',
  'ssTaxationThresholdsMfj',
  'earlyWithdrawalPenaltyRate',
  'saltCapByYear',
  'saltCapFallback',
  'saltPhaseDown',
  'homeSaleExclusionMfj',
  'charitable',
] as const;

const STATE_KEYS = ['state', 'baseYear', 'kind', 'startingPoint', 'socialSecurityTaxed', 'indexed'] as const;

const SOCIAL_SECURITY_KEYS = [
  'fraYearsByBirthYear',
  'fraDefaultYears',
  'workerReductionFirst36PerMonth',
  'workerReductionBeyond36PerMonth',
  'delayedCreditPerMonth',
  'maxClaimAge',
  'minClaimAge',
  'spousalMaxPctOfPia',
  'spousalReductionFirst36PerMonth',
  'spousalReductionBeyond36PerMonth',
] as const;

const MEDICARE_KEYS = [
  'baseYear',
  'partBStandardMonthly',
  'partDBaseMonthly',
  'irmaaTiersMfj',
  'medicareStartAge',
  'magiLookbackYears',
] as const;

const ACA_KEYS = [
  'baseYear',
  'fpl2Person',
  'applicablePctTable',
  'applicablePctTableEnhanced',
  'enhancedCreditsExtended',
  'medicaidExpansion',
  'medicaidThresholdFpl',
  'ageCurve',
] as const;

const RMD_KEYS = ['uniformLifetimeTable', 'rmdStartAge'] as const;

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface DataStoreOptions {
  /** The data folder itself — every record read and write goes through this. */
  files: FileStore;
  /** The bundled defaults, read-only, for seeding and backfill. */
  defaults: FileStore;
}

export interface DataStore {
  /** The two stores this instance is bound to, for the sibling factories. */
  readonly files: FileStore;
  readonly defaults: FileStore;
  describeDataFile(relPath: string): string;
  pathExists(relPath: string): Promise<boolean>;
  readJsonFile(relPath: string): Promise<unknown>;
  writeJsonPretty(relPath: string, value: unknown): Promise<void>;
  initDataDir(): Promise<{ dataDir: string; existedBefore: boolean }>;
  backfillAssumptionDefaults(): Promise<string[]>;
  migrateGivingSplitFiles(): Promise<string[]>;
  loadProfile(): Promise<Profile>;
  saveProfile(profile: Profile): Promise<void>;
  loadQuotes(): Promise<QuotesFile>;
  saveQuotes(quotes: QuotesFile): Promise<void>;
  loadResolvedProfile(): Promise<HoldingsResolution>;
  loadAssumptions(): Promise<Assumptions>;
  saveMarket(market: MarketAssumptions): Promise<void>;
}

export function createDataStore(opts: DataStoreOptions): DataStore {
  const { files, defaults } = opts;

  /**
   * The human name of a data-folder file, for error messages and logs. Every
   * user-facing message that used to interpolate a path.join(getDataDir(), ..)
   * goes through this, so under node the messages stay byte-identical while
   * the store calls themselves carry relative paths (the browser driver has
   * no absolute paths to offer).
   */
  const describeDataFile = (relPath: string): string => files.describe(relPath);

  async function copyIfMissing(srcRel: string, destRel: string): Promise<void> {
    if (await files.exists(destRel)) return;
    await files.mkdir(parentDirOf(destRel));
    await files.writeBytes(destRel, await defaults.readBytes(srcRel));
  }

  /** Recursively copy a directory tree, never overwriting existing dest files. */
  async function copyTreeIfMissing(srcRelDir: string, destRelDir: string): Promise<void> {
    await files.mkdir(destRelDir);
    const entries = await defaults.list(srcRelDir);
    for (const entry of entries) {
      const src = `${srcRelDir}/${entry.name}`;
      const dest = `${destRelDir}/${entry.name}`;
      if (entry.kind === 'directory') await copyTreeIfMissing(src, dest);
      else await copyIfMissing(src, dest);
    }
  }

  /**
   * Read + JSON.parse a data-folder file with helpful, file-path-bearing
   * errors. `relPath` is relative to the data folder root.
   */
  async function readJsonFile(relPath: string): Promise<unknown> {
    return readJsonFrom(files, relPath);
  }

  async function writeJsonPretty(relPath: string, value: unknown): Promise<void> {
    await files.mkdir(parentDirOf(relPath));
    await files.writeText(relPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function loadDataFile<T>(
    relPath: string,
    keys: readonly string[],
    label: string,
  ): Promise<T> {
    const raw = await readJsonFile(relPath);
    requireKeys(raw, keys, `${label} (${describeDataFile(relPath)})`);
    return raw as T;
  }

  // -------------------------------------------------------------------------
  // Init / seeding
  // -------------------------------------------------------------------------

  /**
   * Ensure the data folder exists and is seeded from the defaults store.
   * `existedBefore` is true when a profile.json was already present (i.e.
   * this was an already-initialized data folder, not a fresh seed).
   */
  async function initDataDir(): Promise<{ dataDir: string; existedBefore: boolean }> {
    const existedBefore = await files.exists('profile.json');

    await files.mkdir('');
    // profile.starter.json -> profile.json (only when the user has no profile yet)
    await copyIfMissing('profile.starter.json', 'profile.json');
    // Also keep the pristine starter alongside, as a reference.
    await copyIfMissing('profile.starter.json', 'profile.starter.json');
    await copyTreeIfMissing('assumptions', 'assumptions');
    // No scenarios/ seeding any more: there is one plan, and loadPlan() seeds
    // it on first read. An existing scenarios/ folder from an older data
    // folder is left exactly as the user left it — init neither reads nor
    // writes it.
    await files.mkdir('runs');

    // Seeding is copy-if-missing, so NEW keys added to repo-default assumption
    // files would never reach an already-seeded data folder. Backfill them.
    const backfilled = await backfillAssumptionDefaults();
    if (backfilled.length > 0) {
      console.log(`Backfilled assumption defaults:\n  - ${backfilled.join('\n  - ')}`);
    }

    // The giving split's one-time pass, HERE and not lazily at load: the trap
    // rule inside it is gated on the profile still carrying the bundled rule,
    // and only a single ordered pass over profile + plan + cabinet can consult
    // that gate before the profile migration erases it.
    const givingSplit = await migrateGivingSplitFiles();
    if (givingSplit.length > 0) {
      console.log(`Migrated giving to the two-knob split:\n  - ${givingSplit.join('\n  - ')}`);
    }

    return { dataDir: files.describe(''), existedBefore };
  }

  // -------------------------------------------------------------------------
  // Assumption-defaults backfill
  // -------------------------------------------------------------------------

  async function backfillDir(
    srcRelDir: string,
    destRelDir: string,
    changes: string[],
  ): Promise<void> {
    const entries = await defaults.list(srcRelDir);
    for (const entry of entries) {
      const src = `${srcRelDir}/${entry.name}`;
      const dest = `${destRelDir}/${entry.name}`;
      if (entry.kind === 'directory') {
        await backfillDir(src, dest, changes);
        continue;
      }
      // JSON assumption files only — historical-returns.csv has key-less rows
      // a key-wise merge cannot reach; backfillHistoricalBaaColumn handles its
      // one additive migration (the baa column) separately.
      if (!entry.name.endsWith('.json')) continue;
      // Absent user files are handled by copy-if-missing seeding, not backfill.
      if (!(await files.exists(dest))) continue;
      const defaultJson = await readJsonFrom(defaults, src);
      let user: unknown;
      try {
        user = await readJsonFile(dest);
      } catch {
        // Malformed user file: leave it for load-time validation to report
        // with its helpful file-naming error; backfill must never mask that.
        continue;
      }
      if (!isPlainObject(user) || !isPlainObject(defaultJson)) continue;
      const added: string[] = [];
      backfillMissingKeys(user, defaultJson, '', added);
      if (added.length > 0) {
        await writeJsonPretty(dest, user);
        changes.push(`${describeDataFile(dest)}: added ${added.join(', ')}`);
      }
    }
  }

  /**
   * Append the `baa` column to a user historical-returns.csv still in the
   * pre-baa 5-column format, joining values BY YEAR from the repo default CSV.
   *
   * The CSV equivalent of backfillMissingKeys, with the same contract:
   * additive only, user-edited values always survive (the user's five
   * existing columns are kept byte-for-byte; only `,<baa>` is appended),
   * idempotent (a 6-column file is left alone). Without this, every data
   * folder seeded before the column existed fails loadHistoricalCsv's
   * 6-column check on the next launch — the app would refuse to start over a
   * column the user never edited.
   *
   * A data line whose year the default CSV does not carry (a user-extended
   * series) leaves the file UNTOUCHED: inventing a corporate return would be
   * worse than the loud load-time error that follows, which names the file
   * and the offending line.
   */
  async function backfillHistoricalBaaColumn(
    srcCsv: string,
    destCsv: string,
    changes: string[],
  ): Promise<void> {
    if (!(await files.exists(destCsv))) return; // absent file = copy-if-missing's job
    const userText = await files.readText(destCsv);
    const isData = (l: string): boolean =>
      l.length > 0 && !l.startsWith('#') && !/^year\s*,/i.test(l);
    const userLines = userText.split(/\r?\n/);
    const dataLines = userLines.map((l) => l.trim()).filter(isData);
    // Already 6-column (or empty, or some other shape entirely): not ours to
    // touch — load-time validation owns every malformed case.
    if (dataLines.length === 0 || !dataLines.every((l) => l.split(',').length === 5)) return;

    const baaByYear = new Map<string, string>();
    for (const line of (await defaults.readText(srcCsv)).split(/\r?\n/)) {
      const t = line.trim();
      if (!isData(t)) continue;
      const parts = t.split(',').map((p) => p.trim());
      if (parts.length === 6) baaByYear.set(parts[0], parts[5]);
    }

    const out: string[] = [];
    for (const raw of userLines) {
      const t = raw.trim();
      if (/^year\s*,/i.test(t)) {
        out.push(`${raw},baa`);
        continue;
      }
      if (!isData(t)) {
        out.push(raw); // comments and blanks survive verbatim
        continue;
      }
      const baa = baaByYear.get(t.split(',')[0].trim());
      if (baa === undefined) return; // unknown year: hands off, fail loudly later
      out.push(`${raw},${baa}`);
    }
    await files.writeText(destCsv, out.join('\n'));
    changes.push(
      `${describeDataFile(destCsv)}: added baa column (${dataLines.length} rows joined by year)`,
    );
  }

  /**
   * Backfill new default keys into the user's assumption files (additive only;
   * user-edited values always survive; changed files are saved back
   * pretty-printed). Returns a human-readable change log, one entry per file.
   * Idempotent: a second pass reports no changes. Runs during init AND at the
   * top of loadAssumptions, so required-key validation self-heals when the
   * repo defaults gain keys (e.g. federal `charitable`, rmd `singleLifeTable`).
   */
  async function backfillAssumptionDefaults(): Promise<string[]> {
    const changes: string[] = [];
    if (!(await files.exists('assumptions'))) return changes;
    await backfillDir('assumptions', 'assumptions', changes);
    await backfillHistoricalBaaColumn(
      'assumptions/historical-returns.csv',
      'assumptions/historical-returns.csv',
      changes,
    );
    return changes;
  }

  // -------------------------------------------------------------------------
  // The one-time giving-split pass
  // -------------------------------------------------------------------------

  /**
   * THE ONE-TIME GIVING-SPLIT PASS, run at startup (initDataDir) before
   * anything is served. It has to be a single ordered pass over the whole
   * data folder because the trap rule above is gated on evidence that only
   * exists until the profile is migrated: profile.json still carrying the
   * bundled rule. Order:
   *
   * 1. Read profile.json RAW and remember whether it carries the bundle.
   * 2. Normalise plan.json and every scenarios/*.json (trap rule gated on 1),
   *    persisting changed files.
   * 3. Migrate profile.json itself (migrateProfile) and persist — in this
   *    same pass, so the gate can never be consulted a second time with stale
   *    truth.
   *
   * Unreadable or malformed files are SKIPPED, not failed: each load path
   * already reports them with its own helpful, file-naming error, and a
   * broken cabinet file must not stop the app from starting.
   */
  async function migrateGivingSplitFiles(): Promise<string[]> {
    const changes: string[] = [];
    const profileFile = 'profile.json';

    let rawProfile: unknown = null;
    try {
      rawProfile = await readJsonFile(profileFile);
    } catch {
      rawProfile = null; // missing or malformed: no gate, and nothing to migrate
    }
    const legacyProfile =
      isPlainObject(rawProfile) &&
      isPlainObject(rawProfile.expenses) &&
      isTitheBundle(rawProfile.expenses.retirementGiving);

    const migratable: string[] = [];
    const planFile = 'plan.json';
    if (await files.exists(planFile)) migratable.push(planFile);
    if (await files.exists('scenarios')) {
      for (const entry of await files.list('scenarios')) {
        if (entry.name.endsWith('.json')) migratable.push(`scenarios/${entry.name}`);
      }
    }

    for (const filePath of migratable) {
      let raw: unknown;
      try {
        raw = await readJsonFile(filePath);
      } catch {
        continue;
      }
      if (!isPlainObject(raw)) continue;
      const clone = structuredClone(raw);
      // A cabinet file wraps its scenario ({ name, scenario, savedAt, ... });
      // plan.json IS the scenario. Legacy bare-Scenario cabinet files land in
      // the else branch, which is exactly right for them too.
      const scenario = isPlainObject(clone.scenario) ? clone.scenario : clone;
      const changedHere = migrateScenarioGivingInPlace(scenario, {
        disableInheritedPot: legacyProfile,
      });
      if (changedHere.length > 0) {
        await writeJsonPretty(filePath, clone);
        changes.push(`${describeDataFile(filePath)}: ${changedHere.join('; ')}`);
      }
    }

    if (rawProfile !== null) {
      const { profile: migrated, changed } = migrateProfile(rawProfile);
      if (changed.length > 0) {
        await writeJsonPretty(profileFile, migrated);
        changes.push(`${describeDataFile(profileFile)}: ${changed.join('; ')}`);
      }
    }

    return changes;
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  const profilePath = (): string => 'profile.json';

  async function loadProfile(): Promise<Profile> {
    const filePath = profilePath();
    const raw = await readJsonFile(filePath);
    const { profile: migrated, changed } = migrateProfile(raw);
    if (changed.length > 0) {
      await writeJsonPretty(filePath, migrated);
      console.log(
        `Migrated profile ${describeDataFile(filePath)}:\n  - ${changed.join('\n  - ')}`,
      );
    }
    return validate(profileSchema, migrated, `profile (${describeDataFile(filePath)})`);
  }

  async function saveProfile(profile: Profile): Promise<void> {
    const valid = validate(profileSchema, profile, 'profile');
    await writeJsonPretty(profilePath(), valid);
  }

  // -------------------------------------------------------------------------
  // Quotes (quotes.json) and the resolved profile
  // -------------------------------------------------------------------------

  const quotesPath = (): string => 'quotes.json';

  /**
   * Stored quotes. A MISSING file is an empty store, not an error — a data
   * folder that has never refreshed prices simply has none yet, and the
   * holdings resolver reports the symbols as missing with the fix. A file
   * that exists but is malformed fails loudly with its filename, like every
   * other data file here.
   */
  async function loadQuotes(): Promise<QuotesFile> {
    const filePath = quotesPath();
    let raw: unknown;
    try {
      raw = await readJsonFile(filePath);
    } catch (err) {
      if (err instanceof NotFoundError) return {};
      throw err;
    }
    return validate(quotesFileSchema, raw, `quotes (${describeDataFile(filePath)})`);
  }

  async function saveQuotes(quotes: QuotesFile): Promise<void> {
    const valid = validate(quotesFileSchema, quotes, 'quotes');
    await writeJsonPretty(quotesPath(), valid);
  }

  /**
   * THE PROFILE AS EVERYTHING DOWNSTREAM MUST SEE IT: loaded, migrated,
   * validated, and with every holdings-mode account's balance/allocation
   * re-derived from the stored quotes. This is the single chokepoint the
   * holdings design hangs on — the run manager, the search manager, the
   * snapshot scorer and the profile page all read THIS, so a price refresh
   * moves every one of them together and no two surfaces can disagree about
   * what the IRA is worth.
   *
   * LENIENT ABOUT MISSING QUOTES, deliberately: an account with an unpriced
   * symbol keeps its stored (last-resolved) figures and the symbol is
   * reported in `missing`. The profile EDITOR must render before the first
   * refresh ever happens, so missing cannot be fatal here — the run manager
   * and the search manager check `missing` themselves and refuse to simulate,
   * because a run quietly priced from a stale cache is the one outcome worse
   * than an error.
   */
  async function loadResolvedProfile(): Promise<HoldingsResolution> {
    const profile = await loadProfile();
    const quotes = await loadQuotes();
    return resolveAccounts(profile, quotes);
  }

  // -------------------------------------------------------------------------
  // Assumptions
  // -------------------------------------------------------------------------

  async function loadStateTax(state: StateCode): Promise<StateTaxData> {
    const filePath = `assumptions/tax/${state}-2026.json`;
    return loadDataFile<StateTaxData>(filePath, STATE_KEYS, `${state.toUpperCase()} state tax data`);
  }

  /** Load and assemble the full Assumptions bundle from the data folder. */
  async function loadAssumptions(): Promise<Assumptions> {
    // Self-heal: user copies seeded before a repo default gained new keys
    // would otherwise fail the required-key checks below (additive, no-op
    // when clean).
    const backfilled = await backfillAssumptionDefaults();
    if (backfilled.length > 0) {
      console.log(`Backfilled assumption defaults:\n  - ${backfilled.join('\n  - ')}`);
    }

    const market = await loadDataFile<MarketAssumptions>(
      'assumptions/market.json',
      MARKET_KEYS,
      'market assumptions',
    );
    const federal = await loadDataFile<FederalTaxData>(
      'assumptions/tax/federal-2026.json',
      FEDERAL_KEYS,
      'federal tax data',
    );
    const states: Record<StateCode, StateTaxData> = {
      va: await loadStateTax('va'),
      sc: await loadStateTax('sc'),
      nc: await loadStateTax('nc'),
    };
    const socialSecurity = await loadDataFile<SocialSecurityData>(
      'assumptions/social-security.json',
      SOCIAL_SECURITY_KEYS,
      'social security data',
    );
    const medicare = await loadDataFile<MedicareData>(
      'assumptions/medicare-2026.json',
      MEDICARE_KEYS,
      'medicare data',
    );
    const aca = await loadDataFile<AcaData>('assumptions/aca-2026.json', ACA_KEYS, 'ACA data');
    const rmd = await loadDataFile<RmdTableData>(
      'assumptions/rmd-table.json',
      RMD_KEYS,
      'RMD table data',
    );

    const csvPath = 'assumptions/historical-returns.csv';
    let csvText: string;
    try {
      csvText = await files.readText(csvPath);
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        throw new NotFoundError(`File not found: ${describeDataFile(csvPath)}`);
      }
      throw err;
    }
    // Dynamic import: the engine module is loaded lazily so the data store
    // stays importable (and testable) independently of the engine build.
    const { loadHistoricalCsv } = await import('../engine/returns');
    let historical: HistoricalRow[];
    try {
      historical = loadHistoricalCsv(csvText);
    } catch (err) {
      throw new ValidationError(
        `Invalid historical returns (${describeDataFile(csvPath)}): ${(err as Error).message}`,
      );
    }

    return { market, historical, federal, states, socialSecurity, medicare, aca, rmd };
  }

  async function saveMarket(market: MarketAssumptions): Promise<void> {
    requireKeys(market, MARKET_KEYS, 'market assumptions');
    await writeJsonPretty('assumptions/market.json', market);
  }

  return {
    files,
    defaults,
    describeDataFile,
    pathExists: (relPath) => files.exists(relPath),
    readJsonFile,
    writeJsonPretty,
    initDataDir,
    backfillAssumptionDefaults,
    migrateGivingSplitFiles,
    loadProfile,
    saveProfile,
    loadQuotes,
    saveQuotes,
    loadResolvedProfile,
    loadAssumptions,
    saveMarket,
  };
}
