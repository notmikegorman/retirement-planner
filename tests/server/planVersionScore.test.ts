/**
 * Scoring a stored version of the plan (src/server/planHistoryScorer.ts).
 *
 * The History tab is meant to be RECOGNISED from — "the one where we bought in
 * 2028 and it was 96%" — so any version can be scored on demand. Two things
 * make that trustworthy, and both are pinned below:
 *
 *  - THE SCORE GOES ON ITS OWN ENTRY, and touches nothing else about it. The
 *    version's `plan` is the only copy of that plan there is; a scorer that
 *    could rewrite it would turn a restore point into a promise the app can
 *    quietly break.
 *  - ABSENT NEVER MEANS ZERO. A version nobody has scored has no `score` key at
 *    all, and a failed attempt leaves a sentence rather than a number.
 *  - AND A RECORDED SCORE IS FINAL. On demand means ONCE. There was a "Score it
 *    again" button, and the user's objection to it is the rule this module now
 *    enforces: an entry is a RECORD of a moment — that plan, measured against
 *    that day's balances and prices — so a second number filed on the same row
 *    would make one row report two different days as if they were one. Filling
 *    a blank is allowed; overwriting a fact is not.
 *
 * WHICH ENTRIES ARE BLANKS, since that is the whole distinction: one nobody has
 * ever scored, and one whose scoring FAILED (a failure records no measurement).
 * A scored entry is not a blank even when half of its score is missing — the
 * a "Baseline — saved Aug 18" can carry 93.8% and no spend figure, and
 * it stays that way, because solving the dollars today would file an answer
 * measured against today beside a probability measured against August 18th.
 *
 * The simulation is injected: none of these properties are about the engine's
 * arithmetic, they are about what happens to the file around it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunProgress, RunRequest, RunResult, Scenario } from '../../src/shared/types';
import {
  ConflictError,
  NotFoundError,
  initDataDir,
  loadProfile,
} from '../../src/server/dataStore';
import {
  attachPlanHistoryScore,
  attachPlanHistorySpend,
  getPlanHistoryEntry,
  keepPlan,
  listPlanHistory,
} from '../../src/server/planHistoryStore';
import {
  scorePlanVersion,
  startVersionScoring,
  versionsBeingScored,
} from '../../src/server/planHistoryScorer';
import type { ScoringDeps } from '../../src/server/scoreRunner';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-version-score-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const OLD_PLAN: Scenario = {
  name: 'Plan',
  events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
  description: 'the one where we bought in 2028',
};

function finished(over: Partial<RunResult> = {}): RunResult {
  return {
    success: 0.938,
    medianTerminalReal: 1_284_510,
    meta: { engineVersion: '1.21.0', mode: 'montecarlo', paths: 10_000, seed: 20260812 },
    ...over,
  } as unknown as RunResult;
}

/**
 * A completed max_spend SWEEP. Scoring a version is two runs — the probability,
 * then the bisection for what it could afford — so the fake answers each
 * request in its own currency, keyed on whether it carried a solver.
 */
function solved(answer: number | null = 118_000): RunResult {
  return finished({
    solverOutput: {
      spec: { type: 'max_spend' },
      points: [],
      ...(answer === null ? {} : { answer }),
      answerLabel: 'x',
    },
  } as unknown as Partial<RunResult>);
}

function fakeDeps(over: Partial<ScoringDeps> = {}): ScoringDeps & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    requests,
    startRun: async (req) => {
      requests.push(req);
      return { runId: 'run-1' };
    },
    getRun: async (): Promise<RunProgress> => ({
      runId: 'run-1',
      status: 'done',
      progress: 1,
      result: requests.at(-1)?.scenario.solver ? solved() : finished(),
    }),
    wait: async () => undefined,
    now: () => new Date('2026-08-20T10:00:00.000Z'),
    ...over,
  };
}

describe('scoring one version', () => {
  it('runs THAT version’s plan, at the same quality every other score uses', async () => {
    // Not the plan on disk — the point of the button is "what would THIS one
    // do", and the answer is only readable beside the others if the conditions
    // are the same.
    const entry = await keepPlan(OLD_PLAN, 'Bought in 2028');
    const profile = await loadProfile();
    const deps = fakeDeps();

    await startVersionScoring(entry.id, deps);

    expect(deps.requests[0].scenario.events).toEqual(OLD_PLAN.events);
    expect(deps.requests[0].mode).toBe('montecarlo');
    expect(deps.requests[0].paths).toBe(profile.settings.mcPathsFinal);
    expect(deps.requests[0].seed).toBe(profile.settings.seed);
    // NOT fresh: the run key already carries the resolved profile, so an
    // unchanged world may legitimately return the cached number.
    expect(deps.requests[0].fresh).toBeUndefined();

    // The second run is the spend bisection of that same version — the number
    // that actually tells two of them apart once success has saturated.
    expect(deps.requests).toHaveLength(2);
    expect(deps.requests[1].scenario.solver).toEqual({ type: 'max_spend' });
    expect(deps.requests[1].scenario.events).toEqual(OLD_PLAN.events);
  });

  it('attaches the number and its conditions, and changes nothing else', async () => {
    const entry = await keepPlan(OLD_PLAN, 'Bought in 2028');
    await startVersionScoring(entry.id, fakeDeps());

    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score).toEqual({
      success: 0.938,
      medianTerminalReal: 1_284_510,
      mode: 'montecarlo',
      paths: 10_000,
      seed: 20260812,
      engineVersion: '1.21.0',
      scoredAt: '2026-08-20T10:00:00.000Z',
      sustainableSpend: 118_000,
      // The solver's own inner cap, not the 10,000 above it: a label carries
      // its own condition.
      sustainableSpendPaths: 2_000,
    });
    // What the entry IS survives untouched.
    expect(stored.plan).toEqual(OLD_PLAN);
    expect(stored.takenAt).toBe(entry.takenAt);
    expect(stored.planHash).toBe(entry.planHash);
    expect(stored.label).toBe('Bought in 2028');
  });

  it('scores the version it was asked about, not the newest one', async () => {
    const older = await keepPlan(OLD_PLAN, 'Older');
    const newer = await keepPlan({ name: 'Plan', events: [] }, 'Newer');

    await startVersionScoring(older.id, fakeDeps());

    expect((await getPlanHistoryEntry(older.id)).score?.success).toBe(0.938);
    expect((await getPlanHistoryEntry(newer.id)).score).toBeUndefined();
  });

  it('leaves a sentence rather than a number when the run fails', async () => {
    const entry = await keepPlan(OLD_PLAN);
    const outcome = await startVersionScoring(
      entry.id,
      fakeDeps({
        getRun: async () => ({
          runId: 'run-1',
          status: 'error',
          progress: 0.2,
          error: 'Simulation worker exited unexpectedly with code 3',
        }),
      }),
    );

    expect(outcome.status).toBe('failed');
    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score).toBeUndefined();
    expect(stored.scoreError).toContain('worker exited unexpectedly');
    // The version itself is untouched: a failed run is not a reason to lose a
    // restore point.
    expect(stored.plan).toEqual(OLD_PLAN);
  });

  it('is listed as in flight while the run is going, and not after', async () => {
    const entry = await keepPlan(OLD_PLAN);
    let land: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    const deps = fakeDeps({
      getRun: async () => {
        await gate;
        return { runId: 'run-1', status: 'done', progress: 1, result: finished() };
      },
    });

    const work = startVersionScoring(entry.id, deps);
    expect(versionsBeingScored()).toEqual([entry.id]);
    land();
    await work;
    expect(versionsBeingScored()).toEqual([]);
  });

  it('joins an attempt already running rather than starting a second', async () => {
    const entry = await keepPlan(OLD_PLAN);
    const deps = fakeDeps();
    const [a, b] = await Promise.all([
      startVersionScoring(entry.id, deps),
      startVersionScoring(entry.id, deps),
    ]);
    expect(a).toBe(b);
    // One attempt: the probability and the spend bisection, once each.
    expect(deps.requests).toHaveLength(2);
  });

  it('keeps the probability when only the spend bisection fails', async () => {
    // Two writes for one score, so that the expensive half can fail on its own
    // without taking down the cheap one.
    const entry = await keepPlan(OLD_PLAN);
    const deps = fakeDeps();
    await startVersionScoring(entry.id, {
      ...deps,
      getRun: async () =>
        deps.requests.at(-1)?.scenario.solver
          ? { runId: 'run-1', status: 'error', progress: 0.4, error: 'sweep worker died' }
          : { runId: 'run-1', status: 'done', progress: 1, result: finished() },
    });

    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score?.success).toBe(0.938);
    expect(stored.score?.sustainableSpend).toBeUndefined();
    expect(stored.score?.sustainableSpendError).toContain('sweep worker died');
    expect(stored.plan).toEqual(OLD_PLAN);
  });

  it('answers a press against a stale list with a 404, not with silence', async () => {
    // The alternative is starting nothing in the background and returning ok,
    // which looks exactly like a run that is about to land.
    await expect(scorePlanVersion('ph-nope', fakeDeps())).rejects.toBeInstanceOf(NotFoundError);
    expect(versionsBeingScored()).toEqual([]);
  });

  it('never scores a version nobody asked about', async () => {
    const entry = await keepPlan(OLD_PLAN);
    expect(entry.score).toBeUndefined();
    expect((await listPlanHistory())[0].score).toBeUndefined();
    expect(versionsBeingScored()).toEqual([]);
  });
});

describe('a version that already carries a score', () => {
  /** Score `entry` for real, so the refusals below are refusing a real number. */
  async function scored(label?: string): Promise<string> {
    const entry = await keepPlan(OLD_PLAN, label);
    await startVersionScoring(entry.id, fakeDeps());
    return entry.id;
  }

  it('is refused, and told plainly why and what to do instead', async () => {
    const id = await scored('Bought in 2028');

    const err = await scorePlanVersion(id, fakeDeps()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    const message = (err as Error).message;
    // A message a human can act on: which version, when it was measured, why
    // that is the end of it, and the thing to do instead.
    expect(message).toContain('Bought in 2028');
    expect(message).toContain('2026-08-20');
    expect(message).toContain('not rewritten');
    expect(message).toContain('restore it');
  });

  it('refuses BEFORE a single path is simulated', async () => {
    // Refusing after the run would burn minutes to produce a number with
    // nowhere to go, and would leave the row saying "scoring…" while it did.
    const id = await scored();
    const deps = fakeDeps();

    await expect(scorePlanVersion(id, deps)).rejects.toBeInstanceOf(ConflictError);
    expect(deps.requests).toEqual([]);
    expect(versionsBeingScored()).toEqual([]);
  });

  it('keeps the number it had, byte for byte', async () => {
    const id = await scored();
    const before = (await getPlanHistoryEntry(id)).score;

    await expect(scorePlanVersion(id, fakeDeps())).rejects.toBeInstanceOf(ConflictError);

    expect((await getPlanHistoryEntry(id)).score).toEqual(before);
  });

  it('is refused by the store too, for a caller that skipped the front door', async () => {
    // A guard the UI can forget is not a guard, and neither is one only the
    // route knows about. The function that does the writing is where the rule
    // has to be true.
    const id = await scored();
    const before = (await getPlanHistoryEntry(id)).score;

    const outcome = await startVersionScoring(id, fakeDeps());
    expect(outcome.status).toBe('already_scored');
    expect(await attachPlanHistoryScore(id, { error: 'a later run died' })).toBe('already_scored');
    expect((await getPlanHistoryEntry(id)).score).toEqual(before);
    expect((await getPlanHistoryEntry(id)).scoreError).toBeUndefined();
  });
});

describe('a version scored before the spend was ever solved for', () => {
  /**
   * A "Baseline — saved Aug 18" IS EXACTLY THIS: 93.8% at 1,000
   * paths, no `sustainableSpend`, because the solve did not exist when it was
   * scored. It is the case that most tempts a re-open — the figure is missing,
   * the solver is right there — and the one where re-opening does the most
   * damage: its success was measured on Aug 18 against that day's balances, and
   * a spend figure solved today filed on the same row would make one row report
   * two different moments as if they were one.
   */
  async function august18(): Promise<string> {
    const entry = await keepPlan(OLD_PLAN, 'Baseline — saved Aug 18');
    // Written the way the file holds it: a score, and no spend half at all.
    expect(
      await attachPlanHistoryScore(entry.id, {
        score: {
          success: 0.938,
          medianTerminalReal: 1_284_510,
          mode: 'montecarlo',
          paths: 1_000,
          seed: 20260812,
          engineVersion: '1.21.0',
          scoredAt: '2026-08-18T21:41:17.203Z',
        },
      }),
    ).toBe('attached');
    return entry.id;
  }

  it('cannot be re-opened to "just add the spend number"', async () => {
    const id = await august18();

    await expect(scorePlanVersion(id, fakeDeps())).rejects.toBeInstanceOf(ConflictError);

    const stored = await getPlanHistoryEntry(id);
    expect(stored.score?.success).toBe(0.938);
    expect(stored.score?.paths).toBe(1_000);
    expect(stored.score?.scoredAt).toBe('2026-08-18T21:41:17.203Z');
    expect(stored.score?.sustainableSpend).toBeUndefined();
  });

  it('gets no spend figure from a scoring run either — the run stops at the score', async () => {
    /*
     * THIS IS THE REACHABILITY ARGUMENT, pinned rather than asserted in a
     * comment. `attachPlanHistorySpend` will happily fill an empty spend field,
     * because from where it sits that IS a blank; what makes it safe is that
     * the only thing that calls it is `scoreVersion`, which reaches that line
     * only by having written the score two statements earlier. Score first
     * refused, so the spend never happens, so the figure that lands beside a
     * probability is always one solved in the same run as it.
     */
    const id = await august18();
    const deps = fakeDeps();

    const outcome = await startVersionScoring(id, deps);

    expect(outcome.status).toBe('already_scored');
    expect(deps.requests).toEqual([]);
    expect((await getPlanHistoryEntry(id)).score?.sustainableSpend).toBeUndefined();
  });

  it('will not let a spend figure REPLACE one that is already recorded', async () => {
    // The other half: once a figure is there, the store refuses to move it,
    // whoever asks and for whatever reason.
    const entry = await keepPlan(OLD_PLAN, 'Fully scored');
    await startVersionScoring(entry.id, fakeDeps());
    expect((await getPlanHistoryEntry(entry.id)).score?.sustainableSpend).toBe(118_000);

    expect(
      await attachPlanHistorySpend(entry.id, {
        sustainableSpend: 1,
        sustainableSpendPaths: 2_000,
      }),
    ).toBe(false);
    expect((await getPlanHistoryEntry(entry.id)).score?.sustainableSpend).toBe(118_000);
  });
});

describe('a version that is still a blank', () => {
  it('can be scored when nobody ever has', async () => {
    // The History tab is meant to be recognised from, and a row of dates with
    // no numbers is not recognisable. Writing here destroys nothing.
    const entry = await keepPlan(OLD_PLAN, 'Baseline — frozen Aug 20');
    expect(entry.score).toBeUndefined();

    await expect(scorePlanVersion(entry.id, fakeDeps())).resolves.toEqual({
      ok: true,
      scoring: true,
    });
    await Promise.all([...versionsBeingScored()].map(() => startVersionScoring(entry.id)));
    expect((await getPlanHistoryEntry(entry.id)).score?.success).toBe(0.938);
  });

  it('can be scored again when the last attempt FAILED', async () => {
    // "We tried and it failed" records no measurement, so this is filling a
    // blank, not overwriting a fact — the one case where a second press is not
    // the thing the user objected to.
    const entry = await keepPlan(OLD_PLAN);
    await startVersionScoring(
      entry.id,
      fakeDeps({
        getRun: async () => ({
          runId: 'run-1',
          status: 'error',
          progress: 0.2,
          error: 'Simulation worker exited unexpectedly with code 3',
        }),
      }),
    );
    expect((await getPlanHistoryEntry(entry.id)).scoreError).toBeDefined();

    await expect(scorePlanVersion(entry.id, fakeDeps())).resolves.toEqual({
      ok: true,
      scoring: true,
    });
    await startVersionScoring(entry.id, fakeDeps());

    const stored = await getPlanHistoryEntry(entry.id);
    expect(stored.score?.success).toBe(0.938);
    // A version carrying both a number and a complaint about not having one
    // gives the reader no way to tell which is current.
    expect(stored.scoreError).toBeUndefined();
    expect('scoreError' in stored).toBe(false);
  });
});
