/**
 * THE SIMULATION GATE — whether this profile gives a simulation anything to
 * simulate, decided once, consumed by every surface that would otherwise
 * print a simulated figure (Workbench, Net Worth's snapshot button, the plan
 * History's scoring offers, Search).
 *
 * THE PREDICATE, precisely: `accounts.length === 0` gates; zero recorded
 * spending ANNOTATES. The reasoning, since this line is the whole design:
 *
 *   - ZERO ACCOUNTS GATES. Accounts are the substrate of the simulation —
 *     every simulated future is a story about balances being drawn down, and
 *     with no accounts there are no balances, so "94% of futures succeed" is
 *     a statement about a household that does not exist. A number like that
 *     is a fiction however it is captioned, so no number renders at all: the
 *     results area says what is missing and where to add it instead.
 *
 *   - ZERO SPENDING DOES NOT GATE — IT IS SAID BESIDE THE NUMBER. A household
 *     with accounts and no recorded expenses still simulates: its futures
 *     spend only what the law charges anyway (taxes; Medicare premiums from
 *     65), so the score is usually flattering — though those statutory
 *     charges can still sink a small balance, so the caption must not claim
 *     the plan cannot fail, and the verdict beside it may honestly say "No".
 *     Unlike the zero-account case the number is a true statement about the
 *     inputs as entered, and this app's rule for true-but-conditional numbers
 *     is that the number CARRIES its condition (the same rule as "Quick run ·
 *     1,000 paths" and the widow banner), not that it is withheld. Gating
 *     here would also break the first honest feedback moment a new user
 *     gets: add one account, watch the first simulation appear, read the
 *     caption telling you what it still assumes.
 *
 * Both facts are read through deriveExpenseStreams so an itemised budget and
 * the scalar streams cannot disagree about what "no recorded spending" means.
 *
 * Node-tested in tests/ui/firstRun.test.ts; the pages walkthrough drives the
 * real thing (zero-start setup → gated Workbench → first account → first
 * number, with the zero-spend caption on it).
 */
import type { Profile } from '../shared/types';
import { deriveExpenseStreams } from '../shared/expenses';

export type SimulationReadiness =
  /** No accounts: render the first-run state; start no simulation anywhere. */
  | { state: 'no-accounts' }
  /** Simulate; `zeroSpend` true means the score must carry that condition. */
  | { state: 'ready'; zeroSpend: boolean };

export function simulationReadiness(profile: Profile): SimulationReadiness {
  if (profile.accounts.length === 0) return { state: 'no-accounts' };
  const streams = deriveExpenseStreams(profile.expenses);
  const zeroSpend =
    streams.livingMonthly === 0 &&
    streams.charitableMonthly === 0 &&
    streams.investingMonthly === 0 &&
    (streams.livingMonthlyRetired ?? 0) === 0 &&
    (streams.investingMonthlyRetired ?? 0) === 0;
  return { state: 'ready', zeroSpend };
}

// ---------------------------------------------------------------------------
// The words each gated surface says — one place, so the walkthrough can pin
// them and no two pages can drift into different explanations of one state.
// ---------------------------------------------------------------------------

/** The Workbench results column's first-run state. */
export const FIRST_RUN_HEADLINE = 'Nothing to simulate yet';
export const FIRST_RUN_BODY =
  'Add your accounts on the Accounts page — the simulation starts when there is ' +
  'something to simulate. No number appears here before then, because a ' +
  'simulation of zero accounts would be a statement about a household that ' +
  'does not exist.';

/** Beside the number, whenever it was computed against $0/mo of spending. */
export const ZERO_SPEND_CONDITION =
  'Recorded spending is $0/month, so the only dollars any simulated future spends ' +
  'are the ones the law charges anyway — taxes, and Medicare premiums from 65. ' +
  'This number is a fact about the inputs as entered, not about your retirement; ' +
  'record your expenses on the Expenses page and it becomes one.';

/** Net Worth's snapshot affordance, gated. */
export const NET_WORTH_FIRST_RUN =
  'Add your accounts on the Accounts page first — a snapshot records their balances ' +
  'at today’s prices, and there is nothing to record yet.';

/** The Search page, gated whole: a search is thousands of simulations. */
export const SEARCH_FIRST_RUN =
  'Search sweeps your plan across thousands of simulations, and a simulation ' +
  'needs something to simulate. Add your accounts on the Accounts page first.';

/** The History tab's scoring offers, gated. */
export const HISTORY_FIRST_RUN =
  'Scoring waits until the profile has accounts — a version scored against zero ' +
  'accounts would record a number that was never true of any household.';
