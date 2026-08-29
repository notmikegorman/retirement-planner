/**
 * THE HISTORY TAB — every version of the plan there has been, newest first,
 * as a SCANNABLE LEDGER.
 *
 * It replaced a "Saved" tab the user called a hot mess, and then it earned a
 * complaint of its own (2026-08-29): "this history tab is just walls and
 * walls of text. I find it confusing and overwhelming." His screenshot showed
 * the specific walls: five-line entries; the engine-version warning repeated
 * VERBATIM as a full amber paragraph on every older entry; three entries
 * simultaneously badged "the plan on screen" (genuinely identical plans —
 * but three duplicate badges is the wall-of-text problem in miniature);
 * "Unnamed version" standing where a name should be; and the never-scored
 * explainer as standing prose on every unscored row.
 *
 * THE LEDGER RULE: one compact row per plan, everything else one click deep.
 * A row is the facts that tell versions apart — when (the date IS the name
 * when no label exists), why it exists (a two-word kind tag), what it scored
 * (compact chips), and the buttons. The provenance (paths/seed/engine/
 * scoredAt), the full never-scored and interrupted sentences, the restore-
 * consequence warnings, and a group's individual filings all live in an
 * expandable detail the row opens on click. COMPRESSION, NOT DELETION —
 * every fact the old tab printed is still reachable, carrying its condition.
 *
 * IDENTICAL PLANS GROUP (planHistoryLogic.groupHistoryRows): filings whose
 * planIdentityKey matches collapse into one visible row with a muted "also
 * filed …" line; the badge therefore lands on at most one visible row, and
 * the engine-version notice renders ONCE, above the first affected row, with
 * a small marker on affected rows (engineNotice / engineNoticeIndex).
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
 * wrong version cost nothing. Grouped filings hold identical plans, so
 * restoring any member writes the same bytes — but each filing keeps its own
 * Restore (and its own scoring blank), because each is its own record.
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
  engineNotice,
  engineNoticeIndex,
  finishOffer,
  groupHasOlderEngine,
  groupHistoryRows,
  historyEmptyNote,
  historyRows,
  kindTag,
  restoreOutcome,
  restorePrompt,
  rowTitle,
  scoringOffer,
  type HistoryGroup,
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
   * Which ledger rows are OPEN — by the face entry's id, several at once:
   * comparing two versions' provenance is exactly what the detail is for,
   * and closing one to open another would forbid the comparison.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
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
  const groups = groupHistoryRows(rows);
  /** Where the ONE engine-version note goes; -1 renders none. */
  const noticeAt = engineNoticeIndex(groups, ENGINE_VERSION);

  /**
   * ZERO-START'S GATE (src/ui/firstRun.ts): with zero accounts, no scoring
   * offer renders — pressing one would run a final-quality simulation of a
   * household that does not exist and file the number as a record. Restore
   * stays: copying a stored plan forward simulates nothing.
   */
  const scoringGated = simulationReadiness(profile).state === 'no-accounts';

  /* Computed by the parent, which is the half of the app that holds the LIST —
     and whether today already has a restore point is a fact about the list,
     not about any one row. */
  const questionFor = (row: HistoryRow) => restorePrompt(row, entries ?? [], new Date());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        History
        <InfoTip
          label="the plan’s history"
          text={
            'Every version of the plan there has been. The first time you change the plan on ' +
            'any day, the version that day began with is filed here — you never ask for a ' +
            'restore point and cannot forget to. Click a row for its full record: when it was ' +
            'filed, the conditions behind its numbers, and what restoring it would change. ' +
            'Restoring copies a stored version back onto the plan; the entry itself is never ' +
            'consumed or changed, and neither is a score once one is recorded on it.'
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
      ) : groups.length === 0 ? (
        <div className="muted">{historyEmptyNote()}</div>
      ) : (
        groups.map((group, i) => (
          <div key={group.primary.entry.id}>
            {i === noticeAt && (
              <div className="lib-warning warn hist-notice" role="note">
                {engineNotice(ENGINE_VERSION)}
              </div>
            )}
            <HistoryGroupView
              group={group}
              scoringGated={scoringGated}
              expanded={expanded.has(group.primary.entry.id)}
              onToggle={() => toggle(group.primary.entry.id)}
              busyId={busy}
              confirmingId={confirming}
              questionFor={questionFor}
              onAskRestore={(row) => {
                setActionError(null);
                setConfirming(row.entry.id);
              }}
              onCancelRestore={() => setConfirming(null)}
              onRestore={(row) => void restore(row)}
              onScore={(id) => void score(id)}
              onFinish={(id) => void finish(id)}
            />
          </div>
        ))
      )}

      {scoringGated && groups.length > 0 ? (
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
// One ledger row: a plan, however many times it was filed
// ---------------------------------------------------------------------------

interface RowCallbacks {
  /** Zero-start's gate: no scoring offer of any kind while accounts are empty. */
  scoringGated: boolean;
  busyId: string | null;
  confirmingId: string | null;
  questionFor: (row: HistoryRow) => string;
  onAskRestore: (row: HistoryRow) => void;
  onCancelRestore: () => void;
  onRestore: (row: HistoryRow) => void;
  onScore: (id: string) => void;
  onFinish: (id: string) => void;
}

function HistoryGroupView({
  group,
  expanded,
  onToggle,
  ...cb
}: {
  group: HistoryGroup;
  expanded: boolean;
  onToggle: () => void;
} & RowCallbacks) {
  const row = group.primary;
  const olderEngine = groupHasOlderEngine(group, ENGINE_VERSION);
  return (
    <div className={row.isCurrent ? 'hist-row is-current' : 'hist-row'}>
      {/* THE HEAD IS THE DISCLOSURE — the whole title line opens the detail,
          because "click the row" is the redesign's contract. The action
          buttons live OUTSIDE it (the score line below), so a real <button>
          never nests inside this button-role line. */}
      <div
        className="row hist-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        {/* The title: the owner's label, or the moment standing in as the
            name — "Unnamed version" named nothing and is gone (rowTitle). */}
        <strong>{rowTitle(row)}</strong>
        <span className="hist-kind">{kindTag(row.entry.kind)}</span>
        {/* The match indicator. Grouping is what makes "at most one visible
            row" true structurally: identity decides the groups AND the match,
            so the plan on screen matches at most one group. */}
        {row.isCurrent && <span className="badge">the plan on screen</span>}
        {olderEngine && (
          <span
            className="hist-marker"
            title="A score in this row was taken by an older engine — open the row for what that means."
          >
            older engine
          </span>
        )}
        {row.named && (
          <span className="muted" style={{ fontSize: 12 }} title={row.entry.takenAt}>
            {row.moment}
          </span>
        )}
        <span className="spacer" />
        <span className="hist-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      <div className="row hist-scoreline">
        <div className="hist-score">
          <ScoreChips score={row.score} />
        </div>
        <span className="spacer" />
        <RowActions row={row} {...cb} />
      </div>

      {group.alsoFiled !== null && <div className="muted hist-also">{group.alsoFiled}</div>}

      {expanded && <RowDetail group={group} {...cb} />}

      <RestoreConfirm row={row} {...cb} />
    </div>
  );
}

/**
 * The row's buttons — compact, and decided elsewhere: which rows get a
 * scoring button is `scoringOffer`'s one testable rule, which get Finish is
 * `finishOffer`'s, and this component only renders their answers. Rendered
 * for the group's face AND for each filing inside the expansion, because
 * every filing is its own record with its own blank to fill.
 */
function RowActions({
  row,
  scoringGated,
  busyId,
  onAskRestore,
  onScore,
  onFinish,
}: { row: HistoryRow } & RowCallbacks) {
  const { score } = row;
  const busy = busyId === row.entry.id;
  const offer = scoringOffer(score);
  const finishLabel = finishOffer(score);
  return (
    <span className="hist-actions">
      <button disabled={busy} onClick={() => onAskRestore(row)}>
        Restore
      </button>
      {/* Only where there is a blank to fill — scoringOffer holds the rule
          and the label. A version that already carries a number gets no
          button at all. */}
      {!scoringGated && offer !== null && (
        <button disabled={busy} onClick={() => onScore(row.entry.id)}>
          {offer}
        </button>
      )}
      {/* Finish scoring — only behind a still-verifying write-ahead intent
          (finishOffer holds the rule and the argument for why this is not the
          removed re-score button back). Gated with the score button: an
          intent that still "verifies" against a profile whose accounts have
          all been deleted would complete a 0-account run. */}
      {!scoringGated && finishLabel !== null && (
        <button className="primary" disabled={busy} onClick={() => onFinish(row.entry.id)}>
          {finishLabel}
        </button>
      )}
    </span>
  );
}

/**
 * THE CONFIRMATION IS THE ROW, not a modal. Restoring replaces what is on
 * screen, so the question has to be asked next to the version it is about —
 * a dialog in the middle of the window names a row the user then has to go
 * back and find. Same two-step idiom the destructive buttons elsewhere use.
 */
function RestoreConfirm({
  row,
  busyId,
  confirmingId,
  questionFor,
  onCancelRestore,
  onRestore,
}: { row: HistoryRow } & RowCallbacks) {
  const confirming = confirmingId === row.entry.id;
  const busy = busyId === row.entry.id;
  if (!confirming) return null;
  return (
    <div className="hist-confirm" style={{ marginTop: 8 }}>
      <div style={{ marginBottom: 6 }}>{questionFor(row)}</div>
      <div className="row" style={{ gap: 6 }}>
        <button className="primary" disabled={busy} onClick={() => onRestore(row)}>
          {busy ? 'Restoring…' : 'Restore it'}
        </button>
        <button disabled={busy} onClick={onCancelRestore}>
          Keep the plan on screen
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The numbers at row width, and the full record one click deep
// ---------------------------------------------------------------------------

/**
 * The compact reading: chips when scored, a short phrase otherwise. The FULL
 * sentence for every state — why a blank is a blank, what an interruption
 * means, the conditions behind each figure — lives in ScoreDetail, inside
 * the expansion; this line only has to be recognisable.
 *
 * A version that has never been scored still renders as words, never as a
 * figure. Printing 0% for "nobody has run this yet" would claim the plan
 * fails in every simulated future — the difference between unmeasured and
 * catastrophic is exactly what an optional `score` exists to keep.
 */
function ScoreChips({ score }: { score: HistoryRow['score'] }) {
  if (score.state === 'scoring') {
    return (
      <span className="muted" role="status">
        scoring…
      </span>
    );
  }
  if (score.state === 'interrupted') {
    return (
      <>
        <span className="flag">interrupted</span>{' '}
        <span className="muted">finishable — open the row for what happened</span>
      </>
    );
  }
  if (score.state === 'never') {
    return <span className="muted">never scored</span>;
  }
  if (score.state === 'failed') {
    return (
      <>
        <span className="flag">no score</span>{' '}
        <span className="muted">the run failed — open the row for why</span>
      </>
    );
  }
  return (
    <span className="chip-list">
      <span className="wb-chip">
        <strong>{score.success}</strong> success
      </span>
      {score.median !== null && (
        <span className="wb-chip">
          <strong>{score.median}</strong> median
        </span>
      )}
      {score.spend !== null && (
        <span className="wb-chip">
          <strong>{score.spend}</strong> spend
        </span>
      )}
      {/* THE LIVE BLANK, said live: the bisection is running right now. */}
      {score.spend === null && score.spendSolving && (
        <span className="muted" role="status">
          solving spend…
        </span>
      )}
    </span>
  );
}

/**
 * The full reading — every sentence the compact line compressed away, with
 * each number's own conditions beside it (paths, seed, engine, the moment).
 *
 * THE TWO BLANKS ARE DIFFERENT BLANKS and read differently, because the offer
 * beside them is a different offer: "nobody has measured this" invites a first
 * measurement, while "a run was attempted and died" invites a second attempt at
 * the same one. Collapsing both into "no score" would hide a failure worth
 * reading — the reason names what broke.
 */
function ScoreDetail({ score }: { score: HistoryRow['score'] }) {
  if (score.state === 'scoring') {
    return (
      <div className="muted" role="status">
        scoring… (a final-quality run, then the spend solve — minutes, not seconds)
      </div>
    );
  }
  if (score.state === 'interrupted') {
    return (
      <div className="muted">
        Scoring was cut short before anything landed — the app closed mid-run. Today&rsquo;s
        inputs still produce exactly the run that was in flight, so Finish scoring completes
        the same measurement: a blank being filled, not a number being rewritten.
      </div>
    );
  }
  if (score.state === 'never') {
    return (
      <div className="muted">
        Never scored — nobody has measured this version. Press Score it to find out what it was
        worth.
      </div>
    );
  }
  if (score.state === 'failed') {
    return (
      <div className="muted">
        Scoring was attempted and failed, so nothing was measured: {score.reason} Press Try
        scoring again.
      </div>
    );
  }
  return (
    <div className="hist-detail-score">
      <div>
        {score.success} chance of never running out
        {score.median !== null ? ` · ${score.median} median terminal (real)` : ''}
      </div>
      {score.spend !== null && (
        <div>
          {score.spend} sustainable living spend
          {score.spendConditions === null ? '' : ` (${score.spendConditions})`}
        </div>
      )}
      {/* ABSENT IS NOT ZERO, and the reason is worth the line: an over-funded
          plan clears the top of the solver's range, which is "more than this",
          not "this". */}
      {score.spend === null && score.spendMissing !== null && (
        <div className="muted">No sustainable-spend figure: {score.spendMissing}</div>
      )}
      {/* THE LIVE BLANK: the bisection is running right now (the in-flight
          registry says so). The permanent sentence below must not render
          while this is true — it used to (the Phase-4 wording quirk) and
          claimed finality about a figure a dozen runs from landing. */}
      {score.spend === null && score.spendMissing === null && score.spendSolving && (
        <div className="muted" role="status">
          Solving the spend figure — the probability landed and its bisection is still
          running; the figure lands on this row when it finishes.
        </div>
      )}
      {/* THE INTERRUPTED BLANK: the bisection was cut short, and the
          write-ahead intent still verifies against today's inputs — so this
          one, uniquely, is completable (the Aug-20 shape, with its repair). */}
      {score.spend === null && score.spendMissing === null && score.spendInterrupted && (
        <div className="muted">
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
          bisection leaves exactly this shape. The entry stores no way to tell
          the two apart, so the line states what it knows. (A row whose
          interruption IS known — a still-verifying intent — renders the
          completable sentence above instead of this one.) */}
      {score.spend === null &&
        score.spendMissing === null &&
        !score.spendSolving &&
        !score.spendInterrupted && (
        <div className="muted">
          No sustainable-spend figure — none was solved alongside this score, and none can be
          added now: a figure solved today would belong to today, not to the day this score was
          taken.
        </div>
      )}
      <div className="muted">{score.conditions}</div>
    </div>
  );
}

/**
 * The expandable record behind a ledger row: when it was filed and why, the
 * full score reading with its conditions, the restore-consequence warnings
 * (the older-engine sentence lives HERE now, once per affected record,
 * instead of as a standing amber paragraph on every old row) — and, for a
 * group, every other filing of the identical plan as its own sub-record with
 * its own facts and its own buttons.
 */
function RowDetail({ group, ...cb }: { group: HistoryGroup } & RowCallbacks) {
  const row = group.primary;
  return (
    <div className="hist-detail">
      <div className="muted">
        Filed {row.moment}
        {row.ago === null ? '' : ` · ${row.ago}`} — {row.why}.
      </div>
      <ScoreDetail score={row.score} />
      {row.warnings.map((w) => (
        <div key={w.code} className="lib-warning warn" style={{ marginTop: 6 }}>
          {w.message}
        </div>
      ))}
      {group.others.length > 0 && (
        <div className="hist-records">
          <div className="muted">
            The identical plan, filed {group.others.length + 1} times — each filing is its own
            record:
          </div>
          {group.others.map((o) => (
            <SubRecord key={o.entry.id} row={o} {...cb} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One of a group's OTHER filings, whole: identical plan, distinct record —
 * its own moment, its own score (or blank, with its own offer), its own
 * warnings, its own Restore. Restoring any filing of a group writes the same
 * plan bytes; scoring fills only THIS record's blank.
 */
function SubRecord({ row, ...cb }: { row: HistoryRow } & RowCallbacks) {
  return (
    <div className="hist-subrow">
      <div className="row" style={{ gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span title={row.entry.takenAt}>{rowTitle(row)}</span>
        <span className="hist-kind">{kindTag(row.entry.kind)}</span>
        <div className="hist-score">
          <ScoreChips score={row.score} />
        </div>
        <span className="spacer" />
        <RowActions row={row} {...cb} />
      </div>
      <ScoreDetail score={row.score} />
      {row.warnings.map((w) => (
        <div key={w.code} className="lib-warning warn" style={{ marginTop: 6 }}>
          {w.message}
        </div>
      ))}
      <RestoreConfirm row={row} {...cb} />
    </div>
  );
}
