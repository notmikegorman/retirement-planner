/**
 * Renderers for one sweep's output — the chart + table for a retirement-year
 * sweep, a Social Security claiming sweep, a spending curve, and the generic
 * single-answer view.
 *
 * These used to be the Solvers page. There is no Solvers page any more: a
 * scenario answers one question ("will this work?") and these views answer the
 * follow-ups, inline, in the Workbench (see ExploreCard).
 */
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SolverResult } from '../../../shared/types';
import { formatPct, formatUSD } from '../../../shared/util';
import { useChartTheme, type ChartPalette } from '../../theme';
import {
  formatClaimAgeMonths,
  formatCompactUSD,
  solverPointsHave,
  successClass,
} from './resultsData';

/** Themed Recharts props shared by every sweep chart (dark-mode legibility). */
function axisProps(chart: ChartPalette) {
  return { stroke: chart.axis, tick: { fill: chart.axis } };
}

function tooltipProps(chart: ChartPalette) {
  return {
    contentStyle: {
      background: chart.tooltip.bg,
      border: `1px solid ${chart.tooltip.border}`,
      borderRadius: 6,
    },
    labelStyle: { color: chart.tooltip.text },
    itemStyle: { color: chart.tooltip.text },
  };
}

/** Tooltip formatter shared by sweep charts: % for success series, $ otherwise. */
function pctOrUsdFormatter(
  value: number | string | Array<number | string>,
  name: number | string,
): [string, string] {
  const label = String(name);
  const v = Number(value);
  return [label.toLowerCase().includes('success') ? formatPct(v, 1) : formatUSD(v), label];
}

export function RetireSweepView({ out, target }: { out: SolverResult; target: number }) {
  const chart = useChartTheme();
  const hasMaxSpend = solverPointsHave(out.points, 'maxSpend');
  const data = out.points.map((p) => ({
    year: p.x,
    success: p.success,
    maxSpend: p.maxSpend ?? null,
  }));
  return (
    <>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
          <XAxis dataKey="year" {...axisProps(chart)} />
          <YAxis
            yAxisId="left"
            domain={[0, 1]}
            tickFormatter={(v: number) => formatPct(v, 0)}
            {...axisProps(chart)}
          />
          {hasMaxSpend && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={formatCompactUSD}
              width={76}
              {...axisProps(chart)}
            />
          )}
          <Tooltip formatter={pctOrUsdFormatter} {...tooltipProps(chart)} />
          <Legend />
          {hasMaxSpend && (
            <Bar
              yAxisId="right"
              dataKey="maxSpend"
              name="Most you could spend (real $/yr)"
              fill={chart.areaFill}
              fillOpacity={chart.areaOpacity + 0.35}
              isAnimationActive={false}
            />
          )}
          <Line
            yAxisId="left"
            dataKey="success"
            name="Share of futures that work"
            stroke={chart.accent}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="table-scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Stop working in</th>
              <th>Futures that work</th>
              {hasMaxSpend && <th>Most you could spend (real $/yr)</th>}
            </tr>
          </thead>
          <tbody>
            {out.points.map((p) => (
              <tr key={p.x} className={out.best && p.x === out.best.x ? 'best-row' : undefined}>
                <td>{p.label || p.x}</td>
                <td>
                  <span className={successClass(p.success, target)}>{formatPct(p.success, 1)}</span>
                </td>
                {hasMaxSpend && <td>{p.maxSpend != null ? formatUSD(p.maxSpend) : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SsClaimSweepView({ out, target }: { out: SolverResult; target: number }) {
  const chart = useChartTheme();
  const hasBenefits = solverPointsHave(out.points, 'expectedLifetimeBenefits');
  const data = out.points.map((p) => ({
    x: p.x,
    success: p.success,
    benefits: p.expectedLifetimeBenefits ?? null,
  }));
  const yearTicks = out.points.map((p) => p.x).filter((m) => m % 12 === 0);
  return (
    <>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            ticks={yearTicks}
            tickFormatter={formatClaimAgeMonths}
            {...axisProps(chart)}
          />
          <YAxis
            yAxisId="left"
            domain={[0, 1]}
            tickFormatter={(v: number) => formatPct(v, 0)}
            {...axisProps(chart)}
          />
          {hasBenefits && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={formatCompactUSD}
              width={76}
              {...axisProps(chart)}
            />
          )}
          <Tooltip
            formatter={pctOrUsdFormatter}
            labelFormatter={(m: unknown) => `Claim at ${formatClaimAgeMonths(Number(m))}`}
            {...tooltipProps(chart)}
          />
          <Legend />
          <Line
            yAxisId="left"
            dataKey="success"
            name="Share of futures that work"
            stroke={chart.accent}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {hasBenefits && (
            <Line
              yAxisId="right"
              dataKey="benefits"
              name="Lifetime benefits (today's $)"
              stroke={chart.good}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="table-scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Claim at</th>
              <th>Futures that work</th>
              {hasBenefits && <th>Lifetime benefits (today&apos;s $)</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {out.points.map((p) => {
              const isBest = out.best != null && p.x === out.best.x;
              return (
                <tr key={p.x} className={isBest ? 'best-row' : undefined}>
                  <td>{formatClaimAgeMonths(p.x)}</td>
                  <td>
                    <span className={successClass(p.success, target)}>
                      {formatPct(p.success, 1)}
                    </span>
                  </td>
                  {hasBenefits && (
                    <td>
                      {p.expectedLifetimeBenefits != null
                        ? formatUSD(p.expectedLifetimeBenefits)
                        : '—'}
                    </td>
                  )}
                  <td>{isBest && <span className="badge">best</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SwrCurveView({ out, target }: { out: SolverResult; target: number }) {
  const chart = useChartTheme();
  const data = out.points.map((p) => ({ x: p.x, success: p.success }));
  return (
    <>
      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatCompactUSD}
            {...axisProps(chart)}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(v: number) => formatPct(v, 0)}
            {...axisProps(chart)}
          />
          <Tooltip
            formatter={pctOrUsdFormatter}
            labelFormatter={(x: unknown) => `Spending ${formatUSD(Number(x))} / yr`}
            {...tooltipProps(chart)}
          />
          <ReferenceLine
            y={target}
            stroke={chart.warn}
            strokeDasharray="4 4"
            label={{
              value: `target ${formatPct(target, 0)}`,
              position: 'insideTopRight',
              fill: chart.warn,
              fontSize: 12,
            }}
          />
          <Line
            dataKey="success"
            name="Share of futures that work"
            stroke={chart.accent}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="table-scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Spending per year (today&apos;s $)</th>
              <th>Futures that work</th>
              <th>Meets your target</th>
            </tr>
          </thead>
          <tbody>
            {out.points.map((p) => (
              <tr key={p.x}>
                <td>{p.label || formatUSD(p.x)}</td>
                <td>
                  <span className={successClass(p.success, target)}>{formatPct(p.success, 1)}</span>
                </td>
                <td>
                  {p.success >= target ? (
                    <span className="good">yes</span>
                  ) : (
                    <span className="bad">no</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Generic view for sweeps that produce one answer plus its probe points. */
export function AnswerView({ out, target }: { out: SolverResult; target: number }) {
  const hasMaxSpend = solverPointsHave(out.points, 'maxSpend');
  const hasMedian = solverPointsHave(out.points, 'medianTerminalReal');
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Levels tried</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Level</th>
              <th>Futures that work</th>
              {hasMaxSpend && <th>Most you could spend (real $/yr)</th>}
              {hasMedian && <th>Median money left (today&apos;s $)</th>}
            </tr>
          </thead>
          <tbody>
            {out.points.map((p, i) => (
              <tr key={i}>
                <td>{p.label || p.x}</td>
                <td>
                  <span className={successClass(p.success, target)}>{formatPct(p.success, 1)}</span>
                </td>
                {hasMaxSpend && <td>{p.maxSpend != null ? formatUSD(p.maxSpend) : '—'}</td>}
                {hasMedian && (
                  <td>{p.medianTerminalReal != null ? formatUSD(p.medianTerminalReal) : '—'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The right view for a sweep's spec type. */
export function SolverOutputView({ out, target }: { out: SolverResult; target: number }) {
  switch (out.spec.type) {
    case 'retire_year_sweep':
      return <RetireSweepView out={out} target={target} />;
    case 'ss_claim_sweep':
      return <SsClaimSweepView out={out} target={target} />;
    case 'swr_curve':
      return <SwrCurveView out={out} target={target} />;
    /*
     * The widow sweep has a view of its own (WidowCard), which is where it is
     * actually run: that one draws the household score and the without-the-
     * policy comparison alongside, and neither is available from a SolverResult
     * on its own. This arm is the fallback for a widow_score spec that reached
     * the generic renderer — hand-written into plan.json, say — and the level
     * table is the honest thing to show when the comparison is missing.
     */
    case 'widow_score':
    case 'max_spend':
    case 'earliest_retirement':
      return <AnswerView out={out} target={target} />;
  }
}
