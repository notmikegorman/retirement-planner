/**
 * Pure data-shaping for the Workbench's HISTORY tab — every version of the
 * plan there has been, and what each one scored. No React, no IO.
 *
 * The tab it feeds replaced a cabinet of named, saved copies. The user's
 * complaint about that cabinet was "this is a hot mess" and the specific thing
 * he could not answer from it was the only thing he wanted: WHICH VERSION IS
 * WORTH GOING BACK TO. So a row's job here is to be recognisable at a glance —
 * when it was, what it scored, what it could afford — and every one of those
 * numbers travels with the conditions that make it mean something.
 *
 * THREE RULES, all of them the same rule:
 *
 *  1. ABSENT IS NOT ZERO. A version nobody has scored reads "never scored" and
 *     offers the button that would fix that. It never reads 0%, which would
 *     claim the plan fails in every simulated future — the difference between
 *     "unmeasured" and "catastrophic" is the whole reason `score` is optional.
 *     The mirror of that rule is `scoringOffer` below: a version that HAS a
 *     number is offered nothing, because the only thing a second press could do
 *     is overwrite it.
 *  2. EVERY NUMBER CARRIES ITS OWN CONDITIONS. Paths, seed, engine version and
 *     the moment it was computed sit on the row that shows the number, not in
 *     a legend somewhere. At this engine's noise level a different seed moves
 *     success by more than most of the decisions being compared, and the spend
 *     figure is deliberately solved at fewer paths than the success figure
 *     beside it (scoreRunner.solveSustainableSpend) — so it says so.
 *  3. A WARNING SAYS WHAT IT MEANS FOR RESTORING. The old cabinet's "stale"
 *     badge meant "re-score before ranking". A version's warning has to answer
 *     a different question — what happens if I press Restore — because that is
 *     the button beside it.
 *
 * (Unit tests: tests/ui/planHistoryTab.test.ts.)
 */
import type {
  Account,
  Person,
  PlanHistoryEntry,
  PlanScore,
  Scenario,
} from '../../../shared/types';
import { planIdentityKey } from '../../../shared/planIdentity';
import { formatUSD } from '../../../shared/util';
// The app's one date idiom, imported rather than re-derived: a second copy of
// "Aug 20, 2026" would drift from the net-worth ledger's the first time either
// was touched, and the two lists are read on the same afternoon.
import { formatSnapshotDate } from '../../pages/netWorthChart';
import { autoSeppStatus } from '../scenarios/scenarioHelpers';

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

/**
 * A version's moment: the ledger's date, plus the clock.
 *
 * The date alone is not enough here, unlike on the net-worth page. Only ONE
 * day-start entry exists per day, but an explicit keep can be filed any number
 * of times in an afternoon (a search with six finalists), and three rows all
 * reading "Aug 20, 2026" would be three rows the user cannot tell apart.
 */
export function historyMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${formatSnapshotDate(iso)}, ${time}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "22 minutes ago" — or null once the absolute date says it better.
 *
 * It is an ADDITION to the date, never a replacement: "3 days ago" is how the
 * owner finds this morning's version, and "Aug 18, 2026" is how he finds the
 * one from before the trip. Past 30 days the relative form stops helping and
 * starts requiring arithmetic, so it is dropped rather than stretched into
 * "47 days ago".
 *
 * A FUTURE takenAt returns null rather than "in 2 hours": the only way to get
 * one is a clock that moved, and inventing a tense for it would be the least
 * useful thing this line could do.
 */
export function relativeTime(iso: string, now: Date): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const elapsed = now.getTime() - at.getTime();
  if (elapsed < 0) return null;
  if (elapsed < MINUTE) return 'just now';
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  const days = Math.floor(elapsed / DAY);
  return days <= 30 ? plural(days, 'day') : null;
}

/**
 * THE LOCAL CALENDAR DAY as "YYYY-MM-DD" — the same key the server's daily
 * guard uses (planHistoryStore.localDayKey), so this page can say whether a
 * restore filed anything without asking.
 */
export function localDayKey(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

/** Why this version exists — the one thing `kind` is for, in the user's words. */
export function kindLabel(kind: PlanHistoryEntry['kind']): string {
  return kind === 'day-start' ? 'the plan as that day began' : 'kept on purpose';
}

/**
 * The same fact as `kindLabel`, at row width. The ledger redesign (2026-08-29,
 * "walls and walls of text") put a two-word tag on the row and moved the full
 * sentence into the expandable detail — the fact did not shrink, its standing
 * copy did.
 */
export function kindTag(kind: PlanHistoryEntry['kind']): string {
  return kind === 'day-start' ? 'day start' : 'kept';
}

/**
 * What the row is CALLED. The owner's label when he gave one; otherwise the
 * moment itself — "Aug 20, 2026, 10:23 AM" is a better name than "Unnamed
 * version", which was a sentence about a blank where a fact could stand (his
 * screenshot had it as a title, and it named nothing).
 */
export function rowTitle(row: Pick<HistoryRow, 'named' | 'label' | 'moment'>): string {
  return row.named ? row.label : row.moment;
}

// ---------------------------------------------------------------------------
// What it scored
// ---------------------------------------------------------------------------

/**
 * What a row shows where the numbers go. FOUR STATES AND NONE OF THEM IS ZERO:
 * a score, a run in flight, a run that failed with its reason, and a version
 * nobody has ever scored.
 */
export type ScoreReading =
  | {
      state: 'scored';
      /** "94.2%" — the plan's probability of never running out. */
      success: string;
      /** "$1,318,403" or null when the run recorded no terminal figure. */
      median: string | null;
      /** "$64,200/yr" or null — ABSENT, not zero. */
      spend: string | null;
      /** The conditions the spend figure alone was solved under. */
      spendConditions: string | null;
      /** Why there is no spend figure, when the solve reported a reason. */
      spendMissing: string | null;
      /**
       * The spend blank is not at rest: the bisection is running RIGHT NOW
       * (the in-flight registry says so). The permanent none-can-be-added
       * sentence must not render while this is true — it used to (the
       * Phase-4 wording quirk), claiming finality about a figure that was a
       * dozen runs from landing.
       */
      spendSolving: boolean;
      /**
       * The spend solve was INTERRUPTED and the write-ahead intent still
       * verifies against today's inputs — the probability stands, and Finish
       * scoring may complete the same bisection (store/scoringIntent.ts).
       */
      spendInterrupted: boolean;
      /** Paths, seed, engine and the moment — on the row, not in a legend. */
      conditions: string;
    }
  | { state: 'scoring' }
  /**
   * Nothing landed before the run was cut short, and the intent still
   * verifies: the whole measurement may be finished as a blank-fill.
   */
  | { state: 'interrupted' }
  | { state: 'failed'; reason: string }
  | { state: 'never' };

/** "10,000 paths, seed 20260812, engine 1.21.0 · scored Aug 20, 2026, 10:26 AM". */
export function scoreConditions(score: PlanScore): string {
  return (
    `${score.paths.toLocaleString('en-US')} paths, seed ${score.seed}, ` +
    `engine ${score.engineVersion} · scored ${historyMoment(score.scoredAt)}`
  );
}

/**
 * The spend figure's OWN condition, which is not the one above it.
 *
 * A bisection is a dozen runs, so the solver caps its inner sweep well below
 * the success figure's path count. Two numbers on one line measured at
 * different precisions, with only one of them labelled, is how a reader comes
 * to believe the cheaper one is as solid as the dearer one.
 */
export function spendConditions(score: PlanScore): string | null {
  if (score.sustainableSpend === undefined) return null;
  if (score.sustainableSpendPaths === undefined) return null;
  return `${score.sustainableSpendPaths.toLocaleString('en-US')} paths`;
}

export function readScore(
  entry: PlanHistoryEntry,
  opts: { scoring: boolean; interrupted?: boolean },
): ScoreReading {
  if (entry.score !== undefined) {
    const s = entry.score;
    const spendBlank = s.sustainableSpend === undefined && s.sustainableSpendError === undefined;
    return {
      state: 'scored',
      success: `${(s.success * 100).toFixed(1)}%`,
      median: s.medianTerminalReal === undefined ? null : formatUSD(s.medianTerminalReal),
      spend: s.sustainableSpend === undefined ? null : `${formatUSD(s.sustainableSpend)}/yr`,
      spendConditions: spendConditions(s),
      spendMissing: s.sustainableSpendError ?? null,
      // In flight wins over interrupted: a Finish press joins the registry,
      // and from that moment the truth is "running", not "waiting".
      spendSolving: opts.scoring && spendBlank,
      spendInterrupted: !opts.scoring && spendBlank && opts.interrupted === true,
      conditions: scoreConditions(s),
    };
  }
  // Order matters: a version being scored right now has usually just failed
  // once (that is why the button was pressed), and showing the old reason
  // beside a live run would say the opposite of what is happening. And
  // 'interrupted' outranks 'failed'/'never' for the same reason the intent
  // file exists: while it stands, the honest description of this blank is
  // "cut short and still finishable", not "permanent".
  if (opts.scoring) return { state: 'scoring' };
  if (opts.interrupted === true) return { state: 'interrupted' };
  if (entry.scoreError !== undefined) return { state: 'failed', reason: entry.scoreError };
  return { state: 'never' };
}

/**
 * THE BUTTON, OR THE ABSENCE OF ONE. The whole immutability rule, in one place
 * the tab can be tested at rather than by reading its JSX.
 *
 * FILLING A BLANK IS ALLOWED; OVERWRITING A FACT IS NOT — the user's own
 * resolution, after "Score it again undermines take a snapshot". A version's
 * entry is a RECORD: this plan, measured against one day's balances, prices and
 * calendar. Two of the four readings are blanks and get a button:
 *
 *  - 'never'  — nobody has measured this. Writing here destroys nothing.
 *  - 'failed' — we tried and the run died. That records no measurement either,
 *               and the label says which of the two it is, because "try again"
 *               and "find out" are different offers.
 *
 * The other two get nothing. 'scored' is the point of the rule: the only thing
 * a press could do is replace a number taken on a different day, and the server
 * refuses it anyway (409 from POST /api/plan/history/:id/score). 'scoring' has
 * a run in flight and a second press would just join it.
 *
 * A SCORED VERSION WITH NO SPEND FIGURE STILL GETS NOTHING, and that is the
 * subtle case rather than an oversight. The user's "Baseline — saved Aug 18"
 * is exactly it: 93.8% at 1,000 paths, no dollars, because the solve did not
 * exist yet. Solving it today and filing the answer on that row would put a
 * figure measured against today's balances beside a probability measured
 * against August 18th's, and the row would report two moments as one. The row
 * says why the figure is absent instead.
 */
export function scoringOffer(score: ScoreReading): string | null {
  if (score.state === 'never') return 'Score it';
  if (score.state === 'failed') return 'Try scoring again';
  return null;
}

/**
 * THE OTHER BUTTON — Finish scoring, offered only behind a write-ahead intent
 * that still verifies against today's inputs (store/scoringIntent.ts,
 * decision D4). It is NOT the removed re-score button in new clothes: a
 * re-score measured a different day and filed it here; a finish completes the
 * run that was already in flight for THIS record, provably the same
 * measurement, and the backend re-verifies at the press. Two shapes qualify:
 * a version whose run was cut short before anything landed ('interrupted'),
 * and a scored version whose spend bisection alone was lost — the Aug-20
 * shape, the incident the intent machinery exists to close.
 */
export function finishOffer(score: ScoreReading): string | null {
  if (score.state === 'interrupted') return 'Finish scoring';
  if (score.state === 'scored' && score.spendInterrupted) return 'Finish scoring';
  return null;
}

// ---------------------------------------------------------------------------
// What restoring this one would mean
// ---------------------------------------------------------------------------

/**
 * A warning on a version, worded for the button beside it.
 *
 * The cabinet had six of these and they were all about ranking saved numbers.
 * Two survive the collapse, because two of them are about the PLAN and the
 * score together rather than about a stale metrics block:
 *
 *  - `older_engine`     — the number was taken with a different instrument, and
 *                         restoring re-measures with this one.
 *  - `auto_sepp_differs` — the automatic 72(t) bridge is ON in one of these two
 *                         plans and OFF in the other, so restoring flips it.
 *
 * WHY THE SECOND ONE IS A COMPARISON AND NOT A PROPERTY, which is where the
 * cabinet's version of it went wrong. Its rule was "no `autoSepp` field and
 * somebody retires early", and that fires on EVERY plan this app writes:
 * `autoSeppPatch(true)` deliberately CLEARS the field rather than writing
 * `true`, because absent already means on — so a modern plan with the bridge
 * switched on is indistinguishable from a 2024 file that never heard of it.
 * Run against the user's real history it warned on three rows out of three,
 * about a default he chose. A warning that fires on everything says nothing.
 *
 * What a reader actually needs before pressing Restore is whether this version
 * disagrees with the plan on screen — and that is a comparison, is silent when
 * they agree, and is exactly the surprise the button can spring.
 *
 * The rest died with what they were about: `metrics_stale` /
 * `metrics_inputs_changed` were about a cabinet record's own metrics block,
 * `legacy_shape` about a file format there is no longer any of, and
 * `carries_solver` about the removed sweep UI — the scorer strips a solver
 * before running (scoreRunner.planForScoring) and so does the workbench, so a
 * stored one changes no number anyone sees.
 */
export interface HistoryWarning {
  code: 'older_engine' | 'auto_sepp_differs';
  message: string;
}

/** ABSENT MEANS ON. The one rule this whole comparison turns on. */
function bridgeOn(plan: Scenario): boolean {
  return plan.autoSepp !== false;
}

export function planVersionWarnings(
  entry: PlanHistoryEntry,
  opts: {
    engineVersion: string;
    people: readonly Person[];
    accounts?: readonly Pick<Account, 'id' | 'owner'>[];
    /** The plan on screen — what restoring would replace. Null while loading. */
    currentPlan?: Scenario | null;
  },
): HistoryWarning[] {
  const warnings: HistoryWarning[] = [];

  if (entry.score !== undefined && entry.score.engineVersion !== opts.engineVersion) {
    warnings.push({
      code: 'older_engine',
      message:
        `Scored by engine ${entry.score.engineVersion}; this app runs ${opts.engineVersion}. ` +
        'The engine version is part of the run key precisely because two engines do not agree, ' +
        'so that figure is not comparable with anything scored since. Restoring is safe — the ' +
        'plan is unchanged — and restoring is how to read it under this engine: the Plan page ' +
        'runs the plan on screen live. The recorded number stays as it is, because it is a ' +
        'record of what that engine said on that day.',
    });
  }

  const current = opts.currentPlan ?? null;
  if (current !== null && bridgeOn(entry.plan) !== bridgeOn(current)) {
    // Only worth a line if the bridge would DO anything in the stored version:
    // a household where nobody stops working early has no gap to bridge, so
    // the setting is inert and flipping it changes no number.
    const status = autoSeppStatus(entry.plan, opts.people, opts.accounts ?? []);
    if (status.applies) {
      const who = status.bridges.map((b) => b.name).join(' and ');
      warnings.push({
        code: 'auto_sepp_differs',
        message: bridgeOn(entry.plan)
          ? `The automatic 72(t) bridge is ON in this version and OFF in the plan on screen, ` +
            `and it bites: ${who} stops working before pre-tax money is penalty-free. ` +
            'Restoring turns the bridge back on — pre-59½ IRA draws stop paying the 10% penalty.'
          : `The automatic 72(t) bridge is OFF in this version and ON in the plan on screen, ` +
            `and it bites: ${who} stops working before pre-tax money is penalty-free. ` +
            'Restoring turns the bridge off — pre-59½ IRA draws start paying the 10% penalty.',
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** One row of the History tab, everything already decided. */
export interface HistoryRow {
  entry: PlanHistoryEntry;
  /**
   * Is this the plan on screen?
   *
   * By CONTENT IDENTITY (planIdentityKey), never by id or by label: the plan
   * has no id, it is renamed to "Plan" on every write, and the whole question
   * the user is asking of this list is "where am I in it". Two entries can
   * both be current — a history can hold the Aug-18 and Aug-20 records of one
   * unchanged plan — and both should say so rather than the list picking one.
   */
  isCurrent: boolean;
  /** "Aug 20, 2026, 10:23 AM". */
  moment: string;
  /** "3 hours ago", or null once the date says it better. */
  ago: string | null;
  /** What the user called it, or the honest absence of a name. */
  label: string;
  /** Whether `label` is the user's words or ours — the fallback is rendered quieter. */
  named: boolean;
  why: string;
  score: ScoreReading;
  warnings: HistoryWarning[];
}

export interface HistoryRowOptions {
  /** The plan on screen, for the match indicator. Null while it is loading. */
  currentPlan: Scenario | null;
  /** Ids with a simulation in flight right now, from the server's own memory. */
  scoring: readonly string[];
  /**
   * Ids whose scoring was interrupted and still verifies completable — from
   * the write-ahead intent file (api.getScoringIntents). Optional so callers
   * without the answer render the at-rest readings unchanged.
   */
  interrupted?: readonly string[];
  engineVersion: string;
  people: readonly Person[];
  accounts?: readonly Pick<Account, 'id' | 'owner'>[];
  now: Date;
}

/**
 * Newest first, every row ready to render.
 *
 * IT SORTS, even though the route already returns reverse-chronological. "The
 * newest version is at the top" is what makes the list readable at all, and
 * leaving that property to a promise made in another module — one an unrelated
 * change to the store could break without failing a single test here — is how
 * a list quietly starts lying about which version is the recent one.
 *
 * It does NOT de-duplicate by plan hash. Two entries holding the identical
 * plan are two facts (this owner has exactly that: the same plan filed on
 * Aug 18 with a score and again on Aug 20 without one), and collapsing them
 * would throw away a recorded number to tidy a list.
 */
export function historyRows(
  entries: readonly PlanHistoryEntry[],
  opts: HistoryRowOptions,
): HistoryRow[] {
  const currentKey = opts.currentPlan === null ? null : planIdentityKey(opts.currentPlan);
  return [...entries]
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt))
    .map((entry) => {
      const label = entry.label ?? '';
      return {
        entry,
        isCurrent: currentKey !== null && planIdentityKey(entry.plan) === currentKey,
        moment: historyMoment(entry.takenAt),
        ago: relativeTime(entry.takenAt, opts.now),
        label: label.trim() === '' ? 'Unnamed version' : label,
        named: label.trim() !== '',
        why: kindLabel(entry.kind),
        score: readScore(entry, {
          scoring: opts.scoring.includes(entry.id),
          interrupted: opts.interrupted?.includes(entry.id) === true,
        }),
        warnings: planVersionWarnings(entry, {
          engineVersion: opts.engineVersion,
          people: opts.people,
          currentPlan: opts.currentPlan,
          ...(opts.accounts === undefined ? {} : { accounts: opts.accounts }),
        }),
      };
    });
}

/**
 * What a restore announcement calls an entry — rowTitle's rule, for a raw
 * entry: the owner's label (with the moment beside it, since the announcement
 * stands apart from the list), or the moment standing in as the name. The
 * ledger killed "Unnamed version" everywhere a user reads, and the
 * post-restore sentence and its toast are places a user reads.
 */
export function restoredWhat(entry: Pick<PlanHistoryEntry, 'label' | 'takenAt'>): string {
  const named = entry.label !== undefined && entry.label.trim() !== '';
  return named
    ? `“${entry.label}”, taken ${historyMoment(entry.takenAt)}`
    : `the version taken ${historyMoment(entry.takenAt)}`;
}

// ---------------------------------------------------------------------------
// Grouping identical plans (the ledger redesign, 2026-08-29)
// ---------------------------------------------------------------------------

/**
 * One VISIBLE row of the ledger: a plan, however many times it was filed.
 *
 * `historyRows` deliberately does not de-duplicate — two entries holding the
 * identical plan are two facts, and both survive here, in `others`. What the
 * owner's screenshot showed is why the GROUPING exists on top: three entries
 * of one unchanged plan rendered as three full rows, three identical badges,
 * three identical warnings — the wall-of-text problem in miniature. One row
 * now faces for the group, a muted "also filed …" line names the rest, and
 * expanding the row reaches every individual record with its own facts and
 * its own buttons. Compression, not deletion.
 */
export interface HistoryGroup {
  /** The face of the group — see the primary rule below. */
  primary: HistoryRow;
  /** The group's other filings, newest first. Empty for a single filing. */
  others: HistoryRow[];
  /** "also filed Aug 21, Aug 20" — null when the group is a single filing. */
  alsoFiled: string | null;
}

/**
 * "Aug 21" — the also-filed line's date, with the year only when it differs
 * from the face's own (a cross-year group must not read as one August).
 */
function alsoFiledDate(iso: string, primaryYear: number | null): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const withYear = primaryYear === null || at.getFullYear() !== primaryYear;
  return at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** The muted line under a group's face, naming its other filings. */
export function alsoFiledLine(
  others: readonly HistoryRow[],
  primaryTakenAt: string,
): string | null {
  if (others.length === 0) return null;
  const at = new Date(primaryTakenAt);
  const primaryYear = Number.isNaN(at.getTime()) ? null : at.getFullYear();
  return `also filed ${others.map((o) => alsoFiledDate(o.entry.takenAt, primaryYear)).join(', ')}`;
}

/**
 * Collapse rows whose plans are IDENTICAL (planIdentityKey — the same
 * comparison `isCurrent` is made by, so a group is current exactly when the
 * plan on screen is, and "the plan on screen" badges at most one visible row
 * without any further rule).
 *
 * THE FACE IS THE NEWEST SCORED FILING, else the newest filing. A ledger row
 * exists to be recognised by, and a recorded score is what tells two versions
 * apart — fronting an unscored Aug-20 filing over a scored Aug-18 one would
 * hide the group's one recorded number behind a click. The face's chips are
 * only ever the face's OWN entry's: two scored filings of one plan are two
 * measurements of two days, and the collapsed row never mixes them — the
 * second stays whole inside the expansion.
 *
 * Groups keep list order by their newest member (rows arrive newest-first, so
 * first occurrence IS newest member), which keeps "the newest version is at
 * the top" true of the visible ledger too.
 */
export function groupHistoryRows(rows: readonly HistoryRow[]): HistoryGroup[] {
  const byKey = new Map<string, HistoryRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = planIdentityKey(row.entry.plan);
    const members = byKey.get(key);
    if (members === undefined) {
      byKey.set(key, [row]);
      order.push(key);
    } else {
      members.push(row);
    }
  }
  return order.map((key) => {
    const members = byKey.get(key)!;
    const primary = members.find((m) => m.score.state === 'scored') ?? members[0];
    const others = members.filter((m) => m !== primary);
    return { primary, others, alsoFiled: alsoFiledLine(others, primary.entry.takenAt) };
  });
}

// ---------------------------------------------------------------------------
// The engine-version notice — once, not per row
// ---------------------------------------------------------------------------

/**
 * Whether a group carries any score taken by an older engine — the marker
 * rule. ANY member counts, not just the face: the note's promise ("Restore
 * re-reads any of them under the current engine") covers the whole group, and
 * a group whose only old-engine measurement is inside the expansion still
 * deserves its marker.
 */
export function groupHasOlderEngine(group: HistoryGroup, engineVersion: string): boolean {
  return [group.primary, ...group.others].some(
    (m) => m.entry.score !== undefined && m.entry.score.engineVersion !== engineVersion,
  );
}

/**
 * Where the ONE engine-version note renders: above the first affected group,
 * or nowhere (-1). The owner's screenshot had the full amber paragraph
 * repeated VERBATIM on every older entry; the redesign says it once, short,
 * with a small marker on each affected row and the full sentence in the row
 * detail (planVersionWarnings, unchanged).
 */
export function engineNoticeIndex(
  groups: readonly HistoryGroup[],
  engineVersion: string,
): number {
  return groups.findIndex((g) => groupHasOlderEngine(g, engineVersion));
}

/** The note itself — short, above the line, said once. */
export function engineNotice(engineVersion: string): string {
  return (
    `Versions marked below were scored by an older engine than this app runs (${engineVersion}). ` +
    'Recorded numbers stand as records; Restore re-reads any of them under the current engine.'
  );
}

/** Nothing filed yet — said once, in the place the list would be. */
export function historyEmptyNote(): string {
  return (
    'No earlier version of the plan yet. The first time you change the plan on any day, the ' +
    'version the day began with is filed here automatically — so tomorrow this list will have ' +
    'today in it. Keeping a search finalist files one too.'
  );
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/**
 * Does today already have a restore point? The same question the server's guard
 * asks (planHistoryStore.recordDayStart), asked here from the list the tab has
 * already loaded — because the answer decides whether the sentence below can
 * promise an undo.
 */
export function dayIsCovered(entries: readonly PlanHistoryEntry[], now: Date): boolean {
  const today = localDayKey(now);
  return entries.some((e) => e.kind === 'day-start' && localDayKey(new Date(e.takenAt)) === today);
}

/**
 * The sentence shown before a restore happens. It is the whole confirmation,
 * and it must not promise something that will not happen.
 *
 * "The plan being replaced is filed first" is true of the day's FIRST change
 * and only that. Restore in the afternoon of a day you have already edited and
 * the guard files nothing, because today's restore point already exists — and
 * that entry holds THIS MORNING'S plan, not the one about to be replaced. So an
 * afternoon's work can be dropped by a button that just said it could be got
 * back. `restoreOutcome` says so afterwards, which is the right thing to say in
 * the wrong place: after an act nobody can take back is where a warning stops
 * being a warning.
 *
 * The two facts it takes — the list and the clock — are ones the card already
 * holds, so this costs nothing but the asking.
 */
export function restorePrompt(
  row: HistoryRow,
  entries: readonly PlanHistoryEntry[] = [],
  now: Date = new Date(),
): string {
  // An unnamed row is NAMED BY ITS MOMENT (rowTitle's rule), so the question
  // says "the version taken …" rather than quoting a fallback label — the
  // ledger killed "Unnamed version" everywhere a user reads.
  const what = row.named ? `“${row.label}”, taken ${row.moment}` : `the version taken ${row.moment}`;
  const opening = `Restore ${what}? It replaces the plan on screen, and the workbench re-runs against it.`;
  return dayIsCovered(entries, now)
    ? `${opening} Today's restore point already exists and holds the plan as this morning began — so the plan on screen now will NOT be filed, and any change you have made today would have to be made again.`
    : `${opening} The plan being replaced is filed first, so this is undoable.`;
}

/**
 * WHAT ACTUALLY HAPPENED, said afterwards, from the list as it now stands.
 *
 * The promise on the button — "the plan being replaced is filed first" — is
 * true of the day's FIRST change and only of that (planStore's daily guard).
 * Restore twice in one afternoon and the second one files nothing, because
 * today's restore point already exists. That is the right behaviour and the
 * wrong thing to be silent about: the user would be told their last plan was
 * kept when the entry offering to bring it back holds this morning's plan
 * instead. So the answer is computed rather than asserted — whether a NEW
 * entry appeared is a fact about the two lists.
 */
export function restoreOutcome(
  restoredFrom: PlanHistoryEntry,
  idsBefore: readonly string[],
  after: readonly PlanHistoryEntry[],
  now: Date,
): string {
  const restored = `Restored ${restoredWhat(restoredFrom)} — it is the plan on screen now.`;
  const filed = after.find((e) => !idsBefore.includes(e.id));
  if (filed !== undefined) {
    return (
      `${restored} The plan it replaced was filed first, at the top of this list, so this ` +
      'restore is itself undoable.'
    );
  }
  const today = localDayKey(now);
  const point = after.find(
    (e) => e.kind === 'day-start' && localDayKey(new Date(e.takenAt)) === today,
  );
  if (point === undefined) {
    // Belt and braces: no new entry and no day-start for today means the store
    // did something this page cannot explain, and guessing would be worse than
    // saying so.
    return `${restored} Nothing new was filed — check the list before relying on an undo.`;
  }
  // The point is named the same way every announcement names an entry —
  // its label, or its moment; never a quoted placeholder (restoredWhat).
  const pointName =
    point.label !== undefined && point.label.trim() !== ''
      ? `“${point.label}”, ${historyMoment(point.takenAt)}`
      : `taken ${historyMoment(point.takenAt)}`;
  return (
    `${restored} Nothing new was filed: today already had a restore point (${pointName}), ` +
    'and that entry holds the plan as TODAY BEGAN — not the plan that was on screen a moment ago.'
  );
}
