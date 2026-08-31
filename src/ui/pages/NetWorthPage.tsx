/**
 * Net Worth — the ledger page. One button, one number to type behind it, and a
 * history.
 *
 * A snapshot is a RECORD of a moment, and the page keeps the two inputs
 * honest about who supplies them:
 *  - PRICES are the server's: the snapshot route refreshes quotes for every
 *    holdings symbol first, then prices the accounts through the same
 *    resolver every simulation uses. Each row stores the prices it used.
 *  - THE HOME VALUE is the user's: no feed prices a house, so the box asks for
 *    it and defaults to the last snapshot's figure (the profile's home value
 *    only seeds the very first one).
 *
 * The box asks from inside a MODAL rather than from a permanent row on the
 * card. A number typed once every few weeks does not deserve standing floor
 * space above the chart it pushes down, and the button that opens the modal is
 * the whole card: one control, one decision, and the page's vertical budget
 * spent on the history instead.
 *
 * Deliberately NOT a projection surface: no simulated futures, no engine, no
 * assumptions — the chart is only "what it added up to on the days I looked",
 * which is exactly what the Workbench cannot show.
 *
 * It draws that as a stacked bar per snapshot rather than a line through the
 * totals, because the total alone hides the question the ledger is actually
 * asked. Two snapshots a year apart can share a total while the house went up
 * and the portfolio went down, and a line cannot say so. The bar carries both:
 * its height is the total, its slices are where the money sat. (The assembly —
 * segments, colours, size ordering, the union of accounts — is netWorthChart.ts.)
 *
 * THE TWO CHARTS BELOW THE BARS are the trends the user asked for: what THE
 * PLAN scored on each of those days, and what it could afford. Each is a
 * separate plot on the same categorical axis rather than another series on the
 * bars, because millions of dollars, a probability and an annual spend need
 * three scales — and two series sharing a plot on two scales invite the eye to
 * read a crossing point that means nothing at all. A snapshot with no reading
 * is a gap in that line, never a zero: zero success reads as "this plan fails
 * in every future" and zero spend as "this household can afford nothing",
 * and neither is what "nobody measured this" means. (Assembly:
 * netWorthScoreChart.ts.)
 *
 * BOTH ARE OF THE PLAN AS IT THEN STOOD, and the page says so wherever it shows
 * one: plan.json changes on every knob turn, so a point is a reading of the
 * plan at that moment — which the plan's History remembers by hash even after
 * the plan has moved on. The chart marks the point where the plan changed
 * rather than drawing a smooth line through it.
 *
 * WHY THE SPEND LINE IS WORTH A WHOLE PLOT: this household's success rate
 * saturates. Every version reads 96-point-something, so the probability trend
 * can be flat while the plan gets materially better or worse — and the dollars
 * are what say which.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Rectangle,
  type RectangleProps,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { NetWorthSnapshot, SnapshotScore } from '../../shared/types';
import { formatUSD } from '../../shared/util';
import { api } from '../api';
import { NET_WORTH_FIRST_RUN, simulationReadiness } from '../firstRun';
import {
  NETWORTH_TAB_IDS,
  NETWORTH_TAB_STORAGE_KEY,
  resolveTab,
  writeStoredTab,
  type NetWorthTabId,
  type PageProps,
} from '../nav';
import { ModuleBanner } from '../modules/ModuleBanner';
import { useChartTheme, type ChartPalette } from '../theme';
import { useToast } from '../toast';
import { NumberField, TextField } from '../components/profile/fields';
import {
  buildNetWorthChart,
  formatSnapshotDate,
  hoveredSlice,
  tooltipPosition,
  type BoxSize,
  type ChartPoint,
  type HoveredSlice,
  type NetWorthBar,
  type NetWorthSegment,
} from './netWorthChart';
import {
  BREAK_CHIP_LABEL,
  UNKNOWN_CHIP_LABEL,
  scoreChartEmptyNote,
  spendChartEmptyNote,
  buildScoreSeries,
  formatScorePct,
  scoreAt,
  scoreAxisTick,
  scoreMark,
  scoreTooltipLines,
  spendTooltipLines,
  type ScoreMark,
  type ScorePoint,
} from './netWorthScoreChart';

/**
 * The size of a rendered node, kept in state and updated when it changes.
 *
 * A ResizeObserver rather than a one-shot measurement in a callback ref,
 * because the hover card is re-rendered in place with different text on every
 * slice — "Savings / $31,400" and "Home (as entered) / $640,000" are not the
 * same width, and a ref callback only fires when the NODE changes, not when its
 * contents do. The plot area needs the observer for the ordinary reason: the
 * chart is width:100% and the window is resizable.
 *
 * `null` until the first measurement, so callers can tell "not measured yet"
 * from "measured, and it is zero".
 */
function useMeasuredSize(): [BoxSize | null, (node: HTMLElement | null) => void] {
  const [size, setSize] = useState<BoxSize | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    const apply = () => {
      const { width, height } = node.getBoundingClientRect();
      // Guarded, or every observation would setState and re-render forever.
      setSize((prev) =>
        prev !== null && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(node);
    observer.current = ro;
  }, []);
  return [size, measure];
}

/**
 * Where to put the card before it has ever been measured — one frame, on the
 * very first hover of a session. The real card measured 218x86 in the browser
 * at the default 13px/8px-12px styling; these are that, rounded up, so the
 * first frame's edge flip is decided against a plausible box rather than a zero
 * one (a zero-width card never flips, and would be drawn off the right edge).
 */
const TOOLTIP_CARD_ESTIMATE: BoxSize = { width: 224, height: 88 };

/**
 * Hover card in the app's tooltip idiom (the withdrawal-rate chart's), about
 * ONE slice: the one under the cursor.
 *
 * It used to list every segment and the bar's total, which meant a reader
 * pointing at a band got six rows and had to find the right one again. The legend
 * already names the segments and the table below already carries the totals;
 * what the pointing gesture asks is "what is THAT", so the answer is that
 * slice's label, its figure, its share of the day (a fact about the piece,
 * which its dollar figure alone cannot give), and the condition it was recorded
 * under.
 *
 * IT NAMES THE SLICE FROM `hovered`, NOT FROM RECHARTS' PAYLOAD. The user's
 * report was "it displays the value for IRA no matter what I hover over", and
 * the IRA is segment[0] — the bottom of the stack. Reading `payload[0]` is what
 * made every slice answer "IRA"; see the <Tooltip> comment below for why the
 * payload arrives holding the whole column. `hovered` is the page's own state,
 * set by the very Bar the pointer is inside, so it cannot drift from the slice
 * that is outlined — and no recharts event-mode change can quietly re-point it
 * at segment 0.
 */
function SnapshotTooltip({
  hovered,
  bars,
  segments,
  chart,
  cardRef,
}: {
  hovered: HoveredSlice | null;
  bars: NetWorthBar[];
  segments: NetWorthSegment[];
  chart: ChartPalette;
  cardRef: (node: HTMLDivElement | null) => void;
}) {
  // The whole reading — which bar, which segment, the figure and the share —
  // comes from `hovered` through one pure function, so the answer this card
  // gives is unit-testable without a browser (tests/ui/netWorthChart.test.ts).
  const reading = hoveredSlice(hovered, bars, segments);
  if (reading === null) return null;
  const { bar, segment: seg, value, share } = reading;
  return (
    <div
      // Measured, not guessed: the card is the thing `tooltipPosition` flips to
      // the other side of the cursor at an edge, and its width changes with the
      // account name and the figure inside it.
      ref={cardRef}
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
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{bar.date}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
        <span style={{ color: seg.fill }}>{seg.isHome ? 'Home (as entered)' : seg.label}</span>
        <span>{formatUSD(value)}</span>
      </div>
      {share === null ? null : (
        <div className="muted" style={{ marginTop: 2, fontSize: 12 }}>
          {share}
        </div>
      )}
      {/* The condition differs by who supplied the figure, and saying "prices as
          of the snapshot moment" over a house nobody priced would be a lie. */}
      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
        {seg.isHome ? 'the value you entered that day' : 'prices as of the snapshot moment'}
      </div>
    </div>
  );
}

/**
 * The snapshot form, on the platform's <dialog> + showModal(): focus trapping,
 * Escape-to-close, the background made inert and the backdrop all come from the
 * element, so the app owns none of that code and cannot get it subtly wrong.
 *
 * The body is mounted only while open, because NumberField/TextField seed their
 * text state once at mount — a dialog left mounted would still be showing the
 * home value from two snapshots ago.
 */
function SnapshotDialog({
  open,
  homeValue,
  note,
  taking,
  error,
  onHomeValue,
  onNote,
  onDismiss,
  onConfirm,
}: {
  open: boolean;
  homeValue: number;
  note: string;
  taking: boolean;
  error: string | null;
  onHomeValue: (value: number) => void;
  onNote: (value: string) => void;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="modal"
      ref={ref}
      // Escape raises 'cancel'. It is refused while the request is in flight:
      // the server is already refreshing quotes, and a dialog dismissed
      // mid-write leaves the outcome — including the failure — nowhere to land.
      onCancel={(e) => {
        e.preventDefault();
        if (!taking) onDismiss();
      }}
      onClose={onDismiss}
    >
      {open ? (
        <>
          <h3 style={{ marginTop: 0 }}>Take a snapshot</h3>
          <div className="row">
            <NumberField
              label="Home value ($)"
              value={homeValue}
              width={160}
              help="Your number — no feed prices a house"
              onCommit={(v) => onHomeValue(v ?? homeValue)}
            />
            <TextField
              label="Note"
              value={note}
              width={260}
              placeholder="optional"
              onCommit={onNote}
            />
          </div>
          <div className="field-help" style={{ marginTop: 8 }}>
            Taking a snapshot refreshes every holdings symbol&rsquo;s price first, then records
            each account&rsquo;s balance — derived for holdings accounts, as typed for manual
            ones — plus the home value above. Prices as of the snapshot moment; the home value
            as you entered it.
          </div>
          {/* Stays INSIDE the dialog, which stays open: the number just typed is
              the expensive part of this form, and closing on a failed request
              would throw it away along with the message explaining the failure. */}
          {error === null ? null : (
            <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button onClick={onDismiss} disabled={taking}>
              Cancel
            </button>
            <button className="primary" disabled={taking} onClick={() => void onConfirm()}>
              {taking ? 'Refreshing prices…' : 'Take snapshot'}
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/**
 * The provenance a scored row shows on hover.
 *
 * Two vocabularies, because the ledger holds rows from both: a row recorded
 * since the collapse scored THE PLAN, and one recorded before it scored a
 * separately frozen baseline, under a label that only that row remembers.
 * Naming the older one by its own words is the point — it is a historical fact
 * about a number already on the chart, not a defect to be papered over.
 */
function scoreRowTitle(score: SnapshotScore): string {
  const what =
    score.baselineLabel !== undefined
      ? `baseline r${score.baselineRevision} “${score.baselineLabel}”`
      : 'the plan as it then stood';
  // The spend figure rides along when there is one — the cell shows a
  // percentage, and the dollars are the half that separates two versions of
  // this plan. Absent when it was never solved for; never a zero.
  const spend =
    score.sustainableSpend === undefined
      ? ''
      : ` · ${formatUSD(score.sustainableSpend)}/yr sustainable` +
        (score.sustainableSpendPaths === undefined
          ? ''
          : ` at ${score.sustainableSpendPaths.toLocaleString('en-US')} paths`);
  return (
    `Scored ${formatSnapshotDate(score.scoredAt)} · ${what} · ` +
    `${score.paths.toLocaleString('en-US')} paths · engine ${score.engineVersion}${spend}`
  );
}

/**
 * WHAT ONE TREND PLOT DRAWS: which reading of a point it is a picture of, and
 * every word its hover card says.
 *
 * The two plots under the bars — the probability and the dollars — share their
 * x axis, their gap rule, their comparability marks and every line of the
 * pointer-following machinery below. Only the reading differs, so only the
 * reading is a parameter. Two copies of <TrendChart> would be two copies of the
 * tooltip positioning that took a day to get right, and the second copy is the
 * one that silently stops being fixed.
 */
interface TrendSpec {
  /** The recharts data key AND the field this plot reads. Null draws a gap. */
  dataKey: 'pct' | 'spend';
  /**
   * The card's left-hand label — whose number this is, said EVERY time. Never
   * "your plan right now": a recorded figure is of the plan as it stood when
   * the row was scored, and a reader who forgets that reads the chart wrong.
   */
  label: string;
  /** The reading, formatted for the card. */
  format: (value: number) => string;
  /** What the card says where the number would be, when there is none. */
  absent: string;
  /** The conditions and the caveats, one per line, under the headline. */
  lines: (point: ScorePoint) => string[];
  /** Axis ticks. */
  tick: (value: number) => string;
}

const SCORE_TREND: TrendSpec = {
  dataKey: 'pct',
  label: 'The plan, as scored',
  format: formatScorePct,
  absent: 'not scored',
  lines: scoreTooltipLines,
  tick: (v) => `${v}%`,
};

/**
 * The spend spec's static half. Its `lines` is completed per render inside
 * the component, because "is this row's solve still running" is a fact about
 * the in-flight registry — live state — and a module constant cannot see it.
 * That gap is exactly what used to make a mid-solve row show the permanent
 * none-can-be-added sentence (the Phase-4 wording quirk).
 */
const SPEND_TREND: TrendSpec = {
  dataKey: 'spend',
  label: 'Most it could spend',
  format: (v) => `${formatUSD(v)}/yr`,
  // Not "not scored": a row can carry a perfectly good probability and no
  // dollars at all, which is a different absence and has its own reasons.
  absent: 'no figure',
  lines: spendTooltipLines,
  tick: (v) => formatUSD(v),
};

/**
 * THE ONE PLACE THE MARKS PICK UP THEIR COLOUR — dot, boundary rule and hover
 * card border all read it, so a point cannot end up ringed in one colour and
 * ruled in another. Null means "no mark", which each caller renders as its own
 * ordinary state rather than as a colour.
 *
 * Amber is the alarm colour this app already uses for "these two numbers were
 * never on one scale". The unknown mark deliberately does NOT get it: it is a
 * weaker claim, and giving it the alarm colour is exactly how "the app cannot
 * tell" got read as "the plan changed". `neutralStrong` is the palette's
 * high-contrast grey — visible without shouting.
 */
function markColor(mark: ScoreMark, chart: ChartPalette): string | null {
  if (mark === 'break') return chart.amber;
  return mark === 'unknown' ? chart.neutralStrong : null;
}

/**
 * A trend line's hover card. Same idiom as the bar chart's above it — a
 * single point, named from the page's OWN hover index rather than from
 * recharts' payload — and the same reasoning: the payload is rebuilt from
 * chart state that a hover-driven re-render can invalidate, and a card that
 * reads it can end up describing a different day from the one under the
 * cursor. That bug cost a day on the chart above; it is not being re-invited
 * here.
 *
 * What it says is the point's OWN conditions — paths, seed, engine version,
 * and what was scored — because two of those silently decide whether this
 * number can be compared with the one beside it.
 */
function TrendTooltip({
  point,
  spec,
  chart,
  cardRef,
}: {
  point: ScorePoint | null;
  spec: TrendSpec;
  chart: ChartPalette;
  cardRef: (node: HTMLDivElement | null) => void;
}) {
  if (point === null) return null;
  const reading = point[spec.dataKey];
  const mark = scoreMark(point);
  return (
    <div
      ref={cardRef}
      style={{
        background: chart.tooltip.bg,
        border: `1px solid ${markColor(mark, chart) ?? chart.tooltip.border}`,
        color: chart.tooltip.text,
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: 13,
        maxWidth: 320,
        boxShadow: 'var(--shadow)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{point.date}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 }}>
        <span style={{ color: reading === null ? chart.axis : chart.accent }}>
          {spec.label}
        </span>
        <span>{reading === null ? spec.absent : spec.format(reading)}</span>
      </div>
      {spec.lines(point).map((line) => (
        <div key={line} className="muted" style={{ marginTop: 3, fontSize: 12 }}>
          {line}
        </div>
      ))}
    </div>
  );
}

/**
 * One trend plot: a dot per point that has a reading, a gap for every point
 * that has none, and a mark wherever two neighbouring points are not on one
 * scale.
 *
 * IT OWNS ITS OWN HOVER STATE rather than sharing the page's, and each instance
 * owns its own separately: the plots are separate plots, a pointer is in
 * exactly one of them, and one shared "hovered" would have every card on the
 * page believing it was the one being pointed at.
 */
function TrendChart({
  points,
  domain,
  chart,
  spec,
}: {
  points: ScorePoint[];
  domain: [number, number];
  chart: ChartPalette;
  spec: TrendSpec;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [pointer, setPointer] = useState<ChartPoint | null>(null);
  const [plotSize, measurePlot] = useMeasuredSize();
  const [cardSize, measureCard] = useMeasuredSize();

  const point = scoreAt(points, hovered);
  const cardAt =
    point !== null && pointer !== null && plotSize !== null
      ? tooltipPosition(pointer, cardSize ?? TOOLTIP_CARD_ESTIMATE, plotSize)
      : undefined;

  return (
    <div ref={measurePlot}>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart
          data={points}
          margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
          /* Axis mode here, unlike the stacked bars: a line has one series, so
             "which point" is entirely a question about the x position, and
             recharts' own activeTooltipIndex is that answer. It arrives on the
             same mouse state as chartX/chartY, so both readings come from one
             event and cannot disagree. */
          onMouseMove={(state: {
            chartX?: number;
            chartY?: number;
            activeTooltipIndex?: number;
          }) => {
            if (typeof state.chartX === 'number' && typeof state.chartY === 'number') {
              setPointer({ x: state.chartX, y: state.chartY });
            }
            setHovered(typeof state.activeTooltipIndex === 'number' ? state.activeTooltipIndex : null);
          }}
          onMouseLeave={() => {
            setPointer(null);
            setHovered(null);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
          {/* The bars' axis, tick for tick: same rows, same order, so reading
              straight down from a bar lands on that day's score.

              Keyed on `axisKey` rather than on `date`, and labelled back to
              the date. Two snapshots on one day would give two ticks the same
              category value, and recharts answers duplicated categories by
              scaling on serial numbers instead — at which point a
              ReferenceLine addressed by the date resolves to nothing and is
              discarded without a word. The ticks read identically either way;
              the difference is that the boundary rules below still draw. */}
          <XAxis
            dataKey="axisKey"
            tickFormatter={scoreAxisTick}
            stroke={chart.axis}
            tick={{ fill: chart.axis }}
          />
          {/* NEVER THE FULL RANGE. This household's scores live in a
              nine-point band and its spend figures inside a few thousand
              dollars; an axis from zero would draw every one of them as the
              same straight line. Each domain is fitted to its own data but
              never narrower than its own minimum span, so a wobble inside the
              engine's own resolution cannot be inflated into a cliff (see
              scoreDomain and spendDomain). */}
          <YAxis
            width={84}
            domain={domain}
            tickFormatter={spec.tick}
            stroke={chart.axis}
            tick={{ fill: chart.axis }}
          />
          <Tooltip
            active={point !== null}
            position={cardAt}
            isAnimationActive={false}
            cursor={false}
            content={
              <TrendTooltip point={point} spec={spec} chart={chart} cardRef={measureCard} />
            }
          />
          {/* A vertical rule at every boundary the chart cannot draw straight
              through. The dot alone marks the point; the rule marks the
              BOUNDARY, which is what a reader needs — the condition is between
              this point and the one before it, not a property of either.

              TWO RULES, NOT ONE. A dashed amber rule is the provable break; a
              finely-dotted grey one is the boundary the app cannot judge. They
              differ in colour AND in stroke, because colour alone is a channel
              a colour-blind reader does not have, and this is precisely the
              distinction he must not miss. */}
          {points.map((p, i) => {
            const mark = scoreMark(p);
            const color = markColor(mark, chart);
            return color === null ? null : (
              <ReferenceLine
                key={`break-${p.takenAt}-${i}`}
                x={p.axisKey}
                stroke={color}
                strokeDasharray={mark === 'break' ? '4 4' : '1 5'}
              />
            );
          })}
          <Line
            type="linear"
            dataKey={spec.dataKey}
            stroke={chart.accent}
            strokeWidth={2}
            /* THE GAP IS THE POINT. A snapshot with no reading must leave a
               hole in the line, not a value: connecting across it would draw a
               straight segment through days nothing was measured, and dropping
               to 0 would draw a catastrophe (or a household that can afford
               nothing) that never happened. */
            connectNulls={false}
            isAnimationActive={false}
            activeDot={false}
            dot={(props: unknown) => {
              // recharts types `dot` as the Line's props; what it passes is one
              // point's geometry plus its datum. The cast is that gap.
              const d = props as { cx?: number; cy?: number; index?: number; payload?: ScorePoint };
              const datum = d.payload;
              const key = `dot-${d.index ?? 0}`;
              if (
                !datum ||
                datum[spec.dataKey] === null ||
                d.cx === undefined ||
                d.cy === undefined
              ) {
                // A row with no reading has no dot at all — the gap says it.
                return <g key={key} />;
              }
              const mark = scoreMark(datum);
              const color = markColor(mark, chart);
              return (
                <circle
                  key={key}
                  cx={d.cx}
                  cy={d.cy}
                  /* A hollow ring, bigger than the plain dot, because a reader
                     must see the condition without hovering.

                     SOLID AMBER for a provable break; DOTTED GREY for the
                     boundary the app cannot judge. The broken stroke is the
                     mark's own claim about itself, and it is what the legend's
                     ◌ glyph is drawn to echo — the user reported that one
                     ring with one meaning was already unreadable, so two
                     meanings could not share it. */
                  r={color === null ? 3.5 : 6}
                  fill={color === null ? chart.accent : chart.tooltip.bg}
                  stroke={color ?? chart.accent}
                  strokeWidth={color === null ? 1 : 2.5}
                  strokeDasharray={mark === 'unknown' ? '2 2' : undefined}
                />
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * How often the page asks which rows still have a simulation running.
 *
 * A final-quality run is minutes, so this is a progress check, not a race:
 * every poll is one tiny GET against a server on this machine, and 2.5s is
 * quick enough that a score appears to land on its own while the page is left
 * open. Polling STOPS the moment nothing is in flight — an idle Net Worth page
 * makes no requests at all.
 */
const SCORING_POLL_MS = 2500;

/**
 * The four views, one per panel (the owner's reorganisation, 2026-08-30).
 * The ids live in nav.ts because they are URL segments (/networth/trend);
 * this record supplies the words, and a tab without a label fails to
 * compile.
 */
const NETWORTH_TAB_LABELS: Record<NetWorthTabId, string> = {
  trend: 'Trend',
  score: 'Score',
  spend: 'Spend',
  snapshots: 'Snapshots',
};

export function NetWorthPage({ route, navigate, storedTab }: PageProps) {
  const chart = useChartTheme();
  const { showToast } = useToast();
  const [snapshots, setSnapshots] = useState<NetWorthSnapshot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * Rows with a simulation in flight RIGHT NOW, from the server's own memory.
   *
   * This is what separates "scoring…" from "no score, and none is coming" —
   * two states that look identical on a row and mean opposite things. It is
   * deliberately not stored on the row: a persisted "scoring" flag would
   * survive a server restart that the run did not, and be a lie for ever after.
   */
  const [scoring, setScoring] = useState<string[]>([]);
  const scoringRef = useRef<string[]>([]);
  /**
   * Rows whose scoring run was INTERRUPTED (a killed tab, a restart) and
   * still verifies completable against today's inputs — from the write-ahead
   * intent file, via the backend's boot healer (store/scoringIntent.ts).
   * These get the one-click Finish-scoring offer (decision D4): completing
   * one fills the blank the kill left with the SAME measurement, which the
   * runKey check makes provable rather than hoped.
   */
  const [interrupted, setInterrupted] = useState<string[]>([]);
  const [finishError, setFinishError] = useState<string | null>(null);
  /**
   * The home-value box's committed value. Null until the defaults load —
   * last snapshot's figure first, the profile's current home value only when
   * the ledger is empty (the profile is a starting guess, not a record).
   */
  const [homeValue, setHomeValue] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [taking, setTaking] = useState(false);
  /**
   * ZERO-START'S GATE (src/ui/firstRun.ts): with zero accounts a snapshot
   * would record a "total" of nothing and immediately start scoring a
   * 0-account simulation — a row of zeros pretending to be a measurement.
   * The button is replaced by the honest note; existing rows (recorded when
   * accounts existed) stay fully readable.
   */
  const [snapshotGated, setSnapshotGated] = useState(false);
  /**
   * Two error slots, because they are read in two places now. A failed snapshot
   * belongs in the dialog beside the form that caused it; a failed delete
   * belongs beside the table, where the dialog would never be open to show it.
   */
  const [takeError, setTakeError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * Which rectangle the cursor is in, so exactly one slice can be outlined.
   * recharts' own `activeIndex` is the CATEGORY index, which would outline every
   * segment of the hovered bar — the whole column — and say nothing about which
   * one the tooltip is describing.
   */
  const [hovered, setHovered] = useState<HoveredSlice | null>(null);
  /**
   * The pointer, in the chart's own pixel space, so the card can be drawn where
   * the mouse is. The user's report was "the tooltip needs to pop up wherever
   * my mouse is — at present it always pops at the top of the bar stack".
   *
   * It has to come from <BarChart onMouseMove>, because that handler is given
   * recharts' own chartX/chartY — the same space the tooltip's transform is
   * applied in. A DOM mouse event would be in client coordinates and would need
   * the container's offset subtracted back off by hand.
   */
  const [pointer, setPointer] = useState<ChartPoint | null>(null);
  const [plotSize, measurePlot] = useMeasuredSize();
  const [cardSize, measureCard] = useMeasuredSize();

  // The URL's opinion first, storage's second, 'trend' third — the same
  // precedence every tabbed page uses (nav.ts resolveTab).
  const tab = resolveTab(route.tab, NETWORTH_TAB_IDS, storedTab);
  const selectTab = (id: NetWorthTabId) => {
    writeStoredTab(NETWORTH_TAB_STORAGE_KEY, id);
    navigate('networth', id);
  };

  /**
   * AUTO-SNAPSHOT (the owner's rule, 2026-08-30): arriving at the ledger
   * takes today's snapshot if none exists yet — the record the page exists
   * to keep should not depend on remembering to press the button. Once per
   * mount (the ref), never while the zero-start gate is up, and with the
   * same home value the dialog would have offered (the last snapshot's
   * figure, the profile's only for the very first). The manual button stays
   * for a second snapshot in a day, or a different home value.
   */
  const autoTried = useRef(false);
  const [autoTaking, setAutoTaking] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  /**
   * Memoised, and that is a FIX, not a micro-optimisation. Rebuilt inline, this
   * handed <BarChart> a new `data` array identity on every render — including
   * the render that `setHovered` causes on every hover — and recharts reacts to
   * a changed `data` identity by rebuilding its tooltip state from scratch
   * (getDerivedStateFromProps, the `data !== prevState.prevData` branch). See
   * the <Tooltip> comment for what that rebuild produced. Nothing here depends
   * on that state any more, but there is no reason to keep provoking it.
   */
  const { segments, bars } = useMemo(
    () => buildNetWorthChart(snapshots ?? [], chart),
    [snapshots, chart],
  );

  /**
   * The score series, memoised for the same reason the bars are: a new `data`
   * identity on every render makes recharts rebuild its tooltip state, and
   * that rebuild is what produced the "every slice says IRA" bug on the chart
   * above.
   */
  const scoreSeries = useMemo(() => buildScoreSeries(snapshots ?? []), [snapshots]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [list, profile] = await Promise.all([api.getNetWorth(), api.getProfile()]);
      setSnapshots(list);
      setHomeValue((prev) => prev ?? list[list.length - 1]?.homeValue ?? profile.home.value);
      setSnapshotGated(simulationReadiness(profile).state === 'no-accounts');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    // Separately and non-fatally: which rows are interrupted. A backend
    // without the answer must not take the ledger down with it.
    try {
      setInterrupted(
        (await api.getScoringIntents()).intents
          .filter((i) => i.kind === 'snapshot')
          .map((i) => i.id),
      );
    } catch {
      // Keep whatever we knew; the offer is additive, never load-bearing.
    }
  }, []);

  const setScoringIds = useCallback((ids: string[]) => {
    scoringRef.current = ids;
    setScoring(ids);
  }, []);

  /**
   * Ask who is still running, and reload the ledger when someone stops.
   *
   * The reload is what puts the score (or the reason there is none) on screen:
   * the run wrote it to networth.json when it landed, and this page is holding
   * the copy it read before that happened. A failed poll is ignored rather
   * than surfaced — it must not clear "scoring…" or stop the loop, because the
   * simulation is still going regardless of what this GET did.
   *
   * It reloads WHILE a run is still in flight too, not only when one drops off
   * the list. A score now arrives in two parts — the probability first, the
   * sustainable spend a dozen runs later — and waiting for the second would
   * hide the first for the tens of seconds the bisection takes, or for the
   * twenty minutes a wedged one takes before it gives up.
   */
  const pollScoring = useCallback(async () => {
    let ids: string[];
    try {
      ids = (await api.getNetWorthScoring()).scoring;
    } catch {
      return;
    }
    const landed = scoringRef.current.some((id) => !ids.includes(id));
    setScoringIds(ids);
    if (landed || ids.length > 0) await load();
  }, [load, setScoringIds]);

  useEffect(() => {
    void load();
    // Once on mount: a run started before this page was opened (or before it
    // was navigated away from and back) is still going, and the row it belongs
    // to should say so rather than looking permanently scoreless.
    void pollScoring();
  }, [load, pollScoring]);

  const idle = scoring.length === 0;
  useEffect(() => {
    if (idle) return;
    const timer = setInterval(() => void pollScoring(), SCORING_POLL_MS);
    return () => clearInterval(timer);
  }, [idle, pollScoring]);

  useEffect(() => {
    if (autoTried.current) return;
    // Not before the load has answered, and never while the gate is up.
    if (snapshots === null || homeValue === null || snapshotGated) return;
    const now = new Date();
    const takenToday = snapshots.some((s) => {
      const d = new Date(s.takenAt);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    });
    autoTried.current = true;
    if (takenToday) return;
    setAutoTaking(true);
    setAutoError(null);
    void (async () => {
      try {
        const snapshot = await api.takeNetWorthSnapshot({ homeValue });
        setSnapshots((prev) => [...(prev ?? []), snapshot]);
        setScoringIds([...scoringRef.current, snapshot.id]);
        showToast(`Snapshot recorded: ${formatUSD(snapshot.total)}`);
      } catch (e) {
        setAutoError(e instanceof Error ? e.message : String(e));
      } finally {
        setAutoTaking(false);
      }
    })();
  }, [snapshots, homeValue, snapshotGated, setScoringIds, showToast]);

  const openDialog = () => {
    setTakeError(null);
    setDialogOpen(true);
  };
  const closeDialog = () => setDialogOpen(false);

  const take = async () => {
    if (homeValue === null) return;
    setTaking(true);
    setTakeError(null);
    try {
      const snapshot = await api.takeNetWorthSnapshot({
        homeValue,
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      setSnapshots((prev) => [...(prev ?? []), snapshot]);
      setNote('');
      setDialogOpen(false);
      // The row is already recorded and on screen; the score is a simulation
      // that has only just started. Marking it in flight here rather than
      // waiting for the next poll is what makes the new row say "scoring…"
      // immediately.
      setScoringIds([...scoringRef.current, snapshot.id]);
      showToast(`Snapshot recorded: ${formatUSD(snapshot.total)}`);
    } catch (e) {
      setTakeError(e instanceof Error ? e.message : String(e));
    } finally {
      setTaking(false);
    }
  };

  const remove = async (id: string) => {
    setDeleteError(null);
    try {
      await api.deleteNetWorthSnapshot(id);
      setSnapshots((prev) => (prev ?? []).filter((s) => s.id !== id));
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * The Finish-scoring press: hand the interrupted row back to the backend,
   * which re-verifies the intent's runKey before a single path runs — the
   * click is a request, not an override. On accept the row goes straight to
   * "scoring…" (same immediate-mark idiom as taking a snapshot) and the
   * ordinary poll carries it home; whatever lands — the completed figure, or
   * the honest inputs-moved reason — arrives through `load` like any other
   * outcome.
   */
  const finish = async (id: string) => {
    setFinishError(null);
    try {
      await api.finishScoring({ kind: 'snapshot', id });
      setInterrupted((prev) => prev.filter((x) => x !== id));
      setScoringIds([...scoringRef.current.filter((x) => x !== id), id]);
    } catch (e) {
      setFinishError(e instanceof Error ? e.message : String(e));
      // The refusal may mean the intent is already resolved — re-read rather
      // than leave a button that can only refuse again.
      void load();
    }
  };

  /**
   * The spend spec, completed with the live half of its tooltip: whether a
   * point's solve is still running is a fact about the in-flight registry,
   * so the module constant cannot know it — see SPEND_TREND.
   */
  const spendTrend = useMemo<TrendSpec>(
    () => ({
      ...SPEND_TREND,
      lines: (p: ScorePoint) => spendTooltipLines(p, scoring.includes(p.id)),
    }),
    [scoring],
  );

  if (loadError) {
    return (
      <>
        <ModuleBanner title="Net worth" />
        <div className="moduleBody">
          <div className="error-banner">Failed to load net worth: {loadError}</div>
          <button onClick={() => void load()}>Retry</button>
        </div>
      </>
    );
  }
  if (snapshots === null || homeValue === null) {
    return (
      <>
        <ModuleBanner title="Net worth" />
        <div className="moduleBody">
          <div className="muted">Loading…</div>
        </div>
      </>
    );
  }

  // Nothing hovered draws nothing; before the plot has been measured there is
  // no edge to flip against, so the card stays with recharts' own anchor for
  // that one frame rather than being placed against a guess.
  const cardAt =
    hovered !== null && pointer !== null && plotSize !== null
      ? tooltipPosition(pointer, cardSize ?? TOOLTIP_CARD_ESTIMATE, plotSize)
      : undefined;

  return (
    <>
      <ModuleBanner
        title="Net worth"
        actions={
          snapshotGated ? undefined : (
            <button className="primary" disabled={autoTaking || taking} onClick={openDialog}>
              Take snapshot
            </button>
          )
        }
      />
      <div className="moduleBody">
      {snapshotGated ? (
        /* Zero-start: no button in the banner, and the reason here — an empty
           state, never a $0 row pretending to be a measurement. */
        <div className="muted" style={{ marginBottom: 12 }}>
          {NET_WORTH_FIRST_RUN}
        </div>
      ) : null}
      {autoError === null ? null : (
        <div className="error-banner">Today&rsquo;s automatic snapshot failed: {autoError}</div>
      )}
      <nav
        className="modalTabBar"
        role="tablist"
        aria-label="Net worth views"
        style={{ marginBottom: 16 }}
      >
        {NETWORTH_TAB_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`networth-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`networth-panel-${id}`}
            className={tab === id ? 'modalTabBtn isActive' : 'modalTabBtn'}
            onClick={() => selectTab(id)}
          >
            {NETWORTH_TAB_LABELS[id]}
          </button>
        ))}
      </nav>

      <SnapshotDialog
        open={dialogOpen}
        homeValue={homeValue}
        note={note}
        taking={taking}
        error={takeError}
        onHomeValue={setHomeValue}
        onNote={setNote}
        onDismiss={closeDialog}
        onConfirm={take}
      />

      {tab === 'trend' && (
      <div role="tabpanel" id="networth-panel-trend" aria-labelledby="networth-tab-trend">
        {bars.length === 0 ? (
          <div className="muted">
            {snapshotGated
              ? 'No snapshots yet — the first becomes possible once the profile has accounts.'
              : 'No snapshots yet.'}
          </div>
        ) : (
          <>
            {/* Tall on purpose. The chart's content is the SLICES, and at 260px a
                $28k savings account inside a $1.8M bar was under two pixels —
                present, correct, and unreadable. Height is the only dimension
                that gives the small segments back. */}
            {/* Wraps the chart only to be measured. An explicit <Tooltip
                position> bypasses recharts' viewBox clamping entirely, so the
                page has to know how much room the card has before it can decide
                to flip it — and this div is exactly the box the chart fills, in
                the same pixel space as chartX/chartY. */}
            <div ref={measurePlot}>
              <ResponsiveContainer width="100%" height={520}>
                <BarChart
                  data={bars}
                  margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
                  /*
                    The pointer, for the card's position. recharts hands this
                    handler its own mouse state, whose chartX/chartY are relative
                    to the chart container — exactly the space <Tooltip position>
                    is interpreted in. It is also the ONE reading that survives
                    either tooltip event mode: in 'item' mode this arrives via
                    adaptEventHandlers/handleOuterEvent, in 'axis' mode via
                    triggeredAfterMouseMove, and both call it with the mouse info
                    as the first argument. Outside the plot area recharts passes
                    {} — no coordinates — and the last good point is kept, which
                    is what we want while the pointer crosses a gridline label.
                  */
                  onMouseMove={(state: { chartX?: number; chartY?: number }) => {
                    if (typeof state.chartX === 'number' && typeof state.chartY === 'number') {
                      setPointer({ x: state.chartX, y: state.chartY });
                    }
                  }}
                  // Leaving the plot clears both, so a card cannot be left behind
                  // pointing at a slice the cursor is no longer in.
                  onMouseLeave={() => {
                    setPointer(null);
                    setHovered(null);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                  {/* Categorical, one tick per record — not the elapsed-time axis
                      this replaced. A snapshot exists because the user decided to
                      take one: six weeks after the last, then twice in a morning.
                      Spacing those to scale would draw a continuous series and
                      invite the eye to read a slope through days nobody measured.
                      Even spacing says only what is true — these are the times he
                      looked, in order — and one bar is one of them. */}
                  <XAxis dataKey="date" stroke={chart.axis} tick={{ fill: chart.axis }} />
                  {/* No domain override: a stacked bar read against anything but a
                      zero baseline lies about the proportions it exists to show.
                      tickCount is raised with the height — the default 5 leaves a
                      gridline every 130px at 520, and a slice boundary that far
                      from a labelled line cannot be read to the nearest $100k. */}
                  <YAxis
                    width={84}
                    tickCount={9}
                    tickFormatter={(v: number) => formatUSD(v)}
                    stroke={chart.axis}
                    tick={{ fill: chart.axis }}
                  />
                  {/* WHAT IT DRAWS AND WHERE ARE BOTH THIS PAGE'S, NOT RECHARTS'.
                      Two bugs the user reported — "it displays the value for IRA
                      no matter what I hover over" and "the tooltip needs to pop up
                      wherever my mouse is — at present it always pops at the top
                      of the bar stack" — were one fault, and it was NOT that
                      shared={false} failed to select item mode. It selects it:
                      getTooltipEventType() returned 'item' in the live page, and
                      handleItemMouseEnter did set the correct rectangle. The
                      trouble is what happened one beat later.

                      Each <Bar onMouseEnter> also calls setHovered (for the
                      outline below), which re-renders this page; `bars` was then
                      rebuilt inline, so <BarChart> received a NEW `data` identity
                      on every hover. recharts treats that as "the dataset
                      changed" and rebuilds its tooltip state from
                      getTooltipData(prevState, …), which reads state.chartX/
                      chartY — and in item mode recharts never attaches the
                      chart-level mousemove that would maintain them, so they sit
                      at their initial 0,0 forever. The rebuilt state therefore
                      resolved to tick index 0 every time: activePayload became the
                      whole six-segment column of the FIRST bar (payload[0] = the
                      biggest bottom slice = the IRA) at activeCoordinate {x: first
                      bar's centre, y: 0} — the top of the first stack. isTooltipActive
                      is preserved across that rebuild by design ("avoid
                      flickering"), so the wrong card stayed up. The page's own
                      hover state was the thing destroying the tooltip that was
                      meant to describe it.

                      So the card no longer reads recharts' payload, coordinate or
                      active flag at all: `active`, its content and its position
                      all come from `hovered` and `pointer`, which are set by the
                      Bar the cursor is actually inside. shared={false} stays
                      because item mode is still worth having — it is what stops
                      the whole-column cursor band from rendering (Cursor.js bails
                      unless tooltipEventType === 'axis') — but nothing above
                      depends on it any more.

                      isAnimationActive={false} is not the house rule here so much
                      as a requirement: the wrapper's default 400ms transform
                      transition would leave the card visibly swimming after a
                      pointer it is supposed to be pinned to. */}
                  <Tooltip
                    shared={false}
                    active={hovered !== null}
                    position={cardAt}
                    isAnimationActive={false}
                    cursor={false}
                    content={
                      <SnapshotTooltip
                        hovered={hovered}
                        bars={bars}
                        segments={segments}
                        chart={chart}
                        cardRef={measureCard}
                      />
                    }
                  />
                  {/* One stackId, so the bar's height is the snapshot's total, and
                      the segments arrive biggest-first so the first Bar — which
                      recharts stacks on the baseline — is the biggest slice.
                      maxBarSize because with a single record the band is the whole
                      plot and an unconstrained bar would be a 900px-wide slab.
                      isAnimationActive off, the house rule.

                      The stroke is a hairline in the tooltip's surface colour: with
                      position now chosen by size, any two colours can end up
                      touching, including series[0] against series[1] — the pair the
                      theme documents as ΔE 0.4 under deuteranopia, which this
                      ledger's 401(k) and Roth are. No boundary rests on hue alone.

                      THE HOVER OUTLINE IS DRAWN BY THIS PAGE, in `shape`, and not
                      by recharts' `activeBar` + `activeIndex` — which is what this
                      was, and which stopped outlining anything at all the moment
                      `bars` was memoised. recharts only honours a caller's
                      activeIndex while its OWN state.activeTooltipIndex is >= 0
                      (generateCategoricalChart, inside `hasActive`); in item mode
                      nothing ever sets that field, and it was only reaching 0
                      because the unmemoised `data` identity kept making recharts
                      rebuild its tooltip state — that is, because of the bug. With
                      the rebuild gone it sits at -1, recharts takes its
                      getItemByXY fallback instead, and that branch OVERWRITES the
                      activeIndex we passed with the Bar's position among the
                      chart's children — a number that indexes no bar — so every
                      slice went unoutlined.

                      Reading `hovered` in `shape` needs none of that machinery. It
                      also switches the machinery off: `hasActive` is
                      Boolean(activeDot || activeBar || activeShape), so with no
                      activeBar recharts stops rewriting these elements, and the
                      outline and the card are left deriving from the one piece of
                      state — they cannot disagree about which slice is which. */}
                  {segments.map((seg) => (
                    <Bar
                      key={seg.key}
                      dataKey={`values.${seg.key}`}
                      stackId="networth"
                      name={seg.label}
                      fill={seg.fill}
                      stroke={chart.tooltip.bg}
                      strokeWidth={1}
                      maxBarSize={72}
                      isAnimationActive={false}
                      shape={(props: unknown) => {
                        // recharts types `shape` as taking the Bar's own props;
                        // what it actually calls this with is ONE rectangle —
                        // geometry, plus the `index` of the bar along the axis.
                        // The cast is that gap, and it is the only one.
                        const rect = props as RectangleProps & { index?: number };
                        const outlined =
                          hovered !== null && hovered.key === seg.key && hovered.index === rect.index;
                        return (
                          <Rectangle
                            {...rect}
                            stroke={outlined ? chart.tooltip.text : chart.tooltip.bg}
                            strokeWidth={outlined ? 2 : 1}
                          />
                        );
                      }}
                      onMouseEnter={(_entry: unknown, index: number) =>
                        setHovered({ key: seg.key, index })
                      }
                      onMouseLeave={() => setHovered(null)}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="chip-list" style={{ marginTop: 4 }}>
              {segments.map((seg) => (
                <span className="wb-chip" key={seg.key}>
                  <span style={{ color: seg.fill }}>■</span> {seg.label}
                </span>
              ))}
            </div>
            {/* No explanatory footer (the owner's fluff rule, 2026-08-31):
                the bars and the legend chips speak for themselves. */}
          </>
        )}
      </div>
      )}

      {/* THE SCORE, ON ITS OWN PLOT. Not overlaid on the bars: millions of
          dollars and a probability need two scales, and two scales make the
          eye read a crossing point that means nothing — move either axis and
          it moves. Same x axis, same order, so a tab switch keeps the days
          lined up. */}
      {tab === 'score' && (
        <div role="tabpanel" id="networth-panel-score" aria-labelledby="networth-tab-score">
          {bars.length === 0 ? (
            <div className="muted">No snapshots yet.</div>
          ) : scoreSeries.scored === 0 ? (
            <div className="muted">{scoreChartEmptyNote()}</div>
          ) : (
            <>
              <TrendChart
                points={scoreSeries.points}
                domain={scoreSeries.domain}
                chart={chart}
                spec={SCORE_TREND}
              />
              <div className="chip-list" style={{ marginTop: 4 }}>
                <span className="wb-chip">
                  <span style={{ color: chart.accent }}>●</span> a scored snapshot
                </span>
                <span className="wb-chip">
                  <span style={{ color: chart.amber }}>○</span> {BREAK_CHIP_LABEL}
                </span>
                <span className="wb-chip">
                  <span style={{ color: chart.neutralStrong }}>◌</span> {UNKNOWN_CHIP_LABEL}
                </span>
              </div>
              {/* No explanatory footer (the owner's fluff rule, 2026-08-31);
                  the conditions live in each point's tooltip. */}
            </>
          )}
        </div>
      )}

      {/* THE DOLLARS, ON A THIRD PLOT, FOR THE SAME REASON AS THE SECOND: a
          probability and an annual spend do not share an axis, and a household
          whose success rate saturates near the ceiling cannot read its own
          progress off the probability at all. Every version of this plan scores
          96-point-something; what separates them is what they could afford. */}
      {tab === 'spend' && (
        <div role="tabpanel" id="networth-panel-spend" aria-labelledby="networth-tab-spend">
          {bars.length === 0 ? (
            <div className="muted">No snapshots yet.</div>
          ) : scoreSeries.spendScored === 0 ? (
            <div className="muted">{spendChartEmptyNote()}</div>
          ) : (
            <>
              <TrendChart
                points={scoreSeries.points}
                domain={scoreSeries.spendDomain}
                chart={chart}
                spec={spendTrend}
              />
              <div className="chip-list" style={{ marginTop: 4 }}>
                <span className="wb-chip">
                  <span style={{ color: chart.accent }}>●</span> a snapshot with a solved figure
                </span>
                <span className="wb-chip">
                  <span style={{ color: chart.amber }}>○</span> {BREAK_CHIP_LABEL}
                </span>
                <span className="wb-chip">
                  <span style={{ color: chart.neutralStrong }}>◌</span> {UNKNOWN_CHIP_LABEL}
                </span>
              </div>
              {/* WHAT THE NUMBER IS, INCLUDING THE TARGET IT CLEARS. Without the
                  target the figure is meaningless — "the most you could spend"
                  is a different number at 85% than at 95% — so the target is
                  stated here rather than left to be inferred, and it is stated
                  as YOURS TODAY, because a figure recorded earlier was solved
                  against whatever target that plan carried at the time. */}
              {/* No explanatory footer (the owner's fluff rule, 2026-08-31);
                  the conditions live in each point's tooltip. */}
            </>
          )}
        </div>
      )}

      {tab === 'snapshots' && (
      <div role="tabpanel" id="networth-panel-snapshots" aria-labelledby="networth-tab-snapshots">
        {deleteError === null ? null : <div className="error-banner">{deleteError}</div>}
        {finishError === null ? null : <div className="error-banner">{finishError}</div>}
        {snapshots.length === 0 ? (
          <div className="muted">Nothing recorded yet.</div>
        ) : (
          /* The app's wide-table convention (styles.css .table-scroll). Four
             money columns and a note, every cell nowrap, is already wider than
             its own card on a narrow window — and a page that scrolls sideways
             scrolls its heading and its charts too. Sideways scrolling belongs
             inside the box the wide thing is in. */
          <div className="table-scroll managedTableWrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ textAlign: 'right' }}>Portfolio</th>
                <th style={{ textAlign: 'right' }}>Home (as entered)</th>
                <th style={{ textAlign: 'right' }}>Plan score</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {/* Newest first: the row you just took is the row you came to see. */}
              {[...snapshots].reverse().map((s) => (
                <tr key={s.id}>
                  <td title={s.takenAt}>{formatSnapshotDate(s.takenAt)}</td>
                  <td style={{ textAlign: 'right' }}>{formatUSD(s.total)}</td>
                  <td style={{ textAlign: 'right' }}>{formatUSD(s.total - s.homeValue)}</td>
                  <td style={{ textAlign: 'right' }}>{formatUSD(s.homeValue)}</td>
                  {/*
                    FIVE DIFFERENT STATES, and none of them is a zero. A score;
                    a run still going; a run that was INTERRUPTED and can still
                    be finished honestly (below); a run that failed, with its
                    reason on the row; and a row nobody ever measured, which is
                    not a failure and is not dressed as one. Printing 0% for
                    any of the last four would claim this plan fails in every
                    simulated future.

                    THE LAST TWO ARE PERMANENT, and they say so rather than
                    reading as a gap waiting to be filled. There is no re-score:
                    a run that died took the only chance this row had, and "not
                    measured" is the true and final statement about that day.
                    The alternative on offer was a button that measured a
                    DIFFERENT day and filed the answer here. INTERRUPTED is the
                    one exception, and it is not an exception to the rule: the
                    write-ahead intent's runKey proves today's inputs still
                    produce the very run that was cut short, so Finish scoring
                    completes the SAME measurement — a blank filled, never a
                    number rewritten (store/scoringIntent.ts).
                  */}
                  <td style={{ textAlign: 'right' }}>
                    {s.score ? (
                      <span title={scoreRowTitle(s.score)}>
                        {formatScorePct(s.score.success * 100)}
                      </span>
                    ) : scoring.includes(s.id) ? (
                      <span className="muted">scoring…</span>
                    ) : interrupted.includes(s.id) ? (
                      <span
                        className="flag"
                        title="Scoring was interrupted before this row's number landed, and today's inputs still produce the same run — press Finish scoring to complete the same measurement."
                      >
                        interrupted
                      </span>
                    ) : s.scoreError ? (
                      <span
                        className="flag"
                        title={`${s.scoreError} — and this row stays unscored: the plan is scored once, when the snapshot is taken.`}
                      >
                        no score
                      </span>
                    ) : (
                      <span
                        className="muted"
                        title="This snapshot was never scored, and cannot be now: the plan is scored once, when the snapshot is taken. Not measured is not zero."
                      >
                        not measured
                      </span>
                    )}
                  </td>
                  <td className="muted">{s.note ?? ''}</td>
                  <td>
                    {/* DELETE IS THE ONLY UNCONDITIONAL ACTION ON A ROW, and
                        that is the point. There was a scoring button here in
                        three costumes — score a blank row, retry a failed one,
                        add the missing dollars to one scored before the solve
                        existed — and every one of them ran TODAY's plan against
                        TODAY's profile and filed the answer on a row recorded
                        weeks ago. The number it produced was never true of the
                        row it landed on. FINISH SCORING is not that button
                        back: it appears only behind a write-ahead intent whose
                        runKey still verifies against today's inputs, and the
                        backend re-verifies at the press — it completes the
                        interrupted measurement or refuses with the reason,
                        never measures a different day. */}
                    <div className="row" style={{ gap: 6 }}>
                      {interrupted.includes(s.id) && !scoring.includes(s.id) && (
                        <button className="primary" onClick={() => void finish(s.id)}>
                          Finish scoring
                        </button>
                      )}
                      <button className="danger" onClick={() => void remove(s.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {/* The reasons, in full. The cell has room for "no score" and a
            tooltip; a failure the user has to hover to read is a failure he
            will not read. It ends by saying the state is final — otherwise the
            sentence reads like a problem waiting for the button that used to be
            beside it. */}
        {snapshots
          .filter(
            (s) =>
              s.scoreError !== undefined &&
              s.score === undefined &&
              !interrupted.includes(s.id),
          )
          .map((s) => (
            <div key={s.id} className="field-help" style={{ marginTop: 6 }}>
              <strong>{formatSnapshotDate(s.takenAt)}</strong> has no score: {s.scoreError} That
              row stays unscored — the plan is scored once, when the snapshot is taken, so what
              this day would have measured is not recoverable.
            </div>
          ))}
        {/* The interrupted rows, in full — same idiom as the failure blocks
            above: a state the user has to hover to understand is a state they
            will not understand. It says WHY finishing is honest here and
            nowhere else: the write-ahead intent recorded which run was in
            flight, and today's inputs still produce exactly that run. */}
        {snapshots
          .filter((s) => interrupted.includes(s.id) && !scoring.includes(s.id))
          .map((s) => (
            <div key={s.id} className="field-help" style={{ marginTop: 6 }}>
              <strong>{formatSnapshotDate(s.takenAt)}</strong> was interrupted mid-scoring —
              the app closed before the measurement finished. Today&rsquo;s plan and prices
              still produce exactly the run that was cut short, so <em>Finish scoring</em>{' '}
              completes the same measurement: a blank being filled, not a number being
              rewritten. If the inputs change first, the row will say so and stay honestly
              unmeasured instead.
            </div>
          ))}
        {/* No explanatory footer (the owner's fluff rule, 2026-08-31). */}
      </div>
      )}

      {/* The automatic snapshot's moment: a strict little overlay that closes
          itself when the record lands (or fails, whose message shows above). */}
      {autoTaking ? (
        <div className="deleteConfirmOverlay" role="presentation">
          <div
            className="deleteConfirmPanel"
            role="alertdialog"
            aria-modal="true"
            aria-busy="true"
            aria-label="Taking a snapshot"
          >
            <h3>Taking a snapshot…</h3>
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
}
