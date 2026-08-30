/**
 * SCORING A STORED VERSION OF THE PLAN: what would this one do, measured the
 * same way as everything else? ENVIRONMENT-NEUTRAL since Phase 4 of the
 * browser port — the module that lived at src/server/planHistoryScorer.ts, as
 * a factory over the history store it writes through, with the in-flight
 * registry moved into the instance and no behavioural change.
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
import { ConflictError, NotFoundError } from './dataStore';
import { localDayKey, type PlanHistoryStore } from './planHistoryStore';
import { message, type ScoreRunner, type ScoringDeps } from './scoreRunner';
import {
  inputsMovedReason,
  type ScoringIntentStore,
  type ScoringIntentTarget,
} from './scoringIntent';

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

export interface PlanHistoryScorer {
  versionsBeingScored(): string[];
  startVersionScoring(id: string, deps?: ScoringDeps): Promise<VersionScoringOutcome>;
  scorePlanVersion(id: string, deps?: ScoringDeps): Promise<{ ok: true; scoring: boolean }>;
  /**
   * Complete an INTERRUPTED scoring run — the Finish behind an orphaned
   * intent (decision D4, store/scoringIntent.ts). Verifies the intent's
   * runKey against today's inputs first; 'identical' completes the SAME
   * measurement as a blank-fill, 'moved' stamps the missing half with the
   * honest reason and clears the intent. This is the one path that may write
   * a spend figure onto a version scored in an EARLIER process — legitimate
   * exactly because the runKey proves the world has not moved between the
   * probability and the figure.
   */
  finishVersionScoring(id: string, deps?: ScoringDeps): Promise<VersionScoringOutcome>;
}

export interface PlanHistoryScorerOptions {
  planHistory: PlanHistoryStore;
  runner: ScoreRunner;
  /** The environment's real ScoringDeps; tests pass their own per call. */
  defaultDeps: ScoringDeps;
  /** The write-ahead intent store — see SnapshotScorerOptions.intents. */
  intents?: ScoringIntentStore;
  /** Registry-size hook — see SnapshotScorerOptions.onInFlightChange. */
  onInFlightChange?: (inFlight: number) => void;
}

export function createPlanHistoryScorer(opts: PlanHistoryScorerOptions): PlanHistoryScorer {
  const { planHistory, runner, defaultDeps, intents } = opts;

  const target = (id: string): ScoringIntentTarget => ({ kind: 'plan-version', id });

  /** Clear the entry's intent; never throws — see snapshotScorer.clearIntent. */
  async function clearIntent(id: string): Promise<void> {
    await intents?.clear(target(id)).catch(() => undefined);
  }

  /** Versions with a simulation in flight, keyed so a double-press joins it. */
  const inFlight = new Map<string, Promise<VersionScoringOutcome>>();

  /** Which versions are being scored, for the page's "scoring…" cell. */
  function versionsBeingScored(): string[] {
    return [...inFlight.keys()];
  }

  /** The one registry door — see snapshotScorer.launch for why it is one. */
  function launch(
    id: string,
    work: () => Promise<VersionScoringOutcome>,
  ): Promise<VersionScoringOutcome> {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const running = work().finally(() => {
      inFlight.delete(id);
      opts.onInFlightChange?.(inFlight.size);
    });
    inFlight.set(id, running);
    opts.onInFlightChange?.(inFlight.size);
    return running;
  }

  function startVersionScoring(
    id: string,
    deps: ScoringDeps = defaultDeps,
  ): Promise<VersionScoringOutcome> {
    return launch(id, () => scoreVersion(id, deps));
  }

  async function scoreVersion(id: string, deps: ScoringDeps): Promise<VersionScoringOutcome> {
    const entry = await planHistory.getPlanHistoryEntry(id);
    // Asked again here, and not only in scorePlanVersion, because this is the
    // side that spends the minutes: attachPlanHistoryScore would refuse a scored
    // entry anyway, but only after a 10,000-path run and a dozen-run bisection
    // had been computed for a number with nowhere to go.
    if (entry.score !== undefined) return { status: 'already_scored' };
    // The runner records the write-ahead intent before each phase's run —
    // see scoreRunner.runToCompletion and store/scoringIntent.ts.
    const attempt = await runner.scorePlan(entry.plan, deps, target(id));
    if (!attempt.ok) {
      const trimmed =
        attempt.reason.length > 1000 ? `${attempt.reason.slice(0, 997)}...` : attempt.reason;
      const attached = await planHistory.attachPlanHistoryScore(id, { error: trimmed });
      // A recorded failure IS the outcome; the intent clears (attach first,
      // clear second — a kill between the two reads as satisfied at boot).
      await clearIntent(id);
      return attached === 'attached' ? { status: 'failed', reason: trimmed } : { status: attached };
    }
    const attached = await planHistory.attachPlanHistoryScore(id, { score: attempt.score });
    if (attached !== 'attached') {
      await clearIntent(id);
      return { status: attached };
    }

    // Then the expensive half, on a version that already carries its number —
    // see snapshotScorer for why the two are attached separately. It matters
    // more here than anywhere: this household's success rate saturates, so
    // "what could this version afford" is the question that actually tells two
    // of them apart.
    const spend = await runner.solveSustainableSpend(entry.plan, deps, target(id));
    await planHistory.attachPlanHistorySpend(
      id,
      spend.ok
        ? { sustainableSpend: spend.sustainableSpend, sustainableSpendPaths: spend.sustainableSpendPaths }
        : { error: spend.reason.length > 1000 ? `${spend.reason.slice(0, 997)}...` : spend.reason },
    );
    await clearIntent(id);
    return { status: 'scored' };
  }

  /**
   * The Finish button's work for a plan version — the mirror of
   * snapshotScorer.finishInterrupted, over the entry's own frozen plan (a
   * version cannot drift; only the world around it can). Never throws: it is
   * fired unawaited from the finish route, so every failure is an outcome.
   */
  function finishVersionScoring(
    id: string,
    deps: ScoringDeps = defaultDeps,
  ): Promise<VersionScoringOutcome> {
    return launch(id, () => finishInterrupted(id, deps));
  }

  async function finishInterrupted(
    id: string,
    deps: ScoringDeps,
  ): Promise<VersionScoringOutcome> {
    if (!intents) {
      return { status: 'failed', reason: 'This backend has no intent machinery composed.' };
    }
    try {
      const intent = (await intents.list()).find(
        (i) => i.kind === 'plan-version' && i.id === id,
      );
      let entry: PlanHistoryEntry;
      try {
        entry = await planHistory.getPlanHistoryEntry(id);
      } catch (err) {
        if (err instanceof NotFoundError) {
          await clearIntent(id);
          return { status: 'entry_gone' };
        }
        throw err;
      }
      const complete =
        entry.scoreError !== undefined ||
        (entry.score !== undefined &&
          (entry.score.sustainableSpend !== undefined ||
            entry.score.sustainableSpendError !== undefined));
      if (complete) {
        await clearIntent(id);
        return { status: 'already_scored' };
      }
      if (!intent) {
        return {
          status: 'failed',
          reason:
            'No interrupted scoring is recorded for this version, so there is nothing to finish.',
        };
      }

      let verdict: 'identical' | 'moved';
      try {
        verdict = await runner.verifyIntent(entry.plan, intent);
      } catch (err) {
        // Transient: nothing is stamped, the intent stays, the button stays.
        return {
          status: 'failed',
          reason: `The interrupted run could not be verified against today’s inputs: ${message(err)}`,
        };
      }

      if (verdict === 'moved') {
        const reason = inputsMovedReason(entry.score === undefined ? 'score' : 'spend');
        if (entry.score === undefined) {
          await planHistory.attachPlanHistoryScore(id, { error: reason });
        } else {
          await planHistory.attachPlanHistorySpend(id, { error: reason });
        }
        await clearIntent(id);
        return { status: 'failed', reason };
      }

      if (entry.score === undefined) return await scoreVersion(id, deps);

      // The Aug-20 shape: probability standing, bisection lost. Fill the one
      // blank the kill left, under the runKey the interrupted solve carried.
      const spend = await runner.solveSustainableSpend(entry.plan, deps, target(id));
      await planHistory.attachPlanHistorySpend(
        id,
        spend.ok
          ? {
              sustainableSpend: spend.sustainableSpend,
              sustainableSpendPaths: spend.sustainableSpendPaths,
            }
          : { error: spend.reason.length > 1000 ? `${spend.reason.slice(0, 997)}...` : spend.reason },
      );
      await clearIntent(id);
      return { status: 'scored' };
    } catch (err) {
      return { status: 'failed', reason: message(err) };
    }
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
  async function scorePlanVersion(
    id: string,
    deps: ScoringDeps = defaultDeps,
  ): Promise<{ ok: true; scoring: boolean }> {
    const entry = await planHistory.getPlanHistoryEntry(id);
    if (entry.score !== undefined) throw new ConflictError(alreadyScoredMessage(entry));
    void startVersionScoring(id, deps);
    return { ok: true, scoring: true };
  }

  return { versionsBeingScored, startVersionScoring, scorePlanVersion, finishVersionScoring };
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
    'restore it: the Plan page runs the plan on screen live.'
  );
}
