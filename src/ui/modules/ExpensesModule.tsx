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
import { rentingWindowFromPlan } from '../components/profile/expensesLogic';
import { ProfileFormModule } from './ProfileFormModule';
import { usePlanFacts } from './usePlanFacts';

export function ExpensesModule() {
  const { planEvents, planHousing } = usePlanFacts();
  return (
    <ProfileFormModule title="Expenses">
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
