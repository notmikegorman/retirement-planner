/**
 * THE PLAN AND ITS HISTORY (src/server/planStore.ts).
 *
 * Two things are pinned here, and the second is the reason this module exists:
 *
 * 1. THE PLAN FILE ITSELF — seeded once, never reseeded, name pinned, malformed
 *    files reported rather than replaced. (These tests moved here with the
 *    code; they used to live in dataStore.test.ts.)
 * 2. THE DAILY GUARD — the plan saves itself on every committed edit, so the
 *    ONLY thing standing between the user and a silently overwritten decision
 *    is that the day's first save files the version it replaces. The properties
 *    below are the ones that make it worth trusting: it fires when history is
 *    empty (the most valuable restore point there is), it fires once per day
 *    and not per keystroke, it files the PRE-change plan rather than the new
 *    one, and a save that changes nothing files nothing.
 *
 * Each test points FPLAN_DATA_DIR at a fresh temp dir and pins the clock
 * explicitly — no test may depend on what day it is run, and none of them may
 * read or touch the user's real data folder.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario, ScenarioEvent } from '../../src/shared/types';
import { NotFoundError, ValidationError, initDataDir } from '../../src/server/dataStore';
import { PLAN_NAME, loadPlan, restorePlan, savePlan } from '../../src/server/planStore';
import {
  keepPlan,
  listPlanHistory,
  planHash,
} from '../../src/server/planHistoryStore';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-planstore-'));
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

/** Put a plan on disk the way the file itself holds it — no guard, no history. */
async function writePlanFile(plan: Scenario): Promise<void> {
  await fs.writeFile(path.join(tmpDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

/** Two moments on the same local calendar day, and one on the next. */
const MORNING = new Date(2026, 7, 20, 8, 30);
/** The same day, before MORNING — for entries that must sort under it. */
const EARLIER = new Date(2026, 7, 20, 7, 15);
const EVENING = new Date(2026, 7, 20, 21, 15);
const NEXT_DAY = new Date(2026, 7, 21, 9, 0);

/**
 * The default plan the seeder must write for the STARTER profile, hand-computed
 * from the two starter people (p1 born 1975-03, p2 born 1977-09 — deliberately
 * DIFFERENT, so this pins the per-person arithmetic and not one shared answer)
 * and the plan defaults in scenarioHelpers (retire at 62, claim at 67,
 * allocation unchanged):
 *
 *   dateAtAge(p1, 62): months = (birthMonth - 1) + 62*12 = 2 + 744 = 746
 *                      year   = 1975 + floor(746/12) = 1975 + 62 = 2037
 *                      month  = 746 % 12 + 1 = 2 + 1 = 3          -> "2037-03"
 *   dateAtAge(p2, 62): months = 8 + 744 = 752
 *                      year   = 1977 + floor(752/12) = 1977 + 62 = 2039
 *                      month  = 752 % 12 + 1 = 8 + 1 = 9          -> "2039-09"
 *   dateAtAge(p1, 67): months = 2 + 67*12 = 2 + 804 = 806
 *                      year   = 1975 + floor(806/12) = 1975 + 67 = 2042
 *                      month  = 806 % 12 + 1 = 2 + 1 = 3          -> "2042-03"
 *
 * writePlan emits retires in people order, then THE PRIMARY'S claim date for
 * every person (the plan carries one household claiming decision, so p2 claims
 * on p1's date, not p2's own 67), then the allocation event — which is absent
 * because the default allocation decision is null ("keep the current
 * allocation"). Four events, and NOTHING else: a new plan starts empty and is
 * built up by hand.
 */
const EXPECTED_SEEDED_EVENTS: ScenarioEvent[] = [
  { type: 'retire', person: 'p1', date: '2037-03' },
  { type: 'retire', person: 'p2', date: '2039-09' },
  { type: 'claim_social_security', person: 'p1', date: '2042-03' },
  { type: 'claim_social_security', person: 'p2', date: '2042-03' },
];

describe('the plan file', () => {
  const planFile = (): string => path.join(tmpDir, 'plan.json');

  it('seeds plan.json when absent: default decisions, no extra events', async () => {
    await initDataDir();
    expect(await exists(planFile())).toBe(false);

    const plan = await loadPlan();
    // Retire at 62 (2037-03 / 2039-09), claim at FRA (2042-03), allocation
    // unchanged -> exactly four events and nothing else. See the derivation on
    // EXPECTED_SEEDED_EVENTS.
    expect(plan.events).toEqual(EXPECTED_SEEDED_EVENTS);
    expect(plan.events).toHaveLength(4);
    // No allocation decision by default.
    expect(plan.events.some((e) => e.type === 'allocation_change' || e.type === 'glidepath')).toBe(
      false,
    );
    // The name is an internal constant, never shown or edited.
    expect(plan.name).toBe(PLAN_NAME);
    expect(plan.description).toBeUndefined();

    // It was written to disk, pretty-printed, and reads back identically.
    const raw = await fs.readFile(planFile(), 'utf8');
    expect(raw.startsWith('{\n  "')).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(plan);
  });

  it('a second load returns the stored plan unchanged — it never reseeds', async () => {
    await initDataDir();
    await loadPlan(); // seeds

    // A user deletes a plan event and adds one of his own.
    const edited: Scenario = {
      name: PLAN_NAME,
      events: [
        { type: 'retire', person: 'p1', date: '2029-09' },
        { type: 'one_time_expense', date: '2030-03', amount: 25000 },
      ],
    };
    await savePlan(edited);

    const before = await fs.readFile(planFile(), 'utf8');
    const reloaded = await loadPlan();
    const after = await fs.readFile(planFile(), 'utf8');

    expect(reloaded).toEqual(edited);
    // Reseeding would have restored the four defaults; the file is byte-identical.
    expect(after).toBe(before);
    expect(reloaded.events).toHaveLength(2);
  });

  it('round-trips save -> load, pinning the internal name and stripping stray keys', async () => {
    await initDataDir();
    const plan = await loadPlan();
    const next: Scenario = {
      ...plan,
      events: [...plan.events, { type: 'state_change', date: '2034-01', state: 'sc' }],
      autoSepp: false,
      assumption_overrides: { expenses: { livingMonthly: 7200 } },
    };
    await savePlan(next);
    expect(await loadPlan()).toEqual(next);

    // A name the caller invents is replaced by the internal constant, and an
    // `id` left over from the old scenario files is dropped by validation.
    await savePlan({ ...next, name: 'Whatever the UI sent', id: 'base-case' } as Scenario);
    const stored = JSON.parse(await fs.readFile(planFile(), 'utf8')) as Record<string, unknown>;
    expect(stored.name).toBe(PLAN_NAME);
    expect(stored).not.toHaveProperty('id');
  });

  it('malformed plan.json is a helpful error naming the file, not a crash', async () => {
    await initDataDir();
    await fs.writeFile(planFile(), '{ "name": "Plan", events: OOPS }', 'utf8');

    const err = await loadPlan().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain('Malformed JSON');
    expect(err?.message).toContain(planFile());

    // A broken plan is reported, never silently reseeded over the top.
    expect(await fs.readFile(planFile(), 'utf8')).toBe('{ "name": "Plan", events: OOPS }');
  });

  it('schema-invalid plan.json names the file and the offending field', async () => {
    await initDataDir();
    await fs.writeFile(planFile(), '{ "name": "Plan" }', 'utf8');

    const err = await loadPlan().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain('Invalid plan');
    expect(err?.message).toContain(planFile());
    expect(err?.message).toContain('events');
  });

  it('savePlan validates before writing', async () => {
    await initDataDir();
    const invalid = {
      name: PLAN_NAME,
      events: [{ type: 'retire', person: 'p1', date: 'not-a-date' }],
    } as unknown as Scenario;
    await expect(savePlan(invalid)).rejects.toThrow(ValidationError);
    expect(await exists(planFile())).toBe(false);
  });
});

describe('the daily guard', () => {
  /**
   * Seed the folder and put a known plan on disk WITHOUT arming the guard.
   *
   * Written straight to the file rather than through savePlan, because this is
   * the state each day begins in, not a change to it — routing it through the
   * guard would file an entry every test below then had to reason around.
   */
  async function startWith(events: ScenarioEvent[]): Promise<Scenario> {
    await initDataDir();
    const plan: Scenario = { name: PLAN_NAME, events };
    await writePlanFile(plan);
    return plan;
  }

  it('files the pre-change plan on the first change of a day', async () => {
    const before = await startWith([{ type: 'retire', person: 'p1', date: '2033-06' }]);
    const historyBefore = await listPlanHistory();

    await savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2029-06' }] }, MORNING);

    const history = await listPlanHistory();
    expect(history).toHaveLength(historyBefore.length + 1);
    // The entry holds what was there BEFORE the change — the point of the
    // whole exercise is to be able to get back to it.
    expect(history[0].plan).toEqual(before);
    expect(history[0].kind).toBe('day-start');
    expect(history[0].takenAt).toBe(MORNING.toISOString());
    expect(history[0].planHash).toBe(planHash(before));
    // ...and the new plan is what the file now holds.
    expect((await loadPlan()).events[0]).toEqual({ type: 'retire', person: 'p1', date: '2029-06' });
  });

  it('files nothing on the second change of the same day — one restore point, not one per edit', async () => {
    const before = await startWith([{ type: 'retire', person: 'p1', date: '2033-06' }]);
    await savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2029-06' }] }, MORNING);
    const afterFirst = await listPlanHistory();

    await savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2030-06' }] }, EVENING);
    await savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2031-06' }] }, EVENING);

    expect(await listPlanHistory()).toEqual(afterFirst);
  });

  it('files again on the next day, holding that day’s own starting point', async () => {
    const before = await startWith([{ type: 'retire', person: 'p1', date: '2033-06' }]);
    const mondayEnd: Scenario = {
      ...before,
      events: [{ type: 'retire', person: 'p1', date: '2029-06' }],
    };
    await savePlan(mondayEnd, MORNING);

    await savePlan({ ...before, events: [{ type: 'retire', person: 'p1', date: '2027-06' }] }, NEXT_DAY);

    const history = await listPlanHistory();
    expect(history).toHaveLength(2);
    // Newest first: Tuesday's entry holds where Monday left off.
    expect(history[0].plan).toEqual(mondayEnd);
    expect(history[1].plan).toEqual(before);
  });

  it('files one when the history is empty — the first change ever is the most valuable one', async () => {
    await initDataDir();
    const seeded = await loadPlan();
    expect(await listPlanHistory()).toEqual([]);

    await savePlan({ ...seeded, events: [] }, MORNING);

    const history = await listPlanHistory();
    expect(history).toHaveLength(1);
    expect(history[0].plan).toEqual(seeded);
  });

  it('files nothing when the plan does not change — a no-op autosave is free', async () => {
    const plan = await startWith([{ type: 'retire', person: 'p1', date: '2033-06' }]);
    // The autosave PUTs whatever is on screen; landing the identical plan is
    // an ordinary event and must not consume the day's restore point.
    await savePlan(plan, MORNING);
    await savePlan({ ...plan, name: 'Whatever the UI sent' }, EVENING);

    expect(await listPlanHistory()).toEqual([]);
  });

  it('files a description-only edit, which plan IDENTITY would have called no change', async () => {
    // planIdentityKey excludes `description` on purpose (two plans differing
    // only in prose are one plan to the engine). The guard asks the WIDER
    // question — would the stored file differ — because the description is
    // where a representative analysis lives, and overwriting it is exactly the
    // kind of edit history exists to undo.
    const plan = await startWith([{ type: 'retire', person: 'p1', date: '2033-06' }]);
    const noted = { ...plan, description: 'Northbridge is a values call, not a solvency call.' };

    await savePlan(noted, MORNING);

    const history = await listPlanHistory();
    expect(history).toHaveLength(1);
    expect(history[0].plan.description).toBeUndefined();
    // Identity is unchanged, which is why the hash on the entry is the same one
    // the new plan would produce: the two questions really are different.
    expect(history[0].planHash).toBe(planHash(noted));
  });

  it('does not file the seeding write — there is no previous version to keep', async () => {
    await initDataDir();
    await loadPlan();
    expect(await listPlanHistory()).toEqual([]);
  });

  it('an explicitly KEPT plan does not stand in for the day’s restore point', async () => {
    // Keeping a search finalist in the morning must not throw away the undo
    // for everything edited afterwards.
    const before = await startWith([{ type: 'retire', person: 'p1', date: '2033-06' }]);
    // The keep is pinned to a moment BEFORE the save, like the afternoon it
    // describes. Left on the real clock it filed the kept entry at whatever
    // time the suite happened to run, and the list came back in the other
    // order every afternoon — a test that passed only because it was written
    // before 8:30am.
    await keepPlan({ name: 'Finalist', events: [] }, 'Search winner', EARLIER);

    await savePlan({ ...before, events: [] }, MORNING);

    const history = await listPlanHistory();
    expect(history.map((e) => e.kind)).toEqual(['day-start', 'kept']);
    expect(history[0].plan).toEqual(before);
  });
});

describe('restoring an older version', () => {
  async function twoVersions(): Promise<{ first: Scenario; second: Scenario }> {
    await initDataDir();
    const first: Scenario = {
      name: PLAN_NAME,
      events: [{ type: 'retire', person: 'p1', date: '2033-06' }],
    };
    await writePlanFile(first);
    const second: Scenario = {
      name: PLAN_NAME,
      events: [{ type: 'retire', person: 'p1', date: '2029-06' }],
    };
    // A different day, so `first` is filed.
    await savePlan(second, MORNING);
    return { first, second };
  }

  it('makes the stored version the plan again', async () => {
    const { first } = await twoVersions();
    const [entry] = await listPlanHistory();

    const restored = await restorePlan(entry.id, EVENING);

    expect(restored.plan).toEqual(first);
    expect(restored.restoredFrom.id).toBe(entry.id);
    expect(await loadPlan()).toEqual(first);
  });

  it('is itself undoable: the version it replaced is filed like any other change', async () => {
    const { first, second } = await twoVersions();
    const [entry] = await listPlanHistory();

    // A new day, so the guard has a restore point to file.
    await restorePlan(entry.id, NEXT_DAY);

    const history = await listPlanHistory();
    expect(history).toHaveLength(2);
    expect(history[0].plan).toEqual(second); // what the restore replaced
    expect(history[1].plan).toEqual(first); // the version restored, untouched
  });

  it('never mutates, consumes or reorders the entry it restores', async () => {
    const { first } = await twoVersions();
    const before = await listPlanHistory();

    await restorePlan(before[0].id, EVENING);
    await savePlan({ ...first, events: [] }, EVENING);

    const after = await listPlanHistory();
    expect(after.at(-1)).toEqual(before.at(-1));
    expect(after.some((e) => e.id === before[0].id)).toBe(true);
  });

  it('brings back the version it was ASKED for, not the newest or the oldest one', async () => {
    // The one property every other test in this block took for granted, because
    // each of them built a history with a single entry — so restoring the newest
    // and restoring the oldest were the same act, and a store that quietly
    // ignored the id would have passed all of them. It would also be the worst
    // bug this module could have: `restoredFrom` is what the History tab's
    // banner names afterwards, so the user would be told the version he chose
    // is on screen while a different one silently became the plan.
    await initDataDir();
    const versions: Scenario[] = ['2029-06', '2031-06', '2033-06'].map((date) => ({
      name: PLAN_NAME,
      events: [{ type: 'retire', person: 'p1', date } as ScenarioEvent],
    }));
    const kept = [];
    for (const [i, plan] of versions.entries()) kept.push(await keepPlan(plan, `v${i + 1}`));

    // The MIDDLE one: neither end of the list, so neither end can stand in for it.
    const target = kept[1];
    const restored = await restorePlan(target.id, MORNING);

    expect(restored.restoredFrom.id).toBe(target.id);
    expect(restored.plan).toEqual(versions[1]);
    expect(await loadPlan()).toEqual(versions[1]);
    // And what it reports is what it wrote — the banner cannot be made to lie.
    expect(restored.plan.events).toEqual(restored.restoredFrom.plan.events);
  });

  it('pins the plan name on the way back in, like every other save', async () => {
    await initDataDir();
    await loadPlan();
    const kept = await keepPlan({ name: 'Search finalist', events: [] }, 'Rank 1');

    const restored = await restorePlan(kept.id, MORNING);

    expect(restored.plan.name).toBe(PLAN_NAME);
    // The entry keeps its own name: restoring copies forward, it does not move.
    expect((await listPlanHistory()).find((e) => e.id === kept.id)?.plan.name).toBe(
      'Search finalist',
    );
  });

  it('an unknown version is a 404, not an empty answer', async () => {
    await initDataDir();
    await loadPlan();
    await expect(restorePlan('ph-nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
