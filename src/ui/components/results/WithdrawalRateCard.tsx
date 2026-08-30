/**
 * The classic withdrawal rate, year by year (the Withdrawals tab since the Summary split, 2026-08-30).
 *
 * The tile above this chart states ONE number — the first fully retired
 * year's rate. The chart exists to show that number's shape over the whole
 * retirement: the bridge years the portfolio carries alone, the step down
 * when Social Security starts, and the late-life rise forced RMDs can bring.
 * Every point comes from withdrawalRateSeries — the function the tile's
 * classicWithdrawalRate reads its own rate from — so the two cannot disagree
 * about a year (a disagreement would be worse than having no chart).
 *
 * Deliberate absences:
 * - No 4% reference line. The folklore benchmark assumes a 30-year-flat
 *   rate; painting it across a deliberately front-loaded plan invites
 *   exactly the wrong comparison. The caption carries the meaning instead.
 * - No legend: a single series, and the title names it.
 * - One axis. Rate only — the dollars live in the hover, where they can be
 *   labelled with their year.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ScenarioEvent, YearRow } from '../../../shared/types';
import { formatPct } from '../../../shared/util';
import { useChartTheme, type ChartPalette } from '../../theme';
import {
  WITHDRAWAL_CHART_EMPTY_NOTE,
  ssClaimMarkerYear,
  withdrawalRateAxisDomain,
  withdrawalRateSeries,
  withdrawalTooltipView,
  type WithdrawalRatePoint,
} from '../workbench/workbenchLogic';

/**
 * Hover card: the rate and the two nominal dollar figures behind it, so a
 * hovered year can be reconciled by hand against the Cashflow table. Content
 * comes from withdrawalTooltipView (pure, tested); this renders it in the
 * app's tooltip idiom (FanChartCard's).
 */
function RateTooltip({
  active,
  payload,
  chart,
}: {
  active?: boolean;
  payload?: Array<{ payload: WithdrawalRatePoint }>;
  chart: ChartPalette;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const view = withdrawalTooltipView(point);
  return (
    <div
      style={{
        background: chart.tooltip.bg,
        border: `1px solid ${chart.tooltip.border}`,
        color: chart.tooltip.text,
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: 13,
        boxShadow: 'var(--shadow)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{point.year}</div>
      {view.lines.map((l) => (
        <div key={l.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
          <span className="muted">{l.label}</span>
          <span>{l.value}</span>
        </div>
      ))}
      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
        {view.note}
      </div>
    </div>
  );
}

export function WithdrawalRateCard({
  referencePath,
  events,
}: {
  referencePath: readonly YearRow[];
  /** The PLAN's events — the Social Security marker derives from the claim
   * events as currently edited, never from a hardcoded year. */
  events: readonly ScenarioEvent[];
}) {
  const chart = useChartTheme();
  const points = withdrawalRateSeries(referencePath);
  if (points.length === 0) {
    // The chart never goes blank silently — the tile rule (the tile lives on the Details tab now).
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Withdrawal rate, year by year</h2>
        <div className="muted">{WITHDRAWAL_CHART_EMPTY_NOTE}</div>
      </div>
    );
  }
  const ssYear = ssClaimMarkerYear(points, events);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Withdrawal rate, year by year</h2>
      {/* Fixed height inside the tab panel — the card never scrolls. */}
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
          <XAxis
            dataKey="year"
            type="number"
            domain={['dataMin', 'dataMax']}
            allowDecimals={false}
            tickCount={10}
            stroke={chart.axis}
            tick={{ fill: chart.axis }}
          />
          <YAxis
            width={56}
            domain={withdrawalRateAxisDomain(points)}
            tickFormatter={(v: number) => formatPct(v, 1)}
            stroke={chart.axis}
            tick={{ fill: chart.axis }}
          />
          {/* Default cursor stroke is a hardcoded light gray — invisible or
              glaring depending on theme, so it takes the palette's neutral. */}
          <Tooltip content={<RateTooltip chart={chart} />} cursor={{ stroke: chart.neutral }} />
          {ssYear !== null && (
            <ReferenceLine
              x={ssYear}
              stroke={chart.neutralStrong}
              strokeDasharray="4 4"
              label={{
                value: 'Social Security starts',
                position: 'insideTopLeft',
                fill: chart.axis,
                fontSize: 11,
              }}
            />
          )}
          <Line
            dataKey="rate"
            name="withdrawal rate"
            stroke={chart.accent}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="muted">
        From the deterministic reference path — the typical future; each simulated future has its
        own version of this curve. The high early years are the bridge the portfolio carries
        alone; the rate steps down when Social Security starts, and forced RMDs can lift it again
        late in life.
      </div>
    </div>
  );
}
