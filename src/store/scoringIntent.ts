/**
 * THE WRITE-AHEAD SCORING INTENT: the file that makes an interrupted scoring
 * run RECOVERABLE instead of silently permanent.
 *
 * THE INCIDENT THIS CLOSES. On Aug 20 a server restart landed between the two
 * halves of a scoring run — the probability had attached, the sustainable-
 * spend bisection had not — and the record permanently lost its spend figure:
 * nothing on disk said a solve had been in flight, so the reopened app could
 * only read the row as "no figure, and none can be added" (the immutability
 * rules forbid solving it on a later day, and rightly — a figure computed
 * later would belong to the later day). The record was honest and blank
 * FOREVER, when for a window it was provably completable. In the browser the
 * tab IS the process, so without this file that class of loss would stop
 * being a rare restart and become every accidental tab close.
 *
 * WHAT THE FILE HOLDS: for every scoring run in flight, {which record, which
 * phase, the runKey that phase's run will compute, when it started} — written
 * through the guarded store path BEFORE the run starts (scoreRunner records
 * it inside the same step that starts the run), updated at the phase boundary
 * (probability landed, bisection starting), and cleared when both attaches
 * complete or a failure is recorded. In a finished session the file is GONE —
 * the dual-stack gate asserts its absence from finished trees, which is
 * stronger than excluding it from the byte comparison.
 *
 * WHAT AN ORPHANED INTENT MEANS ON BOOT, and the whole honesty argument: the
 * runKey covers the resolved profile (today's quotes), the assumptions, the
 * plan, the mode, the paths, the seed and the engine version. So:
 *
 *  - If the intent's runKey still equals the key computed from TODAY'S inputs,
 *    the interrupted measurement is still THE SAME measurement — same plan,
 *    same prices — and completing it fills a blank under the immutability
 *    rules rather than rewriting anything (the run cache may even hold the
 *    finished result, making the completion free). Per decision D4 this is
 *    offered as a one-click Finish-scoring button, never done silently.
 *  - If the runKey no longer matches, the world has moved, and finishing
 *    would be dishonest: a figure computed now would belong to now. The
 *    record is stamped with the reason (permanently unmeasured for the
 *    missing half) and the intent clears.
 *
 * Every outcome is explicit; no fourth state exists. The healer runs at boot
 * in BOTH backends — this module lives in the shared core precisely so the
 * node server and the browser tab heal identically, byte for byte.
 */
import type {
  InterruptedScoring,
  PlanHistoryEntry,
  ScoringPhase,
  ScoringTargetKind,
} from '../shared/types';
import { parseOrThrow, scoringIntentFileSchema } from '../shared/schemas';
import { NotFoundError, type DataStore } from './dataStore';
import type { NetworthStore } from './networthStore';
import type { PlanHistoryStore } from './planHistoryStore';
import type { PlanStore } from './planStore';
import { message, type ScoreRunner } from './scoreRunner';

/** Where the intents live, relative to the data folder root. */
export const SCORING_INTENT_FILE = '.scoring-intent.json';

/** One recorded intent: the wire view plus the runKey the run will compute. */
export interface ScoringIntent extends InterruptedScoring {
  runKey: string;
}

export interface ScoringIntentTarget {
  kind: ScoringTargetKind;
  id: string;
}

export interface ScoringIntentStore {
  /** Every intent on file, in file order. An absent or torn file is empty. */
  list(): Promise<ScoringIntent[]>;
  /** Write one intent, replacing any existing intent for the same record. */
  record(intent: ScoringIntent): Promise<void>;
  /** Remove the target's intent; the file itself is deleted when none remain. */
  clear(target: ScoringIntentTarget): Promise<void>;
}

/**
 * The intent store: one small file, read-modify-written whole through its own
 * serialized chain (two scorers can be in flight at once — a snapshot and a
 * plan version — and an interleaved read-modify-write would drop one's
 * intent, which is the exact loss class this file exists to prevent).
 *
 * A file that EXISTS but cannot be parsed is treated as empty and deleted:
 * the node driver's writeText is not atomic, so a crash mid-write can leave
 * torn JSON, and a torn intent cannot name what was in flight. The rows it
 * would have named stay scoreless with the standard permanent wording —
 * exactly the pre-intent behaviour, never worse. (The browser driver's writes
 * are atomic swap-and-rename, so this branch is a node-side story.)
 */
export function createScoringIntentStore(
  data: DataStore,
  onLog: (m: string) => void = (m) => console.error(m),
): ScoringIntentStore {
  let writes: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = writes.then(work, work);
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function readIntents(): Promise<ScoringIntent[]> {
    if (!(await data.pathExists(SCORING_INTENT_FILE))) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(await data.files.readText(SCORING_INTENT_FILE));
      return parseOrThrow(
        scoringIntentFileSchema,
        raw,
        `scoring intents (${data.describeDataFile(SCORING_INTENT_FILE)})`,
      );
    } catch (err) {
      onLog(
        `Discarding an unreadable ${data.describeDataFile(SCORING_INTENT_FILE)} (a torn ` +
          `write cannot name what was in flight): ${message(err)}`,
      );
      await data.files.deleteFile(SCORING_INTENT_FILE).catch(() => undefined);
      return [];
    }
  }

  async function writeIntents(intents: ScoringIntent[]): Promise<void> {
    if (intents.length === 0) {
      await data.files.deleteFile(SCORING_INTENT_FILE).catch(() => undefined);
      return;
    }
    await data.writeJsonPretty(SCORING_INTENT_FILE, intents);
  }

  return {
    list: () => serialized(readIntents),
    record: (intent) =>
      serialized(async () => {
        const rest = (await readIntents()).filter(
          (i) => !(i.kind === intent.kind && i.id === intent.id),
        );
        await writeIntents([...rest, intent]);
      }),
    clear: (target) =>
      serialized(async () => {
        const all = await readIntents();
        const rest = all.filter((i) => !(i.kind === target.kind && i.id === target.id));
        if (rest.length !== all.length) await writeIntents(rest);
      }),
  };
}

// ---------------------------------------------------------------------------
// The reason sentences — shared, so both backends stamp identical bytes
// ---------------------------------------------------------------------------

/**
 * What the record carries when finishing an interrupted run would be
 * dishonest. One sentence per phase, because the two halves leave different
 * things standing: an interrupted 'score' phase measured nothing at all,
 * while an interrupted 'spend' phase leaves a real probability on the record
 * and only the dollars missing.
 */
export function inputsMovedReason(phase: ScoringPhase): string {
  return phase === 'score'
    ? 'The scoring run was interrupted before its number landed, and the inputs have since ' +
        'changed — today’s plan, prices or assumptions no longer produce the run that was ' +
        'in flight, so a figure computed now would belong to now, not to the moment this ' +
        'record measures.'
    : 'The sustainable-spend solve was interrupted before its figure landed, and the inputs ' +
        'have since changed — the probability above stands (it was measured), but a spend ' +
        'figure solved now would belong to now, not to the moment the probability measures.';
}

// ---------------------------------------------------------------------------
// Boot healing
// ---------------------------------------------------------------------------

export interface HealScoringIntentsDeps {
  intents: ScoringIntentStore;
  networth: NetworthStore;
  planHistory: PlanHistoryStore;
  plan: PlanStore;
  runner: ScoreRunner;
  onLog?: (m: string) => void;
}

/** Is nothing left to finish on this record? (score or failure, spend or reason) */
function snapshotComplete(row: {
  score?: { sustainableSpend?: number; sustainableSpendError?: string };
  scoreError?: string;
}): boolean {
  if (row.scoreError !== undefined) return true;
  if (row.score === undefined) return false;
  return (
    row.score.sustainableSpend !== undefined || row.score.sustainableSpendError !== undefined
  );
}

/**
 * Resolve every orphaned intent, once, at boot — BEFORE the backend serves
 * anything, so no page ever reads a row whose fate is still being decided.
 *
 * Per intent, exactly one of:
 *  - target gone, or already complete   → the intent clears (nothing to do);
 *  - runKey verifies identical          → the intent STAYS, and the record
 *    shows Interrupted with the Finish-scoring offer (decision D4: a button,
 *    never an automatic completion);
 *  - runKey verifies moved              → the missing half is stamped with
 *    inputsMovedReason() and the intent clears;
 *  - verification itself failed (an unreadable file, a driver error) → the
 *    intent is LEFT for the next boot, logged. A transient failure must not
 *    stamp a permanent reason.
 */
export async function healScoringIntents(d: HealScoringIntentsDeps): Promise<void> {
  const log = d.onLog ?? ((m: string) => console.error(m));
  for (const intent of await d.intents.list()) {
    try {
      await healOne(d, intent);
    } catch (err) {
      log(
        `Scoring intent for ${intent.kind} "${intent.id}" could not be resolved this boot ` +
          `(left in place for the next one): ${message(err)}`,
      );
    }
  }
}

async function healOne(d: HealScoringIntentsDeps, intent: ScoringIntent): Promise<void> {
  const target: ScoringIntentTarget = { kind: intent.kind, id: intent.id };

  if (intent.kind === 'snapshot') {
    const row = (await d.networth.listSnapshots()).find((s) => s.id === intent.id);
    if (!row) return d.intents.clear(target);
    if (snapshotComplete(row)) return d.intents.clear(target);
    const verdict = await d.runner.verifyIntent(await d.plan.loadPlan(), intent);
    if (verdict === 'identical') return; // completable — the page offers Finish scoring
    if (row.score === undefined) {
      await d.networth.attachScore(intent.id, { error: inputsMovedReason('score') });
    } else {
      await d.networth.attachSustainableSpend(intent.id, {
        error: inputsMovedReason('spend'),
      });
    }
    return d.intents.clear(target);
  }

  let entry: PlanHistoryEntry;
  try {
    entry = await d.planHistory.getPlanHistoryEntry(intent.id);
  } catch (err) {
    if (err instanceof NotFoundError) return d.intents.clear(target);
    throw err;
  }
  if (snapshotComplete(entry)) return d.intents.clear(target);
  const verdict = await d.runner.verifyIntent(entry.plan, intent);
  if (verdict === 'identical') return; // completable — the History tab offers Finish scoring
  if (entry.score === undefined) {
    await d.planHistory.attachPlanHistoryScore(intent.id, {
      error: inputsMovedReason('score'),
    });
  } else {
    await d.planHistory.attachPlanHistorySpend(intent.id, {
      error: inputsMovedReason('spend'),
    });
  }
  return d.intents.clear(target);
}
