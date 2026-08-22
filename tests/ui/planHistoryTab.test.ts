/**
 * The Workbench's HISTORY tab: its assembly
 * (src/ui/components/workbench/planHistoryLogic.ts) and its wiring
 * (PlanHistoryCard.tsx, ScenarioPanel.tsx).
 *
 * The tab replaced a "Saved" tab the user called a hot mess, so the properties
 * below are the ones that decide whether the replacement is better or merely
 * different:
 *
 * 1. NEWEST FIRST, WHATEVER ARRIVES. "Which version is the recent one" is the
 *    question the list exists to answer, and it must not be inherited from a
 *    route's ordering promise made in another module.
 * 2. A VERSION WITH NO SCORE READS AS NOT-SCORED. Never 0%: that would claim
 *    the plan fails in every simulated future, which is the opposite of "we
 *    have not measured this yet".
 * 3. RESTORING ASKS FIRST, AND SAYS WHAT IT DID AFTERWARDS — including the
 *    case where the day's restore point already existed and nothing new was
 *    filed, which is the one the button's own promise gets wrong.
 * 4. THE MATCH INDICATOR IS BY CONTENT. The plan has no id and is renamed on
 *    every write, so identity is the only thing that can answer "am I looking
 *    at this one" — and two entries holding one plan must both say so.
 * 5. A RECORDED SCORE IS NEVER OFFERED A SECOND ONE. There was a "Score it
 *    again" button here; the user's objection to it — "Score it again
 *    undermines take a snapshot" — is the rule the tab now follows. A row is a
 *    RECORD of a moment, so filling its blank is allowed and rewriting its
 *    number is not, and `scoringOffer` is the one place that decides which.
 *
 * Source scans for the wiring, in the idiom of tests/ui/tithingTab.test.ts and
 * the score chart's own: a button that calls the wrong route, or one that
 * restores without asking, is a declaration, and reading it is what catches it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Person, PlanHistoryEntry, PlanScore, Scenario } from '../../src/shared/types';
import {
  historyEmptyNote,
  historyMoment,
  historyRows,
  kindLabel,
  localDayKey,
  planVersionWarnings,
  readScore,
  relativeTime,
  scoringOffer,
  restoreOutcome,
  dayIsCovered,
  restorePrompt,
  scoreConditions,
  spendConditions,
} from '../../src/ui/components/workbench/planHistoryLogic';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const card = read('../../src/ui/components/workbench/PlanHistoryCard.tsx');
const panel = read('../../src/ui/components/workbench/ScenarioPanel.tsx');
const styles = read('../../src/ui/styles.css');
/**
 * The panel with its comments blanked out.
 *
 * The header comment QUOTES the amber sentence the user complained about, to
 * explain what the History tab replaced and why — so a scan for "is that line
 * gone" has to read what renders, not what explains. Deleting the reasoning to
 * satisfy the guard would be exactly backwards.
 */
const panelCode = panel
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const workbench = read('../../src/ui/pages/WorkbenchPage.tsx');

const ENGINE = '1.21.0';

const plan = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'Plan',
  events: [],
  ...over,
});

const score = (over: Partial<PlanScore> = {}): PlanScore => ({
  success: 0.942,
  medianTerminalReal: 1_318_402.556,
  sustainableSpend: 64_199.60,
  sustainableSpendPaths: 2_000,
  mode: 'montecarlo',
  paths: 10_000,
  seed: 20_260_812,
  engineVersion: ENGINE,
  scoredAt: '2026-08-20T10:26:33.775Z',
  ...over,
});

const entry = (over: Partial<PlanHistoryEntry> = {}): PlanHistoryEntry => ({
  id: 'ph-1',
  takenAt: '2026-08-20T10:23:15.156Z',
  kind: 'day-start',
  plan: plan(),
  planHash: 'a'.repeat(64),
  ...over,
});

const NOW = new Date('2026-08-20T13:00:00.000Z');

const rowOpts = (over: Partial<Parameters<typeof historyRows>[1]> = {}) => ({
  currentPlan: null,
  scoring: [] as string[],
  engineVersion: ENGINE,
  people: [] as Person[],
  now: NOW,
  ...over,
});

// ---------------------------------------------------------------------------

describe('the list is newest first, whatever order it arrives in', () => {
  it('sorts by the moment it was taken, not by the order on the wire', () => {
    // The route promises reverse-chronological. This does it again anyway: the
    // property is what makes the list readable, and a change in the store that
    // broke the promise would otherwise fail no test on this side.
    const rows = historyRows(
      [
        entry({ id: 'oldest', takenAt: '2026-08-18T21:41:17.216Z' }),
        entry({ id: 'newest', takenAt: '2026-08-20T10:23:15.156Z' }),
        entry({ id: 'middle', takenAt: '2026-08-20T09:24:28.759Z' }),
      ],
      rowOpts(),
    );
    expect(rows.map((r) => r.entry.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('keeps two entries that hold the identical plan — both are facts', () => {
    // A representative history has exactly this: one unchanged plan filed on
    // Aug 18 with a score and again on Aug 20 without one. De-duplicating by
    // hash would throw away a recorded number to tidy a list.
    const same = plan({ events: [] });
    const rows = historyRows(
      [
        entry({ id: 'a', takenAt: '2026-08-18T21:41:17.216Z', plan: same, label: 'Aug 18' }),
        entry({ id: 'b', takenAt: '2026-08-20T09:24:28.759Z', plan: same, label: 'Aug 20' }),
      ],
      rowOpts(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(['Aug 20', 'Aug 18']);
  });

  it('reads sensibly with one entry, and says the right nothing with none', () => {
    expect(historyRows([entry({ label: 'Only one' })], rowOpts())).toHaveLength(1);
    expect(historyRows([], rowOpts())).toEqual([]);
    // The empty state names what will fill it rather than apologising: this
    // list populates itself, and the user has to be told that or he will go
    // looking for the Save button that no longer exists.
    expect(historyEmptyNote()).toContain('the version the day began with is filed here');
    expect(historyEmptyNote()).toContain('Keeping a search finalist files one too');
  });
});

describe('a version with no score reads as not-scored, never as zero', () => {
  it('has a state of its own for "nobody has run this"', () => {
    const reading = readScore(entry(), { scoring: false });
    expect(reading.state).toBe('never');
    // The exhaustive check: nothing in the reading can be mistaken for a
    // figure, because there is no figure field on this branch at all.
    expect(reading).toEqual({ state: 'never' });
  });

  it('tells a failed run apart from an un-run one, and shows the reason', () => {
    const failed = readScore(entry({ scoreError: 'The simulation failed: no quote for VTI' }), {
      scoring: false,
    });
    expect(failed).toEqual({
      state: 'failed',
      reason: 'The simulation failed: no quote for VTI',
    });
  });

  it('lets a live run speak over a stale failure', () => {
    // The button was pressed BECAUSE it failed; showing the old reason beside
    // a running simulation would say the opposite of what is happening.
    expect(readScore(entry({ scoreError: 'timed out' }), { scoring: true })).toEqual({
      state: 'scoring',
    });
  });

  it('renders 0.0% only for a genuine zero — the catastrophe, not the absence', () => {
    const reading = readScore(entry({ score: score({ success: 0 }) }), { scoring: false });
    expect(reading).toMatchObject({ state: 'scored', success: '0.0%' });
  });

  it('never renders the row’s cell from a number the entry does not carry', () => {
    // The card reaches a figure only through the 'scored' branch, so there is
    // no path on which a missing score becomes a zero.
    expect(card).not.toContain('score?.success ?? 0');
    expect(card).not.toContain('success || 0');
    expect(card).toContain("score.state === 'never'");
    expect(card).toContain('Never scored');
  });

  it('says which of the two blanks it is, because they invite different presses', () => {
    // "Nobody has measured this" asks for a first measurement; "a run was
    // attempted and died" asks for a second attempt at the same one. Collapsing
    // both into "no score" would hide a failure worth reading.
    expect(card).toContain('nobody has measured this version');
    expect(card).toContain('Scoring was attempted and failed, so nothing was measured');
  });
});

describe('a recorded score is never offered a second one', () => {
  /**
   * THE RESOLUTION, in one function: "once a number is recorded,
   * nothing may overwrite it. Filling a blank is allowed; overwriting a fact is
   * not." The button that used to break it read "Score it again".
   */
  it('offers nothing on a version that already carries a number', () => {
    expect(scoringOffer(readScore(entry({ score: score() }), { scoring: false }))).toBeNull();
  });

  it('offers nothing on a SCORED version that has no spend figure either', () => {
    /*
     * A "Baseline — saved Aug 18" is this row: 93.8% and no dollars,
     * because the solve did not exist when it was scored. It is the case that
     * most tempts a re-open, and the one where re-opening does the most damage —
     * its success was measured on Aug 18 against that day's balances, and a
     * spend figure solved today filed on the same row would make one row report
     * two different moments as if they were one.
     */
    const august18 = readScore(
      entry({
        score: score({
          paths: 1_000,
          sustainableSpend: undefined,
          sustainableSpendPaths: undefined,
          sustainableSpendError: undefined,
        }),
      }),
      { scoring: false },
    );
    expect(august18).toMatchObject({ state: 'scored', spend: null, spendMissing: null });
    expect(scoringOffer(august18)).toBeNull();
    // And the row explains the absence rather than leaving it looking like a
    // gap somebody forgot to fill.
    expect(card).toContain('none was solved alongside this score, and none can be');
    expect(card).toContain('a figure solved today would belong to today');
    // And it does NOT claim to know why. "Scored before that was measured" is
    // true of the August rows and false of one whose solve was interrupted
    // between the probability and the bisection — which happened to "Baseline —
    // frozen Aug 20" on the afternoon this rule shipped. The entry stores no
    // way to tell the two apart, so the row states only what it knows.
    expect(card).not.toContain('was scored before that was measured, and');
  });

  it('offers a FIRST measurement on a version nobody has scored', () => {
    // Writing here destroys nothing, and the History tab is meant to be
    // recognised from — a list of dates with no numbers is not recognisable.
    expect(scoringOffer(readScore(entry(), { scoring: false }))).toBe('Score it');
  });

  it('offers ANOTHER ATTEMPT on a version whose run died', () => {
    // A failure records no measurement, so this is filling a blank. The label
    // says which of the two it is.
    const failed = readScore(entry({ scoreError: 'worker died' }), { scoring: false });
    expect(scoringOffer(failed)).toBe('Try scoring again');
  });

  it('offers nothing while a run is in flight — a second press would just join it', () => {
    expect(scoringOffer(readScore(entry(), { scoring: true }))).toBeNull();
  });
});

describe('every number carries its own conditions', () => {
  it('names paths, seed, engine and the moment on the row that shows it', () => {
    // The clock half is asserted by SHAPE, not by value: it is formatted in the
    // machine's own zone (deliberately — the whole app is, and the server's day
    // key is too), so pinning "6:26 AM" would pin this suite to one timezone.
    expect(scoreConditions(score())).toMatch(
      /^10,000 paths, seed 20260812, engine 1\.21\.0 · scored Aug 20, 2026, \d{1,2}:\d{2} (AM|PM)$/,
    );
  });

  it('labels the spend figure with ITS OWN path count, which is not the other one', () => {
    // A bisection is a dozen runs, so the solver caps its inner sweeps far
    // below the success figure's precision. Two numbers on one line at two
    // precisions, one of them unlabelled, is how the cheaper one comes to be
    // trusted like the dearer one.
    expect(spendConditions(score())).toBe('2,000 paths');
    expect(spendConditions(score({ sustainableSpend: undefined }))).toBeNull();
    expect(spendConditions(score({ sustainableSpendPaths: undefined }))).toBeNull();
  });

  it('shows an absent spend figure as absent, with the reason when there is one', () => {
    const over = readScore(
      entry({
        score: score({
          sustainableSpend: undefined,
          sustainableSpendPaths: undefined,
          sustainableSpendError: 'Even $400,000/yr clears this plan’s success target',
        }),
      }),
      { scoring: false },
    );
    expect(over).toMatchObject({
      state: 'scored',
      success: '94.2%',
      spend: null,
      spendMissing: 'Even $400,000/yr clears this plan’s success target',
    });
  });

  it('formats the money the way the rest of the app does', () => {
    expect(readScore(entry({ score: score() }), { scoring: false })).toMatchObject({
      success: '94.2%',
      median: '$1,318,403',
      spend: '$64,200/yr',
    });
  });
});

describe('when it was', () => {
  it('carries the clock as well as the date, because a day can hold several', () => {
    // One day-start entry per day, but a search with six finalists can file six
    // keeps in an afternoon, and six rows reading "Aug 20, 2026" are six rows
    // nobody can tell apart.
    expect(historyMoment('2026-08-20T10:23:15.156Z')).toMatch(
      /^Aug 20, 2026, \d{1,2}:\d{2} (AM|PM)$/,
    );
    // An unparseable moment is echoed rather than rendered as "Invalid Date":
    // the raw string is at least a clue about what is wrong with the file.
    expect(historyMoment('not-a-date')).toBe('not-a-date');
  });

  it('adds a relative reading while it still helps, and drops it when it does not', () => {
    const now = new Date('2026-08-20T13:00:00.000Z');
    expect(relativeTime('2026-08-20T12:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2026-08-20T12:38:00.000Z', now)).toBe('22 minutes ago');
    expect(relativeTime('2026-08-20T12:00:00.000Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-08-20T10:23:15.156Z', now)).toBe('2 hours ago');
    expect(relativeTime('2026-08-18T21:41:17.216Z', now)).toBe('1 day ago');
    // Past a month "47 days ago" is arithmetic, not a reading: the date says it.
    expect(relativeTime('2026-06-01T00:00:00.000Z', now)).toBeNull();
    // A clock that moved is the only way to get a future entry, and inventing
    // a tense for it would be the least useful thing this line could do.
    expect(relativeTime('2026-08-21T00:00:00.000Z', now)).toBeNull();
    expect(relativeTime('nonsense', now)).toBeNull();
  });

  it('says why each version exists, since that is all `kind` is for', () => {
    expect(kindLabel('day-start')).toBe('the plan as that day began');
    expect(kindLabel('kept')).toBe('kept on purpose');
  });
});

describe('which entry is the plan on screen', () => {
  const events: Scenario['events'] = [
    { type: 'retire', person: 'p1', date: '2031-06' },
  ];

  it('matches on content, so a different name is still the same plan', () => {
    // plan.json's name is pinned to "Plan" on every write, and a stored version
    // may have been filed under any label. Matching on the name would report
    // "not this one" about a byte-identical plan.
    const rows = historyRows(
      [entry({ id: 'x', plan: plan({ name: 'Baseline — frozen Aug 20', events }) })],
      rowOpts({ currentPlan: plan({ name: 'Plan', events }) }),
    );
    expect(rows[0].isCurrent).toBe(true);
  });

  it('marks BOTH entries when two of them hold the plan on screen', () => {
    // Not a selection — a statement about each row. Picking one would claim a
    // choice nobody made, and the user's history really does contain a pair.
    const rows = historyRows(
      [
        entry({ id: 'a', takenAt: '2026-08-18T21:41:17.216Z', plan: plan({ events }) }),
        entry({ id: 'b', takenAt: '2026-08-20T09:24:28.759Z', plan: plan({ events }) }),
      ],
      rowOpts({ currentPlan: plan({ events }) }),
    );
    expect(rows.map((r) => r.isCurrent)).toEqual([true, true]);
  });

  it('says nothing at all while the plan on screen is unknown', () => {
    // Null is "not loaded yet". Defaulting to a match would put the badge on
    // the newest row for one frame on every mount, which is a claim.
    const rows = historyRows([entry()], rowOpts({ currentPlan: null }));
    expect(rows[0].isCurrent).toBe(false);
  });

  it('does not match a plan that differs anywhere the engine can see', () => {
    const rows = historyRows(
      [entry({ plan: plan({ events }) })],
      rowOpts({ currentPlan: plan({ events: [{ type: 'retire', person: 'p1', date: '2032-06' }] }) }),
    );
    expect(rows[0].isCurrent).toBe(false);
  });

  it('falls back to honest words rather than a blank when nobody named it', () => {
    const rows = historyRows([entry({ label: '   ' }), entry({ id: 'p', label: 'Frozen' })], rowOpts());
    expect(rows.map((r) => [r.label, r.named])).toEqual([
      ['Unnamed version', false],
      ['Frozen', true],
    ]);
  });
});

describe('restoring asks first, and says afterwards what it actually did', () => {
  const row = () => historyRows([entry({ label: 'Baseline — frozen Aug 20' })], rowOpts())[0];

  it('states the consequence and the undo in the question itself', () => {
    const prompt = restorePrompt(row());
    expect(prompt).toContain('Baseline — frozen Aug 20');
    expect(prompt).toContain('It replaces the plan on screen');
    expect(prompt).toContain('filed first, so this is undoable');
  });

  it('reports the undo only when an entry was really filed', () => {
    const restoredFrom = entry({ id: 'old', label: 'Aug 18' });
    const after = [entry({ id: 'freshly-filed', takenAt: '2026-08-20T13:00:00.000Z' }), restoredFrom];
    const text = restoreOutcome(restoredFrom, ['old'], after, NOW);
    expect(text).toContain('Restored “Aug 18”');
    expect(text).toContain('it is the plan on screen now');
    expect(text).toContain('filed first, at the top of this list, so this restore is itself undoable');
  });

  it('does NOT repeat the button’s promise when the day’s restore point already existed', () => {
    // The second restore of an afternoon files nothing (planStore's daily
    // guard). Saying "your last plan was kept" then would point the user at
    // an entry holding THIS MORNING'S plan instead — the exact failure this
    // sentence is computed rather than asserted to avoid.
    const restoredFrom = entry({ id: 'old', label: 'Aug 18' });
    const todaysPoint = entry({
      id: 'today',
      kind: 'day-start',
      label: 'The plan as it stands today',
      takenAt: NOW.toISOString(),
    });
    const text = restoreOutcome(restoredFrom, ['old', 'today'], [todaysPoint, restoredFrom], NOW);
    expect(text).toContain('Nothing new was filed');
    expect(text).toContain('The plan as it stands today');
    expect(text).toContain('holds the plan as TODAY BEGAN');
    expect(text).not.toContain('undoable');
  });

  it('admits it cannot explain a list with neither a new entry nor today’s point', () => {
    // Guessing here would be worse than saying so: the store did something
    // this page has no account of.
    const restoredFrom = entry({ id: 'old', kind: 'kept', takenAt: '2026-06-01T09:00:00.000Z' });
    const text = restoreOutcome(restoredFrom, ['old'], [restoredFrom], NOW);
    expect(text).toContain('check the list before relying on an undo');
  });

  it('uses the same local calendar day the server’s guard does', () => {
    // A UTC key would put an owner in Eastern time into "tomorrow" from 8pm,
    // and this sentence would then claim today had no restore point.
    const at = new Date(2026, 7, 20, 22, 30);
    expect(localDayKey(at)).toBe('2026-08-20');
  });
});

describe('the warnings that survived the cabinet, re-worded for a restore', () => {
  const people: Person[] = [
    {
      id: 'p1',
      name: 'Alice',
      birthYear: 1971,
      birthMonth: 6,
      piaMonthlyAtFraIfWorkingTo62: 4000,
      piaMonthlyAtFraIfStoppingNow: 3500,
      hasOwnBenefit: true,
    },
  ];

  it('flags a score taken by an older engine, and says what restoring does about it', () => {
    const [warning, ...rest] = planVersionWarnings(
      entry({ score: score({ engineVersion: '1.19.0' }) }),
      { engineVersion: ENGINE, people: [] },
    );
    expect(rest).toEqual([]);
    expect(warning.code).toBe('older_engine');
    expect(warning.message).toContain('Scored by engine 1.19.0; this app runs 1.21.0');
    // The half a history row needs that a cabinet row did not: what the button
    // beside it will do.
    expect(warning.message).toContain('Restoring is safe');
    // It used to end "re-score it before you trust the number", and that advice
    // is now impossible: the recorded figure is a record of what THAT engine
    // said on that day, and nothing overwrites it. What is left is the thing
    // that still works — restore it and the workbench runs it under this one.
    expect(warning.message).not.toMatch(/re-score/i);
    expect(warning.message).toContain('the workbench runs the plan on screen live');
  });

  it('says nothing when the score was taken by the engine that is running', () => {
    expect(planVersionWarnings(entry({ score: score() }), { engineVersion: ENGINE, people: [] })).toEqual(
      [],
    );
    // And nothing at all about an engine for a version that was never scored:
    // there is no number to be incomparable with.
    expect(planVersionWarnings(entry(), { engineVersion: ENGINE, people: [] })).toEqual([]);
  });

  it('says nothing about 72(t) when the version and the plan on screen agree', () => {
    // THE CABINET'S VERSION OF THIS WARNING FIRED ON EVERYTHING. Its rule was
    // "no autoSepp field and somebody retires early", and autoSeppPatch(true)
    // deliberately CLEARS the field — absent already means on — so every plan
    // this app writes with the bridge switched on looks identical to a file
    // that never heard of it. Run against the user's real history it warned
    // on three rows out of three, about a default he chose.
    const early = plan({ events: [{ type: 'retire', person: 'p1', date: '2029-06' }] });
    expect(
      planVersionWarnings(entry({ plan: early }), {
        engineVersion: ENGINE,
        people,
        currentPlan: early,
      }),
    ).toEqual([]);
    // And nothing at all when there is no plan on screen to disagree with.
    expect(
      planVersionWarnings(entry({ plan: early }), { engineVersion: ENGINE, people }),
    ).toEqual([]);
  });

  it('flags the 72(t) bridge when restoring would flip it ON', () => {
    // Alice turns 59.5 in 2031, so the penalty-free year is 2032; retiring in
    // 2029 means the bridge decides whether pre-59½ IRA draws pay the penalty.
    const early = plan({ events: [{ type: 'retire', person: 'p1', date: '2029-06' }] });
    const [warning, ...rest] = planVersionWarnings(entry({ plan: early }), {
      engineVersion: ENGINE,
      people,
      currentPlan: plan({ ...early, autoSepp: false }),
    });
    expect(rest).toEqual([]);
    expect(warning.code).toBe('auto_sepp_differs');
    expect(warning.message).toContain('ON in this version and OFF in the plan on screen');
    expect(warning.message).toContain('Alice');
    expect(warning.message).toContain('Restoring turns the bridge back on');
  });

  it('flags it the other way round too, and says which way', () => {
    const early = plan({ events: [{ type: 'retire', person: 'p1', date: '2029-06' }] });
    const [warning] = planVersionWarnings(entry({ plan: { ...early, autoSepp: false } }), {
      engineVersion: ENGINE,
      people,
      currentPlan: early,
    });
    expect(warning.code).toBe('auto_sepp_differs');
    expect(warning.message).toContain('OFF in this version and ON in the plan on screen');
    expect(warning.message).toContain('start paying the 10% penalty');
  });

  it('stays quiet when the setting differs but has nothing to bridge', () => {
    // Nobody stops working before their own penalty-free year, so the toggle
    // is inert and flipping it changes no number. A warning here would be a
    // sentence about a difference that makes none.
    const late = plan({ events: [{ type: 'retire', person: 'p1', date: '2035-06' }] });
    expect(
      planVersionWarnings(entry({ plan: late }), {
        engineVersion: ENGINE,
        people,
        currentPlan: plan({ ...late, autoSepp: false }),
      }),
    ).toEqual([]);
  });

  it('drops the cabinet’s other four rather than re-pointing them at a version', () => {
    // metrics_stale / metrics_inputs_changed were about a cabinet record's own
    // metrics block; legacy_shape about a file format there is none of; and
    // carries_solver about the removed sweep UI — the scorer and the workbench
    // both strip a solver before running, so a stored one changes no number
    // anyone sees.
    const withSolver = plan({ solver: { type: 'max_spend' } });
    expect(planVersionWarnings(entry({ plan: withSolver, score: score() }), {
      engineVersion: ENGINE,
      people: [],
    })).toEqual([]);
  });
});

describe('a chip in a 286px panel is a sentence, not a tag (source scan)', () => {
  it('lets a history chip WRAP, because the longest one does not fit', () => {
    // `.wb-chip` is nowrap for the results panel, whose chips are two words
    // ("first run"). These carry their own conditions —
    // "$64,200/yr sustainable living spend (2,000 paths)" is 48 characters —
    // and the History tab lives in the Inputs panel, which is 286px wide.
    // Left nowrap, that chip ran off the edge of the panel and was cut
    // mid-word: the one number of the three a reader most needs whole, since
    // this household's success rate saturates and the dollars are what tell
    // two versions apart.
    expect(styles).toContain('.hist-score .wb-chip {');
    const rule = styles.slice(styles.indexOf('.hist-score .wb-chip {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('white-space: normal');
  });

  it('still builds that chip out of the figure AND its path count', () => {
    expect(card).toContain('sustainable living spend');
    expect(card).toContain('${score.spendConditions}');
  });
});

describe('the restore question does not promise an undo it cannot give', () => {
  const row = () =>
    historyRows(
      [entry({ id: 'ph-old', takenAt: '2026-08-18T21:41:17.216Z', label: 'Baseline' })],
      rowOpts(),
    )[0];

  it('promises the undo on a day with no restore point yet', () => {
    const text = restorePrompt(row(), [], NOW);
    expect(text).toContain('The plan being replaced is filed first, so this is undoable');
    expect(text).not.toContain('NOT be filed');
  });

  it('says the opposite once today already has one — BEFORE the press, not after', () => {
    // The guard files one entry per day. Restore in the afternoon of a day you
    // have already edited and nothing is filed: today's entry holds THIS
    // MORNING'S plan, so the afternoon's work is simply gone. Saying so after
    // the fact — which restoreOutcome does — is the right sentence in the wrong
    // place; this is the only moment the user can still say no.
    const today = [
      entry({ id: 'ph-today', takenAt: '2026-08-20T10:23:15.156Z', kind: 'day-start' }),
    ];
    const text = restorePrompt(row(), today, NOW);
    expect(text).toContain('will NOT be filed');
    expect(text).toContain('made again');
    expect(text).not.toContain('so this is undoable');
  });

  it('asks the day question the way the server’s guard asks it', () => {
    // kind matters: a KEPT entry never satisfies the day server-side, so it
    // must not make this sentence claim the day is covered either.
    const kept = [entry({ id: 'ph-kept', takenAt: '2026-08-20T10:23:15.156Z', kind: 'kept' })];
    expect(dayIsCovered(kept, NOW)).toBe(false);
    expect(
      dayIsCovered([entry({ id: 'ph-ds', takenAt: '2026-08-20T10:23:15.156Z', kind: 'day-start' })], NOW),
    ).toBe(true);
    // Yesterday's day-start does not cover today.
    expect(
      dayIsCovered([entry({ id: 'ph-y', takenAt: '2026-08-19T10:23:15.156Z', kind: 'day-start' })], NOW),
    ).toBe(false);
  });
});

describe('the tab’s wiring (source scan)', () => {
  it('is in the panel’s strip and renders the card with the live draft', () => {
    expect(panel).toContain("{ id: 'history', label: 'History' }");
    expect(panel).toContain("tab === 'history' && (");
    expect(panel).toContain('<PlanHistoryCard');
    // The DRAFT, not the file: the autosave is debounced 400ms, so a match
    // computed from disk would put the badge on the wrong row for that long
    // after every keystroke.
    expect(panel).toContain('plan={draft}');
  });

  it('never restores on the first press — the row asks first', () => {
    // The plain button only opens the question; the call itself lives inside
    // the confirming branch.
    expect(card).toContain('onClick={onAskRestore}');
    expect(card).toContain('{confirming ? (');
    // The list and the clock go in, because whether the undo it promises will
    // actually exist is a fact about the list (see restorePrompt).
    expect(card).toContain('restorePrompt(row, entries ?? [], new Date())');
    expect(card).toContain('Keep the plan on screen');
    expect(card).toContain('api.restorePlan(row.entry.id)');
    // One call site, and it is `restore`, which is only reachable from the
    // confirmed button.
    expect(card.match(/api\.restorePlan\(/g)).toHaveLength(1);
  });

  it('re-reads the list before saying what the restore did', () => {
    // The undo sentence is a fact about the two lists, not a promise repeated
    // from the button.
    expect(card).toContain('const idsBefore = (entries ?? []).map((e) => e.id)');
    expect(card).toContain('restoreOutcome(res.restoredFrom, idsBefore, after, new Date())');
    expect(card).toContain('onRestored(res.plan)');
    // And it is only AMBER in the case where the button's promise did not
    // hold. Dressing a restore that did exactly what it said as a warning
    // teaches the user to ignore the one that really is one.
    expect(card).toContain("filed: after.some((e) => !idsBefore.includes(e.id))");
    expect(card).toContain("outcome.filed ? 'hist-outcome' : 'lib-warning warn'");
  });

  it('scores a version through the version route, not the snapshot one', () => {
    expect(card).toContain('api.scorePlanVersion(id)');
    expect(card).toContain('api.planVersionsScoring()');
    expect(card).not.toContain('rescoreNetWorthSnapshot');
    // The button that used to sit on a scored row is gone, and the decision
    // about which rows get one lives in scoringOffer rather than in a chain of
    // ternaries here.
    // The LABEL, not the phrase: the module comment quotes the user's
    // objection ("Score it again undermines take a snapshot") and that sentence
    // is the reason the button went, so banning the words outright would delete
    // the record of why.
    expect(card).not.toContain("'Score it again'");
    expect(card).not.toMatch(/>\s*Score it again\s*</);
    expect(card).toContain('scoringOffer(score)');
    expect(card).toContain('{offer !== null && (');
    // "scoring…" comes from the server's own memory, never from a stored flag:
    // a persisted one would survive a restart the run did not.
    expect(card).toContain('setScoringIds([...scoringRef.current.filter((x) => x !== id), id])');
  });

  it('stops polling the moment nothing is running', () => {
    // An idle History tab makes no requests at all.
    expect(card).toContain('const idle = scoring.length === 0');
    expect(card).toContain('if (idle) return;');
  });

  it('hands a restored plan to the workbench WITHOUT marking it saved', () => {
    // Deliberate: an autosave fired inside the debounce can still be in flight
    // carrying the pre-restore draft. Letting the next PUT fire queues the
    // restored plan behind it on `saveChain`, so the restored plan is what
    // ends up on disk however the two raced. Marking it saved would skip that
    // PUT and leave the file and the screen disagreeing for ever.
    expect(workbench).toContain('const restoredPlan = (plan: Scenario) => {');
    expect(workbench).toContain('onPlanRestored={restoredPlan}');
    expect(workbench).toMatch(/restoredPlan = \(plan: Scenario\) => \{\s*replaceDraft\(plan\);/);
    expect(workbench).not.toMatch(/restoredPlan[\s\S]{0,400}lastSavedKey\.current =/);
  });

  it('has no cabinet, no baseline and no drift line left in the panel', () => {
    // The user's complaint, in three strings: the button he pressed, the
    // amber sentence it produced, and the origin line above the tab strip.
    expect(panelCode).not.toContain('Make this the baseline');
    expect(panelCode).not.toContain('Is the baseline');
    expect(panelCode).not.toContain('The plan on screen is not this plan');
    expect(panelCode).not.toContain('OriginLine');
    expect(panelCode).not.toContain('originStatusText');
    expect(panelCode).not.toContain('Save this plan');
    expect(panelCode).not.toContain("id: 'saved'");
  });
});
