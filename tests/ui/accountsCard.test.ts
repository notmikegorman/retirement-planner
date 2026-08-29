/**
 * The Accounts card's narrow/wide split: the list column's arithmetic, the
 * selection that has to survive an edit, and a source scan for the fields the
 * restructure moved.
 *
 * The card is React, and these run under vitest's node environment, so the
 * split is the usual one in this repo (tests/ui/holdingsUi.test.ts, the score
 * chart's wiring scans): every decision that can be a pure function IS one and
 * is tested as one, and the wiring that hands those functions to JSX is read
 * out of the source. What that leaves uncovered is pixel placement — which is
 * what the stylesheet scan at the bottom is for.
 *
 * The three regressions worth this file:
 *
 * 1. TWO NUMBERS FOR ONE ACCOUNT. The list prints a balance for an account
 *    whose detail pane prints one too. For a holdings-mode account the pane's
 *    is derived from stored prices, and the stored `balance` beside it is a
 *    stale cache — reading the wrong one puts $1,284,502.66 in the list next
 *    to $1,221,542.76 in the pane, with nothing on screen to say which is the
 *    account's money.
 * 2. A TOTAL THAT WILL NOT ADD UP. Rounded rows summed from unrounded values
 *    print a total a penny away from the column above it.
 * 3. A SELECTION THAT SNAPS BACK. Every committed field rebuilds the profile;
 *    a selection held by index or by object identity would not survive it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Account, QuotesFile } from '../../src/shared/types';
import { deriveAccount } from '../../src/shared/holdings';
import { formatUSD } from '../../src/shared/util';
import {
  ACCOUNTS_TOTAL_LABEL,
  ACCOUNTS_TOTAL_TITLE,
  SELECTED_ACCOUNT_STORAGE_KEY,
  accountListBalance,
  accountMissingQuotes,
  accountsTotal,
  accountsTotalNote,
  formatListBalance,
  neighborAccountId,
  resolveSelectedAccountId,
} from '../../src/ui/components/profile/accountsLogic';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const accountsCard = read('../../src/ui/components/profile/AccountsCard.tsx');
const css = read('../../src/ui/styles.css');

/**
 * A representative five accounts, with the prices stored on the day this was
 * written. Fractional cents on purpose: the penny the total used to be out by
 * only appears at balances with real fractional cents in them, and inventing
 * round numbers would have hidden it.
 */
const QUOTES: QuotesFile = {
  VTI: {
    price: 379.99,
    currency: 'USD',
    asOf: '2026-08-19T20:00:00.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-20T11:14:22.211Z',
  },
  BND: {
    price: 72.56,
    currency: 'USD',
    asOf: '2026-08-19T20:00:01.000Z',
    source: 'yahoo',
    fetchedAt: '2026-08-20T11:14:22.015Z',
  },
};

const MIX = { stocks: 1, bonds: 0, bills: 0 };

function manual(id: string, name: string, balance: number): Account {
  return { id, name, type: 'savings', owner: 'p1', balance, allocation: MIX };
}

/** A holdings account whose stored `balance` is deliberately STALE. */
function ira(): Account {
  return {
    id: 'ira1',
    name: 'IRA',
    type: 'traditional_ira',
    owner: 'p1',
    balance: 1213880.4419, // last resolved, days ago — never what the row shows
    allocation: { stocks: 0.5569, bonds: 0.4431, bills: 0 },
    holdings: [
      { symbol: 'VTI', quantity: 1838.501, assetClass: 'stocks' },
      { symbol: 'BND', quantity: 7206, assetClass: 'bonds' },
    ],
    cash: 63.41,
  };
}

/** The five, in the order the profile lists them. */
function fiveAccounts(): Account[] {
  return [
    { ...manual('k401', '401(k)', 162431.09), type: '401k' },
    ira(),
    {
      id: 'roth1',
      name: 'Roth IRA',
      type: 'roth_ira',
      owner: 'p2',
      balance: 96200,
      allocation: MIX,
      holdings: [{ symbol: 'VTI', quantity: 234, assetClass: 'stocks' }],
      cash: 542.26,
    },
    {
      id: 'brokerage',
      name: 'Brokerage',
      type: 'taxable_brokerage',
      owner: 'p1',
      balance: 71500,
      allocation: MIX,
      holdings: [{ symbol: 'VTI', quantity: 176.803, assetClass: 'stocks' }],
      cash: 0,
    },
    manual('savings', 'Savings', 31400.18),
  ];
}

describe('accountListBalance — one number per account, and the pane prints the same one', () => {
  it('takes a manual account at the balance typed into it', () => {
    expect(accountListBalance(manual('savings', 'Savings', 31400.18), QUOTES)).toBe(31400.18);
  });

  it('DERIVES a holdings account, ignoring the stale stored balance', () => {
    // 1838.501 × 379.99 + 7206 × 72.56 + 63.41, hand-computed.
    const expected = 1838.501 * 379.99 + 7206 * 72.56 + 63.41;
    expect(accountListBalance(ira(), QUOTES)).toBeCloseTo(expected, 6);
    expect(accountListBalance(ira(), QUOTES)).toBeCloseTo(1221542.76499, 5);
    // The stored figure is 7 thousand dollars away — the exact size of the
    // disagreement a reader would have been left to referee.
    expect(accountListBalance(ira(), QUOTES)).not.toBe(ira().balance);
  });

  it('is the SAME call the detail pane makes, not a second implementation', () => {
    // HoldingsEditor renders deriveAccount(account, quotes).balance. Equality
    // here is the property "the list and the pane can never disagree" — an
    // approximation would let them drift by a cent and still pass.
    for (const account of fiveAccounts()) {
      const expected = account.holdings ? deriveAccount(account, QUOTES).balance : account.balance;
      expect(accountListBalance(account, QUOTES), account.id).toBe(expected);
    }
  });

  it('counts an unpriced symbol as $0, exactly as the pane does, and names it', () => {
    const account = ira();
    const noBnd: QuotesFile = { VTI: QUOTES.VTI! };
    expect(accountListBalance(account, noBnd)).toBe(deriveAccount(account, noBnd).balance);
    expect(accountListBalance(account, noBnd)).toBeCloseTo(1838.501 * 379.99 + 63.41, 6);
    // Named, because a balance short by a whole bond position looks like a
    // balance. ABSENT is reported, never smoothed into the number.
    expect(accountMissingQuotes(account, noBnd)).toEqual(['BND']);
  });

  it('does not flag a half-typed holding row as unpriced', () => {
    // "+ Add holding" seeds an empty symbol; that is an unfinished row, not a
    // position nobody priced, and the flag must not fire on it.
    const account: Account = {
      ...ira(),
      holdings: [{ symbol: '', quantity: 1, assetClass: 'stocks' }],
    };
    expect(accountMissingQuotes(account, QUOTES)).toEqual([]);
  });

  it('reports nothing missing for a manual account', () => {
    expect(accountMissingQuotes(manual('savings', 'Savings', 1), {})).toEqual([]);
  });
});

describe('accountsTotal — the column adds up to the number under it', () => {
  it('is the sum of every listed account, derived and manual alike', () => {
    const accounts = fiveAccounts();
    const byHand =
      162431.09 +
      Math.round((1838.501 * 379.99 + 7206 * 72.56 + 63.41) * 100) / 100 +
      Math.round((234 * 379.99 + 542.26) * 100) / 100 +
      Math.round(176.803 * 379.99 * 100) / 100 +
      31400.18;
    expect(accountsTotal(accounts, QUOTES)).toBeCloseTo(byHand, 2);
  });

  it('EQUALS the printed rows added up — the penny that used to be missing', () => {
    // Summing the raw derived values put these five accounts at $1,572,017.33
    // over a column that adds by hand to $1,572,017.32. A total nobody can
    // check by adding the rows above it is not a total.
    const accounts = fiveAccounts();
    const rows = accounts.map((a) => formatListBalance(accountListBalance(a, QUOTES)));
    const handAdded = rows.reduce((sum, s) => sum + Math.round(Number(s.replace(/[$,]/g, '')) * 100), 0);
    expect(formatListBalance(accountsTotal(accounts, QUOTES))).toBe(
      formatUSD(handAdded / 100, { cents: true }),
    );
    expect(formatListBalance(accountsTotal(accounts, QUOTES))).toBe('$1,572,017.32');
  });

  it('moves with the prices, because most of the total is derived', () => {
    const accounts = fiveAccounts();
    const cheaper: QuotesFile = { ...QUOTES, VTI: { ...QUOTES.VTI!, price: 279.99 } };
    // 2249.304 VTI shares across three accounts × $100 less.
    expect(accountsTotal(accounts, QUOTES) - accountsTotal(accounts, cheaper)).toBeCloseTo(
      (1838.501 + 234 + 176.803) * 100,
      2,
    );
  });

  it('is 0 for no accounts — and the card renders no total at all there', () => {
    expect(accountsTotal([], QUOTES)).toBe(0);
    expect(accountsCard).toMatch(/accounts\.length > 0 \? \(/);
  });
});

describe('the total says what it counts, so it cannot be read as net worth', () => {
  it('is not labelled "Total" or "Net worth"', () => {
    // The Net Worth page's total is these accounts PLUS the home MINUS the
    // mortgage. Two totals under one word, on two screens, is the whole bug.
    expect(ACCOUNTS_TOTAL_LABEL).toBe('All accounts');
    expect(ACCOUNTS_TOTAL_LABEL.toLowerCase()).not.toContain('net worth');
    expect(ACCOUNTS_TOTAL_LABEL).not.toBe('Total');
  });

  it('names what it leaves out, and where that other total lives', () => {
    const note = accountsTotalNote(fiveAccounts(), QUOTES);
    expect(note).toContain('accounts only');
    expect(note).toContain('home');
    expect(note).toContain('Net Worth page');
    // The count is stated, so the reader can see the sum covers every row.
    expect(note).toContain('5 balances');
    expect(ACCOUNTS_TOTAL_TITLE).toContain('not net worth');
  });

  it('describes the OTHER total the way that page actually computes it', () => {
    // networthStore builds a snapshot as `total: portfolio + input.homeValue`.
    // No mortgage is subtracted anywhere in it — and the user's home carries
    // none either. Promising a subtraction that never happens sends the reader
    // to the Net Worth page hunting for a term that is not there, which is the
    // confusion this note exists to end. If that total ever grows a mortgage
    // term, this test is the thing that says so out loud.
    const note = accountsTotalNote(fiveAccounts(), QUOTES);
    expect(note.toLowerCase()).not.toContain('mortgage');
    expect(ACCOUNTS_TOTAL_TITLE.toLowerCase()).not.toContain('mortgage');
    expect(
      readFileSync(
        // The store logic moved to src/store in Phase 3 of the browser port;
        // the pin follows the code that actually computes the total.
        fileURLToPath(new URL('../../src/store/networthStore.ts', import.meta.url)),
        'utf8',
      ),
    ).toContain('total: portfolio + input.homeValue');
  });

  it('says "1 balance" for one account rather than "1 balances"', () => {
    expect(accountsTotalNote([manual('a', 'A', 1)], QUOTES)).toContain('1 balance above');
  });

  it('confesses when an unpriced symbol is counted as $0 inside it', () => {
    const note = accountsTotalNote(fiveAccounts(), { VTI: QUOTES.VTI! });
    expect(note).toContain('BND');
    expect(note).toContain('$0');
    expect(note).toContain('Refresh prices');
    // Only when it is true: a fully priced set gets no such clause.
    expect(accountsTotalNote(fiveAccounts(), QUOTES)).not.toContain('$0');
  });
});

describe('resolveSelectedAccountId — always exactly one account, whatever was stored', () => {
  const accounts = fiveAccounts();

  it('opens on the first account when nothing was remembered', () => {
    expect(resolveSelectedAccountId(null, accounts)).toBe('k401');
    expect(resolveSelectedAccountId(undefined, accounts)).toBe('k401');
  });

  it('reopens the remembered account', () => {
    expect(resolveSelectedAccountId('brokerage', accounts)).toBe('brokerage');
  });

  it('SURVIVES AN EDIT to the selected account', () => {
    // What `update` actually does: structuredClone the profile and mutate it,
    // so every account object is new and the array is new. Renaming the Roth
    // and reordering around it must leave the Roth selected — a selection held
    // by index or by object identity would have moved to another account here.
    const edited = accounts.map((a) => ({ ...a, name: `${a.name} ` }));
    const reordered = [edited[2]!, ...edited.filter((_, i) => i !== 2)];
    expect(resolveSelectedAccountId('roth1', edited)).toBe('roth1');
    expect(resolveSelectedAccountId('roth1', reordered)).toBe('roth1');
  });

  it('falls back to the first account when the stored id is gone', () => {
    // Deleted account, a stored id from another data folder, junk in
    // localStorage: all the same answer, because all of them otherwise leave
    // an empty pane beside a full list.
    expect(resolveSelectedAccountId('deleted-last-week', accounts)).toBe('k401');
    expect(resolveSelectedAccountId('', accounts)).toBe('k401');
    const withoutRoth = accounts.filter((a) => a.id !== 'roth1');
    expect(resolveSelectedAccountId('roth1', withoutRoth)).toBe('k401');
  });

  it('answers null for an empty list rather than naming an account that is not there', () => {
    expect(resolveSelectedAccountId(null, [])).toBeNull();
    expect(resolveSelectedAccountId('k401', [])).toBeNull();
  });

  it('remembers the choice under the app\u2019s own key convention', () => {
    // 'fplan-' + what it holds, like nav.ts's 'fplan-profile-tab'.
    expect(SELECTED_ACCOUNT_STORAGE_KEY).toBe('fplan-profile-account');
    expect(SELECTED_ACCOUNT_STORAGE_KEY.startsWith('fplan-')).toBe(true);
  });
});

describe('neighborAccountId — deleting a row lands you beside it, not back at the top', () => {
  const accounts = fiveAccounts();

  it('moves up one when a middle row goes', () => {
    expect(neighborAccountId(accounts, 3)).toBe('roth1');
    expect(neighborAccountId(accounts, 1)).toBe('k401');
  });

  it('moves down when the FIRST row goes — there is nothing above it', () => {
    expect(neighborAccountId(accounts, 0)).toBe('ira1');
  });

  it('moves up when the last row goes', () => {
    expect(neighborAccountId(accounts, 4)).toBe('brokerage');
  });

  it('answers null when that was the only account', () => {
    expect(neighborAccountId([manual('only', 'Only', 1)], 0)).toBeNull();
  });
});

describe('the wiring (source scan)', () => {
  it('renders one row per account, keyed and selected by id', () => {
    expect(accountsCard).toMatch(/accounts\.map\(\(account\) => \{/);
    expect(accountsCard).toContain('key={account.id}');
    expect(accountsCard).toContain('const selected = account.id === selectedId;');
    // Selection is READ from the id every render, never stored as an index.
    expect(accountsCard).toContain('resolveSelectedAccountId(storedSelection, accounts)');
    expect(accountsCard).toContain("accounts.findIndex((a) => a.id === selectedId)");
  });

  it('prints the row balance through accountListBalance, never account.balance', () => {
    expect(accountsCard).toContain('accountListBalance(account, quotes)');
    // The row's JSX shows the name and that balance, and nothing else that
    // would compete with them for the eye.
    expect(accountsCard).toMatch(/<span className="acct-row-name"[\s\S]{0,120}accountDisplayName\(account\)/);
    expect(accountsCard).toMatch(/<span className="acct-row-balance">\{formatListBalance\(balance\)\}<\/span>/);
  });

  it('shows the detail pane for the SELECTED account only', () => {
    expect(accountsCard).toContain('account={accounts[selectedIndex]!}');
    expect(accountsCard).toContain('index={selectedIndex}');
    // Remounted per account: the number/symbol fields hold local text state,
    // so a shared instance would carry a half-typed balance across the switch.
    expect(accountsCard).toMatch(/key=\{accounts\[selectedIndex\]!\.id\}/);
  });

  it('selects the account it just added, so "+ Add account" visibly does something', () => {
    expect(accountsCard).toMatch(/const id = uniqueAccountId\(accounts\);/);
    expect(accountsCard).toMatch(/p\.accounts\.push\(\{ \.\.\.makeNewAccount\(p\), id \}\);/);
    expect(accountsCard).toMatch(/select\(id\);/);
  });

  it('moves the selection before deleting, not after', () => {
    expect(accountsCard).toMatch(/select\(neighborAccountId\(accounts, index\)\);/);
  });

  it('prices the list from the SAME quotes object the detail pane is handed', () => {
    // accountListBalance is only half the promise. The other half is upstream:
    // both children have to be reading one `quotes` state. Hand the list a
    // different source — `{}` while the pane keeps the loaded quotes — and the
    // row prints an IRA of $63.41 beside a pane printing $1,221,542.76, with
    // every pure test in this file still green. That is the two-numbers-for-one
    // -account defect the card was rebuilt to remove, arriving through the prop
    // instead of the function.
    expect(accountsCard).toMatch(/<AccountList[^>]*\bquotes=\{quotes\}/);
    expect(accountsCard).toMatch(/<AccountDetail[^>]*\bquotes=\{quotes\}/);
  });

  it('prints the TOTAL through accountsTotal, over the label the module names', () => {
    // The three unit-tested decisions about the total — its value, its label,
    // its note — are worth nothing if the JSX prints something else. Each of
    // these was a mutation that survived the pure tests: a hand-typed "Total"
    // over the column, a figure taken from somewhere other than accountsTotal,
    // and the accounts-only note deleted from the markup while the string
    // function that builds it stayed passing.
    expect(accountsCard).toContain('<span>{ACCOUNTS_TOTAL_LABEL}</span>');
    expect(accountsCard).toMatch(/\{formatListBalance\(accountsTotal\(accounts, quotes\)\)\}/);
    expect(accountsCard).toContain('title={ACCOUNTS_TOTAL_TITLE}');
  });

  it('renders the accounts-only note under the total, where the reader is', () => {
    expect(accountsCard).toMatch(
      /<div className="field-help">\{accountsTotalNote\(accounts, quotes\)\}<\/div>/,
    );
  });

  it('is wired as the vertical tab strip it behaves like', () => {
    expect(accountsCard).toContain('role="tablist"');
    expect(accountsCard).toContain('aria-orientation="vertical"');
    expect(accountsCard).toContain('aria-selected={selected}');
    expect(accountsCard).toContain('role="tabpanel"');
    // The app's existing "you are here" class, not a new highlight.
    expect(accountsCard).toContain("selected ? 'acct-row is-active' : 'acct-row'");
  });
});

/**
 * NOTHING WAS LOST IN THE MOVE.
 *
 * The restructure took a component that rendered every field of every account
 * and made it render every field of ONE account. That is exactly the change
 * where a conditional branch quietly fails to come along, and the loss is
 * invisible: an account type whose editor no longer appears looks like an
 * account type that never had one.
 *
 * So this is the inventory of what the old full-width AccountRow rendered,
 * asserted as still present. A scan, not a render: what it protects against is
 * a field being DELETED, and a deleted field cannot hide from a text search.
 */
describe('every field the old account row rendered is still in the detail pane', () => {
  const FIELDS: ReadonlyArray<readonly [string, string]> = [
    ['the account header name', 'accountDisplayName(account)'],
    ['the muted internal id', 'id: {account.id}'],
    ['the PLACEHOLDER chip', 'isPlaceholder(account.notes) ? <PlaceholderChip />'],
    ['Delete', 'className="danger" onClick={onDelete}'],
    ['Name', 'label="Name"'],
    ['Type', 'options={ACCOUNT_TYPE_OPTIONS}'],
    ['Owner (with the joint-ownership rule)', 'options={ownerOptions(people, account.type)}'],
    ['the manual Balance box', 'label="Balance ($)"'],
    ['Cost basis, on a taxable brokerage', 'label="Cost basis ($)"'],
    ['career contributions, on a pre-tax account', 'isPretaxAccount(account.type) ? ('],
    ['the holdings toggle', 'label="Track holdings (symbol × shares)"'],
    ['the holdings editor', '<HoldingsEditor'],
    ['a position\u2019s symbol', '<SymbolField'],
    ['a position\u2019s share count', 'label="Shares"'],
    ['a position\u2019s asset class', 'options={ASSET_CLASS_OPTIONS}'],
    ['the per-price as-of label', 'formatQuoteAsOf(quote.asOf)'],
    ['the no-quote flag', 'title={NO_QUOTE_TITLE}'],
    ['removing a position', "p.accounts[index].holdings!.splice(hi, 1)"],
    ['adding a position', '+ Add holding'],
    ['uninvested cash', 'label="Cash ($)"'],
    ['the derived balance and mix readout', 'formatDerivedMix(derived.allocation)'],
    ['the unpriced-symbols warning', 'unpriced — counted as $0 here'],
    ['Refresh prices', 'Refresh prices'],
    ['current employer, on a 401(k)', 'label="Current employer"'],
    ['the rollover note', '{ROLLOVER_NOTE}'],
    ['the target-date-fund toggle', 'label="This is a target-date fund"'],
    ['the target year', 'label="Target year"'],
    ['the Roth funding editor', '<RothFundingEditor'],
    ['Roth direct contributions', 'label="Direct contributions ($)"'],
    ['a Roth conversion year', 'label="Conversion year"'],
    ['a Roth conversion amount', 'label="Amount converted ($)"'],
    ['adding a conversion', '+ Add conversion'],
    ['the manual allocation editor', '<AllocationEditor'],
    ['Notes', 'label="Notes"'],
    ['+ Add account', '+ Add account'],
  ];

  for (const [what, needle] of FIELDS) {
    it(`still renders ${what}`, () => {
      expect(accountsCard).toContain(needle);
    });
  }

  it('keeps each editor behind the condition that always gated it', () => {
    // Holdings mode still hides the two manual editors, pre-tax still gates
    // the contributions box, and the type-specific blocks still ask the type.
    expect(accountsCard).toContain('canBeTargetDateFund(account.type)');
    expect(accountsCard).toContain("account.type === 'roth_ira' ? (");
    expect(accountsCard).toContain("account.type === '401k' ? (");
    expect(accountsCard).toContain("account.type === 'taxable_brokerage' ? (");
    expect(accountsCard).toContain('{isHoldings ? (');
  });
});

describe('the layout (src/ui/styles.css)', () => {
  /** The body of the first rule whose selector matches (tests/ui/fieldSpacing.test.ts). */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[,}]|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
    const m = re.exec(css);
    expect(m, `no CSS rule found for "${selector}"`).not.toBeNull();
    return m![2];
  }

  it('is the .wb-layout split: a floor on the narrow side, clipping on the wide one', () => {
    const body = ruleBody('.acct-layout');
    // minmax(0, …) on the results side is what keeps wide content inside its
    // own box instead of widening the grid and scrolling the page sideways.
    expect(body).toMatch(/grid-template-columns:\s*minmax\(260px,\s*1fr\)\s*minmax\(0,\s*2fr\)/);
  });

  it('stacks rather than crushing the editor on a small window', () => {
    // .wb-layout can let its wide column give way because that column is a
    // scroller. This one is a form, so below the breakpoint the columns stack.
    const media = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(media, 'no small-window rule for the accounts layout').not.toBeNull();
    expect(media![1]).toContain('.acct-layout');
    expect(media![1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    // And the list unpins, or it would cover the fields being edited.
    expect(media![1]).toMatch(/\.acct-list-col \{\s*position: static;/);
  });

  it('marks the selected row with the marks this app already uses', () => {
    // .nav-btn.active's accent-soft fill, .tab.is-active's inset accent edge —
    // turned to the leading edge for a strip that runs down the page.
    const body = ruleBody('.acct-row.is-active');
    expect(body).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(body).toMatch(/color:\s*var\(--accent\)/);
    expect(body).toMatch(/box-shadow:\s*inset 2px 0 0 var\(--accent\)/);
    expect(ruleBody('.nav-btn.active')).toMatch(/background:\s*var\(--accent-soft\)/);
  });

  it('keeps the total visible while a long list scrolls under it', () => {
    // The scroller is the list; the total sits outside it in the sticky column.
    expect(ruleBody('.acct-list')).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody('.acct-list-col')).toMatch(/position:\s*sticky/);
    expect(ruleBody('.acct-total')).not.toMatch(/overflow/);
  });

  it('truncates a long account name, never its balance', () => {
    // "$1,284,50…" is a wrong number; "Alex's 401(k) rollo…" is still the
    // account you meant.
    expect(ruleBody('.acct-row-name')).toMatch(/text-overflow:\s*ellipsis/);
    expect(ruleBody('.acct-row-balance')).toMatch(/white-space:\s*nowrap/);
    expect(ruleBody('.acct-row-balance')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
