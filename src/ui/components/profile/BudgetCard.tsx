/**
 * The itemised budget, cut into three homogeneous tabs — Expenses (living),
 * the Tithing tab's giving lines, and Investing — all editing the SAME
 * ProfileExpenses.lines array through the same derivation.
 *
 * WHY THREE TABS AND NOT ONE TABLE. The single table needed a category column
 * and a per-row explanation of which cells were real: giving's after-work
 * cells were a rule stated where an input should be, and the never-summed
 * rows had to be dimmed so they would not read as spending. Cut by category,
 * all of that apparatus disappears — a row IS what its tab says it is, new
 * rows are stamped with the tab's category, and each tab renders ONLY the
 * money columns the engine reads off its lines (LINE_TAB_COLUMNS is that
 * decision, written once). The hard rule behind the column sets: a cell that
 * commits a number nothing consumes is a lie in a financial tool.
 *
 * WHY A TABLE AND NOT THREE BOXES. Three scalar streams can say what the
 * household spends; they cannot say what any of it does when a salary stops or
 * when one of two people dies. A global survivor percentage cannot either — a
 * household with ONE car does not see its $610 payment fall by a quarter when
 * one of them dies, it does not fall at all. A number per LINE per state says
 * that exactly.
 *
 * INHERITED IS NOT THE SAME AS CHOSEN, and the whole editor turns on being able
 * to see which is which at a glance. A blank retired/survivor cell shows the
 * figure it inherits, muted and italic, through the input's own placeholder:
 * typing sets the cell, clearing it hands the cell back. A stored number and an
 * inherited one must never look alike, because absence is what carries the
 * meaning in profile.json.
 *
 * The categories with no tab ('insurance', 'modeled_elsewhere', 'excluded')
 * have no rows in the user's data and the import no longer writes them; a
 * line hand-edited into profile.json is filtered out of every tab and every
 * total (see categoryTotals) rather than crashing anything or quietly joining
 * a figure the engine never spends.
 */
import type { ExpenseLine, Profile, ProfileExpenses } from '../../../shared/types';
import { deriveExpenseStreams } from '../../../shared/expenses';
import { formatUSD } from '../../../shared/util';
import {
  FieldNote,
  InfoTip,
  MoneyCell,
  MonthlyMoneyField,
  NumberField,
  TextCell,
} from './fields';
import { annualFromMonthly } from './profileLogic';
import { effectiveRetiredMonthly, retiredPlaceholder } from '../workbench/workbenchLogic';
import {
  LINE_TAB_COLUMNS,
  applyDerivedStreams,
  categoryTotals,
  formatMonth,
  makeExpenseLine,
  moveLineWithinCategory,
  rentingInheritanceSplits,
  rentingMonthly,
  seedLinesFromStreams,
  survivorInheritanceSplits,
  survivorMonthly,
  type RentingWindow,
  type SummedLineCategory,
} from './expensesLogic';

type UpdateFn = (mutate: (p: Profile) => void) => void;

// --- Help copy (see fields.tsx InfoTip: anything longer than a glance) ------

const NOW_TIP =
  'What the line costs while a salary is still coming in. This is the only column that is always ' +
  'a number you type; the columns beside it inherit it until you say otherwise.';

const RETIRED_TIP =
  'What the line costs once NOBODY in the household earns a salary. LEAVE IT EMPTY and it stays ' +
  'at the Now figure, which is the honest default — groceries, utilities and insurance do not ' +
  'fall the day the salary stops. The retirement year itself is split: the Now figure for the ' +
  'months worked, this one for the rest.';

/**
 * The tooltip's opener; the window sentence is appended per render because the
 * dates come from the CURRENT plan and the plan is not profile data.
 */
const RENTING_TIP_BASE =
  'What the line costs while you are BETWEEN HOMES — sold, renting, the next purchase still ' +
  'ahead. LEAVE IT EMPTY and it stays at whatever is otherwise in force for that month (the Now ' +
  'or after-work figure). Heating oil and the security system go to zero in an apartment; ' +
  'electricity roughly halves; most lines do not notice the dwelling at all. Whatever this ' +
  'column frees up is banked in cash toward the purchase, not spent. The months it prices come ' +
  'from the plan’s housing move (the sale month through the month before the purchase), so a ' +
  'plan with no pending purchase — including renting from then on — never reads it. ';

function rentingTip(window: RentingWindow | null): string {
  return (
    RENTING_TIP_BASE +
    (window === null
      ? 'The current plan has no such window, so this column is priced into nothing right now — ' +
        'it comes alive the moment the plan models a sell-then-buy move.'
      : `The current plan’s window is ${formatMonth(window.from)} to ${formatMonth(window.to)} ` +
        `(${window.months} months renting).`)
  );
}

const SURVIVOR_TIP =
  'What the line costs the SURVIVOR alone, from the month of death. LEAVE IT EMPTY and it does ' +
  'not change — which is right for every household-level line (the mortgage, the property tax, ' +
  'the one car whose payment does not fall because one of you died) and wrong only for the ' +
  'genuinely per-person ones, which is exactly where a number belongs. An empty cell inherits ' +
  'whichever state is in force, so it shows the after-work figure here and says when a death ' +
  'while still working would inherit something different.';

const INVESTING_RETIRED_TIP =
  'What the transfer becomes once NOBODY in the household earns a salary. LEAVE IT EMPTY and it ' +
  'stays at the Now figure — a blank cell inherits here like everywhere else in the budget — so ' +
  'type a 0 to say the transfer ends with the paycheck. Whatever the column says, the plan caps ' +
  'it at the year’s surplus, so it can never force a withdrawal.';

const ITEMISE_TIP =
  'One row per stream to start with, holding exactly the numbers above, so nothing changes on the ' +
  'day you itemise. From then on THE TABLE IS THE TRUTH: these three figures become a sum of it ' +
  'and are rewritten on every edit. Delete every row and they stay at their last totals, so the ' +
  'itemisation collapses back into the streams it came from rather than being lost.';

// --- The scalar streams (help copy moved here with the fields it explains) --

const EXPENSE_SPLIT_NOTE =
  'These three streams replace the old single “annual baseline spending” number — re-enter your ' +
  'living expenses with giving and investing carved out, or you will double-count them. Each has ' +
  'a value in play while working and a value in play afterwards; the Plan page’s Spending card ' +
  'shows the same pairs side by side and can override either of them for one plan.';
const RETIRED_SWITCH_NOTE =
  'Living, investing and giving all switch on ONE signal: the first year in which nobody in the ' +
  'household earns a salary. The retirement year itself is split — the working figure for the ' +
  'months worked, the after-work figure for the rest.';
const LIVING_HELP =
  'Everyday consumption only: excludes health premiums, housing (property tax, insurance, ' +
  'maintenance, rent, mortgage), charitable giving and investing — all modeled separately.';
const LIVING_RETIRED_HELP =
  'What everyday consumption becomes once nobody is earning. LEAVE IT EMPTY and it stays at the ' +
  'working figure, which is the honest default — groceries, utilities and insurance do not fall ' +
  'the day the salary stops. (Under the fixed-percent spending policy neither figure is ' +
  'consulted: the policy sets living spending outright.)';
const CHARITABLE_HELP =
  'Your giving while anyone is still earning. It feeds the charitable tax deductions, and — ' +
  'unlike investing below — it does not stop by itself when the paychecks do: the rule on the ' +
  'Tithing page says what happens then.';
const INVESTING_HELP =
  'Money moved into the taxable brokerage while working — not spending. It is capped at what’s ' +
  'left after taxes and expenses, so it can never force a withdrawal. While anyone is still ' +
  'earning, this is the ONLY thing the plan assumes you accumulate: whatever the paycheck leaves ' +
  'over beyond it is treated as spent (the living figure is a budget, and it does not carry the ' +
  'new air conditioner), and the cashflow table shows it as “Unbudgeted / not invested”.';
const INVESTING_RETIRED_HELP =
  'What the transfer becomes once nobody is earning. LEAVE IT EMPTY and it stops, which is the ' +
  'honest default — investing out of a paycheck ends with the paycheck. Put a figure here if you ' +
  'expect to keep investing anyway (a forced RMD you do not spend, say); it stays capped at the ' +
  'year’s surplus.';

/**
 * The retired half of a paired stream, as the household's own baseline.
 *
 * It is OPTIONAL on purpose: an empty box leaves the field absent from
 * profile.json, and absence already carries the right meaning per stream —
 * living stays at the working figure, investing stops. So the placeholder says
 * which of those it is, and the annual note prices whichever value the engine
 * will actually use, rather than showing a hopeful $0.
 */
function RetiredMonthlyField(props: {
  label: string;
  fallback: 'same_as_working' | 'stops';
  working: number;
  value: number | undefined;
  tip: string;
  onCommit: (value: number | undefined) => void;
}) {
  const effective = effectiveRetiredMonthly(props.fallback, props.working, props.value, undefined);
  return (
    <>
      <NumberField
        label={props.label}
        allowEmpty
        placeholder={retiredPlaceholder(props.fallback, undefined)}
        value={props.value}
        width={230}
        tip={props.tip}
        onCommit={props.onCommit}
      />
      <FieldNote className="muted">= {formatUSD(annualFromMonthly(effective))}/yr</FieldNote>
    </>
  );
}

/** The Expenses tab: the living lines, or the pre-itemisation streams. */
export function BudgetCard({
  expenses,
  update,
  rentingWindow = null,
}: {
  expenses: ProfileExpenses;
  update: UpdateFn;
  /**
   * The current plan's between-homes span, for the renting column's header —
   * null when the plan implies none (or the plan failed to load, which the
   * tooltip's hypothetical wording covers honestly either way).
   */
  rentingWindow?: RentingWindow | null;
}) {
  const lines = expenses.lines ?? [];
  return lines.length === 0 ? (
    <StreamsCard expenses={expenses} update={update} />
  ) : (
    <LivingCard lines={lines} expenses={expenses} update={update} rentingWindow={rentingWindow} />
  );
}

/**
 * The pre-itemisation editor, and the offer to itemise.
 *
 * It is still here, unchanged, because a profile with no rows is one the three
 * scalars ARE the truth for — every profile written before the table existed —
 * and deleting the last row has to land somewhere that can still be edited.
 */
function StreamsCard({ expenses, update }: { expenses: ProfileExpenses; update: UpdateFn }) {
  return (
    <div className="card">
      {/* No "Expenses" heading: the banner already says where you are. */}
      <p className="muted" style={{ marginTop: 0 }}>
        Three monthly streams in today’s dollars, each modeled differently, and each with a value in
        play while working and a value in play afterwards.
        <InfoTip label="the expense streams" text={EXPENSE_SPLIT_NOTE} />
        <InfoTip label="the working/after-work switch" text={RETIRED_SWITCH_NOTE} />
      </p>
      <div className="row">
        <MonthlyMoneyField
          label="Living expenses ($/mo)"
          value={expenses.livingMonthly}
          tip={LIVING_HELP}
          onCommit={(v) =>
            update((p) => {
              p.expenses.livingMonthly = v;
            })
          }
        />
        <RetiredMonthlyField
          label="Living after you stop working ($/mo)"
          fallback="same_as_working"
          working={expenses.livingMonthly}
          value={expenses.livingMonthlyRetired}
          tip={LIVING_RETIRED_HELP}
          onCommit={(v) =>
            update((p) => {
              if (v == null) delete p.expenses.livingMonthlyRetired;
              else p.expenses.livingMonthlyRetired = v;
            })
          }
        />
      </div>
      <div className="row">
        <MonthlyMoneyField
          label="Charitable giving ($/mo)"
          value={expenses.charitableMonthly}
          tip={CHARITABLE_HELP}
          onCommit={(v) =>
            update((p) => {
              p.expenses.charitableMonthly = v;
            })
          }
        />
        <FieldNote className="muted">
          giving after you stop working is a rule — see the Tithing page
        </FieldNote>
      </div>
      <div className="row">
        <MonthlyMoneyField
          label="Investing / savings ($/mo)"
          value={expenses.investingMonthly}
          tip={INVESTING_HELP}
          onCommit={(v) =>
            update((p) => {
              p.expenses.investingMonthly = v;
            })
          }
        />
        <RetiredMonthlyField
          label="Investing after you stop working ($/mo)"
          fallback="stops"
          working={expenses.investingMonthly}
          value={expenses.investingMonthlyRetired}
          tip={INVESTING_RETIRED_HELP}
          onCommit={(v) =>
            update((p) => {
              if (v == null) delete p.expenses.investingMonthlyRetired;
              else p.expenses.investingMonthlyRetired = v;
            })
          }
        />
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <h3 style={{ margin: '0 0 4px' }}>
          Itemise this budget
          <InfoTip label="itemising the budget" text={ITEMISE_TIP} />
        </h3>
        <p className="field-help" style={{ marginTop: 0 }}>
          Transcribe the real budget line by line and each line gets its own answer for “if I stop
          working” and “if I die” — which is the only way to say that the car payment does not fall
          when one of you dies. The lines land on their own tabs: living here, giving on Tithing,
          investing on Investing. Seeding loses nothing: the three figures above become the first
          three rows.
        </p>
        <div className="row inlineRow">
          <button
            className="primary"
            onClick={() =>
              update((p) => {
                p.expenses.lines = seedLinesFromStreams(p.expenses);
              })
            }
          >
            Start from these three streams
          </button>
          <button
            onClick={() =>
              update((p) => {
                p.expenses.lines = [makeExpenseLine([], 'living')];
                applyDerivedStreams(p.expenses);
              })
            }
          >
            Start with one empty row
          </button>
          <span className="muted">
            An empty row makes the table the truth at once — the three figures above become a sum of
            it, so seeding is the safe way in.
          </span>
        </div>
        {/* Visible only inside a DISABLED fieldset (view mode), where the two
            start buttons above hide: a pitch whose call to action vanished
            reads as broken. The stylesheet owns the toggle (.editHint). */}
        <p className="field-help editHint">Press Edit, top right, to start itemising.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The shared table machinery
// ---------------------------------------------------------------------------

type EditLinesFn = (mutate: (lines: ExpenseLine[]) => ExpenseLine[] | void) => void;

/**
 * Every edit rewrites the scalar cache (applyDerivedStreams) so the file and
 * the Workbench never hold a second, staler answer to "what do you spend".
 * Emptying the table deletes the key rather than storing `[]`: absent and
 * empty mean the same thing to the engine, and absent is the quieter of the
 * two in profile.json.
 *
 * One factory shared by all three tabs, because they edit ONE array — a tab
 * that wrote lines without re-deriving would leave the other two tabs (and
 * every run) reading totals its edit just falsified.
 */
function editLinesWith(update: UpdateFn): EditLinesFn {
  return (mutate) =>
    update((p) => {
      const current = p.expenses.lines ?? [];
      const next = mutate(current) ?? current;
      if (next.length === 0) delete p.expenses.lines;
      else p.expenses.lines = next;
      applyDerivedStreams(p.expenses);
    });
}

/**
 * One tab's table: the lines of ONE category, with exactly the money columns
 * the engine reads off that category (LINE_TAB_COLUMNS says which, and why).
 * `lines` is always the FULL array — the filter lives here so no caller can
 * accidentally hand a pre-filtered list to the edit functions, whose index
 * arithmetic is over the full array.
 */
function LinesTable(props: {
  lines: ExpenseLine[];
  category: SummedLineCategory;
  nowTip?: string;
  rentingTip?: string;
  retiredTip?: string;
  survivorTip?: string;
  editLines: EditLinesFn;
}) {
  const { lines, category, editLines } = props;
  const columns = LINE_TAB_COLUMNS[category];
  const members = lines.filter((line) => line.category === category);
  const totals = categoryTotals(lines, category);
  return (
    <div className="table-scroll managedTableWrap">
      <table className="budget-table">
        <thead>
          <tr>
            <th>Line</th>
            <th>
              Now
              {props.nowTip ? <InfoTip label="the Now column" text={props.nowTip} /> : null}
            </th>
            {/* Between Now and the after-work column: the window sits between
                the working years and (usually) the retired ones, so the money
                columns read left to right in the order the plan lives them. */}
            {columns.renting ? (
              <th>
                While renting
                {props.rentingTip ? (
                  <InfoTip label="the renting column" text={props.rentingTip} align="start" />
                ) : null}
              </th>
            ) : null}
            {columns.retired ? (
              <th>
                If I stop working
                {props.retiredTip ? (
                  <InfoTip
                    label="the after-work column"
                    text={props.retiredTip}
                    align={columns.survivor ? 'start' : 'end'}
                  />
                ) : null}
              </th>
            ) : null}
            {columns.survivor ? (
              <th>
                If I die
                {props.survivorTip ? (
                  <InfoTip label="the survivor column" text={props.survivorTip} align="end" />
                ) : null}
              </th>
            ) : null}
            <th aria-label="Row controls" />
          </tr>
        </thead>
        <tbody>
          {members.map((line, i) => (
            <LineRow
              key={line.id}
              line={line}
              first={i === 0}
              last={i === members.length - 1}
              columns={columns}
              editLines={editLines}
            />
          ))}
        </tbody>
        <tfoot>
          <tr className="budget-total">
            <th className="col-text">Total</th>
            <td>{formatUSD(totals.now)}</td>
            {columns.renting ? <td>{formatUSD(totals.renting)}</td> : null}
            {columns.retired ? <td>{formatUSD(totals.retired)}</td> : null}
            {columns.survivor ? <td>{formatUSD(totals.survivorAfterRetiring)}</td> : null}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function LineRow({
  line,
  first,
  last,
  columns,
  editLines,
}: {
  line: ExpenseLine;
  /** First/last WITHIN THE TAB's lines — what the move buttons can reach. */
  first: boolean;
  last: boolean;
  columns: { renting: boolean; retired: boolean; survivor: boolean };
  editLines: EditLinesFn;
}) {
  const patch = (mutate: (line: ExpenseLine) => void) =>
    editLines((ls) => {
      // By id, never by index: the tab shows a filtered view, so a row's
      // position on screen is not its position in the array being edited.
      const found = ls.find((l) => l.id === line.id);
      if (found) mutate(found);
    });

  return (
    <tr>
      {/*
        The transcribed note survives as a hover title, not an editor: the
        textfield under every row doubled the table's height to hold prose that
        matters once (why a line is 0 in retirement, say). The transcribe
        script still writes notes; hovering the label is where they surface.
      */}
      <td className="col-text" title={line.note}>
        <TextCell
          value={line.label}
          required
          ariaLabel={`Label for ${line.label}`}
          onCommit={(v) =>
            patch((l) => {
              l.label = v;
            })
          }
        />
      </td>
      <td>
        <MoneyCell
          value={line.monthlyNow}
          placeholder="0"
          ariaLabel={`Now, ${line.label}`}
          onCommit={(v) =>
            patch((l) => {
              l.monthlyNow = v ?? 0;
            })
          }
        />
      </td>
      {columns.renting ? (
        <td>
          <MoneyCell
            value={line.monthlyRenting}
            // The working-state inheritance, like the after-work cell beside
            // it: the placeholder shows the simpler state and the note below
            // covers window months after the last paycheck.
            placeholder={String(rentingMonthly(line, 'working'))}
            ariaLabel={`While renting, ${line.label}`}
            title={
              line.monthlyRenting === undefined
                ? 'Inherited from whichever figure is in force — nothing was set here'
                : undefined
            }
            onCommit={(v) =>
              patch((l) => {
                if (v === undefined) delete l.monthlyRenting;
                else l.monthlyRenting = v;
              })
            }
          />
          {/* The one case a single inherited number cannot state: renting
              months before and after the last paycheck inherit different
              figures, and the user's own window straddles that line. */}
          {rentingInheritanceSplits(line) ? (
            <div className="cell-note">
              {formatUSD(rentingMonthly(line, 'retired'))} once work stops
            </div>
          ) : null}
        </td>
      ) : null}
      {columns.retired ? (
        <td>
          <MoneyCell
            value={line.monthlyRetired}
            placeholder={String(line.monthlyNow)}
            ariaLabel={`After work stops, ${line.label}`}
            title={
              line.monthlyRetired === undefined
                ? 'Inherited from Now — nothing was set here'
                : undefined
            }
            onCommit={(v) =>
              patch((l) => {
                if (v === undefined) delete l.monthlyRetired;
                else l.monthlyRetired = v;
              })
            }
          />
        </td>
      ) : null}
      {columns.survivor ? (
        <td>
          <MoneyCell
            value={line.monthlySurvivor}
            placeholder={String(survivorMonthly(line, 'retired'))}
            ariaLabel={`If I die, ${line.label}`}
            title={
              line.monthlySurvivor === undefined
                ? 'Inherited from whichever state is in force — nothing was set here'
                : undefined
            }
            onCommit={(v) =>
              patch((l) => {
                if (v === undefined) delete l.monthlySurvivor;
                else l.monthlySurvivor = v;
              })
            }
          />
          {/* The one case a single inherited number cannot state: the two
              states inherit different figures, so naming only the later one
              would hide what a death while still working costs. */}
          {survivorInheritanceSplits(line) ? (
            <div className="cell-note">
              {formatUSD(survivorMonthly(line, 'working'))} while still working
            </div>
          ) : null}
        </td>
      ) : null}
      <td className="col-text">
        <div className="cell-controls">
          <button
            className="cell-btn"
            disabled={first}
            title="Move up"
            aria-label={`Move ${line.label} up`}
            onClick={() => editLines((ls) => moveLineWithinCategory(ls, line.id, -1))}
          >
            ↑
          </button>
          <button
            className="cell-btn"
            disabled={last}
            title="Move down"
            aria-label={`Move ${line.label} down`}
            onClick={() => editLines((ls) => moveLineWithinCategory(ls, line.id, 1))}
          >
            ↓
          </button>
          <button
            className="cell-btn danger"
            title="Delete this line"
            aria-label={`Delete ${line.label}`}
            onClick={() => editLines((ls) => ls.filter((l) => l.id !== line.id))}
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// The three tabs
// ---------------------------------------------------------------------------

/** The Expenses tab once itemised: living lines only, all four states. */
function LivingCard({
  lines,
  expenses,
  update,
  rentingWindow,
}: {
  lines: ExpenseLine[];
  expenses: ProfileExpenses;
  update: UpdateFn;
  rentingWindow: RentingWindow | null;
}) {
  const editLines = editLinesWith(update);
  // The engine's own derivation, not a second copy of the sums: what this
  // card says the rows set is exactly what the run will spend.
  const streams = deriveExpenseStreams(expenses);
  const totals = categoryTotals(lines, 'living');

  return (
    <div>
      {/* No "Expenses" heading, no card, no preamble, no toolbar: the banner
          names the module and carries + Add row (ExpensesModule's
          extraActions); the today's-dollars / inherited-cell rules moved to
          the first-visit intro modal (ExpensesModule.tsx). */}
      <LinesTable
        lines={lines}
        category="living"
        nowTip={NOW_TIP}
        rentingTip={rentingTip(rentingWindow)}
        retiredTip={RETIRED_TIP}
        survivorTip={SURVIVOR_TIP}
        editLines={editLines}
      />

      <div className="field-help" style={{ marginTop: 8 }}>
        The “if I die” total assumes the death comes AFTER work has stopped, because that is the
        state an empty cell inherits there.
        {totals.survivorWhileWorking === totals.survivorAfterRetiring
          ? ''
          : ` A death while a salary is still coming in costs ${formatUSD(
              totals.survivorWhileWorking,
            )}/mo of living spending instead.`}
      </div>
      <div className="field-help" style={{ marginTop: 4 }}>
        These rows SET the plan’s living stream: {formatUSD(streams.livingMonthly)}/mo
        {streams.livingMonthlyRetired === undefined
          ? ' (unchanged after work stops)'
          : ` (${formatUSD(streams.livingMonthlyRetired)} after work stops)`}
        . The rest of the budget lives on its own tabs: giving on Tithing, investing on Investing.
      </div>
    </div>
  );
}

/**
 * The giving lines, rendered INSIDE the Tithing card so they sit right above
 * the rule that owns their after-work half.
 *
 * Renders nothing before the budget is itemised: with no rows the scalar
 * streams are the truth and are edited on the Expenses tab, and a "+ Add row"
 * here would create the first row — at which point the near-empty table
 * silently becomes the truth for living and investing too, zeroing both.
 */
export function GivingLines({
  expenses,
  update,
}: {
  expenses: ProfileExpenses;
  update: UpdateFn;
}) {
  const lines = expenses.lines ?? [];
  if (lines.length === 0) return null;
  const editLines = editLinesWith(update);
  return (
    <>
      {/* The asymmetry with the other budget tabs is deliberate, and this
          sentence is where the tab says so — without it, one money column
          reads as an editor somebody forgot to finish. */}
      <div className="row inlineRow">
        <p className="muted" style={{ margin: 0 }}>
          Every figure is $/month in today’s dollars, and there is only a Now column: giving after
          the last paycheck follows the rule on the Going-forward tab, and
          the plan never reads an after-work or survivor figure off a giving line.
        </p>
        <span className="spacer" />
        <button onClick={() => editLines((ls) => [...ls, makeExpenseLine(ls, 'charitable')])}>
          + Add row
        </button>
      </div>
      <LinesTable lines={lines} category="charitable" editLines={editLines} />
    </>
  );
}

/**
 * The Investing page — the transfer into the brokerage as the two numbers it
 * is (the owner's call, 2026-08-30: a form, not a table). Before itemisation
 * the two scalars are the truth and are edited directly; after itemisation
 * the budget's investing line carries the same pair, and these fields edit
 * that line in place — one pair per line in the rare budget holding several.
 */
export function InvestingFields({
  expenses,
  update,
}: {
  expenses: ProfileExpenses;
  update: UpdateFn;
}) {
  const lines = expenses.lines ?? [];
  if (lines.length === 0) {
    return (
      <div className="card">
        <div className="row">
          <NumberField
            label="While working ($/mo)"
            value={expenses.investingMonthly}
            width={170}
            tip={INVESTING_HELP}
            onCommit={(v) =>
              update((p) => {
                p.expenses.investingMonthly = v ?? 0;
              })
            }
          />
          <NumberField
            label="After the last paycheck ($/mo)"
            allowEmpty
            placeholder="0"
            value={expenses.investingMonthlyRetired}
            width={210}
            tip={INVESTING_RETIRED_HELP}
            onCommit={(v) =>
              update((p) => {
                if (v == null) delete p.expenses.investingMonthlyRetired;
                else p.expenses.investingMonthlyRetired = v;
              })
            }
          />
        </div>
      </div>
    );
  }
  const investingLines = lines.filter((l) => l.category === 'investing');
  if (investingLines.length === 0) {
    // An itemised budget with no investing row: the first commit creates the
    // row, with an EXPLICIT 0 in the other cell — on a line, an absent retired
    // figure means "same as now" and would quietly carry the transfer thirty
    // years into retirement.
    const createWith = (mutate: (line: ExpenseLine) => void) =>
      update((p) => {
        const ls = p.expenses.lines ?? [];
        const line = { ...makeExpenseLine(ls, 'investing'), label: 'Investing / savings' };
        line.monthlyRetired = 0;
        mutate(line);
        p.expenses.lines = [...ls, line];
        // Same discipline as editLinesWith: every line write rewrites the
        // scalar cache, so the file and the run never disagree.
        applyDerivedStreams(p.expenses);
      });
    return (
      <div className="card">
        <div className="row">
          <NumberField
            label="While working ($/mo)"
            value={0}
            width={170}
            tip={INVESTING_HELP}
            onCommit={(v) =>
              createWith((line) => {
                line.monthlyNow = v ?? 0;
              })
            }
          />
          <NumberField
            label="After the last paycheck ($/mo)"
            value={0}
            width={210}
            tip={INVESTING_RETIRED_HELP}
            onCommit={(v) =>
              createWith((line) => {
                line.monthlyRetired = v ?? 0;
              })
            }
          />
        </div>
      </div>
    );
  }
  const editLine = (id: string, mutate: (line: ExpenseLine) => void) =>
    update((p) => {
      const line = (p.expenses.lines ?? []).find((l) => l.id === id);
      if (line === undefined) return;
      mutate(line);
      // Same discipline as editLinesWith: the scalar cache follows the lines.
      applyDerivedStreams(p.expenses);
    });
  return (
    <div className="card">
      {investingLines.map((line) => (
        <div key={line.id}>
          {investingLines.length > 1 ? (
            <div className="pair-head" style={{ marginBottom: 6 }}>
              {line.label}
            </div>
          ) : null}
          <div className="row">
            <NumberField
              label="While working ($/mo)"
              value={line.monthlyNow}
              width={170}
              tip={INVESTING_HELP}
              onCommit={(v) =>
                editLine(line.id, (l) => {
                  l.monthlyNow = v ?? 0;
                })
              }
            />
            <NumberField
              label="After the last paycheck ($/mo)"
              allowEmpty
              placeholder="same as now"
              value={line.monthlyRetired}
              width={210}
              tip={INVESTING_RETIRED_TIP}
              onCommit={(v) =>
                editLine(line.id, (l) => {
                  if (v == null) delete l.monthlyRetired;
                  else l.monthlyRetired = v;
                })
              }
            />
          </div>
        </div>
      ))}
    </div>
  );
}
