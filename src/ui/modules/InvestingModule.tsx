/**
 * Investing — the budget's transfer into the brokerage, as the two numbers it
 * is (InvestingFields owns the content and the scalar-vs-line binding), plus
 * the "What the bonds are" dial (the owner's relocation, 2026-08-30 — it
 * lived on the Plan page, twice, through its two-door era).
 */
import { useEffect, useState } from 'react';
import type { AssumptionOverrides, Scenario } from '../../shared/types';
import { api } from '../api';
import { InvestingFields } from '../components/profile/BudgetCard';
import { BondsAreSelect } from '../components/scenarios/BondsAreSelect';
import { awaitPendingPlanSave, chainPlanWrite } from '../pages/WorkbenchPage';
import { ProfileFormModule } from './ProfileFormModule';

/**
 * The bond-composition dial, editing the PLAN (assumption_overrides), not
 * the profile — which is why it sits OUTSIDE the module's view/edit form as
 * an always-active card with the Plan page's own semantics: every change
 * saves itself, no Save button. Get-mutate-put: the loaded plan is mutated
 * and PUT whole, optimistically, with the error surfaced if the write fails.
 */
function BondsCard() {
  const [plan, setPlan] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Behind the workbench's pending-flush gate: fetching before an
    // in-flight autosave lands would seed this card with the PRE-edit plan,
    // and the whole-plan PUT below would then resurrect it.
    awaitPendingPlanSave()
      .then(() => api.getPlan())
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const onChange = (assumption_overrides: AssumptionOverrides | undefined) => {
    if (plan === null) return;
    const next = { ...plan, assumption_overrides };
    setPlan(next);
    setError(null);
    // Chained, not fire-and-forget: chainPlanWrite orders this PUT after any
    // pending plan write and REGISTERS it as the pending write, so two quick
    // flips land in order and the Plan page's next load waits for the last
    // one instead of reading a file this write is about to change.
    chainPlanWrite(() => api.putPlan(next)).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>What the bonds are</h2>
      {error !== null ? (
        <div className="error-banner">The plan could not be written: {error}</div>
      ) : null}
      {plan === null && error === null ? (
        <div className="muted">Loading…</div>
      ) : plan !== null ? (
        <BondsAreSelect overrides={plan.assumption_overrides} onChange={onChange} />
      ) : null}
    </div>
  );
}

export function InvestingModule() {
  return (
    <ProfileFormModule title="Investing" after={<BondsCard />}>
      {(draft, doc) => <InvestingFields expenses={draft.expenses} update={doc.update} />}
    </ProfileFormModule>
  );
}
