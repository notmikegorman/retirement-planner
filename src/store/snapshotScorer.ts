/**
 * SCORING A SNAPSHOT: run THE PLAN at final quality and attach the result to
 * the ledger row, without ever making the row wait for it. ENVIRONMENT-
 * NEUTRAL since Phase 4 of the browser port — the module that lived at
 * src/server/snapshotScorer.ts, as a factory over the stores it writes
 * through, with the in-flight registry moved into the instance and no
 * behavioural change.
 *
 * THE ORDERING IS THE WHOLE DESIGN. A snapshot records market prices at a
 * moment that has passed and cannot be recreated; a score is a computation
 * that can be repeated at any time. So the row is written FIRST and alone, and
 * the score is attached later or not at all. A snapshot must never be lost
 * because a simulation was slow, crashed, or was interrupted by a closed
 * browser — 10,000 paths is minutes of work, and nothing about that work is
 * allowed to put the irreplaceable half at risk.
 *
 * WHAT IT SCORES IS THE PLAN AS IT STANDS. There used to be a separate frozen
 * "baseline plan" here, because plan.json is rewritten on every knob turn and a
 * snapshot taken mid what-if would poison the trend with a thought its owner
 * never meant to keep. The plan's history answers that better: every recorded
 * score carries the `planHash` it scored and, when it matches one, the id of
 * the version in the history — so the chart can mark the point where the plan
 * changed instead of drawing through it, and a point can offer to restore the
 * plan it was scored under. One plan, and a memory of every day of it.
 *
 * IN-FLIGHT STATE IS MEMORY-ONLY — but since Phase 6 of the browser port it
 * leaves a WRITE-AHEAD INTENT behind it. The in-flight registry still lives in
 * memory and still answers empty after a restart (a persisted "scoring…" flag
 * would be a lie forever after); what IS on disk is the intent file
 * (store/scoringIntent.ts): {which row, which phase, the runKey the run will
 * compute}, recorded before each run starts and cleared when both attaches
 * complete. That file is what turns the Aug-20 class of loss — a restart
 * between the two attaches permanently cost a real record its sustainable-
 * spend figure, because nothing on disk said a solve had been in flight —
 * into a recoverable state: on boot an orphaned intent whose runKey still
 * resolves identically from today's inputs makes the row INTERRUPTED with a
 * one-click Finish (`finishScoring` below, decision D4), and one whose
 * inputs have moved resolves to honestly-unmeasured with the reason. In the
 * browser the process is the tab, so this is the difference between "a rare
 * restart" and "every accidental tab close".
 *
 * A SCORE IS ATTACHED ONCE, WHEN THE ROW IS FORMED, AND NEVER AGAIN. There was
 * a re-score button on the ledger and a POST /api/networth/:id/score behind it,
 * and it was the worst version of a mistake the user named: it scored
 * TODAY's plan against TODAY's profile and filed the answer on a row recorded
 * on a different day under a different plan — a number that was never true of
 * that row. Both are gone. The automatic run below stays, because that one is
 * the record being FORMED rather than rewritten.
 *
 * WHAT THAT COSTS, AND WHY IT IS WORTH IT: a row whose run dies (a restart
 * mid-simulation) is scoreless for good. That is a true statement about the
 * moment — nobody measured it — and the page says exactly that. The alternative
 * was a button that filled the gap with a measurement of a different day.
 */
import type { NetWorthSnapshot, Scenario, SnapshotScore } from '../shared/types';
import type { NetworthStore } from './networthStore';
import { planHash, type PlanHistoryStore } from './planHistoryStore';
import type { PlanStore } from './planStore';
import { message, type ScoreRunner, type ScoringDeps } from './scoreRunner';
import {
  inputsMovedReason,
  type ScoringIntentStore,
  type ScoringIntentTarget,
} from './scoringIntent';

/** What a scoring attempt did — reported to the caller, never to disk. */
export type ScoringOutcome =
  /** The score was computed and attached. */
  | { status: 'scored'; score: SnapshotScore }
  /** The row was deleted while its simulation ran; the score belongs to nothing. */
  | { status: 'row_gone' }
  /**
   * The row already carried a score, and one is never written twice. Not
   * reachable today — the only caller scores a row it has just written — but
   * `attachScore` answers for it, and reporting it as 'row_gone' would name the
   * wrong reason for the same silence.
   */
  | { status: 'already_scored' }
  /** The run failed, or never finished. `reason` is what the row now carries. */
  | { status: 'failed'; reason: string };

export interface SnapshotScorer {
  snapshotsBeingScored(): string[];
  startScoring(snapshotId: string, deps?: ScoringDeps): Promise<ScoringOutcome>;
  /**
   * Complete an INTERRUPTED scoring run — the one-click Finish behind an
   * orphaned intent (decision D4). Verifies first that the intent's runKey
   * still resolves identically from today's inputs; on 'identical' it
   * completes the SAME measurement (a blank-fill, never an overwrite — the
   * run cache may even hold the finished result), on 'moved' it stamps the
   * missing half with the honest reason and clears the intent.
   */
  finishScoring(snapshotId: string, deps?: ScoringDeps): Promise<ScoringOutcome>;
}

export interface SnapshotScorerOptions {
  networth: NetworthStore;
  planHistory: PlanHistoryStore;
  plan: PlanStore;
  runner: ScoreRunner;
  /** The environment's real ScoringDeps; tests pass their own per call. */
  defaultDeps: ScoringDeps;
  /**
   * The write-ahead intent store (store/scoringIntent.ts). Optional so unit
   * tests of the attach machinery need no intent fixture; the composed
   * services always pass it — without it an interruption is a silent
   * permanent blank, the pre-Phase-6 behaviour.
   */
  intents?: ScoringIntentStore;
  /**
   * Fired with the registry's size on every change — the seam the local
   * backend arms its beforeunload warning through (exactly while any scoring
   * is in flight, mirroring the search guard's arm/disarm discipline).
   */
  onInFlightChange?: (inFlight: number) => void;
}

export function createSnapshotScorer(opts: SnapshotScorerOptions): SnapshotScorer {
  const { networth, planHistory, plan: planStore, runner, defaultDeps, intents } = opts;

  const target = (snapshotId: string): ScoringIntentTarget => ({
    kind: 'snapshot',
    id: snapshotId,
  });

  /** Clear the row's intent, if the machinery is wired. Never throws: the
   *  outcome is already attached, and a failed cleanup must not turn a scored
   *  row into a rejected promise — the healer clears satisfied intents at the
   *  next boot anyway. */
  async function clearIntent(snapshotId: string): Promise<void> {
    await intents?.clear(target(snapshotId)).catch(() => undefined);
  }

  /**
   * Snapshot ids with a simulation in flight right now, keyed to the promise so
   * a second request for the same row JOINS the run rather than starting a
   * second identical one. (Two identical runs would in fact collapse onto one
   * run key inside the run manager, but they would race to write the same ledger
   * row afterwards.) Nothing in the app starts a second one today — the snapshot
   * flow is the only caller and it is handed an id it has just minted — but the
   * map is what makes that a property of the module rather than of its callers.
   */
  const inFlight = new Map<string, Promise<ScoringOutcome>>();

  /** Which rows are being scored, for the page's "scoring…" cell. */
  function snapshotsBeingScored(): string[] {
    return [...inFlight.keys()];
  }

  /**
   * Register one piece of scoring work in the registry — the single door for
   * both the forming run and a Finish, so joining, the page's "scoring…" and
   * the unload guard's arm/disarm cannot differ between them.
   */
  function launch(
    snapshotId: string,
    work: () => Promise<ScoringOutcome>,
  ): Promise<ScoringOutcome> {
    const existing = inFlight.get(snapshotId);
    if (existing) return existing;
    const running = work().finally(() => {
      inFlight.delete(snapshotId);
      opts.onInFlightChange?.(inFlight.size);
    });
    inFlight.set(snapshotId, running);
    opts.onInFlightChange?.(inFlight.size);
    return running;
  }

  /**
   * Score `snapshotId` in the background and return the promise for it.
   *
   * The caller does not await this: the snapshot flow answers with the row the
   * instant it is written, and the page fills the score cell in when the
   * ledger reports one. Tests DO await it, which is the only reason it is
   * returned rather than swallowed.
   *
   * The snapshot flow is the ONLY caller. It calls with a row that was written
   * moments ago and carries nothing, so this always writes into a blank; the
   * guard inside `attachScore` is what keeps that true rather than assumed.
   */
  function startScoring(
    snapshotId: string,
    deps: ScoringDeps = defaultDeps,
  ): Promise<ScoringOutcome> {
    return launch(snapshotId, () => scoreSnapshot(snapshotId, deps));
  }

  /**
   * The version in the history this plan matches, NEWEST FIRST — the plan can
   * pass through the same shape twice (edit, undo, edit back), and the most
   * recent time it did is the one the user would recognise. Undefined when the
   * plan is not in the history, which is the ordinary case mid-day: today's
   * changes are not filed until tomorrow's first edit.
   */
  async function matchingHistoryId(hash: string): Promise<string | undefined> {
    try {
      return (await planHistory.listPlanHistory()).find((e) => e.planHash === hash)?.id;
    } catch {
      // An unreadable history must not cost the row its score: the hash above is
      // the load-bearing half, and this is a convenience link.
      return undefined;
    }
  }

  async function scoreSnapshot(snapshotId: string, deps: ScoringDeps): Promise<ScoringOutcome> {
    let plan: Scenario;
    try {
      plan = await planStore.loadPlan();
    } catch (err) {
      return fail(snapshotId, `The plan could not be read: ${message(err)}`);
    }

    // The runner records the write-ahead intent (phase 'score', this run's
    // key) before the simulation starts — see runToCompletion.
    const attempt = await runner.scorePlan(plan, deps, target(snapshotId));
    if (!attempt.ok) return fail(snapshotId, attempt.reason);

    const hash = planHash(plan);
    const historyId = await matchingHistoryId(hash);
    const score: SnapshotScore = {
      ...attempt.score,
      planHash: hash,
      ...(historyId !== undefined ? { planHistoryId: historyId } : {}),
    };
    const attached = await networth.attachScore(snapshotId, { score });
    if (attached !== 'attached') {
      // Nothing left in flight for this row — the score had nowhere to go.
      await clearIntent(snapshotId);
      return { status: attached };
    }

    /*
     * THEN THE EXPENSIVE HALF, on the row that already has its number.
     *
     * Success saturates for this household — every version reads 96-point-
     * something — so what actually separates two plans is what they could
     * afford, and that is a bisection of a dozen runs where the score above was
     * one. It is attached second precisely because it can fail on its own: a
     * wedged solve, or a plan whose answer is off the end of the solver's
     * bracket, must leave the probability standing rather than take it down too.
     *
     * `startScoring`'s promise covers both, so the row stays listed as in flight
     * until the whole thing lands and the page keeps saying "scoring…" — which
     * is the truth: a simulation is still running.
     */
    // The runner updates the intent at this phase boundary (phase 'spend',
    // the bisection's own run key) before the solve starts.
    const spend = await runner.solveSustainableSpend(plan, deps, target(snapshotId));
    await networth.attachSustainableSpend(
      snapshotId,
      spend.ok
        ? { sustainableSpend: spend.sustainableSpend, sustainableSpendPaths: spend.sustainableSpendPaths }
        : { error: spend.reason.length > 1000 ? `${spend.reason.slice(0, 997)}...` : spend.reason },
    );
    // BOTH attaches are on the row; only now is there nothing left to lose.
    await clearIntent(snapshotId);
    return { status: 'scored', score };
  }

  /** Write the reason onto the row and report it. A vanished row keeps nothing. */
  async function fail(snapshotId: string, reason: string): Promise<ScoringOutcome> {
    // Bounded to the schema's limit: a stack trace from a worker can run to
    // kilobytes, and the ledger is not a log file.
    const trimmed = reason.length > 1000 ? `${reason.slice(0, 997)}...` : reason;
    const attached = await networth.attachScore(snapshotId, { error: trimmed });
    // The failure is RECORDED — the scoring completed, with a reason instead
    // of a number — so the intent clears. Attach first, clear second: a kill
    // between the two leaves an intent pointing at a row that carries its
    // outcome, which the boot healer clears as satisfied.
    await clearIntent(snapshotId);
    return attached === 'attached' ? { status: 'failed', reason: trimmed } : { status: attached };
  }

  /**
   * The Finish button's work (see the interface doc). Runs through `launch`,
   * so the page's "scoring…" cell and the unload guard treat a completion
   * exactly like the forming run it resumes. Never throws: it is fired
   * unawaited from the finish route, so every failure is an outcome.
   */
  function finishScoring(
    snapshotId: string,
    deps: ScoringDeps = defaultDeps,
  ): Promise<ScoringOutcome> {
    return launch(snapshotId, () => finishInterrupted(snapshotId, deps));
  }

  async function finishInterrupted(
    snapshotId: string,
    deps: ScoringDeps,
  ): Promise<ScoringOutcome> {
    if (!intents) {
      return { status: 'failed', reason: 'This backend has no intent machinery composed.' };
    }
    try {
      const intent = (await intents.list()).find(
        (i) => i.kind === 'snapshot' && i.id === snapshotId,
      );
      const rows = await networth.listSnapshots();
      const row = rows.find((r) => r.id === snapshotId);
      if (!row) {
        await clearIntent(snapshotId);
        return { status: 'row_gone' };
      }
      if (rowComplete(row)) {
        // Nothing left to finish — the outcome is already on the row (a race
        // with the healer, or a double press across a reload).
        await clearIntent(snapshotId);
        return { status: 'already_scored' };
      }
      if (!intent) {
        // No recorded intent for a still-blank row: there is nothing that says
        // what was in flight, so there is nothing that may honestly be
        // finished. NOT written to the row — the row already reads as
        // permanently unmeasured, which is the truth.
        return {
          status: 'failed',
          reason:
            'No interrupted scoring is recorded for this row, so there is nothing to finish.',
        };
      }

      let plan: Scenario;
      try {
        plan = await planStore.loadPlan();
      } catch (err) {
        // Transient by assumption: nothing is stamped, the intent stays, the
        // button stays. A permanent verdict needs a readable world.
        return { status: 'failed', reason: `The plan could not be read: ${message(err)}` };
      }

      let verdict: 'identical' | 'moved';
      try {
        verdict = await runner.verifyIntent(plan, intent);
      } catch (err) {
        return {
          status: 'failed',
          reason: `The interrupted run could not be verified against today’s inputs: ${message(err)}`,
        };
      }

      if (verdict === 'moved') {
        // Finishing would file a figure that belongs to now. Stamp the honest
        // reason on the missing half and retire the intent.
        const reason = inputsMovedReason(row.score === undefined ? 'score' : 'spend');
        if (row.score === undefined) await networth.attachScore(snapshotId, { error: reason });
        else await networth.attachSustainableSpend(snapshotId, { error: reason });
        await clearIntent(snapshotId);
        return { status: 'failed', reason };
      }

      // Identical: the interrupted measurement is still THE measurement.
      if (row.score === undefined) {
        // Nothing landed before the kill — the whole flow re-runs. Same plan,
        // same resolved inputs (just verified), so the run cache may answer
        // both halves without simulating a path.
        return await scoreSnapshot(snapshotId, deps);
      }
      // The probability landed; only the bisection was lost. This is the
      // Aug-20 shape, completed: the spend attach below fills the one blank
      // the kill left, under the same runKey the interrupted solve carried.
      const spend = await runner.solveSustainableSpend(plan, deps, target(snapshotId));
      await networth.attachSustainableSpend(
        snapshotId,
        spend.ok
          ? {
              sustainableSpend: spend.sustainableSpend,
              sustainableSpendPaths: spend.sustainableSpendPaths,
            }
          : { error: spend.reason.length > 1000 ? `${spend.reason.slice(0, 997)}...` : spend.reason },
      );
      await clearIntent(snapshotId);
      return { status: 'scored', score: row.score };
    } catch (err) {
      // Fired unawaited — a rejection here would be an unhandled rejection in
      // a background task nobody is watching. Nothing is stamped: the intent
      // survives for the next attempt or the next boot's healer.
      return { status: 'failed', reason: message(err) };
    }
  }

  return { snapshotsBeingScored, startScoring, finishScoring };
}

/** Nothing left to finish: an outcome (number or reason) fills every slot. */
function rowComplete(row: NetWorthSnapshot): boolean {
  if (row.scoreError !== undefined) return true;
  if (row.score === undefined) return false;
  return (
    row.score.sustainableSpend !== undefined || row.score.sustainableSpendError !== undefined
  );
}
