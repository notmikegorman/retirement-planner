/**
 * THE PLAN'S HISTORY (plan-history.json): every version of the plan there has
 * been, oldest first, and nothing ever edited in place.
 *
 * The plan saves itself as it is edited — no Save button, no dropdown, no
 * dirty flag — which is what makes "pick up where I left off" true. The cost
 * of that is that an edit overwrites the only copy, so this file is the undo:
 * the first change of any day files the plan AS THE DAY BEGAN (see
 * planStore.savePlan, which is the only caller of `recordDayStart`), and a
 * week of editing leaves a week of restore points rather than one plan and no
 * memory.
 *
 * ONE ENTRY PER DAY, deliberately. Per-edit history would file dozens of
 * near-identical copies an hour — the autosave fires on every committed field —
 * and a list nobody can read is not a history. A day is the unit the user
 * actually thinks in ("what did this look like before I started messing with
 * it on Tuesday"), and it makes every entry a decision rather than a keystroke.
 *
 * WHAT IS NOT HERE: any notion of a "current" or "designated" version. There is
 * one plan (plan.json) and this is where its past lives; restoring copies an
 * entry forward onto the plan and appends going forward, so a restore is itself
 * undoable and no entry is ever consumed, reordered or rewritten.
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../shared/sha256';
import type { PlanHistoryEntry, PlanScore, Scenario } from '../shared/types';
import { planIdentityKey } from '../shared/planIdentity';
import { planHistoryFileSchema, parseOrThrow } from '../shared/schemas';
import {
  NotFoundError,
  ValidationError,
  describeDataFile,
  readJsonFile,
  writeJsonPretty,
} from './dataStore';

function historyPath(): string {
  return 'plan-history.json';
}

/**
 * A plan's fingerprint: sha256 over its IDENTITY (name and description
 * excluded — shared/planIdentity.ts), which is a stable stringification, so
 * two plans that differ only in key order hash identically and a recorded
 * score's `planHash` means "this exact plan" on any machine.
 */
export function planHash(plan: Scenario): string {
  return sha256Hex(planIdentityKey(plan));
}

/**
 * THE LOCAL CALENDAR DAY, as "YYYY-MM-DD" — the same day the pages render.
 *
 * Local, not UTC, and the server may say so: it binds to 127.0.0.1 only
 * (server.ts), so the process and the browser are the same machine in the same
 * zone, and every date on screen is already formatted in it
 * (netWorthChart.formatSnapshotDate passes no timeZone). A UTC key would put
 * the user in Eastern time into "tomorrow" from 8pm: an evening session would
 * file a second day-start entry mid-sitting, and the row would render a date
 * one day ahead of the guard that wrote it.
 */
export function localDayKey(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * Every write to plan-history.json goes through here, one at a time.
 *
 * The file is read-modify-written whole, and it has writers that overlap: the
 * daily guard on the plan's save path, an explicit keep, and a score arriving
 * from a simulation that started minutes earlier. Interleave them and the
 * loser's work is gone — and what would be lost is a version of the plan that
 * no longer exists anywhere else. The guard's check ("does today already have
 * a restore point?") lives INSIDE the same closure as the append for the same
 * reason: the check contains an await, so two concurrent first-edits could
 * both read "no entry today" and both file one.
 *
 * A rejected link must not break the chain: the next writer runs either way.
 */
let writes: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Every entry, OLDEST FIRST, as the file stores them. A missing file is an
 * empty history (a data folder that has never been edited has no past); a file
 * that exists but is malformed fails loudly with its filename, like every data
 * file here.
 */
async function readEntries(): Promise<PlanHistoryEntry[]> {
  const filePath = historyPath();
  let raw: unknown;
  try {
    raw = await readJsonFile(filePath);
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    throw err;
  }
  let parsed: PlanHistoryEntry[];
  try {
    parsed = parseOrThrow(planHistoryFileSchema, raw, `plan history (${describeDataFile(filePath)})`);
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
  // Sorted on read rather than trusted on disk: a hand-edited file must not
  // make the History tab claim Tuesday came after Thursday.
  return [...parsed].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

/**
 * The history as the page reads it: NEWEST FIRST. The most recent version of
 * the plan is the one most likely to be restored, so it is the one that does
 * not need scrolling to.
 */
export async function listPlanHistory(): Promise<PlanHistoryEntry[]> {
  return (await readEntries()).reverse();
}

/** One entry by id. Unknown ids are a 404, not an empty answer. */
export async function getPlanHistoryEntry(id: string): Promise<PlanHistoryEntry> {
  const entry = (await readEntries()).find((e) => e.id === id);
  if (!entry) throw new NotFoundError(`Unknown plan version "${id}"`);
  return entry;
}

function newEntry(input: {
  plan: Scenario;
  kind: PlanHistoryEntry['kind'];
  takenAt: Date;
  label?: string;
}): PlanHistoryEntry {
  return {
    id: `ph-${input.takenAt.getTime().toString(36)}-${randomBytes(3).toString('hex')}`,
    takenAt: input.takenAt.toISOString(),
    kind: input.kind,
    plan: input.plan,
    planHash: planHash(input.plan),
    ...(input.label !== undefined && input.label.trim() !== ''
      ? { label: input.label.trim() }
      : {}),
  };
}

/**
 * THE DAILY GUARD, called with the plan AS IT STANDS BEFORE a change is
 * written. Files it if today has no restore point yet; returns null if it has.
 *
 * Only a 'day-start' entry counts. A 'kept' entry is an explicit act — a
 * search finalist put somewhere safe — and letting one satisfy the day would
 * mean that keeping a finalist in the morning silently threw away the undo for
 * everything edited afterwards.
 */
export async function recordDayStart(
  plan: Scenario,
  now: Date,
): Promise<PlanHistoryEntry | null> {
  return serialized(async () => {
    const all = await readEntries();
    const today = localDayKey(now);
    const covered = all.some(
      (e) => e.kind === 'day-start' && localDayKey(new Date(e.takenAt)) === today,
    );
    if (covered) return null;
    const entry = newEntry({ plan, kind: 'day-start', takenAt: now });
    all.push(entry);
    await writeJsonPretty(historyPath(), all);
    return entry;
  });
}

/**
 * File a plan WITHOUT making it the plan — "keep this one".
 *
 * This is where a search finalist goes: a twenty-minute search produces six
 * plans worth remembering, and only one of them can be the plan. Keeping one
 * never touches plan.json, so the workbench is exactly where it was.
 */
export async function keepPlan(
  plan: Scenario,
  label?: string,
  // The same injectable clock recordDayStart and restorePlan take, and for the
  // same reason: a test that has to file a 'kept' entry alongside a pinned
  // day-start cannot pin the order otherwise. It read the real clock until the
  // afternoon of 2026-08-20, when planStore's "a kept plan does not stand in
  // for the day's restore point" flipped from ['day-start','kept'] to the
  // reverse — a test that had been passing only because it was written before
  // 8:30am.
  now: Date = new Date(),
): Promise<PlanHistoryEntry> {
  const entry = newEntry({ plan, kind: 'kept', takenAt: now, ...(label ? { label } : {}) });
  return serialized(async () => {
    const all = await readEntries();
    all.push(entry);
    await writeJsonPretty(historyPath(), all);
    return entry;
  });
}

/**
 * What a write of a scoring outcome did. Three answers, because "it did not
 * land" has two causes that mean opposite things, and a boolean would let a
 * caller report the wrong one.
 */
export type PlanHistoryScoreWrite =
  /** The outcome is on the entry. */
  | 'attached'
  /** No entry with that id. Lands from a background task nobody is watching. */
  | 'entry_gone'
  /** The entry already carries a score, and a recorded number is not rewritten. */
  | 'already_scored';

/**
 * Attach the outcome of a scoring attempt to one entry: a score, or the reason
 * there is none. The only edit an entry invites, and it touches nothing but
 * the two score fields — `plan`, `takenAt` and `planHash` are what the entry IS.
 *
 * A RECORDED SCORE IS FINAL. This writes into a blank and never over a number:
 * an entry that already carries a score is refused, and the caller is told
 * which of the two "nothing happened" answers it got. An entry IS a record of a
 * moment — this plan, measured on that day against that day's balances and
 * prices — so a second number filed on the same row would make one row report
 * two different moments as if they were one. (The user's words for the button
 * that used to do it: "Score it again undermines take a snapshot".)
 *
 * A FAILURE IS STILL A BLANK, so `scoreError` may be replaced: "we tried and it
 * failed" records no measurement, and the entry has never been measured. A
 * success arriving over one CLEARS it, because a version carrying both a number
 * and a complaint about not having one gives the reader no way to tell which is
 * current.
 */
export async function attachPlanHistoryScore(
  id: string,
  outcome: { score: PlanScore } | { error: string },
): Promise<PlanHistoryScoreWrite> {
  return serialized(async () => {
    const all = await readEntries();
    const index = all.findIndex((e) => e.id === id);
    if (index < 0) return 'entry_gone';
    if (all[index].score !== undefined) return 'already_scored';
    const { score: _score, scoreError: _error, ...entry } = all[index];
    all[index] =
      'score' in outcome ? { ...entry, score: outcome.score } : { ...entry, scoreError: outcome.error };
    await writeJsonPretty(historyPath(), all);
    return 'attached';
  });
}

/**
 * Merge a sustainable-spend outcome into a version's EXISTING score.
 *
 * A second write rather than a bigger first one, for the reason
 * networthStore.attachSustainableSpend gives: the success number is one run and
 * the spend is a bisection of a dozen, so holding the cheap half back until the
 * expensive one lands would let one failure lose both. A version with no score
 * has nowhere to put this and gets `false`.
 *
 * A RECORDED FIGURE IS FINAL, same rule as the score above it: a version that
 * already has a spend figure is refused rather than re-solved. Unreachable
 * today — the only caller runs this once, on a score it has just written — but
 * this is the function that would do the overwriting, so this is where the rule
 * has to be true. A recorded `sustainableSpendError` is NOT a figure and may be
 * replaced: it says nothing was measured.
 *
 * WHAT THIS DELIBERATELY DOES NOT GUARD, and why it does not have to: an EMPTY
 * spend field on an OLD score. From here that is a blank and gets filled — and
 * any version saved before scoring existed is exactly such a blank, one that
 * must never be filled today, because a figure solved against today's balances
 * beside a probability solved months ago makes one row report two moments as
 * one. What protects it is reachability, not a test here:
 * `scoreVersion` is the only caller, and it reaches this line only after
 * `attachPlanHistoryScore` returned 'attached' — which a version with a score
 * never does. So the score under any spend figure this writes is one the same
 * run computed seconds earlier. (Pinned in planVersionScore.test.ts, "the run
 * stops at the score".)
 */
export async function attachPlanHistorySpend(
  id: string,
  outcome: { sustainableSpend: number; sustainableSpendPaths: number } | { error: string },
): Promise<boolean> {
  return serialized(async () => {
    const all = await readEntries();
    const index = all.findIndex((e) => e.id === id);
    if (index < 0) return false;
    const entry = all[index];
    if (!entry.score) return false;
    if (entry.score.sustainableSpend !== undefined) return false;
    const {
      sustainableSpend: _spend,
      sustainableSpendPaths: _paths,
      sustainableSpendError: _err,
      ...score
    } = entry.score;
    all[index] = {
      ...entry,
      score:
        'error' in outcome
          ? { ...score, sustainableSpendError: outcome.error }
          : {
              ...score,
              sustainableSpend: outcome.sustainableSpend,
              sustainableSpendPaths: outcome.sustainableSpendPaths,
            },
    };
    await writeJsonPretty(historyPath(), all);
    return true;
  });
}
