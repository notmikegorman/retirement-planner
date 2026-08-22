/**
 * One metric in the Workbench strip: what it is now, and how far it moved.
 *
 * The move is the point. Seeing "52.5%" tells the user nothing about the edit
 * they just made; seeing "52.5%  ▲ +12.8 pts" says that edit was worth 12.8
 * points. The arrow encodes the SIGN of the move and the color encodes whether
 * that sign is good news — they disagree for the shortfall year, where a later
 * year is a better one.
 */
import { noChangeChip, type MetricDelta } from './workbenchLogic';

function arrow(direction: MetricDelta['direction']): string {
  switch (direction) {
    case 'up':
      return '▲ ';
    case 'down':
      return '▼ ';
    default:
      return '';
  }
}

export function DeltaChip({
  delta,
  /** Optional color class for the VALUE (the success gauge's good/warn/bad). */
  valueClass,
  /**
   * True when a comparison run EXISTS and was thrown out for having been
   * measured differently. It changes only what the chip says in place of a
   * change — "first run" would be plainly false in that case.
   */
  methodMismatch = false,
}: {
  delta: MetricDelta;
  valueClass?: string;
  methodMismatch?: boolean;
}) {
  const noChange = noChangeChip(methodMismatch);
  return (
    // The tooltip rides on the whole tile: a metric that needs defining needs
    // defining wherever the reader's cursor happens to hover, not on one word.
    <div title={delta.tooltip}>
      <div className="metric-label">{delta.label}</div>
      <div className={valueClass ? `wb-metric-value ${valueClass}` : 'wb-metric-value'}>
        {delta.value}
      </div>
      {delta.change === null ? (
        <span className="wb-chip" title={noChange.title}>
          {noChange.text}
        </span>
      ) : (
        /*
          The chip carries its OWN title when it has one, separate from the
          tile's. They answer different questions: the tile's says what the
          number counts, the chip's says what the app did with the difference —
          today, that it declined to call a sub-noise difference a move.
        */
        <span className={`wb-chip ${delta.tone}`} title={delta.changeTitle}>
          {arrow(delta.direction)}
          {delta.change}
        </span>
      )}
      {/*
        The second line a metric can carry (today: the guardrails band in the
        withdrawal rate's own units). Capped in width so a sentence under one
        tile does not stretch the whole strip row.
      */}
      {delta.note !== undefined && (
        <div className="field-help" style={{ maxWidth: 300, marginTop: 5 }}>
          {delta.note}
        </div>
      )}
    </div>
  );
}
