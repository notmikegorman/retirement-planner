/**
 * Holdings resolution: the pure math that turns (positions, stored quotes)
 * into the balance and allocation the engine consumes.
 *
 * This lives in shared/ because BOTH sides need the same arithmetic: the
 * server resolves the profile before a run or a search ever sees it
 * (dataStore.loadResolvedProfile), and the Profile UI prices the DRAFT the
 * user is editing — an unsaved holdings row must preview with exactly the
 * numbers a save-then-run would use, or the preview is a small lie.
 *
 * Nothing here fetches. Quotes arrive as data (quotes.json's shape), priced
 * whenever the user last pressed Refresh; a missing quote is REPORTED, never
 * guessed around, and the caller decides whether missing is fatal (a run) or
 * merely displayed (the editor, which shows the symbol and the fix).
 */
import type { AssetClass, AssetMix, DerivedAccountView, Profile, QuotesFile } from './types';

/**
 * Every symbol appearing in any account's holdings, unique and sorted — the
 * refresh route's default batch and the resolver's own iteration order.
 */
export function holdingsSymbols(profile: Profile): string[] {
  const out = new Set<string>();
  for (const account of profile.accounts) {
    for (const h of account.holdings ?? []) out.add(h.symbol);
  }
  return [...out].sort();
}

/** A holdings-mode account: the field is present, even when the list is empty. */
export function isHoldingsAccount(account: Profile['accounts'][number]): boolean {
  return account.holdings !== undefined;
}

/**
 * Derive one holdings-mode account's view from stored quotes. Pure and total:
 * a missing quote contributes 0 to the totals and lands in `missing`, so the
 * caller always gets a complete picture of what could and could not be priced.
 */
export function deriveAccount(
  account: Profile['accounts'][number],
  quotes: QuotesFile,
): DerivedAccountView {
  const cash = account.cash ?? 0;
  const missing: string[] = [];
  const byClass: Record<AssetClass, number> = { stocks: 0, bonds: 0, bills: cash };
  const holdings: DerivedAccountView['holdings'] = [];

  for (const h of account.holdings ?? []) {
    const quote = quotes[h.symbol];
    if (!quote) {
      if (!missing.includes(h.symbol)) missing.push(h.symbol);
      holdings.push({ ...h, price: null, asOf: null, value: 0 });
      continue;
    }
    const value = h.quantity * quote.price;
    byClass[h.assetClass] += value;
    holdings.push({ ...h, price: quote.price, asOf: quote.asOf, value });
  }

  const balance = byClass.stocks + byClass.bonds + byClass.bills;
  return {
    balance,
    allocation: mixFromValues(byClass, balance),
    cash,
    holdings,
    missing: missing.sort(),
  };
}

/**
 * Class values → weights. Bills takes the remainder (1 − stocks − bonds)
 * rather than its own division so the three ALWAYS sum to exactly 1 — the
 * profile schema refuses a mix off by more than 1e-6, and three independent
 * divisions of floating-point market values can miss that by just enough.
 *
 * The remainder can also land one ulp BELOW zero (stocks/total + bonds/total
 * rounds above 1 when cash is 0), and the schema holds every weight to
 * min(0) — so a Save that round-trips the derived mix would bounce on dust.
 * The true bills share is cash/total ≥ 0, so a negative remainder is never
 * information: the LARGER of the two sleeves (> 0.5, since together they
 * exceed 1) takes the remainder role instead, and bills is exactly 0.
 *
 * A zero total (an empty holdings list with no cash, or nothing priceable
 * yet) derives ALL-BILLS: the account holds nothing the market can move, and
 * a 0/0 mix would be NaN wearing an allocation.
 */
function mixFromValues(byClass: Record<AssetClass, number>, total: number): AssetMix {
  if (total <= 0) return { stocks: 0, bonds: 0, bills: 1 };
  const stocks = byClass.stocks / total;
  const bonds = byClass.bonds / total;
  const bills = 1 - stocks - bonds;
  if (bills < 0) {
    return stocks >= bonds
      ? { stocks: 1 - bonds, bonds, bills: 0 }
      : { stocks, bonds: 1 - stocks, bills: 0 };
  }
  return { stocks, bonds, bills };
}

/** What resolveAccounts hands back: the priced profile plus the audit trail. */
export interface HoldingsResolution {
  /**
   * A CLONE of the profile with every holdings-mode account's balance and
   * allocation replaced by the derived figures. Accounts whose quotes are
   * incomplete are left on their stored (last-resolved) values — the caller
   * consults `missing` to decide whether that is an error or a display state.
   */
  profile: Profile;
  /** Derived views for the holdings-mode accounts, keyed by account id. */
  derived: Record<string, DerivedAccountView>;
  /** Every symbol with no stored quote, across all accounts. Sorted, unique. */
  missing: string[];
}

/**
 * Resolve a profile against stored quotes. Manual accounts pass through
 * untouched — ABSENT holdings means the account behaves exactly as it always
 * has, which is the contract that lets the 401(k) and Savings stay manual
 * while the IRA goes holdings-mode.
 *
 * An account with ANY missing quote keeps its stored balance/allocation
 * whole rather than taking a partial reprice: half-derived numbers (two of
 * three funds priced) would move the balance to something that is neither
 * yesterday's truth nor today's, and nothing on screen could say which.
 */
export function resolveAccounts(profile: Profile, quotes: QuotesFile): HoldingsResolution {
  const out = structuredClone(profile);
  const derived: Record<string, DerivedAccountView> = {};
  const missing = new Set<string>();

  for (const account of out.accounts) {
    if (!isHoldingsAccount(account)) continue;
    const view = deriveAccount(account, quotes);
    derived[account.id] = view;
    for (const s of view.missing) missing.add(s);
    if (view.missing.length === 0) {
      account.balance = view.balance;
      account.allocation = view.allocation;
    }
  }

  return { profile: out, derived, missing: [...missing].sort() };
}

/**
 * The one sentence a run failure shows for unpriced symbols. Shared so the
 * server route, the tests and any future surface say exactly the same thing —
 * including the fix, because an error that names only the problem sends the
 * user hunting for the button.
 */
export function missingQuotesMessage(missing: readonly string[]): string {
  const list = missing.join(', ');
  const noun = missing.length === 1 ? 'symbol has' : 'symbols have';
  return (
    `Cannot price the portfolio: ${missing.length === 1 ? '' : `${missing.length} `}` +
    `${noun} no stored quote (${list}). ` +
    'Refresh prices on the Profile tab (Accounts → Refresh prices), then run again. ' +
    'Runs never fetch prices themselves.'
  );
}
