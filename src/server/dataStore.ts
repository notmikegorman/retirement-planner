/**
 * File-system data store for the planner's data folder (SPEC §2).
 *
 * - dataDir = $FPLAN_DATA_DIR or ~/finance-planner-data
 * - Seeding copies from <repoRoot>/data-defaults (copy-if-missing; user files
 *   are never overwritten).
 * - Every load validates: profile/plan via zod schemas; assumption data files
 *   via a light structural check (required top-level keys present). Malformed
 *   JSON produces a helpful error that names the file — never a crash.
 * - Saves are pretty-printed (2-space) JSON so the folder stays human-readable
 *   and git-diffable.
 *
 * THE WORKBENCH HAS ONE PLAN, and this module no longer owns it. plan.json and
 * its history live in planStore.ts, because every write to the plan has to pass
 * a guard (the day's first change files the version it replaces) and a file
 * with a guard needs one door, not a general-purpose IO module's.
 *
 * The ONE exception is migrateGivingSplitFiles below, which rewrites plan.json
 * raw at boot: the file it is fixing is by definition in a shape the current
 * schema rejects, so it cannot go through the validating door — see the note
 * on planStore's header.
 *
 * ALL IO GOES THROUGH THE fileStore SEAM (fileStore.ts): this module names
 * files by paths relative to the data dir and never imports node:fs, so the
 * same store logic can run against the browser's directory-handle driver in
 * Phase 3 without a second copy of any guard or migration.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type {
  AcaData,
  Assumptions,
  FederalTaxData,
  HistoricalRow,
  MarketAssumptions,
  MedicareData,
  Person,
  Profile,
  QuotesFile,
  RmdTableData,
  Scenario,
  SocialSecurityData,
  StateCode,
  StateTaxData,
} from '../shared/types';
import { parseOrThrow, profileSchema, quotesFileSchema, scenarioSchema } from '../shared/schemas';
import { resolveAccounts, type HoldingsResolution } from '../shared/holdings';
import { titheBundleToPair, type TitheAccountRule } from '../shared/giving';
import {
  FileNotFoundError,
  createNodeFileStore,
  dataFiles,
  getDataDir,
  parentDirOf,
  type FileStore,
} from './fileStore';

// The one place the data folder's location is decided moved to fileStore.ts
// (the driver needs it and must not depend on this module); re-exported here
// so its many existing importers keep one import path.
export { getDataDir } from './fileStore';

/** Requested resource does not exist (server maps to HTTP 404). */
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

// Resolve the repo root relative to THIS source file (src/server/dataStore.ts),
// not process.cwd(), so the server works no matter where it is launched from.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

/**
 * The bundled defaults, read through the SAME FileStore contract as the data
 * folder (a second instance rooted elsewhere, used read-only). That is not
 * symmetry for its own sake: in the browser the defaults ship as bundled
 * assets, so seeding must already speak an interface a non-fs source can
 * implement — copy = readBytes here, writeBytes there.
 */
const defaultsFiles: FileStore = createNodeFileStore(() => defaultsDir);

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * The absolute name of a data-folder file, for error messages and logs. Every
 * user-facing message that used to interpolate a path.join(getDataDir(), ...)
 * now goes through this, so the messages stay byte-identical while the store
 * calls themselves carry relative paths (the browser driver has no absolute
 * paths to offer).
 */
export function describeDataFile(relPath: string): string {
  return dataFiles.describe(relPath);
}

async function copyIfMissing(srcRel: string, destRel: string): Promise<void> {
  if (await dataFiles.exists(destRel)) return;
  await dataFiles.mkdir(parentDirOf(destRel));
  await dataFiles.writeBytes(destRel, await defaultsFiles.readBytes(srcRel));
}

/** Recursively copy a directory tree, never overwriting existing dest files. */
async function copyTreeIfMissing(srcRelDir: string, destRelDir: string): Promise<void> {
  await dataFiles.mkdir(destRelDir);
  const entries = await defaultsFiles.list(srcRelDir);
  for (const entry of entries) {
    const src = `${srcRelDir}/${entry.name}`;
    const dest = `${destRelDir}/${entry.name}`;
    if (entry.kind === 'directory') await copyTreeIfMissing(src, dest);
    else await copyIfMissing(src, dest);
  }
}

/**
 * Does this data-folder path exist? Relative to the data dir, like every
 * store path since the seam. Kept exported so a future store owning its own
 * directory does not re-derive fs conventions.
 */
export async function pathExists(relPath: string): Promise<boolean> {
  return dataFiles.exists(relPath);
}

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

/**
 * Read + JSON.parse a data-folder file with helpful, file-path-bearing
 * errors. `relPath` is relative to the data dir.
 */
export async function readJsonFile(relPath: string): Promise<unknown> {
  return readJsonFrom(dataFiles, relPath);
}

export async function writeJsonPretty(relPath: string, value: unknown): Promise<void> {
  await dataFiles.mkdir(parentDirOf(relPath));
  await dataFiles.writeText(relPath, `${JSON.stringify(value, null, 2)}\n`);
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

async function loadDataFile<T>(relPath: string, keys: readonly string[], label: string): Promise<T> {
  const raw = await readJsonFile(relPath);
  requireKeys(raw, keys, `${label} (${describeDataFile(relPath)})`);
  return raw as T;
}

// ---------------------------------------------------------------------------
// Init / seeding
// ---------------------------------------------------------------------------

/**
 * Ensure the data folder exists and is seeded from data-defaults.
 * `existedBefore` is true when a profile.json was already present (i.e. this
 * was an already-initialized data folder, not a fresh seed).
 */
export async function initDataDir(): Promise<{ dataDir: string; existedBefore: boolean }> {
  const dataDir = getDataDir();
  const existedBefore = await dataFiles.exists('profile.json');

  await dataFiles.mkdir('');
  // profile.starter.json -> profile.json (only when the user has no profile yet)
  await copyIfMissing('profile.starter.json', 'profile.json');
  // Also keep the pristine starter alongside, as a reference.
  await copyIfMissing('profile.starter.json', 'profile.starter.json');
  await copyTreeIfMissing('assumptions', 'assumptions');
  // No scenarios/ seeding any more: there is one plan, and loadPlan() seeds it
  // on first read. An existing scenarios/ folder from an older data folder is
  // left exactly as the user left it — init neither reads nor writes it.
  await dataFiles.mkdir('runs');

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

  return { dataDir, existedBefore };
}

// ---------------------------------------------------------------------------
// Assumption-defaults backfill
// ---------------------------------------------------------------------------

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

async function backfillDir(srcRelDir: string, destRelDir: string, changes: string[]): Promise<void> {
  const entries = await defaultsFiles.list(srcRelDir);
  for (const entry of entries) {
    const src = `${srcRelDir}/${entry.name}`;
    const dest = `${destRelDir}/${entry.name}`;
    if (entry.kind === 'directory') {
      await backfillDir(src, dest, changes);
      continue;
    }
    // JSON assumption files only — historical-returns.csv has key-less rows a
    // key-wise merge cannot reach; backfillHistoricalBaaColumn handles its one
    // additive migration (the baa column) separately.
    if (!entry.name.endsWith('.json')) continue;
    // Absent user files are handled by copy-if-missing seeding, not backfill.
    if (!(await dataFiles.exists(dest))) continue;
    const defaults = await readJsonFrom(defaultsFiles, src);
    let user: unknown;
    try {
      user = await readJsonFile(dest);
    } catch {
      // Malformed user file: leave it for load-time validation to report with
      // its helpful file-naming error; backfill must never mask that.
      continue;
    }
    if (!isPlainObject(user) || !isPlainObject(defaults)) continue;
    const added: string[] = [];
    backfillMissingKeys(user, defaults, '', added);
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
 * The CSV equivalent of backfillMissingKeys, with the same contract: additive
 * only, user-edited values always survive (the user's five existing columns
 * are kept byte-for-byte; only `,<baa>` is appended), idempotent (a 6-column
 * file is left alone). Without this, every data folder seeded before the
 * column existed fails loadHistoricalCsv's 6-column check on the next launch
 * — the app would refuse to start over a column the user never edited.
 *
 * A data line whose year the default CSV does not carry (a user-extended
 * series) leaves the file UNTOUCHED: inventing a corporate return would be
 * worse than the loud load-time error that follows, which names the file and
 * the offending line.
 */
async function backfillHistoricalBaaColumn(
  srcCsv: string,
  destCsv: string,
  changes: string[],
): Promise<void> {
  if (!(await dataFiles.exists(destCsv))) return; // absent file = copy-if-missing's job
  const userText = await dataFiles.readText(destCsv);
  const isData = (l: string): boolean =>
    l.length > 0 && !l.startsWith('#') && !/^year\s*,/i.test(l);
  const userLines = userText.split(/\r?\n/);
  const dataLines = userLines.map((l) => l.trim()).filter(isData);
  // Already 6-column (or empty, or some other shape entirely): not ours to
  // touch — load-time validation owns every malformed case.
  if (dataLines.length === 0 || !dataLines.every((l) => l.split(',').length === 5)) return;

  const baaByYear = new Map<string, string>();
  for (const line of (await defaultsFiles.readText(srcCsv)).split(/\r?\n/)) {
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
  await dataFiles.writeText(destCsv, out.join('\n'));
  changes.push(
    `${describeDataFile(destCsv)}: added baa column (${dataLines.length} rows joined by year)`,
  );
}

/**
 * Backfill new default keys into the user's assumption files (additive only;
 * user-edited values always survive; changed files are saved back
 * pretty-printed). Returns a human-readable change log, one entry per file.
 * Idempotent: a second pass reports no changes. Runs during init AND at the
 * top of loadAssumptions, so required-key validation self-heals when the repo
 * defaults gain keys (e.g. federal `charitable`, rmd `singleLifeTable`).
 */
export async function backfillAssumptionDefaults(): Promise<string[]> {
  const changes: string[] = [];
  if (!(await dataFiles.exists('assumptions'))) return changes;
  await backfillDir('assumptions', 'assumptions', changes);
  await backfillHistoricalBaaColumn(
    'assumptions/historical-returns.csv',
    'assumptions/historical-returns.csv',
    changes,
  );
  return changes;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function profilePath(): string {
  return 'profile.json';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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

/**
 * THE ONE-TIME GIVING-SPLIT PASS, run at startup (initDataDir) before anything
 * is served. It has to be a single ordered pass over the whole data folder
 * because the trap rule above is gated on evidence that only exists until the
 * profile is migrated: profile.json still carrying the bundled rule. Order:
 *
 * 1. Read profile.json RAW and remember whether it carries the bundle.
 * 2. Normalise plan.json and every scenarios/*.json (trap rule gated on 1),
 *    persisting changed files.
 * 3. Migrate profile.json itself (migrateProfile) and persist — in this same
 *    pass, so the gate can never be consulted a second time with stale truth.
 *
 * Unreadable or malformed files are SKIPPED, not failed: each load path
 * already reports them with its own helpful, file-naming error, and a broken
 * cabinet file must not stop the server from starting.
 */
export async function migrateGivingSplitFiles(): Promise<string[]> {
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

  const files: string[] = [];
  const planFile = 'plan.json';
  if (await dataFiles.exists(planFile)) files.push(planFile);
  if (await dataFiles.exists('scenarios')) {
    for (const entry of await dataFiles.list('scenarios')) {
      if (entry.name.endsWith('.json')) files.push(`scenarios/${entry.name}`);
    }
  }

  for (const filePath of files) {
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

export async function loadProfile(): Promise<Profile> {
  const filePath = profilePath();
  const raw = await readJsonFile(filePath);
  const { profile: migrated, changed } = migrateProfile(raw);
  if (changed.length > 0) {
    await writeJsonPretty(filePath, migrated);
    console.log(`Migrated profile ${describeDataFile(filePath)}:\n  - ${changed.join('\n  - ')}`);
  }
  return validate(profileSchema, migrated, `profile (${describeDataFile(filePath)})`);
}

export async function saveProfile(profile: Profile): Promise<void> {
  const valid = validate(profileSchema, profile, 'profile');
  await writeJsonPretty(profilePath(), valid);
}

// ---------------------------------------------------------------------------
// Quotes (quotes.json) and the resolved profile
// ---------------------------------------------------------------------------

function quotesPath(): string {
  return 'quotes.json';
}

/**
 * Stored quotes. A MISSING file is an empty store, not an error — a data
 * folder that has never refreshed prices simply has none yet, and the
 * holdings resolver reports the symbols as missing with the fix. A file that
 * exists but is malformed fails loudly with its filename, like every other
 * data file here.
 */
export async function loadQuotes(): Promise<QuotesFile> {
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

export async function saveQuotes(quotes: QuotesFile): Promise<void> {
  const valid = validate(quotesFileSchema, quotes, 'quotes');
  await writeJsonPretty(quotesPath(), valid);
}

/**
 * THE PROFILE AS EVERYTHING DOWNSTREAM MUST SEE IT: loaded, migrated,
 * validated, and with every holdings-mode account's balance/allocation
 * re-derived from the stored quotes. This is the single chokepoint the
 * holdings design hangs on — the run manager, the search manager, the snapshot
 * scorer and GET /api/profile all read THIS, so a price refresh moves every one
 * of them together and no two surfaces can disagree about what the IRA is
 * worth.
 *
 * LENIENT ABOUT MISSING QUOTES, deliberately: an account with an unpriced
 * symbol keeps its stored (last-resolved) figures and the symbol is reported
 * in `missing`. The profile EDITOR must render before the first refresh ever
 * happens, so missing cannot be fatal here — the run manager and the search
 * manager check `missing` themselves and refuse to simulate, because a run
 * quietly priced from a stale cache is the one outcome worse than an error.
 */
export async function loadResolvedProfile(): Promise<HoldingsResolution> {
  const profile = await loadProfile();
  const quotes = await loadQuotes();
  return resolveAccounts(profile, quotes);
}

// ---------------------------------------------------------------------------
// Assumptions
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

async function loadStateTax(state: StateCode): Promise<StateTaxData> {
  const filePath = `assumptions/tax/${state}-2026.json`;
  return loadDataFile<StateTaxData>(filePath, STATE_KEYS, `${state.toUpperCase()} state tax data`);
}

/** Load and assemble the full Assumptions bundle from the data folder. */
export async function loadAssumptions(): Promise<Assumptions> {
  // Self-heal: user copies seeded before a repo default gained new keys would
  // otherwise fail the required-key checks below (additive, no-op when clean).
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
    csvText = await dataFiles.readText(csvPath);
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      throw new NotFoundError(`File not found: ${describeDataFile(csvPath)}`);
    }
    throw err;
  }
  // Dynamic import: the engine module is loaded lazily so the data store stays
  // importable (and testable) independently of the engine build.
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

export async function saveMarket(market: MarketAssumptions): Promise<void> {
  requireKeys(market, MARKET_KEYS, 'market assumptions');
  await writeJsonPretty('assumptions/market.json', market);
}
