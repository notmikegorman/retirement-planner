/**
 * Expenses — the living half of the budget (BudgetCard owns the two modes:
 * three scalar streams before itemisation, the itemised table after).
 *
 * DELIBERATE DEVIATION from the managed-table standard, recorded here: the
 * itemised budget is an ordered WORKSHEET — rows carry a hand-chosen order
 * (move up/down), a totals footer, and per-cell inherited placeholders —
 * not a collection of records to sort and click into. Sorting it would
 * destroy the order the owner arranged, and a per-line detail page would
 * turn transcribing a budget into forty page visits. It stays an in-place
 * editable grid inside the module's one view/edit form.
 */
import { BudgetCard } from '../components/profile/BudgetCard';
import {
  applyDerivedStreams,
  makeExpenseLine,
  rentingWindowFromPlan,
} from '../components/profile/expensesLogic';
import { IntroModal } from './IntroModal';
import { ProfileFormModule } from './ProfileFormModule';
import { usePlanFacts } from './usePlanFacts';

/**
 * The table's two ground rules used to sit above it as a preamble; the owner
 * moved them into the FIRST-VISIT modal (2026-08-30) so the page itself is
 * just the table. IntroModal.tsx carries the modal rules and the flag's
 * not-cleared-by-File-New reasoning.
 */
const INTRO_SEEN_KEY = 'fplan-expenses-intro-seen';

export function ExpensesModule() {
  const { planEvents, planHousing } = usePlanFacts();
  return (
    <ProfileFormModule
      title="Expenses"
      /*
        Outside the fieldset (its button must work in view mode), and only
        over the itemised table — the rules it states are the table's. The
        scalar-streams empty state explains itself field by field.
      */
      after={(draft) =>
        (draft.expenses.lines ?? []).length > 0 ? (
          <IntroModal title="About this table" storageKey={INTRO_SEEN_KEY}>
            <p>
              Every figure is $/month in <strong>today’s dollars</strong> — the plan inflates
              them itself, so never type a future number.
            </p>
            <p>
              A blank cell in the last three columns is <strong>inherited</strong> — it shows the
              figure it inherits in grey italics, and typing over it makes the number yours.
            </p>
          </IntroModal>
        ) : null
      }
      /*
        The table standard's Add, in the banner — not a toolbar row, which
        held 32px of empty space above the table in view mode (the buttons
        hide but their row keeps its height so nothing jumps). Itemised
        only: before itemisation there is no table, and a first line created
        from here would quietly make the near-empty table the truth for the
        other streams (GivingFields notes the same hazard).
      */
      extraActions={(draft, doc) =>
        doc.editing && (draft.expenses.lines ?? []).length > 0 ? (
          <button
            // Same in-flight guard as the Cancel/Save beside it: a row added
            // between Save and the PUT resolving would mutate a draft the
            // write already captured, and view mode would show a phantom row.
            disabled={doc.saving}
            onClick={() =>
              doc.update((p) => {
                const lines = p.expenses.lines ?? [];
                p.expenses.lines = [...lines, makeExpenseLine(lines, 'living')];
                // The new row is zeros, so today this rewrites equal values —
                // but every line write runs it (editLinesWith's discipline),
                // because the paths that "cannot drift the cache" are the
                // ones that eventually do.
                applyDerivedStreams(p.expenses);
              })
            }
          >
            + Add row
          </button>
        ) : null
      }
    >
      {(draft, doc) => (
        <BudgetCard
          expenses={draft.expenses}
          update={doc.update}
          rentingWindow={rentingWindowFromPlan(planHousing, planEvents)}
        />
      )}
    </ProfileFormModule>
  );
}
