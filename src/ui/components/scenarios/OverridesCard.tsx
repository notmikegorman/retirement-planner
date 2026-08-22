/**
 * Assumption-overrides card: deterministic market returns + inflation (only
 * written into assumption_overrides.market when set), the ACA enhanced-credits
 * toggle, and settings overrides (horizon age, success target, spending policy).
 *
 * Bound checks mirror the strict plan schema: out-of-range or
 * non-numeric input shows an inline error and is never written into the
 * draft (buildOverrides skips fields flagged by overrideFieldErrors).
 */
import { useState } from 'react';
import type { AssumptionOverrides } from '../../../shared/types';
import { CorporateShareField } from './CorporateShareField';
import {
  buildOverrides,
  overrideFieldErrors,
  overrideFieldsFrom,
  type MarketDefaults,
  type OverrideFieldKey,
  type OverrideFields,
} from './scenarioHelpers';

interface OverridesCardProps {
  overrides: AssumptionOverrides | undefined;
  /** Loaded from market.json for placeholders/backfill; null when unavailable. */
  marketDefaults: MarketDefaults | null;
  onChange: (overrides: AssumptionOverrides | undefined) => void;
}

function FieldError({ error }: { error: string | undefined }) {
  if (!error) return null;
  return (
    <span className="bad" style={{ fontSize: 12 }}>
      {error}
    </span>
  );
}

export function OverridesCard({ overrides, marketDefaults, onChange }: OverridesCardProps) {
  const [f, setF] = useState<OverrideFields>(() => overrideFieldsFrom(overrides));
  const defaults = marketDefaults ?? { stocks: 0, bonds: 0, bills: 0, inflation: 0 };
  const errors = overrideFieldErrors(f);

  /** Update local state AND push the rebuilt overrides to the draft. */
  const commit = (next: OverrideFields) => {
    setF(next);
    onChange(buildOverrides(next, defaults));
  };

  const marketField = (
    label: string,
    key: keyof OverrideFields['market'] & OverrideFieldKey,
    placeholder: string,
  ) => (
    <label className="field" key={key}>
      {label}
      <input
        style={{ width: 100 }}
        value={f.market[key]}
        placeholder={placeholder}
        onChange={(e) => setF({ ...f, market: { ...f.market, [key]: e.target.value } })}
        onBlur={(e) => commit({ ...f, market: { ...f.market, [key]: e.target.value } })}
      />
      <FieldError error={errors[key]} />
    </label>
  );

  const ph = (v: number) => (marketDefaults ? String(v) : 'default');

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Assumption overrides</h2>

      <div className="muted">
        Deterministic real returns and inflation. Blank fields keep the market.json defaults;
        filled fields are written into the plan's overrides. Out-of-range values are
        rejected, not saved.
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        {marketField('Stocks real return', 'stocks', ph(defaults.stocks))}
        {marketField('Bonds real return', 'bonds', ph(defaults.bonds))}
        {marketField('Bills real return', 'bills', ph(defaults.bills))}
        {marketField('Inflation', 'inflation', ph(defaults.inflation))}
      </div>

      {/*
        Its own row, and its own sentence, because it is a different KIND of
        assumption from the four above. Those pin deterministic-mode returns;
        this one says where the household's cash actually sits, and it applies
        in Monte Carlo runs too. It matters most in a year holding house-sale
        proceeds, where the interest lands in the MAGI that decides the ACA
        subsidy.
      */}
      <div className="row" style={{ marginTop: 12 }}>
        {marketField('Cash yield (savings)', 'cashYield', 'bills rate')}
        <span className="field-note muted">
          Nominal, as a decimal — 0.0425 is 4.25%. Blank earns the year&apos;s bills return, which
          is right for money in a bank account and low for a CD or T-bill ladder. Applies to
          savings only; the bills sleeve of an investment allocation keeps the market&apos;s own
          return.
        </span>
      </div>

      {/*
        Also mode-independent: the blend reprices the bond sleeve in every
        sampled historical year, so it belongs beside the cash yield, not in
        the deterministic row above. The input is the SHARED component the
        Plan card's "Bonds are: Custom" box uses — one dial, two doors — so
        text state flows through this card's fields but the box and its error
        are pixel-identical in both homes.
      */}
      <div className="row" style={{ marginTop: 12 }}>
        <CorporateShareField
          value={f.market.corporateShare}
          placeholder="0"
          onChange={(text) => setF({ ...f, market: { ...f.market, corporateShare: text } })}
          onBlur={(text) => commit({ ...f, market: { ...f.market, corporateShare: text } })}
        />
        <span className="field-note muted">
          Blank or 0 = Treasuries only. Corporates yield more but crash with stocks instead of
          against them (2008: Baa &minus;3.4% vs 10-yr Treasuries +20.1%). A total-bond fund like
          BND is roughly 30. The Plan card&apos;s &ldquo;Bonds are&rdquo; select sets this same
          number.
        </span>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={f.acaEnhanced}
            onChange={(e) => commit({ ...f, acaEnhanced: e.target.checked })}
          />
          Assume Congress extends enhanced ACA credits
        </label>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <label className="field">
          Horizon age
          <input
            style={{ width: 80 }}
            value={f.horizonAge}
            placeholder="default"
            onChange={(e) => setF({ ...f, horizonAge: e.target.value })}
            onBlur={(e) => commit({ ...f, horizonAge: e.target.value })}
          />
          <FieldError error={errors.horizonAge} />
        </label>
        <label className="field">
          Success target (0–1)
          <input
            style={{ width: 80 }}
            value={f.successTarget}
            placeholder="default"
            onChange={(e) => setF({ ...f, successTarget: e.target.value })}
            onBlur={(e) => commit({ ...f, successTarget: e.target.value })}
          />
          <FieldError error={errors.successTarget} />
        </label>
        <label className="field">
          Spending policy
          <select
            value={f.spendingPolicyType}
            onChange={(e) =>
              commit({
                ...f,
                spendingPolicyType: e.target.value as OverrideFields['spendingPolicyType'],
              })
            }
          >
            <option value="">Profile default</option>
            <option value="fixed_real">Fixed real</option>
            <option value="fixed_percent">Fixed percent of portfolio</option>
            {/* The band itself stays a profile decision (see buildOverrides) —
                but without this option a scenario already carrying 'guardrails'
                round-trips through a select that cannot show it, and the next
                edit silently drops the policy. */}
            <option value="guardrails">Guardrails</option>
          </select>
        </label>
        {f.spendingPolicyType === 'fixed_percent' && (
          <label className="field">
            Percent (decimal)
            <input
              style={{ width: 80 }}
              value={f.spendingPercent}
              placeholder="e.g. 0.04"
              onChange={(e) => setF({ ...f, spendingPercent: e.target.value })}
              onBlur={(e) => commit({ ...f, spendingPercent: e.target.value })}
            />
            <FieldError error={errors.spendingPercent} />
          </label>
        )}
      </div>
    </div>
  );
}
