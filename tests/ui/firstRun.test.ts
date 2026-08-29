/**
 * ZERO-START'S GATE (src/ui/firstRun.ts): the one predicate every results
 * surface consults before printing a simulated figure. The two-tier design is
 * the thing under test — zero accounts GATES (no number renders at all; a
 * 0-account simulation describes a household that does not exist), zero
 * recorded spending ANNOTATES (the number renders carrying its condition) —
 * plus the rule that an itemised budget and the scalar streams cannot
 * disagree about what "no recorded spending" means.
 */
import { describe, expect, it } from 'vitest';
import type { Profile } from '../../src/shared/types';
import { buildInitialProfile } from '../../src/shared/setupProfile';
import { simulationReadiness } from '../../src/ui/firstRun';

/** The minimal zero-start profile, mutated per case — the shape setup writes. */
function fresh(): Profile {
  return buildInitialProfile({
    person1: { name: 'Riley', birthYear: 1980, birthMonth: 6 },
    person2: null,
    state: 'nc',
    year: 2026,
  });
}

const withAccount = (p: Profile): Profile => ({
  ...p,
  accounts: [
    {
      id: 'sav1',
      name: 'Savings',
      type: 'savings',
      owner: 'p1',
      balance: 50_000,
      allocation: { stocks: 0, bonds: 0, bills: 1 },
    },
  ],
});

describe('simulationReadiness', () => {
  it('gates on zero accounts — the floor, whatever else is filled in', () => {
    expect(simulationReadiness(fresh())).toEqual({ state: 'no-accounts' });
    // Even a profile with real spending recorded gates without accounts:
    // there is still nothing for a simulated future to draw the money from.
    const spending = fresh();
    spending.expenses = { ...spending.expenses, livingMonthly: 6000 };
    expect(simulationReadiness(spending)).toEqual({ state: 'no-accounts' });
  });

  it('one account opens the gate — and a zero-spend profile says so beside the number', () => {
    expect(simulationReadiness(withAccount(fresh()))).toEqual({
      state: 'ready',
      zeroSpend: true,
    });
  });

  it('any recorded stream clears the zero-spend condition', () => {
    for (const field of ['livingMonthly', 'charitableMonthly', 'investingMonthly'] as const) {
      const p = withAccount(fresh());
      p.expenses = { ...p.expenses, [field]: 100 };
      expect(simulationReadiness(p)).toEqual({ state: 'ready', zeroSpend: false });
    }
  });

  it('a retired-side stream alone clears it too — retirement spending IS spending', () => {
    const p = withAccount(fresh());
    p.expenses = { ...p.expenses, livingMonthlyRetired: 4000 };
    expect(simulationReadiness(p)).toEqual({ state: 'ready', zeroSpend: false });
    const q = withAccount(fresh());
    q.expenses = { ...q.expenses, investingMonthlyRetired: 250 };
    expect(simulationReadiness(q)).toEqual({ state: 'ready', zeroSpend: false });
  });

  it('reads spending through the derived streams, so a budget and the scalars cannot disagree', () => {
    // Scalars say zero but an itemised budget records real lines: the budget
    // wins (deriveExpenseStreams), so this is NOT zero-spend.
    const p = withAccount(fresh());
    p.expenses = {
      ...p.expenses,
      lines: [{ id: 'groceries', label: 'Groceries', category: 'living', monthlyNow: 800 }],
    };
    expect(simulationReadiness(p)).toEqual({ state: 'ready', zeroSpend: false });

    // A budget of only non-summed categories derives zeros — still zero-spend,
    // exactly as the engine will simulate it.
    const q = withAccount(fresh());
    q.expenses = {
      ...q.expenses,
      lines: [{ id: 'ins', label: 'Term life', category: 'insurance', monthlyNow: 90 }],
    };
    expect(simulationReadiness(q)).toEqual({ state: 'ready', zeroSpend: true });
  });
});
