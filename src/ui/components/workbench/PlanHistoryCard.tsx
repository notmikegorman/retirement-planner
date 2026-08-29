/**
 * THE HISTORY TAB — every version of the plan there has been, newest first.
 *
 * It replaced a "Saved" tab the user called a hot mess, and the mess was
 * structural rather than cosmetic. That tab held a cabinet of named copies AND
 * a separately frozen "baseline plan", so it had to explain two things it had
 * no room to explain: which copy the workbench was showing, and which entirely
 * different plan the Net Worth page was scoring. The sentence he quoted back —
 * "The plan on screen is not this plan" — was the second concept failing at the
 * first concept's expense. Both are gone. There is one plan, this is its past,
 * and the only relationships left are "this is the one you are looking at" and
 * "press this to go back to it".
 *
 * WHAT A ROW IS FOR: recognising a version worth returning to. That is the
 * owner's own stated purpose, and it is why the score and the median terminal
 * assets are on the row rather than behind a click — with the sustainable spend
 * beside them, because for this household success saturates and dollars are
 * what actually separate two versions.
 *
 * WHY SCORING IS A BUTTON AND NOT AUTOMATIC. A version is filed mid-edit, on
 * the day's first change, and a final-quality run plus a dozen-run bisection
 * fired at that moment would fight the workbench's own live run for the same
 * machine. So a row arrives unscored and says so, and the number is one press
 * away — taken under exactly the conditions every other recorded score was
 * taken under (scoreRunner decides mode, paths and seed once, for everyone).
 *
 * AND WHY THE BUTTON DISAPPEARS ONCE IT IS PRESSED. There was a "Score it
 * again" here. The user's objection to it is the rule the tab now follows:
 * "Score it again undermines take a snapshot" — a row's whole value is that it
 * is a RECORD of a moment, and a button that rewrites a recorded number
 * contradicts the only guarantee the record makes. Filling a blank is allowed;
 * overwriting a fact is not. Which reading gets a button is decided in one
 * place, `scoringOffer`, and the server refuses the rest with a 409 rather than
 * trusting this file to remember.
 *
 * NOTHING HERE EDITS AN ENTRY. Restoring COPIES a stored plan forward onto
 * plan.json; the entry stays where it is, which is what makes a restore of the
 * wrong version cost nothing.
 *
 * (Assembly and every sentence it prints: planHistoryLogic.ts.)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanHistoryEntry, Profile, Scenario } from '../../../shared/types';
import { ENGINE_VERSION } from '../../../shared/types';
import { api } from '../../api';
import { HISTORY_FIRST_RUN, simulationReadiness } from '../../firstRun';
import { useToast } from '../../toast';
import { InfoTip } from '../profile/fields';
import {
  finishOffer,
  historyEmptyNote,
  historyRows,
  restoreOutcome,
  restorePrompt,
  scoringOffer,
  type HistoryRow,
} from './planHistoryLogic';

/**
 * How often the tab asks which versions still have a simulation running.
 *
 * The same interval and the same reasoning as the Net Worth page's poll: a
 * final-quality run is minutes, every poll is one tiny GET to a server on this
 * machine, and the loop STOPS the moment nothing is in flight — a History tab
 * left open with no runs going makes no requests at all.
 */
const SCORING_POLL_MS = 2500;

export interface PlanHistoryCardProps {
  /**
   * The plan on screen — the live draft, not what is on disk. It decides which
   * rows say "this is the plan you are looking at", and the draft is the right
   * source because the autosave is debounced: for 400ms after a keystroke the
   * file still holds the previous plan, and a match computed from the file
   * would flicker onto the wrong row.
   */
  plan: Scenario;
  /** People and accounts for the 72(t) warning; nothing else is read. */
  profile: Profile;
  /** Hand a restored plan back to the workbench, which re-runs against it. */
  onRestored: (plan: Scenario) => void;
}

export function PlanHistoryCard({ plan, profile, onRestored }: PlanHistoryCardProps) {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<PlanHistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * Versions with a run in flight RIGHT NOW, from the server's own memory.
   * Never stored on the entry: a persisted "scoring" flag would survive a
   * server restart the run did not, and be a lie for ever after.
   */
  const [scoring, setScoring] = useState<string[]>([]);
  const scoringRef = useRef<string[]>([]);
  /**
   * Versions whose scoring was INTERRUPTED (a killed tab, a restart) and
   * still verifies completable against today's inputs — the write-ahead
   * intent file's answer (store/scoringIntent.ts). These rows carry the
   * Finish-scoring offer instead of the permanent readings.
   */
  const [interrupted, setInterrupted] = useState<string[]>([]);
  /** Which row is asking "are you sure?" — at most one at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * What the last restore actually did, kept on screen rather than toasted
   * away. A toast is gone in 2.5 seconds and this sentence answers "wait —
   * what happened to what I had?", which is a question asked later than that.
   *
   * `filed` decides how loud it is. A restore that filed the plan it replaced
   * did exactly what the button promised and reads as a plain notice; one that
   * filed nothing — because today's restore point already existed — is the
   * case where the promise does NOT hold, and that is worth amber.
   */
  const [outcome, setOutcome] = useState<{ text: string; filed: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setEntries(await api.planHistory());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    // Separately and non-fatally, like the Net Worth page: the interrupted
    // offer is additive, and a backend without the answer must not take the
    // history down with it.
    try {
      setInterrupted(
        (await api.getScoringIntents()).intents
          .filter((i) => i.kind === 'plan-version')
          .map((i) => i.id),
      );
    } catch {
      // Keep whatever we knew.
    }
  }, []);

  const setScoringIds = useCallback((ids: string[]) => {
    scoringRef.current = ids;
    setScoring(ids);
  }, []);

  /**
   * Ask who is still running, and reload when someone stops.
   *
   * A failed poll is ignored rather than surfaced: it must not clear
   * "scoring…" or stop the loop, because the simulation is still going
   * whatever this GET did. It reloads while a run is still in flight too — a
   * score lands in two parts (the probability first, the spend a dozen runs
   * later) and waiting for the second would hide the first.
   */
  const pollScoring = useCallback(async () => {
    let ids: string[];
    try {
      ids = (await api.planVersionsScoring()).scoring;
    } catch {
      return;
    }
    const landed = scoringRef.current.some((id) => !ids.includes(id));
    setScoringIds(ids);
    if (landed || ids.length > 0) await load();
  }, [load, setScoringIds]);

  useEffect(() => {
    void load();
    // Once on mount: a run started before this tab was opened is still going,
    // and its row should say so rather than looking permanently scoreless.
    void pollScoring();
  }, [load, pollScoring]);

  const idle = scoring.length === 0;
  useEffect(() => {
    if (idle) return;
    const timer = setInterval(() => void pollScoring(), SCORING_POLL_MS);
    return () => clearInterval(timer);
  }, [idle, pollScoring]);

  const score = async (id: string) => {
    setActionError(null);
    setBusy(id);
    try {
      await api.scorePlanVersion(id);
      // Mark it in flight here rather than waiting for the next poll: that is
      // what makes the row say "scoring…" the instant the button is pressed.
      setScoringIds([...scoringRef.current.filter((x) => x !== id), id]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Finish an interrupted version's scoring. The backend re-verifies the
   * intent's runKey before a single path runs — this press is a request, not
   * an override — and whatever lands (the completed figure, or the honest
   * inputs-moved reason) arrives through the ordinary poll like any outcome.
   */
  const finish = async (id: string) => {
    setActionError(null);
    setBusy(id);
    try {
      await api.finishScoring({ kind: 'plan-version', id });
      setInterrupted((prev) => prev.filter((x) => x !== id));
      setScoringIds([...scoringRef.current.filter((x) => x !== id), id]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      // A refusal may mean the intent is already resolved — re-read rather
      // than leave a button that can only refuse again.
      void load();
    } finally {
      setBusy(null);
    }
  };

  const restore = async (row: HistoryRow) => {
    setActionError(null);
    setBusy(row.entry.id);
    const idsBefore = (entries ?? []).map((e) => e.id);
    try {
      const res = await api.restorePlan(row.entry.id);
      // Re-read before speaking: whether the replaced plan was actually filed
      // is a fact about the list, not a promise this page may repeat.
      let after: PlanHistoryEntry[];
      try {
        after = await api.planHistory();
        setEntries(after);
      } catch {
        after = entries ?? [];
      }
      setConfirming(null);
      setOutcome({
        text: restoreOutcome(res.restoredFrom, idsBefore, after, new Date()),
        filed: after.some((e) => !idsBefore.includes(e.id)),
      });
      onRestored(res.plan);
      showToast(`Restored “${res.restoredFrom.label ?? 'an unnamed version'}”`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const rows = historyRows(entries ?? [], {
    currentPlan: plan,
    scoring,
    interrupted,
    engineVersion: ENGINE_VERSION,
    people: profile.people,
    accounts: profile.accounts,
    now: new Date(),
  });

  /**
   * ZERO-START'S GATE (src/ui/firstRun.ts): with zero accounts, no scoring
   * offer renders — pressing one would run a final-quality simulation of a
   * household that does not exist and file the number as a record. Restore
   * stays: copying a stored plan forward simulates nothing.
   */
  const scoringGated = simulationReadiness(profile).state === 'no-accounts';

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        History
        <InfoTip
          label="the plan’s history"
          text={
            'Every version of the plan there has been. The first time you change the plan on ' +
            'any day, the version that day began with is filed here — you never ask for a ' +
            'restore point and cannot forget to. Restoring copies a stored version back onto ' +
            'the plan; the entry itself is never consumed or changed, and neither is a score ' +
            'once one is recorded on it.'
          }
        />
      </h2>

      {loadError !== null && (
        <div className="error-banner">
          {loadError}{' '}
          <button onClick={() => void load()} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      )}
      {actionError !== null && <div className="error-banner">{actionError}</div>}
      {outcome !== null && (
        <div
          className={outcome.filed ? 'hist-outcome' : 'lib-warning warn'}
          role="status"
          style={{ marginBottom: 10 }}
        >
          {outcome.text}
        </div>
      )}

      {entries === null && loadError === null ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted">{historyEmptyNote()}</div>
      ) : (
        rows.map((row) => (
          <HistoryRowView
            key={row.entry.id}
            row={row}
            scoringGated={scoringGated}
            busy={busy === row.entry.id}
            confirming={confirming === row.entry.id}
            onAskRestore={() => {
              setActionError(null);
              setConfirming(row.entry.id);
            }}
            restoreQuestion={restorePrompt(row, entries ?? [], new Date())}
            onCancelRestore={() => setConfirming(null)}
            onRestore={() => void restore(row)}
            onScore={() => void score(row.entry.id)}
            onFinish={() => void finish(row.entry.id)}
          />
        ))
      )}

      {scoringGated && rows.length > 0 ? (
        <div className="field-help" style={{ marginTop: 10 }}>
          {HISTORY_FIRST_RUN}
        </div>
      ) : null}

      <div className="field-help" style={{ marginTop: 10 }}>
        One entry per day of editing, plus anything kept on purpose. Scoring a version runs it at
        final quality on the profile’s own seed — the same conditions every recorded score here
        was taken under, which is what makes two of these numbers comparable at all. It can be
        done once: a score is what this plan measured against one day’s balances and prices, and
        nothing here writes a second number over it. To see what a version would do today,
        restore it — the workbench runs the plan on screen live.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One version
// ---------------------------------------------------------------------------

function HistoryRowView({
  row,
  scoringGated,
  busy,
  confirming,
  restoreQuestion,
  onAskRestore,
  onCancelRestore,
  onRestore,
  onScore,
  onFinish,
}: {
  row: HistoryRow;
  /** Zero-start's gate: no scoring offer of any kind while accounts are empty. */
  scoringGated: boolean;
  busy: boolean;
  confirming: boolean;
  /* Computed by the parent, which is the half of the app that holds the LIST —
     and whether today already has a restore point is a fact about the list, not
     about this row. */
  restoreQuestion: string;
  onAskRestore: () => void;
  onCancelRestore: () => void;
  onRestore: () => void;
  onScore: () => void;
  onFinish: () => void;
}) {
  const { entry, score } = row;
  const offer = scoringOffer(score);
  const finishLabel = finishOffer(score);
  return (
    <div className={row.isCurrent ? 'hist-row is-current' : 'hist-row'}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <strong className={row.named ? undefined : 'muted'}>{row.label}</strong>
        {/* The match indicator. It is a statement about the plan on screen,
            not a selection: more than one entry can hold the identical plan,
            and each of them is equally "the one you are looking at". */}
        {row.isCurrent && <span className="badge">the plan on screen</span>}
        <span className="spacer" />
        <span className="muted" title={entry.takenAt}>
          {row.moment}
          {row.ago === null ? '' : ` · ${row.ago}`}
        </span>
      </div>
      {/* 12, like every other line of small print in the app — this one sat at
          12.5 alone, a half-pixel out of step with the three below it. */}
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {row.why}
      </div>

      <ScoreLine score={score} />

      {row.warnings.map((w) => (
        <div key={w.code} className="lib-warning warn" style={{ marginTop: 6 }}>
          {w.message}
        </div>
      ))}

      {/* THE CONFIRMATION IS THE ROW, not a modal. Restoring replaces what is
          on screen, so the question has to be asked next to the version it is
          about — a dialog in the middle of the window names a row the user
          then has to go back and find. Same two-step idiom the destructive
          buttons elsewhere in the app use. */}
      {confirming ? (
        <div className="hist-confirm" style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>{restoreQuestion}</div>
          <div className="row" style={{ gap: 6 }}>
            <button className="primary" disabled={busy} onClick={onRestore}>
              {busy ? 'Restoring…' : 'Restore it'}
            </button>
            <button disabled={busy} onClick={onCancelRestore}>
              Keep the plan on screen
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button disabled={busy} onClick={onAskRestore}>
            Restore
          </button>
          {/* Only where there is a blank to fill — scoringOffer holds the rule
              and the label, so "which rows get a button" is one testable
              function rather than a chain of ternaries in a view. A version
              that already carries a number gets no button at all. */}
          {!scoringGated && offer !== null && (
            <button disabled={busy} onClick={onScore}>
              {offer}
            </button>
          )}
          {/* Finish scoring — only behind a still-verifying write-ahead
              intent (finishOffer holds the rule and the argument for why this
              is not the removed re-score button back). Gated with the score
              button: an intent that still "verifies" against a profile whose
              accounts have all been deleted would complete a 0-account run. */}
          {!scoringGated && finishLabel !== null && (
            <button className="primary" disabled={busy} onClick={onFinish}>
              {finishLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The numbers, or the single honest reason there are none.
 *
 * A version that has never been scored renders as words, never as a figure.
 * Printing 0% for "nobody has run this yet" would claim the plan fails in
 * every simulated future — the difference between unmeasured and catastrophic
 * is exactly what an optional `score` exists to keep.
 *
 * THE TWO BLANKS ARE DIFFERENT BLANKS and read differently, because the offer
 * beside them is a different offer: "nobody has measured this" invites a first
 * measurement, while "a run was attempted and died" invites a second attempt at
 * the same one. Collapsing both into "no score" would hide a failure worth
 * reading — the reason names what broke.
 */
function ScoreLine({ score }: { score: HistoryRow['score'] }) {
  if (score.state === 'scoring') {
    return (
      <div className="hist-score muted" role="status">
        scoring… (a final-quality run, then the spend solve — minutes, not seconds)
      </div>
    );
  }
  if (score.state === 'interrupted') {
    return (
      <div className="hist-score">
        <span className="flag">interrupted</span>{' '}
        <span className="muted">
          Scoring was cut short before anything landed — the app closed mid-run. Today&rsquo;s
          inputs still produce exactly the run that was in flight, so Finish scoring completes
          the same measurement: a blank being filled, not a number being rewritten.
        </span>
      </div>
    );
  }
  if (score.state === 'never') {
    return (
      <div className="hist-score muted">
        Never scored — nobody has measured this version. Press Score it to find out what it was
        worth.
      </div>
    );
  }
  if (score.state === 'failed') {
    return (
      <div className="hist-score">
        <span className="flag">no score</span>{' '}
        <span className="muted">
          Scoring was attempted and failed, so nothing was measured: {score.reason} Press Try
          scoring again.
        </span>
      </div>
    );
  }
  return (
    <div className="hist-score">
      <div className="chip-list">
        <span className="wb-chip">
          <strong>{score.success}</strong> chance of never running out
        </span>
        {score.median !== null && (
          <span className="wb-chip">
            <strong>{score.median}</strong> median terminal (real)
          </span>
        )}
        {score.spend !== null && (
          <span className="wb-chip">
            <strong>{score.spend}</strong> sustainable living spend
            {score.spendConditions === null ? '' : ` (${score.spendConditions})`}
          </span>
        )}
      </div>
      {/* ABSENT IS NOT ZERO, and the reason is worth the line: an over-funded
          plan clears the top of the solver's range, which is "more than this",
          not "this". */}
      {score.spend === null && score.spendMissing !== null && (
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          No sustainable-spend figure: {score.spendMissing}
        </div>
      )}
      {/* THE LIVE BLANK: the bisection is running right now (the in-flight
          registry says so). This used to fall through to the permanent
          sentence below — the Phase-4 wording quirk — and claim finality
          about a figure that was a dozen runs from landing. */}
      {score.spend === null && score.spendMissing === null && score.spendSolving && (
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }} role="status">
          Solving the spend figure — the probability landed and its bisection is still
          running; the figure lands on this row when it finishes.
        </div>
      )}
      {/* THE INTERRUPTED BLANK: the bisection was cut short, and the
          write-ahead intent still verifies against today's inputs — so this
          one, uniquely, is completable (the Aug-20 shape, with its repair). */}
      {score.spend === null && score.spendMissing === null && score.spendInterrupted && (
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          The spend solve was interrupted — the probability above stands (it was measured),
          and today&rsquo;s inputs still produce exactly the bisection that was cut short.
          Finish scoring completes it: the same measurement, filling the one blank the
          interruption left.
        </div>
      )}
      {/* A PRE-SCORING "Baseline — saved Aug 18" IS THIS ROW: 93.8% and no
          dollars, because the solve did not exist when it was scored. It says
          the figure is absent and permanent, and offers nothing — solving it
          today would put a number measured against today's balances beside a
          probability measured against August 18th's, and one row would then
          report two different days as if they were one.

          IT DOES NOT NAME A CAUSE, and it used to. "Scored before that was
          measured" is true of the August rows and false of a row whose solve
          was interrupted — a server restart between the probability and the
          bisection leaves exactly this shape, and "Baseline — frozen Aug 20"
          became one on the afternoon this rule shipped. The entry stores no way
          to tell the two apart, so the line states what it knows. (A row whose
          interruption IS known — a still-verifying intent — renders the
          completable sentence above instead of this one.) */}
      {score.spend === null &&
        score.spendMissing === null &&
        !score.spendSolving &&
        !score.spendInterrupted && (
        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
          No sustainable-spend figure — none was solved alongside this score, and none can be
          added now: a figure solved today would belong to today, not to the day this score was
          taken.
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
        {score.conditions}
      </div>
    </div>
  );
}
