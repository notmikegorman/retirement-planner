/**
 * ONE-SHOT: seed plan-history.json from the two files the baseline feature
 * left behind, then retire them.
 *
 * The data folder holds three copies of one household's plan, written at three
 * moments and by three different features:
 *
 *   scenarios/baseline.json  the filing cabinet's record, saved 2026-08-18 with
 *                            the metrics it scored (93.8%, 1,000 paths)
 *   baseline.json            the frozen baseline, designated 2026-08-20
 *   plan.json                the plan as it stands
 *
 * All three are versions of the plan, and the plan's history is where versions
 * live now. So they are filed there in that order, oldest first, and the two
 * retired files are removed ONLY after their content is provably present in the
 * new one — byte for byte on the plan, hash for hash on the fingerprint.
 *
 * WHAT THIS DOES NOT DO:
 *  - It does not touch plan.json. The current plan stays the plan; it is filed
 *    as today's starting point, not replaced by anything older.
 *  - It does not "fix" the older two. Both still carry the retired
 *    allocation_change from 2026-06 and a different insurance disposition, and
 *    that is exactly why they are history: an entry is a record of what was.
 *  - It does not re-score anything. The Aug-18 record carries the numbers it
 *    was actually measured with, under the conditions it was measured under.
 *  - It does not touch networth.json. The score shape stayed backward
 *    compatible on purpose, so the ledger needs no migration at all.
 *
 * Run: npx tsx scripts/migrate-plan-history.ts [--apply]
 * Without --apply it reports what it would do and writes nothing.
 *
 * (Unit tests: tests/server/planHistoryMigration.test.ts, which runs this
 * against a temp folder holding copies of the three files' real shapes.)
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { PlanHistoryEntry, PlanScore, Scenario } from '../src/shared/types';
import { planHistoryFileSchema, scenarioSchema } from '../src/shared/schemas';
import { planIdentityKey } from '../src/shared/planIdentity';

export interface MigrateOptions {
  dataDir?: string;
  /** Without this nothing is written — the run only reports what it would do. */
  apply?: boolean;
  /** The moment today's entry is filed at. Injected so a test can pin it. */
  now?: Date;
  log?: (line: string) => void;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The fingerprint the store stamps on an entry — identity, not bytes. */
function planHash(plan: Scenario): string {
  return sha256(planIdentityKey(plan));
}

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function digestOf(p: string): Promise<string> {
  const text = await readText(p);
  return text === null ? '(absent)' : sha256(text);
}

/**
 * Parse a stored scenario through the app's own schema.
 *
 * Parsed rather than copied raw, because the schema strips unknown keys: an
 * entry that hashed the raw shape and stored the parsed one would carry a
 * fingerprint of something the file no longer holds. Anything stripped is
 * reported — on this folder nothing is, and if that ever changed it would be a
 * fact worth seeing rather than swallowing.
 */
function asPlan(raw: unknown, label: string, log: (line: string) => void): Scenario {
  const parsed = scenarioSchema.parse(raw) as Scenario;
  const before = JSON.stringify(raw);
  const after = JSON.stringify(parsed);
  if (before !== after) {
    log(`  note: ${label} lost keys the current schema does not know:`);
    log(`    stored : ${before.length} chars`);
    log(`    parsed : ${after.length} chars`);
  }
  return parsed;
}

/** Returns true when the folder ends up migrated (or already was, on a dry run). */
export async function migratePlanHistory(options: MigrateOptions = {}): Promise<boolean> {
  const dataDir =
    options.dataDir ?? process.env.FPLAN_DATA_DIR ?? path.join(os.homedir(), 'finance-planner-data');
  const apply = options.apply ?? false;
  const now = options.now ?? new Date();
  const console = { log: options.log ?? ((line: string) => process.stdout.write(`${line}\n`)) };
  const error = (line: string): void => console.log(line);
  const stamp = Math.floor(now.getTime() / 1000);
  const file = (...parts: string[]): string => path.join(dataDir, ...parts);

  console.log(`Data folder: ${dataDir}`);
  console.log(apply ? 'Mode: APPLY' : 'Mode: dry run (pass --apply to write)');

  const historyPath = file('plan-history.json');
  if ((await readText(historyPath)) !== null) {
    error(
      `\nRefusing to run: ${historyPath} already exists. This migration seeds a history ` +
        'from scratch; running it twice would file the same three versions again.',
    );
    return false;
  }

  const cabinetPath = file('scenarios', 'baseline.json');
  const frozenPath = file('baseline.json');
  const planPath = file('plan.json');

  const cabinetText = await readText(cabinetPath);
  const frozenText = await readText(frozenPath);
  const planText = await readText(planPath);
  if (planText === null) {
    error(`\nRefusing to run: no ${planPath}. There is no plan to file.`);
    return false;
  }

  console.log('\nBEFORE');
  for (const p of [cabinetPath, frozenPath, planPath, file('networth.json')]) {
    console.log(`  ${await digestOf(p)}  ${p}`);
  }

  const entries: PlanHistoryEntry[] = [];

  // 1. The cabinet's record, with the score it was saved carrying.
  if (cabinetText !== null) {
    const raw = JSON.parse(cabinetText) as {
      scenario: unknown;
      savedAt: string;
      metrics?: {
        engineVersion: string;
        mode: 'deterministic' | 'historical' | 'montecarlo';
        paths: number;
        seeds: number[];
        success: number;
        medianTerminalReal?: number;
        scoredAt: string;
      };
    };
    const plan = asPlan(raw.scenario, 'scenarios/baseline.json', console.log);
    const m = raw.metrics;
    // A recorded number keeps its own conditions. `seeds` is a list because the
    // cabinet averaged over several; this one has exactly one, so it maps onto
    // a score's single `seed` without inventing anything. A multi-seed record
    // would NOT map, and would be filed without a score rather than with a mean
    // pretending to be a measurement.
    const score: PlanScore | undefined =
      m && m.seeds.length === 1
        ? {
            success: m.success,
            ...(m.medianTerminalReal !== undefined
              ? { medianTerminalReal: m.medianTerminalReal }
              : {}),
            mode: m.mode,
            paths: m.paths,
            seed: m.seeds[0],
            engineVersion: m.engineVersion,
            scoredAt: m.scoredAt,
          }
        : undefined;
    entries.push({
      id: `ph-${Date.parse(raw.savedAt).toString(36)}-cab001`,
      takenAt: raw.savedAt,
      kind: 'kept',
      plan,
      planHash: planHash(plan),
      label: 'Baseline — saved Aug 18',
      ...(score ? { score } : {}),
    });
  }

  // 2. The frozen baseline. No score of its own: nothing ever recorded one
  //    against this exact revision, and inventing one now would be a
  //    measurement nobody took.
  if (frozenText !== null) {
    const raw = JSON.parse(frozenText) as { scenario: unknown; designatedAt: string };
    const plan = asPlan(raw.scenario, 'baseline.json', console.log);
    entries.push({
      id: `ph-${Date.parse(raw.designatedAt).toString(36)}-frz001`,
      takenAt: raw.designatedAt,
      kind: 'kept',
      plan,
      planHash: planHash(plan),
      label: 'Baseline — frozen Aug 20',
    });
  }

  // 3. The plan as it stands, as today's starting point. 'day-start' so the
  //    guard counts today as covered: this entry already holds exactly what the
  //    next edit would otherwise file.
  const currentPlan = asPlan(JSON.parse(planText), 'plan.json', console.log);
  entries.push({
    id: `ph-${now.getTime().toString(36)}-cur001`,
    takenAt: now.toISOString(),
    kind: 'day-start',
    plan: currentPlan,
    planHash: planHash(currentPlan),
    label: 'The plan as it stands today',
  });

  entries.sort((a, b) => a.takenAt.localeCompare(b.takenAt));

  // Every entry must parse as the store will read it, or the app would fail to
  // list a history it had just been handed.
  planHistoryFileSchema.parse(entries);

  console.log('\nWOULD FILE');
  for (const e of entries) {
    const scored = e.score
      ? `${(e.score.success * 100).toFixed(1)}% @ ${e.score.paths} paths, engine ${e.score.engineVersion}`
      : 'no score';
    console.log(`  ${e.takenAt}  ${e.kind.padEnd(9)}  ${e.planHash.slice(0, 12)}…  ${e.label}`);
    console.log(`      events: ${e.plan.events.length}   ${scored}`);
  }

  if (!apply) {
    console.log('\nDry run: nothing written.');
    return false;
  }

  // --- Back up everything this touches, including the file it must not change.
  const backups: string[] = [];
  const backupFile = async (src: string, name: string): Promise<void> => {
    const dest = file(`${name}.backup-planhistory-${stamp}.json`);
    await fs.copyFile(src, dest);
    backups.push(dest);
  };
  if (cabinetText !== null) {
    const dir = file(`scenarios.backup-planhistory-${stamp}`);
    await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(file('scenarios'))) {
      await fs.copyFile(file('scenarios', name), path.join(dir, name));
    }
    backups.push(dir);
  }
  if (frozenText !== null) await backupFile(frozenPath, 'baseline');
  await backupFile(planPath, 'plan');

  await fs.writeFile(historyPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  // --- Prove the retired files are preserved before removing either of them.
  const written = planHistoryFileSchema.parse(
    JSON.parse(await fs.readFile(historyPath, 'utf8')),
  ) as PlanHistoryEntry[];

  const preserved = (sourceText: string | null): boolean => {
    if (sourceText === null) return true;
    const raw = JSON.parse(sourceText) as { scenario: unknown };
    const plan = asPlan(raw.scenario, 'verification', console.log);
    const hash = planHash(plan);
    return written.some(
      (e) => e.planHash === hash && JSON.stringify(e.plan) === JSON.stringify(plan),
    );
  };

  const cabinetSafe = preserved(cabinetText);
  const frozenSafe = preserved(frozenText);

  console.log('\nVERIFY');
  console.log(`  scenarios/baseline.json preserved in the history: ${cabinetSafe}`);
  console.log(`  baseline.json preserved in the history:           ${frozenSafe}`);

  if (cabinetSafe && cabinetText !== null) {
    await fs.rm(file('scenarios'), { recursive: true, force: true });
    console.log('  removed scenarios/');
  }
  if (frozenSafe && frozenText !== null) {
    await fs.rm(frozenPath, { force: true });
    console.log('  removed baseline.json');
  }
  if (!cabinetSafe || !frozenSafe) {
    error('  NOT removed: content could not be proved preserved.');
  }

  console.log('\nAFTER');
  for (const p of [cabinetPath, frozenPath, planPath, file('networth.json'), historyPath]) {
    console.log(`  ${await digestOf(p)}  ${p}`);
  }
  console.log('\nBACKUPS');
  for (const b of backups) console.log(`  ${b}`);
  return cabinetSafe && frozenSafe;
}

// Run only when invoked directly, so the test can import the function above.
if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-plan-history.ts')) {
  migratePlanHistory({ apply: process.argv.includes('--apply') }).catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
