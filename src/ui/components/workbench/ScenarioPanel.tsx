/**
 * The Workbench's left panel: every knob, on eight tabs.
 *
 * THERE IS ONE LIVE PLAN AND IT SAVES ITSELF. No scenario picker, no dirty
 * flag, no Save / Revert: every committed change re-runs the simulation AND
 * writes plan.json (WorkbenchPage owns both, on one debounce). The panel shows
 * NOTHING of that while it works — a quiet line reading "Saved — every change
 * writes itself to plan.json" used to sit above the tabs and the user asked
 * for it gone, along with the "Inputs" heading over it and the collapse control
 * beside it. A FAILED write still raises a banner, because that is the one
 * state nothing else in the app would ever mention.
 *
 * THE HISTORY TAB DOES NOT CHANGE THAT. It holds every version this plan has
 * been — filed by the server on the first change of each day, so a week of
 * editing leaves a week of recoverable decisions — and restoring one copies it
 * forward onto the same one plan, which then re-runs like any other edit. There
 * is still exactly one plan in flight; what there is now is a way back.
 *
 * IT REPLACED A "SAVED" TAB the user called a hot mess. That tab carried two
 * concepts at once (a cabinet of named copies, and a separately frozen
 * "baseline plan" that the Net Worth page scored instead of the live one), and
 * the amber line he quoted — "The plan on screen is not this plan" — was the
 * second concept trying to explain itself in the first one's space. Both are
 * gone. A version is a version, and the only question a row answers about the
 * plan on screen is whether it IS this one.
 *
 * TABS, NOT FOLDS. Every section used to be a `<details>`, four of them open by
 * default, which made the panel a single column several screens tall: reaching
 * the assumptions meant scrolling past every spending field, and a fold you
 * collapsed to shorten the column was a fold you then forgot was there. Tabs
 * give each group the whole panel and cost exactly one click to switch. The
 * three folds nobody opened per session — assumption overrides, run settings
 * and raw JSON — collapse into ONE "Settings" tab, stacked, because they are
 * all "how the run behaves" rather than "what the plan is".
 *
 * The selection persists in localStorage, like the results column's tabs and
 * the Profile page's, so a reload comes back to the tab you were working in.
 *
 * THE SAVE FAILURE SITS OUTSIDE THE TABS, directly under the strip. It is the
 * only thing that would ever tell the user their edits have stopped reaching the
 * disk, and a warning that could be one tab away from the field that just
 * changed would be no warning at all. UNDER the strip rather than over it
 * because the tab row is the line the eye reads across to the results tabs
 * opposite (see the alignment note on the strip below): a banner above it would
 * push the left half of that line down on exactly the day something broke.
 *
 * The cards themselves are unchanged — PlanCard / SpendingCard / IncomeCard /
 * EventsCard / OverridesCard already take props and call onChange, so this is a
 * container, not a re-implementation. HousingCard is the one new one, and it
 * edits `scenario.housing` rather than events (see HousingCard.tsx).
 */
import { useState } from 'react';
import type {
  Profile,
  RunMode,
  RunResult,
  Scenario,
  SocialSecurityData,
} from '../../../shared/types';
import { EventsCard } from '../scenarios/EventsCard';
import { OverridesCard } from '../scenarios/OverridesCard';
import { PlanCard } from '../scenarios/PlanCard';
import {
  autoSeppPatch,
  parseScenarioText,
  scenarioToText,
  type MarketDefaults,
} from '../scenarios/scenarioHelpers';
import { InfoTip } from '../profile/fields';
import { HousingCard } from './HousingCard';
import { IncomeCard } from './IncomeCard';
import { PlanHistoryCard } from './PlanHistoryCard';
import { SpendingCard } from './SpendingCard';
import { TithingCard } from './TithingCard';
import { saveFailureText, type RunSettings, type SaveState } from './workbenchLogic';

export interface ScenarioPanelProps {
  /** The one plan, live: edits are applied here and saved from here. */
  draft: Scenario;
  saveState: SaveState;
  /** Re-PUT after a failed save — the only manual write left in the app. */
  onRetrySave: () => void;
  profile: Profile;
  ssData: SocialSecurityData | null;
  marketDefaults: MarketDefaults | null;
  /**
   * Bumped whenever the draft is replaced wholesale (load / raw apply) so the
   * cards holding their own field state remount.
   */
  revision: number;
  runSettings: RunSettings;
  onRunSettingsChange: (next: RunSettings) => void;
  onChange: (patch: Partial<Scenario>) => void;
  onReplace: (scenario: Scenario) => void;
  /**
   * A stored version has just been copied onto the plan (History tab). Distinct
   * from `onReplace` because the plan is ALREADY on disk when this fires — the
   * server wrote it during the restore — so the page it goes to has a different
   * job to do about saving. See WorkbenchPage.restoredPlan.
   */
  onPlanRestored: (plan: Scenario) => void;
  /** The run on screen — the Housing card traces the last completed one. */
  result: RunResult | null;
}

/*
 * This one tab is deliberately NOT in the URL, unlike the results strip
 * opposite it and the Profile's tabs: /workbench/cashflow names the answer you
 * are reading, which is worth sending someone, while "which knob am I holding"
 * belongs to the machine you are typing on. nav.ts's precedence rule covers it
 * exactly as written — the URL never names it, so storage always decides.
 */
const PANEL_TAB_STORAGE_KEY = 'fplan-inputs-tab';

const PANEL_TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'spending', label: 'Spending' },
  // Directly after Spending, whose giving row points here: the un-tithed pot
  // and the ongoing method are two decisions that outgrew a dropdown cell.
  { id: 'tithing', label: 'Tithing' },
  { id: 'income', label: 'Income' },
  { id: 'housing', label: 'Housing' },
  { id: 'events', label: 'Events' },
  { id: 'settings', label: 'Settings' },
  // Last, and after Settings on purpose: every tab before it edits the plan,
  // and this one is the only one that looks at what the plan USED to be. A
  // history tab sitting between two groups of knobs reads as another knob.
  { id: 'history', label: 'History' },
] as const;

type PanelTabId = (typeof PANEL_TABS)[number]['id'];

function isPanelTabId(v: string | null): v is PanelTabId {
  return v !== null && PANEL_TABS.some((t) => t.id === v);
}

function readStoredPanelTab(): PanelTabId {
  if (typeof localStorage === 'undefined') return 'plan';
  const stored = localStorage.getItem(PANEL_TAB_STORAGE_KEY);
  return isPanelTabId(stored) ? stored : 'plan';
}

export function ScenarioPanel(props: ScenarioPanelProps) {
  const { draft, saveState, onRetrySave, profile, ssData, marketDefaults, revision, onChange } =
    props;

  const [tab, setTab] = useState<PanelTabId>(readStoredPanelTab);
  const selectTab = (id: PanelTabId) => {
    setTab(id);
    if (typeof localStorage !== 'undefined') localStorage.setItem(PANEL_TAB_STORAGE_KEY, id);
  };

  const cardKey = String(revision);

  return (
    <div>
      {/*
        FIRST IN THE COLUMN, ALWAYS. The results column opposite also opens with
        its tab strip, and `.wb-layout` is a grid with `align-items: start`, so
        two strips that are each their column's first child sit on one line
        across the screen with no offset to keep in step. That is the whole
        alignment mechanism, and it only holds while nothing is allowed to
        render above either strip — which is why the save-failure banner below
        sits under this one, and why the run's progress bar opposite does too.
      */}
      <div className="tabs" role="tablist" aria-label="Plan inputs">
        {PANEL_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`wb-input-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`wb-input-panel-${t.id}`}
            className={tab === t.id ? 'tab is-active' : 'tab'}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---------------- did a write fail? ---------------- */}
      <SaveFailure state={saveState} onRetry={onRetrySave} />

      <div
        role="tabpanel"
        id={`wb-input-panel-${tab}`}
        aria-labelledby={`wb-input-tab-${tab}`}
      >
        {/*
          The 72(t) toggle is a plan-level field, not an event, so it commits
          through the same onChange patch path as the overrides — which is what
          makes the live loop re-run and the autosave fire for it (runInputKey
          and planSaveKey both hash the whole plan).
        */}
        {tab === 'plan' && (
          <PlanCard
            key={`plan:${cardKey}`}
            events={draft.events}
            people={profile.people}
            accounts={profile.accounts}
            autoSepp={draft.autoSepp}
            ssData={ssData}
            // The "Bonds are" select edits the same override object the
            // Settings tab's OverridesCard does; both read the draft fresh,
            // and only one tab renders at a time, so there is exactly one
            // writer and no copy to fall out of sync.
            overrides={draft.assumption_overrides}
            onChange={(events) => onChange({ events })}
            onAutoSeppChange={(on) => onChange(autoSeppPatch(on))}
            onOverridesChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />
        )}

        {tab === 'spending' && (
          <SpendingCard
            key={`spend:${cardKey}`}
            profileExpenses={profile.expenses}
            // The policy rows state the month the last paycheck stops (that is
            // when "cancel at retirement" bites), so they need the plan's
            // retire events and who actually draws a salary.
            events={draft.events}
            salaries={profile.income.salaries}
            personNames={Object.fromEntries(profile.people.map((p) => [p.id, p.name]))}
            overrides={draft.assumption_overrides}
            onChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />
        )}

        {/*
          The two giving decisions (the un-tithed pot; the ongoing method),
          each writing its own override through the same onChange path as
          every other card.
        */}
        {tab === 'tithing' && (
          <TithingCard
            key={`tithing:${cardKey}`}
            profileExpenses={profile.expenses}
            overrides={draft.assumption_overrides}
            onChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />
        )}

        {/*
          Same two-column shape as Spending and the same onChange path, so the
          retirement-income knob re-runs and autosaves like every other input.
        */}
        {tab === 'income' && (
          <IncomeCard
            key={`income:${cardKey}`}
            profileIncome={profile.income}
            people={profile.people}
            overrides={draft.assumption_overrides}
            onChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />
        )}

        {/*
          Housing is the one input that is NOT an event: `scenario.housing` is
          plan-level configuration the engine compiles down to sell / rent / buy
          events, so this card patches `housing` and, when the user asks it to,
          the event list as well (to clear the events its plan supersedes).
        */}
        {tab === 'housing' && (
          <HousingCard
            key={`housing:${cardKey}`}
            housing={draft.housing}
            events={draft.events}
            home={profile.home}
            marketDefaults={marketDefaults}
            // For the cash-at-purchase readout: the engine's own funding
            // trace off the last completed run (see HousingCardProps.result).
            result={props.result}
            onChange={(housing) => onChange({ housing })}
            onChangeEvents={(events) => onChange({ events })}
          />
        )}

        {tab === 'events' && (
          <EventsCard
            key={`events:${cardKey}`}
            events={draft.events}
            people={profile.people}
            accounts={profile.accounts}
            ssData={ssData}
            onChange={(events) => onChange({ events })}
          />
        )}

        {/*
          Settings: the three sections that describe how the run behaves rather
          than what the plan is — the assumptions it runs against, the mechanics
          of the run itself, and the file underneath it all.
        */}
        {tab === 'settings' && (
          <>
            <OverridesCard
              key={`over:${cardKey}`}
              overrides={draft.assumption_overrides}
              marketDefaults={marketDefaults}
              onChange={(assumption_overrides) => onChange({ assumption_overrides })}
            />
            <RunSettingsCard {...props} />
            {/*
              NOT keyed by `revision`: applying raw JSON bumps the revision to
              remount the form cards, and remounting the editor you are typing
              in would throw away the text you just applied from.
            */}
            <RawJsonCard draft={draft} onReplace={props.onReplace} />
          </>
        )}

        {/*
          NOT keyed by `revision`, unlike every card above it. The revision
          bumps whenever the draft is replaced wholesale — which is what a
          restore does — and remounting this card on its own restore would
          throw away the sentence saying what the restore just did, at the
          exact moment it is being read.
        */}
        {tab === 'history' && (
          <PlanHistoryCard
            plan={draft}
            profile={profile}
            onRestored={props.onPlanRestored}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save failure
// ---------------------------------------------------------------------------

/**
 * NOTHING, UNTIL A WRITE FAILS. All the save chrome this panel ever had is now
 * this one banner: no heading, no dot, no "Saved" line. A silent failure is
 * still the one thing autosave must never do — nothing else in the app would
 * tell the user that the knobs he is turning have stopped reaching the disk —
 * so the error keeps its banner and its Retry, which is the only manual write
 * left anywhere.
 */
function SaveFailure({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const text = saveFailureText(state);
  if (text === null) return null;
  return (
    <div className="error-banner" role="alert">
      {text}{' '}
      <button onClick={onRetry} style={{ marginLeft: 8 }}>
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run settings
// ---------------------------------------------------------------------------

const MODES: readonly RunMode[] = ['deterministic', 'historical', 'montecarlo'];

function RunSettingsCard({
  profile,
  runSettings,
  onRunSettingsChange,
}: Pick<ScenarioPanelProps, 'profile' | 'runSettings' | 'onRunSettingsChange'>) {
  const s = runSettings;
  const set = (patch: Partial<RunSettings>) => onRunSettingsChange({ ...s, ...patch });

  const toggleFinalQuality = (checked: boolean) => {
    set({
      finalQuality: checked,
      pathsText: String(
        checked ? profile.settings.mcPathsFinal : profile.settings.mcPathsInteractive,
      ),
    });
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Run settings
        <InfoTip
          label="run settings"
          text={
            'How the simulation is executed, not what it simulates: these are NOT part of the ' +
            'plan and are not saved to plan.json.'
          }
        />
      </h2>

      <div className="row">
        <label className="field" style={{ width: 150 }}>
          <span className="field-label">Mode</span>
          <select value={s.mode} onChange={(e) => set({ mode: e.target.value as RunMode })}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {s.mode === 'montecarlo' && (
          <label className="field" style={{ width: 110 }}>
            <span className="field-label">Paths</span>
            <input
              value={s.pathsText}
              inputMode="numeric"
              onChange={(e) => set({ pathsText: e.target.value })}
            />
          </label>
        )}
      </div>

      {s.mode === 'montecarlo' && (
        <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={s.finalQuality}
            onChange={(e) => toggleFinalQuality(e.target.checked)}
          />
          <span>
            Final quality ({profile.settings.mcPathsFinal.toLocaleString('en-US')} paths) — slower,
            steadier
          </span>
        </label>
      )}

      <div className="row">
        <label className="field" style={{ width: 130 }}>
          <span className="field-label">Seed</span>
          <input
            value={s.seedText}
            disabled={!s.seedUnlocked}
            inputMode="numeric"
            onChange={(e) => set({ seedText: e.target.value })}
          />
        </label>
        <span className="field-note">
          <button
            type="button"
            className="link-button"
            onClick={() =>
              set({
                seedUnlocked: !s.seedUnlocked,
                // Re-locking snaps back to the profile seed, so "locked" always
                // means the same stream of futures.
                seedText: s.seedUnlocked ? String(profile.settings.seed) : s.seedText,
              })
            }
          >
            {s.seedUnlocked ? 'Lock to the profile seed' : 'Change the seed'}
          </button>
        </span>
      </div>
      <div className="field-help" style={{ marginTop: 4 }}>
        The seed is held fixed on purpose
        <InfoTip
          label="the fixed seed"
          text={
            'Every live run draws the SAME set of futures, so when a number moves it moved ' +
            'because of your edit, not because the Monte Carlo resampled. Change it deliberately ' +
            'to check that an answer is not an artifact of one draw.'
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw JSON
// ---------------------------------------------------------------------------

/**
 * The plan as it is written to disk. An escape hatch for anything the forms
 * can't express — and the fastest way to lift events out of one of the user's
 * old scenario files and into the plan. Applying replaces the working copy,
 * which re-runs and saves like any other change.
 */
function RawJsonCard({
  draft,
  onReplace,
}: {
  draft: Scenario;
  onReplace: (scenario: Scenario) => void;
}) {
  const [text, setText] = useState(() => scenarioToText(draft));
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While untouched, the textarea mirrors the form edits.
  const shown = edited ? text : scenarioToText(draft);

  const apply = () => {
    const res = parseScenarioText(shown);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setEdited(false);
    onReplace(res.scenario);
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Raw JSON
        <InfoTip
          label="the raw plan"
          text={
            'Exactly what gets written to plan.json. Applying replaces the whole plan, then ' +
            're-runs and saves like any other edit.'
          }
        />
      </h2>
      {error && (
        <div className="error-banner" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      <textarea
        className="raw-json"
        rows={16}
        spellCheck={false}
        value={shown}
        onChange={(e) => {
          setText(e.target.value);
          setEdited(true);
        }}
        style={{ marginTop: 8 }}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={apply} disabled={!edited}>
          Apply
        </button>
        <button
          onClick={() => {
            setEdited(false);
            setError(null);
          }}
          disabled={!edited}
        >
          Discard
        </button>
        <span className="muted">{edited ? 'Unapplied edits' : 'In sync with the form'}</span>
      </div>
    </div>
  );
}
