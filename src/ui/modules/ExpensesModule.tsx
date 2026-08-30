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
import { useEffect, useRef, useState } from 'react';
import { BudgetCard } from '../components/profile/BudgetCard';
import { rentingWindowFromPlan } from '../components/profile/expensesLogic';
import { ProfileFormModule } from './ProfileFormModule';
import { usePlanFacts } from './usePlanFacts';

/**
 * The table's two ground rules used to sit above it as a preamble; the owner
 * moved them into a FIRST-VISIT modal (2026-08-30) so the page itself is just
 * the table. The flag is browser-local UI memory like the remembered tabs —
 * and deliberately NOT cleared by File > New: "do not show this again" is a
 * statement about the reader, not the folder.
 */
const INTRO_SEEN_KEY = 'fplan-expenses-intro-seen';

function introSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_SEEN_KEY) !== null;
  } catch {
    // No storage means the choice cannot be remembered — showing the modal
    // on every visit would nag, so err on the quiet side.
    return true;
  }
}

/**
 * The intro, shown once per visit at most and never again once dismissed with
 * the box ticked. Same modal rules as ConfirmModal: no backdrop dismiss,
 * Escape closes (identically to the button — both honor the checkbox), focus
 * lands on the button so a reflexive Enter just closes it.
 */
function ExpensesIntro() {
  const [open, setOpen] = useState(() => !introSeen());
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const okRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) okRef.current?.focus();
  }, [open]);
  if (!open) return null;
  const close = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(INTRO_SEEN_KEY, '1');
      } catch {
        // Nothing to do: the modal still closes, and introSeen()'s own
        // failure branch keeps it from nagging.
      }
    }
    setOpen(false);
  };
  return (
    <div
      className="deleteConfirmOverlay"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div className="deleteConfirmPanel" role="dialog" aria-modal="true">
        <h3>About this table</h3>
        <p>
          Every figure is $/month in <strong>today’s dollars</strong> — the plan inflates them
          itself, so never type a future number.
        </p>
        <p>
          A blank cell in the last three columns is <strong>inherited</strong> — it shows the
          figure it inherits in grey italics, and typing over it makes the number yours.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 4px' }}>
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          Do not show this again
        </label>
        <div className="deleteConfirmActions">
          <button ref={okRef} type="button" className="primary" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

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
      after={(draft) => ((draft.expenses.lines ?? []).length > 0 ? <ExpensesIntro /> : null)}
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
