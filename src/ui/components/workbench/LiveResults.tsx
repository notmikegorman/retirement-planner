/**
 * The Workbench's right column: the answer, and how far it moved.
 *
 * Two rules govern this component:
 *
 *  1. It NEVER blanks. While a run is in flight the previous render stays on
 *     screen, dimmed, under a slim progress bar — the numbers you are comparing
 *     against must not vanish the moment you change a field.
 *  2. Every headline number carries a DELTA against the comparison run: the
 *     pinned baseline when one is pinned, otherwise the immediately previous
 *     run. "52.5%" answers nothing on its own; "52.5%, +12.8 pts" answers what
 *     the last edit was worth.
 *  3. Every headline number also carries ITS OWN CONDITIONS, at the top of the
 *     Summary card rather than in small text at the foot of it. A 1,000-path
 *     run and a 10,000-path one differ by about a point on this profile with
 *     nothing whatever having changed, and until the run said which it was the
 *     user had no way to tell that point from the plan moving.
 */
import type { FanChart, Profile, RunResult, Scenario } from '../../../shared/types';
import { deriveExpenseStreams } from '../../../shared/expenses';
import { formatPct } from '../../../shared/util';
import {
  FIRST_RUN_BODY,
  FIRST_RUN_HEADLINE,
  ZERO_SPEND_CONDITION,
  simulationReadiness,
} from '../../firstRun';
import { RESULTS_TAB_IDS, type ResultsTabId } from '../../nav';
import { CashflowTable } from '../results/CashflowTable';
import { CharitableLegacyCard } from '../results/CharitableLegacyCard';
import { ExploreCard } from '../results/ExploreCard';
import { FanChartCard } from '../results/FanChartCard';
import { MagiChartCard } from '../results/MagiChartCard';
import { TitheCard } from '../results/TitheCard';
import { WidowCard } from '../results/WidowCard';
import { WithdrawalRateCard } from '../results/WithdrawalRateCard';
import { WorstDecileCard } from '../results/WorstDecileCard';
import { formatElapsed, runVerdict, successClass } from '../results/resultsData';
import { DeltaChip } from './DeltaChip';
import {
  alignBaselineP50,
  comparableRun,
  comparisonNote,
  computeDeltas,
  runMetrics,
  runComputedAt,
  runNowButtonText,
  runNowBusy,
  runQualityLabel,
  successPrecision,
  type ResolvedRunParams,
  type RunMetrics,
  type RunNowState,
} from './workbenchLogic';

export interface PinnedBaseline {
  /** How the baseline is named in the chips and on the chart legend. */
  label: string;
  metrics: RunMetrics;
  fan: FanChart;
}

export interface LiveResultsProps {
  /** The most recent finished run; null only before the first one lands. */
  result: RunResult | null;
  /** The immediately previous run's metrics (used when nothing is pinned). */
  previous: RunMetrics | null;
  baseline: PinnedBaseline | null;
  /** Success target the verdict is phrased against (scenario override wins). */
  target: number;
  running: boolean;
  progress: number;
  error: string | null;
  onRetry: () => void;
  onPinBaseline: () => void;
  onClearBaseline: () => void;
  profile: Profile;
  /** The plan as it currently stands, so Explore can sweep against it. */
  plan: Scenario;
  /** What the live loop is actually sending — Explore and Widow run on it too. */
  runParams: ResolvedRunParams;
  /**
   * Refresh every holdings price, then re-run at final quality on the profile
   * seed. WorkbenchPage owns it; this column only draws the button, because
   * this column is where the number it changes lives.
   */
  onRunNow: () => void;
  runNow: RunNowState;
  /** Which view is on screen — the URL's second segment; see WorkbenchPage. */
  tab: ResultsTabId;
  onSelectTab: (id: ResultsTabId) => void;
  /**
   * ZERO-START'S GATE, decided by WorkbenchPage (simulationReadiness): with
   * no accounts there is nothing to simulate, so `result` arrives null, no
   * run is ever started, and the tabpanel renders the first-run state — what
   * is missing and where to add it — instead of a waiting message that would
   * never come true.
   */
  firstRun: boolean;
  /** The first-run state's one action: the Accounts module. */
  onOpenAccounts: () => void;
}

/**
 * The right column's tabs.
 *
 * Six stacked panels meant everything below the first was a scroll away, and
 * each one got a third of the width it wanted. Tabs give each its own page.
 *
 * The selection is deliberately NOT derived from the run: it is the second
 * segment of the URL (/workbench/cashflow), with localStorage behind it for a
 * bare /workbench — so changing an input on the left re-runs the simulation
 * underneath whichever tab you are reading, reloading puts you back on it, and
 * the view you are looking at is a link you can send. A tab that reset to
 * "Outlook" on every keystroke would make the MAGI and Tithing views unusable
 * for exactly the iterative work they exist for.
 *
 * WorkbenchPage resolves it (it is the component holding the route) and passes
 * it down; the order and the ids are RESULTS_TAB_IDS in nav.ts, which explains
 * why Widow sits second. These are the labels.
 */
const TAB_LABELS: Record<ResultsTabId, string> = {
  summary: 'Summary',
  widow: 'Widow',
  outlook: 'Outlook',
  tithing: 'Tithing',
  taxes: 'Taxes',
  cashflow: 'Cashflow',
  explore: 'Explore',
};

export function LiveResults(props: LiveResultsProps) {
  const { result, running, progress, error, onRetry, tab, onSelectTab } = props;

  return (
    <div>
      {/*
        FIRST IN THE COLUMN, ALWAYS — and therefore drawn here rather than inside
        ResultsBody, which only renders once a run has landed. The progress bar
        and the error banner render UNDER this strip: the bar used to sit above
        it and pushed the whole right-hand column, tabs and all, 15px down and
        back on every debounce.

        Dressed as .modalTabBar — the underline strip every other tabbed view
        wears (Net worth, Settings, Tithing…) — since the owner asked the two
        styles to stop diverging (2026-08-30). The inputs panel opposite is
        expand/collapse sections now, so there is no second strip to align with.
      */}
      <nav className="modalTabBar" role="tablist" aria-label="Results views">
        {RESULTS_TAB_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`wb-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`wb-panel-${id}`}
            className={tab === id ? 'modalTabBtn isActive' : 'modalTabBtn'}
            onClick={() => onSelectTab(id)}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </nav>

      {/*
        The bar keeps its 3px slot whether or not a run is in flight. It occupies
        its own row rather than overlaying the cards, so it can never cover a
        number the user is mid-read; reserving the row when idle is what stops
        the results below it hopping every time the 400ms debounce fires.
      */}
      {running ? (
        <div className="wb-progress is-running" aria-label="Simulating">
          <div style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
        </div>
      ) : (
        <div className="wb-progress" aria-hidden="true" />
      )}

      {error && (
        <div className="error-banner">
          {error}{' '}
          <button onClick={onRetry} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      )}

      <div role="tabpanel" id={`wb-panel-${tab}`} aria-labelledby={`wb-tab-${tab}`}>
        {props.firstRun ? (
          /*
           * The first-run state, on EVERY tab: each of these views is a view
           * of a simulation, and there is deliberately none. No percentage,
           * no median, no chart — a 0-account simulation is a fiction, and
           * this card says so instead (src/ui/firstRun.ts has the predicate
           * and the argument).
           */
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{FIRST_RUN_HEADLINE}</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              {FIRST_RUN_BODY}
            </p>
            <button className="primary" onClick={props.onOpenAccounts}>
              Add your accounts
            </button>
          </div>
        ) : !result ? (
          <div className="card muted">
            {running
              ? 'Running the first simulation…'
              : 'Change anything on the left and the results appear here.'}
          </div>
        ) : (
          <div className={running ? 'wb-stale' : undefined}>
            <ResultsBody {...props} result={result} />
          </div>
        )}
      </div>
    </div>
  );
}

function ResultsBody({
  result,
  previous,
  baseline,
  target,
  onPinBaseline,
  onClearBaseline,
  profile,
  plan,
  runParams,
  running,
  onRunNow,
  runNow,
  tab,
}: LiveResultsProps & { result: RunResult }) {
  const current = runMetrics(result);
  const candidate = baseline ? baseline.metrics : previous;
  // A 1,000-path run set against a 10,000-path one reports the path count, not
  // the plan — see comparableRun. Dropping the comparison here rather than in
  // the chips keeps ONE decision about it, which the note below then explains.
  const comparison = comparableRun(current, candidate);
  const mismatched = candidate !== null && comparison === null;
  const deltas = computeDeltas(current, comparison);
  const verdict = runVerdict(result, target);
  const gauge = successClass(result.success, target);

  const annualSpend =
    (effectiveSpend(profile, plan, 'livingMonthly') +
      effectiveSpend(profile, plan, 'charitableMonthly')) *
    12;

  const baselineSeries = baseline
    ? {
        label: `baseline — ${baseline.label}`,
        values: alignBaselineP50(result.fan.years, baseline.fan),
      }
    : undefined;

  const survivorRun = survivorRunYear(result);

  return (
    /*
     * The tab strip and the tabpanel wrapper are LiveResults' own — see the
     * alignment note there for why they cannot live in here.
     */
    <>
      {/*
        Summary is the answer to the question the workbench asks — does this
        plan work, and what did the last edit do to it — and it is the tab the
        app opens on. It is also the only tab that says what run produced the
        numbers, so the provenance line has one home rather than five.
      */}
      {tab === 'summary' && (
        <>
          <div className="card">
            {/*
              THE BUTTON LIVES WITH THE NUMBER IT RECOMPUTES. Every other tab is
              a different view of this same run, so a Run now pressed from
              Cashflow would be pressed away from the one figure it visibly
              changes; and the label beside it has to sit where the eye lands
              BEFORE the headline, because the whole failure it fixes is reading
              93.1% and 94.2% as two facts about one plan.
            */}
            <RunNowBar
              result={result}
              profile={profile}
              onRunNow={onRunNow}
              runNow={runNow}
            />
            {/*
              A plan carrying a `death` event does not have a household score
              at all — the number below IS a widow score, and "this plan works
              in 76.5% of futures" would be a materially different claim from
              the one the reader takes from it. The engine reports the death
              per year (YearRow.survivor), so this is read off the run rather
              than guessed at from the draft the panel happens to be holding.

              `.lib-warning warn` is the app's boxed-warning class, the same one
              the History tab and the Search page use. It was `.field-help warn`
              — unboxed help text at 12px against those boxes' 12.5px — which
              made the one warning on the results side the only one in the app
              at a different size from its counterpart in the panel.
            */}
            {survivorRun !== null && (
              <div className="lib-warning warn" style={{ marginTop: 0, marginBottom: 10 }}>
                This plan contains a death in {survivorRun.year}, so everything below is the
                SURVIVOR’s plan, not the household’s — one person filing single from{' '}
                {survivorRun.year + 1}. Use the Widow tab to compare the two properly; delete the
                death event on the Events tab to get the household back.
              </div>
            )}
            {/*
              THE ZERO-SPEND CONDITION (zero-start's annotate half — see
              src/ui/firstRun.ts): a household with accounts but $0/mo of
              recorded spending spends only what the law charges (taxes;
              Medicare premiums from 65) — usually a flattering score, though
              not always a passing one, since statutory charges can outlast a
              small balance. The number is a true statement about the inputs,
              so it renders — but it renders WITH its condition, in the same
              slot and voice as the survivor warning above, because a
              flattering fantasy read as a verdict is exactly the misreading
              this app exists to prevent.
            */}
            {(() => {
              const readiness = simulationReadiness(profile);
              // Both facts, deliberately: the PROFILE records no spending AND
              // this run's effective spend (plan overrides included) is $0.
              // A plan override that sets real spending lifts the condition;
              // a what-if override down to $0 over a real budget is the
              // user's own typed experiment, not this caption's case.
              const zeroSpendRun =
                readiness.state === 'ready' && readiness.zeroSpend && annualSpend === 0;
              return zeroSpendRun ? (
                <div className="lib-warning warn" style={{ marginTop: 0, marginBottom: 10 }}>
                  {ZERO_SPEND_CONDITION}
                </div>
              ) : null;
            })()}
            <div className={`verdict ${verdict.tone}`}>{verdict.headline}</div>
            {verdict.timing ? (
              <>
                <div className="verdict-timing">{verdict.timing}</div>
                <div className="field-help" style={{ marginTop: 4 }}>
                  {verdict.timingSource === 'worst-decile'
                    ? 'Typical year across the futures that end worst (the bottom tenth by ' +
                      'money left over) — half of those run out before it, half after.'
                    : 'From the single deterministic path — this run has no per-future ' +
                      'insolvency spread.'}
                </div>
              </>
            ) : (
              <div className="verdict-timing muted">
                {result.success >= 1
                  ? 'No simulated future ran out of money before the horizon.'
                  : 'No simulated future ran out of money — what falls short is the amount left ' +
                    'at the horizon, against the terminal-value floor in your settings.'}
              </div>
            )}
          </div>

          <div className="card">
            <div className="wb-metrics">
              {deltas.map((d) => (
                <DeltaChip
                  key={d.key}
                  delta={d}
                  valueClass={d.key === 'success' ? gauge : undefined}
                  methodMismatch={mismatched}
                />
              ))}
              <div style={{ minWidth: 150 }}>
                <div className="metric-label">Target</div>
                <div className="wb-metric-value">{formatPct(target, 0)}</div>
                <span className="wb-chip">{formatElapsed(result.elapsedMs)} per run</span>
              </div>
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <span className="muted">
                {comparisonNote(baseline ? baseline.label : null, previous !== null, mismatched)}
              </span>
              <span className="spacer" />
              <button onClick={onPinBaseline} disabled={running}>
                {baseline ? 'Pin this run instead' : 'Pin as baseline'}
              </button>
              {baseline && <button onClick={onClearBaseline}>Clear baseline</button>}
            </div>
            <div className="field-help" style={{ marginTop: 6 }}>
              {baseline
                ? 'Every change is measured from the pinned run, so a dozen small tweaks still ' +
                  'report their combined effect.'
                : 'Without a pin, changes are measured from the run just before this one. Pin a ' +
                  'run to keep measuring from a fixed reference.'}
            </div>
            {/*
              The audit trail, still at the foot of the card where an audit
              trail belongs. What this run WAS is stated at the top now; this is
              the run key you would quote to reproduce it.

              Read entirely off `result.meta`, never off `runParams`: Run now
              forces Monte Carlo at final quality whatever the Settings tab
              says, and gating the path count on `runParams.paths` hid it on
              exactly the run whose path count is the interesting fact.
            */}
            <div className="muted" style={{ marginTop: 10 }}>
              {result.meta.mode}
              {result.meta.mode === 'montecarlo' ? ` · ${result.meta.paths} paths` : ''} · seed{' '}
              {result.meta.seed} · run {result.meta.runKey.slice(0, 8)}
            </div>
          </div>

          {/*
            The shape behind the withdrawal tile: the same arithmetic
            (withdrawalRateSeries feeds both), every fully retired year.
            Below the tiles because the tile states the number and the chart
            shows what it does over time. The Social Security marker reads
            the PLAN's claim events — the claiming decision as currently
            edited is the decision the marker exists to anchor.
          */}
          <WithdrawalRateCard referencePath={result.referencePath} events={plan.events} />
        </>
      )}

      {/*
        The survivor's side of the same question. It runs on its own button
        rather than off the live loop — one full simulation per death year is
        not something to spend on every keystroke — so it takes the plan and
        the run settings and does the rest itself.
      */}
      {tab === 'widow' && (
        <WidowCard
          profile={profile}
          plan={plan}
          target={target}
          runParams={runParams}
          disabled={running}
        />
      )}

      {tab === 'outlook' && (
        <>
          <FanChartCard fan={result.fan} baselineSeries={baselineSeries} />
          {result.meta.mode !== 'deterministic' && (
            <WorstDecileCard hist={result.worstDecileShortfallYears} />
          )}
        </>
      )}

      {tab === 'tithing' && (
        <>
          <TitheCard result={result} />
          <CharitableLegacyCard
            charitableLegacy={result.charitableLegacy}
            breakGlassReal={result.breakGlassReal}
          />
        </>
      )}

      {tab === 'taxes' && <MagiChartCard referencePath={result.referencePath} />}

      {tab === 'cashflow' && (
        <CashflowTable
          referencePath={result.referencePath}
          accountNames={Object.fromEntries(profile.accounts.map((a) => [a.id, a.name]))}
        />
      )}

      {tab === 'explore' && (
        <ExploreCard
          plan={plan}
          target={target}
          annualSpend={annualSpend}
          runParams={runParams}
          disabled={running}
        />
      )}
    </>
  );
}

/**
 * WHAT THIS RUN IS, AND THE BUTTON THAT MAKES IT THE RECORDED KIND.
 *
 * The Workbench runs at `mcPathsInteractive` while knobs move, because a
 * 10,000-path run per keystroke is not a live loop. The History tab and the
 * net-worth ledger record at `mcPathsFinal` on the profile seed. Both are right,
 * and nothing on screen said which you were looking at: the user read 93.1%
 * here against 94.2% recorded for the same plan on the same day and reasonably
 * concluded something had changed. Nothing had. It was 1,000 paths against
 * 10,000.
 *
 * So the chip states the run's own conditions above the headline, and the button
 * beside it refreshes every holdings price and re-runs on the recorded
 * conditions — after which the number IS comparable with the recorded ones,
 * which is the only reason the button exists.
 *
 * AND A SECOND CHIP STATES THE PRECISION, because naming the path count was not
 * enough on its own. "Quick run · 1,000 paths" tells a reader the conditions and
 * leaves the reader to know what 1,000 paths buys; they do not, and neither did the
 * app. It buys ±1.6 points at 95% on a plan scoring in the low nineties, which
 * swallows the whole 1.3-point swing the user reported as a bug. The final run
 * gets the same treatment — ±0.5 points — because a run that states its
 * precision only when the precision is poor teaches the reader that a missing
 * chip means "exact".
 *
 * A failure keeps the previous result on screen and says why underneath. It has
 * its own banner rather than the column's shared one because the column's Retry
 * re-runs the LIVE loop, which would answer a different question from the one
 * that just failed.
 */
function RunNowBar({
  result,
  profile,
  onRunNow,
  runNow,
}: {
  result: RunResult;
  profile: Profile;
  onRunNow: () => void;
  runNow: RunNowState;
}) {
  const label = runQualityLabel(result.meta, profile.settings);
  const precision = successPrecision(result.success, result.meta);
  const computed = runComputedAt(result.meta);
  const busy = runNowBusy(runNow);

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row">
        <span className={label.tone === 'final' ? 'wb-chip good' : 'wb-chip'}>
          {label.headline}
        </span>
        {/*
          NEUTRAL IN BOTH TONES, unlike its neighbour. The conditions chip goes
          green for a final run because being comparable with a recorded score
          is good news. A precision is not good or bad news — it is the grain of
          the instrument — and a green ±0.5 beside a plain ±1.6 would read as a
          verdict on the plan rather than on the run. Absent entirely for a
          deterministic or historical run, which have no sampling error to state.
        */}
        {precision !== null && (
          <span className="wb-chip" title={precision.title}>
            {precision.text}
          </span>
        )}
        {/*
          WHEN, third and last — after what the run is and how precisely it
          measured, because a moment only matters once you know what it is a
          moment of.

          The page prefers a final run already in the cache over computing a
          quick one, so the headline can be a number made at 3:41 PM. Nothing
          said so before, and "Final quality · 10,000 paths" on its own reads as
          a run that just finished. Neutral, like the precision chip: a run's age
          is a fact about the run, not a verdict on the plan, and the input being
          identical is what makes an older one exactly as right.
        */}
        {computed !== null && (
          <span className="wb-chip" title={computed.title}>
            {computed.text}
          </span>
        )}
        <span className="spacer" />
        <button className="primary" onClick={onRunNow} disabled={busy}>
          {runNowButtonText(runNow)}
        </button>
      </div>
      <div className="field-help" style={{ marginTop: 6 }}>
        {label.note}
        {precision !== null && ` ${precision.sentence}`}
      </div>
      {runNow.status === 'error' && (
        <div className="error-banner" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
          {runNow.message}
        </div>
      )}
    </div>
  );
}

/**
 * The year a run's own death happened, or null for an ordinary run.
 *
 * Read from the engine's report (YearRow.survivor is present from the year a
 * `death` event fires and absent entirely otherwise) rather than from the draft
 * plan, so it describes the run whose numbers are on screen — the two differ
 * for the moment between an edit and the run that answers it.
 */
function survivorRunYear(result: RunResult): { year: number } | null {
  const row = result.referencePath.find((r) => r.survivor?.deathYear === true);
  return row ? { year: row.year } : null;
}

/**
 * The monthly figure a sweep should be centered on: the plan's spending
 * override when it has one, else the profile's. Explore's spending curve is
 * built around this, so a plan that already drags spending gets a curve around
 * ITS number rather than the household baseline.
 */
function effectiveSpend(
  profile: Profile,
  plan: Scenario,
  key: 'livingMonthly' | 'charitableMonthly',
): number {
  // Falls back to the DERIVED stream, not the scalar cache the budget rows
  // replace — otherwise Explore centred its spending sweep on $7,100/mo while
  // the run it is exploring around spent $7,340, shifting every point on the
  // curve away from the plan it claims to vary.
  return (
    plan.assumption_overrides?.expenses?.[key] ?? deriveExpenseStreams(profile.expenses)[key]
  );
}
