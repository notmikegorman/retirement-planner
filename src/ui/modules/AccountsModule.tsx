/**
 * Accounts — the managed-table module (the owner's standard, 2026-08-30):
 * /accounts is the table, /accounts/<id> is one account's detail, and the
 * banner carries the actions each view owns (Add on the table; Edit / Delete
 * on a detail; Cancel / Save while editing).
 *
 * ONE profile document for both views. The table and the detail read the
 * same draft, so a half-typed new account appears in the table the moment
 * you click back to it — and the add flow leans on that: Add pushes a fresh
 * account into the DRAFT only, opens its detail in edit mode, and Save is
 * what makes it real. Cancel restores the saved profile, at which point the
 * URL names an account that no longer exists and the module returns to the
 * table (the not-found effect below) — no junk rows from abandoned adds.
 *
 * Deletion is immediate (confirm modal, then one get-mutate-put write):
 * a trashcan click is not an edit session.
 *
 * QUOTES are module state, loaded once and replaced by each refresh, priced
 * against the DRAFT accounts client-side (accountsLogic.accountListBalance →
 * the same deriveAccount call the server resolves runs with) so the table,
 * the detail readout, and a save-then-run all print the same dollars.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuoteRefreshOutcome, QuotesFile } from '../../shared/types';
import { api } from '../api';
import type { PageProps } from '../nav';
import { DiscardChangesPrompt } from '../dirtyFormBlocker';
import { AccountEditor } from '../components/profile/AccountEditor';
import {
  ACCOUNTS_TOTAL_LABEL,
  ACCOUNTS_TOTAL_TITLE,
  ROW_UNPRICED_TITLE,
  accountListBalance,
  accountMissingQuotes,
  accountsTotal,
  formatListBalance,
} from '../components/profile/accountsLogic';
import {
  accountDisplayName,
  accountTypeLabel,
  makeNewAccount,
  ownerLabel,
  uniqueAccountId,
} from '../components/profile/profileLogic';
import { ConfirmModal } from './ConfirmModal';
import { ManagedTable } from './ManagedTable';
import { ModuleBanner } from './ModuleBanner';
import { useProfileDoc } from './useProfileDoc';

export function AccountsModule({ route, navigate }: PageProps) {
  const doc = useProfileDoc();
  const entityId = route.tab;

  const [quotes, setQuotes] = useState<QuotesFile>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailures, setRefreshFailures] = useState<QuoteRefreshOutcome[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [confirmDetailDelete, setConfirmDetailDelete] = useState(false);

  useEffect(() => {
    api.getQuotes().then(setQuotes, () => {
      // A failed load leaves {} — every symbol then shows "no stored quote",
      // which is the truthful display for a folder never refreshed too.
    });
  }, []);

  const accounts = doc.profile?.accounts ?? [];
  const selectedIndex =
    entityId === null ? -1 : accounts.findIndex((a) => a.id === entityId);
  const selected = selectedIndex >= 0 ? accounts[selectedIndex] : undefined;

  /**
   * A path naming an account the draft does not hold — a stale link, a
   * deleted record, or a cancelled add — answers with the table. Replace,
   * not push: the dead URL should not survive in history.
   */
  useEffect(() => {
    if (entityId !== null && !doc.loading && doc.profile !== null && selected === undefined) {
      navigate('accounts', null, { replace: true });
    }
  }, [entityId, doc.loading, doc.profile, selected, navigate]);


  /** Where the route is NOW, for async completions that captured the past. */
  const routeTabRef = useRef(entityId);
  routeTabRef.current = entityId;
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  /**
   * Returning to the table ends any edit session: a clean edit left via the
   * breadcrumb (or browser Back — the guard's one documented gap) must not
   * reopen the next row in edit mode. (The add flow is safe: its enterEdit
   * and its navigate land in one batch, so the table state this effect
   * watches never renders.)
   */
  useEffect(() => {
    if (entityId === null && doc.editing) doc.cancelEdit();
  }, [entityId, doc.editing, doc.cancelEdit]);

  // Symbols from the DRAFT, not the saved profile: the refresh must price the
  // rows on screen, including ones not saved yet.
  const draftSymbols = [
    ...new Set(accounts.flatMap((a) => (a.holdings ?? []).map((h) => h.symbol))),
  ]
    .filter((s) => s !== '')
    .sort();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await api.refreshQuotes(draftSymbols);
      setQuotes(res.quotes);
      // Failures are per-symbol data, shown per symbol; the eight that landed
      // still reprice everything on screen.
      setRefreshFailures(res.results.filter((r) => !r.ok));
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [draftSymbols.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Add = draft row + detail in edit mode. The id is decided out here rather
   * than read back from makeNewAccount's result: `update` hands the mutation
   * a clone, so nothing inside it comes back, and the row that appears and
   * the row that opens must be the same row by construction.
   */
  const addAccount = () => {
    const id = uniqueAccountId(accounts);
    doc.update((p) => {
      p.accounts.push({ ...makeNewAccount(p), id });
    });
    doc.enterEdit();
    navigate('accounts', id);
  };

  const deleteAccount = async (id: string) => {
    const ok = await doc.mutateAndSave((p) => {
      const i = p.accounts.findIndex((a) => a.id === id);
      if (i >= 0) p.accounts.splice(i, 1);
    });
    // Only steer the URL if the user is still LOOKING at the deleted record:
    // a slow write must not yank them back from wherever they went meanwhile.
    if (ok && alive.current && routeTabRef.current === id) {
      navigate('accounts', null, { replace: true });
    }
  };

  if (doc.loading || doc.profile === null) {
    return (
      <>
        <ModuleBanner title="Accounts" />
        <div className="moduleBody">
          {doc.loadError !== null ? (
            <>
              <div className="error-banner">Failed to load the profile: {doc.loadError}</div>
              <button onClick={() => void doc.reload()}>Retry</button>
            </>
          ) : (
            <div className="muted">Loading…</div>
          )}
        </div>
      </>
    );
  }

  const profile = doc.profile;
  const refreshNotes = (
    <>
      {refreshError !== null ? (
        <div className="error-banner">Refresh failed: {refreshError}</div>
      ) : null}
      {refreshFailures.map((f) =>
        f.ok ? null : (
          <div key={f.symbol} className="field-help warn" style={{ marginTop: 4 }}>
            {f.symbol}: {f.error}
          </div>
        ),
      )}
    </>
  );
  const refreshButton =
    draftSymbols.length > 0 ? (
      <button disabled={refreshing} onClick={() => void refresh()}>
        {refreshing ? 'Refreshing…' : 'Refresh prices'}
      </button>
    ) : null;

  // ---- the detail view ----------------------------------------------------

  if (selected !== undefined) {
    return (
      <>
        <ModuleBanner
          title="Accounts"
          onTitleClick={() => navigate('accounts', null)}
          crumb={accountDisplayName(selected)}
          pill={
            doc.editing ? (
              <span className={doc.dirty ? 'statusPill isDirty' : 'statusPill isSaved'}>
                {doc.dirty ? 'Unsaved changes' : 'Editing'}
              </span>
            ) : null
          }
          actions={
            doc.editing ? (
              <>
                {/* Stays in edit mode too: the no-quote flag's own tooltip
                    says to press it, and a freshly typed symbol is exactly
                    when it is needed. It touches quotes state, not the
                    draft, so it is safe mid-edit. */}
                {refreshButton}
                <button disabled={doc.saving} onClick={doc.cancelEdit}>
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={doc.saving}
                  onClick={() => void doc.save()}
                >
                  {doc.saving ? 'Saving…' : 'Save'}
                </button>
              </>
            ) : (
              <>
                {refreshButton}
                <button onClick={doc.enterEdit}>Edit</button>
                <button className="danger" onClick={() => setConfirmDetailDelete(true)}>
                  Delete
                </button>
              </>
            )
          }
        />
        <div className="moduleBody">
          {doc.saveError !== null ? (
            <div className="error-banner">Save failed: {doc.saveError}</div>
          ) : null}
          {refreshNotes}
          <div className="card">
            <fieldset
              // Keyed by rev AND id: Cancel remounts the blur-committed
              // fields, and switching accounts must never leave a half-typed
              // balance sitting in the next account's box.
              key={`${doc.rev}:${selected.id}`}
              disabled={!doc.editing}
              className="moduleFieldset"
            >
              <AccountEditor
                account={selected}
                index={selectedIndex}
                people={profile.people}
                update={doc.update}
                quotes={quotes}
              />
            </fieldset>
          </div>
        </div>
        {confirmDetailDelete ? (
          <ConfirmModal
            title={`Delete ${accountDisplayName(selected)}?`}
            body="The account and everything recorded on it leave the profile. Plan events that reference its id stop matching anything. This cannot be undone."
            onConfirm={() => {
              setConfirmDetailDelete(false);
              void deleteAccount(selected.id);
            }}
            onCancel={() => setConfirmDetailDelete(false)}
          />
        ) : null}
        <DiscardChangesPrompt blocker={doc.blocker} />
      </>
    );
  }

  // ---- the table view -----------------------------------------------------

  return (
    <>
      <ModuleBanner
        title="Accounts"
        actions={
          <>
            {refreshButton}
            <button className="primary" onClick={addAccount}>
              + Add account
            </button>
          </>
        }
      />
      <div className="moduleBody">
        {doc.saveError !== null ? (
          <div className="error-banner">Save failed: {doc.saveError}</div>
        ) : null}
        {refreshNotes}
        {accounts.length === 0 ? (
          <div className="card">
            <div className="muted">No accounts yet.</div>
          </div>
        ) : (
          <ManagedTable
            columns={[
              {
                key: 'name',
                label: 'Name',
                sortValue: (a) => accountDisplayName(a),
                render: (a) => {
                  const unpriced = accountMissingQuotes(a, quotes);
                  return (
                    <>
                      {accountDisplayName(a)}
                      {unpriced.length > 0 ? (
                        <>
                          {' '}
                          <span className="flag" title={ROW_UNPRICED_TITLE}>
                            unpriced
                          </span>
                        </>
                      ) : null}
                    </>
                  );
                },
              },
              {
                key: 'type',
                label: 'Type',
                sortValue: (a) => accountTypeLabel(a.type),
              },
              {
                key: 'owner',
                label: 'Owner',
                sortValue: (a) => ownerLabel(profile, a.owner),
              },
              {
                key: 'balance',
                label: 'Balance',
                align: 'right',
                sortValue: (a) => accountListBalance(a, quotes),
                render: (a) => formatListBalance(accountListBalance(a, quotes)),
              },
            ]}
            rows={accounts}
            rowId={(a) => a.id}
            onOpen={(a) => navigate('accounts', a.id)}
            deleteLabel={(a) => `Delete ${accountDisplayName(a)}`}
            deleteConfirm={(a) => ({
              title: `Delete ${accountDisplayName(a)}?`,
              body: 'The account and everything recorded on it leave the profile. Plan events that reference its id stop matching anything. This cannot be undone.',
            })}
            onDelete={(a) => void deleteAccount(a.id)}
            foot={
              <tfoot>
                <tr className="managedTotalRow">
                  <td className="col-text">
                    <strong>{ACCOUNTS_TOTAL_LABEL}</strong>
                  </td>
                  <td className="col-text" />
                  <td className="col-text" />
                  <td>
                    <strong title={ACCOUNTS_TOTAL_TITLE}>
                      {formatListBalance(accountsTotal(accounts, quotes))}
                    </strong>
                  </td>
                  <td className="deleteCell" />
                </tr>
              </tfoot>
            }
          />
        )}
      </div>
      <DiscardChangesPrompt blocker={doc.blocker} />
    </>
  );
}
