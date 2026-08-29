/**
 * Net-worth snapshots (networth.json): an append-only ledger of "what it all
 * added up to when I looked".
 *
 * A snapshot is a RECORD, not a projection, and the design keeps it honest
 * about both of its inputs:
 *  - PRICES: the snapshot flow refreshes quotes for every holdings symbol
 *    first (the one moment besides the Refresh button that the app fetches),
 *    then prices accounts through the SAME resolver every run uses. Each
 *    snapshot stores the prices it used, with their asOf moments, so a row
 *    can always say what it knew.
 *  - THE HOME: the value is the user's own number, typed beside the button.
 *    No feed prices a house; pretending otherwise would put a model where a
 *    judgment belongs.
 *
 * Append-only in behaviour: taking a snapshot never edits an old one, and the
 * only mutation offered is deleting a row the user explicitly points at — plus
 * ATTACHING A SCORE to a row that has none, which is the one edit a row invites
 * (see attachScore, and the snapshot scorer for why it arrives late).
 *
 * ENVIRONMENT-NEUTRAL since Phase 3 of the browser port: a factory over the
 * DataStore, randomness through the shared web-crypto wrapper, chain and
 * guards moved as-is.
 */
import { randomHex } from '../shared/random';
import type { NetWorthSnapshot, SnapshotScore } from '../shared/types';
import { missingQuotesMessage } from '../shared/holdings';
import { netWorthFileSchema, parseOrThrow } from '../shared/schemas';
import { NotFoundError, ValidationError, type DataStore } from './dataStore';

/**
 * Attach the outcome of a scoring attempt to one row: a score, or the reason
 * there is none.
 *
 * The net worth is written the moment the button is pressed and the score
 * lands here whenever the simulation finishes, which is minutes later at
 * 10,000 paths — so this is the ONLY thing that edits an existing row, and it
 * touches nothing but the two score fields.
 *
 * A RECORDED SCORE IS FINAL. This writes into a blank and never over a number.
 * A snapshot is a RECORD — these prices, these balances, this score, on this
 * date — and the row's whole value is that it does not move; a second score
 * filed on it would be a number that was never true of that moment. So a row
 * that already carries a score is refused, and the caller is told which of the
 * two "nothing happened" answers it got.
 *
 * A SUCCESS CLEARS THE PREVIOUS FAILURE. Leaving `scoreError` beside a fresh
 * score would leave the row carrying both a number and a complaint about not
 * having one, and the reader would have no way to tell which was current. A
 * failure records no measurement, so replacing one is filling a blank, not
 * overwriting a fact.
 *
 * A ROW DELETED MID-RUN IS NOT AN ERROR. The user is allowed to delete a
 * snapshot while its simulation is still going; the score then belongs to
 * nothing and is dropped. Throwing here would only surface in a background
 * task nobody is watching, and re-adding the row would resurrect a record its
 * owner deleted on purpose. `'row_gone'` says "there was nowhere to put it".
 */
export type SnapshotScoreWrite =
  /** The outcome is on the row. */
  | 'attached'
  /** No row with that id — deleted while its simulation ran. */
  | 'row_gone'
  /** The row already carries a score, and a recorded number is not rewritten. */
  | 'already_scored';

export interface NetworthStore {
  listSnapshots(): Promise<NetWorthSnapshot[]>;
  takeSnapshot(input: { homeValue: number; note?: string }): Promise<NetWorthSnapshot>;
  deleteSnapshot(id: string): Promise<void>;
  attachScore(
    id: string,
    outcome: { score: SnapshotScore } | { error: string },
  ): Promise<SnapshotScoreWrite>;
  attachSustainableSpend(
    id: string,
    outcome: { sustainableSpend: number; sustainableSpendPaths: number } | { error: string },
  ): Promise<boolean>;
}

export function createNetworthStore(data: DataStore): NetworthStore {
  const networthPath = (): string => 'networth.json';

  /**
   * Every write to networth.json goes through here, one at a time.
   *
   * The file is read-modify-written whole, and it has TWO writers that can
   * overlap: the snapshot button, and a score arriving from a simulation that
   * started minutes earlier. Interleave them and the loser's work is gone —
   * and the row that would be lost is the one thing in this app that cannot
   * be recreated, because it records prices from a moment that has passed. A
   * serial chain costs nothing here (a handful of writes a month) and makes
   * the lost update impossible rather than unlikely.
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
   * All snapshots, oldest first. A missing file is an empty ledger; a
   * malformed one fails loudly with its filename, like every data file here.
   */
  async function listSnapshots(): Promise<NetWorthSnapshot[]> {
    const filePath = networthPath();
    let raw: unknown;
    try {
      raw = await data.readJsonFile(filePath);
    } catch (err) {
      if (err instanceof NotFoundError) return [];
      throw err;
    }
    let parsed: NetWorthSnapshot[];
    try {
      parsed = parseOrThrow(
        netWorthFileSchema,
        raw,
        `net worth ledger (${data.describeDataFile(filePath)})`,
      );
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    // Sorted on read rather than trusted on disk: a hand-edited file must not
    // make the chart's line double back on itself.
    return [...parsed].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  }

  return {
    listSnapshots,

    /**
     * Compute and append one snapshot. The caller has already refreshed quotes
     * (the route owns the network step so THIS stays computable in tests
     * without one); this function prices the profile from whatever is stored
     * now.
     *
     * A holdings symbol with no stored quote is FATAL here, unlike the profile
     * editor: a snapshot silently priced from a stale or absent quote would be
     * a record of nothing, and the ledger is only worth keeping if every row
     * was true when written.
     */
    async takeSnapshot(input: { homeValue: number; note?: string }): Promise<NetWorthSnapshot> {
      const { profile, derived, missing } = await data.loadResolvedProfile();
      if (missing.length > 0) throw new ValidationError(missingQuotesMessage(missing));

      const accounts = profile.accounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance }));
      const portfolio = accounts.reduce((sum, a) => sum + a.balance, 0);

      // Only the prices the derived balances actually used — a symbol quoted
      // but no longer held would stamp the row with a price that priced
      // nothing.
      const prices: NetWorthSnapshot['prices'] = {};
      for (const view of Object.values(derived)) {
        for (const h of view.holdings) {
          if (h.price !== null && h.asOf !== null) prices[h.symbol] = { price: h.price, asOf: h.asOf };
        }
      }

      const snapshot: NetWorthSnapshot = {
        id: `nw-${Date.now().toString(36)}-${randomHex(3)}`,
        takenAt: new Date().toISOString(),
        total: portfolio + input.homeValue,
        homeValue: input.homeValue,
        accounts,
        prices,
        ...(input.note !== undefined && input.note.trim() !== '' ? { note: input.note.trim() } : {}),
      };

      return serialized(async () => {
        const all = await listSnapshots();
        all.push(snapshot);
        await data.writeJsonPretty(networthPath(), all);
        return snapshot;
      });
    },

    async deleteSnapshot(id: string): Promise<void> {
      return serialized(async () => {
        const all = await listSnapshots();
        const next = all.filter((s) => s.id !== id);
        if (next.length === all.length) throw new NotFoundError(`Unknown snapshot "${id}"`);
        await data.writeJsonPretty(networthPath(), next);
      });
    },

    async attachScore(
      id: string,
      outcome: { score: SnapshotScore } | { error: string },
    ): Promise<SnapshotScoreWrite> {
      return serialized(async () => {
        const all = await listSnapshots();
        const index = all.findIndex((s) => s.id === id);
        if (index < 0) return 'row_gone';
        if (all[index].score !== undefined) return 'already_scored';
        const { score: _score, scoreError: _error, ...row } = all[index];
        all[index] =
          'score' in outcome ? { ...row, score: outcome.score } : { ...row, scoreError: outcome.error };
        await data.writeJsonPretty(networthPath(), all);
        return 'attached';
      });
    },

    /**
     * Merge a sustainable-spend outcome into a row's EXISTING score.
     *
     * A SECOND WRITE rather than a bigger first one, because the two halves
     * cost different amounts: the success number is one run, the spend is a
     * bisection of a dozen. Holding the cheap half back until the expensive
     * half lands would mean a crash, a restart or a twenty-minute wedge
     * between them loses both — and the success number is the one the chart
     * is drawn from.
     *
     * A row with no score has nowhere to put this: the score it belonged to is
     * gone (a deleted row), and a spend figure with no probability beside it
     * says nothing on its own. `false` says so without throwing, because this
     * lands from a background task nobody is watching.
     *
     * A RECORDED FIGURE IS FINAL, same rule as the score above it: a row that
     * already has a spend figure is refused rather than re-solved.
     * Unreachable today — the only caller runs this once, on a score it has
     * just written — but this is the function that would do the overwriting,
     * so this is where the rule has to be true. A recorded
     * `sustainableSpendError` is NOT a figure and may be replaced: it says
     * nothing was measured.
     *
     * WHAT IT DELIBERATELY DOES NOT GUARD, and why it does not have to: an
     * EMPTY spend field on an OLD score. From here that is a blank and would
     * be filled — and any pre-scoring row is exactly such a blank, one that
     * must never be filled now, because a figure solved against today's
     * balances beside a probability solved months ago makes one row report
     * two moments as one. Reachability is what protects it: `scoreSnapshot`
     * is the only caller and reaches this line only after `attachScore`
     * returned 'attached', which a row with a score never does. So the score
     * under any figure this writes is one the same run computed seconds
     * earlier.
     */
    async attachSustainableSpend(
      id: string,
      outcome: { sustainableSpend: number; sustainableSpendPaths: number } | { error: string },
    ): Promise<boolean> {
      return serialized(async () => {
        const all = await listSnapshots();
        const index = all.findIndex((s) => s.id === id);
        if (index < 0) return false;
        const row = all[index];
        if (!row.score) return false;
        if (row.score.sustainableSpend !== undefined) return false;
        const {
          sustainableSpend: _spend,
          sustainableSpendPaths: _paths,
          sustainableSpendError: _err,
          ...score
        } = row.score;
        all[index] = {
          ...row,
          score:
            'error' in outcome
              ? { ...score, sustainableSpendError: outcome.error }
              : {
                  ...score,
                  sustainableSpend: outcome.sustainableSpend,
                  sustainableSpendPaths: outcome.sustainableSpendPaths,
                },
        };
        await data.writeJsonPretty(networthPath(), all);
        return true;
      });
    },
  };
}
