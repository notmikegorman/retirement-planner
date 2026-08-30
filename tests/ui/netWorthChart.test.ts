/**
 * The Net Worth chart's assembly (src/ui/pages/netWorthChart.ts) and its wiring.
 *
 * The chart draws composition, so the properties worth protecting are the ones
 * a total-only chart never had to have:
 *
 * 1. THE SEGMENT SET IS THE UNION OF EVERY LEDGER ROW. An account that joins
 *    later, or one that closes, must not delete itself from the bars either
 *    side of it — and its absence is 0, never a gap, never NaN.
 * 2. COLOUR IS FIRST APPEARANCE; POSITION IS SIZE. The two indexes are separate
 *    so that an account which outgrows its neighbour MOVES without repainting —
 *    dragging the colour along with the sort is the exact bug that argued
 *    against sorting at all, and it is pinned here now that the stack sorts.
 * 3. THE SLICES STILL ADD UP TO THE RECORDED TOTAL. If they ever disagree, an
 *    account has been dropped from the union and the bar is a lie about a
 *    number the ledger already stored.
 * 4. THE HOUSE IS NOT AN ACCOUNT — but it is not a special POSITION either. It
 *    stacks by size like everything else; what sets it apart is the one colour
 *    the account rotation can never hand out.
 * 5. THE ORDER IS TOTAL. Ties, and segments the newest row has nothing in, must
 *    still resolve to exactly one order, or the stack reshuffles under a
 *    re-render that changed nothing.
 * 6. THE HOVER CARD ANSWERS ABOUT THE SLICE UNDER THE CURSOR — the two bugs the
 *    owner reported against the shipped chart. It named segment[0] whatever you
 *    pointed at ("it displays the value for IRA no matter what I hover over")
 *    and drew itself at the top of the first stack ("the tooltip needs to pop up
 *    wherever my mouse is"). Both came of trusting recharts' tooltip payload and
 *    anchor, which the page's own hover-state re-render was quietly invalidating
 *    — so both are now derived from that same hover state instead, through two
 *    pure functions this file can test without a browser.
 * 7. THE CARD STAYS ON THE PLOT. An explicit <Tooltip position> skips recharts'
 *    viewBox clamping, so the flips are the only thing keeping a card for a
 *    right-hand or bottom slice on screen at all.
 *
 * The source scan pins the chart TYPE: stacked bars sharing one stackId, on a
 * categorical axis. This is what the user asked for, and a total line is the
 * shape a refactor would drift back toward.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NetWorthSnapshot } from '../../src/shared/types';
import { CHART_PALETTES } from '../../src/ui/theme';
import {
  HOME_SEGMENT_KEY,
  TOOLTIP_CURSOR_GAP,
  buildNetWorthChart,
  formatSegmentShare,
  formatSnapshotDate,
  hoveredSlice,
  tooltipPosition,
} from '../../src/ui/pages/netWorthChart';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const page = read('../../src/ui/pages/NetWorthPage.tsx');

const LIGHT = CHART_PALETTES.light;

/** A ledger row, totalled the way the server totals one: Σ accounts + home. */
function snapshot(
  takenAt: string,
  homeValue: number,
  accounts: Array<[string, string, number]>,
): NetWorthSnapshot {
  const rows = accounts.map(([id, name, balance]) => ({ id, name, balance }));
  return {
    id: `nw-${takenAt}`,
    takenAt,
    total: rows.reduce((s, a) => s + a.balance, 0) + homeValue,
    homeValue,
    accounts: rows,
    prices: {},
  };
}

/**
 * A representative first ledger row, in the shape networth.json records: five
 * accounts, one of them priced from holdings (hence the four decimal places
 * nothing else here has), plus the typed home value.
 */
const FIRST_REAL = snapshot('2026-08-19T09:00:11.349Z', 550_000, [
  ['k401', '401(k)', 162_431.09],
  ['ira1', 'IRA', 921_544.3072],
  ['roth1', 'Roth IRA', 118_420.55],
  ['brokerage', 'Brokerage', 61_908.32144],
  ['savings', 'Savings', 31_400.18],
]);

describe('buildNetWorthChart — the segment set', () => {
  it('is the union across every snapshot, and an absent account is 0', () => {
    // The Roth opens in the second row; the savings account is closed by the
    // third. Both must appear on all three bars, at 0 where they did not exist.
    const { segments, bars } = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 1_000_000, [
          ['k401', '401(k)', 100_000],
          ['savings', 'Savings', 20_000],
        ]),
        snapshot('2026-06-02T12:00:00.000Z', 1_050_000, [
          ['k401', '401(k)', 110_000],
          ['savings', 'Savings', 15_000],
          ['roth1', 'Roth IRA', 7_000],
        ]),
        snapshot('2026-12-02T12:00:00.000Z', 1_100_000, [
          ['k401', '401(k)', 120_000],
          ['roth1', 'Roth IRA', 9_000],
        ]),
      ],
      LIGHT,
    );

    // Every account present, in the newest row's size order: the home (1.1M),
    // the 401(k) (120k), the Roth (9k), then the account that closed (0).
    expect(segments.map((s) => s.id)).toEqual([null, 'k401', 'roth1', 'savings']);
    const roth = segments.find((s) => s.id === 'roth1')!;
    const savings = segments.find((s) => s.id === 'savings')!;
    expect(bars.map((b) => b.values[roth.key])).toEqual([0, 7_000, 9_000]);
    expect(bars.map((b) => b.values[savings.key])).toEqual([20_000, 15_000, 0]);
    // Every value is a real number on every bar — a missing account must never
    // reach recharts as undefined or NaN, which draws a gap in a stack.
    for (const bar of bars) {
      for (const seg of segments) {
        expect(Number.isFinite(bar.values[seg.key]), `${bar.date}/${seg.key}`).toBe(true);
      }
    }
  });

  it('gives a new account its own colour without repainting the ones already there', () => {
    const before = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 1_000_000, [
          ['k401', '401(k)', 100_000],
          ['savings', 'Savings', 20_000],
        ]),
      ],
      LIGHT,
    );
    const after = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 1_000_000, [
          ['k401', '401(k)', 100_000],
          ['savings', 'Savings', 20_000],
        ]),
        // The new account is listed FIRST in the newer snapshot — colour comes
        // from the ledger's history, not from the latest row's ordering.
        snapshot('2026-06-02T12:00:00.000Z', 1_000_000, [
          ['brokerage', 'Brokerage', 5_000],
          ['k401', '401(k)', 110_000],
          ['savings', 'Savings', 21_000],
        ]),
      ],
      LIGHT,
    );

    expect(after.segments.map((s) => s.id)).toEqual([null, 'k401', 'savings', 'brokerage']);
    for (const seg of before.segments) {
      const same = after.segments.find((s) => s.id === seg.id)!;
      expect(same.key, seg.label).toBe(seg.key);
      expect(same.fill, seg.label).toBe(seg.fill);
    }
  });

  it('stacks biggest-first from the newest row, with the home in its place by size', () => {
    // The user's real ledger: the IRA is bigger than the house, and the house
    // is bigger than everything else. It sits SECOND — the old assembly pinned
    // it to the top of every bar, above $28k of savings.
    const { segments } = buildNetWorthChart([FIRST_REAL], LIGHT);
    expect(segments.map((s) => s.id)).toEqual([
      'ira1',
      null,
      'k401',
      'roth1',
      'brokerage',
      'savings',
    ]);
    expect(segments[0].id).toBe('ira1');
    expect(segments[1].isHome).toBe(true);
  });

  it('moves an account past its neighbour without either of them changing colour', () => {
    // THE repaint bug the old first-appearance ordering existed to prevent, now
    // that ordering is dynamic: the Brokerage overtakes the 401(k) between two
    // builds. Positions swap; keys and fills must not move a millimetre, because
    // colour is how the eye follows one account from bar to bar.
    const ledger = (brokerage: number): NetWorthSnapshot[] => [
      snapshot('2026-01-02T12:00:00.000Z', 1_000_000, [
        ['k401', '401(k)', 100_000],
        ['brokerage', 'Brokerage', 5_000],
      ]),
      snapshot('2026-06-02T12:00:00.000Z', 1_000_000, [
        ['k401', '401(k)', 110_000],
        ['brokerage', 'Brokerage', brokerage],
      ]),
    ];
    const small = buildNetWorthChart(ledger(5_000), LIGHT).segments;
    const overtaken = buildNetWorthChart(ledger(130_000), LIGHT).segments;

    expect(small.map((s) => s.id)).toEqual([null, 'k401', 'brokerage']);
    expect(overtaken.map((s) => s.id)).toEqual([null, 'brokerage', 'k401']);
    for (const seg of small) {
      const same = overtaken.find((s) => s.id === seg.id)!;
      expect(same.fill, seg.label).toBe(seg.fill);
      expect(same.key, seg.label).toBe(seg.key);
    }
  });

  it('orders what the newest row cannot rank: last non-zero figure, then first appearance', () => {
    // B and C are both absent from the newest row, so both are 0 there and the
    // size rule alone would leave them interchangeable — and a stack whose
    // segments can swap on a re-render is a chart that lies about being the
    // same chart. B was the larger account when it last held anything.
    const { segments } = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 0, [
          ['a', 'A', 10],
          ['b', 'B', 900],
          ['c', 'C', 50],
        ]),
        snapshot('2026-06-02T12:00:00.000Z', 0, [['a', 'A', 100]]),
      ],
      LIGHT,
    );
    expect(segments.map((s) => s.id)).toEqual(['a', 'b', 'c', null]);
  });

  it('breaks an exact tie by first appearance, and gives the same answer every build', () => {
    const rows = [
      snapshot('2026-01-02T12:00:00.000Z', 50_000, [
        ['first', 'First', 50_000],
        ['second', 'Second', 50_000],
      ]),
    ];
    const once = buildNetWorthChart(rows, LIGHT).segments.map((s) => s.id);
    const twice = buildNetWorthChart(rows, LIGHT).segments.map((s) => s.id);
    expect(once).toEqual(['first', 'second', null]);
    expect(twice).toEqual(once);
  });

  it('labels an account by its most recent name, not the one the oldest row froze', () => {
    const { segments } = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 0, [['ira1', 'IRA', 10]]),
        snapshot('2026-06-02T12:00:00.000Z', 0, [['ira1', 'Rollover IRA', 12]]),
      ],
      LIGHT,
    );
    expect(segments.map((s) => s.label)).toEqual(['Rollover IRA', 'Home']);
    expect(segments).toHaveLength(2);
  });

  it('keeps the home off the accounts’ colour rotation, wherever its size puts it', () => {
    // Seven accounts: one more than the hued entries, so the rotation wraps and
    // would reach the home's grey if it were part of the cycle. The home is the
    // largest thing on this ledger, so it also lands at the BOTTOM — the end of
    // the stack it used to be forbidden from.
    const many = snapshot(
      '2026-01-02T12:00:00.000Z',
      500_000,
      Array.from({ length: 7 }, (_, i) => [`a${i}`, `Account ${i}`, 1_000 * (i + 1)] as
        [string, string, number]),
    );
    const { segments } = buildNetWorthChart([many], LIGHT);

    const home = segments.find((s) => s.isHome)!;
    expect(segments[0]).toBe(home);
    expect(home.id).toBeNull();
    expect(home.key).toBe(HOME_SEGMENT_KEY);
    expect(home.label).toBe('Home');
    expect(segments.filter((s) => s.isHome)).toHaveLength(1);
    for (const seg of segments.filter((s) => !s.isHome)) {
      expect(seg.fill, seg.label).not.toBe(home.fill);
    }
  });

  it('keys segments positionally, so an account id is never read as a nested path', () => {
    // The key is half a recharts dataKey (`values.${key}`), and recharts resolves
    // a dataKey through lodash `get`. An account id is any non-empty string the
    // profile cares to carry — `401.k` is legal — and handing that to `get` reads
    // it as a path into a nested object: the segment would silently draw nothing
    // and the bar would be short by a whole account, with no error anywhere.
    const { segments, bars } = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 1_000, [
          ['401.k', '401(k)', 100],
          ['a[0]', 'Bracketed', 200],
        ]),
      ],
      LIGHT,
    );

    for (const seg of segments) {
      expect(seg.key, seg.label).toMatch(/^(a\d+|home)$/);
    }
    // Resolve each segment the way recharts will, by walking the dot path.
    for (const seg of segments) {
      const walked = `values.${seg.key}`
        .split('.')
        .reduce<unknown>((node, step) => (node as Record<string, unknown>)?.[step], bars[0]);
      expect(walked, seg.label).toBe(bars[0].values[seg.key]);
    }
    const byId = new Map(segments.map((s) => [s.id, s]));
    expect(bars[0].values[byId.get('401.k')!.key]).toBe(100);
    expect(bars[0].values[byId.get('a[0]')!.key]).toBe(200);
  });

  it('holds back the palette pair the theme documents as unusable side by side', () => {
    // series[0] against series[1] is invisible under deuteranopia (the theme's
    // `duo` note), and the first two accounts are the likeliest to be large and
    // therefore adjacent. Plain index order would hand that pair straight to
    // them; the walk spends its widest separation there instead. Read by
    // account, not by position — position is size now, and this is about hue.
    const { segments } = buildNetWorthChart(
      [
        snapshot('2026-01-02T12:00:00.000Z', 1, [
          ['a', 'A', 1],
          ['b', 'B', 1],
        ]),
      ],
      LIGHT,
    );
    const byId = new Map(segments.map((s) => [s.id, s]));
    expect(byId.get('a')!.fill).toBe(LIGHT.series[0]);
    expect(byId.get('b')!.fill).not.toBe(LIGHT.series[1]);
  });
});

describe('buildNetWorthChart — the bars', () => {
  it('slices add up to the total the snapshot itself recorded', () => {
    const { segments, bars } = buildNetWorthChart([FIRST_REAL], LIGHT);
    const [bar] = bars;
    const summed = segments.reduce((s, seg) => s + bar.values[seg.key], 0);
    expect(summed).toBeCloseTo(FIRST_REAL.total, 6);
    expect(bar.total).toBe(FIRST_REAL.total);
    expect(bar.values[HOME_SEGMENT_KEY]).toBe(550_000);
    expect(bar.values[segments.find((s) => s.id === 'ira1')!.key]).toBe(921_544.3072);
  });

  it('holds through a ledger where the union is wider than any single row', () => {
    const snapshots = [
      snapshot('2026-01-02T12:00:00.000Z', 1_000_000, [['k401', '401(k)', 100_000]]),
      snapshot('2026-06-02T12:00:00.000Z', 1_050_000, [
        ['k401', '401(k)', 110_000],
        ['roth1', 'Roth IRA', 7_000],
      ]),
      snapshot('2026-12-02T12:00:00.000Z', 1_100_000, [['roth1', 'Roth IRA', 9_000]]),
    ];
    const { segments, bars } = buildNetWorthChart(snapshots, LIGHT);
    bars.forEach((bar, i) => {
      const summed = segments.reduce((s, seg) => s + bar.values[seg.key], 0);
      expect(summed, bar.date).toBeCloseTo(snapshots[i].total, 6);
    });
  });

  it('reports the total the row STORED, never a re-addition of its own slices', () => {
    // The tooltip's Total is a check digit: it comes from the ledger, and the
    // stack beside it is assembled independently, so the two disagreeing is the
    // signal that an account fell out of the union. Re-adding the slices to
    // produce the total destroys that — the figure would then agree with a
    // wrong stack by construction, and a short bar would read as the truth.
    const drifted: NetWorthSnapshot = { ...FIRST_REAL, total: FIRST_REAL.total + 1_000 };
    const [bar] = buildNetWorthChart([drifted], LIGHT).bars;
    expect(bar.total).toBe(drifted.total);

    const { segments, bars } = buildNetWorthChart([drifted], LIGHT);
    const summed = segments.reduce((s, seg) => s + bars[0].values[seg.key], 0);
    expect(summed).not.toBe(bar.total);
  });

  it('renders a single snapshot as one complete bar', () => {
    const { segments, bars } = buildNetWorthChart([FIRST_REAL], LIGHT);
    expect(bars).toHaveLength(1);
    expect(segments).toHaveLength(6);
    expect(bars[0].date).toBe('Aug 19, 2026');
    expect(Object.keys(bars[0].values)).toEqual(segments.map((s) => s.key));
  });

  it('gives an empty ledger no bars and no accounts — the page shows its invitation', () => {
    const { segments, bars } = buildNetWorthChart([], LIGHT);
    expect(bars).toEqual([]);
    // The home segment survives an empty ledger; there is simply nothing to
    // stack it on, and the page renders the empty state instead of a chart.
    expect(segments.map((s) => s.label)).toEqual(['Home']);
  });

  it('carries the note and the raw moment through for the rows beneath', () => {
    const withNote: NetWorthSnapshot = { ...FIRST_REAL, note: 'first look' };
    const [bar] = buildNetWorthChart([withNote], LIGHT).bars;
    expect(bar.note).toBe('first look');
    expect(bar.takenAt).toBe(FIRST_REAL.takenAt);
    expect(buildNetWorthChart([FIRST_REAL], LIGHT).bars[0].note).toBeUndefined();
  });
});

describe('formatSnapshotDate', () => {
  it('is the axis tick and the tooltip header: "Aug 19, 2026"', () => {
    expect(formatSnapshotDate('2026-08-19T09:00:11.349Z')).toBe('Aug 19, 2026');
  });

  it('passes junk through rather than rendering "Invalid Date"', () => {
    expect(formatSnapshotDate('not-a-date')).toBe('not-a-date');
  });
});

describe('the chart type (source scan)', () => {
  it('draws the MONEY as stacked bars, never as a line through the totals', () => {
    expect(page).toContain('<BarChart');
    expect(page).toContain('stackId="networth"');
    /*
     * This used to read "no <Line> anywhere on the page", and that is no
     * longer the property: the page now carries TWO more charts below the bars
     * — what the plan scored on each of those days, and what it could afford —
     * each a line, deliberately on its own plot and its own scale. What must
     * never come back is a line drawn through the NET WORTH totals, because two
     * very different compositions can share a total and a line cannot say so.
     * So the pin is on the data, not on the element: nothing plots `total`, and
     * the only readings a line may draw are the two the trend plots name.
     */
    expect(page).not.toContain("dataKey=\"total\"");
    expect(page).not.toContain('dataKey={`values.total`}');
    expect(page).toContain('dataKey={spec.dataKey}');
    expect(page).toMatch(/dataKey: 'pct'/);
    expect(page).toMatch(/dataKey: 'spend'/);
  });

  it('drives every Bar off the assembled segments, so the union reaches the chart', () => {
    // Memoised, and null-safe because the memo now sits above the loading
    // guard: rebuilding it inline handed <BarChart> a new `data` identity on
    // every hover, which is what set recharts rewriting its tooltip state.
    expect(page).toContain('buildNetWorthChart(snapshots ?? [], chart)');
    expect(page).toContain('useMemo(');
    expect(page).toMatch(/segments\.map\(\(seg\) => \(\s*<Bar/);
    expect(page).toContain('dataKey={`values.${seg.key}`}');
    expect(page).toContain('fill={seg.fill}');
  });

  it('rebuilds the bars when the LEDGER changes, not only when the theme does', () => {
    // The memo above is what stops recharts rewriting its tooltip state on
    // every hover; this dependency list is what stops the chart going stale.
    // Drop `snapshots` from it and the page keeps drawing whatever the ledger
    // held when it first loaded — a snapshot taken or deleted would leave the
    // bars behind, silently, with nothing on screen admitting it.
    expect(page).toMatch(
      /useMemo\(\s*\(\) => buildNetWorthChart\(snapshots \?\? \[\], chart\),\s*\[snapshots, chart\],\s*\)/,
    );
  });

  it('keeps the house rule: no entry animation on any bar', () => {
    expect(page).toContain('isAnimationActive={false}');
    const bars = page.match(/<Bar\b/g) ?? [];
    const still = page.match(/isAnimationActive=\{false\}/g) ?? [];
    expect(bars.length).toBeGreaterThan(0);
    expect(still.length).toBeGreaterThanOrEqual(bars.length);
  });

  it('spaces the x axis by record, not by elapsed time', () => {
    expect(page).toContain('<XAxis dataKey="date"');
    expect(page).not.toContain("domain={['dataMin', 'dataMax']}");
    // A stacked bar measured from anything but zero misstates its own slices.
    expect(page).not.toContain("domain={['auto', 'auto']}");
    // One bar must not become a slab as wide as the plot area.
    expect(page).toContain('maxBarSize=');
  });

  it('legends every segment in the app’s chip idiom, and keeps the caption honest', () => {
    expect(page).toContain('className="chip-list"');
    expect(page).toMatch(/segments\.map\(\(seg\) => \(\s*<span className="wb-chip"/);
    expect(page).toContain('No snapshots yet.');
    expect(page).toContain('a record of what you saw, not a projection');
  });

  it('the empty-chart caption is condition-aware under the zero-start gate', () => {
    // With zero accounts the card above replaces the Take-snapshot button
    // with the no-accounts note — so "yours to take, above" would point at a
    // button that is not there. The caption switches on the same gate the
    // button does.
    expect(page).toContain(
      'No snapshots yet — the first becomes possible once the profile has accounts.',
    );
    const caption = page.slice(page.indexOf('No snapshots yet — the first becomes possible'));
    expect(page).toMatch(/\{snapshotGated\s*\n?\s*\? 'No snapshots yet — the first becomes/);
    expect(caption).toBeTruthy();
  });

  it('gives the stack room, and gridlines close enough to read a boundary against', () => {
    // Doubled from 260: the content of this chart is the SLICES, and $28k of
    // savings inside a $3.6M bar was under two pixels — present, correct and
    // unreadable. The tick count rises with it; the default 5 would leave a
    // labelled line every 130px.
    expect(page).toContain('height={520}');
    expect(page).toContain('tickCount={9}');
  });

  it('tooltips ONE slice — the one under the cursor — and never the whole list again', () => {
    expect(page).toContain('shared={false}');
    expect(page).toContain('segments={segments}');
    expect(page).toContain('prices as of the snapshot moment');
    // The home's condition is not the price feed's — nobody priced the house.
    expect(page).toContain('the value you entered that day');
    // What was removed: the per-segment list and the standalone Total row.
    expect(page).not.toContain('formatUSD(bar.values[seg.key] ?? 0)');
    expect(page).not.toContain('formatUSD(bar.total)');
    expect(page).toContain('chart.tooltip.bg');
    expect(page).toContain('chart.tooltip.border');
    expect(page).toContain('chart.tooltip.text');
  });

  it('names the slice from the page’s own hover state, never from recharts’ payload', () => {
    // BUG: "it displays the value for IRA no matter what I hover over". The card
    // read payload[0] — the first <Bar>, i.e. the biggest slice, i.e. the IRA —
    // and recharts had meanwhile rebuilt that payload for bar index 0, so the
    // figure was the wrong day's too. The reading now comes from `hovered`.
    expect(page).toContain('hoveredSlice(hovered, bars, segments)');
    expect(page).toContain('hovered={hovered}');
    // Scoped to the card's own body — the prose above it has to be free to name
    // the bug it prevents. Inside, neither handle that produced the wrong answer
    // may be read again: not recharts' payload, not the dataKey it identified
    // the hovered Bar by.
    // Bounded to THIS card's body — the prose above it has to be free to name
    // the bug it prevents, and the SCORE chart further down the file
    // legitimately reads a recharts `payload` (its dot renderer is handed one
    // datum at a time), which is why that chart is defined after the dialog
    // rather than between these two markers.
    const tooltip = page.slice(
      page.indexOf('function SnapshotTooltip'),
      page.indexOf('function SnapshotDialog'),
    );
    expect(tooltip).not.toContain('payload');
    expect(tooltip).not.toContain('dataKey');
  });

  it('draws the card at the cursor, with an explicit position recharts cannot override', () => {
    // BUG: "the tooltip needs to pop up wherever my mouse is — at present it
    // always pops at the top of the bar stack". That was recharts' own anchor,
    // recomputed for tick 0 from a chartX/chartY frozen at the origin.
    expect(page).toContain('position={cardAt}');
    expect(page).toContain('tooltipPosition(pointer, cardSize ?? TOOLTIP_CARD_ESTIMATE, plotSize)');
    // The pointer comes from the chart's own mouse state, in the chart's space.
    expect(page).toContain('setPointer({ x: state.chartX, y: state.chartY })');
    // A 400ms transform transition would leave the card swimming after the
    // pointer it is pinned to.
    expect(page).toContain('isAnimationActive={false}');
    // Visibility is the page's too, so the card cannot outlive the hover.
    expect(page).toContain('active={hovered !== null}');
    expect(page).toMatch(/onMouseLeave=\{\(\) => \{\s*setPointer\(null\);\s*setHovered\(null\);/);
  });

  it('never reintroduces a whole-bar tooltip', () => {
    // A column-wide cursor band is the same "the whole bar is the answer" claim
    // the card itself stopped making; Cursor.js only draws one in 'axis' mode,
    // and cursor={false} means it cannot come back if that mode ever changes.
    expect(page).toContain('cursor={false}');
    expect(page).not.toContain('cursor={{ fill: chart.grid');
    // shared must never be flipped to the whole-column payload.
    expect(page).not.toContain('shared={true}');
  });

  it('outlines the hovered slice ITSELF, and draws that outline without recharts', () => {
    // Two bugs in one assertion. recharts' own activeIndex is the CATEGORY
    // index, so leaving activeBar to it lights up every segment of the hovered
    // bar — a question nobody asked, drawn over the one being read.
    //
    // And passing our OWN activeIndex stopped working the day `bars` was
    // memoised. recharts only honours a caller's activeIndex while its own
    // state.activeTooltipIndex is >= 0; in item mode nothing sets that field,
    // and it was only ever reaching 0 because the unmemoised `data` identity
    // kept forcing a tooltip-state rebuild — i.e. because of the bug the memo
    // fixed. With the rebuild gone it sits at -1, recharts takes its
    // getItemByXY fallback, and that branch overwrites the activeIndex we
    // passed with the Bar's position among the chart's children. Nothing was
    // outlined at all, and no source scan of `activeBar=` could have said so.
    //
    // Drawing the outline in `shape` needs none of that: it reads the same
    // `hovered` the card does, so the two cannot name different slices.
    expect(page).toContain('shape={(props: unknown) => {');
    expect(page).toMatch(
      /hovered !== null && hovered\.key === seg\.key && hovered\.index === rect\.index/,
    );
    expect(page).toContain('stroke={outlined ? chart.tooltip.text : chart.tooltip.bg}');
    expect(page).toContain('strokeWidth={outlined ? 2 : 1}');
    // Neither handle may come back: recharts rewrites both, and `activeBar` is
    // also what switches its element-rewriting on (`hasActive`) in the first place.
    expect(page).not.toContain('activeBar=');
    expect(page).not.toContain('activeIndex=');
    expect(page).toContain('setHovered({ key: seg.key, index })');
    expect(page).toContain('onMouseLeave={() => setHovered(null)}');
  });

  it('separates touching slices with a hairline, now that any two can touch', () => {
    // Size ordering can put series[0] beside series[1] — the pair the theme
    // documents at ΔE 0.4 under deuteranopia, which this ledger's 401(k) and
    // Roth are. No boundary in the stack may rest on hue alone.
    expect(page).toContain('stroke={chart.tooltip.bg}');
    expect(page).toContain('strokeWidth={1}');
  });
});

describe('the snapshot dialog (source scan)', () => {
  const dialog = page.slice(
    page.indexOf('function SnapshotDialog'),
    page.indexOf('export function NetWorthPage'),
  );
  const take = page.slice(page.indexOf('const take = async ()'), page.indexOf('const remove ='));

  it('asks for the home value from a modal, so the card is one button', () => {
    expect(page).toContain('<dialog');
    // showModal(), not open=true: focus trapping, Escape and the inert backdrop
    // are the platform's, and this app owns no code for any of them.
    expect(page).toContain('dialog.showModal()');
    // In the banner now (the owner's relocation), and held while a snapshot
    // — automatic or manual — is already in flight.
    expect(page).toContain(
      '<button className="primary" disabled={autoTaking || taking} onClick={openDialog}>',
    );
    // The number is typed in exactly one place, and that place is the dialog.
    expect(page.match(/<NumberField/g)).toHaveLength(1);
    expect(dialog).toContain('<NumberField');
    expect(dialog).toContain('<TextField');
    expect(dialog).toContain('Taking a snapshot refreshes every holdings symbol');
  });

  it('takes a snapshot from confirm only — never from Cancel or Escape', () => {
    // Two call sites since 2026-08-30: the dialog's confirm, and the once-a-
    // day automatic snapshot on arrival. Nothing else may record a row.
    expect(page.match(/api\.takeNetWorthSnapshot/g)).toHaveLength(2);
    expect(page).toContain('const takenToday = snapshots.some((s) => {');
    expect(take).toContain('api.takeNetWorthSnapshot');
    expect(page).toContain('onConfirm={take}');
    expect(page).toContain('onDismiss={closeDialog}');
    expect(page).toContain('const closeDialog = () => setDialogOpen(false);');
    expect(dialog).toContain('onClick={() => void onConfirm()}');
    expect(dialog).toMatch(/<button onClick=\{onDismiss\} disabled=\{taking\}>\s*Cancel/);
    // Escape raises 'cancel'; it dismisses, and dismissing is not confirming.
    expect(dialog).toContain('onCancel={(e) => {');
    expect(dialog).toContain('if (!taking) onDismiss();');
  });

  it('shows the network wait inside the modal — the snapshot route refreshes quotes first', () => {
    expect(dialog).toContain("{taking ? 'Refreshing prices…' : 'Take snapshot'}");
    expect(dialog).toContain('disabled={taking}');
  });

  it('keeps the modal open when the snapshot fails, so the typed number survives', () => {
    expect(dialog).toContain('error-banner');
    // The success path closes it; the failure path must not, or the message and
    // the home value the user just typed both disappear with it.
    expect(take).toContain('setDialogOpen(false);');
    const failed = take.slice(take.indexOf('} catch (e) {'));
    expect(failed).toContain('setTakeError(');
    expect(failed).not.toContain('setDialogOpen');
  });
});

describe('hoveredSlice — the answer the hover card gives', () => {
  // Two days, so "which bar" is a real question and not a foregone one. The
  // stack sorts by size off the newest row: IRA, Home, 401(k), Roth.
  const { segments, bars } = buildNetWorthChart(
    [
      snapshot('2026-06-01T09:00:00.000Z', 500_000, [
        ['ira1', 'IRA', 820_000],
        ['k401', '401(k)', 148_000],
        ['roth1', 'Roth IRA', 96_000],
      ]),
      snapshot('2026-08-19T09:00:00.000Z', 550_000, [
        ['ira1', 'IRA', 921_544],
        ['k401', '401(k)', 162_431],
        ['roth1', 'Roth IRA', 118_420],
      ]),
    ],
    LIGHT,
  );

  it('names the THIRD segment when the third segment is hovered, not segment 0', () => {
    // The bug in one assertion. segments[0] is the IRA — the biggest slice, the
    // bottom of the stack, and the answer the card used to give whatever the
    // cursor was in. Pointing at segments[2] must yield segments[2].
    const third = segments[2];
    const reading = hoveredSlice({ key: third.key, index: 1 }, bars, segments);
    expect(reading).not.toBeNull();
    expect(reading?.segment.label).toBe('401(k)');
    expect(reading?.segment.label).not.toBe(segments[0].label);
    expect(reading?.value).toBe(162_431);
    expect(reading?.share).toBe('9% of $1,752,395');
  });

  it('reads the figure off the hovered BAR, not off bar 0', () => {
    // The old card was fed a payload recharts had rebuilt for tick index 0, so
    // even when it happened to name the right account it quoted the wrong day.
    const ira = segments[0];
    expect(hoveredSlice({ key: ira.key, index: 0 }, bars, segments)?.value).toBe(820_000);
    expect(hoveredSlice({ key: ira.key, index: 1 }, bars, segments)?.value).toBe(921_544);
  });

  it('finds the home wherever its size has put it in the stack', () => {
    const home = segments.find((s) => s.key === HOME_SEGMENT_KEY);
    const reading = hoveredSlice({ key: HOME_SEGMENT_KEY, index: 1 }, bars, segments);
    expect(home?.isHome).toBe(true);
    expect(reading?.segment.isHome).toBe(true);
    expect(reading?.value).toBe(550_000);
  });

  it('draws nothing when nothing is hovered', () => {
    expect(hoveredSlice(null, bars, segments)).toBeNull();
  });

  it('draws nothing — never segment 0 — when the hover no longer resolves', () => {
    // A held pointer while the ledger shrinks under it. Guessing is what the
    // bug was; a blank card is the honest answer.
    expect(hoveredSlice({ key: segments[0].key, index: 99 }, bars, segments)).toBeNull();
    expect(hoveredSlice({ key: 'a-deleted-account', index: 0 }, bars, segments)).toBeNull();
  });
});

describe('tooltipPosition — the card follows the cursor', () => {
  // Roughly the real thing: the card measured 218x86 in the browser, the plot
  // was 1190x520 at a 1280px window.
  const CARD = { width: 218, height: 86 };
  const PLOT = { width: 1190, height: 520 };

  it('sits just off the pointer, and MOVES WITH IT — the whole of bug 1', () => {
    // It used to be drawn at the top of the first stack no matter where the
    // cursor was. Two different pointers must give two different positions.
    const a = tooltipPosition({ x: 300, y: 200 }, CARD, PLOT);
    const b = tooltipPosition({ x: 520, y: 380 }, CARD, PLOT);
    expect(a).toEqual({ x: 300 + TOOLTIP_CURSOR_GAP, y: 200 + TOOLTIP_CURSOR_GAP });
    expect(b).toEqual({ x: 520 + TOOLTIP_CURSOR_GAP, y: 380 + TOOLTIP_CURSOR_GAP });
    expect(a).not.toEqual(b);
  });

  it('never sits under the pointer, which would steal its own hover', () => {
    // A card drawn on the cursor takes it off the slice that summoned it: the
    // Bar fires onMouseLeave, the card unmounts, and the pair flickers.
    const { x, y } = tooltipPosition({ x: 300, y: 200 }, CARD, PLOT);
    expect(x).toBeGreaterThan(300);
    expect(y).toBeGreaterThan(200);
  });

  it('flips to the left of the cursor rather than off the right edge', () => {
    // recharts clamps its OWN anchor to the viewBox but returns an explicit
    // position verbatim, so without this the card for the last bar is drawn
    // past the plot. 1000 + 14 + 218 = 1232 > 1190.
    const at = tooltipPosition({ x: 1000, y: 200 }, CARD, PLOT);
    expect(at.x).toBe(1000 - TOOLTIP_CURSOR_GAP - CARD.width);
    expect(at.x + CARD.width).toBeLessThanOrEqual(1190);
    // Vertically there was room, so that axis does not flip.
    expect(at.y).toBe(200 + TOOLTIP_CURSOR_GAP);
  });

  it('flips above the cursor rather than off the bottom edge', () => {
    // 460 + 14 + 86 = 560 > 520 — a slice near the baseline, which is most of
    // the biggest segment on this chart.
    const at = tooltipPosition({ x: 300, y: 460 }, CARD, PLOT);
    expect(at.y).toBe(460 - TOOLTIP_CURSOR_GAP - CARD.height);
    expect(at.y + CARD.height).toBeLessThanOrEqual(520);
    expect(at.x).toBe(300 + TOOLTIP_CURSOR_GAP);
  });

  it('flips both axes at once in the bottom-right corner', () => {
    const at = tooltipPosition({ x: 1150, y: 500 }, CARD, PLOT);
    expect(at).toEqual({
      x: 1150 - TOOLTIP_CURSOR_GAP - CARD.width,
      y: 500 - TOOLTIP_CURSOR_GAP - CARD.height,
    });
  });

  it('pins to the edge rather than off the far side when neither side fits', () => {
    // A card wider than its plot has nowhere to flip to. Showing as much of it
    // as there is room for beats pushing it off the opposite edge.
    const at = tooltipPosition({ x: 40, y: 30 }, { width: 400, height: 300 }, { width: 300, height: 200 });
    expect(at).toEqual({ x: 0, y: 0 });
  });
});

describe('formatSegmentShare', () => {
  it('says what the slice is OF the bar — the fact its own figure cannot carry', () => {
    expect(formatSegmentShare(665_000, 1_845_000)).toBe('36% of $1,845,000');
  });

  it('never calls a visible band 0%, and never calls an empty one anything else', () => {
    // $9k of Roth against a $3.6M total rounds to 0 and is plainly a band.
    expect(formatSegmentShare(9_000, 1_845_000)).toBe('<1% of $1,845,000');
    expect(formatSegmentShare(0, 1_845_000)).toBe('0% of $1,845,000');
  });

  it('has nothing to report about a bar that totals nothing', () => {
    expect(formatSegmentShare(0, 0)).toBeNull();
  });
});
