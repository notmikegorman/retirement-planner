/**
 * The Plan page's left panel: every knob, in eight expand/collapse sections.
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
 * SECTIONS AGAIN, EYES OPEN (the owner's call, 2026-08-30, under the module
 * shell). The panel's history runs folds → tabs → folds: the original
 * `<details>` era failed because FOUR sections opened by default (a column
 * several screens tall) and a collapsed fold vanished from mind; the tab era
 * fixed that but hid seven groups behind one visible label. These sections
 * keep what each era got right — exactly ONE opens by default (Plan), so the
 * column starts short, and all eight headers stay visible as a flat stack, so
 * nothing collapsed is ever out of sight. Sections are MUTUALLY EXCLUSIVE
 * (the owner's revision, same day, after a few hours of independent
 * toggling): opening one closes whichever was open, so the column never
 * grows past one section's content — the accordion behaves like the tabs
 * did, with all the labels showing. The grouping is unchanged from the tab
 * era — overrides, run settings and raw JSON still share the one Settings
 * section, and History stays last because every section above it edits the
 * plan while History looks at what it used to be. The cards' own inner
 * titles are gone (the fold names the card); their InfoTips moved onto the
 * fold headers (SECTION_HINTS).
 *
 * The OPEN SET persists in localStorage (the tab era's single-selection key
 * seeds it on first load), so a reload comes back to the sections you were
 * working in.
 *
 * THE SAVE FAILURE SITS ABOVE THE SECTIONS, first in the column. It is the
 * only thing that would ever tell the user their edits have stopped reaching
 * the disk, and a warning that could be a closed fold away from the field
 * that just changed would be no warning at all. (The tab era pinned it UNDER
 * the strip to keep the two tab bars reading as one line across the screen;
 * with the strip gone there is no line to protect.)
 *
 * The cards themselves are unchanged — PlanCard / SpendingCard / IncomeCard /
 * EventsCard / OverridesCard already take props and call onChange, so this is a
 * container, not a re-implementation. HousingCard is the one new one, and it
 * edits `scenario.housing` rather than events (see HousingCard.tsx).
 */
import { useState, type ReactNode } from 'react';
import type {
  Profile,
  RunMode,
  RunResult,
  Scenario,
  SocialSecurityData,
} from '../../../shared/types';
import { stableStringify } from '../../../shared/util';
import { EventsCard } from '../scenarios/EventsCard';
import { OverridesCard } from '../scenarios/OverridesCard';
import { PLAN_CARD_TIP, PlanCard } from '../scenarios/PlanCard';
import {
  autoSeppPatch,
  corporateFractionOf,
  parseScenarioText,
  scenarioToText,
  type MarketDefaults,
} from '../scenarios/scenarioHelpers';
import { InfoTip } from '../profile/fields';
import { HOUSING_CARD_TIP, HousingCard } from './HousingCard';
import { IncomeCard, INCOME_CARD_TIP } from './IncomeCard';
import { HISTORY_CARD_TIP, PlanHistoryCard } from './PlanHistoryCard';
import { SPENDING_CARD_TIP, SpendingCard } from './SpendingCard';
import { TITHING_CARD_TIP, TithingCard } from './TithingCard';
import {
  PANEL_TABS,
  readStoredOpenSections,
  saveFailureText,
  storeOpenSections,
  type PanelTabId,
  type RunSettings,
  type SaveState,
} from './workbenchLogic';

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

/**
 * One fold: an always-visible header carrying the disclosure state, and the
 * section's cards mounted only while open — closing a section unmounts its
 * content exactly as leaving a tab used to, so the cards' remount-on-revision
 * keys and mount-time field seeding behave as they always have.
 *
 * The header is a BAR, not just the button: the section's InfoTip (the tip
 * that used to sit on the card's now-removed inner title) is itself a
 * focusable role=button, and interactive content may not nest inside a
 * <button> — so the tip sits beside the toggle, inside the same visual row.
 */
function InputSection(props: {
  id: PanelTabId;
  label: string;
  /** The section's InfoTip — the card's old title tip, rehomed. */
  hint?: ReactNode;
  open: boolean;
  onToggle: (id: PanelTabId) => void;
  children: ReactNode;
}) {
  return (
    <section className="wb-section">
      <div className="wb-section-bar">
        <button
          type="button"
          className="wb-section-head"
          id={`wb-input-head-${props.id}`}
          aria-expanded={props.open}
          // Only while the body EXISTS: closed sections unmount their content
          // (deliberate — see above), and aria-controls naming an absent id is
          // an axe violation and a broken relationship for a screen reader.
          aria-controls={props.open ? `wb-input-panel-${props.id}` : undefined}
          onClick={() => props.onToggle(props.id)}
        >
          <svg
            className="wb-section-chevron"
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="14"
            height="14"
          >
            <path
              d="M5.5 3.5 L10.5 8 L5.5 12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {props.label}
        </button>
        {props.hint}
      </div>
      {props.open ? (
        <div
          className="wb-section-body"
          role="region"
          id={`wb-input-panel-${props.id}`}
          aria-labelledby={`wb-input-head-${props.id}`}
        >
          {props.children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The section-header tips: each card's old inner-title InfoTip, rehomed on
 * the fold that names it (the owner removed the duplicate titles,
 * 2026-08-30). Events explains itself in its own first line, and Settings'
 * three cards keep their sub-titles — neither needs a header tip.
 */
const SECTION_HINTS: Partial<Record<PanelTabId, ReactNode>> = {
  plan: <InfoTip label="the plan" text={PLAN_CARD_TIP} />,
  spending: <InfoTip label="spending" text={SPENDING_CARD_TIP} />,
  tithing: <InfoTip label="tithing" text={TITHING_CARD_TIP} />,
  income: <InfoTip label="income" text={INCOME_CARD_TIP} />,
  housing: <InfoTip label="the housing plan" text={HOUSING_CARD_TIP} />,
  history: <InfoTip label="the plan’s history" text={HISTORY_CARD_TIP} />,
};

export function ScenarioPanel(props: ScenarioPanelProps) {
  const { draft, saveState, onRetrySave, profile, ssData, marketDefaults, revision, onChange } =
    props;

  /*
   * MUTUALLY EXCLUSIVE folds (the owner's call, 2026-08-30, revising the
   * independent toggling this panel launched with): at most ONE section is
   * open — clicking a closed one opens it and closes whichever was open;
   * clicking the open one closes it. Storage keeps the set shape
   * (readStoredOpenSections' contract, with its tab-era seed); a multi-id
   * set stored by the independent era collapses to its first-in-strip-order
   * member here.
   */
  const [openId, setOpenId] = useState<PanelTabId | null>(() => {
    const stored = readStoredOpenSections();
    return PANEL_TABS.find((t) => stored.has(t.id))?.id ?? null;
  });
  const toggle = (id: PanelTabId) => {
    const next = openId === id ? null : id;
    setOpenId(next);
    storeOpenSections(new Set(next === null ? [] : [next]));
  };

  const cardKey = String(revision);
  // Label derived from PANEL_TABS so a rename there cannot leave a call
  // site here reading differently from the stored-order list.
  const section = (id: PanelTabId, children: ReactNode) => (
    <InputSection
      id={id}
      label={PANEL_TABS.find((t) => t.id === id)!.label}
      hint={SECTION_HINTS[id]}
      open={openId === id}
      onToggle={toggle}
    >
      {children}
    </InputSection>
  );

  return (
    <div>
      {/* ---------------- did a write fail? ---------------- */}
      <SaveFailure state={saveState} onRetry={onRetrySave} />

      <div aria-label="Plan inputs" role="group">
        {/*
          The 72(t) toggle is a plan-level field, not an event, so it commits
          through the same onChange patch path as the overrides — which is what
          makes the live loop re-run and the autosave fire for it (runInputKey
          and planSaveKey both hash the whole plan).
        */}
        {section(
          'plan',
          <PlanCard
            key={`plan:${cardKey}`}
            events={draft.events}
            people={profile.people}
            accounts={profile.accounts}
            autoSepp={draft.autoSepp}
            ssData={ssData}
            // The "Bonds are" select edits the same override object the
            // Settings section's OverridesCard does. Sections toggle
            // independently, so BOTH can be mounted at once now — they stay
            // in sync because each is a controlled select reading
            // draft.assumption_overrides fresh on every render; the draft is
            // still the one canonical copy.
            overrides={draft.assumption_overrides}
            onChange={(events) => onChange({ events })}
            onAutoSeppChange={(on) => onChange(autoSeppPatch(on))}
            onOverridesChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />,
        )}

        {section(
          'spending',
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
          />,
        )}

        {/*
          The two giving decisions (the un-tithed pot; the ongoing method),
          each writing its own override through the same onChange path as
          every other card.
        */}
        {section(
          'tithing',
          <TithingCard
            key={`tithing:${cardKey}`}
            profileExpenses={profile.expenses}
            overrides={draft.assumption_overrides}
            onChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />,
        )}

        {/*
          Same two-column shape as Spending and the same onChange path, so the
          retirement-income knob re-runs and autosaves like every other input.
        */}
        {section(
          'income',
          <IncomeCard
            key={`income:${cardKey}`}
            profileIncome={profile.income}
            people={profile.people}
            overrides={draft.assumption_overrides}
            onChange={(assumption_overrides) => onChange({ assumption_overrides })}
          />,
        )}

        {/*
          Housing is the one input that is NOT an event: `scenario.housing` is
          plan-level configuration the engine compiles down to sell / rent / buy
          events, so this card patches `housing` and, when the user asks it to,
          the event list as well (to clear the events its plan supersedes).
        */}
        {section(
          'housing',
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
          />,
        )}

        {section(
          'events',
          <EventsCard
            /*
              Keyed by the EVENTS VALUE. The card's open editor saves by the
              index it captured at Edit-click; the Plan card (writePlan
              filters and reorders the whole array) and the Housing card
              (clears superseded events) could rewrite events while it sat
              open — a save would then land on the wrong row. Mutually
              exclusive sections make that co-mount impossible today, but
              the guard stays (the panel has flipped fold semantics once
              already): a value-keyed remount closes the editor on any
              outside write, its own saves remount too (the editor closes on
              save anyway), and form typing writes nothing, so no remount
              interrupts it.
            */
            key={`events:${cardKey}:${stableStringify(draft.events)}`}
            events={draft.events}
            people={profile.people}
            accounts={profile.accounts}
            ssData={ssData}
            onChange={(events) => onChange({ events })}
          />,
        )}

        {/*
          Settings: the three sections that describe how the run behaves rather
          than what the plan is — the assumptions it runs against, the mechanics
          of the run itself, and the file underneath it all.
        */}
        {section(
          'settings',
          <>
            <OverridesCard
              /*
                Keyed by the SHARED corporate-share dial, the one field this
                card and the Plan card both edit. Sections are mutually
                exclusive now, so the two cards no longer co-mount — but the
                guard stays: it costs nothing, the panel has flipped between
                independent and exclusive folds once already (both on
                2026-08-30), and the stale-buffer clobber it closes is real
                whenever they DO mount together. Same for the commit-time
                passthrough re-read inside OverridesCard.commit. Deliberately
                NOT keyed by the whole overrides value: that remounted the
                card on its own every committing blur, which threw keyboard
                focus away mid-tab-through.
              */
              key={`over:${cardKey}:${String(corporateFractionOf(draft.assumption_overrides) ?? 'unset')}`}
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
          </>,
        )}

        {/*
          NOT keyed by `revision`, unlike every card above it. The revision
          bumps whenever the draft is replaced wholesale — which is what a
          restore does — and remounting this card on its own restore would
          throw away the sentence saying what the restore just did, at the
          exact moment it is being read.
        */}
        {section(
          'history',
          <PlanHistoryCard plan={draft} profile={profile} onRestored={props.onPlanRestored} />,
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
