/**
 * THE WIDOW SCORE — the survivor's probability of success, by year of death.
 *
 * WHY IT IS A CURVE AND NOT A NUMBER. The question it exists for: "if I retire
 * next year with a 95% score but die the year after that, and my spouse is left
 * with a 64% score, that is not good." A single widow figure answers half of
 * that and none of what follows, which is a question about STEERING: does one
 * more working year buy the survivor twelve points, and is a term policy worth
 * its premium until it does? Both answers
 * are gaps between two curves, so the view draws curves and puts the gaps in a
 * column.
 *
 * THREE SERIES, EACH EARNING ITS PLACE:
 *  - the plan as it stands, which is the answer;
 *  - the same plan with the life policy DROPPED, which is what the policy is
 *    worth (the two lines merge in the year coverage lapses — that convergence
 *    is the most useful thing on the chart);
 *  - a PINNED earlier sweep, which is what changing the plan was worth. Pin,
 *    move the retirement date on the left, run again, and "the extra year
 *    bought the survivor twelve points" is a column rather than an act of memory.
 *
 * IT DOES NOT RUN ITSELF. Every other tab re-renders off the live run; this one
 * costs one full simulation per probe and would make every keystroke on the
 * left an eight-second sweep. So it runs on a button, remembers its answer
 * across tab switches (module `session`, the same trick WorkbenchPage uses for
 * the pinned baseline), and says plainly when the plan has moved underneath a
 * result rather than silently showing a stale one.
 *
 * NOTHING HERE MODELS A SURVIVOR. The engine's `widow_score` solver runs the
 * plan once per candidate year with a `death` event in it; a widow score is a
 * normal simulation of a plan that happens to contain a death, held to the
 * household's own success target so the two numbers can be read against each
 * other.
 */
import { useEffect, useRef, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HousingPlan, Profile, Scenario, SolverPoint } from '../../../shared/types';
import { formatPct, formatUSD } from '../../../shared/util';
import { api, pollRun } from '../../api';
import { useChartTheme, type ChartPalette } from '../../theme';
import { InfoTip } from '../profile/fields';
import { solverOverrideNote } from '../scenarios/scenarioHelpers';
import type { ResolvedRunParams } from '../workbench/workbenchLogic';
import { runInputKey } from '../workbench/workbenchLogic';
import { scenarioForPlainRun, scenarioWithSolver, successClass } from './resultsData';
import {
  WIDOW_MAX_POINTS,
  clearsTargetFromYear,
  defaultWidowFields,
  effectivePolicy,
  formatPoints,
  planWithoutPolicy,
  policyVerdict,
  survivorOf,
  weakestPoint,
  widowFieldError,
  widowHeadline,
  widowOutput,
  widowPointCount,
  widowRows,
  survivorDownsizeNote,
  survivorHousingNote,
  survivorShareFromBudget,
  widowSpec,
  yearsBelowTarget,
  type EffectivePolicy,
  type WidowRow,
  type WidowSweepFields,
} from './widowData';

// ---------------------------------------------------------------------------
// Help text — all of it behind a "?" (fields.tsx InfoTip)
// ---------------------------------------------------------------------------

const CARD_TIP =
  'The survivor’s probability of success if the death happened in each year on the chart. It is ' +
  'the same measure as the household score and is held to the same target, which is the only ' +
  'thing that makes the two comparable: a plan at 95% household and 64% widow is a different ' +
  'plan from one at 95% and 91%.';

const WIDOW_PENALTY_TIP =
  'The biggest single effect of the death is not the lost Social Security — it is that the ' +
  'survivor files SINGLE from the year after it. Roughly half the standard deduction, brackets ' +
  'that compress far faster, Social Security taxable from $25,000 rather than $32,000, the ' +
  'investment-income surtax from $200,000 rather than $250,000, single-filer Medicare surcharge ' +
  'tiers, and a one-person poverty level setting the ACA subsidy. Practitioners call it the ' +
  'widow penalty. The lost benefit is real too: the survivor is paid the larger of their own and ' +
  '100% of the deceased’s, so a couple drawing that benefit plus a 50% spousal top-up loses a third of its ' +
  'Social Security permanently, in the same year the tax bill goes up.';

const LIVING_FRACTION_TIP =
  'The share of your LIVING baseline the survivor is modelled to spend — everyday consumption ' +
  'only, since housing and health are modelled separately and are the costs that fall least. ' +
  'There is no primary source for this number and there cannot be: it is a judgment about one ' +
  'household, not a statute. Equivalence scales put two adults at 1.5 consumption units against ' +
  'one (0.67) or at 1/sqrt(2) (0.71); planning practice uses 70-80%. Blank inherits the ' +
  'engine’s 0.75, chosen at the high end on purpose because spending more of the survivor’s money reports ' +
  'a LOWER score, which is the safe direction to be wrong in.';

const LIVING_SHARE_BUDGET_TIP =
  'Summed from your budget\u2019s \u201cIf I die\u201d column, line by line \u2014 not a percentage ' +
  'assumption. Edit it where it is stated: the Expenses page. Lines with no survivor ' +
  'figure inherit their in-force amount, which is the conservative direction.';

const RANGE_TIP =
  'Each year on the chart is a full simulation of this plan with the death in that year, so the ' +
  'range and the step set how long the sweep takes. Two-year steps show the same shape for half ' +
  'the runs; narrow to one year around a date you care about — the year term coverage lapses, ' +
  'say.';

const COMPARE_TIP =
  'Runs the whole sweep a second time with the life policy dropped — no payout AND no premium, ' +
  'because that is the actual decision. The gap between the two lines is what the cover is ' +
  'worth in each year, and the year they merge is the year it runs out.';

const PIN_TIP =
  'Keeps this sweep on the chart while you change the plan on the left and run again. That is ' +
  'how to price a decision against the survivor rather than against the household: pin, move ' +
  'the retirement date, re-run, and read the change off the last column.';

const STALE_NOTE =
  'The plan has changed since this sweep ran, so these numbers describe the earlier one. Run it ' +
  'again to bring them up to date.';

// ---------------------------------------------------------------------------
// What survives a tab switch
// ---------------------------------------------------------------------------

/**
 * A finished sweep, with enough of its context to be honest about later.
 * `planKey` is what makes staleness detectable rather than assumed.
 */
interface WidowSweep {
  points: SolverPoint[];
  /** The companion run with the policy dropped, when one was asked for. */
  dropped: SolverPoint[] | null;
  /** The base plan's own success at full paths — the household number. */
  household: number;
  /** The target both numbers are read against. */
  target: number;
  /** Identity of the plan + run settings this was computed from. */
  planKey: string;
  /** Short human label for the chart legend and the pin chip. */
  label: string;
  policy: EffectivePolicy;
  /**
   * The housing plan THIS sweep ran against, captured like `policy` is: the
   * survivor-price note must describe the runs that produced these points,
   * not whatever the Housing tab says by the time the user reads them.
   */
  housing: HousingPlan | undefined;
}

/**
 * Module-level, like WorkbenchPage's `session`: the tab panel unmounts whenever
 * another results tab is selected, and losing a sweep that cost twenty-six full
 * simulations to a click on "Cashflow" would make the feature unusable for the
 * back-and-forth it exists for.
 */
const session: {
  sweep: WidowSweep | null;
  pinned: WidowSweep | null;
  fields: WidowSweepFields | null;
  compare: boolean;
  /** A failure that landed while the tab was hidden, so it is not lost with it. */
  error: string | null;
} = { sweep: null, pinned: null, fields: null, compare: true, error: null };

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface WidowCardProps {
  profile: Profile;
  /** The plan as it currently stands; the sweep runs against a copy of it. */
  plan: Scenario;
  /** Success target the survivor is held to — the household's own. */
  target: number;
  runParams: ResolvedRunParams;
  /** True while a normal run is in flight — one run at a time. */
  disabled?: boolean;
}

export function WidowCard({ profile, plan, target, runParams, disabled }: WidowCardProps) {
  const [fields, setFields] = useState<WidowSweepFields>(
    () => session.fields ?? defaultWidowFields(profile),
  );
  const [compare, setCompare] = useState(session.compare);
  const [sweep, setSweep] = useState<WidowSweep | null>(session.sweep);
  const [pinned, setPinned] = useState<WidowSweep | null>(session.pinned);
  const [progress, setProgress] = useState<{ frac: number; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(session.error);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    session.fields = fields;
  }, [fields]);
  useEffect(() => {
    session.compare = compare;
  }, [compare]);

  const setField = (patch: Partial<WidowSweepFields>) => setFields((f) => ({ ...f, ...patch }));

  const policy = effectivePolicy(profile, plan);
  const deceased = profile.people.find((p) => p.id === fields.person) ?? null;
  const survivor = fields.person ? survivorOf(profile.people, fields.person) : null;
  // Staleness is tracked against the plan MINUS any solver of its own: this
  // view attaches its own sweep spec, so a solver sitting in plan.json changes
  // nothing about what was run and must not flag a fresh sweep as stale.
  const planKey = runInputKey(scenarioForPlainRun(plan), runParams);
  const fieldError = widowFieldError(fields);
  const running = progress !== null;
  const busy = running || disabled === true;

  const run = async () => {
    if (fieldError) return;
    setError(null);
    session.error = null;
    setProgress({ frac: 0 });
    const spec = widowSpec(fields, profile.expenses);
    const wantDropped = compare && policy.benefit > 0;
    try {
      // Two sweeps at most, run one after the other rather than together: the
      // server runs one simulation at a time anyway, and a shared progress bar
      // that jumps backwards is worse than one that goes round twice.
      const asPlanned = await sweepOnce(scenarioWithSolver(plan, spec), runParams, (frac, message) => {
        if (alive.current) setProgress({ frac: wantDropped ? frac / 2 : frac, ...(message ? { message } : {}) });
      });
      let dropped: SolverPoint[] | null = null;
      if (wantDropped) {
        const out = await sweepOnce(
          // Every LISTED policy must be named for cancellation: the zeroed
          // legacy fields alone are ignored by the engine whenever the profile
          // carries a list, which made this whole second sweep a no-op.
          scenarioWithSolver(
            planWithoutPolicy(
              plan,
              (profile.expenses.lifeInsurancePolicies ?? []).map((p) => p.id),
            ),
            spec,
          ),
          runParams,
          (frac, message) => {
            if (alive.current) {
              setProgress({
                frac: 0.5 + frac / 2,
                ...(message ? { message: `without the policy — ${message}` } : {}),
              });
            }
          },
        );
        dropped = out.points;
      }
      const next: WidowSweep = {
        points: asPlanned.points,
        dropped,
        household: asPlanned.household,
        target,
        planKey,
        label: sweepLabel(asPlanned.household),
        policy,
        housing: plan.housing,
      };
      /*
       * The session is written BEFORE the aliveness check, on purpose. This
       * panel unmounts the moment another results tab is selected, so guarding
       * the write the way the setState below is guarded would throw away
       * twenty-six finished simulations for the crime of clicking "Cashflow"
       * while they ran — the exact loss the session exists to prevent. The
       * component state is what must not be touched after unmount; the module
       * cache is not component state.
       */
      session.sweep = next;
      session.error = null;
      if (alive.current) {
        setSweep(next);
        setError(null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Same reasoning: a failure that happened while the tab was hidden still
      // has to be there when it comes back, or the sweep silently did nothing.
      session.error = message;
      if (alive.current) setError(message);
    } finally {
      if (alive.current) setProgress(null);
    }
  };

  const pin = () => {
    session.pinned = sweep;
    setPinned(sweep);
  };
  const unpin = () => {
    session.pinned = null;
    setPinned(null);
  };

  const stale = sweep !== null && sweep.planKey !== planKey;
  const rows = sweep
    ? widowRows(
        sweep.points,
        survivor,
        sweep.dropped ?? undefined,
        pinned && pinned !== sweep ? pinned.points : undefined,
      )
    : [];

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          Widow score
          <InfoTip label="the widow score" text={CARD_TIP} />
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          What happens to {survivor ? survivor.name : 'the survivor'} if{' '}
          {deceased ? deceased.name : 'the earner'} dies — one full simulation per year on the
          chart, against the plan exactly as it stands.
          <InfoTip label="why the answer moves so much" text={WIDOW_PENALTY_TIP} />
        </p>

        <WidowControls
          profile={profile}
          fields={fields}
          onChange={setField}
          compare={compare}
          onCompare={setCompare}
          policy={policy}
          disabled={busy}
        />

        {fieldError && (
          <div className="field-help warn" style={{ marginTop: 8 }}>
            {fieldError}
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy || fieldError !== null} onClick={() => void run()}>
            {sweep ? 'Run it again' : 'Run the widow score'}
          </button>
          <span className="muted">
            {runCountNote(fields, compare && policy.benefit > 0)}
          </span>
        </div>

        {running && (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <div className="progress-outer">
                <div
                  className="progress-inner"
                  style={{ width: `${Math.round((progress?.frac ?? 0) * 100)}%` }}
                />
              </div>
              <span className="muted" style={{ minWidth: 44, textAlign: 'right' }}>
                {Math.round((progress?.frac ?? 0) * 100)}%
              </span>
            </div>
            {progress?.message && (
              <div className="muted" style={{ marginTop: 6 }}>
                {progress.message}
              </div>
            )}
          </>
        )}

        {!running && disabled === true && (
          <div className="muted" style={{ marginTop: 10 }}>
            Waiting for the current run to finish.
          </div>
        )}

        {error && (
          <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>
            {error}
          </div>
        )}

        {policy.benefit <= 0 && (
          <div className="field-help" style={{ marginTop: 10 }}>
            {/*
              Two sentences because the fix lives in two different places: a
              LIST profile re-instates a policy on the Spending tab's per-policy
              rows (the legacy "add a benefit beside the premium" boxes do not
              even render for it), while a legacy profile still has those boxes.
            */}
            {(profile.expenses.lifeInsurancePolicies ?? []).length > 0
              ? 'No life-insurance payout is in force in this plan: every policy is cancelled ' +
                'or carries no benefit, so there is nothing to compare against. Reinstate one ' +
                'on the Spending tab to make the comparison mean something.'
              : 'No life-insurance payout is in force in this plan, so there is nothing to ' +
                'compare against. Add a death benefit beside the premium — on the Insurance page for ' +
                'the policy you actually hold, or on the Spending tab to try one on this plan ' +
                'only.'}
          </div>
        )}
      </div>

      {sweep && (
        <WidowResult
          sweep={sweep}
          rows={rows}
          pinned={pinned && pinned !== sweep ? pinned : null}
          stale={stale}
          survivorName={survivor ? survivor.name : 'the survivor'}
          canPin={!busy}
          onPin={pin}
          onUnpin={unpin}
          isPinned={pinned === sweep}
        />
      )}
    </>
  );
}

/** Start one sweep and wait for it; throws with the server's message on failure. */
async function sweepOnce(
  scenario: Scenario,
  runParams: ResolvedRunParams,
  onProgress: (frac: number, message?: string) => void,
): Promise<{ points: SolverPoint[]; household: number }> {
  const { runId } = await api.startRun({
    scenario,
    mode: runParams.mode,
    ...(runParams.paths !== undefined ? { paths: runParams.paths } : {}),
    seed: runParams.seed,
  });
  const done = await pollRun(runId, (p) => onProgress(p.progress, p.message));
  if (done.status !== 'done' || !done.result) throw new Error(done.error ?? 'The run failed');
  const out = widowOutput(done.result.solverOutput);
  if (!out) throw new Error('The run finished but produced no widow score.');
  return {
    points: out.points,
    // The solver runs the BASE plan once at full paths for its meta and fan, and
    // that run's success is the household number — the very thing the widow
    // score has to be read against. Taking it from the same result guarantees
    // the two figures came from the same seed and the same path count.
    household: done.result.success,
  };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function WidowControls({
  profile,
  fields,
  onChange,
  compare,
  onCompare,
  policy,
  disabled,
}: {
  profile: Profile;
  fields: WidowSweepFields;
  onChange: (patch: Partial<WidowSweepFields>) => void;
  compare: boolean;
  onCompare: (on: boolean) => void;
  policy: EffectivePolicy;
  disabled: boolean;
}) {
  const budgetShare = survivorShareFromBudget(profile.expenses);
  return (
    <>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="field" style={{ width: 150 }}>
          <span className="field-label">Who dies</span>
          <select
            value={fields.person}
            disabled={disabled}
            onChange={(e) => onChange({ person: e.target.value })}
          >
            {profile.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ width: 100 }}>
          <span className="field-label">
            From
            <InfoTip label="the range of death years" text={RANGE_TIP} />
          </span>
          <input
            inputMode="numeric"
            value={String(fields.from)}
            disabled={disabled}
            onChange={(e) => onChange({ from: Number(e.target.value) })}
          />
        </label>
        <label className="field" style={{ width: 100 }}>
          <span className="field-label">To</span>
          <input
            inputMode="numeric"
            value={String(fields.to)}
            disabled={disabled}
            onChange={(e) => onChange({ to: Number(e.target.value) })}
          />
        </label>
        <label className="field" style={{ width: 110 }}>
          <span className="field-label">Every (years)</span>
          <input
            inputMode="numeric"
            value={String(fields.step)}
            disabled={disabled}
            onChange={(e) => onChange({ step: Number(e.target.value) })}
          />
        </label>
        {budgetShare !== null ? (
          /*
           * READ-ONLY ON PURPOSE, and the editable fraction is gone rather than
           * disabled. With an If-I-die column in the budget, that spending is a
           * SUM the user itemised line by line — one car, so its $610 payment
           * does not fall by a quarter — and a second, coarser knob for the
           * same fact is exactly how the phantom 0.73 overstated every widow
           * score by $8,520/yr — a tenth of a $7,100/mo living baseline, every
           * year of a widowhood. The number is edited where it is stated: the
           * Expenses tab's survivor column.
           */
          <label className="field" style={{ width: 210 }}>
            <span className="field-label">
              Survivor living share
              <InfoTip label="the survivor's living share" text={LIVING_SHARE_BUDGET_TIP} />
            </span>
            <span className="field-static">
              {formatUSD(budgetShare.survivorMonthly)}/mo · {formatPct(budgetShare.share)} of{' '}
              {formatUSD(budgetShare.coupleMonthly)}
            </span>
          </label>
        ) : (
          <label className="field" style={{ width: 150 }}>
            <span className="field-label">
              Survivor living share
              <InfoTip label="the survivor's living share" text={LIVING_FRACTION_TIP} />
            </span>
            <input
              inputMode="decimal"
              placeholder="0.75"
              value={fields.livingFraction === undefined ? '' : String(fields.livingFraction)}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  livingFraction: e.target.value.trim() === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </label>
        )}
      </div>

      <label className="row" style={{ gap: 8, cursor: 'pointer', marginTop: 4 }}>
        <input
          type="checkbox"
          checked={compare}
          disabled={disabled || policy.benefit <= 0}
          onChange={(e) => onCompare(e.target.checked)}
        />
        <span>
          Also run it with the policy dropped
          {policy.benefit > 0 ? ` (${formatUSD(policy.benefit)}${policy.termText})` : ''}
          <InfoTip label="the without-the-policy comparison" text={COMPARE_TIP} />
        </span>
      </label>
    </>
  );
}

function runCountNote(fields: WidowSweepFields, comparing: boolean): string {
  const n = widowPointCount(fields);
  if (n <= 0 || n > WIDOW_MAX_POINTS) return '';
  const total = comparing ? n * 2 : n;
  return `${total} full simulation${total === 1 ? '' : 's'} — considerably slower than one run.`;
}

/**
 * How a sweep is named once it is the PINNED one.
 *
 * Its job is to distinguish two sweeps of the same household, and the thing
 * that differs between them can be anything on the plan — a retirement date, a
 * housing decision, a spending figure. Naming the policy (the first thing tried
 * here) fails exactly when the pin matters most: pin, move the retirement date,
 * run again, and both sweeps are labelled "$1,000,000 cover to 2032-06", which
 * distinguishes nothing. The household score is the one number that moves with
 * every plan change, so it is the discriminator.
 */
function sweepLabel(household: number): string {
  return `household ${formatPct(household, 1)}`;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

function WidowResult({
  sweep,
  rows,
  pinned,
  stale,
  survivorName,
  canPin,
  isPinned,
  onPin,
  onUnpin,
}: {
  sweep: WidowSweep;
  rows: WidowRow[];
  pinned: WidowSweep | null;
  stale: boolean;
  survivorName: string;
  canPin: boolean;
  isPinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const chart = useChartTheme();
  const worst = weakestPoint(sweep.points);
  // "From which year is the survivor safe for good" — scanned backwards from the end, NOT
  // the first year that happens to pass. See clearsTargetFromYear: on a plan
  // with term cover the first passing year is the first year on the chart, and
  // reporting it would advertise safety in exactly the years the policy has
  // lapsed. `below` is what makes "never" legible rather than alarming-and-bare.
  const safeFrom = clearsTargetFromYear(sweep.points, sweep.target);
  const below = yearsBelowTarget(sweep.points, sweep.target);
  const verdict = policyVerdict(rows, sweep.policy);
  // What the pre-purchase probes assumed about the HOUSE — stated in both
  // directions (survivor price set: say it travelled with the number; absent:
  // the honest caveat that the survivor is modelled executing the plan price). Null
  // whenever no probed death precedes a plan-modelled purchase.
  const housingNote = survivorHousingNote(
    sweep.housing,
    sweep.points.map((p) => p.x),
    survivorName,
  );
  // The same contract for probes on the OTHER side of the purchase month:
  // downsize set — say the post-purchase probes sold and rebought (or rented)
  // on the survivor's schedule; absent — the honest caveat that the survivor is
  // modelled keeping the house for good.
  const downsizeNote = survivorDownsizeNote(
    sweep.housing,
    sweep.points.map((p) => p.x),
    survivorName,
  );

  return (
    <div className="card">
      {stale && (
        <div className="field-help warn" style={{ marginTop: 0, marginBottom: 10 }}>
          {STALE_NOTE}
        </div>
      )}

      <div className="wb-metrics">
        <div style={{ minWidth: 150 }}>
          <div className="metric-label">Household</div>
          <div className={`wb-metric-value ${successClass(sweep.household, sweep.target)}`}>
            {formatPct(sweep.household, 1)}
          </div>
          <span className="wb-chip">both alive</span>
        </div>
        <div style={{ minWidth: 150 }}>
          <div className="metric-label">Widow, weakest year</div>
          <div
            className={`wb-metric-value ${worst ? successClass(worst.success, sweep.target) : ''}`}
          >
            {worst ? formatPct(worst.success, 1) : '—'}
          </div>
          <span className="wb-chip">{worst ? `death in ${worst.x}` : ''}</span>
        </div>
        <div style={{ minWidth: 150 }}>
          <div className="metric-label">Gap</div>
          <div className="wb-metric-value">
            {worst ? formatPoints(worst.success - sweep.household) : '—'}
          </div>
          <span className="wb-chip">what the survivor loses</span>
        </div>
        <div style={{ minWidth: 190 }}>
          <div className="metric-label">Safe for good from</div>
          <div className={`wb-metric-value ${safeFrom === null ? 'bad' : 'good'}`}>
            {safeFrom === null ? 'never' : String(safeFrom)}
          </div>
          <span className="wb-chip">
            {below === 0
              ? `every year clears ${formatPct(sweep.target, 0)}`
              : `${below} of ${sweep.points.length} years fall short`}
          </span>
        </div>
      </div>

      <p style={{ marginBottom: 4 }}>
        {widowHeadline(sweep.points, sweep.household, sweep.target, survivorName)}
      </p>
      {verdict && <p className="muted" style={{ marginTop: 0 }}>{verdict}</p>}
      {housingNote && <p className="muted" style={{ marginTop: 0 }}>{housingNote}</p>}
      {downsizeNote && <p className="muted" style={{ marginTop: 0 }}>{downsizeNote}</p>}

      <WidowChart
        rows={rows}
        chart={chart}
        household={sweep.household}
        target={sweep.target}
        pinnedLabel={pinned ? pinned.label : null}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={onPin} disabled={!canPin || isPinned}>
          {isPinned ? 'Pinned' : 'Pin this sweep'}
        </button>
        {(pinned || isPinned) && <button onClick={onUnpin}>Clear the pin</button>}
        {/*
          Three states, not two. "Pinned, and it is THIS sweep" is the moment the
          workflow is half-done and the next move is not obvious, so that is the
          one that says what to do rather than reporting that nothing is being
          compared — which would flatly contradict the button beside it.
        */}
        <span className="muted">
          {pinned
            ? `Comparing against an earlier sweep whose ${pinned.label}.`
            : isPinned
              ? 'Pinned. Now change the plan on the left and run again — the last two columns ' +
                'will show what the change was worth to the survivor.'
              : 'Nothing pinned — the chart shows this sweep only.'}
          <InfoTip label="pinning a sweep" text={PIN_TIP} />
        </span>
      </div>

      <WidowTable rows={rows} sweep={sweep} pinned={pinned} survivorName={survivorName} />

      <div className="field-help" style={{ marginTop: 12 }}>
        {solverOverrideNote('widow_score')}
      </div>
      {/*
        The engine's own answerLabel is NOT rendered here, deliberately. It
        reports the first year that clears the target ("reaches 90% for a death
        in 2026 or later"), which is a true sentence about a non-monotonic curve
        and a false impression of it: on a plan with term cover the first passing
        year is the FIRST year on the chart, and every year after the term lapses
        fails. The tiles and the headline above state the same facts in the
        direction that survives the curve dipping back down.

        Its other half — the note that the engine caps sweep runs below the
        headline's path count — is worth saying and is NOT said here, because
        saying it needs INNER_PATH_CAP and importing it would pull
        engine/solvers.ts (and the whole simulation engine behind it) into the
        browser bundle for one number. Mirroring the number locally is the
        option this file declines: a copied constant that drifts would state a
        false path count with total confidence. Move the constant to src/shared
        and the note can come back.
      */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

interface ChartRow {
  year: number;
  asPlanned: number;
  dropped?: number;
  pinned?: number;
}

/**
 * One y-axis, deliberately: every series on this chart is the same measure on
 * the same 0-1 scale, so a second axis would be inventing a comparison rather
 * than showing one.
 *
 * Colours come from `chart.duo`, a pair validated for colour-vision deficiency
 * (see theme.ts) rather than picked by eye — the obvious blue/violet choice
 * measures ΔE 0.4 under deuteranopia, i.e. one line. The pinned sweep is drawn
 * as a dashed neutral, matching the fan chart's baseline convention: it is a
 * reference, not a third peer, and the dash carries its identity independently
 * of colour.
 */
function WidowChart({
  rows,
  chart,
  household,
  target,
  pinnedLabel,
}: {
  rows: WidowRow[];
  chart: ChartPalette;
  household: number;
  target: number;
  pinnedLabel: string | null;
}) {
  const data: ChartRow[] = rows.map((r) => ({
    year: r.year,
    asPlanned: r.asPlanned,
    ...(r.dropped !== undefined ? { dropped: r.dropped } : {}),
    ...(r.pinned !== undefined ? { pinned: r.pinned } : {}),
  }));
  const hasDropped = rows.some((r) => r.dropped !== undefined);
  const hasPinned = rows.some((r) => r.pinned !== undefined);

  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
        <XAxis
          dataKey="year"
          type="number"
          domain={['dataMin', 'dataMax']}
          allowDecimals={false}
          stroke={chart.axis}
          tick={{ fill: chart.axis }}
        />
        <YAxis
          domain={[0, 1]}
          tickFormatter={(v: number) => formatPct(v, 0)}
          stroke={chart.axis}
          tick={{ fill: chart.axis }}
        />
        <Tooltip
          formatter={(value: number | string) => formatPct(Number(value), 1)}
          labelFormatter={(y: unknown) => `If the death were in ${y}`}
          contentStyle={{
            background: chart.tooltip.bg,
            border: `1px solid ${chart.tooltip.border}`,
            borderRadius: 6,
          }}
          labelStyle={{ color: chart.tooltip.text }}
          itemStyle={{ color: chart.tooltip.text }}
        />
        <Legend />
        {/*
          The household's own score, flat across every death year because it is
          the run in which nobody dies. It is the thing the curve is being read
          against, so it is a reference line rather than a fourth series.
        */}
        <ReferenceLine
          y={household}
          stroke={chart.neutral}
          strokeWidth={1.5}
          label={{
            value: `household ${formatPct(household, 1)}`,
            position: 'insideTopLeft',
            fill: chart.axis,
            fontSize: 12,
          }}
        />
        <ReferenceLine
          y={target}
          stroke={chart.warn}
          strokeDasharray="4 4"
          label={{
            value: `target ${formatPct(target, 0)}`,
            position: 'insideBottomRight',
            fill: chart.warn,
            fontSize: 12,
          }}
        />
        {hasPinned && (
          <Line
            dataKey="pinned"
            name={pinnedLabel ? `pinned — ${pinnedLabel}` : 'pinned'}
            stroke={chart.neutralStrong}
            strokeWidth={1.5}
            strokeDasharray="6 4"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        )}
        {hasDropped && (
          <Line
            dataKey="dropped"
            name="with the policy dropped"
            stroke={chart.duo.counterfactual}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        )}
        <Line
          dataKey="asPlanned"
          name="this plan"
          stroke={chart.duo.primary}
          strokeWidth={2}
          dot={{ r: 3 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * The same numbers as the chart, readable exactly. It is also the relief
 * channel the colour rules require: every series is legible here without any
 * colour at all.
 */
function WidowTable({
  rows,
  sweep,
  pinned,
  survivorName,
}: {
  rows: WidowRow[];
  sweep: WidowSweep;
  pinned: WidowSweep | null;
  survivorName: string;
}) {
  const hasDropped = rows.some((r) => r.dropped !== undefined);
  const hasPinned = rows.some((r) => r.pinned !== undefined);
  const worst = weakestPoint(sweep.points);

  return (
    <div className="table-scroll" style={{ marginTop: 12 }}>
      <table>
        <thead>
          <tr>
            <th>If the death were in</th>
            <th>{survivorName} is</th>
            <th>Widow score</th>
            <th>vs household</th>
            {hasDropped && <th>Policy dropped</th>}
            {hasDropped && <th>What the cover is worth</th>}
            {hasPinned && <th>Pinned</th>}
            {hasPinned && <th>Change since the pin</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.year} className={worst && r.year === worst.x ? 'best-row' : undefined}>
              <td>{r.year}</td>
              <td>{r.survivorAge === null ? '—' : r.survivorAge}</td>
              <td>
                <span className={successClass(r.asPlanned, sweep.target)}>
                  {formatPct(r.asPlanned, 1)}
                </span>
              </td>
              <td>{formatPoints(r.asPlanned - sweep.household)}</td>
              {hasDropped && (
                <td>{r.dropped === undefined ? '—' : formatPct(r.dropped, 1)}</td>
              )}
              {hasDropped && (
                <td>{r.policyWorth === undefined ? '—' : formatPoints(r.policyWorth)}</td>
              )}
              {hasPinned && <td>{r.pinned === undefined ? '—' : formatPct(r.pinned, 1)}</td>}
              {hasPinned && (
                <td>{r.sincePinned === undefined ? '—' : formatPoints(r.sincePinned)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field-help" style={{ marginTop: 6 }}>
        The highlighted row is the weakest year — the one this plan is betting on.
        {pinned
          ? ` The pinned sweep ran on a plan whose ${pinned.label} — the last column is what ` +
            'the change between the two is worth to the survivor.'
          : ''}
      </div>
    </div>
  );
}
