/**
 * Year-by-year cashflow table over the deterministic reference path. Every row
 * expands (click) into expense/withdrawal breakdowns, event/flag chips, and the
 * full tax detailTrace — the user's audit trail (SPEC §7/§9).
 */
import { Fragment, useState, type ReactNode } from 'react';
import type { TraceLine, YearRow } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import {
  GIVING_RULE_FLAG,
  charitableLineLabel,
  chipInfo,
  totalExpenses,
  totalIncome,
  totalWithdrawals,
} from './resultsData';

/**
 * Columns in the header, and therefore the colSpan an expanded row needs.
 *
 * The tithe column earns its place only in a run that has a tithe account:
 * every other plan would otherwise carry a permanent column of em-dashes
 * across an already-wide table. So the count is computed, not constant — bump
 * BASE when adding a column that every run shows.
 */
const BASE_COLUMN_COUNT = 12;

function columnCount(hasTithe: boolean): number {
  return hasTithe ? BASE_COLUMN_COUNT + 1 : BASE_COLUMN_COUNT;
}

/** Muted dash for zero amounts in sparse columns. */
function money(v: number): ReactNode {
  return v === 0 ? <span className="muted">—</span> : formatUSD(v);
}

function Trace({ lines }: { lines: TraceLine[] }) {
  return (
    <div className="trace">
      {lines.map((l, i) => (
        <div key={i}>
          <div className="trace-line" style={{ paddingLeft: (l.indent ?? 0) * 16 }}>
            <span>{l.label}</span>
            {l.amount !== undefined && <span>{formatUSD(l.amount, { cents: true })}</span>}
          </div>
          {l.note && (
            <div className="muted" style={{ paddingLeft: (l.indent ?? 0) * 16 + 12 }}>
              {l.note}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MiniRow({
  label,
  amount,
  sub,
  bold,
}: {
  label: string;
  amount: number;
  sub?: boolean;
  bold?: boolean;
}) {
  return (
    <tr style={bold ? { fontWeight: 600 } : undefined}>
      <td style={sub ? { paddingLeft: 26 } : undefined}>{label}</td>
      <td>{formatUSD(amount)}</td>
    </tr>
  );
}

function ExpenseBreakdown({ row }: { row: YearRow }) {
  const e = row.expenses;
  const h = row.housing;
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Expenses</h3>
      <table className="mini-table">
        <tbody>
          <MiniRow label="Living" amount={e.baseline} />
          <MiniRow label={charitableLineLabel(row)} amount={e.charitable} />
          <MiniRow label="Housing" amount={e.housing} />
          <MiniRow label="Rent" amount={h.rent} sub />
          <MiniRow label="Mortgage" amount={h.mortgagePayment} sub />
          <MiniRow label="Property tax" amount={h.propertyTax} sub />
          <MiniRow label="Insurance" amount={h.insurance} sub />
          <MiniRow label="Maintenance" amount={h.maintenance} sub />
          <MiniRow label="Health" amount={e.health} />
          <MiniRow label="One-time" amount={e.oneTime} />
          {/* Total = Living + Charitable + Housing + Health + One-time,
              matching the Expenses column. Taxes are not expenses (see the
              Taxes column) and neither is the investing transfer below. */}
          <MiniRow label="Total" amount={totalExpenses(row)} bold />
          {/* Note 24a: between sale and purchase the transfer's in-window
              share is parked in savings, not bought into the brokerage — the
              label says so in the years it happens, because a row named
              "→ brokerage" over money that went to cash would be a lie. */}
          <MiniRow
            label={
              row.banked !== undefined && row.banked.investing > 0
                ? 'Investing → savings (house fund) / brokerage'
                : 'Investing → brokerage'
            }
            amount={row.investing}
          />
          {/* Note 21: the year-end move into the tithe account. Like investing
              it is a transfer between accounts rather than money consumed, so
              it sits below the total and never inside it — and unlike a gift,
              it buys no charitable deduction, because nothing has been given
              away yet. */}
          {row.tithe !== undefined && row.tithe.accrued > 0 && (
            <MiniRow label="Set aside → tithe account" amount={row.tithe.accrued} />
          )}
          {/* Note 24b: the living money the renting column freed, parked in
              savings toward the purchase. Its own row because it is its own
              term in the cash identity — the investing slice above is not (it
              rides inside the transfer row). */}
          {row.banked !== undefined && row.banked.livingReduction > 0 && (
            <MiniRow
              label="Living reduction banked → savings"
              amount={row.banked.livingReduction}
            />
          )}
          {/* Note 20: leftover cash a working year consumed. It is neither an
              expense line nor an account transfer, so it sits below the total
              next to investing — the two together are what became of every
              dollar income and withdrawals left over. */}
          <MiniRow label="Unbudgeted / not invested" amount={row.unbudgeted} />
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12 }}>
        Investing is a transfer into the taxable brokerage, not consumption, so it is excluded
        from the expense total. Taxes ({formatUSD(row.taxes.totalTax)}) are tracked separately in
        the Taxes column.
      </div>
      {row.unbudgeted > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          Unbudgeted is what was left after taxes, the expenses above and the investing transfer
          in a year someone was still earning. Living expenses are a budget baseline — they do
          not carry the irregular costs a real year brings (a new air conditioner, a car repair,
          a trip), which is where that money goes. The plan assumes you invest only what you say
          you invest, so this is spent, not accumulated: it never becomes a balance.
        </div>
      )}
      {row.flags.includes(GIVING_RULE_FLAG) && (
        <div className="muted" style={{ fontSize: 12 }}>
          Giving this year came from the giving-after-work rule, not the working-years stream (the
          retirement year itself is split between them). The tax trace below names the rule and the
          prior-year base it read; whatever was given in cash still feeds the charitable
          deductions.
        </div>
      )}
      {row.tithe !== undefined && row.tithe.accrued > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          The tithe account is still filling, so this year gives nothing in cash and claims no
          charitable deduction for the {formatUSD(row.tithe.accrued)} set aside — the money moved
          from one side of the IRA to the other and has not been given away yet. It is not part of
          the expense total for the same reason the investing transfer is not.
        </div>
      )}
    </div>
  );
}

/**
 * The tithe account's year: what it holds, what moved, what was given.
 *
 * It gets its own panel rather than lines scattered through the others because
 * its money obeys different rules from everything around it — a balance inside
 * the IRA that no expense can reach, that the success rate is computed
 * WITHOUT, and that goes to charity rather than to heirs. Reading those facts
 * next to the numbers is the only way the exclusion is not a surprise.
 */
function TitheBreakdown({ row, names }: { row: YearRow; names: Record<string, string> }) {
  const t = row.tithe;
  if (t === undefined) return null;
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Tithe account</h3>
      <table className="mini-table">
        <tbody>
          {t.seeded > 0 && <MiniRow label="Opened with (untithed gains)" amount={t.seeded} />}
          {t.accrued > 0 && <MiniRow label="Set aside this year" amount={t.accrued} />}
          {t.given > 0 && <MiniRow label="Given in cash" amount={t.given} />}
          {t.forcedDistributionGiven > 0 && (
            <MiniRow label="Given because an RMD forced it out" amount={t.forcedDistributionGiven} />
          )}
          <MiniRow label="End balance" amount={t.balance} bold />
          <MiniRow label="End balance (today’s dollars)" amount={t.breakGlassReal} sub />
          <MiniRow label="Spendable portfolio" amount={row.balances.spendable} />
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12 }}>
        Carved out of {accountLabel(t.accountId, names)} — an accounting label on money still
        inside the IRA, not a separate account, so setting it aside cost no tax. It never funds an
        expense, and the success rate, terminal value and fan chart are all computed on the
        spendable figure above rather than on the End bal columns, which include it.
      </div>
      {t.forcedDistributionGiven > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          The IRS sees one IRA and requires distributions off the whole balance, so the carve-out’s
          share had to come out. It is not the household’s to spend, so it was given away the same
          year (in practice, a qualified charitable distribution).
        </div>
      )}
      {/* Only in a year the plan actually failed does the balance become a
          choice rather than a fact — this is the year the user would be
          deciding whether to break the promise, so it is the only year the
          figure is named that way. */}
      {row.flags.includes('insolvent') && t.breakGlassReal > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          <strong>Break glass:</strong> the money ran out this year with {formatUSD(t.balance)} (
          {formatUSD(t.breakGlassReal)} in today’s dollars) sitting here untouched. The plan does
          not spend it and does not count it, so the shortfall above is what happens if the
          promise is kept.
        </div>
      )}
    </div>
  );
}

function IncomeBreakdown({ row }: { row: YearRow }) {
  const inc = row.income;
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Income</h3>
      <table className="mini-table">
        <tbody>
          <MiniRow label="Wages (after deductions)" amount={inc.wages} />
          {/* The retirement income stream — part-time work, consulting, a
              rental, a pension. It sits next to wages because it is the same
              kind of thing: recurring cash the household brings in, here from
              the first year no salary is drawn (prorated in the retirement
              year). Without this line a retired year's cash would not add up. */}
          <MiniRow label="Retirement income" amount={inc.retirement} />
          <MiniRow label="Social Security" amount={inc.socialSecurity} />
          <MiniRow label="Taxable interest" amount={inc.taxableInterest} />
          <MiniRow label="Dividends" amount={inc.dividends} />
          <MiniRow label="Other" amount={inc.other} />
          <MiniRow label="Total" amount={totalIncome(row)} bold />
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12 }}>
        Employer health premium share: {formatUSD(inc.employerHealthPremiumShare)} — a pre-tax
        payroll deduction while working, so wages above are already net of it (it is not an
        expense line and not taxable income).
      </div>
    </div>
  );
}

/**
 * Display label for an account id. Profile accounts use their display name; the
 * engine also synthesizes accounts mid-run (a 401(k) rollover destination, and
 * the `<id>-sepp` carve-out created by the split-IRA technique), so fall back to
 * deriving a readable label from the parent account rather than showing a raw id.
 *
 * The suffixes NEST: an automatic 72(t) elects on the largest traditional IRA,
 * which for someone whose only pre-tax money was a 401(k) is the synthesized
 * rollover IRA — giving `<401k>-rollover-ira-sepp`. So the parent is resolved
 * recursively ("401(k) (rolled over) (72(t) SEPP)") instead of bottoming out on
 * a raw id. `-sepp2`, `-sepp3` … are the ids a second election on the same
 * account takes.
 */
export function accountLabel(id: string, names: Record<string, string>): string {
  if (names[id]) return names[id];
  const sepp = /^(.*)-sepp\d*$/.exec(id);
  if (sepp) return `${accountLabel(sepp[1], names)} (72(t) SEPP)`;
  // The tithe carve-out nests the same way and takes the same `-tithe2`,
  // `-tithe3` … bump when the id is already taken.
  const tithe = /^(.*)-tithe\d*$/.exec(id);
  if (tithe) return `${accountLabel(tithe[1], names)} (Tithe Account)`;
  if (id.endsWith('-rollover-ira')) {
    const parent = id.slice(0, -'-rollover-ira'.length);
    return `${accountLabel(parent, names)} (rolled over)`;
  }
  return id;
}

function WithdrawalBreakdown({ row, names }: { row: YearRow; names: Record<string, string> }) {
  const w = row.withdrawals;
  const byAccount = Object.entries(w.byAccount).filter(([, v]) => v !== 0);
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Withdrawals</h3>
      {byAccount.length === 0 && totalWithdrawals(row) === 0 ? (
        <div className="muted">No withdrawals this year.</div>
      ) : (
        <table className="mini-table">
          <tbody>
            {byAccount.map(([id, amount]) => (
              <MiniRow key={id} label={accountLabel(id, names)} amount={amount} />
            ))}
            <MiniRow label="Total" amount={totalWithdrawals(row)} bold />
            <MiniRow label="Realized LTCG" amount={w.realizedLtcg} />
            <MiniRow label="Penalty base" amount={w.penaltyBase} />
            {w.rothConversion > 0 && <MiniRow label="Roth conversion" amount={w.rothConversion} />}
            {w.rmd > 0 && <MiniRow label="RMD (forced)" amount={w.rmd} />}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EventsAndFlags({ row }: { row: YearRow }) {
  const empty = row.eventsFired.length === 0 && row.flags.length === 0;
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Events &amp; flags</h3>
      {empty ? (
        <div className="muted">None.</div>
      ) : (
        <div className="chip-list">
          {row.eventsFired.map((e) => {
            // The row is passed so a marker can name its own number (the
            // automatic 72(t) chip states the payment it was fixed at).
            const info = chipInfo(e, row);
            return (
              <span key={e} className="badge" title={info.title}>
                {info.label}
              </span>
            );
          })}
          {row.flags.map((f) => {
            const info = chipInfo(f);
            return (
              <span key={f} className="flag" title={info.title}>
                {info.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CashflowTable({
  referencePath,
  accountNames = {},
}: {
  referencePath: YearRow[];
  /** Account id -> display name, from the profile (see accountLabel). */
  accountNames?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const toggle = (year: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });

  // One pass over the path decides whether the tithe column exists at all, so
  // a plan without the rule keeps exactly the table it has always had.
  const hasTithe = referencePath.some((r) => r.balances.tithe > 0);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Year-by-year cashflow</h2>
      <div className="muted" style={{ marginBottom: 8 }}>
        Nominal dollars except the last column. Click a row for breakdowns and the full tax trace.
        {hasTithe
          ? ' The End bal columns include the tithe account; the success rate and the fan chart ' +
            'do not (expand a row for both figures).'
          : ''}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>Ages</th>
              <th>Wages</th>
              <th>Soc Sec</th>
              <th>Income</th>
              <th>Expenses</th>
              <th>Health</th>
              <th>Taxes</th>
              <th>Withdrawals</th>
              <th>RMD</th>
              {hasTithe && <th>Tithe</th>}
              <th>End bal</th>
              <th>End bal (real)</th>
            </tr>
          </thead>
          <tbody>
            {referencePath.map((row) => {
              const open = expanded.has(row.year);
              return (
                <Fragment key={row.year}>
                  <tr className="cf-row" onClick={() => toggle(row.year)}>
                    <td>
                      <span className="muted">{open ? '▾' : '▸'}</span> {row.year}
                    </td>
                    <td>{row.agesAtYearEnd.join(' / ')}</td>
                    <td>{money(row.income.wages)}</td>
                    <td>{money(row.income.socialSecurity)}</td>
                    <td>{formatUSD(totalIncome(row))}</td>
                    <td>{formatUSD(totalExpenses(row))}</td>
                    <td>{money(row.expenses.health)}</td>
                    <td>{formatUSD(row.taxes.totalTax)}</td>
                    <td>{money(totalWithdrawals(row))}</td>
                    <td>{money(row.withdrawals.rmd)}</td>
                    {hasTithe && <td>{money(row.balances.tithe)}</td>}
                    <td>{formatUSD(row.balances.total)}</td>
                    <td>{formatUSD(row.balances.totalReal)}</td>
                  </tr>
                  {open && (
                    <tr className="cf-expand">
                      <td colSpan={columnCount(hasTithe)} style={{ whiteSpace: 'normal' }}>
                        <div className="breakdown-grid">
                          <IncomeBreakdown row={row} />
                          <ExpenseBreakdown row={row} />
                          <WithdrawalBreakdown row={row} names={accountNames} />
                          <TitheBreakdown row={row} names={accountNames} />
                          <EventsAndFlags row={row} />
                        </div>
                        <h3>Tax trace</h3>
                        {row.taxes.trace && row.taxes.trace.length > 0 ? (
                          <Trace lines={row.taxes.trace} />
                        ) : (
                          <div className="muted">No tax trace recorded for this year.</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
