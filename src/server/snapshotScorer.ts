/**
 * SCORING A SNAPSHOT: run THE PLAN at final quality and attach the result to
 * the ledger row, without ever making the row wait for it.
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
 * IN-FLIGHT STATE IS MEMORY-ONLY. Nothing about "a run is going" is written to
 * disk: a server restarted mid-run leaves the row exactly as it was — scoreless
 * — rather than carrying a persisted "scoring…" that would be a lie forever
 * after. The page asks who is in flight through `snapshotsBeingScored()`, and
 * gets an empty list after a restart, which is the truth.
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
import type { Scenario, SnapshotScore } from '../shared/types';
import { attachScore, attachSustainableSpend } from './networthStore';
import { listPlanHistory, planHash } from './planHistoryStore';
import { loadPlan } from './planStore';
import {
  REAL_SCORING_DEPS,
  type ScoringDeps,
  message,
  scorePlan,
  solveSustainableSpend,
} from './scoreRunner';

export type { ScoringDeps } from './scoreRunner';

/**
 * Snapshot ids with a simulation in flight right now, keyed to the promise so
 * a second request for the same row JOINS the run rather than starting a
 * second identical one. (Two identical runs would in fact collapse onto one
 * run key inside the run manager, but they would race to write the same ledger
 * row afterwards.) Nothing in the app starts a second one today — the snapshot
 * route is the only caller and it is handed an id it has just minted — but the
 * map is what makes that a property of the module rather than of its callers.
 */
const inFlight = new Map<string, Promise<ScoringOutcome>>();

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

/** Which rows are being scored, for the page's "scoring…" cell. */
export function snapshotsBeingScored(): string[] {
  return [...inFlight.keys()];
}

/**
 * Score `snapshotId` in the background and return the promise for it.
 *
 * The route does not await this: POST /api/networth/snapshot answers with the
 * row the instant it is written, and the page fills the score cell in when the
 * ledger reports one. Tests DO await it, which is the only reason it is
 * returned rather than swallowed.
 *
 * That POST is the ONLY caller. It is called with a row that was written
 * moments ago and carries nothing, so this always writes into a blank; the
 * guard inside `attachScore` is what keeps that true rather than assumed.
 */
export function startScoring(
  snapshotId: string,
  deps: ScoringDeps = REAL_SCORING_DEPS,
): Promise<ScoringOutcome> {
  const existing = inFlight.get(snapshotId);
  if (existing) return existing;

  const work = scoreSnapshot(snapshotId, deps).finally(() => {
    inFlight.delete(snapshotId);
  });
  inFlight.set(snapshotId, work);
  return work;
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
    return (await listPlanHistory()).find((e) => e.planHash === hash)?.id;
  } catch {
    // An unreadable history must not cost the row its score: the hash above is
    // the load-bearing half, and this is a convenience link.
    return undefined;
  }
}

async function scoreSnapshot(snapshotId: string, deps: ScoringDeps): Promise<ScoringOutcome> {
  let plan: Scenario;
  try {
    plan = await loadPlan();
  } catch (err) {
    return fail(snapshotId, `The plan could not be read: ${message(err)}`);
  }

  const attempt = await scorePlan(plan, deps);
  if (!attempt.ok) return fail(snapshotId, attempt.reason);

  const hash = planHash(plan);
  const historyId = await matchingHistoryId(hash);
  const score: SnapshotScore = {
    ...attempt.score,
    planHash: hash,
    ...(historyId !== undefined ? { planHistoryId: historyId } : {}),
  };
  const attached = await attachScore(snapshotId, { score });
  if (attached !== 'attached') return { status: attached };

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
  const spend = await solveSustainableSpend(plan, deps);
  await attachSustainableSpend(
    snapshotId,
    spend.ok
      ? { sustainableSpend: spend.sustainableSpend, sustainableSpendPaths: spend.sustainableSpendPaths }
      : { error: spend.reason.length > 1000 ? `${spend.reason.slice(0, 997)}...` : spend.reason },
  );
  return { status: 'scored', score };
}

/** Write the reason onto the row and report it. A vanished row keeps nothing. */
async function fail(snapshotId: string, reason: string): Promise<ScoringOutcome> {
  // Bounded to the schema's limit: a stack trace from a worker can run to
  // kilobytes, and the ledger is not a log file.
  const trimmed = reason.length > 1000 ? `${reason.slice(0, 997)}...` : reason;
  const attached = await attachScore(snapshotId, { error: trimmed });
  return attached === 'attached' ? { status: 'failed', reason: trimmed } : { status: attached };
}

