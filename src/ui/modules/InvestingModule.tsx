/**
 * Investing — the budget's transfer into the brokerage (InvestingCard owns
 * the content; the worksheet deviation note in ExpensesModule.tsx covers
 * why these lines stay an in-place grid).
 */
import { InvestingCard } from '../components/profile/BudgetCard';
import { ProfileFormModule } from './ProfileFormModule';

export function InvestingModule() {
  return (
    <ProfileFormModule title="Investing">
      {(draft, doc) => <InvestingCard expenses={draft.expenses} update={doc.update} />}
    </ProfileFormModule>
  );
}
