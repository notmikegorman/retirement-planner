/**
 * The Accounts module's arithmetic and wiring: the table's row balances, the
 * total that must add up, and a source scan for the fields the managed-table
 * restructure moved (2026-08-30: the two-column card became /accounts — a
 * sortable table — and /accounts/<id> — a view/edit detail).
 *
 * The module is React, and these run under vitest's node environment, so the
 * split is the usual one in this repo (tests/ui/holdingsUi.test.ts, the score
 * chart's wiring scans): every decision that can be a pure function IS one and
 * is tested as one, and the wiring that hands those functions to JSX is read
 * out of the source. What that leaves uncovered is pixel placement — which is
 * what the stylesheet scan at the bottom is for.
 *
 * The two regressions worth this file:
 *
 * 1. TWO NUMBERS FOR ONE ACCOUNT. The table prints a balance for an account
 *    whose detail prints one too. For a holdings-mode account the detail's
 *    is derived from stored prices, and the stored `balance` beside it is a
 *    stale cache — reading the wrong one puts $1,284,502.66 in the table next
 *    to $1,221,542.76 in the detail, with nothing on screen to say which is
 *    the account's money.
 * 2. A TOTAL THAT WILL NOT ADD UP. Rounded rows summed from unrounded values
 *    print a total a penny away from the column above it.
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
  accountListBalance,
  accountMissingQuotes,
  accountsTotal,
  formatListBalance,
} from '../../src/ui/components/profile/accountsLogic';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const accountsModule = read('../../src/ui/modules/AccountsModule.tsx');
const accountEditor = read('../../src/ui/components/profile/AccountEditor.tsx');
const managedTable = read('../../src/ui/modules/ManagedTable.tsx');
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

  it('is 0 for no accounts — and the module renders no table at all there', () => {
    expect(accountsTotal([], QUOTES)).toBe(0);
    expect(accountsModule).toMatch(/accounts\.length === 0 \? \(/);
  });
});

describe('the total says what it counts, so it cannot be read as net worth', () => {
  it('is not labelled "Total" or "Net worth"', () => {
    // The Net Worth page's total is these accounts PLUS the home. Two totals
    // under one word, on two screens of one app, is the whole bug. (The
    // sentence that used to spell this out under the table retired as
    // unnecessary commentary, 2026-08-30 — the label and the hover title
    // carry the distinction now.)
    expect(ACCOUNTS_TOTAL_LABEL).toBe('All accounts');
    expect(ACCOUNTS_TOTAL_LABEL.toLowerCase()).not.toContain('net worth');
    expect(ACCOUNTS_TOTAL_LABEL).not.toBe('Total');
    expect(ACCOUNTS_TOTAL_TITLE).toContain('not net worth');
    expect(ACCOUNTS_TOTAL_TITLE.toLowerCase()).not.toContain('mortgage');
  });
});

describe('the wiring (source scan)', () => {
  it('prints the row balance through accountListBalance, never account.balance', () => {
    expect(accountsModule).toContain('accountListBalance(a, quotes)');
    expect(accountsModule).toContain('formatListBalance(accountListBalance(a, quotes))');
  });

  it('sorts the balance column by the same derived number it prints', () => {
    // A column sorted on the stale stored balance would order rows one way
    // and print them another.
    expect(accountsModule).toMatch(
      /key: 'balance',[\s\S]{0,120}sortValue: \(a\) => accountListBalance\(a, quotes\)/,
    );
  });

  it('flags an unpriced row where the number is', () => {
    expect(accountsModule).toContain('accountMissingQuotes(a, quotes)');
    expect(accountsModule).toContain('title={ROW_UNPRICED_TITLE}');
  });

  it('opens a row at its own URL, and returns to the table by the banner title', () => {
    expect(accountsModule).toContain("onOpen={(a) => navigate('accounts', a.id)}");
    // The explicit null matters: an omitted segment on the SAME page means
    // "keep the segment you are reading" (nav.ts's no-op rule), which would
    // make the breadcrumb a dead link on its own detail.
    expect(accountsModule).toContain("onTitleClick={() => navigate('accounts', null)}");
    expect(accountsModule).toContain('crumb={accountDisplayName(selected)}');
  });

  it('adds a DRAFT account and opens it in edit mode', () => {
    // Add is not a write: Save is. The id is decided outside the mutation so
    // the row that appears and the row that opens are the same by construction.
    expect(accountsModule).toMatch(/const id = uniqueAccountId\(accounts\);/);
    expect(accountsModule).toMatch(/p\.accounts\.push\(\{ \.\.\.makeNewAccount\(p\), id \}\);/);
    expect(accountsModule).toContain('doc.enterEdit();');
    expect(accountsModule).toContain("navigate('accounts', id);");
  });

  it('deletes through one immediate write, behind the confirm modal', () => {
    expect(accountsModule).toContain('doc.mutateAndSave((p) => {');
    expect(accountsModule).toMatch(/p\.accounts\.splice\(i, 1\);/);
    expect(accountsModule).toContain('deleteConfirm={(a) => ({');
    // The managed table owns the trashcan + modal; the detail has its own.
    expect(accountsModule).toContain('<ConfirmModal');
  });

  it('answers a dead record URL with the table, by replace', () => {
    expect(accountsModule).toContain("navigate('accounts', null, { replace: true });");
  });

  it('remounts the editor per account and per cancel', () => {
    // The number/symbol fields keep local text state: switching accounts or
    // cancelling an edit must not leave a half-typed balance behind.
    expect(accountsModule).toContain('key={`${doc.rev}:${selected.id}`}');
    expect(accountsModule).toContain('disabled={!doc.editing}');
  });

  it('prices the table and the editor from ONE quotes state', () => {
    // Hand them different sources and the row prints an IRA of $63.41 beside
    // a detail printing $1,221,542.76 — the two-numbers defect, arriving
    // through the prop instead of the function.
    expect(accountsModule).toMatch(/<AccountEditor[\s\S]{0,200}quotes=\{quotes\}/);
    expect(accountsModule.match(/useState<QuotesFile>\(\{\}\)/g)!.length).toBe(1);
  });

  it('prints the TOTAL through accountsTotal, over the label the logic names', () => {
    expect(accountsModule).toContain('{ACCOUNTS_TOTAL_LABEL}');
    expect(accountsModule).toMatch(/\{formatListBalance\(accountsTotal\(accounts, quotes\)\)\}/);
    expect(accountsModule).toContain('title={ACCOUNTS_TOTAL_TITLE}');
  });
});

describe('the managed table (the standard, as shipped machinery)', () => {
  it('defaults to the first column ascending and flips on a repeat click', () => {
    expect(managedTable).toContain('key: columns[0].key');
    expect(managedTable).toMatch(/s\.key === key \? \{ key, dir: s\.dir === 1 \? -1 : 1 \} : \{ key, dir: 1 \}/);
  });

  it('sorts numbers numerically and text with numeric awareness', () => {
    expect(managedTable).toMatch(/typeof va === 'number' && typeof vb === 'number'/);
    expect(managedTable).toContain("numeric: true");
  });

  it('never mutates the caller\u2019s rows to sort them', () => {
    expect(managedTable).toContain('[...rows].sort(');
  });

  it('opens on the row AND on the primary cell, once each', () => {
    expect(managedTable).toContain('onClick={() => onOpen(row)}');
    expect(managedTable).toContain('e.stopPropagation();');
  });

  it('puts every trashcan behind the one confirm modal', () => {
    expect(managedTable).toContain('setPendingDelete(row);');
    expect(managedTable).toContain('<ConfirmModal');
    expect(managedTable).toMatch(/onConfirm=\{\(\) => \{\s*onDelete\(pendingDelete\);/);
  });

  it('carries the sort state on the heading for assistive tech', () => {
    expect(managedTable).toContain('aria-sort={');
  });
});

/**
 * NOTHING WAS LOST IN THE MOVE.
 *
 * The restructure took a component that rendered every field of every account
 * and made it render every field of ONE account behind a URL. That is exactly
 * the change where a conditional branch quietly fails to come along, and the
 * loss is invisible: an account type whose editor no longer appears looks like
 * an account type that never had one.
 *
 * So this is the inventory of what the old full-width account row rendered,
 * asserted as still present — in the editor for its fields, in the module for
 * the chrome that moved there. A scan, not a render: what it protects against
 * is a field being DELETED, and a deleted field cannot hide from a text search.
 */
describe('every field the old account card rendered is still reachable', () => {
  const EDITOR_FIELDS: ReadonlyArray<readonly [string, string]> = [
    // The muted `id:` line left the inventory deliberately (owner's call,
    // 2026-08-30): the id is the URL segment, readable off the address bar.
    ['the PLACEHOLDER chip', 'isPlaceholder(account.notes) ? <PlaceholderChip />'],
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
  ];

  for (const [what, needle] of EDITOR_FIELDS) {
    it(`still renders ${what}`, () => {
      expect(accountEditor).toContain(needle);
    });
  }

  const MODULE_CHROME: ReadonlyArray<readonly [string, string]> = [
    ['the account name (as the banner crumb)', 'accountDisplayName(selected)'],
    ['Delete', 'Delete'],
    ['+ Add account', '+ Add account'],
    ['Refresh prices', 'Refresh prices'],
  ];

  for (const [what, needle] of MODULE_CHROME) {
    it(`still offers ${what}`, () => {
      expect(accountsModule).toContain(needle);
    });
  }

  it('keeps each editor behind the condition that always gated it', () => {
    // Holdings mode still hides the two manual editors, pre-tax still gates
    // the contributions box, and the type-specific blocks still ask the type.
    expect(accountEditor).toContain('canBeTargetDateFund(account.type)');
    expect(accountEditor).toContain("account.type === 'roth_ira' ? (");
    expect(accountEditor).toContain("account.type === '401k' ? (");
    expect(accountEditor).toContain("account.type === 'taxable_brokerage' ? (");
    expect(accountEditor).toContain('{isHoldings ? (');
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

  it('marks the active sidebar item with the marks this app already uses', () => {
    // .tab.is-active's accent-soft fill and inset accent edge, turned to the
    // leading side for a strip that runs down the page.
    const body = ruleBody('.sideNavItem.active');
    expect(body).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(body).toMatch(/color:\s*var\(--accent\)/);
    expect(body).toMatch(/box-shadow:\s*inset 2px 0 0 var\(--accent\)/);
  });

  it('makes the primary column read as clickable, and the row hover confirm it', () => {
    expect(ruleBody('button.rowPrimaryBtn')).toMatch(/color:\s*var\(--accent\)/);
    expect(ruleBody('.managedRow')).toMatch(/cursor:\s*pointer/);
  });

  it('keeps view mode and edit mode the same layout — transparent chrome, same box', () => {
    // The owner's no-jump rule: disabled controls keep their box and lose
    // their borders, so Edit changes affordances and not geometry.
    expect(css).toContain('fieldset.moduleFieldset:disabled input');
    const scan = /fieldset\.moduleFieldset:disabled select,\n[^{]*\{([^}]*)\}/.exec(css);
    expect(scan).not.toBeNull();
    expect(scan![1]).toMatch(/border-color:\s*transparent/);
    expect(scan![1]).toMatch(/background:\s*transparent/);
  });

  it('hides edit-mode furniture in view mode without reflowing the form', () => {
    const rule = /fieldset\.moduleFieldset:disabled button:not\(\.infotip-btn\)\s*\{([^}]*)\}/.exec(
      css,
    );
    expect(rule).not.toBeNull();
    // visibility, not display: the space is preserved, so entering edit mode
    // does not move a single field.
    expect(rule![1]).toMatch(/visibility:\s*hidden/);
    expect(rule![1]).not.toMatch(/display:\s*none/);
  });
});
