/**
 * THE WIDOW'S PLAYBOOK — what Melanie should do, and when.
 *
 * THE ONLY MODULE WRITTEN FOR SOMEBODY ELSE. Every other page in this app is
 * an instrument for the owner to steer with: knobs, curves, a probability.
 * This one is a document for the person who will be reading it on the worst
 * week of her life, and that changes what good looks like. No knobs. No score.
 * Short sentences, the reason underneath, and an honest blank wherever the
 * file does not know something.
 *
 * TWO HALVES, DELIBERATELY DISTINGUISHABLE ON SCREEN:
 *
 *   - THE CONVENTIONAL HALF (src/content/widow-playbook.json): what anybody
 *     would tell her, cut into phases by how long after. It is shipped, dated
 *     and sourced, because half of it is claims about the law with real
 *     deadlines — see that directory's README for why it is not seeded into
 *     the data folder like the assumption dials are.
 *   - THE PLAN-AWARE HALF (shared/widowPlaybook.ts): the same phases, but
 *     about THIS household — which accounts, whose, what the budget says she
 *     spends, whether the inherited-IRA choice is live at her age. Rendered
 *     in its own block under the heading "What this plan knows", so nothing
 *     on the page is ambiguous about whether it is advice or arithmetic.
 *
 * WHAT IT REFUSES TO DO. It computes no probability. The survivor's odds have
 * a home already — the Widow tab's curve, which runs a real simulation per
 * candidate year — and a second answer here, arrived at differently, would
 * eventually disagree with it. It also never fills a blank with a plausible
 * guess: an unnamed attorney renders as "nobody recorded", because a name
 * invented on this page would be believed.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Profile } from '../../shared/types';
import { playbookFacts, type PlaybookFacts } from '../../shared/widowPlaybook';
import { formatUSD } from '../../shared/util';
import { TabPanel, TabStrip, type TabDef } from './TabStrip';
import { WIDOW_PLAYBOOK_TAB_IDS } from '../nav';
import playbookContent from '../../content/widow-playbook.json';
import { ContactsCard } from '../components/profile/ContactsCard';

type PhaseId = 'week' | 'month' | 'year' | 'later';
type TabId = (typeof WIDOW_PLAYBOOK_TAB_IDS)[number];

interface PlaybookItem {
  id: string;
  text: string;
  why?: string;
  source?: string;
  needsProfessional?: boolean;
}
interface PlaybookPhase {
  id: PhaseId;
  label: string;
  heading: string;
  intro: string;
  items: PlaybookItem[];
}

const PHASES = (playbookContent as { phases: PlaybookPhase[] }).phases;
const META = (playbookContent as { meta: { verified_on: string } }).meta;

const TABS: TabDef<TabId>[] = [
  ...PHASES.map((p) => ({ id: p.id as TabId, label: p.label })),
  { id: 'contacts' as TabId, label: 'Who to call' },
];

/** One piece of advice: what to do, why, and who is needed for it. */
function Item({ item }: { item: PlaybookItem }) {
  return (
    <li style={{ marginBottom: 14 }}>
      <div>{item.text}</div>
      {item.why !== undefined ? (
        <div className="muted" style={{ marginTop: 3 }}>
          {item.why}
        </div>
      ) : null}
      <div className="muted" style={{ marginTop: 3, fontSize: 12 }}>
        {item.needsProfessional === true ? <strong>Needs a professional. </strong> : null}
        {item.source !== undefined ? <>Source: {item.source}</> : null}
      </div>
    </li>
  );
}

/**
 * The plan-aware block for one phase. Every branch either states a fact the
 * file holds or says plainly that the file is silent — never a default
 * dressed as an answer.
 */
function PlanKnows({ phase, facts }: { phase: PhaseId; facts: PlaybookFacts }) {
  const rows: React.ReactNode[] = [];
  const her = facts.survivor?.name ?? 'the survivor';

  if (phase === 'week') {
    rows.push(
      <li key="where">
        The money is in <strong>{facts.accounts.length}</strong> recorded accounts totalling{' '}
        <strong>{formatUSD(facts.accountsTotal)}</strong>. The Accounts page lists them; nothing
        there needs touching this week.
      </li>,
    );
    rows.push(
      facts.hasDocuments ? (
        <li key="docs">
          Where the documents are is recorded on the <strong>Who to call</strong> tab.
        </li>
      ) : (
        <li key="docs">
          <strong>Nothing is recorded about where the documents are.</strong> Fill in the{' '}
          <strong>Who to call</strong> tab while you can.
        </li>
      ),
    );
  }

  if (phase === 'month') {
    const choices = facts.accounts.filter((a) => a.inheritsChoice);
    rows.push(
      choices.length === 0 ? (
        <li key="ira">
          No retirement account on file is owned by {facts.deceased?.name ?? 'him'}, so the
          inherited-IRA decision may not arise. Check the Accounts page before assuming that.
        </li>
      ) : (
        <li key="ira">
          The inherited-account decision covers{' '}
          <strong>
            {choices.map((c) => c.name).join(', ')} ({formatUSD(
              choices.reduce((s, c) => s + c.balance, 0),
            )})
          </strong>
          .
          {facts.survivorAgeNow !== null ? (
            <>
              {' '}
              {her} is <strong>{facts.survivorAgeNow}</strong>
              {facts.under59Half ? (
                <>
                  {' '}— under 59½, so staying a beneficiary rather than rolling over is what keeps
                  withdrawals free of the 10% penalty. This is the branch to raise first.
                </>
              ) : (
                <> — past 59½, so the penalty question does not arise and the rollover is simpler.</>
              )}
            </>
          ) : null}
        </li>
      ),
    );
    rows.push(
      facts.lifeCoverTotal > 0 ? (
        <li key="life">
          Life cover on file: <strong>{formatUSD(facts.lifeCoverTotal)}</strong>. The Insurance page
          says whether it is still in force in a given year.
        </li>
      ) : (
        <li key="life">No life insurance is recorded, so expect no policy to claim.</li>
      ),
    );
  }

  if (phase === 'year') {
    rows.push(
      facts.survivorLivingMonthly !== null ? (
        <li key="spend">
          The budget says {her} spends <strong>{formatUSD(facts.survivorLivingMonthly)}/mo</strong>{' '}
          against the household&rsquo;s <strong>{formatUSD(facts.householdLivingMonthly)}/mo</strong>{' '}
          — the &ldquo;if I die&rdquo; column of the Expenses table.
        </li>
      ) : (
        <li key="spend">
          <strong>The budget names no survivor figure</strong>, so the plan assumes her costs are the
          household&rsquo;s <strong>{formatUSD(facts.householdLivingMonthly)}/mo</strong>, unchanged.
          That is the honest default and is usually too high — the &ldquo;if I die&rdquo; column on
          the Expenses page is where to fix it.
        </li>
      ),
    );
  }

  if (phase === 'later') {
    rows.push(
      <li key="widow">
        The Plan page&rsquo;s <strong>Widow</strong> tab runs the survivor&rsquo;s odds year by year.
        It is the one number on this subject worth trusting, and it is not on this page because it
        costs a full simulation to compute.
      </li>,
    );
  }

  if (rows.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>What this plan knows</h3>
      <ul style={{ marginBottom: 0 }}>{rows}</ul>
    </div>
  );
}

export function WidowPlaybookModule() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<TabId>('week');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await api.getProfile();
        if (alive) setProfile(p);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error !== null) return <div className="error-banner">{error}</div>;
  if (profile === null) return <div className="muted">Loading…</div>;

  const facts = playbookFacts(profile, new Date().getFullYear());
  const phase = PHASES.find((p) => p.id === active);

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        For {facts.survivor?.name ?? 'the survivor'}, if {facts.deceased?.name ?? 'the earner'} dies
        first. The advice is conventional and dated {META.verified_on}; the blocks headed{' '}
        <strong>What this plan knows</strong> are read off this plan. None of it is legal or tax
        advice.
      </p>
      <TabStrip
        idPrefix="widow-playbook"
        label="Widow's Playbook phases"
        tabs={TABS}
        active={active}
        onSelect={setActive}
      />
      <TabPanel idPrefix="widow-playbook" tab={active}>
        {active === 'contacts' ? (
          <ContactsCard profile={profile} onSaved={setProfile} />
        ) : phase === undefined ? null : (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>{phase.heading}</h2>
            <p className="muted">{phase.intro}</p>
            <ul>
              {phase.items.map((item) => (
                <Item key={item.id} item={item} />
              ))}
            </ul>
            <PlanKnows phase={phase.id} facts={facts} />
          </div>
        )}
      </TabPanel>
    </div>
  );
}
