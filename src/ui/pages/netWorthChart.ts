/**
 * Pure data-shaping for the NET WORTH chart. No React, no IO.
 *
 * The chart is one stacked bar per snapshot, and the SEGMENT SET is the union
 * of every account id the ledger has ever recorded. It has to be the union: the
 * file is append-only across years in which accounts open and close, so a row
 * taken before the Roth held anything simply has no entry for it. Reading the
 * segments off the newest snapshot would erase a closed account from its own
 * history; reading them off the oldest would hide every account opened since.
 * The union, with a 0 for each absence, is the only assembly under which every
 * bar still adds up to the total that snapshot recorded — and 0 is the honest
 * figure, because "the account was not in this snapshot" and "the account held
 * nothing" are the same statement about the household's net worth.
 *
 * COLOUR CARRIES IDENTITY; POSITION CARRIES SIZE. They are two different
 * indexes, and keeping them apart is the whole design:
 *  - COLOUR is fixed by an account's FIRST APPEARANCE in the ledger and never
 *    moves again. Colour is how the eye follows one account from bar to bar, so
 *    the day the Brokerage overtakes the 401(k) it must change position without
 *    repainting anything — and a rename must not repaint it either, which is why
 *    the index is appearance and not name.
 *  - POSITION is by SIZE, descending, so segments[0] is the bottom of the bar
 *    (recharts stacks the first <Bar> on the baseline). A stack is read upward
 *    from the axis, so the big slices belong where a figure can still be read
 *    off the y axis, and the dust belongs at the top where it is dust rather
 *    than a band straddling a gridline halfway up.
 *
 * ONE order applies to every bar — a stack whose segments reshuffle bar by bar
 * is not a stack — and it comes from the NEWEST snapshot, which is the bar the
 * owner opened the page to read. The ordering must also be TOTAL, or two
 * segments could swap places on a re-render with the ledger unchanged: ties, and
 * segments the newest row has nothing in, fall back to their most recent
 * non-zero figure, and then to first appearance.
 *
 * It also carries the tooltip's PLACEMENT arithmetic (`tooltipPosition`), which
 * is geometry rather than data but belongs to the same "pure, no React, no IO"
 * half of the chart — and being pure is what lets the edge flips be tested
 * without a browser.
 *
 * THE HOME IS ORDERED BY SIZE like everything else. It used to cap every bar,
 * which said "the house is its own category" in the one channel that here means
 * "smallest thing in the stack" — and on this ledger the house is second only to
 * the IRA. What still marks it out is its colour: the palette's one un-hued
 * grey, which no account can be handed.
 *
 * IT ALSO CARRIES THE TABLE'S FORMATTING (`formatSnapshotDate`,
 * `snapshotChange`), which is not chart assembly but belongs to the same pure
 * half of the page — and since the owner moved the ledger table under the bars
 * (2026-09-03) the two are one panel anyway, reading the same rows.
 *
 * (Unit tests: tests/ui/netWorthChart.test.ts.)
 */
import type { NetWorthSnapshot } from '../../shared/types';
import { formatUSD } from '../../shared/util';
import type { ChartPalette } from '../theme';

/** A snapshot's moment for axis ticks and table rows: "Aug 18, 2026". */
export function formatSnapshotDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The tooltip's share line — the one thing about a slice its own dollar figure
 * cannot say: how much of that day's total it was ("55% of $1,845,000").
 *
 * Whole percent, with two figures it must not print. A slice under half a
 * percent rounds to "0% of $1.8M", which reads as "this is nothing" about a
 * $9,000 Roth that is plainly a visible band — it says "<1%" instead, and only
 * an exactly-empty account gets "0%". A bar totalling 0 has no shares to report
 * at all, and returns null so the caller drops the line rather than dividing.
 */
export function formatSegmentShare(value: number, total: number): string | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = Math.round((value / total) * 100);
  const shown = value === 0 ? '0%' : pct === 0 ? '<1%' : `${pct}%`;
  return `${shown} of ${formatUSD(total)}`;
}

/**
 * WHAT MOVED SINCE THE ROW BEFORE — the ledger table's one derived column
 * (the owner's request, 2026-09-03), and the only figure on the page that is
 * arithmetic rather than a record.
 *
 * ONE COLUMN, NOT TWO. The dollars and the percentage are the same fact read
 * two ways, and a household reads them together or not at all: $24,300 means
 * nothing without knowing it moved a $1.8M total, and 1.4% means nothing
 * without the dollars. Two columns would also double the width of a table that
 * already scrolls sideways on a narrow window, to say one thing twice.
 *
 * THE OLDEST ROW HAS NO CHANGE, and gets null rather than a zero. A first
 * snapshot did not hold steady — there was nothing to hold steady against, and
 * printing $0 would claim a measurement nobody took. Same reasoning as the
 * score cell's "not measured" two columns over.
 *
 * THE PERCENTAGE IS DROPPED, not faked, when the earlier total is not positive
 * — a percentage of zero is a division this table has no business printing.
 * The dollars stand alone in that case, and they are still true.
 */
export interface SnapshotChange {
  /** The signed dollar move; its SIGN is what the cell is coloured by. */
  amount: number;
  /** The cell: "+$24,300 (+1.4%)", or just the dollars when there is no base. */
  text: string;
  /** Which row this is measured against, and both totals, named on hover. */
  title: string;
}

/**
 * The change from `previous` to `current`, or null when there is no previous
 * row. `previous` is the snapshot taken BEFORE this one in time — the table
 * lists newest first, so on screen it is the row underneath.
 */
export function snapshotChange(
  current: NetWorthSnapshot,
  previous: NetWorthSnapshot | undefined,
): SnapshotChange | null {
  if (previous === undefined) return null;
  const amount = current.total - previous.total;
  // A true minus sign rather than a hyphen: this column is read down a stack
  // of right-aligned figures, where a hyphen is a dash and a dash is noise.
  const sign = amount > 0 ? '+' : amount < 0 ? '\u2212' : '';
  const pct =
    previous.total > 0
      ? ` (${sign}${((Math.abs(amount) / previous.total) * 100).toFixed(1)}%)`
      : '';
  return {
    amount,
    text: `${sign}${formatUSD(Math.abs(amount))}${pct}`,
    title:
      `Against ${formatSnapshotDate(previous.takenAt)}: ` +
      `${formatUSD(previous.total)} \u2192 ${formatUSD(current.total)}`,
  };
}

/**
 * Which entry of `chart.series` the nth account gets, and why not 0,1,2,3…
 *
 * series[0] against series[1] is the one pair the theme documents as unusable
 * side by side: blue and violet collapse to a single colour under deuteranopia
 * (ΔE 0.4 — see the `duo` note). Plain index order hands that pair to the first
 * two accounts, which are also the two most likely to be large and therefore to
 * touch in a size-ordered stack. Walking 0,3,1,2,4,5 instead holds series[1]
 * back to the third account and spends the palette's widest separations first.
 *
 * What this order can no longer PROMISE is which pairs touch. That was a
 * guarantee while position was first appearance; now that position is size, the
 * adjacency is whatever the balances say — on this ledger the 401(k) and the
 * Roth, series[0] and series[1], land next to each other. The chart therefore
 * draws a hairline between segments (NetWorthPage's `stroke`), so no boundary in
 * the stack rests on hue alone.
 */
const ACCOUNT_HUE_ORDER = [0, 3, 1, 2, 4, 5];

/**
 * The home's row key. Fixed rather than positional because the home is not one
 * of the accounts and never joins their rotation.
 */
export const HOME_SEGMENT_KEY = 'home';

export interface NetWorthSegment {
  /**
   * Key into `NetWorthBar.values`, and therefore half of a recharts dataKey.
   * Positional (`a0`, `a1`, …) rather than the account id, because an id is any
   * non-empty string the profile cares to carry and recharts resolves a dataKey
   * through lodash `get` — an account keyed `401.k` would be read as a path into
   * a nested object and silently draw nothing.
   *
   * The number is the account's FIRST-APPEARANCE index, like the colour: both
   * are identity, and neither moves when the stack re-sorts.
   */
  key: string;
  /** The account this segment tracks; null for the home. */
  id: string | null;
  /** Legend and tooltip label: the account's name as most recently recorded. */
  label: string;
  /** Fixed by first appearance — never by position. See the header. */
  fill: string;
  /** The home. It takes its place by size like any account; only its colour is set apart. */
  isHome: boolean;
}

export interface NetWorthBar {
  /** X tick and tooltip header: "Aug 18, 2026". */
  date: string;
  takenAt: string;
  /** What the snapshot RECORDED, not a re-addition of the segments below it. */
  total: number;
  note?: string;
  /** One entry per segment, 0 where this snapshot has no such account. */
  values: Record<string, number>;
}

export interface NetWorthChartData {
  /** Bottom to top: biggest slice first, so segments[0] sits on the baseline. */
  segments: NetWorthSegment[];
  /** Oldest first, as the ledger stores them. */
  bars: NetWorthBar[];
}

/** Which rectangle the cursor is in: a segment key, and which bar along the axis. */
export interface HoveredSlice {
  key: string;
  index: number;
}

/** Everything the hover card says, resolved from the page's own hover state. */
export interface SliceReading {
  bar: NetWorthBar;
  segment: NetWorthSegment;
  /** That slice's dollars in that bar — 0 where the snapshot had no such account. */
  value: number;
  /** The share line, or null for a bar that totalled nothing. */
  share: string | null;
}

/**
 * What the hover card is about, from the page's OWN record of what the cursor
 * is in — never from recharts' tooltip payload.
 *
 * This function IS the fix for "it displays the value for IRA no matter what I
 * hover over". The card used to read `payload[0]`, and payload[0] is the first
 * <Bar> declared, which is the biggest slice, which on this ledger is the IRA —
 * so every slice answered "IRA". Worse, the payload it was reading had been
 * rebuilt by recharts for bar index 0, so even the FIGURE belonged to the wrong
 * day. Resolving `{key, index}` — set by the very rectangle the pointer entered
 * — against the same `segments`/`bars` the chart was drawn from is the only
 * derivation that cannot disagree with what is on screen.
 *
 * Returns null for "nothing to draw": nothing hovered, or a key/index that no
 * longer resolves because the ledger changed under a held pointer. Null is a
 * blank card, never a fallback to segment 0 — guessing is what caused the bug.
 */
export function hoveredSlice(
  hovered: HoveredSlice | null,
  bars: NetWorthBar[],
  segments: NetWorthSegment[],
): SliceReading | null {
  if (hovered === null) return null;
  const bar = bars[hovered.index];
  const segment = segments.find((s) => s.key === hovered.key);
  if (bar === undefined || segment === undefined) return null;
  const value = bar.values[segment.key] ?? 0;
  return { bar, segment, value, share: formatSegmentShare(value, bar.total) };
}

/** A point in the chart's own pixel space — recharts' `chartX`/`chartY`. */
export interface ChartPoint {
  x: number;
  y: number;
}

/** A rendered box, measured. Used for both the hover card and the plot area. */
export interface BoxSize {
  width: number;
  height: number;
}

/**
 * How far the hover card sits from the pointer, in px.
 *
 * Not zero, and not decorative: the card is a real element in the chart's
 * container, so a card drawn UNDER the cursor takes the pointer off the slice
 * that summoned it — the Bar fires onMouseLeave, `hovered` clears, the card
 * unmounts, the pointer lands back on the slice, and the whole thing loops at
 * frame rate. 14px clears the cursor's own hotspot with room to spare.
 */
export const TOOLTIP_CURSOR_GAP = 14;

/**
 * Where to draw the hover card for a pointer at `pointer`, given the card's
 * measured size and the plot area's.
 *
 * Below-and-right of the cursor by default, because that is where a reader's
 * eye already is and it never covers the slice being pointed at.
 *
 * The FLIPS are not polish. Passing <Tooltip position={…}> an explicit numeric
 * point makes recharts return it verbatim (util/tooltip/translate.js: `if
 * (position && isNumber(position[key])) return position[key]`), which skips the
 * viewBox clamping the computed anchor would otherwise get. Without flipping,
 * the card for a slice near the right edge is simply drawn off the plot. So the
 * card goes to the other side of the cursor whenever it would overrun, on each
 * axis independently.
 *
 * The final clamp is for the case both sides lose: a card wider than the plot
 * area has nowhere to flip to, and pinning it at the edge shows as much of it as
 * there is room for instead of pushing it off the opposite side.
 */
export function tooltipPosition(
  pointer: ChartPoint,
  card: BoxSize,
  container: BoxSize,
  gap: number = TOOLTIP_CURSOR_GAP,
): ChartPoint {
  const right = pointer.x + gap;
  const below = pointer.y + gap;
  const x = right + card.width > container.width ? pointer.x - gap - card.width : right;
  const y = below + card.height > container.height ? pointer.y - gap - card.height : below;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

export function buildNetWorthChart(
  snapshots: NetWorthSnapshot[],
  chart: ChartPalette,
): NetWorthChartData {
  const order: string[] = [];
  const labels = new Map<string, string>();
  for (const s of snapshots) {
    for (const a of s.accounts) {
      if (!labels.has(a.id)) order.push(a.id);
      // Last write wins. An account renamed in the editor should appear in the
      // legend under the name it has now, not the one the oldest snapshot froze
      // — the id is the identity, the name is only what it is currently called.
      labels.set(a.id, a.name);
    }
  }

  const identified: NetWorthSegment[] = order.map((id, i) => ({
    key: `a${i}`,
    id,
    label: labels.get(id) ?? id,
    fill: chart.series[ACCOUNT_HUE_ORDER[i % ACCOUNT_HUE_ORDER.length]],
    isHome: false,
  }));
  identified.push({
    key: HOME_SEGMENT_KEY,
    id: null,
    label: 'Home',
    // The palette's last entry — its one un-hued grey, identical to
    // `neutralStrong` in both themes — and the account rotation stops one short
    // of it so no account can ever be handed the same colour. A house is not
    // another brokerage account: it is illiquid, and it is the one figure on the
    // page the user types himself. Hue reads as "an account"; the absence of
    // hue reads as "and this is the house" — which is the whole job, and it does
    // it from wherever the house's size puts it in the stack.
    fill: chart.series[chart.series.length - 1],
    isHome: true,
  });

  const balances = snapshots.map((s) => new Map(s.accounts.map((a) => [a.id, a.balance])));
  const valueIn = (seg: NetWorthSegment, i: number): number =>
    seg.id === null ? snapshots[i].homeValue : (balances[i].get(seg.id) ?? 0);

  const newest = snapshots.length - 1;
  const segments = identified
    .map((seg, appearance) => {
      let recent = 0;
      for (let i = newest; i >= 0; i--) {
        const v = valueIn(seg, i);
        if (v !== 0) {
          recent = v;
          break;
        }
      }
      return { seg, appearance, current: newest >= 0 ? valueIn(seg, newest) : 0, recent };
    })
    .sort((a, b) => b.current - a.current || b.recent - a.recent || a.appearance - b.appearance)
    .map((ranked) => ranked.seg);

  const bars: NetWorthBar[] = snapshots.map((s, i) => {
    const values: Record<string, number> = {};
    // In segment order, so `Object.keys(values)` reads bottom-to-top like the
    // stack does — the two must not be able to disagree about what a bar holds.
    for (const seg of segments) values[seg.key] = valueIn(seg, i);
    return {
      date: formatSnapshotDate(s.takenAt),
      takenAt: s.takenAt,
      total: s.total,
      values,
      ...(s.note !== undefined ? { note: s.note } : {}),
    };
  });

  return { segments, bars };
}
