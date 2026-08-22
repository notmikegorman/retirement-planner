/**
 * SCORING A STORED VERSION OF THE PLAN: what would this one do, measured the
 * same way as everything else?
 *
 * The History tab exists to be recognised from — "the one where we bought in
 * 2028 and it was 96%" — and a list of dates with no numbers is not
 * recognisable. So any version can be scored on demand, under the SAME
 * conditions as a net-worth row's score (scoreRunner owns the mode, the paths
 * and the seed), which is what makes the two columns readable side by side.
 *
 * SCORING IS ON DEMAND, NOT AUTOMATIC. Filing a version happens on the first
 * edit of the day, in the middle of an editing session, and a final-quality run
 * fired automatically at that moment would compete with the workbench's own
 * live run for the same cores while the user is mid-thought. A version scored
 * whenever the user asks is worth more than one scored while they were typing.
 *
 * A SCORE IS A SCORE UNDER TODAY'S CONDITIONS. Balances, prices, assumptions
 * and the calendar all move; scoring a version from last month today reports
 * what that plan would do NOW, not what it reported then. That is the useful
 * question ("would this still work?") and `scoredAt` on the score says which
 * day's world it was asked in.
 *
 * WHICH IS EXACTLY WHY IT HAPPENS ONCE. A scored entry is refused here, and it
 * used to offer a "Score it again". The user's objection to that button is the
 * rule this module now enforces: a recorded number is a RECORD of a moment —
 * that plan, measured against that day's balances and prices — and a button
 * that rewrites one contradicts the only thing the record was for. Since a
 * second score would be taken under a different day's conditions (see the
 * paragraph above), filing it on the same row would make one row report two
 * different moments as if they were one.
 *
 * FILLING A BLANK IS NOT OVERWRITING, so two kinds of entry can still be
 * scored: one nobody has ever measured, and one whose scoring FAILED. A failure
 * records no measurement — it says the run died — so replacing it costs no
 * fact. A success and a failure are told apart in the message the History tab
 * prints, never merged into one "no number here".
 */
import type { PlanHistoryEntry } from '../shared/types';
import { ConflictError } from './dataStore';
import {
  attachPlanHistoryScore,
  attachPlanHistorySpend,
  getPlanHistoryEntry,
  localDayKey,
} from './planHistoryStore';
import {
  REAL_SCORING_DEPS,
  type ScoringDeps,
  scorePlan,
  solveSustainableSpend,
} from './scoreRunner';

/** Versions with a simulation in flight, keyed so a double-press joins it. */
const inFlight = new Map<string, Promise<VersionScoringOutcome>>();

export type VersionScoringOutcome =
  | { status: 'scored' }
  /** The version was deleted while its simulation ran. Not reachable today —
   *  nothing deletes entries — but attachPlanHistoryScore answers for it. */
  | { status: 'entry_gone' }
  /** The version already carried a score. `scorePlanVersion` refuses before a
   *  single path is simulated, so this is the store having the last word on a
   *  caller that skipped the front door — reported honestly rather than as
   *  'entry_gone', which would name the wrong reason for the same silence. */
  | { status: 'already_scored' }
  | { status: 'failed'; reason: string };

/** Which versions are being scored, for the page's "scoring…" cell. */
export function versionsBeingScored(): string[] {
  return [...inFlight.keys()];
}

export function startVersionScoring(
  id: string,
  deps: ScoringDeps = REAL_SCORING_DEPS,
): Promise<VersionScoringOutcome> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const work = scoreVersion(id, deps).finally(() => {
    inFlight.delete(id);
  });
  inFlight.set(id, work);
  return work;
}

async function scoreVersion(id: string, deps: ScoringDeps): Promise<VersionScoringOutcome> {
  const entry = await getPlanHistoryEntry(id);
  // Asked again here, and not only in scorePlanVersion, because this is the
  // side that spends the minutes: attachPlanHistoryScore would refuse a scored
  // entry anyway, but only after a 10,000-path run and a dozen-run bisection
  // had been computed for a number with nowhere to go.
  if (entry.score !== undefined) return { status: 'already_scored' };
  const attempt = await scorePlan(entry.plan, deps);
  if (!attempt.ok) {
    const trimmed =
      attempt.reason.length > 1000 ? `${attempt.reason.slice(0, 997)}...` : attempt.reason;
    const attached = await attachPlanHistoryScore(id, { error: trimmed });
    return attached === 'attached' ? { status: 'failed', reason: trimmed } : { status: attached };
  }
  const attached = await attachPlanHistoryScore(id, { score: attempt.score });
  if (attached !== 'attached') return { status: attached };

  // Then the expensive half, on a version that already carries its number —
  // see snapshotScorer for why the two are attached separately. It matters
  // more here than anywhere: this household's success rate saturates, so
  // "what could this version afford" is the question that actually tells two
  // of them apart.
  const spend = await solveSustainableSpend(entry.plan, deps);
  await attachPlanHistorySpend(
    id,
    spend.ok
      ? { sustainableSpend: spend.sustainableSpend, sustainableSpendPaths: spend.sustainableSpendPaths }
      : { error: spend.reason.length > 1000 ? `${spend.reason.slice(0, 997)}...` : spend.reason },
  );
  return { status: 'scored' };
}

/**
 * Score one version on demand. Throws a 404 for an unknown id and a 409 for one
 * that already carries a score, BOTH BEFORE starting anything — a press against
 * a stale list says so instead of silently doing nothing in the background, and
 * a version that is already measured costs no minutes of simulation to refuse.
 *
 * THE REFUSAL IS THE POINT, AND IT LIVES HERE RATHER THAN IN THE BUTTON. The
 * History tab no longer draws a button on a scored row, but a guard the UI can
 * forget is not a guard: a stale tab still holding yesterday's list, a replayed
 * request, or the next page that wants to score something would all walk
 * straight past it. Refusing beats silently succeeding for the same reason the
 * button was removed — succeeding would REPLACE a recorded number, and the
 * caller would have no way to know that the figure it now reads belongs to a
 * different day than the row it sits on. It also beats silently doing nothing:
 * a press that returns ok and never changes anything reads as a bug, and the
 * owner would press it again.
 */
export async function scorePlanVersion(
  id: string,
  deps: ScoringDeps = REAL_SCORING_DEPS,
): Promise<{ ok: true; scoring: boolean }> {
  const entry = await getPlanHistoryEntry(id);
  if (entry.score !== undefined) throw new ConflictError(alreadyScoredMessage(entry));
  void startVersionScoring(id, deps);
  return { ok: true, scoring: true };
}

/**
 * The sentence the user reads when they ask for a number that already exists.
 *
 * It names the version, says WHEN the number was taken (the fact that makes the
 * refusal make sense — that day's balances, that day's prices), and ends with
 * the thing they can actually do instead. "Restore it" is the honest advice:
 * restoring copies the version onto the plan and the workbench runs it live, so
 * the question behind the press — what would THIS plan do today — is answered
 * without a second number being filed on a record of a different day.
 */
function alreadyScoredMessage(entry: PlanHistoryEntry): string {
  const which = entry.label === undefined ? 'That version' : `“${entry.label}”`;
  const when = localDayKey(new Date(entry.score?.scoredAt ?? entry.takenAt));
  return (
    `${which} already has a score, measured on ${when} against that day's balances and ` +
    'prices. A recorded score is not rewritten — a second number on the same row would ' +
    'report two different days as if they were one. To see what this plan would do today, ' +
    'restore it: the workbench runs the plan on screen live.'
  );
}
