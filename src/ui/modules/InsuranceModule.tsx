/**
 * Insurance — the managed-table module over the household's life-insurance
 * policies: /insurance is the table, /insurance/<id> one policy's detail,
 * same standard and same one-document machinery as AccountsModule (whose
 * header comment carries the add/cancel/delete reasoning).
 *
 * TWO SHAPES, ONE RULE. With a policy list the module is a table. A profile
 * written before the list existed holds its one policy in four legacy scalar
 * fields instead — that is "just one thing", so the module shows that one
 * thing (a view/edit form) plus the convert offer, which restructures and
 * saves in one move. Deleting the last listed policy returns the module to
 * the legacy form, because absent and empty mean the same thing to the
 * engine and the legacy fields are where editing has to land.
 */
import { useEffect, useRef, useState } from 'react';
import { formatUSD } from '../../shared/util';
import { api } from '../api';
import type { PageProps } from '../nav';
import { DiscardChangesPrompt } from '../dirtyFormBlocker';
import {
  ConvertToListOffer,
  LegacyPolicyFields,
  PolicyEditor,
  convertToPolicyList,
  defaultInsured,
} from '../components/profile/InsuranceEditor';
import {
  formatMonth,
  makePolicy,
  policyTotals,
  workStopsMonth,
} from '../components/profile/expensesLogic';
import { personName } from '../components/profile/profileLogic';
import { readPlan } from '../components/scenarios/scenarioHelpers';
import type { ScenarioEvent } from '../../shared/types';
import { ConfirmModal } from './ConfirmModal';
import { ManagedTable } from './ManagedTable';
import { ModuleBanner } from './ModuleBanner';
import { useProfileDoc } from './useProfileDoc';

export function InsuranceModule({ route, navigate }: PageProps) {
  const doc = useProfileDoc();
  const entityId = route.tab;
  const [confirmDetailDelete, setConfirmDetailDelete] = useState(false);

  /** The plan's retire events — what each policy's expiry measures against. */
  const [planEvents, setPlanEvents] = useState<ScenarioEvent[]>([]);
  useEffect(() => {
    api.getPlan().then(
      (plan) => setPlanEvents(plan.events),
      () => setPlanEvents([]),
    );
  }, []);

  const profile = doc.profile;
  const policies = profile?.expenses.lifeInsurancePolicies ?? [];
  const hasList = policies.length > 0;
  const selectedIndex = entityId === null ? -1 : policies.findIndex((p) => p.id === entityId);
  const selected = selectedIndex >= 0 ? policies[selectedIndex] : undefined;

  useEffect(() => {
    if (entityId !== null && !doc.loading && profile !== null && selected === undefined) {
      navigate('insurance', null, { replace: true });
    }
  }, [entityId, doc.loading, profile, selected, navigate]);

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
   * Returning to the TABLE ends any edit session: a clean edit left via the
   * breadcrumb (or browser Back — the guard's one documented gap) must not
   * reopen the next row in edit mode. Gated on hasList because the LEGACY
   * single-policy form also lives at entityId === null — it IS an edit
   * session at the table's address, and this effect firing there made Edit
   * cancel itself within a frame. (The add flow is safe either way: its
   * enterEdit and its navigate land in one batch, so the table state this
   * effect watches never renders.)
   */
  useEffect(() => {
    if (entityId === null && hasList && doc.editing) doc.cancelEdit();
  }, [entityId, hasList, doc.editing, doc.cancelEdit]);

  if (doc.loading || profile === null) {
    return (
      <>
        <ModuleBanner title="Insurance" />
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

  const workStops = workStopsMonth(
    profile.people,
    profile.income.salaries,
    readPlan(planEvents, profile.people).retireByPerson,
  );

  const editPill = doc.editing ? (
    <span className={doc.dirty ? 'statusPill isDirty' : 'statusPill isSaved'}>
      {doc.dirty ? 'Unsaved changes' : 'Editing'}
    </span>
  ) : null;
  const editActions = (
    <>
      <button disabled={doc.saving} onClick={doc.cancelEdit}>
        Cancel
      </button>
      <button className="primary" disabled={doc.saving} onClick={() => void doc.save()}>
        {doc.saving ? 'Saving…' : 'Save'}
      </button>
    </>
  );
  const saveErrorBanner =
    doc.saveError !== null ? (
      <div className="error-banner">Save failed: {doc.saveError}</div>
    ) : null;

  // ---- the legacy single-policy shape ------------------------------------

  if (policies.length === 0) {
    return (
      <>
        <ModuleBanner
          title="Insurance"
          pill={editPill}
          actions={doc.editing ? editActions : <button onClick={doc.enterEdit}>Edit</button>}
        />
        <div className="moduleBody">
          {saveErrorBanner}
          <fieldset key={doc.rev} disabled={!doc.editing} className="moduleFieldset">
            <LegacyPolicyFields
              expenses={profile.expenses}
              people={profile.people}
              update={doc.update}
            />
          </fieldset>
          <ConvertToListOffer onConvert={() => void doc.mutateAndSave(convertToPolicyList)} />
        </div>
        <DiscardChangesPrompt blocker={doc.blocker} />
      </>
    );
  }

  const addPolicy = () => {
    const list = policies;
    const fresh = makePolicy(list, defaultInsured(profile));
    doc.update((p) => {
      const target = p.expenses.lifeInsurancePolicies ?? [];
      target.push(structuredClone(fresh));
      p.expenses.lifeInsurancePolicies = target;
    });
    doc.enterEdit();
    navigate('insurance', fresh.id);
  };

  const deletePolicy = async (id: string) => {
    const ok = await doc.mutateAndSave((p) => {
      const list = p.expenses.lifeInsurancePolicies;
      if (!list) return;
      const i = list.findIndex((pl) => pl.id === id);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) {
        // Absent and empty mean the same thing to the engine — the legacy
        // single-policy fields take over again — so deleting the LAST policy
        // clears those scalars too. Without this, a conversion's leftovers
        // would quietly resurrect a premium the confirm dialog just promised
        // was gone from every simulated future. The legacy form still
        // renders (empty), so editing still has somewhere to land.
        delete p.expenses.lifeInsurancePolicies;
        delete p.expenses.lifeInsuranceMonthly;
        delete p.expenses.lifeInsuranceDeathBenefit;
        delete p.expenses.lifeInsuranceTermEnd;
        delete p.expenses.lifeInsuranceInsured;
      }
    });
    // Only steer the URL if the user is still LOOKING at the deleted record:
    // a slow write must not yank them back from wherever they went meanwhile.
    if (ok && alive.current && routeTabRef.current === id) {
      navigate('insurance', null, { replace: true });
    }
  };

  // ---- the detail view ----------------------------------------------------

  if (selected !== undefined) {
    return (
      <>
        <ModuleBanner
          title="Insurance"
          onTitleClick={() => navigate('insurance', null)}
          crumb={selected.label || selected.id}
          pill={editPill}
          actions={
            doc.editing ? (
              editActions
            ) : (
              <>
                <button onClick={doc.enterEdit}>Edit</button>
                <button className="danger" onClick={() => setConfirmDetailDelete(true)}>
                  Delete
                </button>
              </>
            )
          }
        />
        <div className="moduleBody">
          {saveErrorBanner}
          <div className="card">
            <fieldset
              key={`${doc.rev}:${selected.id}`}
              disabled={!doc.editing}
              className="moduleFieldset"
            >
              <PolicyEditor
                policy={selected}
                index={selectedIndex}
                people={profile.people}
                workStops={workStops}
                update={doc.update}
              />
            </fieldset>
          </div>
        </div>
        {confirmDetailDelete ? (
          <ConfirmModal
            title={`Delete ${selected.label || selected.id}?`}
            body="The premium stops being charged and the cover stops existing, in every simulated future. This cannot be undone."
            onConfirm={() => {
              setConfirmDetailDelete(false);
              void deletePolicy(selected.id);
            }}
            onCancel={() => setConfirmDetailDelete(false)}
          />
        ) : null}
        <DiscardChangesPrompt blocker={doc.blocker} />
      </>
    );
  }

  // ---- the table view -----------------------------------------------------

  const totals = policyTotals(policies);
  return (
    <>
      <ModuleBanner
        title="Insurance"
        actions={
          <button className="primary" onClick={addPolicy}>
            + Add policy
          </button>
        }
      />
      <div className="moduleBody">
        {saveErrorBanner}
        <ManagedTable
          columns={[
            {
              key: 'policy',
              label: 'Policy',
              sortValue: (p) => p.label || p.id,
            },
            {
              key: 'covers',
              label: 'Covers',
              sortValue: (p) => personName(profile, p.insured),
            },
            {
              key: 'premium',
              label: 'Premium',
              align: 'right',
              sortValue: (p) => p.premiumMonthly,
              render: (p) => `${formatUSD(p.premiumMonthly)}/mo`,
            },
            {
              key: 'benefit',
              label: 'Death benefit',
              align: 'right',
              sortValue: (p) => p.deathBenefit,
              render: (p) => formatUSD(p.deathBenefit),
            },
            {
              key: 'ends',
              label: 'Ends',
              sortValue: (p) => p.termEnd ?? '',
              render: (p) =>
                p.termEnd
                  ? formatMonth(p.termEnd)
                  : p.cancelAtRetirement === true
                    ? 'when work stops'
                    : 'horizon',
            },
          ]}
          rows={policies}
          rowId={(p) => p.id}
          onOpen={(p) => navigate('insurance', p.id)}
          deleteLabel={(p) => `Delete ${p.label || p.id}`}
          deleteConfirm={(p) => ({
            title: `Delete ${p.label || p.id}?`,
            body: 'The premium stops being charged and the cover stops existing, in every simulated future. This cannot be undone.',
          })}
          onDelete={(p) => void deletePolicy(p.id)}
          foot={
            <tfoot>
              <tr className="managedTotalRow">
                <td className="col-text">
                  <strong>All policies</strong>
                </td>
                <td className="col-text" />
                <td>
                  <strong>{formatUSD(totals.premiumMonthly)}/mo</strong>
                </td>
                <td>
                  <strong>{formatUSD(totals.deathBenefit)}</strong>
                </td>
                <td className="col-text" />
                <td className="deleteCell" />
              </tr>
            </tfoot>
          }
        />
      </div>
      <DiscardChangesPrompt blocker={doc.blocker} />
    </>
  );
}
