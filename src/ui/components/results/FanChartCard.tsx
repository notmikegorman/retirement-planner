/** Percentile fan chart over the run's FanChart (real 2026 dollars). */
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FanChart } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { useChartTheme, type ChartPalette } from '../../theme';
import { buildFanData, formatCompactUSD, type FanRow } from './resultsData';

const PCTS: Array<{ key: 'p90' | 'p75' | 'p50' | 'p25' | 'p10'; label: string }> = [
  { key: 'p90', label: 'p90' },
  { key: 'p75', label: 'p75' },
  { key: 'p50', label: 'p50 (median)' },
  { key: 'p25', label: 'p25' },
  { key: 'p10', label: 'p10' },
];

/** A fan row plus the pinned baseline's median for that year, when pinned. */
type FanRowWithBaseline = FanRow & { baseline?: number };

function FanTooltip({
  active,
  payload,
  label,
  chart,
  baselineLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: FanRowWithBaseline }>;
  label?: number | string;
  chart: ChartPalette;
  baselineLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
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
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {PCTS.map((p) => (
        <div key={p.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
          <span className="muted">{p.label}</span>
          <span>{formatUSD(row[p.key])}</span>
        </div>
      ))}
      {row.baseline !== undefined && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 20,
            marginTop: 4,
            borderTop: `1px solid ${chart.tooltip.border}`,
            paddingTop: 4,
          }}
        >
          <span className="muted">{baselineLabel ?? 'baseline p50'}</span>
          <span>{formatUSD(row.baseline)}</span>
        </div>
      )}
    </div>
  );
}

export interface FanChartCardProps {
  fan: FanChart;
  /**
   * A pinned reference run's median line, drawn dashed over the same years so
   * the SHAPE change is visible, not just the end numbers. `values` is aligned
   * index-for-index with `fan.years` (undefined = a year the reference does not
   * cover); the Workbench builds it with alignBaselineP50.
   */
  baselineSeries?: { label: string; values: Array<number | undefined> };
}

export function FanChartCard({ fan, baselineSeries }: FanChartCardProps) {
  const chart = useChartTheme();
  const rows = buildFanData(fan);
  const data: FanRowWithBaseline[] = baselineSeries
    ? rows.map((r, i) => ({ ...r, baseline: baselineSeries.values[i] }))
    : rows;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Portfolio fan</h2>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
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
            width={72}
            tickFormatter={formatCompactUSD}
            stroke={chart.axis}
            tick={{ fill: chart.axis }}
          />
          <Tooltip content={<FanTooltip chart={chart} baselineLabel={baselineSeries?.label} />} />
          <Area
            dataKey="band1090"
            name="p10–p90"
            stroke="none"
            fill={chart.fan.outerFill}
            fillOpacity={chart.fan.outerOpacity}
            isAnimationActive={false}
          />
          <Area
            dataKey="band2575"
            name="p25–p75"
            stroke="none"
            fill={chart.fan.innerFill}
            fillOpacity={chart.fan.innerOpacity}
            isAnimationActive={false}
          />
          <Line
            dataKey="p50"
            name="median"
            stroke={chart.accent}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {baselineSeries && (
            <Line
              dataKey="baseline"
              name={baselineSeries.label}
              stroke={chart.neutralStrong}
              strokeDasharray="6 4"
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="muted">
        Real (2026) dollars. Shaded: p10–p90; darker: p25–p75; line: median.
        {baselineSeries ? ` Dashed: the pinned baseline's median (${baselineSeries.label}).` : ''}
      </div>
    </div>
  );
}
