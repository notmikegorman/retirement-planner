/**
 * The ACCOUNT EDITOR — everything there is to say about one account (name,
 * type, owner, balance or holdings, target-date fund, Roth funding, notes),
 * plus the sub-editors those fields carry. The list/table half lives in
 * modules/AccountsModule.tsx (the managed-table standard); this file is the
 * detail form it opens, shared between view mode (disabled fieldset) and
 * edit mode.
 *
 * The internal `id` is NOT shown (the owner's call, 2026-08-30): it is the
 * URL segment, so anyone who needs it for a hand-written plan event can read
 * it off the address bar.
 */
import { useEffect, useState } from 'react';
import type {
  Account,
  AccountType,
  AssetClass,
  Person,
  Profile,
  QuotesFile,
  RothBasis,
} from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import { deriveAccount } from '../../../shared/holdings';
import {
  AllocationEditor,
  CheckboxField,
  FieldNote,
  NumberField,
  PlaceholderChip,
  SelectField,
  TextField,
} from './fields';
import {
  ACCOUNT_TYPE_LABELS,
  DEFAULT_TDF_TARGET_YEAR,
  accountDisplayName,
  addConversion,
  canBeTargetDateFund,
  emptyRothBasis,
  formatDerivedMix,
  formatQuoteAsOf,
  isPlaceholder,
  isPretaxAccount,
  normalizeAccountForType,
  normalizeSymbolInput,
  ownerOptions,
  removeConversion,
  rothBasisTotal,
  setTargetDateFund,
  updateConversion,
} from './profileLogic';

const ACCOUNT_TYPE_OPTIONS = (Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((value) => ({
  value,
  label: ACCOUNT_TYPE_LABELS[value],
}));

const JOINT_HELP =
  'Retirement accounts (401(k), IRA, Roth) are individually owned by law — only ' +
  'brokerage and savings accounts can be titled jointly.';

const ROLLOVER_NOTE =
  'Rolled into the traditional IRA when you leave this employer (modeled in every run)';

const TDF_HELP =
  'Allocation below is today’s mix; the app glides it to 50/50 at the target year and 30/70 ' +
  'seven years later.';

const TDF_ALLOCATION_HELP =
  'A target-date fund is a stock/bond blend, not 100% stocks — a 2035 fund is roughly 68/32 ' +
  'today (enter 0.68 / 0.32 / 0).';

const CONTRIBUTIONS_HELP =
  'Money you put in directly — withdrawable anytime, tax- and penalty-free';

const CONVERSIONS_HELP =
  'A large lump sum was probably a conversion or a rollover from a Roth 401(k); conversions ' +
  'older than five years behave like contributions after 59½.';

const HOLDINGS_TIP =
  'Instead of typing a balance and an allocation, list what the account actually holds — ' +
  'symbol, share count, and which asset class each fund is. The balance and mix are then ' +
  'DERIVED: shares × the stored price, plus cash, with the mix from the per-class market ' +
  'values. Prices come only from the Refresh button (stored in quotes.json with their own ' +
  'as-of moments) — simulations never fetch, so a run with an unpriced symbol refuses to ' +
  'run rather than quietly using a stale number. Untick to go back to typing the balance ' +
  'by hand; the last derived figures stay as the starting point.';

const CASH_HELP = 'Uninvested sweep money beside the positions; counts as bills';

const NO_QUOTE_TITLE =
  'No stored price for this symbol yet. The derived balance treats it as $0 and a ' +
  'simulation will refuse to run until it is priced — press "Refresh prices".';

const ASSET_CLASS_OPTIONS: Array<{ value: AssetClass; label: string }> = [
  { value: 'stocks', label: 'Stocks' },
  { value: 'bonds', label: 'Bonds' },
  { value: 'bills', label: 'Bills' },
];

type UpdateFn = (mutate: (p: Profile) => void) => void;

// ---------------------------------------------------------------------------
// Lifetime contributions (note 21)
// ---------------------------------------------------------------------------

const LIFETIME_LABEL = 'Contributed over your career ($)';

const LIFETIME_TIP =
  'Every dollar you ever PUT IN to this account — your own deferrals, the employer match, direct ' +
  'contributions, and rollovers of the same — never the growth on top. It is not a tax figure ' +
  'and nothing about your withdrawals depends on it. ' +
  'Only the tithe-account giving rule reads it: contributions arrived out of gross pay you ' +
  'already gave on, so the part of the balance that has never passed under a tithe is the ' +
  'balance MINUS this number. Leaving it blank is honest — it means “I do not know” — and the ' +
  'rule then treats this account as having no untithed gains at all, rather than guessing and ' +
  'either double-tithing a career of pay or missing decades of growth. Years where it had to do ' +
  'that are flagged in the cashflow table. An old statement or your plan’s contribution history ' +
  'is the usual source; a rough figure beats no figure.';

const LIFETIME_HELP = 'Blank = not known';

const LIFETIME_UNKNOWN_TITLE =
  'No career-contributions figure recorded for this account. The tithe-account giving rule ' +
  'counts its untithed gains as zero and flags the year rather than guessing. Every other part ' +
  'of the plan is unaffected.';

/**
 * "What did you put in?" for one retirement account.
 *
 * The chip beside it is the point of the control: an EMPTY box here is a real
 * answer ("unknown"), not an unfilled form, and it changes what the tithe rule
 * seeds — so it has to be visible at a glance rather than inferred from an
 * empty input. Rendered for all three retirement wrappers (the engine reads it
 * on each of them); a brokerage or savings balance is not a record of
 * contributions and gets no field.
 */
function LifetimeContributionsField({
  account,
  index,
  update,
  help,
  width = 220,
}: {
  account: Account;
  index: number;
  update: UpdateFn;
  /** Overrides the default hint — the Roth has a more specific one. */
  help?: string;
  width?: number;
}) {
  return (
    <>
      <NumberField
        label={LIFETIME_LABEL}
        value={account.lifetimeContributions}
        allowEmpty
        width={width}
        placeholder="not known"
        help={help ?? LIFETIME_HELP}
        tip={LIFETIME_TIP}
        onCommit={(v) =>
          update((p) => {
            // Deleted rather than written as 0: absent means UNKNOWN, and a 0
            // would tell the tithe rule the whole balance is untithed growth.
            if (v === undefined) delete p.accounts[index].lifetimeContributions;
            else p.accounts[index].lifetimeContributions = Math.max(0, v);
          })
        }
      />
      {account.lifetimeContributions === undefined ? (
        <FieldNote>
          <span className="flag" title={LIFETIME_UNKNOWN_TITLE}>
            not known
          </span>
        </FieldNote>
      ) : null}
    </>
  );
}

/**
 * "How was this Roth funded?" — direct contributions plus (year, amount)
 * conversion buckets, which the engine ages against the 5-year clock.
 */
function RothFundingEditor({
  account,
  index,
  update,
}: {
  account: Account;
  index: number;
  update: UpdateFn;
}) {
  const b = account.rothBasis ?? emptyRothBasis();
  const setBasis = (next: RothBasis) =>
    update((p) => {
      p.accounts[index].rothBasis = next;
    });

  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ marginBottom: 2 }}>
        How was this Roth funded?
      </div>
      <div className="row">
        <NumberField
          label="Direct contributions ($)"
          value={b.contributions}
          width={190}
          help={CONTRIBUTIONS_HELP}
          onCommit={(v) => setBasis({ ...b, contributions: v ?? 0 })}
        />
        <FieldNote className="muted">
          Total basis {formatUSD(rothBasisTotal(b))} (balance above is today’s value; the
          difference is growth)
        </FieldNote>
      </div>
      {b.conversions.map((c, ci) => (
        // Key includes the values, not just the index: the number inputs keep
        // local text state, so removing a row must not leave the row below it
        // displaying the removed row's text.
        <div className="row inlineRow" key={`${ci}-${c.year}-${c.amount}`}>
          <NumberField
            label="Conversion year"
            int
            value={c.year}
            width={130}
            onCommit={(v) => setBasis(updateConversion(b, ci, { year: v ?? c.year }))}
          />
          <NumberField
            label="Amount converted ($)"
            value={c.amount}
            width={170}
            onCommit={(v) => setBasis(updateConversion(b, ci, { amount: v ?? 0 }))}
          />
          <FieldNote>
            <button className="danger" onClick={() => setBasis(removeConversion(b, ci))}>
              Remove
            </button>
          </FieldNote>
        </div>
      ))}
      <div className="row inlineRow">
        <button onClick={() => setBasis(addConversion(b, new Date().getFullYear()))}>
          + Add conversion
        </button>
      </div>
      <div className="field-help" style={{ marginTop: 4 }}>
        {CONVERSIONS_HELP}
      </div>
      {/*
        The Roth's career-contributions figure. It is NOT the same field as the
        basis above — that one drives the 5-year clock and the withdrawal
        ordering, this one only tells the tithe rule how much of the balance is
        growth — but for a Roth the two are usually the same number, so it sits
        here where that total is on screen and can be copied across.
      */}
      <div className="row">
        <LifetimeContributionsField
          account={account}
          index={index}
          update={update}
          help={`Blank = not known; usually the ${formatUSD(rothBasisTotal(b))} total above`}
          width={250}
        />
      </div>
    </div>
  );
}

/**
 * One typed ticker box. Its own component (rather than TextField) for the one
 * behaviour tickers need: an entry that is not a legal symbol REVERTS on blur,
 * exactly as the number fields revert unparseable text — storing "vti " or a
 * sentence would bounce three tabs later as a zod message on Save, which is a
 * confusing place to learn a box wanted uppercase.
 */
function SymbolField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const symbol = normalizeSymbolInput(text);
    if (symbol === null) {
      setText(value); // revert, the number-field rule
      return;
    }
    setText(symbol);
    if (symbol !== value) onCommit(symbol);
  };
  return (
    <label className="field" style={{ width: 110 }}>
      <span className="field-label">Symbol</span>
      <input
        value={text}
        placeholder="VTI"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}

/**
 * The holdings-mode editor: position rows, the cash box, and the derived
 * readout. The derivation runs CLIENT-SIDE through the same shared function
 * the server resolves runs with (shared/holdings.ts deriveAccount), fed the
 * stored quotes — so the preview prices the DRAFT the user is typing, and an
 * unsaved row previews with exactly the numbers a save-then-run would use.
 */
function HoldingsEditor({
  account,
  index,
  update,
  quotes,
}: {
  account: Account;
  index: number;
  update: UpdateFn;
  quotes: QuotesFile;
}) {
  const holdings = account.holdings ?? [];
  const derived = deriveAccount(account, quotes);
  // A just-added row has no symbol yet; it is not a "missing quote", it is an
  // unfinished row, and the warning line should not name an empty string.
  const missing = derived.missing.filter((s) => s !== '');

  return (
    <div style={{ marginTop: 8 }}>
      {holdings.map((h, hi) => {
        const quote = quotes[h.symbol];
        return (
          // Key includes the values (the conversions-editor rule): these
          // fields keep local text state, so removing a row must not leave
          // the row below it displaying the removed row's text.
          <div className="row inlineRow" key={`${hi}-${h.symbol}-${h.quantity}-${h.assetClass}`}>
            <SymbolField
              value={h.symbol}
              onCommit={(symbol) =>
                update((p) => {
                  p.accounts[index].holdings![hi].symbol = symbol;
                })
              }
            />
            <NumberField
              label="Shares"
              value={h.quantity}
              width={130}
              help="Fractional is fine"
              onCommit={(v) =>
                update((p) => {
                  // Zero-or-negative is left unstored (the schema refuses it
                  // on Save anyway): a 0-share row is a delete wearing a row,
                  // and the Remove button is right there.
                  if (v !== undefined && v > 0) p.accounts[index].holdings![hi].quantity = v;
                })
              }
            />
            <SelectField
              label="Asset class"
              value={h.assetClass}
              options={ASSET_CLASS_OPTIONS}
              width={110}
              onChange={(v) =>
                update((p) => {
                  p.accounts[index].holdings![hi].assetClass = v as AssetClass;
                })
              }
            />
            <FieldNote className="muted">
              {quote ? (
                `${h.symbol} ${formatUSD(quote.price, { cents: true })} as of ` +
                `${formatQuoteAsOf(quote.asOf)} — delayed · ${formatUSD(h.quantity * quote.price)}`
              ) : (
                <span className="flag" title={NO_QUOTE_TITLE}>
                  no stored quote
                </span>
              )}
            </FieldNote>
            <FieldNote>
              <button
                className="danger"
                onClick={() =>
                  update((p) => {
                    p.accounts[index].holdings!.splice(hi, 1);
                  })
                }
              >
                Remove
              </button>
            </FieldNote>
          </div>
        );
      })}
      <div className="row inlineRow">
        <NumberField
          label="Cash ($)"
          value={account.cash ?? 0}
          width={130}
          help={CASH_HELP}
          onCommit={(v) =>
            update((p) => {
              p.accounts[index].cash = Math.max(0, v ?? 0);
            })
          }
        />
        <FieldNote>
          <button
            onClick={() =>
              update((p) => {
                p.accounts[index].holdings!.push({ symbol: '', quantity: 1, assetClass: 'stocks' });
              })
            }
          >
            + Add holding
          </button>
        </FieldNote>
      </div>
      {/* The derived figures, each carrying its condition: stored prices, not
          live ones, and unpriced symbols named rather than silently $0. */}
      <div className="row inlineRow">
        <FieldNote className="muted">
          Balance {formatUSD(derived.balance, { cents: true })} · mix{' '}
          {formatDerivedMix(derived.allocation)} (stocks/bonds/bills) — derived from stored
          prices{missing.length > 0 ? '' : '; refresh to reprice'}
        </FieldNote>
        {missing.length > 0 ? (
          <FieldNote className="warn">
            {missing.join(', ')} unpriced — counted as $0 here, and simulations refuse to run
            until refreshed
          </FieldNote>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Everything there is to say about ONE account — the same fields, in the same
 * order, under the same conditions the old two-column card showed them. Its
 * caller (AccountsModule) owns the surrounding chrome: the banner crumb, the
 * Edit / Delete actions, and the view-mode fieldset this renders inside.
 */
export function AccountEditor({
  account,
  index,
  people,
  update,
  quotes,
}: {
  account: Account;
  index: number;
  people: Person[];
  update: UpdateFn;
  quotes: QuotesFile;
}) {
  const fallbackPerson = people[0]?.id ?? 'p1';
  const isTdf = account.targetDateFund != null;
  const isHoldings = account.holdings !== undefined;

  return (
    <div className="acct-detail">
      {isPlaceholder(account.notes) ? <PlaceholderChip /> : null}
      <div className="row">
        <TextField
          label="Name"
          value={account.name}
          width={220}
          help="Shown everywhere in the app (e.g. “Alex’s 401(k)”)"
          onCommit={(v) =>
            update((p) => {
              p.accounts[index].name = v;
            })
          }
        />
        <SelectField
          label="Type"
          value={account.type}
          options={ACCOUNT_TYPE_OPTIONS}
          width={170}
          onChange={(v) =>
            update((p) => {
              p.accounts[index] = normalizeAccountForType(
                p.accounts[index],
                v as AccountType,
                fallbackPerson,
              );
            })
          }
        />
        <SelectField
          label="Owner"
          value={account.owner}
          options={ownerOptions(people, account.type)}
          width={150}
          help={JOINT_HELP}
          onChange={(v) =>
            update((p) => {
              p.accounts[index].owner = v;
            })
          }
        />
        {/* In holdings mode the balance is DERIVED (shares × stored price +
            cash) and the manual box disappears — a typed number beside a
            derived one would be two answers to one question. */}
        {!isHoldings ? (
          <NumberField
            label="Balance ($)"
            value={account.balance}
            width={140}
            onCommit={(v) =>
              update((p) => {
                p.accounts[index].balance = v ?? 0;
              })
            }
          />
        ) : null}
        {account.type === 'taxable_brokerage' ? (
          <NumberField
            label="Cost basis ($)"
            value={account.costBasis ?? 0}
            width={140}
            help="For LTCG on sales"
            onCommit={(v) =>
              update((p) => {
                p.accounts[index].costBasis = v ?? 0;
              })
            }
          />
        ) : null}
        {/* Pre-tax accounts carry no funding history anywhere else, so the
            figure sits in the main row beside the balance it qualifies. The
            Roth's copy lives inside its funding editor below, next to the
            contributions and conversions that usually add up to it. */}
        {isPretaxAccount(account.type) ? (
          <LifetimeContributionsField account={account} index={index} update={update} />
        ) : null}
      </div>

      <div className="row">
        <CheckboxField
          label="Track holdings (symbol × shares)"
          checked={isHoldings}
          tip={HOLDINGS_TIP}
          onChange={(on) =>
            update((p) => {
              const a = p.accounts[index];
              if (on) {
                // The last manual balance/allocation stay in place underneath:
                // they are the resolved cache the engine reads until the first
                // derivation replaces them, so ticking the box destroys nothing.
                a.holdings = a.holdings ?? [];
                a.cash = a.cash ?? 0;
              } else {
                // Untick keeps the derived figures as the new manual values —
                // the honest starting point, and the reason the toggle is safe
                // to try in both directions.
                delete a.holdings;
                delete a.cash;
              }
            })
          }
        />
      </div>

      {isHoldings ? (
        <HoldingsEditor account={account} index={index} update={update} quotes={quotes} />
      ) : null}

      {account.type === '401k' ? (
        <div className="row">
          <CheckboxField
            label="Current employer"
            checked={account.currentEmployer ?? false}
            onChange={(v) =>
              update((p) => {
                p.accounts[index].currentEmployer = v;
              })
            }
          />
          <FieldNote className="muted">{ROLLOVER_NOTE}</FieldNote>
        </div>
      ) : null}

      {canBeTargetDateFund(account.type) ? (
        <div className="row">
          <CheckboxField
            label="This is a target-date fund"
            checked={isTdf}
            onChange={(v) =>
              update((p) => {
                p.accounts[index] = setTargetDateFund(p.accounts[index], v);
              })
            }
          />
          {isTdf ? (
            <NumberField
              label="Target year"
              int
              value={account.targetDateFund?.targetYear ?? DEFAULT_TDF_TARGET_YEAR}
              width={110}
              help={TDF_HELP}
              onCommit={(v) =>
                update((p) => {
                  p.accounts[index].targetDateFund = {
                    targetYear: v ?? DEFAULT_TDF_TARGET_YEAR,
                  };
                })
              }
            />
          ) : null}
        </div>
      ) : null}

      {account.type === 'roth_ira' ? (
        <RothFundingEditor account={account} index={index} update={update} />
      ) : null}

      {/* Holdings mode derives the mix from per-class market values; the
          hand-typed editor would be a second, disagreeing author. */}
      {!isHoldings ? (
        <div style={{ marginTop: 4 }}>
          <AllocationEditor
            mix={account.allocation}
            help={isTdf ? TDF_ALLOCATION_HELP : undefined}
            onChange={(mix) =>
              update((p) => {
                p.accounts[index].allocation = mix;
              })
            }
          />
        </div>
      ) : null}
      <TextField
        label="Notes"
        value={account.notes ?? ''}
        width="full"
        onCommit={(v) =>
          update((p) => {
            p.accounts[index].notes = v || undefined;
          })
        }
      />
    </div>
  );
}
