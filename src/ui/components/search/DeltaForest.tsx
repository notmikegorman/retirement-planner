/**
 * THE FOREST PLOT — every finalist's difference from the plan as it stands,
 * with the interval that difference is actually known to.
 *
 * WHY THIS FORM. The question is never "how big is this number" but "is this
 * difference real?", and that is a question about an INTERVAL against a
 * threshold. A bar chart of levels answers neither: it draws four bars of
 * near-identical height whose differences are entirely inside the measurement
 * error, and the reader's eye supplies a ranking the data does not support. A
 * forest plot puts the estimate, its 95% interval, zero, and the
 * practical-significance band on one line each, so "inside the noise" is
 * something you SEE rather than something you have to be told.
 *
 * WHY IT IS HAND-DRAWN SVG rather than Recharts, unlike every other chart in
 * this app: a category axis with horizontal error bars is the one shape that
 * library makes harder than plain geometry, and a chart that mounts inside a
 * tab must not animate from zero — the bars in this app's other charts do that
 * once, on first select, which is fine for a trend line and wrong for an
 * interval (an interval sweeping out from zero reads as a measurement being
 * taken). There is no animation here at all; the marks are where they belong on
 * the first frame.
 *
 * COLOUR. Two hues carry the sign of a REAL difference, and they are the pair
 * already validated for this app in theme.ts (`duo`): light #2563eb/#c2410c,
 * dark #3b82f6/#ea580c — all-pairs CVD ΔE 31.7 / 30.5 under protanopia and
 * deuteranopia, normal-vision ΔE 36.1, contrast >= 3:1 on both card surfaces.
 * (This app once shipped a pair measuring ΔE 0.4 under deuteranopia — one line,
 * to a red-green-colorblind reader, on a chart whose whole content was the gap
 * between two lines. Anyone changing these re-runs the validator.) Everything
 * the search could NOT separate is neutral gray, which is the diverging
 * idiom's "nothing here" and is not a hue competing with the two that mean
 * something. Colour is never the only encoding: a settled tie is a FILLED gray
 * dot and an unresolved one is HOLLOW, the legend names all four verdicts, and
 * the table under the chart carries every value in text.
 */
import type { PairedDelta, SearchObjective } from '../../../shared/types';
import { useChartTheme } from '../../theme';
import { formatCompactUSD } from '../results/resultsData';
import { formatDelta, formatInterval, verdictWord } from './searchLogic';

export interface ForestRow {
  id: string;
  label: string;
  delta: PairedDelta;
  /** Drawn with a heavier label; it is the row the report is written about. */
  isWinner: boolean;
}

export interface DeltaForestProps {
  objective: SearchObjective;
  rows: ForestRow[];
  /** Half-width of the "these are the same plan" band, in the metric's units. */
  practicalFloor: number;
}

/* Geometry, in viewBox units. The SVG scales; these do not change. */
const VIEW_W = 760;
const ROW_H = 34;
const TOP = 26;
const AXIS_H = 44;
const LABEL_W = 250;
const PLOT_L = LABEL_W + 12;
const PLOT_R = VIEW_W - 16;

export function DeltaForest({ objective, rows, practicalFloor }: DeltaForestProps) {
  const chart = useChartTheme();
  if (rows.length === 0) return null;

  const plotH = rows.length * ROW_H;
  const height = TOP + plotH + AXIS_H;

  // Domain: every interval, the floor band, and zero — then a tenth of padding
  // so a whisker never touches the frame.
  let lo = -practicalFloor;
  let hi = practicalFloor;
  for (const row of rows) {
    lo = Math.min(lo, row.delta.ci95[0], row.delta.mean);
    hi = Math.max(hi, row.delta.ci95[1], row.delta.mean);
  }
  const pad = (hi - lo) * 0.1 || Math.max(Math.abs(hi), 1) * 0.1;
  lo -= pad;
  hi += pad;
  const x = (v: number) => PLOT_L + ((v - lo) / (hi - lo)) * (PLOT_R - PLOT_L);

  const ticks = tickValues(lo, hi);
  const usd = objective.metric === 'sustainable_spend';

  return (
    <div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        style={{ maxWidth: VIEW_W, height: 'auto' }}
        role="img"
        aria-label={`Difference from the plan as it stands, for ${rows.length} finalists, with 95% confidence intervals`}
      >
        <title>Paired difference from the plan as it stands</title>

        {/* The band where a difference is not worth acting on. */}
        <rect
          x={x(-practicalFloor)}
          y={TOP - 8}
          width={Math.max(1, x(practicalFloor) - x(-practicalFloor))}
          height={plotH + 8}
          fill={chart.neutral}
          opacity={0.16}
        />
        <text
          x={(x(-practicalFloor) + x(practicalFloor)) / 2}
          y={TOP - 13}
          textAnchor="middle"
          fontSize={11}
          fill={chart.axis}
        >
          same plan
        </text>

        {/* Zero: the plan as it stands. */}
        <line
          x1={x(0)}
          x2={x(0)}
          y1={TOP - 8}
          y2={TOP + plotH}
          stroke={chart.neutralStrong}
          strokeWidth={1}
        />

        {rows.map((row, i) => {
          const cy = TOP + i * ROW_H + ROW_H / 2;
          const real = row.delta.verdict === 'better' || row.delta.verdict === 'worse';
          const colour = real
            ? row.delta.verdict === 'better'
              ? chart.duo.primary
              : chart.duo.counterfactual
            : chart.neutralStrong;
          const hollow = row.delta.verdict === 'inconclusive';
          return (
            <g key={row.id}>
              <title>
                {`${row.label} — ${formatDelta(objective, row.delta.mean)} (${verdictWord(row.delta.verdict)}), 95% CI ${formatInterval(objective, row.delta.ci95)}`}
              </title>
              <text
                x={LABEL_W}
                y={cy + 4}
                textAnchor="end"
                fontSize={12}
                fontWeight={row.isWinner ? 600 : 400}
                fill={row.isWinner ? chart.tooltip.text : chart.axis}
              >
                {truncate(row.label, 40)}
              </text>
              <line
                x1={x(row.delta.ci95[0])}
                x2={x(row.delta.ci95[1])}
                y1={cy}
                y2={cy}
                stroke={colour}
                strokeWidth={2}
                strokeLinecap="round"
              />
              {/* End caps make a very narrow interval still readable as one. */}
              <line
                x1={x(row.delta.ci95[0])}
                x2={x(row.delta.ci95[0])}
                y1={cy - 5}
                y2={cy + 5}
                stroke={colour}
                strokeWidth={2}
              />
              <line
                x1={x(row.delta.ci95[1])}
                x2={x(row.delta.ci95[1])}
                y1={cy - 5}
                y2={cy + 5}
                stroke={colour}
                strokeWidth={2}
              />
              <circle
                cx={x(row.delta.mean)}
                cy={cy}
                r={5}
                fill={hollow ? chart.tooltip.bg : colour}
                stroke={colour}
                strokeWidth={2}
              />
            </g>
          );
        })}

        {/* Axis */}
        <line
          x1={PLOT_L}
          x2={PLOT_R}
          y1={TOP + plotH + 8}
          y2={TOP + plotH + 8}
          stroke={chart.grid}
          strokeWidth={1}
        />
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={TOP + plotH + 8}
              y2={TOP + plotH + 12}
              stroke={chart.grid}
              strokeWidth={1}
            />
            <text x={x(t)} y={TOP + plotH + 26} textAnchor="middle" fontSize={11} fill={chart.axis}>
              {axisTick(t, usd)}
            </text>
          </g>
        ))}
        <text
          x={(PLOT_L + PLOT_R) / 2}
          y={TOP + plotH + 41}
          textAnchor="middle"
          fontSize={11}
          fill={chart.axis}
        >
          {usd
            ? 'difference in sustainable annual spending vs the plan as it stands'
            : 'difference in probability of success vs the plan as it stands'}
        </text>
      </svg>

      {/* A legend is always present: colour alone never carries the verdict. */}
      <div className="forest-legend">
        <LegendItem colour={chart.duo.primary} label="better — the whole interval clears the band" />
        <LegendItem colour={chart.duo.counterfactual} label="worse" />
        <LegendItem colour={chart.neutralStrong} label="same plan — the interval sits inside the band" />
        <LegendItem
          colour={chart.neutralStrong}
          hollow
          fill={chart.tooltip.bg}
          label="not resolved — the interval is wider than the band and straddles zero"
        />
      </div>
    </div>
  );
}

function LegendItem({
  colour,
  label,
  hollow,
  fill,
}: {
  colour: string;
  label: string;
  hollow?: boolean;
  fill?: string;
}) {
  return (
    <span className="forest-legend-item">
      <svg width="14" height="14" aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r="5"
          fill={hollow ? (fill ?? 'transparent') : colour}
          stroke={colour}
          strokeWidth="2"
        />
      </svg>
      {label}
    </span>
  );
}

/** Five-ish round ticks across the domain, always including 0. */
function tickValues(lo: number, hi: number): number[] {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [0];
  const rough = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    out.push(Math.abs(v) < step / 1000 ? 0 : v);
  }
  if (!out.some((v) => v === 0) && lo < 0 && hi > 0) out.push(0);
  return out.sort((a, b) => a - b);
}

function axisTick(value: number, usd: boolean): string {
  if (value === 0) return '0';
  const sign = value > 0 ? '+' : '-';
  const magnitude = Math.abs(value);
  return usd
    ? `${sign}${formatCompactUSD(magnitude)}`
    : `${sign}${(magnitude * 100).toFixed(1)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
