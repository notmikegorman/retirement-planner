/** Worst-decile insolvency-year histogram (non-deterministic modes only). */
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useChartTheme } from '../../theme';
import { buildWorstDecileData } from './resultsData';

export function WorstDecileCard({ hist }: { hist: Record<string, number> }) {
  const chart = useChartTheme();
  const data = buildWorstDecileData(hist);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Worst decile — insolvency years</h2>
      {data.length === 0 ? (
        <div className="muted">No insolvencies in the worst decile.</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
              <XAxis dataKey="year" stroke={chart.axis} tick={{ fill: chart.axis }} />
              <YAxis
                allowDecimals={false}
                width={40}
                stroke={chart.axis}
                tick={{ fill: chart.axis }}
              />
              <Tooltip
                contentStyle={{
                  background: chart.tooltip.bg,
                  border: `1px solid ${chart.tooltip.border}`,
                  borderRadius: 6,
                }}
                labelStyle={{ color: chart.tooltip.text }}
                itemStyle={{ color: chart.tooltip.text }}
              />
              <Bar dataKey="count" name="paths" fill={chart.bad} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <div className="muted">
            First insolvent year across the worst 10% of simulated paths.
          </div>
        </>
      )}
    </div>
  );
}
