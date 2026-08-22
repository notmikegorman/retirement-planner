/**
 * MAGI chart (SPEC §9): each year's ACA / IRMAA / NIIT MAGI variants plotted
 * against that year's applicable thresholds. Threshold series only carry
 * values for the years they apply, so the dashed lines start/stop correctly
 * (ACA cliff through the ACA years, IRMAA from 2 years before Medicare, SS
 * tiers from claiming).
 */
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { YearRow } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { useChartTheme, type ChartPalette } from '../../theme';
import { buildMagiData, formatCompactUSD, type MagiRow } from './resultsData';

/** Series colors come from the active theme so dark mode stays legible. */
function series(chart: ChartPalette): Array<{
  key: keyof MagiRow;
  name: string;
  stroke: string;
  dash?: string;
}> {
  return [
    { key: 'acaMagi', name: 'ACA MAGI', stroke: chart.accent },
    { key: 'irmaaMagi', name: 'IRMAA MAGI', stroke: chart.violet },
    { key: 'niitMagi', name: 'NIIT MAGI', stroke: chart.teal },
    { key: 'acaCliff', name: 'ACA 400% FPL cliff', stroke: chart.bad, dash: '6 4' },
    { key: 'niitThreshold', name: 'NIIT threshold ($250K)', stroke: chart.amber, dash: '6 4' },
    { key: 'ssTier1', name: 'SS tier 1 ($32K)', stroke: chart.neutral, dash: '4 4' },
    { key: 'ssTier2', name: 'SS tier 2 ($44K)', stroke: chart.neutralStrong, dash: '4 4' },
    { key: 'irmaaTier1', name: 'IRMAA first tier', stroke: chart.warn, dash: '6 4' },
  ];
}

/**
 * What every acronym on this chart means, and — the part that actually matters —
 * what it costs you to cross each line.
 *
 * This chart is the densest thing in the app and was, for a long time, eight
 * initialisms and no english. A reader who cannot expand IRMAA cannot act on a
 * line labelled IRMAA, which makes the whole card decorative. The consequence
 * column is the point: these are not tax trivia, they are cliffs with prices.
 */
const GLOSSARY: Array<{ term: string; expands: string; means: string }> = [
  {
    term: 'MAGI',
    expands: 'Modified Adjusted Gross Income',
    means:
      'Your income for a particular rule’s purposes. There is no single MAGI — each programme ' +
      'modifies your AGI (Adjusted Gross Income) differently, which is why three separate MAGI ' +
      'lines are plotted rather than one.',
  },
  {
    term: 'ACA',
    expands: 'Affordable Care Act',
    means:
      'The health-insurance marketplace you buy from between retiring and turning 65. Its ' +
      'subsidy is the premium tax credit, and it is means-tested on ACA MAGI.',
  },
  {
    term: 'FPL',
    expands: 'Federal Poverty Level',
    means:
      'The yardstick ACA subsidies are measured against. At 400% of it there is a CLIFF, not a ' +
      'taper: one dollar over and the entire premium tax credit disappears for the year. On a ' +
      'plan like yours that is worth roughly $20,000 — the single most expensive line here.',
  },
  {
    term: 'IRMAA',
    expands: 'Income-Related Monthly Adjustment Amount',
    means:
      'A surcharge on Medicare Part B and Part D premiums for higher incomes. It uses your MAGI ' +
      'from TWO YEARS EARLIER, so the year you do a big Roth conversion is not the year you pay ' +
      'for it. Also a cliff: a dollar over a tier raises the premium for the whole year.',
  },
  {
    term: 'NIIT',
    expands: 'Net Investment Income Tax',
    means:
      'An extra 3.8% on investment income above $250,000 (married filing jointly). Unlike the ' +
      'others this one is a taper, not a cliff — you pay it only on the amount above the line — ' +
      'and the threshold is fixed in law, so inflation walks you into it.',
  },
  {
    term: 'SS tiers',
    expands: 'Social Security provisional-income tiers',
    means:
      'How much of your Social Security is taxable: below $32,000 none of it, above $44,000 up ' +
      'to 85% of it. Both figures are unindexed and have not moved since 1993, so almost every ' +
      'retiree eventually crosses them.',
  },
  {
    term: 'RMD',
    expands: 'Required Minimum Distribution',
    means:
      'The withdrawal the IRS forces out of your pre-tax accounts each year from age 75 (your ' +
      'birth year). It is income whether or not you want it, which is what pushes MAGI up late ' +
      'in the plan and drags these lines with it.',
  },
];

function Glossary() {
  return (
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
        What do these acronyms mean, and what does crossing each line cost?
      </summary>
      <table className="mini-table" style={{ marginTop: 8 }}>
        <tbody>
          {GLOSSARY.map((g) => (
            <tr key={g.term}>
              <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap', paddingRight: 12 }}>
                <strong>{g.term}</strong>
                <div className="muted" style={{ fontSize: 12 }}>{g.expands}</div>
              </td>
              <td style={{ whiteSpace: 'normal', lineHeight: 1.45 }}>{g.means}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function MagiChartCard({ referencePath }: { referencePath: YearRow[] }) {
  const chart = useChartTheme();
  const data = buildMagiData(referencePath);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>MAGI vs thresholds</h2>
      <div className="muted" style={{ marginTop: -4, marginBottom: 8 }}>
        Solid lines are your income as each rule counts it; dashed lines are the thresholds that
        cost you money when crossed.
      </div>
      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
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
          <Tooltip
            formatter={(value) => formatUSD(Number(value))}
            contentStyle={{
              background: chart.tooltip.bg,
              border: `1px solid ${chart.tooltip.border}`,
              borderRadius: 6,
            }}
            labelStyle={{ color: chart.tooltip.text }}
            itemStyle={{ color: chart.tooltip.text }}
          />
          <Legend />
          {series(chart).map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.name}
              stroke={s.stroke}
              strokeDasharray={s.dash}
              strokeWidth={s.dash ? 1.5 : 2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="muted">
        Nominal dollars from the deterministic reference path. Dashed threshold lines are drawn
        only over the years they apply; the IRMAA tier shows from 2 years before Medicare because
        premiums key off MAGI from 2 years prior — the boundary drawn at year Y is the premium
        year Y+2&apos;s threshold in that later year&apos;s dollars. SS provisional-income tiers
        and the NIIT threshold are unindexed by law.
      </div>
      <Glossary />
    </div>
  );
}
