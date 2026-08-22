/**
 * What this plan gives away, over the whole plan (note 21).
 *
 * Every other card here answers "will the money last?". This one answers the
 * question the user actually built the tithe rule to ask — how much reaches
 * charity — and it is the only place the two halves of that number are named
 * apart: dollars ALREADY GIVEN, year by year, versus a balance the household
 * has only PROMISED, which reaches charity at death and not before. They are
 * different kinds of commitment and adding them silently would flatter the
 * first with the second.
 *
 * The break-glass line belongs here rather than beside the success rate. It is
 * the cost of the promise stated in the promise's own terms: this is what the
 * plan gives up, and this is what was still sitting there in the futures where
 * giving it up hurt.
 *
 * Everything is in real (start-year) dollars, from the deterministic reference
 * path — the same path the cashflow table walks — because a lifetime total in
 * nominal dollars adds 2026 dollars to 2061 dollars and means nothing.
 */
import type { RunResult } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { InfoTip } from '../profile/fields';

const CARD_TIP =
  'Today’s dollars, from the deterministic reference path (the same path the year-by-year table ' +
  'walks), so the figures are comparable across runs and add up to something meaningful over ' +
  'thirty-odd years. Cash given is the sum of every year’s charitable expense. The tithe account ' +
  'is a balance, not a gift yet: it is what would reach charity if the plan ran to the horizon ' +
  'as modelled.';

const BREAK_GLASS_TIP =
  'Across the futures that ran out of money, the median tithe-account balance still sitting ' +
  'untouched in the year it happened. The plan never spends it and never counts it toward ' +
  'success — that is the whole point of the rule — so this is the size of the choice, not a ' +
  'reserve the plan is relying on. A blank here means either nothing failed or there is no ' +
  'tithe account.';

/** Same shape as the cashflow table's breakdown rows, so figures read alike. */
function Line({ label, amount, bold }: { label: string; amount: number; bold?: boolean }) {
  return (
    <tr style={bold ? { fontWeight: 600 } : undefined}>
      <td>{label}</td>
      <td>{formatUSD(amount)}</td>
    </tr>
  );
}

export function CharitableLegacyCard({
  charitableLegacy,
  breakGlassReal,
}: Pick<RunResult, 'charitableLegacy' | 'breakGlassReal'>) {
  const { cashGivenReal, terminalTitheReal, totalReal } = charitableLegacy;
  const hasTithe = terminalTitheReal > 0;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>
        Lifetime giving
        <InfoTip label="lifetime giving" text={CARD_TIP} />
      </h2>
      <div className="success-gauge">{formatUSD(totalReal)}</div>
      <table className="mini-table">
        <tbody>
          <Line label="Given in cash over the plan" amount={cashGivenReal} />
          {hasTithe && (
            <Line label="Tithe account, to charity at death" amount={terminalTitheReal} />
          )}
          {hasTithe && <Line label="Total" amount={totalReal} bold />}
        </tbody>
      </table>
      <div className="field-help" style={{ marginTop: 6 }}>
        {hasTithe
          ? 'The first line is money already out the door; the second is a balance still invested ' +
            'inside the IRA that the plan has promised away. A traditional IRA left to a charity ' +
            'is received tax-free and carries an uncapped estate deduction, so all of it lands.'
          : 'Every charitable dollar this plan spends, in today’s dollars.'}
      </div>
      {breakGlassReal !== null && (
        <div className="field-help" style={{ marginTop: 6 }}>
          <strong>Break glass: {formatUSD(breakGlassReal)}</strong> — what the tithe account was
          worth, untouched, in the futures where the money ran out.
          <InfoTip label="the break-glass figure" text={BREAK_GLASS_TIP} />
        </div>
      )}
    </div>
  );
}
