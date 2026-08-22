/**
 * THE PLAN'S HISTORY FILE (src/server/planHistoryStore.ts).
 *
 * The store's own properties, separate from the guard that calls it
 * (tests/server/planStore.test.ts): what the file means when it is missing,
 * what order the page reads it in, what a day is, and what may be edited on an
 * entry after it is filed — which is the score, and nothing else. An entry's
 * `plan` is the whole reason the file exists; if that could be rewritten in
 * place, a restore point would be a promise the app could quietly break.
 *
 * Each test points FPLAN_DATA_DIR at a fresh temp dir; the user's real data
 * folder is never read or touched.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanScore, Scenario } from '../../src/shared/types';
import { ValidationError } from '../../src/server/dataStore';
import {
  attachPlanHistoryScore,
  attachPlanHistorySpend,
  getPlanHistoryEntry,
  keepPlan,
  listPlanHistory,
  localDayKey,
  planHash,
  recordDayStart,
} from '../../src/server/planHistoryStore';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-planhistory-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const plan = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'Plan',
  events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
  ...over,
});

const score = (over: Partial<PlanScore> = {}): PlanScore => ({
  success: 0.938,
  medianTerminalReal: 1_284_510.4471935,
  mode: 'montecarlo',
  paths: 1000,
  seed: 20260812,
  engineVersion: '1.21.0',
  scoredAt: '2026-08-18T21:41:17.203Z',
  ...over,
});

describe('the file', () => {
  it('is an empty history when it does not exist — a folder with no past is not an error', async () => {
    expect(await listPlanHistory()).toEqual([]);
  });

  it('fails loudly and names itself when it exists but is malformed', async () => {
    const filePath = path.join(tmpDir, 'plan-history.json');
    await fs.writeFile(filePath, '[{ "id": OOPS }]', 'utf8');
    const err = await listPlanHistory().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.message).toContain(filePath);
  });

  it('reads newest first, whatever order the file is in', async () => {
    // Hand-written out of order: the page's claim that it lists the most
    // recent version first must come from the read, not from the writer.
    await fs.writeFile(
      path.join(tmpDir, 'plan-history.json'),
      JSON.stringify([
        {
          id: 'ph-late',
          takenAt: '2026-08-20T09:00:00.000Z',
          kind: 'day-start',
          plan: plan(),
          planHash: planHash(plan()),
        },
        {
          id: 'ph-early',
          takenAt: '2026-08-18T09:00:00.000Z',
          kind: 'kept',
          plan: plan(),
          planHash: planHash(plan()),
        },
      ]),
      'utf8',
    );
    expect((await listPlanHistory()).map((e) => e.id)).toEqual(['ph-late', 'ph-early']);
  });

  it('an unknown id is a 404, and a known one comes back whole', async () => {
    const kept = await keepPlan(plan(), 'Search winner');
    expect((await getPlanHistoryEntry(kept.id)).plan).toEqual(plan());
    await expect(getPlanHistoryEntry('ph-nope')).rejects.toThrow(/Unknown plan version/);
  });
});

describe('localDayKey', () => {
  it('is the LOCAL calendar day, so an evening edit is not filed as tomorrow', () => {
    // 9pm in the machine's own zone. In UTC this is already the 21st for the
    // owner in US Eastern, and a UTC key would file a second "day start" in
    // the middle of one sitting — and stamp it with a date the page, which
    // formats in local time, would render as a different day.
    expect(localDayKey(new Date(2026, 7, 20, 21, 30))).toBe('2026-08-20');
    expect(localDayKey(new Date(2026, 7, 20, 0, 1))).toBe('2026-08-20');
    // Single-digit months and days are padded, so string comparison works.
    expect(localDayKey(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });
});

describe('planHash', () => {
  it('is the identity rule, so a rename is not a different plan', () => {
    expect(planHash(plan({ name: 'Search finalist' }))).toBe(planHash(plan()));
    expect(planHash(plan({ description: 'the one I mean' }))).toBe(planHash(plan()));
  });

  it('is stable against key order — a round trip through disk is not a change', () => {
    const reordered: Scenario = { events: plan().events, name: 'Plan' };
    expect(planHash(reordered)).toBe(planHash(plan()));
  });

  it('changes when anything the engine reads changes', () => {
    expect(planHash(plan({ autoSepp: false }))).not.toBe(planHash(plan()));
    expect(
      planHash(plan({ assumption_overrides: { expenses: { livingMonthly: 9_000 } } })),
    ).not.toBe(planHash(plan()));
  });
});

describe('a score on an entry', () => {
  it('is absent until one is attached — never a zero standing in for "not scored"', async () => {
    const entry = await keepPlan(plan(), 'Kept');
    expect(entry.score).toBeUndefined();
    expect(entry.scoreError).toBeUndefined();
    const stored = await getPlanHistoryEntry(entry.id);
    expect('score' in stored).toBe(false);
  });

  it('attaches without touching what the entry IS', async () => {
    const entry = await keepPlan(plan(), 'Kept');
    expect(await attachPlanHistoryScore(entry.id, { score: score() })).toBe('attached');

    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score).toEqual(score());
    expect(stored.plan).toEqual(entry.plan);
    expect(stored.takenAt).toBe(entry.takenAt);
    expect(stored.planHash).toBe(entry.planHash);
    expect(stored.label).toBe('Kept');
  });

  it('a success clears the previous failure — never a number beside a complaint about not having one', async () => {
    const entry = await keepPlan(plan());
    await attachPlanHistoryScore(entry.id, { error: 'The simulation failed: worker died' });
    expect((await getPlanHistoryEntry(entry.id)).scoreError).toContain('worker died');

    await attachPlanHistoryScore(entry.id, { score: score() });
    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score?.success).toBe(0.938);
    expect(stored.scoreError).toBeUndefined();
  });

  it('merges a spend figure into the score already there, and nothing else', async () => {
    // The two halves of a score are attached separately because they cost
    // different amounts; the second must not overwrite the first.
    const entry = await keepPlan(plan());
    await attachPlanHistoryScore(entry.id, { score: score() });

    expect(
      await attachPlanHistorySpend(entry.id, {
        sustainableSpend: 118_000,
        sustainableSpendPaths: 2_000,
      }),
    ).toBe(true);

    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score).toEqual({ ...score(), sustainableSpend: 118_000, sustainableSpendPaths: 2_000 });
  });

  it('has nowhere to put a spend figure on a version with no score', async () => {
    // A spend level with no probability beside it says nothing on its own.
    const entry = await keepPlan(plan());
    expect(
      await attachPlanHistorySpend(entry.id, {
        sustainableSpend: 118_000,
        sustainableSpendPaths: 2_000,
      }),
    ).toBe(false);
    expect((await getPlanHistoryEntry(entry.id)).score).toBeUndefined();
  });

  it('reports "nowhere to put it" rather than throwing when the entry is gone', async () => {
    // This lands from a background task nobody is watching; a throw would
    // surface as an unhandled rejection and tell no one anything.
    expect(await attachPlanHistoryScore('ph-nope', { score: score() })).toBe('entry_gone');
  });

  it('refuses a second score, and says THAT rather than "the entry is gone"', async () => {
    /*
     * ONCE A NUMBER IS RECORDED, NOTHING OVERWRITES IT. A representative words
     * for the button that used to: "Score it again undermines take a snapshot".
     * An entry is a record of a moment — this plan, measured against that day's
     * balances and prices — and a second number filed on the same row would
     * make one row report two different days as if they were one.
     *
     * The two refusals are told apart on purpose: 'entry_gone' would send a
     * reader looking for a delete that never happened.
     */
    const entry = await keepPlan(plan(), 'Kept');
    await attachPlanHistoryScore(entry.id, { score: score() });

    expect(await attachPlanHistoryScore(entry.id, { score: { ...score(), success: 0.5 } })).toBe(
      'already_scored',
    );
    // And a FAILURE cannot erase a good number either — the nastier half of the
    // same bug, where a later run that died would replace a recorded figure
    // with its own excuse.
    expect(await attachPlanHistoryScore(entry.id, { error: 'a later run died' })).toBe(
      'already_scored',
    );

    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score).toEqual(score());
    expect(stored.scoreError).toBeUndefined();
  });

  it('still replaces a FAILURE, because a failure records no measurement', async () => {
    // Filling a blank is allowed; overwriting a fact is not. "We tried and it
    // died" is a blank — this version has never been measured.
    const entry = await keepPlan(plan());
    await attachPlanHistoryScore(entry.id, { error: 'worker died' });

    expect(await attachPlanHistoryScore(entry.id, { error: 'worker died again' })).toBe('attached');
    expect((await getPlanHistoryEntry(entry.id)).scoreError).toBe('worker died again');
  });
});

describe('recordDayStart', () => {
  it('files the first call of a day and refuses the rest', async () => {
    const morning = new Date(2026, 7, 20, 8, 0);
    const evening = new Date(2026, 7, 20, 22, 0);
    expect(await recordDayStart(plan(), morning)).not.toBeNull();
    expect(await recordDayStart(plan({ autoSepp: false }), evening)).toBeNull();
    expect(await listPlanHistory()).toHaveLength(1);
  });

  it('serializes: two first-edits landing together file ONE entry, not two', async () => {
    // The check ("does today already have a restore point?") contains an
    // await, so without the store's serial chain both callers read "no" and
    // both append — and the second would overwrite the first's version with a
    // copy of the same plan taken a moment later.
    const now = new Date(2026, 7, 20, 8, 0);
    const [a, b] = await Promise.all([recordDayStart(plan(), now), recordDayStart(plan(), now)]);
    expect([a, b].filter((e) => e !== null)).toHaveLength(1);
    expect(await listPlanHistory()).toHaveLength(1);
  });
});
