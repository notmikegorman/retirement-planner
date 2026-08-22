/**
 * dataStore tests: seeding, never-overwrite semantics, profile round-trip, and
 * helpful errors on malformed files. The plan itself lives in planStore now,
 * and so do its tests (tests/server/planStore.test.ts); loadPlan/savePlan
 * appear here only as the operations that must leave everything else alone.
 *
 * Each test points FPLAN_DATA_DIR at a fresh temp dir. No network ports are
 * bound and nothing outside the temp dir is written — in particular the
 * owner's real data folder is never read or touched.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ValidationError,
  getDataDir,
  initDataDir,
  loadProfile,
  migrateGivingSplitFiles,
  migrateProfile,
  migrateScenarioGivingInPlace,
  saveProfile,
} from '../../src/server/dataStore';
import { loadPlan, savePlan } from '../../src/server/planStore';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-datastore-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('getDataDir', () => {
  it('honors FPLAN_DATA_DIR', () => {
    expect(getDataDir()).toBe(tmpDir);
  });
});

describe('initDataDir seeding', () => {
  it('seeds profile, starter reference, assumptions, and runs/ — but no scenarios/', async () => {
    const { dataDir, existedBefore } = await initDataDir();
    expect(dataDir).toBe(tmpDir);
    // Fresh temp dir had no profile.json -> not initialized before.
    expect(existedBefore).toBe(false);

    // profile.starter.json -> profile.json, plus the pristine starter alongside.
    const seededProfile = await fs.readFile(path.join(tmpDir, 'profile.json'), 'utf8');
    const starter = await fs.readFile(path.join(defaultsDir, 'profile.starter.json'), 'utf8');
    expect(seededProfile).toBe(starter);
    expect(await exists(path.join(tmpDir, 'profile.starter.json'))).toBe(true);

    // Every default assumptions file lands, including the tax/ subtree + CSV.
    for (const rel of [
      'assumptions/market.json',
      'assumptions/historical-returns.csv',
      'assumptions/social-security.json',
      'assumptions/medicare-2026.json',
      'assumptions/aca-2026.json',
      'assumptions/rmd-table.json',
      'assumptions/tax/federal-2026.json',
      'assumptions/tax/va-2026.json',
      'assumptions/tax/sc-2026.json',
      'assumptions/tax/nc-2026.json',
    ]) {
      expect(await exists(path.join(tmpDir, rel)), rel).toBe(true);
    }

    // There is one plan, not a library: no scenarios/ folder is created and no
    // sample scenarios are copied in.
    expect(await exists(path.join(tmpDir, 'scenarios'))).toBe(false);

    // runs/ cache dir exists.
    const runsStat = await fs.stat(path.join(tmpDir, 'runs'));
    expect(runsStat.isDirectory()).toBe(true);
  });

  it('second init never overwrites user-modified files and reports existedBefore', async () => {
    await initDataDir();

    // User edits their profile...
    const profile = await loadProfile();
    profile.expenses.livingMonthly = 12345;
    await saveProfile(profile);

    // ...and their plan.
    const plan = await loadPlan();
    await savePlan({ ...plan, events: [...plan.events, { type: 'sell_house', date: '2035-04' }] });

    const second = await initDataDir();
    expect(second.existedBefore).toBe(true);

    // Modified files survive untouched.
    expect((await loadProfile()).expenses.livingMonthly).toBe(12345);
    expect((await loadPlan()).events).toHaveLength(plan.events.length + 1);
  });
});

describe('historical-returns baa-column backfill (pre-baa data folders self-heal)', () => {
  const csvRel = path.join('assumptions', 'historical-returns.csv');

  /** Strip the seeded CSV back to the pre-baa 5-column format. */
  async function writePreBaaCsv(mutate?: (lines: string[]) => string[]): Promise<void> {
    const seeded = await fs.readFile(path.join(defaultsDir, csvRel), 'utf8');
    let lines = seeded
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'))
      .filter((l) => l.trim().length > 0)
      .map((l) =>
        /^year\s*,/i.test(l.trim())
          ? 'year,stocks,bonds10,tbills,cpi'
          : l.split(',').slice(0, 5).join(','),
      );
    lines = ['# the user annotated this file', ...(mutate ? mutate(lines) : lines)];
    await fs.mkdir(path.join(tmpDir, 'assumptions'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, csvRel), lines.join('\n'), 'utf8');
  }

  it('appends the baa column by year, preserving user-edited values and comments', async () => {
    await initDataDir();
    await writePreBaaCsv((lines) =>
      // A user hand-edited 1928 stocks: that value must survive the append.
      lines.map((l) => (l.startsWith('1928,') ? '1928,0.9999,0.0084,0.0308,-0.0116' : l)),
    );
    await initDataDir(); // second init runs the backfill

    const healed = await fs.readFile(path.join(tmpDir, csvRel), 'utf8');
    const lines = healed.split('\n');
    expect(lines[0]).toBe('# the user annotated this file'); // comment verbatim
    expect(lines[1]).toBe('year,stocks,bonds10,tbills,cpi,baa');
    // User's edited value survives byte-for-byte, with the default 1928 baa appended.
    expect(lines[2]).toBe('1928,0.9999,0.0084,0.0308,-0.0116,0.0322');
    // The healed file passes the 6-column loader (via the engine's own parser).
    const { loadHistoricalCsv } = await import('../../src/engine/returns');
    expect(() => loadHistoricalCsv(healed.replace('0.9999', '0.4381'))).not.toThrow();
  });

  it('is idempotent: a healed (6-column) file is left byte-for-byte alone', async () => {
    await initDataDir();
    await writePreBaaCsv();
    await initDataDir();
    const once = await fs.readFile(path.join(tmpDir, csvRel), 'utf8');
    await initDataDir();
    expect(await fs.readFile(path.join(tmpDir, csvRel), 'utf8')).toBe(once);
  });

  it('leaves a file with an unknown year untouched (fail loudly, never invent a return)', async () => {
    await initDataDir();
    await writePreBaaCsv((lines) => [...lines, '2099,0.05,0.02,0.01,0.02']);
    const before = await fs.readFile(path.join(tmpDir, csvRel), 'utf8');
    await initDataDir();
    // Untouched: no baa value exists for 2099, and guessing one would be worse
    // than the loud 6-column load error the user will see and can fix.
    expect(await fs.readFile(path.join(tmpDir, csvRel), 'utf8')).toBe(before);
  });
});

describe('profile', () => {
  it('round-trips save -> load exactly, pretty-printed', async () => {
    await initDataDir();
    const profile = await loadProfile();
    profile.expenses.livingMonthly = 9876.54;
    profile.settings.seed = 42424242;
    await saveProfile(profile);

    const reloaded = await loadProfile();
    expect(reloaded).toEqual(profile);

    // Saved file is human-readable 2-space JSON with a trailing newline.
    const raw = await fs.readFile(path.join(tmpDir, 'profile.json'), 'utf8');
    expect(raw.startsWith('{\n  "')).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('malformed profile JSON produces a helpful error naming the file', async () => {
    await initDataDir();
    await fs.writeFile(path.join(tmpDir, 'profile.json'), '{ "people": [oops', 'utf8');
    const err = await loadProfile().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain('Malformed JSON');
    // The error must name the offending file so the user can go fix it.
    expect(err?.message).toContain(path.join(tmpDir, 'profile.json'));
  });

  it('schema-invalid profile produces a helpful error naming the file', async () => {
    await initDataDir();
    // Valid JSON, invalid shape: people must have 1-2 entries.
    await fs.writeFile(path.join(tmpDir, 'profile.json'), '{ "people": [] }', 'utf8');
    const err = await loadProfile().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain('Invalid profile');
    expect(err?.message).toContain(path.join(tmpDir, 'profile.json'));
  });
});

describe('profile migration', () => {
  /**
   * Old-shape fixture mirroring the user's LIVE data: real values he typed
   * (name "Alex", PIA 3180) that migration must NEVER overwrite, plus the old
   * 1750 ACA placeholder which is the ONE value migration is authorized to
   * rewrite (to the starter's researched benchmark).
   */
  function oldShapeProfile(): Record<string, unknown> {
    return {
      people: [
        {
          id: 'p1',
          name: 'Alex',
          birthYear: 1971,
          birthMonth: 6,
          piaMonthlyAtFra: 3180,
          hasOwnBenefit: true,
        },
        {
          id: 'p2',
          name: 'Jordan',
          birthYear: 1971,
          birthMonth: 6,
          piaMonthlyAtFra: 0,
          hasOwnBenefit: false,
        },
      ],
      filing: { status: 'mfj', state: 'va' },
      accounts: [
        {
          id: 'k401',
          type: '401k',
          owner: 'p1',
          balance: 850000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
          currentEmployer: true,
          ruleOf55Eligible: true,
          allowsPartialWithdrawals: null,
        },
        {
          id: 'ira1',
          type: 'traditional_ira',
          owner: 'p1',
          balance: 250000,
          allocation: { stocks: 1, bonds: 0, bills: 0 },
        },
        {
          id: 'savings',
          type: 'savings',
          owner: 'p1',
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
      expenses: { annualBaseline: 72000, categories: {} },
      health: { acaBenchmarkMonthly: 1750, acaQuoteYear: 2026, partDPlanMonthly: 45 },
      settings: {
        horizonAge: 95,
        successTarget: 0.85,
        mcPathsInteractive: 1000,
        mcPathsFinal: 10000,
        seed: 20260812,
        spendingPolicy: { type: 'fixed_real' },
        withdrawalPolicy: {
          order: ['cash', 'taxable', 'pretax', 'roth'],
          pretaxPreference: 'rule_of_55_first',
        },
      },
    };
  }

  it('migrates an old-shape file, preserving live values (PIA 3180, name "Alex")', () => {
    const { profile, changed } = migrateProfile(oldShapeProfile());
    expect(changed.length).toBeGreaterThan(0);
    const p = profile as {
      people: Array<Record<string, unknown>>;
      accounts: Array<Record<string, unknown>>;
      expenses: Record<string, unknown>;
      health: Record<string, unknown>;
      settings: { withdrawalPolicy: Record<string, unknown> };
    };

    // Owner-typed values survive: PIA copied into BOTH new fields, name untouched.
    expect(p.people[0].piaMonthlyAtFraIfWorkingTo62).toBe(3180);
    expect(p.people[0].piaMonthlyAtFraIfStoppingNow).toBe(3180);
    expect(p.people[0].name).toBe('Alex');
    expect(p.people[0]).not.toHaveProperty('piaMonthlyAtFra');
    expect(p.people[1].piaMonthlyAtFraIfWorkingTo62).toBe(0);
    expect(p.people[1].name).toBe('Jordan');

    // Accounts get name = id; deprecated fields tolerated in place.
    expect(p.accounts[0].name).toBe('k401');
    expect(p.accounts[0].ruleOf55Eligible).toBe(true);
    expect(p.accounts[0].allowsPartialWithdrawals).toBeNull();

    // Expense streams: annualBaseline 72000 → 6000/mo living + zeroed new streams.
    expect(p.expenses).toEqual({ livingMonthly: 6000, charitableMonthly: 0, investingMonthly: 0 });

    // Health: exact 1750 placeholder → the starter's 1480 benchmark; employer
    // share defaults to 0.
    expect(p.health.acaBenchmarkMonthly).toBe(1480);
    expect(p.health.employerPremiumShareMonthly).toBe(0);
    expect(changed).toContain('acaBenchmarkMonthly 1750→1480 (starter SLCSP benchmark)');

    // rule_of_55_first → ira_first.
    expect(p.settings.withdrawalPolicy.pretaxPreference).toBe('ira_first');

    // Idempotent: a second pass reports no changes and leaves the profile alone.
    const second = migrateProfile(profile);
    expect(second.changed).toEqual([]);
    expect(second.profile).toEqual(profile);
  });

  it('does NOT touch a non-placeholder ACA benchmark (only the exact 1750)', () => {
    const fixture = oldShapeProfile();
    (fixture.health as Record<string, unknown>).acaBenchmarkMonthly = 1800;
    const { profile, changed } = migrateProfile(fixture);
    expect((profile as { health: Record<string, unknown> }).health.acaBenchmarkMonthly).toBe(1800);
    expect(changed.join(';')).not.toContain('acaBenchmarkMonthly');
  });

  it('new-shape starter profile passes through migration unchanged', async () => {
    const starter = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'profile.starter.json'), 'utf8'),
    ) as unknown;
    const { profile, changed } = migrateProfile(starter);
    expect(changed).toEqual([]);
    expect(profile).toEqual(starter);
  });

  it("leaves the OWNER's profile completely alone — no paired values are invented (note 19)", async () => {
    // The user's real shape: living 8,450/mo, giving 2,300/mo, investing
    // 1,250/mo, and NONE of the retired counterparts named. Migration must be
    // a pure no-op: the retired sides are optional and their absence already
    // means the right thing (living unchanged, investing 0, giving 'continue',
    // retirement income 0), so writing anything into the file would either add
    // noise or, worse, silently rewrite their plan.
    const starter = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'profile.starter.json'), 'utf8'),
    ) as Record<string, any>;
    const owner = {
      ...starter,
      expenses: { livingMonthly: 8200, charitableMonthly: 2300, investingMonthly: 1250 },
    };
    const before = JSON.stringify(owner);
    const { profile, changed } = migrateProfile(owner);
    expect(changed).toEqual([]);
    expect(profile).toEqual(owner);
    // Byte-identical, key order included — nothing added, nothing reordered.
    expect(JSON.stringify(profile)).toBe(before);
    // In particular, none of the new optional fields materialized.
    const p = profile as { expenses: Record<string, unknown>; income: Record<string, unknown> };
    expect(p.expenses).not.toHaveProperty('livingMonthlyRetired');
    expect(p.expenses).not.toHaveProperty('investingMonthlyRetired');
    expect(p.expenses).not.toHaveProperty('retirementGiving');
    expect(p.income).not.toHaveProperty('retirementMonthly');
    expect(p.income).not.toHaveProperty('retirementIncomeTaxable');
    // And the input object itself was never mutated.
    expect(JSON.stringify(owner)).toBe(before);
  });

  it('carries paired values and retirement income through untouched when they ARE set', async () => {
    // The other half of the guarantee: once the user fills the retired cells
    // in, migration must not normalize, round, or drop them.
    const starter = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'profile.starter.json'), 'utf8'),
    ) as Record<string, any>;
    const filled = {
      ...starter,
      expenses: {
        livingMonthly: 8200,
        livingMonthlyRetired: 7200,
        charitableMonthly: 2300,
        investingMonthly: 1250,
        investingMonthlyRetired: 400,
        retirementGiving: { type: 'amount', monthly: 1800 },
      },
      income: {
        ...starter.income,
        retirementMonthly: 2000,
        retirementIncomeTaxable: false,
      },
    };
    const { profile, changed } = migrateProfile(filled);
    expect(changed).toEqual([]);
    expect(profile).toEqual(filled);
  });

  it('loadProfile migrates old files in place: parses, saves back pretty JSON', async () => {
    await initDataDir();
    const profileFile = path.join(tmpDir, 'profile.json');
    await fs.writeFile(profileFile, JSON.stringify(oldShapeProfile()), 'utf8');

    const loaded = await loadProfile();
    expect(loaded.people[0].piaMonthlyAtFraIfWorkingTo62).toBe(3180);
    expect(loaded.people[0].piaMonthlyAtFraIfStoppingNow).toBe(3180);
    expect(loaded.expenses.livingMonthly).toBe(6000);
    expect(loaded.health.acaBenchmarkMonthly).toBe(1480);
    expect(loaded.settings.withdrawalPolicy.pretaxPreference).toBe('ira_first');

    // The migrated shape was written back, pretty-printed.
    const raw = await fs.readFile(profileFile, 'utf8');
    expect(raw.startsWith('{\n  "')).toBe(true);
    expect(raw).not.toContain('piaMonthlyAtFra"');
    expect(raw).not.toContain('annualBaseline');
    const onDisk = JSON.parse(raw) as unknown;
    expect(migrateProfile(onDisk).changed).toEqual([]);

    // Loading again is a no-op migration returning the same profile.
    expect(await loadProfile()).toEqual(loaded);
  });
});

describe('the giving split migration (tithe_account → ongoing + untithedPot)', () => {
  /** A current-shape profile carrying the legacy bundled rule. */
  async function legacyProfile(): Promise<Record<string, any>> {
    const starter = JSON.parse(
      await fs.readFile(path.join(defaultsDir, 'profile.starter.json'), 'utf8'),
    ) as Record<string, any>;
    return {
      ...starter,
      expenses: {
        livingMonthly: 8200,
        charitableMonthly: 2300,
        investingMonthly: 1250,
        retirementGiving: {
          type: 'tithe_account',
          percent: 0.1,
          deferYears: 11,
          seedFromExistingGains: true,
        },
      },
    };
  }

  it('migrateProfile splits the bundle into the pair the rule always meant', async () => {
    const { profile, changed } = migrateProfile(await legacyProfile());
    const e = (profile as { expenses: Record<string, unknown> }).expenses;
    expect(e.retirementGiving).toEqual({ type: 'percent_of_growth', percent: 0.1 });
    // percent and seedFromGains written explicitly (they were REQUIRED fields
    // of the bundle — the user's chosen values, not untouched defaults);
    // distributeYears / earlyRelease / ongoingDuringHold stay ABSENT so a
    // future default change still reaches the migrated file.
    expect(e.untithedPot).toEqual({ percent: 0.1, holdYears: 11, seedFromGains: true });
    expect(changed.join(';')).toContain("'tithe_account' → ongoing percent_of_growth + untithedPot");
    // Idempotent: the migrated shape passes through untouched.
    const second = migrateProfile(profile);
    expect(second.changed).toEqual([]);
    expect(second.profile).toEqual(profile);
  });

  it('migrateProfile carries the optional bundle fields only when they were present', async () => {
    const fixture = await legacyProfile();
    fixture.expenses.retirementGiving = {
      type: 'tithe_account',
      percent: 0.12,
      deferYears: 5,
      seedFromExistingGains: false,
      distributeYears: 7,
      earlyRelease: false,
      allocation: { stocks: 0.6, bonds: 0.4, bills: 0 },
    };
    const { profile } = migrateProfile(fixture);
    expect((profile as { expenses: Record<string, unknown> }).expenses.untithedPot).toEqual({
      percent: 0.12,
      holdYears: 5,
      seedFromGains: false,
      distributeYears: 7,
      earlyRelease: false,
      allocation: { stocks: 0.6, bonds: 0.4, bills: 0 },
    });
  });

  it('migrateScenarioGivingInPlace: a bundle override becomes ongoing + an EXPLICIT pot', () => {
    const scenario: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: {
        expenses: {
          retirementGiving: {
            type: 'tithe_account',
            percent: 0.08,
            deferYears: 0,
            seedFromExistingGains: true,
          },
        },
      },
    };
    const changed = migrateScenarioGivingInPlace(scenario, { disableInheritedPot: true });
    expect(changed.length).toBe(1);
    const e = scenario.assumption_overrides.expenses;
    expect(e.retirementGiving).toEqual({ type: 'percent_of_growth', percent: 0.08 });
    // EXPLICIT, not inherited: the old override replaced the whole rule, so
    // its pot must beat whatever the profile ends up with.
    expect(e.untithedPot).toEqual({ percent: 0.08, holdYears: 0, seedFromGains: true });
    // Idempotent.
    expect(migrateScenarioGivingInPlace(scenario, { disableInheritedPot: true })).toEqual([]);
  });

  it('migrateScenarioGivingInPlace: THE TRAP — a pre-split non-tithe override gets the explicit disable', () => {
    // A representative plan.json shape: an override left from an experiment,
    // which under the old model replaced the bundled rule POT AND ALL. Under
    // the new inherit semantics a bare override would resurrect the profile
    // pot, so the one-time pass writes the disable in.
    const scenario: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: {
        expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } },
      },
    };
    const changed = migrateScenarioGivingInPlace(scenario, { disableInheritedPot: true });
    expect(changed.length).toBe(1);
    expect(scenario.assumption_overrides.expenses.untithedPot).toEqual({ enabled: false });
    expect(scenario.assumption_overrides.expenses.retirementGiving).toEqual({
      type: 'percent_of_growth',
      percent: 0.1,
    });
  });

  it('migrateScenarioGivingInPlace: the trap fires ONLY during the gated one-time pass', () => {
    // The same shape written by the NEW UI means "override the ongoing
    // method, inherit the pot" — and the gate (the profile still carrying the
    // bundle) is what tells the two apart. Ungated, nothing may change.
    const scenario: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: {
        expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } },
      },
    };
    expect(migrateScenarioGivingInPlace(scenario, { disableInheritedPot: false })).toEqual([]);
    expect(scenario.assumption_overrides.expenses).not.toHaveProperty('untithedPot');
    // An override that already says something about the pot is never touched
    // either — user values always win.
    const explicit: Record<string, any> = {
      name: 'Plan',
      events: [],
      assumption_overrides: {
        expenses: {
          retirementGiving: { type: 'none' },
          untithedPot: { holdYears: 3 },
        },
      },
    };
    expect(migrateScenarioGivingInPlace(explicit, { disableInheritedPot: true })).toEqual([]);
    expect(explicit.assumption_overrides.expenses.untithedPot).toEqual({ holdYears: 3 });
  });

  it('the one-time pass sweeps profile + plan + cabinet in one ordered breath', async () => {
    await initDataDir();
    // A PRE-SPLIT data folder: profile still carries the bundle (the gate),
    // the plan carries the user's trap-shaped override, and the cabinet
    // holds one current-shape file with a bundle override and one legacy
    // bare-Scenario file with a trap-shaped override.
    await fs.writeFile(
      path.join(tmpDir, 'profile.json'),
      JSON.stringify(await legacyProfile()),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'plan.json'),
      JSON.stringify({
        name: 'Plan',
        events: [],
        assumption_overrides: {
          expenses: { retirementGiving: { type: 'percent_of_growth', percent: 0.1 } },
        },
      }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'scenarios'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'scenarios', 'bundle.json'),
      JSON.stringify({
        name: 'Bundle',
        savedAt: '2026-01-01T00:00:00.000Z',
        scenario: {
          name: 'Bundle',
          events: [],
          assumption_overrides: {
            expenses: {
              retirementGiving: {
                type: 'tithe_account',
                percent: 0.08,
                deferYears: 2,
                seedFromExistingGains: false,
              },
            },
          },
        },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'scenarios', 'legacy-bare.json'),
      JSON.stringify({
        name: 'Bare',
        events: [],
        assumption_overrides: { expenses: { retirementGiving: { type: 'none' } } },
      }),
      'utf8',
    );

    const changes = await migrateGivingSplitFiles();
    expect(changes.length).toBeGreaterThanOrEqual(4); // plan + 2 cabinet files + profile

    const plan = JSON.parse(await fs.readFile(path.join(tmpDir, 'plan.json'), 'utf8'));
    expect(plan.assumption_overrides.expenses.untithedPot).toEqual({ enabled: false });

    const bundle = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'scenarios', 'bundle.json'), 'utf8'),
    );
    expect(bundle.scenario.assumption_overrides.expenses.retirementGiving).toEqual({
      type: 'percent_of_growth',
      percent: 0.08,
    });
    expect(bundle.scenario.assumption_overrides.expenses.untithedPot).toEqual({
      percent: 0.08,
      holdYears: 2,
      seedFromGains: false,
    });

    const bare = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'scenarios', 'legacy-bare.json'), 'utf8'),
    );
    expect(bare.assumption_overrides.expenses.untithedPot).toEqual({ enabled: false });

    // The profile itself was migrated IN the pass, erasing the gate...
    const profile = JSON.parse(await fs.readFile(path.join(tmpDir, 'profile.json'), 'utf8'));
    expect(profile.expenses.retirementGiving).toEqual({ type: 'percent_of_growth', percent: 0.1 });
    expect(profile.expenses.untithedPot).toEqual({
      percent: 0.1,
      holdYears: 11,
      seedFromGains: true,
    });

    // ...so a second pass is a no-op, and — the part the gate exists for — a
    // NEW-SEMANTICS plan (bare ongoing override, pot inherited on purpose)
    // written after the migration is never clobbered by a later restart.
    expect(await migrateGivingSplitFiles()).toEqual([]);
    await fs.writeFile(
      path.join(tmpDir, 'plan.json'),
      JSON.stringify({
        name: 'Plan',
        events: [],
        assumption_overrides: {
          expenses: { retirementGiving: { type: 'amount', monthly: 500 } },
        },
      }),
      'utf8',
    );
    expect(await migrateGivingSplitFiles()).toEqual([]);
    const untouched = JSON.parse(await fs.readFile(path.join(tmpDir, 'plan.json'), 'utf8'));
    expect(untouched.assumption_overrides.expenses).not.toHaveProperty('untithedPot');
  });

  it('initDataDir runs the pass before anything is served', async () => {
    // Seed a legacy pair into an EXISTING folder, then init as the server
    // does at startup: the files must come out migrated without any load
    // having been asked for.
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'profile.json'),
      JSON.stringify(await legacyProfile()),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'plan.json'),
      JSON.stringify({
        name: 'Plan',
        events: [],
        assumption_overrides: {
          expenses: { retirementGiving: { type: 'percent_of_income', percent: 0.05 } },
        },
      }),
      'utf8',
    );
    await initDataDir();
    const plan = JSON.parse(await fs.readFile(path.join(tmpDir, 'plan.json'), 'utf8'));
    expect(plan.assumption_overrides.expenses.untithedPot).toEqual({ enabled: false });
    const profile = JSON.parse(await fs.readFile(path.join(tmpDir, 'profile.json'), 'utf8'));
    expect(profile.expenses.untithedPot).toEqual({
      percent: 0.1,
      holdYears: 11,
      seedFromGains: true,
    });
    // And what init wrote parses under the strict schemas.
    await expect(loadProfile()).resolves.toBeDefined();
    await expect(loadPlan()).resolves.toBeDefined();
  });
});

describe("the user's old scenarios/ folder", () => {
  /**
   * Scenario management is gone, but the files the user accumulated are HIS —
   * he may still want to copy events out of them. Nothing in the data store may
   * read, rewrite, or remove them: they simply stopped being surfaced.
   */
  const OLD_FILES: Record<string, string> = {
    'base-case.json':
      '{\n  "name": "Base case",\n  "events": [{ "type": "retire", "person": "p1", "date": "2026-07" }]\n}\n',
    // Deliberately ugly + schema-invalid: an untouched file is not a validated
    // one, and nothing may try to "fix" it.
    'half-finished.json': '{"name":"Half finished","events":[],"stray":true}',
  };

  async function seedOldScenarios(): Promise<void> {
    const dir = path.join(tmpDir, 'scenarios');
    await fs.mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(OLD_FILES)) {
      await fs.writeFile(path.join(dir, name), text, 'utf8');
    }
  }

  async function expectUntouched(): Promise<void> {
    const dir = path.join(tmpDir, 'scenarios');
    expect((await fs.readdir(dir)).sort()).toEqual(Object.keys(OLD_FILES).sort());
    for (const [name, text] of Object.entries(OLD_FILES)) {
      expect(await fs.readFile(path.join(dir, name), 'utf8'), name).toBe(text);
    }
  }

  it('survives init, plan seeding, and plan saves byte-identical', async () => {
    await seedOldScenarios();

    await initDataDir();
    await expectUntouched();

    const plan = await loadPlan(); // seeds plan.json
    await expectUntouched();

    await savePlan({ ...plan, events: [] });
    await savePlan({ ...plan, events: [{ type: 'sell_house', date: '2031-05' }] });
    await expectUntouched();

    // A second init does not re-seed sample scenarios over them either.
    await initDataDir();
    await expectUntouched();
  });
});
