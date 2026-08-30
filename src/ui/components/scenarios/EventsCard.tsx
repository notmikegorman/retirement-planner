/**
 * Additional-events editor card: sorted event list with Edit/Delete per row,
 * plus an "Add event" flow (type picker, then typed form).
 *
 * The three core decisions — stopping work, claiming Social Security, changing
 * the allocation — are NOT here: they live in the always-present Plan card
 * above, which owns those events (isPlanOwnedEvent). This card is everything
 * else: moving, selling the house, a 72(t) bridge, one-off costs. Indices are
 * the ORIGINAL positions in the full event array, so hiding the plan's events
 * never shifts what Edit/Delete point at.
 */
import { useState } from 'react';
import type {
  Account,
  Person,
  ScenarioEvent,
  SocialSecurityData,
} from '../../../shared/types';
import { EventForm } from './EventForm';
import {
  DEFAULT_EVENT_DATE,
  EVENT_TYPES,
  PLAN_ONLY_EVENT_TYPES,
  defaultEventFields,
  eventDate,
  eventFieldsFrom,
  eventTypeLabel,
  isPlanOwnedEvent,
  sortedWithIndex,
  summarizeEvent,
  type EventFields,
  type EventType,
} from './scenarioHelpers';

/**
 * Types offered in the picker. Retiring and claiming are plan decisions, not
 * things you add — they are always present above. Allocation events stay
 * addable because one can target a single account (note 8), which the plan
 * does not own; new ones therefore default to a specific account.
 */
const ADDABLE_EVENT_TYPES = EVENT_TYPES.filter((t) => !PLAN_ONLY_EVENT_TYPES.includes(t.type));

interface EventsCardProps {
  events: ScenarioEvent[];
  people: Person[];
  accounts: Account[];
  /** Statutory claiming factors for the age-picker preview (null while loading). */
  ssData?: SocialSecurityData | null;
  onChange: (events: ScenarioEvent[]) => void;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pick' }
  | { kind: 'new'; fields: EventFields }
  | { kind: 'edit'; index: number; fields: EventFields };

export function EventsCard({ events, people, accounts, onChange, ssData = null }: EventsCardProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });

  const firstPretaxAccount =
    accounts.find((a) => a.type === '401k' || a.type === 'traditional_ira')?.id ??
    accounts[0]?.id ??
    '';
  const firstInvestedAccount = accounts.find((a) => a.type !== 'savings')?.id ?? '';

  const pickType = (type: EventType) => {
    const fields = defaultEventFields(DEFAULT_EVENT_DATE);
    fields.type = type;
    fields.person = people[0]?.id ?? '';
    if (type === 'start_72t') fields.account = firstPretaxAccount;
    // Allocation events added HERE are the per-account kind — the
    // whole-portfolio decision belongs to the Plan card, so default the target
    // to a real account rather than "All accounts".
    if (type === 'allocation_change' || type === 'glidepath') {
      fields.account = firstInvestedAccount;
    }
    setMode({ kind: 'new', fields });
  };

  const saveEvent = (event: ScenarioEvent) => {
    if (mode.kind === 'new') {
      onChange([...events, event]);
    } else if (mode.kind === 'edit') {
      onChange(events.map((e, i) => (i === mode.index ? event : e)));
    }
    setMode({ kind: 'idle' });
  };

  const deleteEvent = (index: number) => {
    onChange(events.filter((_, i) => i !== index));
    if (mode.kind === 'edit' && mode.index === index) setMode({ kind: 'idle' });
  };

  const editEvent = (index: number) => {
    setMode({ kind: 'edit', index, fields: eventFieldsFrom(events[index]) });
  };

  /**
   * A whole-portfolio allocation_change / glidepath is still "plan-owned"
   * (writePlan round-trips it, so a retire-age change never destroys it), but
   * the Plan card's allocation section is GONE — the user executed the
   * reallocation for real (2026-08-18) and the what-if retired with it. Such
   * an event in a loaded plan or an old cabinet scenario must therefore show
   * HERE, read-only, or it becomes an invisible knob: a mix silently steering
   * every simulated year with no surface saying so. No editor on purpose —
   * removing or changing one is a Raw JSON edit, the documented escape hatch.
   */
  const isLegacyAllocation = (event: ScenarioEvent): boolean =>
    (event.type === 'allocation_change' || event.type === 'glidepath') &&
    event.account === undefined;

  // Plan-owned events are edited in the Plan card; `index` stays the position
  // in the full `events` array so Edit/Delete keep working.
  const rows = sortedWithIndex(events).filter(
    ({ event }) => !isPlanOwnedEvent(event) || isLegacyAllocation(event),
  );

  return (
    <div className="card">
      <div className="row">
        {/* No heading: the section header names this card. */}
        <span className="spacer" />
        {mode.kind === 'idle' && <button onClick={() => setMode({ kind: 'pick' })}>Add event</button>}
      </div>
      <div className="field-help" style={{ marginTop: 4 }}>
        Stopping work and claiming Social Security are set in the plan above. Add anything else
        that happens in your plan here — a move, selling the house, a one-off cost, a Roth
        conversion.
      </div>

      {rows.length === 0 && mode.kind === 'idle' && (
        <div className="muted" style={{ marginTop: 8 }}>
          Nothing extra yet — just the plan above.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {rows.map(({ event, index }) => (
            <div className="event-row" key={index}>
              <span className="badge">{eventTypeLabel(event.type)}</span>
              <span className="event-date">
                {eventDate(event) ?? (event.type === 'roth_conversion' ? 'yearly' : '—')}
              </span>
              <span className="event-summary">{summarizeEvent(event, people, accounts)}</span>
              <span className="spacer" />
              {isLegacyAllocation(event) ? (
                <span
                  className="muted"
                  title={
                    'A whole-portfolio allocation event. Its editor was retired when the ' +
                    'reallocation was executed for real (2026-08-18); the event still runs ' +
                    'exactly as written. To change or remove it, use the Raw JSON editor.'
                  }
                >
                  read-only
                </span>
              ) : (
                <>
                  <button onClick={() => editEvent(index)}>Edit</button>
                  <button className="danger" onClick={() => deleteEvent(index)}>
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {mode.kind === 'pick' && (
        <div style={{ marginTop: 10 }}>
          <div className="row">
            <div className="muted">Choose an event type</div>
            <span className="spacer" />
            <button onClick={() => setMode({ kind: 'idle' })}>Cancel</button>
          </div>
          <div className="type-grid">
            {ADDABLE_EVENT_TYPES.map((t) => (
              <button key={t.type} onClick={() => pickType(t.type)}>
                {t.label}
                <span className="type-hint">{t.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(mode.kind === 'new' || mode.kind === 'edit') && (
        <EventForm
          key={mode.kind === 'edit' ? `edit-${mode.index}` : 'new'}
          initial={mode.fields}
          people={people}
          accounts={accounts}
          ssData={ssData}
          isNew={mode.kind === 'new'}
          onSave={saveEvent}
          onCancel={() => setMode({ kind: 'idle' })}
        />
      )}
    </div>
  );
}
