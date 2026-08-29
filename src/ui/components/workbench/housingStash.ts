/**
 * HOUSING'S USE OF THE PLAN-BLOCK STASH (src/ui/planBlockStash.ts — the
 * pattern's header carries the incident and the design; this file is the one
 * wired consumer, by the owner's scoping).
 *
 * Two sources, in order, when the Housing tab turns back on:
 *
 *   1. THE STASH — the exact block "Turn off" removed, keyed to this data
 *      folder. The owner's own values, byte for byte, including the fields
 *      whose absence changes numbers (his real insurance quote against the
 *      engine's estimate).
 *   2. THE PLAN'S HISTORY — the newest filed version whose plan carries a
 *      housing block. Slower-moving and folder-resident, so it survives what
 *      localStorage does not (another browser, a cleared origin).
 *
 * Only with NEITHER does the seeded blank form appear, because then blank is
 * the truth. Whichever source restores, a provenance line states where the
 * values came from and when — a restored number carries its condition, the
 * same house rule as every other conditional figure.
 */
import type { HousingPlan, PlanHistoryEntry } from '../../../shared/types';
import { readBlockStash, writeBlockStash, type StashedBlock } from '../../planBlockStash';
import { historyMoment } from './planHistoryLogic';

/** The stash shelf this card owns. */
export const HOUSING_BLOCK = 'housing';

export function stashHousing(folderKey: string, housing: HousingPlan, now: Date): void {
  writeBlockStash(folderKey, HOUSING_BLOCK, housing, now);
}

export function readHousingStash(folderKey: string): StashedBlock<HousingPlan> | null {
  return readBlockStash<HousingPlan>(folderKey, HOUSING_BLOCK);
}

/**
 * The fallback source: the newest filed version whose plan modelled the
 * move. Newest by takenAt, whatever order the list arrived in — the same
 * defensive sort as historyRows, for the same reason.
 */
export function newestHousingVersion(
  entries: readonly PlanHistoryEntry[],
): PlanHistoryEntry | null {
  const withHousing = entries
    .filter((e) => e.plan.housing !== undefined)
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  return withHousing[0] ?? null;
}

// ---------------------------------------------------------------------------
// Provenance — a restored value carries its condition
// ---------------------------------------------------------------------------

/** The stash's line: whose values, from when, and what to do about it. */
export function stashRestoredNote(stashedAt: string): string {
  return (
    `Restored: your housing configuration as it was when you turned it off — ` +
    `${historyMoment(stashedAt)} — review before running.`
  );
}

/** The history fallback's line: which version lent its housing block. */
export function historyRestoredNote(entry: PlanHistoryEntry): string {
  const what =
    entry.kind === 'day-start'
      ? `the ${historyMoment(entry.takenAt)} day-start version`
      : `“${entry.label ?? 'kept'}”, kept ${historyMoment(entry.takenAt)}`;
  return `Restored from history: the housing configuration of ${what} — review before running.`;
}

/**
 * The pre-press sentence on the OFF state, when a stash exists: the button
 * must say it will restore BEFORE it is pressed, or the restore reads as the
 * form inventing values.
 */
export function stashOfferNote(stashedAt: string): string {
  return (
    `Turning this on restores your housing configuration as it was when you turned it off ` +
    `(${historyMoment(stashedAt)}).`
  );
}
