/**
 * Dashboard: profile snapshot (SPEC §9) — net worth breakdown, household,
 * plan settings, data folder, VERIFY flags, and quick actions.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Profile } from '../../shared/types';
import { deriveExpenseStreams } from '../../shared/expenses';
import { formatPct, formatUSD } from '../../shared/util';
import { api, type ServerMeta } from '../api';
import type { PageProps } from '../nav';
import { PlaceholderChip } from '../components/profile/fields';
import {
  STATE_LABELS,
  accountDisplayName,
  accountTypeLabel,
  ageAt,
  annualFromMonthly,
  formatBirth,
  isPlaceholder,
  netWorth,
  ownerLabel,
  spendingPolicySummary,
  withdrawalPolicySummary,
} from '../components/profile/profileLogic';

function SettingRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
      <span className="muted">{props.label}</span>
      <span style={{ textAlign: 'right' }}>{props.children}</span>
    </div>
  );
}

export function DashboardPage({ navigate }: PageProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [meta, setMeta] = useState<ServerMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, m] = await Promise.all([api.getProfile(), api.meta()]);
      setProfile(p);
      setMeta(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="muted">Loading…</div>;
  if (error || !profile || !meta) {
    return (
      <div>
        <div className="error-banner">Failed to load dashboard: {error ?? 'missing data'}</div>
        <button onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  // Display-only "today" — engine/tax code stays deterministic; this is UI.
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;

  const total = netWorth(profile);
  const mortgageBalance = profile.home.mortgage?.balance ?? 0;
  const s = profile.settings;
  /*
   * Derived, not `profile.expenses`: with an itemised budget those scalars are
   * a CACHE of the rows that scripts/transcribe-budget.ts never refreshes, so
   * reading them here reported a household's living spend as $7,100/mo
   * while every run it launched actually spent $7,340. prepareSim and
   * planSpendAnnual already derive; this panel was the last place quoting the
   * cache, and a snapshot that disagrees with the simulation is worse than no
   * snapshot.
   */
  const e = deriveExpenseStreams(profile.expenses);

  return (
    <div>
      <h1>Dashboard</h1>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="primary" onClick={() => navigate('workbench')}>
          Open the workbench
        </button>
        <button onClick={() => navigate('profile')}>Edit profile</button>
      </div>

      <div className="card">
        <h2 style={{ margin: 0 }}>Net worth</h2>
        <div className="success-gauge">{formatUSD(total)}</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th style={{ textAlign: 'left' }}>Type</th>
                <th style={{ textAlign: 'left' }}>Owner</th>
                <th>Balance</th>
                <th>Cost basis</th>
              </tr>
            </thead>
            <tbody>
              {profile.accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {accountDisplayName(a)}{' '}
                    <span className="muted" style={{ fontSize: 12 }}>
                      {a.id}
                    </span>
                    {isPlaceholder(a.notes) ? (
                      <>
                        {' '}
                        <PlaceholderChip />
                      </>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'left' }}>{accountTypeLabel(a.type)}</td>
                  <td style={{ textAlign: 'left' }}>{ownerLabel(profile, a.owner)}</td>
                  <td>{formatUSD(a.balance)}</td>
                  <td>
                    {a.type === 'taxable_brokerage' && a.costBasis != null
                      ? formatUSD(a.costBasis)
                      : '—'}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Home</td>
                <td style={{ textAlign: 'left' }}>Real estate</td>
                <td style={{ textAlign: 'left' }}>—</td>
                <td>{formatUSD(profile.home.value)}</td>
                <td>{formatUSD(profile.home.costBasis)}</td>
              </tr>
              {mortgageBalance > 0 ? (
                <tr>
                  <td>Mortgage</td>
                  <td style={{ textAlign: 'left' }}>Liability</td>
                  <td style={{ textAlign: 'left' }}>—</td>
                  <td>−{formatUSD(mortgageBalance)}</td>
                  <td>—</td>
                </tr>
              ) : null}
              <tr>
                <td>
                  <strong>Net worth</strong>
                </td>
                <td />
                <td />
                <td>
                  <strong>{formatUSD(total)}</strong>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-grid">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Household</h2>
          {profile.people.map((p) => (
            <div key={p.id} style={{ marginBottom: 10 }}>
              <div>
                <strong>{p.name}</strong> — {formatBirth(p.birthYear, p.birthMonth)} · age{' '}
                {ageAt(nowYear, nowMonth, p.birthYear, p.birthMonth)}
              </div>
              <div className="muted">
                PIA at FRA {formatUSD(p.piaMonthlyAtFraIfWorkingTo62)}/mo working to 62 ·{' '}
                {formatUSD(p.piaMonthlyAtFraIfStoppingNow)}/mo stopping now ·{' '}
                {p.hasOwnBenefit ? 'has own benefit' : 'spousal benefit only'}{' '}
                {isPlaceholder(p.notes) ? <PlaceholderChip /> : null}
              </div>
            </div>
          ))}
          <div className="row">
            <span className="badge">{profile.filing.status.toUpperCase()}</span>
            <span className="badge">{profile.filing.state.toUpperCase()}</span>
            <span className="muted">{STATE_LABELS[profile.filing.state]}</span>
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Plan settings</h2>
          <SettingRow label="Horizon age">{s.horizonAge}</SettingRow>
          <SettingRow label="Success target">{formatPct(s.successTarget, 0)}</SettingRow>
          <SettingRow label="MC paths">
            {s.mcPathsInteractive.toLocaleString('en-US')} interactive /{' '}
            {s.mcPathsFinal.toLocaleString('en-US')} final
          </SettingRow>
          <SettingRow label="Seed">{s.seed}</SettingRow>
          {s.terminalFloorReal != null ? (
            <SettingRow label="Terminal floor">{formatUSD(s.terminalFloorReal)} real</SettingRow>
          ) : null}
          <SettingRow label="Spending">{spendingPolicySummary(s.spendingPolicy)}</SettingRow>
          <SettingRow label="Living expenses">
            {formatUSD(e.livingMonthly)}/mo · {formatUSD(annualFromMonthly(e.livingMonthly))}/yr
          </SettingRow>
          <SettingRow label="Charitable giving">
            {formatUSD(e.charitableMonthly)}/mo ·{' '}
            {formatUSD(annualFromMonthly(e.charitableMonthly))}/yr
          </SettingRow>
          <SettingRow label="Investing (while working)">
            {formatUSD(e.investingMonthly)}/mo ·{' '}
            {formatUSD(annualFromMonthly(e.investingMonthly))}/yr
          </SettingRow>
          <SettingRow label="Employer premium share">
            {formatUSD(profile.health.employerPremiumShareMonthly)}/mo pre-tax
          </SettingRow>
          <div className="muted" style={{ marginTop: 8 }}>
            Withdrawals: {withdrawalPolicySummary(s.withdrawalPolicy)}
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Data folder</h2>
          <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{meta.dataDir}</code>
          <p className="muted">
            Your profile (<code>profile.json</code>) and your plan (<code>plan.json</code>, saved on
            every change) are human-readable JSON in this folder. Back it up — <code>git init</code>{' '}
            works well.
          </p>
          <p className="muted">
            Engine v{meta.engineVersion}
            {meta.dataDirInitialized ? '' : ' · data folder not yet initialized'}
          </p>
        </div>
      </div>
    </div>
  );
}
