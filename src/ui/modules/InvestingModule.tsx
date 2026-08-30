/**
 * Investing — the budget's transfer into the brokerage, as the two numbers it
 * is (InvestingFields owns the content and the scalar-vs-line binding).
 */
import { InvestingFields } from '../components/profile/BudgetCard';
import { ProfileFormModule } from './ProfileFormModule';

export function InvestingModule() {
  return (
    <ProfileFormModule title="Investing">
      {(draft, doc) => <InvestingFields expenses={draft.expenses} update={doc.update} />}
    </ProfileFormModule>
  );
}
