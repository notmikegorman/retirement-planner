/**
 * The pure half of the Accounts card's two-column layout: which account is
 * showing, what each row's balance is, and what the column's total means.
 *
 * Kept free of React/DOM so it can be unit-tested under vitest's node
 * environment, like profileLogic beside it. The two questions here are the two
 * that can go wrong silently:
 *
 * 1. A LIST BALANCE THAT DISAGREES WITH THE DETAIL PANE. The narrow column
 *    shows a number for an account whose detail pane shows one too, and for a
 *    holdings-mode account the detail pane's is DERIVED (shares × stored price
 *    + cash). Reading `account.balance` for the row would show the IRA's last
 *    resolved figure beside a freshly derived one — two numbers for one
 *    account, on one screen, differing by whatever the market did since the
 *    last save. accountListBalance is the single answer both sides use.
 * 2. A SELECTION THAT MOVES UNDER THE USER. Selection is by account ID, never
 *    by index, so committing a field on the selected account — which rebuilds
 *    the accounts array — leaves the same account selected rather than
 *    snapping back to the first one.
 */
import type { Account, QuotesFile } from '../../../shared/types';
import { deriveAccount, isHoldingsAccount } from '../../../shared/holdings';
import { formatUSD } from '../../../shared/util';

/**
 * The balance for one account, as the account itself defines it: DERIVED for a
 * holdings-mode account, as-typed for a manual one.
 *
 * Deliberately the same call the detail pane's readout makes
 * (deriveAccount(account, quotes) — HoldingsEditor), on the same draft account
 * and the same stored quotes, so the row and the pane cannot print different
 * dollars. An unpriced symbol counts as $0 here exactly as it does there; the
 * row flags it rather than hiding the shortfall in a number that looks whole.
 */
export function accountListBalance(account: Account, quotes: QuotesFile): number {
  return isHoldingsAccount(account) ? deriveAccount(account, quotes).balance : account.balance;
}

/** Every symbol this account holds with no stored quote (empty for manual accounts). */
export function accountMissingQuotes(account: Account, quotes: QuotesFile): string[] {
  if (!isHoldingsAccount(account)) return [];
  // A just-added holding row has no symbol yet: that is an unfinished row, not
  // an unpriced position, and it must not raise the row's "unpriced" flag.
  return deriveAccount(account, quotes).missing.filter((s) => s !== '');
}

/**
 * One account's balance as the row PRINTS it: cents, and nothing finer.
 *
 * A derived balance is shares × price, so it carries fractions of a cent —
 * 1838.501 × $379.99 + 7206 × $72.56 + $63.41 is $1,221,542.76499. No account
 * holds half a cent, and the row cannot show it.
 */
function balanceAsPrinted(account: Account, quotes: QuotesFile): number {
  return Math.round(accountListBalance(account, quotes) * 100) / 100;
}

/**
 * The column's total: every listed account's balance, by the rule above.
 *
 * Summed from the ROUNDED figures — the ones the rows print — so the column
 * adds up to the number under it. Summing the raw values instead put a
 * five-account column at $1,572,017.33 above rows that add by hand to
 * $1,572,017.32, and a total that disagrees with its own rows by a penny is a
 * total nobody can check.
 */
export function accountsTotal(accounts: readonly Account[], quotes: QuotesFile): number {
  const sum = accounts.reduce((total, a) => total + balanceAsPrinted(a, quotes), 0);
  // The addition itself is binary floating point: five exact cent values do
  // not necessarily add to one. 162431.09 + 1221542.76 + 89459.92 + 67183.37 +
  // 30000.00 evaluates to 1570617.1400000001, not 1570617.14, so the sum is
  // rounded again on the way out.
  return Math.round(sum * 100) / 100;
}

/**
 * The total's label.
 *
 * NOT "Total", and never "Net worth". The Net Worth page's total is these
 * accounts PLUS the home value MINUS the mortgage, and it is a figure the
 * same person reads on the same afternoon as this one. Two totals a few hundred
 * thousand dollars apart, both called "Total", on two screens of one app, is
 * the confusion this label exists to refuse — so it names its own contents
 * instead, and accountsTotalNote spells out what it leaves out.
 */
export const ACCOUNTS_TOTAL_LABEL = 'All accounts';

/**
 * The sentence under the total: what it counts, and what the other total on
 * the Net Worth page counts that this one does not.
 *
 * THE DIFFERENCE IS THE HOME, AND ONLY THE HOME. Say what that page actually
 * does, not what a net-worth figure conventionally does: networthStore builds
 * a snapshot's total as `portfolio + input.homeValue` — there is no mortgage
 * term in it at all, whatever the profile's home carries. A
 * sentence promising a subtraction that never happens sends the reader to the
 * Net Worth page to look for it, which is the confusion this line exists to
 * end rather than start. If a mortgage ever enters that total, this sentence
 * and ACCOUNTS_TOTAL_TITLE below change with it.
 *
 * The unpriced clause is the same honesty the row flags carry — a total that
 * silently counted an unpriced VTI position as $0 would read as a real sum of
 * real accounts, and be short by the whole position.
 */
export function accountsTotalNote(accounts: readonly Account[], quotes: QuotesFile): string {
  const n = accounts.length;
  const unpriced = [
    ...new Set(accounts.flatMap((a) => accountMissingQuotes(a, quotes))),
  ].sort();
  const base =
    `Sum of the ${n} ${n === 1 ? 'balance' : 'balances'} above — accounts only. ` +
    'The Net Worth page adds your home value on top of this; that is the bigger total.';
  if (unpriced.length === 0) return base;
  return (
    `${base} ${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no stored price ` +
    'and counts as $0 in this sum — press Refresh prices.'
  );
}

/**
 * The tooltip on the total. Says the same thing the note does, for the reader
 * who hovers the number rather than reading the line under it.
 */
export const ACCOUNTS_TOTAL_TITLE =
  'The listed accounts added up: holdings-mode accounts at their derived balance (shares × ' +
  'stored price + cash), manual accounts at the balance typed above. It is not net worth — ' +
  'the Net Worth page counts the home value on top of these accounts.';

/**
 * Where the chosen account id is remembered. Follows the app's key convention
 * ('fplan-' + what it holds — see nav.ts's PROFILE_TAB_STORAGE_KEY and
 * ScenarioPanel's 'fplan-inputs-tab').
 *
 * Persisting it at all is the same argument the profile TABS already won:
 * coming back to check one number on the Roth should not start at the 401(k)
 * every time. It also survives the remount ProfilePage forces on load/discard
 * (its `key={rev}`), which would otherwise silently reset the pane.
 */
export const SELECTED_ACCOUNT_STORAGE_KEY = 'fplan-profile-account';

/**
 * Which account the detail pane shows, given what was remembered.
 *
 * TOTAL BY DESIGN — every input produces a usable answer, because each way it
 * can fail leaves an empty pane beside a full list:
 *   - a remembered id that still exists wins;
 *   - anything else (nothing remembered, an account since deleted, a stored id
 *     from a different data folder, junk in localStorage) falls back to the
 *     first account, which is also the arrival case;
 *   - an empty list answers null, and the pane says so rather than rendering
 *     an editor for an account that is not there.
 *
 * Resolving on every render rather than repairing state in an effect is what
 * makes deletion self-healing: the id vanishes from the list and the next
 * render has already moved on.
 */
export function resolveSelectedAccountId(
  storedId: string | null | undefined,
  accounts: readonly Account[],
): string | null {
  if (accounts.length === 0) return null;
  if (storedId != null && accounts.some((a) => a.id === storedId)) return storedId;
  return accounts[0]!.id;
}

/**
 * Who to select after deleting the account at `index`: the one above it, or —
 * when the first row is deleted — the one below.
 *
 * Without this, deleting the fourth of five accounts drops the selection to
 * the first (resolveSelectedAccountId's fallback) and the pane jumps to the
 * top of the list, which reads as if the wrong row was deleted. Returns null
 * when that was the last account, and the pane goes empty honestly.
 */
export function neighborAccountId(accounts: readonly Account[], index: number): string | null {
  const rest = accounts.filter((_, i) => i !== index);
  if (rest.length === 0) return null;
  return rest[Math.max(0, Math.min(index - 1, rest.length - 1))]!.id;
}

/** A row's money string. Cents, because the detail pane prints cents too. */
export function formatListBalance(value: number): string {
  return formatUSD(value, { cents: true });
}
