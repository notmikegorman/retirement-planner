/**
 * Scoring a net-worth snapshot (src/server/snapshotScorer.ts +
 * networthStore.attachScore).
 *
 * ONE RULE ABOVE ALL: the net-worth row is never at risk from the score.
 * A snapshot records prices from a moment that has passed and cannot be
 * recreated; a score is a computation that can be repeated forever. So every
 * failure below — a run that errors, a run that never lands, a row deleted
 * mid-run — must leave the row intact and its money untouched, and must leave
 * the reader able to tell WHICH failure it was:
 *
 *  - the run failed          -> no score, and a reason on the row
 *  - a run is still going    -> no score yet, and the row listed as in flight
 *
 * ABSENT NEVER MEANS ZERO. A scoreless row is a row with no `score` key at all,
 * so nothing downstream can read it as 0% — the failure mode that would turn
 * this trend into a chart of imaginary collapses.
 *
 * AND ABSENT IS NOW PERMANENT, which is what most of the additions below are
 * about. A row is scored ONCE, by the run the snapshot POST starts, and never
 * again: there was a per-row re-score button and a POST /api/networth/:id/score
 * behind it, and both scored TODAY's plan against TODAY's profile and filed the
 * answer on a row recorded on a different day — a number that was never true of
 * the row it landed on. What that costs is a row whose run died staying
 * scoreless for ever, and the cost is the honest one: "this was not measured"
 * is a true statement about a moment, and a fabricated figure is not.
 *
 * The simulation itself is injected. A real final-quality run is 10,000 paths
 * and minutes of wall clock, and none of the properties here are about the
 * engine's arithmetic — they are about what happens to the ledger around it.
 */
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  NetWorthSnapshot,
  Profile,
  QuotesFile,
  RunProgress,
  RunRequest,
  RunResult,
  Scenario,
} from '../../src/shared/types';
import {
  ValidationError,
  initDataDir,
  loadProfile,
  saveProfile,
  saveQuotes,
} from '../../src/server/dataStore';
import { loadPlan, savePlan } from '../../src/server/planStore';
import { keepPlan, listPlanHistory, planHash } from '../../src/server/planHistoryStore';
import {
  attachScore,
  attachSustainableSpend,
  listSnapshots,
  takeSnapshot,
} from '../../src/server/networthStore';
import {
  snapshotsBeingScored,
  startScoring,
  type ScoringDeps,
} from '../../src/server/snapshotScorer';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.FPLAN_DATA_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-score-'));
  process.env.FPLAN_DATA_DIR = tmpDir;
  await initDataDir();
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.FPLAN_DATA_DIR;
  else process.env.FPLAN_DATA_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const PLAN: Scenario = {
  name: 'Plan',
  events: [{ type: 'retire', person: 'p1', date: '2031-07' }],
};

/** A snapshot with nothing to price from a feed — the home value is the whole test. */
async function snapshot(): Promise<NetWorthSnapshot> {
  return takeSnapshot({ homeValue: 550_000 });
}

/** What the run manager hands back for a completed final-quality run. */
function finished(over: Partial<RunResult> = {}): RunResult {
  return {
    success: 0.941,
    medianTerminalReal: 3_100_000,
    meta: { engineVersion: '1.21.0', mode: 'montecarlo', paths: 10_000, seed: 12_345 },
    ...over,
  } as unknown as RunResult;
}

/**
 * A completed max_spend SWEEP. Scoring a row is two runs now — the probability,
 * then the bisection for what the plan could afford — so the fake answers each
 * request in its own currency, keyed on whether the request carried a solver.
 */
function solved(answer: number | null = 118_000): RunResult {
  return finished({
    solverOutput: {
      spec: { type: 'max_spend' },
      points: [],
      // null = the solver came back with no answer at all, which is what it
      // does when even the floor of the bracket fails.
      ...(answer === null ? {} : { answer }),
      answerLabel: 'x',
    },
  } as unknown as Partial<RunResult>);
}

/**
 * Deps that answer immediately: one poll and the run is done. `requests`
 * records what was asked for, which is how the "final quality, profile seed"
 * property is checked without running anything.
 */
function fakeDeps(
  over: Partial<ScoringDeps> = {},
): ScoringDeps & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  const deps: ScoringDeps & { requests: RunRequest[] } = {
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
    now: () => new Date('2026-08-19T10:00:00.000Z'),
    ...over,
  };
  return deps;
}

/** Put a known plan on disk. There is only one, and it is what gets scored. */
async function withPlan(plan: Scenario = PLAN): Promise<void> {
  await savePlan(plan);
}

describe('there is no way to score a row after the fact', () => {
  /**
   * The route and the function behind it are GONE, not disabled. A disabled
   * feature is one someone re-enables by deleting an `if`; a deleted one has to
   * be argued for again — and the argument against it is why this file's header
   * changed.
   *
   * Pinned by reading the server rather than by calling it: there is no route
   * harness in this repo (importing server.ts starts a listener on the port the
   * owner browses). What that costs is coverage of Fastify's own routing; what
   * it buys back is the two facts that actually decide the answer — nothing
   * registers the path, and an unregistered /api/ path answers 404 JSON rather
   * than falling through to the SPA's index.html.
   */
  const serverSource = readFileSync(
    fileURLToPath(new URL('../../src/server/server.ts', import.meta.url)),
    'utf8',
  );

  it('registers no per-row scoring route, so a POST to one 404s', () => {
    expect(serverSource).not.toContain("'/api/networth/:id/score'");
    expect(serverSource).not.toContain('rescoreSnapshot');
    // The catch-all is what turns "not registered" into a 404 with a body the
    // caller can read, instead of the SPA's HTML.
    expect(serverSource).toContain("req.url.startsWith('/api/')");
    expect(serverSource).toContain('Not found: ${req.method} ${req.url}');
  });

  it('leaves no rescore machinery exported for a future route to reach for', () => {
    // The button is one press away from returning if the function it called is
    // still sitting there exported, tested and apparently supported.
    const scorer = readFileSync(
      fileURLToPath(new URL('../../src/server/snapshotScorer.ts', import.meta.url)),
      'utf8',
    );
    expect(scorer).not.toContain('export async function rescoreSnapshot');
    const client = readFileSync(
      fileURLToPath(new URL('../../src/ui/api.ts', import.meta.url)),
      'utf8',
    );
    expect(client).not.toContain('rescoreNetWorthSnapshot:');
  });
});

describe('a recorded score is never written over', () => {
  it('refuses a second score on a row that already carries one', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());
    const first = (await listSnapshots())[0].score;
    expect(first?.success).toBe(0.941);

    // The exact shape of the removed feature: score the same row again.
    expect(await attachScore(row.id, { score: { ...first!, success: 0.5 } })).toBe(
      'already_scored',
    );
    expect((await listSnapshots())[0].score).toEqual(first);
  });

  it('refuses a FAILURE over a recorded score, so a later bad run cannot erase a good number', async () => {
    // The nastier half of the same bug: a second run that dies would otherwise
    // replace a perfectly good recorded figure with its own excuse.
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    expect(await attachScore(row.id, { error: 'a later run died' })).toBe('already_scored');
    const [stored] = await listSnapshots();
    expect(stored.score?.success).toBe(0.941);
    expect(stored.scoreError).toBeUndefined();
  });

  it('reports "already scored" as itself, not as a vanished row', async () => {
    // Two different silences. Calling this one 'row_gone' would send a reader
    // looking for a delete that never happened.
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    const again = await startScoring(row.id, fakeDeps());
    expect(again.status).toBe('already_scored');
  });

  it('refuses a second spend figure on a score that already has one', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());
    const solved = (await listSnapshots())[0].score?.sustainableSpend;
    expect(solved).toBeDefined();

    expect(
      await attachSustainableSpend(row.id, { sustainableSpend: 1, sustainableSpendPaths: 2_000 }),
    ).toBe(false);
    expect((await listSnapshots())[0].score?.sustainableSpend).toBe(solved);
  });

  it('still fills a BLANK — a failure records no measurement', async () => {
    // Filling a blank is allowed; overwriting a fact is not. Nothing in the app
    // walks this path today, and the store is where that distinction has to be
    // true rather than merely observed.
    await withPlan();
    const row = await snapshot();
    await startScoring(
      row.id,
      fakeDeps({
        getRun: async () => ({ runId: 'run-1', status: 'error', progress: 0, error: 'boom' }),
      }),
    );
    expect((await listSnapshots())[0].scoreError).toBeDefined();

    expect(await attachScore(row.id, { error: 'a different failure' })).toBe('attached');
    expect((await listSnapshots())[0].scoreError).toBe('a different failure');
  });
});

describe('the score attaches after the row is already written', () => {
  it('runs THE PLAN at final quality on the profile seed', async () => {
    // Whatever plan.json holds at the moment of scoring is what is scored —
    // there is one plan, and the score records which one it was.
    await withPlan();
    const edited: Scenario = { ...PLAN, events: [{ type: 'retire', person: 'p1', date: '2027-01' }] };
    await savePlan(edited);
    const profile = await loadProfile();

    const row = await snapshot();
    const deps = fakeDeps();
    await startScoring(row.id, deps);

    expect(deps.requests[0].scenario.events).toEqual(edited.events);
    expect(deps.requests[0].mode).toBe('montecarlo');
    expect(deps.requests[0].paths).toBe(profile.settings.mcPathsFinal);
    expect(deps.requests[0].seed).toBe(profile.settings.seed);
    // NOT fresh: the run key already carries the resolved profile, so an
    // unchanged world may legitimately return the cached number.
    expect(deps.requests[0].fresh).toBeUndefined();

    // The second run is the spend bisection, of the same plan under the same
    // conditions — a figure measured on a different plan would not belong in
    // the same score block.
    expect(deps.requests).toHaveLength(2);
    expect(deps.requests[1].scenario.solver).toEqual({ type: 'max_spend' });
    expect(deps.requests[1].scenario.events).toEqual(edited.events);
    expect(deps.requests[1].paths).toBe(profile.settings.mcPathsFinal);
    expect(deps.requests[1].seed).toBe(profile.settings.seed);
  });

  it('updates the row in place with the score and every condition it holds', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    const [stored] = await listSnapshots();
    expect(stored.id).toBe(row.id);
    expect(stored.total).toBe(row.total);
    expect(stored.score).toEqual({
      success: 0.941,
      medianTerminalReal: 3_100_000,
      mode: 'montecarlo',
      // From the run's own meta — the conditions the number actually has,
      // which for a cache hit are the ones it was computed under.
      paths: 10_000,
      seed: 12_345,
      engineVersion: '1.21.0',
      // WHICH plan this is a score of. No baseline fields: nothing writes
      // those any more, and inventing one here would claim a measurement
      // against a frozen record that does not exist.
      planHash: planHash(await loadPlan()),
      scoredAt: '2026-08-19T10:00:00.000Z',
      // The dollar-denominated half, measured at the solver's own inner path
      // cap rather than the 10,000 above it — a label carries its own
      // condition.
      sustainableSpend: 118_000,
      sustainableSpendPaths: 2_000,
    });
  });

  it('points at the filed version when the plan it scored is one', async () => {
    // What makes a point on the chart offer "restore the plan this was scored
    // under". Absent when the plan is not in the history, which is the ordinary
    // case mid-day — today's changes are not filed until tomorrow's first edit.
    await withPlan();
    const kept = await keepPlan(PLAN, 'The one I mean');
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    expect((await listSnapshots())[0].score?.planHistoryId).toBe(kept.id);
  });

  it('points at the NEWEST filed version holding that plan', async () => {
    // A plan can pass through the same shape twice (edit, undo, edit back).
    // The most recent time it did is the one the user would recognise.
    await withPlan();
    await keepPlan(PLAN, 'First time');
    const later = await keepPlan(PLAN, 'Second time');
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    expect((await listPlanHistory())[0].id).toBe(later.id);
    expect((await listSnapshots())[0].score?.planHistoryId).toBe(later.id);
  });

  it('records no version at all when the plan it scored is not in the history', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    const [stored] = await listSnapshots();
    expect(stored.score?.planHash).toBe(planHash(PLAN));
    // ABSENT, not an empty string: there is no version to point at.
    expect(stored.score?.planHistoryId).toBeUndefined();
    expect('planHistoryId' in (stored.score ?? {})).toBe(false);
  });

  it('is listed as in flight while the run is going, and not after', async () => {
    // The page needs "scoring…" to be distinguishable from "no score, and none
    // is coming" — the two look identical on a row and mean opposite things.
    await withPlan();
    const row = await snapshot();
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

    const work = startScoring(row.id, deps);
    expect(snapshotsBeingScored()).toEqual([row.id]);
    land();
    await work;
    expect(snapshotsBeingScored()).toEqual([]);
    expect((await listSnapshots())[0].score?.success).toBe(0.941);
  });

  it('joins an attempt already running rather than starting a second', async () => {
    await withPlan();
    const row = await snapshot();
    const deps = fakeDeps();
    const [a, b] = await Promise.all([startScoring(row.id, deps), startScoring(row.id, deps)]);
    expect(a).toBe(b);
    // One attempt: the probability and the spend bisection, once each.
    expect(deps.requests).toHaveLength(2);
  });
});

describe('a run that produces no number', () => {
  it('leaves the row scoreless with a reason a person can read', async () => {
    await withPlan();
    const row = await snapshot();
    const outcome = await startScoring(
      row.id,
      fakeDeps({
        getRun: async () => ({
          runId: 'run-1',
          status: 'error',
          progress: 0.3,
          error: 'Simulation worker exited unexpectedly with code 3',
        }),
      }),
    );

    expect(outcome.status).toBe('failed');
    const [stored] = await listSnapshots();
    expect(stored.score).toBeUndefined();
    expect(stored.scoreError).toContain('worker exited unexpectedly');
    // The irreplaceable half is untouched.
    expect(stored.total).toBe(row.total);
    expect(stored.accounts).toEqual(row.accounts);
  });

  it('says so when the simulation could not even start', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(
      row.id,
      fakeDeps({
        startRun: async () => {
          throw new ValidationError('No stored quote for VTI — press Refresh prices.');
        },
      }),
    );
    // The message names the symbol and the fix, so it is passed through whole.
    expect((await listSnapshots())[0].scoreError).toContain('No stored quote for VTI');
  });

  it('gives up on a run that never lands, instead of "scoring…" for ever', async () => {
    await withPlan();
    const row = await snapshot();
    let clock = Date.parse('2026-08-19T10:00:00.000Z');
    const outcome = await startScoring(
      row.id,
      fakeDeps({
        getRun: async () => ({ runId: 'run-1', status: 'running', progress: 0.5 }),
        // Every poll advances the clock a minute; the deadline is 20.
        wait: async () => {
          clock += 60_000;
        },
        now: () => new Date(clock),
      }),
    );

    expect(outcome.status).toBe('failed');
    expect((await listSnapshots())[0].scoreError).toMatch(/did not finish within \d+ minutes/);
    // It must not name a repair: this same sentence lands on a plan version,
    // which CAN be scored again, and on a net-worth row, which cannot.
    expect((await listSnapshots())[0].scoreError).not.toMatch(/Re-score|try again/i);
    expect(snapshotsBeingScored()).toEqual([]);
  });

  it('says so when the run manager has never heard of the run', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps({ getRun: async () => null }));
    expect((await listSnapshots())[0].scoreError).toMatch(/disappeared/);
  });
});

describe('taking a snapshot still scores it, automatically', () => {
  /**
   * THIS IS THE ONE SCORING PATH LEFT, and it is the one that was never the
   * problem: the run starts the moment the row is written, so what it measures
   * IS the moment the row records. It is the record being formed. Everything
   * removed in this change was the other thing — a measurement of a later day
   * filed onto an earlier day's row.
   */
  it('lands a score on the row the button just wrote', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    const [stored] = await listSnapshots();
    expect(stored.id).toBe(row.id);
    expect(stored.score?.success).toBe(0.941);
    expect(stored.score?.scoredAt).toBe('2026-08-19T10:00:00.000Z');
    // The row's own moment is untouched by the score that lands on it.
    expect(stored.takenAt).toBe(row.takenAt);
  });

  it('is what the snapshot route starts, without waiting for it', () => {
    // Both halves matter: that the route starts a run at all (or every row
    // would arrive unmeasured and stay that way), and that it does not await it
    // (or the irreplaceable half would ride on a simulation finishing).
    const serverSource = readFileSync(
      fileURLToPath(new URL('../../src/server/server.ts', import.meta.url)),
      'utf8',
    );
    expect(serverSource).toContain('void startScoring(snapshot.id)');
  });

  it('leaves the failure standing when the run dies — with no offer to try again', async () => {
    // The cost of removing the retry, pinned as a property rather than left as
    // a claim in a comment: this row is now permanently unmeasured, and what it
    // carries is the reason, not a zero.
    await withPlan();
    const row = await snapshot();
    await startScoring(
      row.id,
      fakeDeps({
        getRun: async () => ({ runId: 'run-1', status: 'error', progress: 0, error: 'boom' }),
      }),
    );

    const [stored] = await listSnapshots();
    expect(stored.score).toBeUndefined();
    expect('score' in stored).toBe(false);
    expect(stored.scoreError).toContain('boom');
    expect(stored.total).toBe(row.total);
  });
});

describe('a row deleted while its simulation runs', () => {
  it('is not resurrected by the score that arrives for it', async () => {
    await withPlan();
    const row = await snapshot();
    // The run finishes after the user has deleted the row.
    const attached = await attachScore(row.id, { error: 'anything' });
    expect(attached).toBe('attached');

    await fs.writeFile(path.join(tmpDir, 'networth.json'), '[]\n', 'utf8');
    expect(await attachScore(row.id, { error: 'too late' })).toBe('row_gone');
    expect(await listSnapshots()).toEqual([]);
  });
});

describe('rows written before scoring existed', () => {
  it('parse, and read as NOT SCORED rather than as a failure or a zero', async () => {
    // A representative first snapshot has this exact shape.
    await fs.writeFile(
      path.join(tmpDir, 'networth.json'),
      JSON.stringify([
        {
          id: 'nw-mszwlw6h-bd9a05',
          takenAt: '2026-08-19T09:43:20.873Z',
          total: 1_845_704.44864,
          homeValue: 550_000,
          accounts: [{ id: 'savings', name: 'Savings', balance: 31_400.18 }],
          prices: { VTI: { price: 379.04, asOf: '2026-08-18T20:00:00.000Z' } },
        },
      ]),
      'utf8',
    );

    const [stored] = await listSnapshots();
    expect(stored.total).toBeCloseTo(1_845_704.45, 2);
    expect(stored.score).toBeUndefined();
    expect(stored.scoreError).toBeUndefined();
  });

  it('keep their money byte for byte when a score is attached to another row', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'networth.json'),
      JSON.stringify([
        {
          id: 'nw-old',
          takenAt: '2026-01-01T00:00:00.000Z',
          total: 1_000,
          homeValue: 0,
          accounts: [],
          prices: {},
        },
      ]),
      'utf8',
    );
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    const [old, scored] = await listSnapshots();
    expect(old).toEqual({
      id: 'nw-old',
      takenAt: '2026-01-01T00:00:00.000Z',
      total: 1_000,
      homeValue: 0,
      accounts: [],
      prices: {},
    });
    expect(scored.score?.success).toBe(0.941);
  });
});

describe('holdings still gate the row itself', () => {
  it('a missing quote stops the SNAPSHOT, which is the half that cannot be redone', async () => {
    // Unchanged behaviour, pinned here because scoring now runs alongside it:
    // a scoring failure is survivable, a mispriced ledger row is not.
    const profile: Profile = await loadProfile();
    const ira = profile.accounts.find((a) => a.id === 'ira1');
    if (ira) ira.holdings = [{ symbol: 'VTI', quantity: 100, assetClass: 'stocks' }];
    await saveProfile(profile);
    const empty: QuotesFile = {};
    await saveQuotes(empty);

    await expect(snapshot()).rejects.toBeInstanceOf(ValidationError);
    expect(await listSnapshots()).toEqual([]);
  });
});

describe('a score belongs to ONE row, and to no other', () => {
  /**
   * The row being scored is usually the last one in the file now — the snapshot
   * route scores what it has just written — which is exactly why this is worth
   * pinning. An attach that wrote to "the newest row" rather than to the row it
   * was asked about would pass every ordinary test, and would go wrong on the
   * one case that still exists: a run still in flight when the NEXT snapshot is
   * taken, which would stamp the new row with the old row's number and leave
   * the old row empty.
   */
  it('attaches to the row it was asked about, not to the newest one', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'networth.json'),
      JSON.stringify([
        {
          id: 'nw-old',
          takenAt: '2026-01-01T00:00:00.000Z',
          total: 1_000,
          homeValue: 0,
          accounts: [],
          prices: {},
        },
      ]),
      'utf8',
    );
    await withPlan();
    // The newest row is a DIFFERENT row from the one being scored.
    const newest = await snapshot();
    await startScoring('nw-old', fakeDeps());

    const [old, latest] = await listSnapshots();
    expect(old.id).toBe('nw-old');
    expect(old.score?.success).toBe(0.941);
    expect(latest.id).toBe(newest.id);
    expect(latest.score).toBeUndefined();
    expect('score' in latest).toBe(false);
  });

  it('writes a failure onto its own row too, leaving the others clean', async () => {
    await withPlan();
    const first = await snapshot();
    await new Promise((r) => setTimeout(r, 2));
    const second = await snapshot();

    await startScoring(
      first.id,
      fakeDeps({
        getRun: async () => ({ runId: 'run-1', status: 'error', progress: 0, error: 'boom' }),
      }),
    );

    const rows = await listSnapshots();
    expect(rows.find((s) => s.id === first.id)?.scoreError).toContain('boom');
    expect(rows.find((s) => s.id === second.id)?.scoreError).toBeUndefined();
  });
});

describe('two writers at once', () => {
  /**
   * networth.json is read-modify-written whole, and it now has more than one
   * writer: the snapshot button, and scores arriving from simulations that
   * started minutes earlier. Interleave two of them without a queue and the
   * loser's work is simply gone — and what would be lost is the one thing in
   * this app that cannot be recreated, because a row records prices from a
   * moment that has passed. So every write goes through one serial chain.
   */
  it('lose nothing: two scores landing together both reach the file', async () => {
    await withPlan();
    const first = await snapshot();
    await new Promise((r) => setTimeout(r, 2));
    const second = await snapshot();

    // Both simulations land in the same tick — the read-modify-write of each
    // would otherwise be based on a file the other is about to overwrite.
    await Promise.all([
      attachScore(first.id, { error: 'the first run failed' }),
      attachScore(second.id, { error: 'the second run failed' }),
    ]);

    const rows = await listSnapshots();
    expect(rows).toHaveLength(2);
    expect(rows.find((s) => s.id === first.id)?.scoreError).toBe('the first run failed');
    expect(rows.find((s) => s.id === second.id)?.scoreError).toBe('the second run failed');
  });

  it('a snapshot taken while a score is landing keeps both the row and the score', async () => {
    await withPlan();
    const old = await snapshot();
    // Warm the resolver so the snapshot's own read-modify-write races the
    // attach rather than trailing minutes behind it.
    await loadProfile();

    const [taken] = await Promise.all([
      snapshot(),
      attachScore(old.id, { error: 'a run that started before this snapshot' }),
    ]);

    const rows = await listSnapshots();
    expect(rows.map((s) => s.id).sort()).toEqual([old.id, taken.id].sort());
    expect(rows.find((s) => s.id === old.id)?.scoreError).toBe(
      'a run that started before this snapshot',
    );
    expect(rows.find((s) => s.id === taken.id)?.total).toBe(taken.total);
  });
});

describe('the plan that actually runs', () => {
  /**
   * A `solver` on a scenario makes the engine run a SWEEP — many simulations
   * answering a question about a DIFFERENT plan (every sweep overrides the
   * decisions the plan just made). plan.json can carry one, hand-typed into
   * the Raw JSON editor or pasted from an old file. The workbench strips it
   * before every plain run (resultsData.scenarioForPlainRun); a recorded score
   * that did not would be a number the Workbench never shows, on a trend that
   * claims to be the plan's own score.
   */
  it('strips the solver off the plan, so the score is a projection', async () => {
    const withSolver: Scenario = {
      ...PLAN,
      solver: { type: 'retire_year_sweep', from: 2030, to: 2035 },
    };
    await savePlan(withSolver);

    const row = await snapshot();
    const deps = fakeDeps();
    await startScoring(row.id, deps);

    expect(deps.requests[0].scenario.solver).toBeUndefined();
    expect('solver' in deps.requests[0].scenario).toBe(false);
    // And the spend run sweeps SPENDING, not the retirement year the plan
    // happened to carry: its own sweep is stripped before ours is added.
    expect(deps.requests[1].scenario.solver).toEqual({ type: 'max_spend' });
    // plan.json itself keeps what the user typed — the strip is about what
    // RUNS, and rewriting his file to make a run tidy would be an edit he
    // never asked for.
    expect((await loadPlan()).solver).toEqual({ type: 'retire_year_sweep', from: 2030, to: 2035 });
  });
});

describe('what the plan could afford', () => {
  /**
   * THE SECOND HALF OF A SCORE, and the one that actually separates two plans
   * here: this household's probability of success saturates — every version
   * reads 96-point-something — so the difference between two of them shows up
   * in dollars a year, not in percentage points.
   *
   * It is attached SECOND, on a row that already carries its probability,
   * because it costs a dozen runs where that one cost one. Everything below is
   * about the seam: the cheap half must survive every way the expensive half
   * can fail, and a non-answer must read as a reason rather than as a number.
   */
  it('records the level and the paths it was bisected at', async () => {
    await withPlan();
    const row = await snapshot();
    await startScoring(row.id, fakeDeps());

    const [stored] = await listSnapshots();
    expect(stored.score?.sustainableSpend).toBe(118_000);
    // min(10,000 requested, the solver's own INNER_PATH_CAP).
    expect(stored.score?.sustainableSpendPaths).toBe(2_000);
    expect(stored.score?.sustainableSpendError).toBeUndefined();
  });

  it('leaves the probability standing when the bisection fails', async () => {
    // The whole reason for two writes. A wedged or crashed sweep must not take
    // down the number the chart is drawn from.
    await withPlan();
    const row = await snapshot();
    const deps = fakeDeps();
    await startScoring(
      row.id,
      {
        ...deps,
        getRun: async () =>
          deps.requests.at(-1)?.scenario.solver
            ? { runId: 'run-1', status: 'error', progress: 0.4, error: 'sweep worker died' }
            : { runId: 'run-1', status: 'done', progress: 1, result: finished() },
      },
    );

    const [stored] = await listSnapshots();
    expect(stored.score?.success).toBe(0.941);
    expect(stored.score?.sustainableSpend).toBeUndefined();
    expect(stored.score?.sustainableSpendError).toContain('sweep worker died');
    // And the row itself is untouched.
    expect(stored.total).toBe(row.total);
  });

  it('says "more than this" rather than recording the top of the bracket', async () => {
    // When even $400,000/yr clears the target the solver returns that ceiling
    // after two probes, and it is indistinguishable from a bisected answer
    // inside the result. Recording it would put a figure on the row that
    // nothing measured — the likely case for an over-funded plan.
    await withPlan();
    const row = await snapshot();
    const deps = fakeDeps();
    await startScoring(row.id, {
      ...deps,
      getRun: async () => ({
        runId: 'run-1',
        status: 'done',
        progress: 1,
        result: deps.requests.at(-1)?.scenario.solver ? solved(400_000) : finished(),
      }),
    });

    const [stored] = await listSnapshots();
    expect(stored.score?.success).toBe(0.941);
    expect(stored.score?.sustainableSpend).toBeUndefined();
    expect(stored.score?.sustainableSpendError).toContain('$400,000');
    expect(stored.score?.sustainableSpendError).toContain('more than this');
  });

  it('says so when nothing in the bracket reaches the target', async () => {
    await withPlan();
    const row = await snapshot();
    const deps = fakeDeps();
    await startScoring(row.id, {
      ...deps,
      getRun: async () => ({
        runId: 'run-1',
        status: 'done',
        progress: 1,
        result: deps.requests.at(-1)?.scenario.solver ? solved(null) : finished(),
      }),
    });

    const [stored] = await listSnapshots();
    expect(stored.score?.sustainableSpend).toBeUndefined();
    expect(stored.score?.sustainableSpendError).toContain('$20,000');
  });

  it('has nowhere to put a spend figure on a row whose score is gone', async () => {
    const row = await snapshot();
    expect(
      await attachSustainableSpend(row.id, { sustainableSpend: 1, sustainableSpendPaths: 2_000 }),
    ).toBe(false);
    expect((await listSnapshots())[0].score).toBeUndefined();
  });
});

describe('the snapshot route (source scan)', () => {
  /**
   * THE ROW MUST NOT WAIT FOR THE SCORE. This is the single property the whole
   * design is arranged around, and it lives in one character: `void` rather
   * than `await` in front of startScoring. Awaiting it would make the POST hang
   * for the minutes a 10,000-path run takes, and a timeout, a closed browser or
   * a crashed worker would then take the SNAPSHOT with it — the half that
   * records a market moment and can never be taken again.
   *
   * There is no route harness in this repo, so this is pinned by reading the
   * handler, bounded to its own body so the prose around it stays free to
   * explain what it prevents.
   */
  const serverSource = readFileSync(
    fileURLToPath(new URL('../../src/server/server.ts', import.meta.url)),
    'utf8',
  );
  const handler = serverSource.slice(
    serverSource.indexOf("app.post('/api/networth/snapshot'"),
    serverSource.indexOf("app.get('/api/networth/scoring'"),
  );

  it('answers with the row without waiting for the simulation', () => {
    expect(handler).toContain('void startScoring(');
    expect(handler).not.toContain('await startScoring(');
  });

  it('writes the row BEFORE the run is even started', () => {
    expect(handler.indexOf('await takeSnapshot(')).toBeGreaterThan(-1);
    expect(handler.indexOf('await takeSnapshot(')).toBeLessThan(handler.indexOf('startScoring('));
  });
});
