/**
 * The Tithing tab, told in the order the user actually asks it:
 *
 *   1. WHAT DOES MY CHURCH RECEIVE, and starting when?
 *   2. Where does that money come from?
 *
 * It used to open with the carve-out's balance, which is the MECHANISM, and
 * left the giving as the fifth column of a seven-column table. That is the
 * wrong lead: the balance is an accounting device, and no cheque is written
 * because of it until the defer window ends. So the giving chart comes first
 * and the carve-out chart second, under a heading that says it is the source.
 *
 * The defer window is drawn rather than described. Under this strategy the
 * church receives NOTHING for the whole window — on a plan giving $27,600 a
 * year today, that is a decade-plus of zero — and a bar chart with a visible
 * hole in it states that in a way no sentence does. It is the most consequential
 * property of the design and it should be impossible to miss.
 *
 * Two hues, both validated rather than chosen: teal against the darker amber
 * separates at ΔE 13.6 under deuteranopia and 23.6 in normal vision, and both
 * clear 3:1 on the light surface. Stacked bars touch along an edge, which is
 * the hardest case for a weak pair.
 */
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RunResult, YearRow } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { useChartTheme, type ChartPalette } from '../../theme';
import { InfoTip } from '../profile/fields';
import { formatCompactUSD } from './resultsData';

const CARD_TIP =
  'What this plan actually hands to charity, year by year, and where it comes from. A tithe ' +
  'account is a carve-out INSIDE your largest pre-tax IRA — an accounting label on money that ' +
  'never leaves the account, so filling it is not a gift yet and costs nothing in tax. The gifts ' +
  'are the bars in the first chart; the balance in the second is what has been promised but not ' +
  'yet handed over.';

const GIVING_TIP =
  'Every dollar leaving the household for charity, in the year it leaves. Three kinds: the ' +
  'held pot paying out on its schedule once the account locks, the ongoing giving stream ' +
  'alongside it (for a growth tithe, a share of each new real high), and what a required ' +
  'minimum distribution forces out of the carve-out (the IRS sees one IRA and will not let ' +
  'the carve-out’s share stay inside — it is not yours to spend, so it is given). A hold that ' +
  'accrues the growth tithe gives nothing at all until it ends: that is the strategy working ' +
  'as designed, not a gap in the data.';

/** One year of the strategy, as every view here reads it. */
interface TitheRow {
  year: number;
  age: number | null;
  /** Cash the rule prescribed. */
  given: number;
  /** Cash an RMD forced out of the carve-out. */
  forced: number;
  /** Everything the household gave this year, charity's point of view. */
  totalGiven: number;
  /** The carve-out itself. */
  carveOut: number;
  /** The rest of the parent IRA — stacked ON TOP of the carve-out. */
  restOfIra: number;
  seeded: number;
  accrued: number;
  /** True before anyone retires: this is the paycheck tithe, not the rule. */
  working: boolean;
}

/**
 * The parent account id for a carve-out. The engine names it `<parent>-tithe`,
 * with a `-tithe2`/`-tithe3` bump on collision (mirroring `-sepp2`), so the
 * suffix is stripped with the same shape the engine writes it in.
 */
export function titheParentIdOf(carveOutId: string): string {
  return carveOutId.replace(/-tithe\d*$/, '');
}

/**
 * Every year of the plan, not just the carve-out's life. The working years
 * belong here: "my church got $27,600 and will get $0 for twelve years" is the
 * comparison the user is actually making, and it cannot be seen from a table
 * that starts at retirement.
 */
export function buildTitheRows(referencePath: YearRow[]): TitheRow[] {
  return referencePath.map((r) => {
    const parentId = r.tithe ? titheParentIdOf(r.tithe.accountId) : null;
    const parentTotal = parentId ? (r.balances.byAccount[parentId] ?? 0) : 0;
    const forced = r.tithe?.forcedDistributionGiven ?? 0;
    return {
      year: r.year,
      age: r.agesAtYearEnd[0] ?? null,
      // expenses.charitable is the household's whole gift for the year; the
      // rule's own share is whatever the forced distribution did not cover.
      given: Math.max(0, r.expenses.charitable - forced),
      forced,
      totalGiven: r.expenses.charitable,
      carveOut: r.balances.tithe,
      restOfIra: Math.max(0, parentTotal),
      seeded: r.tithe?.seeded ?? 0,
      accrued: r.tithe?.accrued ?? 0,
      working: r.income.wages > 0,
    };
  });
}

function GivingTooltip({
  active,
  payload,
  label,
  chart,
}: {
  active?: boolean;
  payload?: Array<{ payload: TitheRow }>;
  label?: number | string;
  chart: ChartPalette;
}) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const line = (name: string, v: number, color?: string) => (
    <div style={{ display: 'flex', gap: 14, justifyContent: 'space-between' }}>
      <span style={{ color: color ?? chart.tooltip.text }}>{name}</span>
      <span>{formatUSD(v)}</span>
    </div>
  );
  return (
    <div
      style={{
        background: chart.tooltip.bg,
        border: `1px solid ${chart.tooltip.border}`,
        color: chart.tooltip.text,
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 13,
        minWidth: 220,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {label}
        {r.age !== null ? ` · age ${r.age}` : ''}
      </div>
      {r.totalGiven === 0 ? (
        <div className="muted">Nothing given this year.</div>
      ) : (
        <>
          {r.given > 0 && line(r.working ? 'From your paycheck' : 'From the rule', r.given, chart.teal)}
          {r.forced > 0 && line('Forced out by an RMD', r.forced, chart.warn)}
          {r.given > 0 && r.forced > 0 && line('Total', r.totalGiven)}
        </>
      )}
      {r.carveOut > 0 && (
        <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          Promised, not yet given: {formatUSD(r.carveOut)}
        </div>
      )}
    </div>
  );
}

/** One headline figure. */
function Stat({
  label,
  value,
  tip,
  tone,
}: {
  label: string;
  value: string;
  tip?: string;
  tone?: string;
}) {
  return (
    <div style={{ minWidth: 148 }}>
      <div className="metric-label">
        {label}
        {tip ? <InfoTip label={label.toLowerCase()} text={tip} /> : null}
      </div>
      <div className={tone ? `wb-metric-value ${tone}` : 'wb-metric-value'}>{value}</div>
    </div>
  );
}

export function TitheCard({ result }: { result: RunResult }) {
  const chart = useChartTheme();
  const rows = buildTitheRows(result.referencePath);
  const legacy = result.charitableLegacy;
  const hasCarveOut = rows.some((r) => r.carveOut > 0);

  // The first year the RULE gives — not the paycheck stream it replaced, and
  // not a forced distribution, which is what makes it the answer to "when does
  // my giving start again".
  const firstRuleGift = rows.find((r) => !r.working && r.given > 0);
  const lastWorkingGift = [...rows].reverse().find((r) => r.working && r.totalGiven > 0);
  const silentYears = firstRuleGift
    ? rows.filter((r) => !r.working && r.year < firstRuleGift.year && r.totalGiven === 0).length
    : rows.filter((r) => !r.working && r.totalGiven === 0).length;
  const seedRow = rows.find((r) => r.seeded > 0);
  const last = rows[rows.length - 1];

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Tithing
        <InfoTip label="this plan’s giving" text={CARD_TIP} />
      </h2>

      <div className="wb-metrics" style={{ marginBottom: 6 }}>
        <Stat
          label="Cash giving restarts"
          value={firstRuleGift ? String(firstRuleGift.year) : 'never'}
          tone={firstRuleGift ? undefined : 'bad'}
          tip={
            firstRuleGift
              ? 'The first year the ongoing method writes a cheque. Under a hold that accrues ' +
                'the growth tithe that is one year after the hold ends, because a gift is priced ' +
                'off the previous year’s growth and the last held year’s growth already went ' +
                'into the account — paying cash on it too would give the same growth away twice. ' +
                'A give-cash hold, or a non-growth method, pays from retirement instead.'
              : 'This plan never resumes cash giving under the ongoing method: nothing its base ' +
                'reads (new real highs, income drawn, a set amount) ever produces a gift.'
          }
        />
        <Stat
          label="First year’s gift"
          value={firstRuleGift ? formatUSD(firstRuleGift.given) : '—'}
          tip={
            'What the ongoing method prescribes for its first year — for a growth tithe, a ' +
            'share of the previous year’s new real high. It varies with the markets every year ' +
            'after, which is what the chart below shows.'
          }
        />
        <Stat
          label="Years giving nothing"
          value={String(silentYears)}
          tone={silentYears > 0 ? 'warn' : undefined}
          tip={
            'Retired years in which your church receives nothing at all. The hold is deliberate — ' +
            'the tithe is accruing inside the IRA instead — but the money does not reach anyone ' +
            'until the hold ends, and this is the count of years that is true for.'
          }
        />
        <Stat
          label="Given over the plan"
          value={formatUSD(legacy.cashGivenReal)}
          tip="Today’s dollars: every year’s cash gift added up, working years included."
        />
        <Stat
          label="Left to charity at death"
          value={formatUSD(legacy.terminalTitheReal)}
          tip={
            'Today’s dollars. The carve-out is not given during your life — it reaches charity at ' +
            'the horizon, which for a traditional IRA is the one destination that owes no income ' +
            'tax on the way out.'
          }
        />
        <Stat
          label="Total to charity"
          value={formatUSD(legacy.totalReal)}
          tone="good"
          tip="Today’s dollars: cash given during your life plus the carve-out left at death."
        />
      </div>

      {lastWorkingGift && firstRuleGift && (
        <div className="field-help" style={{ marginBottom: 8 }}>
          Your church receives {formatUSD(lastWorkingGift.totalGiven)} in {lastWorkingGift.year},
          then nothing for {silentYears} years, then {formatUSD(firstRuleGift.given)} in{' '}
          {firstRuleGift.year}. Shortening the hold on the left starts the cash sooner and leaves
          less in the account at death.
        </div>
      )}

      <h3 style={{ marginBottom: 2 }}>
        What your church receives
        <InfoTip label="the giving chart" text={GIVING_TIP} />
      </h3>
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={chart.grid} vertical={false} />
          <XAxis dataKey="year" stroke={chart.axis} tick={{ fill: chart.axis, fontSize: 12 }} />
          <YAxis
            stroke={chart.axis}
            tick={{ fill: chart.axis, fontSize: 12 }}
            tickFormatter={formatCompactUSD}
            width={62}
          />
          <Tooltip content={<GivingTooltip chart={chart} />} cursor={{ fill: chart.grid, opacity: 0.35 }} />
          {/*
            isAnimationActive={false}, as every other chart here sets it. The
            bars mount when the tab is first selected, and recharts' entry
            animation starts them at zero height — which is where they stayed,
            rendering 72 empty <g> elements and a chart that looked like a
            household giving nothing. Not a data problem; the data was right the
            whole time.
          */}
          <Bar
            dataKey="given"
            stackId="give"
            name="Given"
            fill={chart.teal}
            isAnimationActive={false}
          />
          <Bar
            dataKey="forced"
            stackId="give"
            name="Forced out by an RMD"
            fill={chart.warn}
            isAnimationActive={false}
          />
          {firstRuleGift && (
            <ReferenceLine
              x={firstRuleGift.year}
              stroke={chart.neutralStrong}
              strokeDasharray="4 4"
              label={{
                value: 'cash giving restarts',
                position: 'insideTopLeft',
                fill: chart.axis,
                fontSize: 11,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="chip-list" style={{ marginTop: 4 }}>
        <span className="wb-chip">
          <span style={{ color: chart.teal }}>■</span> Given
        </span>
        <span className="wb-chip">
          <span style={{ color: chart.warn }}>■</span> Forced out by an RMD
        </span>
      </div>

      {hasCarveOut && (
        <>
          <h3 style={{ marginBottom: 2 }}>Where it comes from</h3>
          <div className="muted" style={{ marginBottom: 4 }}>
            The carve-out inside your IRA. Stacked under the rest of that account, so the top of
            the band is the whole IRA and the lower slice is the part already promised away.
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={chart.grid} vertical={false} />
              <XAxis dataKey="year" stroke={chart.axis} tick={{ fill: chart.axis, fontSize: 12 }} />
              <YAxis
                stroke={chart.axis}
                tick={{ fill: chart.axis, fontSize: 12 }}
                tickFormatter={formatCompactUSD}
                width={62}
              />
              <Tooltip content={<GivingTooltip chart={chart} />} />
              {/* The carve-out sits at the BOTTOM so it is read against the
                  axis rather than floating on a moving baseline. */}
              <Area
                type="monotone"
                dataKey="carveOut"
                stackId="ira"
                name="Tithe account"
                stroke={chart.teal}
                strokeWidth={2}
                fill={chart.teal}
                fillOpacity={0.55}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="restOfIra"
                stackId="ira"
                name="Rest of the IRA"
                stroke={chart.accent}
                strokeWidth={2}
                fill={chart.accent}
                fillOpacity={0.16}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="chip-list" style={{ marginTop: 4 }}>
            <span className="wb-chip">
              <span style={{ color: chart.teal }}>■</span> Tithe account
            </span>
            <span className="wb-chip">
              <span style={{ color: chart.accent }}>■</span> Rest of the IRA
            </span>
          </div>
        </>
      )}

      <h3>Year by year</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>Age</th>
              <th>Given to charity</th>
              <th>of which forced by RMD</th>
              <th>Into the account</th>
              <th>Account balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const intoAccount = r.seeded > 0 ? r.seeded : r.accrued;
              return (
                <tr key={r.year}>
                  <td>
                    {r.year}
                    {r.seeded > 0 ? (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        opens
                      </span>
                    ) : null}
                  </td>
                  <td>{r.age ?? '—'}</td>
                  <td>
                    {r.totalGiven > 0 ? (
                      <>
                        {formatUSD(r.totalGiven)}
                        {r.working ? <span className="muted"> (from pay)</span> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{r.forced > 0 ? formatUSD(r.forced) : <span className="muted">—</span>}</td>
                  <td>
                    {intoAccount > 0 ? formatUSD(intoAccount) : <span className="muted">—</span>}
                  </td>
                  <td>{r.carveOut > 0 ? formatUSD(r.carveOut) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="field-help" style={{ marginTop: 6 }}>
        Nominal dollars, from the deterministic reference path — the same path the year-by-year
        cashflow table walks. “Into the account” is an internal transfer between two labels on the
        same IRA: no distribution, no tax, and nothing reaches charity because of it until the
        balance is left to them
        {last.carveOut > 0 ? ` — ${formatUSD(last.carveOut)} of it in ${last.year}` : ''}. The
        totals above are today’s dollars, because summing thirty years of nominal figures would add
        2032 dollars to 2061 dollars.
      </div>
    </div>
  );
}
