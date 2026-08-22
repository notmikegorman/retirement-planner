/**
 * WATCHING A SEARCH RUN.
 *
 * The hard part of this view is not the progress bar; it is that the numbers on
 * it are NOT results and must never be read as results. A leaderboard row
 * during the race is a one- or two-seed screening score, and the maximum of a
 * noisy sample is biased upward — at 1,024 candidates and the measured one-seed
 * noise, the leader is about 6.5 percentage points luckier than it is good. So:
 *
 *  - every screening row is badged, in words, on the row;
 *  - a row with one seed shows NO error bar rather than "± 0", because one
 *    observation licenses no interval and a zero-width bar would read as the
 *    most precise number in the table when it is the least;
 *  - the round table carries the probe spend, which RISES between rounds when
 *    the field saturates — so scores from different rounds are not comparable
 *    and the view says so rather than letting the reader assume otherwise.
 */
import type { SearchProgress, SearchRound } from '../../../shared/types';
import { formatPct, formatUSD } from '../../../shared/util';
import { InfoTip } from '../profile/fields';
import { formatDuration, progressFraction } from './searchLogic';

const SCREENING_TIP =
  'A screening score is a RANKING signal, not a result. It comes from one or two seeds at low ' +
  'path counts, and the leader of a noisy field is biased upward by roughly the noise times the ' +
  'expected maximum of that many draws — about 6.5 percentage points at a thousand candidates. ' +
  'The report stage re-measures the survivors on a separate set of seeds that had no part in ' +
  'choosing them, and those are the numbers worth reading.';

const PROBE_TIP =
  'Candidates are scored at a STRESS level of spending, not at your own. Your plan succeeds ' +
  'essentially always at what it actually spends, so scoring there separates nothing. The probe ' +
  'is calibrated to land the incumbent near 85% — and it RISES between rounds when too much of ' +
  'the surviving field scores a flat 100% at it, because a round that cannot separate its field ' +
  'is not racing, it is shuffling. Scores from different rounds are therefore not comparable.';

const SATURATION_TIP =
  'The share of this round’s field that scored a flat 100% at the round’s probe spend. Above a ' +
  'quarter, the probe is recalibrated upward for the next round; until then, those plans are ' +
  'ordered by median terminal wealth, which does not saturate.';

export interface SearchProgressViewProps {
  progress: SearchProgress;
  onCancel: () => void;
  cancelling: boolean;
}

export function SearchProgressView({ progress, onCancel, cancelling }: SearchProgressViewProps) {
  const fraction = progressFraction(progress.evaluated, progress.total);
  const running = progress.status === 'running' || progress.status === 'queued';

  return (
    <div>
      <div className="card">
        <div className="row">
          <div>
            <div className="metric-label">Stage</div>
            <div className="metric-value">{progress.stageLabel || progress.stage}</div>
          </div>
          <span className="spacer" />
          {running && (
            <button className="danger" disabled={cancelling} onClick={onCancel}>
              {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <div className="progress-outer">
            <div className="progress-inner" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          <span className="muted">
            {progress.evaluated.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')}{' '}
            simulations
          </span>
        </div>

        <div className="row" style={{ marginTop: 10, gap: 28 }}>
          <Stat label={running ? 'Elapsed' : 'Took'} value={formatDuration(progress.elapsedMs)} />
          {/*
            A finished search has no remaining time and no current rate.
            "measuring…" on a done search is not a small cosmetic slip: it says
            the thing is still working when it is not.
          */}
          {running && (
            <>
              <Stat
                label="Remaining"
                value={progress.etaMs === undefined ? 'measuring…' : formatDuration(progress.etaMs)}
              />
              <Stat
                label="Rate"
                value={progress.ratePerSec > 0 ? `${progress.ratePerSec.toFixed(1)}/s` : '—'}
              />
            </>
          )}
          <Stat
            label="From cache"
            value={progress.cacheHits.toLocaleString('en-US')}
            note="answers this search got for free"
          />
        </div>

        {progress.message && (
          <div className="muted" style={{ marginTop: 10 }}>
            {progress.message}
          </div>
        )}

        {progress.status === 'cancelled' && (
          <div className="lib-warning warn" style={{ marginTop: 10 }}>
            Stopped. The report below is the partial answer, labelled with the precision it
            actually reached.
          </div>
        )}

        {progress.error && (
          <div className="error-banner" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
            {progress.error}
          </div>
        )}
      </div>

      {progress.calibration && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Calibration
            <InfoTip label="the probe spend" text={PROBE_TIP} />
          </h2>
          <div className="row" style={{ gap: 28 }}>
            <Stat label="Your plan spends" value={`${formatUSD(progress.calibration.planSpend)}/yr`} />
            <Stat
              label="Scored at"
              value={`${formatUSD(progress.calibration.probeSpend)}/yr`}
              note="the stress level where the metric still has resolution"
            />
            <Stat
              label="Noise floor"
              value={`${(progress.calibration.noiseFloorReport * 100).toFixed(2)} pts`}
              note="one plan, re-run on a different seed, at reporting precision"
            />
          </div>
        </div>
      )}

      {progress.rounds.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Rounds</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Plans</th>
                  <th>Seeds</th>
                  <th>Paths</th>
                  <th>Keep</th>
                  <th>
                    Scored at
                    <InfoTip label="the round’s probe spend" text={PROBE_TIP} align="end" />
                  </th>
                  <th>
                    Saturated
                    <InfoTip label="saturation" text={SATURATION_TIP} align="end" />
                  </th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {progress.rounds.map((round) => (
                  <RoundRow key={round.index} round={round} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {progress.leaderboard.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Leading so far
            <InfoTip label="screening scores" text={SCREENING_TIP} />
          </h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Score at the probe</th>
                  <th>95% interval</th>
                  <th>Seeds</th>
                  <th>In dollars</th>
                </tr>
              </thead>
              <tbody>
                {progress.leaderboard.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.label}{' '}
                      {row.screeningEstimate && (
                        <span className="flag" title={SCREENING_TIP}>
                          screening estimate
                        </span>
                      )}
                    </td>
                    <td>{formatPct(row.score, 2)}</td>
                    <td>
                      {row.ci95HalfWidth === undefined ? (
                        <span className="muted" title="One seed licenses no interval">
                          not yet measurable
                        </span>
                      ) : (
                        `±${(row.ci95HalfWidth * 100).toFixed(2)} pts`
                      )}
                    </td>
                    <td>{row.seeds}</td>
                    <td>{row.impliedSpend === undefined ? '—' : `${formatUSD(row.impliedSpend)}/yr`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            These are the scores that decide who survives each cut. None of them appears in the
            report: the finalists are re-measured on a separate set of seeds that took no part in
            choosing them.
          </div>
        </div>
      )}
    </div>
  );
}

function RoundRow({ round }: { round: SearchRound }) {
  return (
    <tr className={round.status === 'running' ? 'best-row' : undefined}>
      {/* The executor numbers its rounds from 1; this is its number, not ours. */}
      <td>{round.index}</td>
      <td>{round.candidates.toLocaleString('en-US')}</td>
      <td>{round.seeds}</td>
      <td>{round.paths.toLocaleString('en-US')}</td>
      <td>{round.keep.toLocaleString('en-US')}</td>
      <td>{round.probeSpend === undefined ? '—' : `${formatUSD(round.probeSpend)}/yr`}</td>
      <td>
        {round.saturatedFraction === undefined ? '—' : formatPct(round.saturatedFraction, 0)}
      </td>
      <td>{round.status}</td>
    </tr>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {note && <div className="field-help">{note}</div>}
    </div>
  );
}
