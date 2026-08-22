/**
 * The one-shot migration that seeds plan-history.json
 * (scripts/migrate-plan-history.ts).
 *
 * It runs once, against the user's only copy of three years of decisions, and
 * it DELETES two files at the end. So the properties below are the ones that
 * make deleting them defensible:
 *
 *  - the three versions are filed oldest first, each hashing to its source;
 *  - plan.json is not touched — the current plan stays the plan;
 *  - a recorded score is carried AS RECORDED, with its own conditions;
 *  - nothing is removed until its content is provably in the new file;
 *  - a second run refuses rather than filing everything twice.
 *
 * The fixtures below are the real files' shapes — including the two older
 * plans' retired allocation_change and their different insurance disposition,
 * which is exactly what makes them history rather than the plan.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanHistoryEntry, Scenario } from '../../src/shared/types';
import { planIdentityKey } from '../../src/shared/planIdentity';
import { migratePlanHistory } from '../../scripts/migrate-plan-history';

let tmpDir: string;

/** The plan the two older records hold: the retired 60/40 event is on it. */
const OLD_PLAN: Scenario = {
  name: 'Plan',
  description: 'Sell 2027, buy 2028.',
  assumption_overrides: {
    expenses: {
      lifeInsurancePolicyPlans: { 'term-b-1000k': 'cancel_now', 'term-a-2500k': 'cancel_now' },
    },
  },
  events: [
    { type: 'retire', person: 'p1', date: '2028-06' },
    { type: 'allocation_change', date: '2026-06', mix: { stocks: 0.6, bonds: 0.4, bills: 0 } },
  ],
};

/** The plan as it stands: no allocation event, Northbridge kept. */
const CURRENT_PLAN: Scenario = {
  name: 'Plan',
  description: 'Sell 2027, buy 2028. Northbridge is a values call.',
  assumption_overrides: {
    expenses: { lifeInsurancePolicyPlans: { 'term-b-1000k': 'cancel_now' } },
  },
  events: [{ type: 'retire', person: 'p1', date: '2028-06' }],
};

const CABINET_SAVED_AT = '2026-08-18T21:41:17.216Z';
const FROZEN_AT = '2026-08-20T09:24:28.759Z';
const NOW = new Date('2026-08-20T18:00:00.000Z');

const hashOf = (plan: Scenario): string =>
  createHash('sha256').update(planIdentityKey(plan)).digest('hex');

const read = async (rel: string): Promise<string> => fs.readFile(path.join(tmpDir, rel), 'utf8');
const sha = async (rel: string): Promise<string> =>
  createHash('sha256').update(await read(rel)).digest('hex');
const exists = async (rel: string): Promise<boolean> =>
  fs.access(path.join(tmpDir, rel)).then(
    () => true,
    () => false,
  );

async function history(): Promise<PlanHistoryEntry[]> {
  return JSON.parse(await read('plan-history.json')) as PlanHistoryEntry[];
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-migrate-'));
  await fs.mkdir(path.join(tmpDir, 'scenarios'));
  await fs.writeFile(
    path.join(tmpDir, 'scenarios', 'baseline.json'),
    JSON.stringify(
      {
        name: 'Baseline',
        scenario: OLD_PLAN,
        savedAt: CABINET_SAVED_AT,
        metrics: {
          engineVersion: '1.21.0',
          mode: 'montecarlo',
          paths: 1000,
          seeds: [20260812],
          success: 0.938,
          medianTerminalReal: 1284510.4471935,
          charitableTotalReal: 238744.51830261,
          breakGlassReal: 0,
          inputsHash: `${'a'.repeat(64)}:${'b'.repeat(64)}`,
          scoredAt: '2026-08-18T21:41:17.203Z',
          source: 'run',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'baseline.json'),
    JSON.stringify(
      {
        revision: 1,
        scenario: OLD_PLAN,
        designatedAt: FROZEN_AT,
        label: 'Baseline',
        sourceHash: 'c'.repeat(64),
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'plan.json'),
    `${JSON.stringify(CURRENT_PLAN, null, 2)}\n`,
    'utf8',
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const run = (apply: boolean): Promise<boolean> =>
  migratePlanHistory({ dataDir: tmpDir, apply, now: NOW, log: () => undefined });

describe('the dry run', () => {
  it('writes nothing at all', async () => {
    const before = await sha('plan.json');
    expect(await run(false)).toBe(false);
    expect(await exists('plan-history.json')).toBe(false);
    expect(await exists('baseline.json')).toBe(true);
    expect(await exists('scenarios/baseline.json')).toBe(true);
    expect(await sha('plan.json')).toBe(before);
  });
});

describe('the migration', () => {
  it('files the three versions oldest first, each hashing to its source', async () => {
    expect(await run(true)).toBe(true);
    const entries = await history();

    expect(entries.map((e) => e.takenAt)).toEqual([CABINET_SAVED_AT, FROZEN_AT, NOW.toISOString()]);
    expect(entries.map((e) => e.planHash)).toEqual([
      hashOf(OLD_PLAN),
      hashOf(OLD_PLAN),
      hashOf(CURRENT_PLAN),
    ]);
    expect(entries[0].plan).toEqual(OLD_PLAN);
    expect(entries[1].plan).toEqual(OLD_PLAN);
    expect(entries[2].plan).toEqual(CURRENT_PLAN);
  });

  it('leaves plan.json byte for byte as it was — the current plan stays the plan', async () => {
    const before = await read('plan.json');
    await run(true);
    expect(await read('plan.json')).toBe(before);
  });

  it('does not "fix" the older versions — a history entry is a record of what was', async () => {
    // Both older plans still carry the retired allocation_change and the other
    // insurance disposition. That difference is the whole reason they are worth
    // keeping; editing them would make the history a story rather than a record.
    await run(true);
    const [oldest] = await history();
    expect(oldest.plan.events).toContainEqual({
      type: 'allocation_change',
      date: '2026-06',
      mix: { stocks: 0.6, bonds: 0.4, bills: 0 },
    });
    expect(
      oldest.plan.assumption_overrides?.expenses?.lifeInsurancePolicyPlans?.['term-a-2500k'],
    ).toBe('cancel_now');
  });

  it('carries the recorded score AS RECORDED, with its own conditions', async () => {
    // 93.8% at 1,000 paths on engine 1.21.0 is a measurement someone took; it
    // is not re-run here, and it does not borrow today's conditions.
    await run(true);
    const [oldest] = await history();
    expect(oldest.score).toEqual({
      success: 0.938,
      medianTerminalReal: 1284510.4471935,
      mode: 'montecarlo',
      paths: 1000,
      seed: 20260812,
      engineVersion: '1.21.0',
      scoredAt: '2026-08-18T21:41:17.203Z',
    });
  });

  it('files the two unscored versions with no score at all — never a zero', async () => {
    await run(true);
    const entries = await history();
    expect(entries[1].score).toBeUndefined();
    expect(entries[2].score).toBeUndefined();
    expect('score' in entries[1]).toBe(false);
    expect('score' in entries[2]).toBe(false);
  });

  it('marks today’s entry as the day’s start, and the two imports as kept', async () => {
    // Today's entry already holds exactly what the next edit would file, so it
    // satisfies the guard; the two imports are explicit keeps and must not.
    await run(true);
    expect((await history()).map((e) => e.kind)).toEqual(['kept', 'kept', 'day-start']);
  });

  it('removes the two retired files, and only after copying them aside', async () => {
    await run(true);
    expect(await exists('baseline.json')).toBe(false);
    expect(await exists('scenarios')).toBe(false);

    const names = await fs.readdir(tmpDir);
    const backup = names.find((n) => n.startsWith('baseline.backup-planhistory-'));
    const cabinetDir = names.find((n) => n.startsWith('scenarios.backup-planhistory-'));
    const planBackup = names.find((n) => n.startsWith('plan.backup-planhistory-'));
    expect(backup).toBeDefined();
    expect(cabinetDir).toBeDefined();
    // plan.json is backed up too, though it is never written: the cheapest
    // insurance there is against a migration that turns out to be wrong.
    expect(planBackup).toBeDefined();

    const frozen = JSON.parse(await read(backup as string)) as { scenario: Scenario };
    expect(frozen.scenario).toEqual(OLD_PLAN);
    expect(await fs.readdir(path.join(tmpDir, cabinetDir as string))).toEqual(['baseline.json']);
  });

  it('refuses a second run rather than filing everything twice', async () => {
    await run(true);
    const after = await read('plan-history.json');

    expect(await run(true)).toBe(false);
    expect(await read('plan-history.json')).toBe(after);
  });

  it('works on a folder that never had either file', async () => {
    // Any other machine, or a folder restored from before the baseline
    // existed: there is still a plan, and it is still worth filing.
    await fs.rm(path.join(tmpDir, 'baseline.json'));
    await fs.rm(path.join(tmpDir, 'scenarios'), { recursive: true });

    expect(await run(true)).toBe(true);
    const entries = await history();
    expect(entries).toHaveLength(1);
    expect(entries[0].plan).toEqual(CURRENT_PLAN);
  });
});
