/**
 * THE REPORT — the only part of the search the user is meant to act on.
 *
 * Everything here is arranged around one sentence from the brief: "he does not
 * want a single number; he wants to see which decisions actually moved the
 * outcome and which were noise." So the order is: what won and by how much,
 * whether that lead is real, which decisions produced it, and finally what the
 * report is NOT entitled to say.
 *
 * FOUR RULES, EACH OF WHICH THE OBVIOUS DESIGN BREAKS:
 *
 *  1. THE WINNER IS PRESENTED WITH ITS TIE BRACKET, NOT ALONE. The maximum of a
 *     noisy sample is biased upward; a single crowned plan is the failure mode
 *     this whole feature exists to avoid. When several plans are
 *     indistinguishable, saying so IS the result.
 *  2. "SAME PLAN" AND "NOT RESOLVED" NEVER RENDER ALIKE. One is a finding — the
 *     whole interval sits inside the band you said you would act on. The other
 *     is a confession — we did not measure it well enough. Collapsing them into
 *     "no difference" is the classic lie, so each delta prints its own
 *     ready-written note.
 *  3. AN INERT KNOB IS NOT A KNOB WITH NO EFFECT. 72(t) with a penalty-free
 *     retirement, financing with no purchase: the question does not arise, and
 *     that is a different statement from "we tried it and it did nothing".
 *  4. THE PARTS NEVER ADD UP. The sum of the one-knob effects is not the
 *     winner's total gain, and the residual is printed rather than hidden.
 */
import { useState } from 'react';
import type {
  Scenario,
  SearchAttributionRow,
  SearchFinalist,
  SearchReport,
} from '../../../shared/types';
import { formatPct, formatUSD } from '../../../shared/util';
import { api } from '../../api';
import { useToast } from '../../toast';
import { InfoTip } from '../profile/fields';
import { DeltaForest, type ForestRow } from './DeltaForest';
import {
  attributionTitle,
  deltaSummary,
  finalistSaveName,
  formatDelta,
  formatObjective,
  formatSpread,
  objectiveStat,
  objectiveTitle,
  ordinal,
  splitAttribution,
  tieBracketNote,
  verdictTone,
  verdictWord,
  formatDuration,
} from './searchLogic';

const PAIRED_TIP =
  'Every difference here is PAIRED: the candidate and your plan are run on the same seeds, so ' +
  'they face bit-identical market futures and the difference is attributable to the decision ' +
  'with market luck held constant rather than merely averaged out. Measured variance reduction ' +
  'ranges from 1.3x for large structural changes to 6.4x for the near-ties that actually need ' +
  'deciding — pairing buys the most precision exactly where it is needed.';

const HELD_OUT_TIP =
  'The seeds that measured these numbers took no part in choosing the finalists. That separation ' +
  'is what makes the figures readable at face value: a score measured on the same draws that ' +
  'won the race is the race’s own luck, quoted back.';

const FEASIBLE_TIP =
  'Whether the plan still clears your own success target at your own spending. A plan can win on ' +
  'sustainable spending and fail this — it is a different question — so an infeasible plan is ' +
  'ranked below every feasible one no matter how well it scores.';

const APPROX_TIP =
  'Converted from success-at-the-probe-spend into dollars using the measured local slope rather ' +
  'than measured directly by bisection. Good enough to rank on, not good enough to quote.';

export interface SearchReportViewProps {
  report: SearchReport;
  /** Put a plan into the workbench and go there. */
  onOpenInWorkbench: (scenario: Scenario) => Promise<void>;
}

export function SearchReportView({ report, onOpenInWorkbench }: SearchReportViewProps) {
  const winner = report.finalists.find((f) => f.rank === 1) ?? report.finalists[0];
  const objective = report.objective;

  return (
    <div>
      {report.truncated && (
        <div className="error-banner">
          This search was stopped early. Everything below is the partial answer — the intervals are
          as wide as the work that was actually done, and the caveats at the bottom say what was
          skipped.
        </div>
      )}

      {winner && <Answer report={report} winner={winner} onOpenInWorkbench={onOpenInWorkbench} />}

      <Finalists report={report} onOpenInWorkbench={onOpenInWorkbench} />

      <Attribution report={report} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>What this does not say</h2>
        {report.caveats.length === 0 ? (
          <div className="muted">No caveats were recorded for this search.</div>
        ) : (
          <ul className="caveat-list">
            {report.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </div>

      <Method report={report} />

      <div className="muted">
        {objectiveTitle(objective)} · engine {report.engineVersion} · space{' '}
        {report.spaceHash.slice(0, 12)} · {formatDuration(report.elapsedMs)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

function Answer({
  report,
  winner,
  onOpenInWorkbench,
}: {
  report: SearchReport;
  winner: SearchFinalist;
  onOpenInWorkbench: (scenario: Scenario) => Promise<void>;
}) {
  const objective = report.objective;
  const stat = objectiveStat(objective, winner);
  const spread = formatSpread(objective, stat);
  const delta = winner.delta;
  const tied = report.tieBracket.length > 1;

  return (
    <div className="card">
      <div className="metric-label">The best plan in the space searched</div>
      <div className="verdict" style={{ marginTop: 4 }}>
        {winner.label}
      </div>

      <div className="row" style={{ marginTop: 14, gap: 36 }}>
        <div>
          <div className="metric-label">{objectiveTitle(objective)}</div>
          <div className="metric-value">
            {stat ? formatObjective(objective, stat.mean) : 'not measured'}
          </div>
          <div className="field-help">
            {spread ?? 'one seed — no interval'}
            <InfoTip label="held-out seeds" text={HELD_OUT_TIP} />
          </div>
        </div>

        {delta && (
          <div>
            <div className="metric-label">
              Against your plan
              <InfoTip label="paired comparison" text={PAIRED_TIP} />
            </div>
            <div className="metric-value">
              {formatDelta(objective, delta.mean)}{' '}
              <span className={`wb-chip ${verdictTone(delta.verdict)}`}>
                {verdictWord(delta.verdict)}
              </span>
            </div>
            <div className="field-help">{deltaSummary(objective, delta)}</div>
          </div>
        )}

        <div>
          <div className="metric-label">
            Meets your target
            <InfoTip label="feasibility" text={FEASIBLE_TIP} />
          </div>
          <div className={winner.feasible ? 'metric-value good' : 'metric-value bad'}>
            {winner.feasible ? 'yes' : 'no'}
          </div>
          {winner.successAtPlanSpend && (
            <div className="field-help">
              {formatPct(winner.successAtPlanSpend.mean)} at your own spending
            </div>
          )}
        </div>
      </div>

      {delta && (
        <p className="report-note" style={{ marginTop: 14 }}>
          {delta.note}
          {delta.approximate && (
            <>
              {' '}
              <span className="flag">approximate</span>
              <InfoTip label="an approximate figure" text={APPROX_TIP} />
            </>
          )}
        </p>
      )}

      <p className={tied ? 'report-note warn' : 'report-note'}>{tieBracketNote(report)}</p>

      {tied && (
        <div className="chip-list" style={{ marginBottom: 10 }}>
          {report.tieBracket.map((id) => {
            const f = report.finalists.find((x) => x.id === id);
            return (
              <span key={id} className="badge" title={f?.label ?? id}>
                {f ? `${ordinal(f.rank)}: ${f.label}` : id}
              </span>
            );
          })}
        </div>
      )}

      <div className="row">
        <SaveFinalist report={report} finalist={winner} primary />
        <button onClick={() => void onOpenInWorkbench(winner.scenario)}>Open on the Plan page</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The finalists
// ---------------------------------------------------------------------------

function Finalists({
  report,
  onOpenInWorkbench,
}: {
  report: SearchReport;
  onOpenInWorkbench: (scenario: Scenario) => Promise<void>;
}) {
  const objective = report.objective;
  const rows: ForestRow[] = report.finalists
    .filter((f): f is SearchFinalist & { delta: NonNullable<SearchFinalist['delta']> } =>
      f.delta !== undefined,
    )
    .map((f) => ({ id: f.id, label: f.label, delta: f.delta, isWinner: f.rank === 1 }));

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Every finalist, and how far from your plan
        <InfoTip label="the forest plot" text={PAIRED_TIP} />
      </h2>

      {rows.length > 0 ? (
        <DeltaForest objective={objective} rows={rows} practicalFloor={objective.practicalFloor} />
      ) : (
        <div className="muted">
          No paired differences were measured — the search did not reach its report stage.
        </div>
      )}

      <div className="table-scroll" style={{ marginTop: 16 }}>
        <table className="report-wrap">
          <thead>
            <tr>
              <th>#</th>
              <th className="col-text">Plan</th>
              <th>{objectiveTitle(objective)}</th>
              <th>Spread</th>
              <th>Against your plan</th>
              <th>
                Target
                <InfoTip label="feasibility" text={FEASIBLE_TIP} align="end" />
              </th>
              <th>Survivor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <FinalistRow
              report={report}
              finalist={report.baseline}
              baseline
              onOpenInWorkbench={onOpenInWorkbench}
            />
            {report.finalists.map((f, i) => (
              <FinalistRow
                key={f.id}
                report={report}
                finalist={f}
                /*
                  Two finalists can carry the same plan under different labels —
                  "retire 2029" and "retire 2029 - 72(t) on" are one plan when
                  the 72(t) was going to be elected anyway. Their scores are
                  then identical to the cent, which reads as an eerie
                  coincidence unless the row says what it is.
                */
                duplicateOf={report.finalists.find(
                  (other, j) => j < i && other.planHash === f.planHash,
                )}
                onOpenInWorkbench={onOpenInWorkbench}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FinalistRow({
  report,
  finalist,
  baseline,
  duplicateOf,
  onOpenInWorkbench,
}: {
  report: SearchReport;
  finalist: SearchFinalist;
  baseline?: boolean;
  /** An earlier finalist that compiles to exactly this plan, if any. */
  duplicateOf?: SearchFinalist;
  onOpenInWorkbench: (scenario: Scenario) => Promise<void>;
}) {
  const objective = report.objective;
  const stat = objectiveStat(objective, finalist);
  const spread = formatSpread(objective, stat);
  const delta = finalist.delta;
  /*
   * The bracket INCLUDES the winner's own id, so membership alone would badge
   * the winner as "tied with" a bracket of one — i.e. with itself. The flag is
   * only meaningful for a non-winner in a bracket of more than one; the winner
   * carries the bracket in prose above the table instead.
   */
  const tied =
    !baseline &&
    finalist.rank !== 1 &&
    report.tieBracket.length > 1 &&
    report.tieBracket.includes(finalist.id) &&
    !finalist.tiedWithWinner;

  return (
    <tr className={finalist.rank === 1 && !baseline ? 'best-row' : undefined}>
      <td>{baseline ? '—' : finalist.rank}</td>
      <td className="col-text">
        {baseline ? 'Your plan as it stands' : finalist.label}
        {finalist.tiedWithWinner && (
          <>
            {' '}
            <span className="flag" title="Statistically indistinguishable from the winner">
              tied with the winner
            </span>
          </>
        )}
        {tied && (
          <>
            {' '}
            <span className="flag">in the tie bracket</span>
          </>
        )}
        {duplicateOf && (
          <>
            {' '}
            <span
              className="flag"
              title={`Compiles to exactly the plan on row ${duplicateOf.rank} — the extra setting changes nothing, so the two score identically.`}
            >
              same plan as #{duplicateOf.rank}
            </span>
          </>
        )}
      </td>
      <td>{stat ? formatObjective(objective, stat.mean) : '—'}</td>
      <td className="muted">{spread ?? 'one seed'}</td>
      <td>
        {baseline ? (
          <span className="muted">the yardstick</span>
        ) : delta ? (
          <>
            {formatDelta(objective, delta.mean)}{' '}
            <span className={`wb-chip ${verdictTone(delta.verdict)}`} title={delta.note}>
              {verdictWord(delta.verdict)}
            </span>
            {delta.approximate && (
              <>
                {' '}
                <span className="flag" title={APPROX_TIP}>
                  approx
                </span>
              </>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className={finalist.feasible ? 'good' : 'bad'}>{finalist.feasible ? 'meets' : 'misses'}</td>
      <td>{finalist.widowScore ? formatPct(finalist.widowScore.mean) : '—'}</td>
      <td>
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <SaveFinalist report={report} finalist={finalist} baseline={baseline} />
          <button onClick={() => void onOpenInWorkbench(finalist.scenario)}>Open</button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Keeping a finalist
// ---------------------------------------------------------------------------

/**
 * The loop the user asked for closes here: a finalist he wants to remember is
 * filed in the PLAN'S HISTORY under a name, beside every version of the plan
 * there has ever been — one list of plans he might want back, not two.
 *
 * Keeping one does NOT touch the plan: the workbench stays exactly where it
 * was, and "Open" is still the button that makes a finalist the plan. What it
 * does not carry is the search's own numbers — see the note in searchLogic on
 * why a mean over a seed LIST cannot be filed as a single-seed score. A kept
 * version scores in one press from the History tab.
 */
function SaveFinalist({
  report,
  finalist,
  primary,
  baseline,
}: {
  report: SearchReport;
  finalist: SearchFinalist;
  primary?: boolean;
  baseline?: boolean;
}) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() =>
    baseline ? 'Plan as it stands' : finalistSaveName(report, finalist),
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.keepPlan({
        plan: finalist.scenario,
        label: name.trim() || finalistSaveName(report, finalist),
      });
      setSaved(true);
      setOpen(false);
      showToast('Kept — it is in the Plan page’s History tab');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return <span className="badge">kept</span>;
  }

  if (!open) {
    return (
      <button className={primary ? 'primary' : undefined} onClick={() => setOpen(true)}>
        Keep this plan
      </button>
    );
  }

  return (
    <div className="save-inline">
      <input value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 260 }} />
      <button className="primary" disabled={busy} onClick={() => void save()}>
        {busy ? 'Keeping…' : 'Keep'}
      </button>
      <button disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      <span className="muted">Kept without a score — score it from the History tab.</span>
      {error && <span className="bad">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What mattered
// ---------------------------------------------------------------------------

function Attribution({ report }: { report: SearchReport }) {
  const split = splitAttribution(report.attribution);
  const objective = report.objective;

  if (report.attribution.length === 0) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>What actually mattered</h2>
        <div className="muted">
          The attribution pass did not run for this search, so there is nothing here to say which
          decisions earned the difference.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        What actually mattered
        <InfoTip
          label="the two measurements"
          text={
            'Each decision is measured twice, because the two answer different questions. ON ITS ' +
            'OWN changes only that one thing, starting from your plan as it stands — what you ' +
            'could act on tomorrow without adopting the rest. INSIDE THE WINNER puts that one ' +
            'thing back to your setting while everything else stays at the winner’s — what ' +
            'dropping it would cost, given the others. When the two disagree, the decision has a ' +
            'partner and cannot be taken alone; the note names it.'
          }
        />
      </h2>

      <AttrGroup
        title="These moved the answer"
        rows={split.moved}
        objective={objective}
        empty="Nothing in this space moved the answer by more than the amount you said was worth acting on."
      />
      <AttrGroup
        title="These made no difference"
        rows={split.noEffect}
        objective={objective}
        empty={null}
        note="Measured, and the whole interval sits inside the band you said you would act on. This is a finding: these decisions are free."
      />
      <AttrGroup
        title="These are not resolved"
        rows={split.unresolved}
        objective={objective}
        empty={null}
        note="Either the interval straddles zero and is wider than the band you said you would act on, or there was nothing measurable to compare. Neither is the same as no difference — buy more report seeds if one of these matters to you."
      />
      <AttrGroup
        title="The question does not arise"
        rows={split.inert}
        objective={objective}
        empty={null}
        note="These knobs physically could not act under the winner’s other settings — a 72(t) with a penalty-free retirement, financing with no purchase. Nothing was measured, and a zero here would have been an invented number."
      />

      {report.interactionResidual !== undefined && (
        <p className="report-note">
          The parts do not add up, and that is expected: the winner’s total gain minus the sum of
          the one-knob effects leaves {formatDelta(objective, report.interactionResidual)}{' '}
          unexplained. That remainder is interaction between decisions — the reason the search
          exists rather than a list of independent tips.
        </p>
      )}
    </div>
  );
}

function AttrGroup({
  title,
  rows,
  objective,
  empty,
  note,
}: {
  title: string;
  rows: SearchAttributionRow[];
  objective: SearchReport['objective'];
  empty: string | null;
  note?: string;
}) {
  if (rows.length === 0) {
    return empty === null ? null : (
      <>
        <h3>{title}</h3>
        <div className="muted">{empty}</div>
      </>
    );
  }
  return (
    <>
      <h3>{title}</h3>
      {note && <div className="muted" style={{ marginBottom: 8 }}>{note}</div>}
      {rows.map((row) => (
        <AttrRow key={row.dim} row={row} objective={objective} />
      ))}
    </>
  );
}

function AttrRow({
  row,
  objective,
}: {
  row: SearchAttributionRow;
  objective: SearchReport['objective'];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="attr-row">
      <div className="row" style={{ gap: 8 }}>
        <strong>{attributionTitle(row.dim, row.label)}</strong>
        <span className="muted">winner: {row.winnerLevel}</span>
        <span className="spacer" />
        {row.separable === true && (
          <span className="badge" title="The two measurements agree, so this decision can be taken on its own">
            can be taken alone
          </span>
        )}
        {row.separable === false && (
          <span className="flag" title="The two measurements disagree: this decision depends on another">
            depends on another
          </span>
        )}
      </div>

      {!row.inert && (
        <div className="row" style={{ gap: 24, marginTop: 4 }}>
          <AttrMeasure label="On its own" delta={row.onOwn} objective={objective} />
          <AttrMeasure label="Inside the winner" delta={row.insideWinner} objective={objective} />
        </div>
      )}

      <div className="report-note">{row.note}</div>

      {row.levels && row.levels.length > 0 && (
        <>
          <button className="link-button" onClick={() => setOpen(!open)}>
            {open ? 'Hide every level' : `Show all ${row.levels.length} levels`}
          </button>
          {open && (
            <div className="table-scroll">
              <table className="report-wrap">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>Difference</th>
                    <th>95% interval</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {row.levels.map((l) => (
                    <tr key={l.label}>
                      <td className="col-text">{l.label}</td>
                      <td>{formatDelta(objective, l.delta.mean)}</td>
                      <td className="muted">
                        {formatDelta(objective, l.delta.ci95[0])} to{' '}
                        {formatDelta(objective, l.delta.ci95[1])}
                      </td>
                      <td>
                        <span className={`wb-chip ${verdictTone(l.delta.verdict)}`} title={l.delta.note}>
                          {verdictWord(l.delta.verdict)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AttrMeasure({
  label,
  delta,
  objective,
}: {
  label: string;
  delta: SearchAttributionRow['onOwn'];
  objective: SearchReport['objective'];
}) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      {delta ? (
        <>
          <div>
            {formatDelta(objective, delta.mean)}{' '}
            <span className={`wb-chip ${verdictTone(delta.verdict)}`} title={delta.note}>
              {verdictWord(delta.verdict)}
            </span>
          </div>
          <div className="field-help">{deltaSummary(objective, delta)}</div>
        </>
      ) : (
        <div className="muted">not measured</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Method
// ---------------------------------------------------------------------------

function Method({ report }: { report: SearchReport }) {
  const c = report.calibration;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>How it was measured</h2>
      <div className="breakdown-grid">
        <table className="mini-table">
          <tbody>
            <tr>
              <td>Plans drawn</td>
              <td>{report.candidatesGenerated.toLocaleString('en-US')}</td>
            </tr>
            <tr>
              <td>Distinct plans</td>
              <td>{report.distinctPlans.toLocaleString('en-US')}</td>
            </tr>
            <tr>
              <td>Simulations run</td>
              <td>{report.evaluations.toLocaleString('en-US')}</td>
            </tr>
            <tr>
              <td>Answered from cache</td>
              <td>{report.cacheHits.toLocaleString('en-US')}</td>
            </tr>
          </tbody>
        </table>

        <table className="mini-table">
          <tbody>
            <tr>
              <td>Seeds to choose</td>
              <td>{report.seeds.selection.length}</td>
            </tr>
            <tr>
              <td>Seeds to report</td>
              <td>{report.seeds.report.length}</td>
            </tr>
            <tr>
              <td>Paths (screen / race / report)</td>
              <td>
                {report.paths.screen.toLocaleString('en-US')} /{' '}
                {report.paths.race.toLocaleString('en-US')} /{' '}
                {report.paths.report.toLocaleString('en-US')}
              </td>
            </tr>
            <tr>
              <td>Worth acting on</td>
              <td>{formatDelta(report.objective, report.objective.practicalFloor)}</td>
            </tr>
          </tbody>
        </table>

        <table className="mini-table">
          <tbody>
            <tr>
              <td>Your plan spends</td>
              <td>{formatUSD(c.planSpend)}/yr</td>
            </tr>
            <tr>
              <td>Screened at</td>
              <td>{formatUSD(c.probeSpend)}/yr</td>
            </tr>
            <tr>
              <td>Noise floor (report)</td>
              <td>{(c.noiseFloorReport * 100).toFixed(2)} pts</td>
            </tr>
            {c.pairedFloorDollars !== undefined && (
              <tr>
                <td>Paired resolution</td>
                <td>{formatUSD(c.pairedFloorDollars)}/yr</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
