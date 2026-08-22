/**
 * Holdings resolution math (src/shared/holdings.ts) — the pure function both
 * the server's run/search chokepoint and the profile editor's preview price
 * through, which is exactly why it is tested to the cent here:
 *
 * - balance = Σ quantity × stored price + cash, fractional shares included;
 * - the derived mix comes from per-class market values and sums to EXACTLY 1
 *   (the profile schema's 1e-6 refine must never bounce a derived profile);
 * - a missing quote never guesses: the account keeps its stored figures whole,
 *   the symbol is reported, and the run-failure sentence names the fix;
 * - manual accounts pass through untouched — ABSENT holdings means the
 *   account behaves exactly as it always has.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveAccount,
  holdingsSymbols,
  isHoldingsAccount,
  missingQuotesMessage,
  resolveAccounts,
} from '../../src/shared/holdings';
import type { Account, Profile, QuotesFile } from '../../src/shared/types';

/** A quote with only the fields the math reads varying per test. */
function quote(price: number): QuotesFile[string] {
  return {
    price,
    currency: 'USD',
    asOf: '2026-08-18T20:00:00.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-18T21:00:00.000Z',
  };
}

function account(overrides: Partial<Account>): Account {
  return {
    id: 'acct',
    name: 'Account',
    type: 'traditional_ira',
    owner: 'p1',
    balance: 999_999,
    allocation: { stocks: 0.5, bonds: 0.5, bills: 0 },
    ...overrides,
  };
}

/** The smallest profile shape the resolver walks (accounts is all it reads). */
function profileWith(accounts: Account[]): Profile {
  return { accounts } as unknown as Profile;
}

describe('deriveAccount', () => {
  it('prices shares × quote + cash, fractional shares to the cent', () => {
    // A holdings-mode IRA: 1838.501 VTI + 7206 BND + $63.41 of sweep cash.
    const a = account({
      holdings: [
        { symbol: 'VTI', quantity: 1838.501, assetClass: 'stocks' },
        { symbol: 'BND', quantity: 7206, assetClass: 'bonds' },
      ],
      cash: 63.41,
    });
    const quotes: QuotesFile = { VTI: quote(379.04), BND: quote(72.1) };
    const d = deriveAccount(a, quotes);
    const vti = 1838.501 * 379.04;
    const bnd = 7206 * 72.1;
    expect(d.balance).toBeCloseTo(vti + bnd + 63.41, 6);
    expect(d.allocation.stocks).toBeCloseTo(vti / d.balance, 12);
    expect(d.allocation.bonds).toBeCloseTo(bnd / d.balance, 12);
    expect(d.missing).toEqual([]);
    expect(d.holdings[0]).toMatchObject({ symbol: 'VTI', price: 379.04, value: vti });
    expect(d.holdings[0].asOf).toBe('2026-08-18T20:00:00.000Z');
  });

  it('derives a mix that sums to EXACTLY 1, whatever the float dust', () => {
    // Three-way splits of awkward market values are where three independent
    // divisions drift past the schema's 1e-6 refine; bills-as-remainder
    // cannot. Property-style sweep over uneven prices and quantities.
    for (const [p1, p2, cash] of [
      [379.04, 72.1, 63.41],
      [0.07, 113.113, 0.01],
      [1234.5678, 9.99, 12345.67],
    ] as const) {
      const d = deriveAccount(
        account({
          holdings: [
            { symbol: 'A', quantity: 3333.333, assetClass: 'stocks' },
            { symbol: 'B', quantity: 7777.777, assetClass: 'bonds' },
          ],
          cash,
        }),
        { A: quote(p1), B: quote(p2) },
      );
      const sum = d.allocation.stocks + d.allocation.bonds + d.allocation.bills;
      expect(sum, `${p1}/${p2}/${cash}`).toBe(1);
    }
  });

  it('handles float dust in BOTH directions: uneven divisions, and a remainder below zero', () => {
    /*
     * 1750.001 × $379.04 stocks beside 5075.004 × $72.22 bonds is a real
     * witness pair (found by search over thousandth-share quantities): with
     * $61 cash, three INDEPENDENT divisions would sum to 0.9999999999999999 —
     * so this case fails if bills ever goes back to its own division — and
     * with NO cash the remainder 1 − stocks − bonds lands one ulp below zero.
     * The schema holds every weight to min(0), so a negative-dust bills would
     * bounce the very Save that round-trips the derived mix; the larger
     * sleeve must absorb the dust and bills must come out exactly 0.
     */
    const holdings = [
      { symbol: 'VTI', quantity: 1750.001, assetClass: 'stocks' as const },
      { symbol: 'BND', quantity: 5075.004, assetClass: 'bonds' as const },
    ];
    const quotes: QuotesFile = { VTI: quote(379.04), BND: quote(72.22) };

    const withCash = deriveAccount(account({ holdings, cash: 61 }), quotes).allocation;
    expect(withCash.stocks + withCash.bonds + withCash.bills).toBe(1);
    expect(withCash.bills).toBeGreaterThan(0);

    const noCash = deriveAccount(account({ holdings, cash: 0 }), quotes).allocation;
    expect(noCash.stocks + noCash.bonds + noCash.bills).toBe(1);
    expect(noCash.bills).toBe(0);
    expect(noCash.stocks).toBeGreaterThan(0);
    expect(noCash.bonds).toBeGreaterThan(0);
  });

  it('counts cash as bills, and an all-cash account as pure bills', () => {
    const d = deriveAccount(account({ holdings: [], cash: 5000 }), {});
    expect(d.balance).toBe(5000);
    expect(d.allocation).toEqual({ stocks: 0, bonds: 0, bills: 1 });
    expect(d.missing).toEqual([]);
  });

  it('derives all-bills for a zero total rather than a NaN mix', () => {
    const d = deriveAccount(account({ holdings: [], cash: 0 }), {});
    expect(d.balance).toBe(0);
    expect(d.allocation).toEqual({ stocks: 0, bonds: 0, bills: 1 });
  });

  it('reports a missing quote instead of guessing, valuing the row at 0', () => {
    const a = account({
      holdings: [
        { symbol: 'VTI', quantity: 10, assetClass: 'stocks' },
        { symbol: 'GHOST', quantity: 5, assetClass: 'bonds' },
      ],
      cash: 0,
    });
    const d = deriveAccount(a, { VTI: quote(100) });
    expect(d.missing).toEqual(['GHOST']);
    const ghost = d.holdings.find((h) => h.symbol === 'GHOST')!;
    expect(ghost).toMatchObject({ price: null, asOf: null, value: 0 });
  });
});

describe('resolveAccounts', () => {
  const quotes: QuotesFile = { VTI: quote(379.04), BND: quote(72.1) };

  it('overwrites a holdings account and leaves manual accounts byte-identical', () => {
    const manual = account({ id: 'k401', balance: 162_400 });
    const holding = account({
      id: 'ira1',
      balance: 1, // a stale cache figure the derivation must replace
      holdings: [{ symbol: 'VTI', quantity: 100, assetClass: 'stocks' }],
      cash: 50,
    });
    const { profile, derived, missing } = resolveAccounts(profileWith([manual, holding]), quotes);
    expect(missing).toEqual([]);
    // Manual: untouched, including the allocation object's values.
    expect(profile.accounts[0]).toEqual(manual);
    // Holdings: balance and allocation replaced by the derivation.
    expect(profile.accounts[1].balance).toBeCloseTo(100 * 379.04 + 50, 6);
    expect(profile.accounts[1].allocation.bills).toBeCloseTo(50 / (100 * 379.04 + 50), 12);
    expect(derived.ira1.balance).toBe(profile.accounts[1].balance);
    // The input profile is never mutated — the resolver clones.
    expect(holding.balance).toBe(1);
  });

  it('keeps an unpriceable account on its stored figures WHOLE — no half-reprice', () => {
    /*
     * Two of three funds priced would move the balance to something that is
     * neither yesterday's truth nor today's; the resolver must keep the
     * stored cache intact and report the symbol instead.
     */
    const stale = account({
      id: 'ira1',
      balance: 921_544.31,
      allocation: { stocks: 0.5569, bonds: 0.4431, bills: 0 },
      holdings: [
        { symbol: 'VTI', quantity: 100, assetClass: 'stocks' },
        { symbol: 'GHOST', quantity: 5, assetClass: 'bonds' },
      ],
    });
    const { profile, missing } = resolveAccounts(profileWith([stale]), quotes);
    expect(missing).toEqual(['GHOST']);
    expect(profile.accounts[0].balance).toBe(921_544.31);
    expect(profile.accounts[0].allocation).toEqual({ stocks: 0.5569, bonds: 0.4431, bills: 0 });
  });

  it('aggregates missing symbols across accounts, sorted and unique', () => {
    const a = account({
      id: 'a',
      holdings: [{ symbol: 'ZZZ', quantity: 1, assetClass: 'stocks' }],
    });
    const b = account({
      id: 'b',
      type: 'roth_ira',
      holdings: [
        { symbol: 'AAA', quantity: 1, assetClass: 'stocks' },
        { symbol: 'ZZZ', quantity: 2, assetClass: 'stocks' },
      ],
    });
    expect(resolveAccounts(profileWith([a, b]), {}).missing).toEqual(['AAA', 'ZZZ']);
  });
});

describe('the vocabulary helpers', () => {
  it('holdingsSymbols walks every account, unique and sorted', () => {
    const p = profileWith([
      account({ id: 'a', holdings: [{ symbol: 'BND', quantity: 1, assetClass: 'bonds' }] }),
      account({
        id: 'b',
        holdings: [
          { symbol: 'VTI', quantity: 1, assetClass: 'stocks' },
          { symbol: 'BND', quantity: 9, assetClass: 'bonds' },
        ],
      }),
      account({ id: 'c' }),
    ]);
    expect(holdingsSymbols(p)).toEqual(['BND', 'VTI']);
  });

  it('isHoldingsAccount is presence, not emptiness — [] is holdings mode', () => {
    expect(isHoldingsAccount(account({}))).toBe(false);
    expect(isHoldingsAccount(account({ holdings: [] }))).toBe(true);
  });

  it('the missing-quotes sentence names the symbols AND the fix', () => {
    const msg = missingQuotesMessage(['BND', 'VTI']);
    expect(msg).toContain('BND, VTI');
    expect(msg).toContain('Refresh prices on the Profile tab');
    expect(msg).toContain('Runs never fetch');
    expect(missingQuotesMessage(['VTI'])).toContain('symbol has no stored quote (VTI)');
  });
});
