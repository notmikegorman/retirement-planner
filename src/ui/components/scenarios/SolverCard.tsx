/**
 * Solver card: none | retire_year_sweep | ss_claim_sweep | swr_curve |
 * max_spend | earliest_retirement, matching SolverSpec exactly.
 */
import { useState } from 'react';
import type { ScenarioEvent, SolverSpec } from '../../../shared/types';
import {
  SOLVER_TYPES,
  buildSolver,
  defaultSolverForType,
  describeSolver,
  solverFieldsFrom,
  solverOverrideNote,
  solverOverriddenEventTypes,
  type SolverFields,
} from './scenarioHelpers';

interface SolverCardProps {
  solver: SolverSpec | undefined;
  /** The scenario's events, so a solver that discards some of them can say so. */
  events?: readonly ScenarioEvent[];
  onChange: (solver: SolverSpec | undefined) => void;
}

export function SolverCard({ solver, events = [], onChange }: SolverCardProps) {
  const [f, setF] = useState<SolverFields>(() => solverFieldsFrom(solver));

  const commit = (next: SolverFields) => {
    setF(next);
    onChange(buildSolver(next));
  };

  const changeType = (type: string) => {
    const next =
      type === ''
        ? solverFieldsFrom(undefined)
        : solverFieldsFrom(defaultSolverForType(type as SolverSpec['type']));
    commit(next);
  };

  const numField = (
    label: string,
    key: 'from' | 'to' | 'stepMonths' | 'spendFrom' | 'spendTo' | 'step' | 'targetSuccess',
    width = 90,
    placeholder?: string,
  ) => (
    <label className="field" key={key}>
      {label}
      <input
        style={{ width }}
        value={f[key]}
        placeholder={placeholder}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
        onBlur={(e) => commit({ ...f, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Solver</h2>
        <span className="spacer" />
        <span className="muted">{describeSolver(buildSolver(f))}</span>
      </div>
      <SolverOverrideNote type={f.type} events={events} />
      <div className="row" style={{ marginTop: 8 }}>
        <label className="field">
          <span className="field-label">Type</span>
          <select value={f.type} onChange={(e) => changeType(e.target.value)}>
            <option value="">None</option>
            {SOLVER_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {f.type === 'retire_year_sweep' && (
          <>
            {numField('From year', 'from')}
            {numField('To year', 'to')}
            <label className="row" style={{ gap: 8, cursor: 'pointer', alignSelf: 'flex-end' }}>
              <input
                type="checkbox"
                checked={f.alsoMaxSpend}
                onChange={(e) => commit({ ...f, alsoMaxSpend: e.target.checked })}
              />
              Also compute max sustainable spend
            </label>
          </>
        )}

        {f.type === 'ss_claim_sweep' && numField('Step (months)', 'stepMonths', 90, '1')}

        {f.type === 'swr_curve' && (
          <>
            {numField('Spend from $/yr', 'spendFrom', 110)}
            {numField('Spend to $/yr', 'spendTo', 110)}
            {numField('Step $', 'step', 90)}
          </>
        )}

        {f.type === 'max_spend' &&
          numField('Target success (0–1)', 'targetSuccess', 90, 'default')}

        {f.type === 'earliest_retirement' && (
          <>
            {numField('Target success (0–1)', 'targetSuccess', 90, 'default')}
            {numField('From year', 'from', 90, 'default')}
            {numField('To year', 'to', 90, 'default')}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Explains what the selected solver overrides, and warns when the scenario
 * actually contains events it will discard — the "my scenario retires in 2026
 * but the sweep says 2031" confusion.
 */
function SolverOverrideNote({
  type,
  events,
}: {
  type: '' | SolverSpec['type'];
  events: readonly ScenarioEvent[];
}) {
  if (type === '') return null;
  const overridden = solverOverriddenEventTypes(type);
  const clashing = events.filter((e) => overridden.includes(e.type));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="field-help">{solverOverrideNote(type)}</div>
      {clashing.length > 0 && (
        <div className="flag" style={{ marginTop: 6, display: 'inline-block' }}>
          Heads up: this plan has {clashing.length}{' '}
          {overridden[0] === 'retire' ? 'retire' : 'claim'} event
          {clashing.length === 1 ? '' : 's'} that the solver will replace.
        </div>
      )}
    </div>
  );
}
